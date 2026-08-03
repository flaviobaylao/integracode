import { Express } from 'express';
import { storage } from './storage';
import { authenticateUser } from './authMiddleware';
import { nowBrazil } from './brazilTimezone';
import * as bbPixService from './bb-pix-service';
import { logFinancialAudit, actorOf } from './financial-audit';
import { webhookTokenGuard } from './webhook-security';
import { db, pool } from './db';
import { sql } from 'drizzle-orm';

// FASE 2 - Flags para badges nas listas (DRE / Fluxo / Conciliada + origem da baixa).
// Consultas agregadas unicas (sem N+1): ids conciliados via extrato bancario e ids
// com baixa automatica do BB (webhook de boleto/PIX ou varredura de consulta).
async function badgeFlagsFor(kind: 'receivable' | 'payable'): Promise<{ ofx: Set<string>; autoBB: Set<string> }> {
  const ofx = new Set<string>(); const autoBB = new Set<string>();
  const col = kind === 'receivable' ? 'receivable_id' : 'payable_id';
  try {
    const m: any = await db.execute(sql.raw(`SELECT DISTINCT ${col} AS id FROM bank_statement_item_matches WHERE ${col} IS NOT NULL`));
    for (const r of (m.rows || [])) ofx.add(String(r.id));
  } catch {}
  if (kind === 'receivable') {
    try {
      const w: any = await db.execute(sql.raw(`SELECT DISTINCT receivable_id AS id FROM receivable_payments WHERE notes ILIKE 'Baixa automatica boleto BB%' OR notes ILIKE 'Pagamento PIX BB autom%'`));
      for (const r of (w.rows || [])) autoBB.add(String(r.id));
    } catch {}
  }
  const hist = new Set();
  try {
    const _t = kind === 'receivable' ? 'receivables' : 'payables';
    const h = await db.execute(sql.raw(`SELECT id FROM ${_t} WHERE import_origin = 'omie_historico'`));
    for (const r of (h.rows || [])) hist.add(String(r.id));
  } catch {}
  return { ofx, autoBB, hist };
}

function attachBadges(items: any[], flags: { ofx: Set<string>; autoBB: Set<string> }, paidStatus: string) {
  for (const it of items) {
    const amt = parseFloat(it.amount || '0');
    const paid = parseFloat(it.amountPaid || '0');
    const quitada = String(it.status) === paidStatus || (amt > 0 && paid >= amt - 0.005);
    // Conciliada = quitada COM vinculo bancario real (extrato OFX ou baixa automatica BB).
    // Baixado = quitada por baixa manual, SEM conciliacao no extrato bancario (nao confundir).
    const conciliadoBanco = quitada && (flags.autoBB.has(String(it.id)) || flags.ofx.has(String(it.id)) || (flags.hist && flags.hist.has(String(it.id))));
    it.badges = {
      dre: !!it.chartAccountId,
      fluxo: !!it.financialAccountId,
      conciliada: conciliadoBanco,
      baixado: quitada && !conciliadoBanco,
      origem: quitada ? (flags.autoBB.has(String(it.id)) ? 'webhook' : (flags.ofx.has(String(it.id)) ? 'extrato' : 'manual')) : null,
    };
  }
}

function isFinancialAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: 'Não autenticado' });
  const allowedRoles = ['admin', 'coordinator', 'administrative'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
  }
  next();
}

// Leitura financeira ampliada: além de admin/coord/administrativo, permite
// vendedor e telemarketing VISUALIZAREM (somente GET; escrita segue restrita).
function isFinancialReadAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: 'Não autenticado' });
  const allowedRoles = ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
  }
  next();
}

// Normaliza o body de contas (edição): datas string -> Date; valores "1.234,56" -> "1234.56"
function normalizeFinancialBody(body: any): any {
  const out: any = { ...body };
  const isoRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const dateFields = ['dueDate', 'issueDate', 'paidDate', 'paidAt', 'emissionDate', 'expectedSettlementDate'];
  for (const k of dateFields) {
    if (out[k] === '' || out[k] === null) { out[k] = null; }
    else if (typeof out[k] === 'string') { const d = new Date(out[k]); if (!isNaN(d.getTime())) out[k] = d; }
  }
  // genérico: qualquer string em formato ISO de data vira Date (cobre createdAt/updatedAt/etc. carregados no form de edição)
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string' && isoRe.test(out[k])) { const d = new Date(out[k]); if (!isNaN(d.getTime())) out[k] = d; }
  }
  const numFields = ['amount', 'amountPaid', 'interestTotal', 'discountTotal'];
  for (const k of numFields) {
    if (typeof out[k] === 'string' && out[k].includes(',')) out[k] = out[k].replace(/\./g, '').replace(',', '.');
  }
  // "" vindo do form (ex.: "Selecione") vira null — evita "invalid input value for enum" e FKs vazias
  const emptyToNullFields = ['paymentMethod', 'chartAccountId', 'financialAccountId', 'omieInstanceId'];
  for (const k of emptyToNullFields) {
    if (out[k] === '') out[k] = null;
  }
  // nunca sobrescrever PK / timestamps de auditoria a partir do payload do cliente
  delete out.id;
  delete out.createdAt;
  delete out.updatedAt;
  return out;
}

function addMonthsUTC(base: Date, n: number): Date {
  const r = new Date(base.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const dim = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, dim));
  return r;
}

function buildRecurrenceDates(base: Date, rec: any): Date[] {
  const interval = Math.max(1, parseInt(rec.interval) || 1);
  const MAX = 120;
  const step = (i: number): Date => {
    if (rec.freq === 'daily') { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + interval * i); return d; }
    if (rec.freq === 'weekly') { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + interval * 7 * i); return d; }
    if (rec.freq === 'monthly') return addMonthsUTC(base, interval * i);
    if (rec.freq === 'yearly') return addMonthsUTC(base, interval * 12 * i);
    return new Date(base.getTime());
  };
  const dates: Date[] = [];
  if (rec.endType === 'date' && rec.until) {
    const until = new Date(rec.until);
    for (let i = 0; i < MAX; i++) { const d = step(i); if (d.getTime() > until.getTime()) break; dates.push(d); }
  } else {
    const count = Math.min(MAX, Math.max(1, parseInt(rec.count) || 1));
    for (let i = 0; i < count; i++) dates.push(step(i));
  }
  if (dates.length === 0) dates.push(new Date(base.getTime()));
  return dates;
}

export function registerFinancialRoutes(app: Express) {

  // ============================================================================
  // REPARO DE BAIXAS revertidas pelo sync 1.0 (idempotente)
  // Recomputa amount_paid/status de recebiveis e pagaveis a partir dos pagamentos
  // que SOBREVIVERAM (receivable_payments/payable_payments). Corrige os titulos que
  // voltaram a "aberto/vencida" com amount_paid=0 embora ja tivessem baixa.
  // Body { "dryRun": true } (padrao) so conta; { "dryRun": false } aplica.
  // ============================================================================
  app.post('/api/admin/financial/repair-baixas', authenticateUser, isFinancialAuthorized, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      // ESCOPO (aditivo; padrao 'ambos' = comportamento antigo). Rodar recebiveis e
      // pagaveis de uma vez obriga a auditar os dois dominios juntos; 'apenas' limita
      // o lado e 'ids' limita a titulos ja conferidos um a um.
      const apenas = String(req.body?.apenas || 'ambos').toLowerCase();
      const fazRcv = apenas === 'ambos' || apenas === 'receivables';
      const fazPay = apenas === 'ambos' || apenas === 'payables';
      const pediuIds = Array.isArray(req.body?.ids);
      const idsFiltro: string[] = pediuIds
        ? req.body.ids.map((x: any) => String(x).trim()).filter((x: string) => /^[0-9a-fA-F-]{8,40}$/.test(x))
        : [];
      if (pediuIds && idsFiltro.length === 0) {
        return res.status(400).json({ error: 'ids informado mas nenhum id valido', recebidos: req.body.ids });
      }
      const filtroId = idsFiltro.length ? " AND r.id IN (" + idsFiltro.map((x) => "'" + x + "'").join(',') + ")" : '';
      const rcvPrev: any = await db.execute(sql.raw("SELECT count(*)::int AS n FROM receivables r JOIN (SELECT receivable_id, sum(amount::numeric) total FROM receivable_payments WHERE deleted_at IS NULL GROUP BY receivable_id) p ON p.receivable_id = r.id WHERE r.deleted_at IS NULL AND r.status <> 'cancelada' AND (r.amount_paid::numeric IS DISTINCT FROM p.total OR (p.total >= r.amount::numeric AND r.status <> 'recebida'))" + filtroId));
      const payPrev: any = await db.execute(sql.raw("SELECT count(*)::int AS n FROM payables r JOIN (SELECT payable_id, sum(amount::numeric) total FROM payable_payments WHERE deleted_at IS NULL GROUP BY payable_id) p ON p.payable_id = r.id WHERE r.deleted_at IS NULL AND r.status <> 'cancelada' AND (r.amount_paid::numeric IS DISTINCT FROM p.total OR (p.total >= r.amount::numeric AND r.status <> 'paga'))" + filtroId));
      const wouldFix = { receivables: fazRcv ? (rcvPrev.rows?.[0]?.n ?? 0) : 0, payables: fazPay ? (payPrev.rows?.[0]?.n ?? 0) : 0 };
      if (dryRun) return res.json({ dryRun: true, apenas, ids: idsFiltro.length || null, wouldFix });

      const rcv: any = !fazRcv ? { rowCount: 0 } : await db.execute(sql.raw("UPDATE receivables r SET amount_paid = p.total, status = (CASE WHEN p.total >= r.amount::numeric THEN 'recebida' WHEN (r.due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'vencida' ELSE 'a_vencer' END)::receivable_status, updated_at = now(), updated_by = 'repair-baixas' FROM (SELECT receivable_id, sum(amount::numeric) total FROM receivable_payments WHERE deleted_at IS NULL GROUP BY receivable_id) p WHERE r.id = p.receivable_id AND r.deleted_at IS NULL AND r.status <> 'cancelada' AND (r.amount_paid::numeric IS DISTINCT FROM p.total OR (p.total >= r.amount::numeric AND r.status <> 'recebida'))" + filtroId));
      const pay: any = !fazPay ? { rowCount: 0 } : await db.execute(sql.raw("UPDATE payables r SET amount_paid = p.total, status = (CASE WHEN p.total >= r.amount::numeric THEN 'paga' WHEN (r.due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'vencida' ELSE 'a_vencer' END)::payable_status, updated_at = now(), updated_by = 'repair-baixas' FROM (SELECT payable_id, sum(amount::numeric) total FROM payable_payments GROUP BY payable_id) p WHERE r.id = p.payable_id AND r.deleted_at IS NULL AND r.status <> 'cancelada' AND (r.amount_paid::numeric IS DISTINCT FROM p.total OR (p.total >= r.amount::numeric AND r.status <> 'paga'))" + filtroId));
      res.json({ dryRun: false, apenas, ids: idsFiltro.length || null, fixed: { receivables: rcv.rowCount ?? null, payables: pay.rowCount ?? null } });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ============================================================================
  // REPARO: boleto LIQUIDADO no BB e titulo SEM baixa (aparece como "vencida")
  // ----------------------------------------------------------------------------
  // Causa: settleBoletoCharge marcava o boleto como 'liquidado' ANTES de baixar o
  // titulo e engolia o erro do laco. Falhando ali, sobrava boleto liquidado + titulo
  // vencido, e toda nova tentativa desistia no short-circuit por status. A varredura
  // noturna (sweepOpenBoletos) tambem nao pegava esses casos: ela so olha boletos
  // que NAO estao liquidados. Resultado: dinheiro no banco, titulo vencido na tela.
  //
  // Este endpoint acha exatamente esses casos e completa a baixa que faltou, usando
  // o VALOR PAGO e a DATA DE CREDITO reais consultados no BB titulo a titulo — nunca
  // o valor de emissao, que pode diferir do que o cliente pagou (desconto/juros).
  //
  // Body { "dryRun": true } (PADRAO) so consulta o BB e mostra o que faria.
  //      { "dryRun": false } aplica. Opcionais: limit, days, boletoIds: [...]
  // Idempotente: rodar de novo em titulo ja baixado nao duplica pagamento.
  // ============================================================================
  // ============================================================================
  // AUDITORIA DE BAIXAS (SOMENTE LEITURA — nao grava nada)
  // ----------------------------------------------------------------------------
  // Varre os recebiveis e devolve, separadas por tipo, as inconsistencias de baixa.
  // Serve para conferir titulo a titulo ANTES de rodar qualquer reparo: o
  // repair-baixas reescreve amount_paid a partir da SOMA dos pagamentos, entao se
  // houver pagamento DUPLICADO ele consolidaria o erro. Por isso duplicidade e a
  // primeira coisa checada aqui.
  //
  // GET /api/admin/financial/auditoria-baixas?limit=300&status=vencida
  //   status: 'vencida' | 'todas' (padrao 'todas')
  // ============================================================================
  // ============================================================================
  // ESTORNO DE PAGAMENTOS DUPLICADOS
  // ----------------------------------------------------------------------------
  // O mesmo boleto foi lancado mais de uma vez no titulo (varredura noturna
  // repetindo a baixa + Sistema 1.0 gravando em paralelo), inflando amount_paid.
  //
  // NAO apaga a linha: marca como ESTORNADA (deleted_at/deleted_by/deleted_reason).
  // Registro financeiro apagado de verdade destroi a trilha de auditoria — e a
  // trilha e justamente o que precisa sobrar para explicar o ajuste depois. A linha
  // estornada some de todo calculo (soma, saldo, relatorio) mas continua consultavel,
  // e o estorno e reversivel.
  //
  // CRITERIO DE QUAL MANTER: o lancamento do proprio Integra 2.0 (nota "Baixa
  // automatica boleto BB", com nosso numero na referencia). Empate: paid_at mais
  // antigo, depois created_at mais antigo.
  //
  // Body { "dryRun": true } (PADRAO) so mostra. { "dryRun": false } aplica.
  //      { "receivableIds": [...] } limita a titulos ja conferidos.
  // ============================================================================
  // ============================================================================
  // CONSOLE SQL — SOMENTE LEITURA (admin)
  // ----------------------------------------------------------------------------
  // Aba de consulta ao banco para auditoria. A garantia de leitura NAO se apoia so
  // em filtro de texto (que se contorna): a consulta roda dentro de uma transacao
  // READ ONLY de verdade, entao o proprio Postgres recusa qualquer escrita. O filtro
  // textual e a segunda barreira, e o statement_timeout evita derrubar o banco com
  // consulta pesada. Ao final sempre ROLLBACK.
  //
  //   GET  /api/admin/db/console  -> a aba (HTML)
  //   POST /api/admin/db/query    -> { sql, limit }
  // ============================================================================
  function apenasAdmin(req: any, res: any, next: any) {
    const u = req.currentUser || req.user;
    if (!u) return res.status(401).json({ message: 'Nao autenticado' });
    if (u.role !== 'admin') return res.status(403).json({ message: 'Console restrito a admin' });
    next();
  }

  const SQL_PROIBIDO = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|copy|call|do|merge|vacuum|analyze|reindex|cluster|lock|listen|notify|prepare|execute|deallocate|set|setval|nextval|reset|begin|commit|rollback|savepoint|refresh|import|security|pg_read_file|pg_ls_dir|pg_authid|pg_shadow|pg_sleep|lo_import|lo_export|dblink|postgres_fdw|dblink_exec)\b/i;
  // Colunas de segredo: o READ ONLY impede escrita, nao leitura. Sem isto um
  // "console de auditoria" entregaria client_secret do BB/Inter, senha de
  // certificado e hash de senha de usuario em texto puro.
  const SQL_SEGREDO = /\b(client_secret|app_secret|dev_app_key|senha_boletos|certificate_password|password|senha|access_token|refresh_token|api_key|secret)\b/i;
  const TABELAS_SENSIVEIS = /\b(financial_accounts|omie_instances|users|digital_certificates)\b/i;
  // Limite de consultas simultaneas: cada uma segura uma conexao do pool.
  let consultasEmCurso = 0;

  app.post('/api/admin/db/query', authenticateUser, apenasAdmin, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const bruto = String(req.body?.sql || '').trim();
      const limite = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 5000);
      if (!bruto) return res.status(400).json({ error: 'informe a consulta em "sql"' });

      // Uma instrucao so: ';' apenas no fim. Bloqueia "SELECT 1; DROP TABLE x".
      const semFim = bruto.replace(/;\s*$/, '');
      if (semFim.includes(';')) return res.status(400).json({ error: 'apenas uma instrucao por consulta (";" so no final)' });
      // Comentario pode esconder palavra proibida do filtro — recusamos.
      if (/--|\/\*/.test(semFim)) return res.status(400).json({ error: 'comentarios nao sao aceitos na consulta' });
      // Dollar-quoting ($$...$$ / $tag$...$tag$) dessincroniza a remocao de literais
      // abaixo (que so entende aspas simples) e permitia esconder palavra proibida do
      // filtro. Nenhuma consulta de auditoria precisa disso.
      if (/\$[A-Za-z0-9_]*\$/.test(semFim)) return res.status(400).json({ error: 'dollar-quoting ($$) nao e aceito' });
      if (/\bE'/i.test(semFim)) return res.status(400).json({ error: "string com escape (E'...') nao e aceita" });
      if (!/^\s*(select|with|explain|table)\b/i.test(semFim)) {
        return res.status(400).json({ error: 'somente SELECT, WITH, TABLE ou EXPLAIN' });
      }
      // O filtro de palavras roda SEM os literais de texto. A base e em portugues e
      // nomes como 'Moreira do Bem' ou 'Casa do Pao' cairiam no \bdo\b, recusando
      // consulta legitima. O que esta dentro de aspas e dado, nunca comando.
      const semLiterais = semFim.replace(/'(?:[^']|'')*'/g, "''");
      if (SQL_PROIBIDO.test(semLiterais)) {
        return res.status(400).json({ error: 'a consulta contem palavra reservada de escrita/comando — console e somente leitura' });
      }
      if (SQL_SEGREDO.test(semLiterais)) {
        return res.status(400).json({ error: 'a consulta referencia coluna de segredo (senha, token, client_secret) — bloqueado' });
      }
      // '*' numa tabela que guarda segredo traria as colunas sensiveis junto.
      if (/\*/.test(semLiterais) && TABELAS_SENSIVEIS.test(semLiterais)) {
        return res.status(400).json({ error: 'nesta tabela liste as colunas explicitamente (SELECT * traria colunas de segredo)' });
      }

      // EXPLAIN nao pode ser embrulhado em subconsulta; roda direto (a transacao
      // READ ONLY continua valendo).
      const ehExplain = /^\s*explain\b/i.test(semFim);
      const envolvida = ehExplain ? semFim : `SELECT * FROM (${semFim}) AS _q LIMIT ${limite}`;
      // Usa o POOL da aplicacao, nao uma conexao nova por request: abrir Client por
      // chamada deixava o console derrubar o banco por esgotamento de conexoes.
      if (consultasEmCurso >= 3) return res.status(429).json({ error: 'console ocupado (3 consultas simultaneas) — tente em instantes' });
      consultasEmCurso++;
      const cli: any = await pool.connect();
      try {
        // Barreira real: o Postgres recusa escrita nesta transacao, qualquer que seja o texto.
        await cli.query('BEGIN TRANSACTION READ ONLY');
        await cli.query("SET LOCAL statement_timeout = '10s'");
        const r: any = await cli.query(envolvida);
        await cli.query('ROLLBACK').catch(() => {});
        const cols = (r.fields || []).map((f: any) => f.name);
        res.json({ ok: true, colunas: cols, linhas: r.rows || [], total: (r.rows || []).length, limite, ms: Date.now() - t0 });
      } finally {
        try { await cli.query('ROLLBACK'); } catch (e: any) { /* ja encerrada */ }
        cli.release();
        consultasEmCurso--;
      }
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || e).slice(0, 400), ms: Date.now() - t0 });
    }
  });

  app.get('/api/admin/db/console', authenticateUser, apenasAdmin, async (_req: any, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<title>Console SQL (leitura) — Integra</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{--bg:#0f172a;--pn:#1e293b;--bd:#334155;--tx:#e2e8f0;--mut:#94a3b8;--ac:#38bdf8;--ok:#4ade80;--er:#f87171}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
 header{padding:12px 18px;border-bottom:1px solid var(--bd);display:flex;gap:12px;align-items:center}
 h1{font-size:15px;margin:0;font-weight:600} .tag{font-size:11px;color:var(--ok);border:1px solid var(--ok);border-radius:999px;padding:1px 9px}
 main{padding:18px;max-width:1500px;margin:0 auto}
 textarea{width:100%;height:150px;background:var(--pn);color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:12px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;resize:vertical}
 .row{display:flex;gap:10px;align-items:center;margin:10px 0;flex-wrap:wrap}
 button{background:var(--ac);color:#08131f;border:0;border-radius:7px;padding:8px 18px;font-weight:600;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 input[type=number]{width:90px;background:var(--pn);color:var(--tx);border:1px solid var(--bd);border-radius:7px;padding:7px}
 .msg{font-size:12px;color:var(--mut)} .err{color:var(--er);white-space:pre-wrap}
 .wrap{overflow:auto;max-height:60vh;border:1px solid var(--bd);border-radius:8px;margin-top:12px}
 table{border-collapse:collapse;width:100%;font-size:12.5px}
 th{position:sticky;top:0;background:#172033;text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);white-space:nowrap}
 td{padding:6px 10px;border-bottom:1px solid #1e293b;vertical-align:top;font-family:ui-monospace,Menlo,Consolas,monospace}
 tr:nth-child(even) td{background:#131d31}
 .ex{font-size:12px;color:var(--mut);margin-top:14px} .ex code{color:var(--ac);cursor:pointer;display:block;padding:3px 0}
</style></head><body>
<header><h1>Console SQL — Integra</h1><span class="tag">SOMENTE LEITURA</span>
<span class="msg">transacao READ ONLY · timeout 20s · uma instrucao por vez</span></header>
<main>
 <textarea id="q" spellcheck="false">SELECT status, count(*), sum(amount)::numeric(14,2) AS total
FROM receivables WHERE deleted_at IS NULL GROUP BY status ORDER BY 2 DESC</textarea>
 <div class="row"><button id="go">Executar</button>
  <label class="msg">limite <input type="number" id="lim" value="500" min="1" max="5000"></label>
  <span class="msg" id="st"></span></div>
 <div id="out"></div>
 <div class="ex"><b>Exemplos (clique para usar):</b>
  <code>SELECT count(*) FROM boleto_charges WHERE status = 'liquidado'</code>
  <code>SELECT * FROM receivable_payments WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC</code>
  <code>SELECT date_trunc('day', created_at) d, count(*) FROM account_movements WHERE created_at > now() - interval '60 days' GROUP BY 1 ORDER BY 1</code>
 </div>
</main>
<script>
 var q=document.getElementById('q'),go=document.getElementById('go'),st=document.getElementById('st'),out=document.getElementById('out'),lim=document.getElementById('lim');
 document.querySelectorAll('.ex code').forEach(function(c){c.onclick=function(){q.value=c.textContent;}});
 function esc(v){ if(v===null||v===undefined) return '<span style="color:#64748b">null</span>';
   if(typeof v==='object') v=JSON.stringify(v);
   return String(v).replace(/[&<>]/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[m];}); }
 async function run(){ go.disabled=true; st.textContent='executando...'; out.innerHTML='';
  try{ var r=await fetch('/api/admin/db/query',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql:q.value,limit:Number(lim.value)||500})});
   var j=await r.json();
   if(!r.ok||j.error){ st.textContent=''; out.innerHTML='<div class="err">'+esc(j.error||('HTTP '+r.status))+'</div>'; return; }
   st.textContent=j.total+' linha(s) · '+j.ms+' ms'+(j.total>=j.limite?' · LIMITE ATINGIDO':'');
   if(!j.total){ out.innerHTML='<div class="msg">sem resultados</div>'; return; }
   var h='<div class="wrap"><table><thead><tr>'+j.colunas.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
   h+=j.linhas.map(function(L){return '<tr>'+j.colunas.map(function(c){return '<td>'+esc(L[c])+'</td>';}).join('')+'</tr>';}).join('');
   out.innerHTML=h+'</tbody></table></div>';
  }catch(e){ st.textContent=''; out.innerHTML='<div class="err">'+esc(e)+'</div>'; }
  finally{ go.disabled=false; } }
 go.onclick=run;
 q.addEventListener('keydown',function(e){ if((e.ctrlKey||e.metaKey)&&e.key==='Enter') run(); });
</script></body></html>`);
  });

  app.post('/api/admin/financial/estornar-pagamentos-duplicados', authenticateUser, isFinancialAuthorized, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const limit = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 2000);
      const pediuIds = Array.isArray(req.body?.receivableIds);
      const ids: string[] = pediuIds
        ? req.body.receivableIds.map((x: any) => String(x).trim()).filter((x: string) => /^[0-9a-fA-F-]{8,40}$/.test(x))
        : [];
      if (pediuIds && ids.length === 0) {
        return res.status(400).json({ error: 'receivableIds informado mas nenhum id valido', recebidos: req.body.receivableIds });
      }

      // Colunas de estorno (aditivo e idempotente).
      await db.execute(sql.raw("ALTER TABLE receivable_payments ADD COLUMN IF NOT EXISTS deleted_at timestamp"));
      await db.execute(sql.raw("ALTER TABLE receivable_payments ADD COLUMN IF NOT EXISTS deleted_by varchar"));
      await db.execute(sql.raw("ALTER TABLE receivable_payments ADD COLUMN IF NOT EXISTS deleted_reason text"));

      const ator = actorOf(req);
      const quem = (ator?.email || ator?.id || 'sistema').slice(0, 120);
      const filtroId = ids.length ? " AND rp.receivable_id IN (" + ids.map((x) => "'" + x + "'").join(',') + ")" : '';
      const chave = "COALESCE(NULLIF(rp.reference,''), substring(rp.notes from '[0-9]{10,20}'))";
      // rn=1 e o que FICA. Ordem: lancamento do 2.0 primeiro, depois com referencia
      // preenchida, depois data de pagamento mais antiga.
      const ranked = `
        SELECT rp.id, rp.receivable_id, rp.amount::numeric AS amount, rp.paid_at, rp.reference, rp.notes,
               ${chave} AS chave,
               ROW_NUMBER() OVER (PARTITION BY rp.receivable_id, ${chave} ORDER BY
                 (CASE WHEN COALESCE(rp.notes,'') LIKE 'Baixa automatica boleto BB%' THEN 0 ELSE 1 END),
                 (CASE WHEN COALESCE(rp.reference,'') <> '' THEN 0 ELSE 1 END),
                 rp.paid_at ASC, rp.created_at ASC) AS rn,
               COUNT(*) OVER (PARTITION BY rp.receivable_id, ${chave}) AS no_grupo
        FROM receivable_payments rp
        JOIN receivables r ON r.id = rp.receivable_id
        WHERE rp.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'
          AND ${chave} IS NOT NULL${filtroId}`;

      const alvos: any = await db.execute(sql.raw(
        `WITH ranked AS (${ranked}) SELECT * FROM ranked WHERE no_grupo > 1 AND rn > 1 ORDER BY amount DESC LIMIT ${limit}`));
      const linhas: any[] = alvos.rows || [];
      const porTitulo = new Map<string, any[]>();
      for (const l of linhas) {
        const k = String(l.receivable_id);
        if (!porTitulo.has(k)) porTitulo.set(k, []);
        porTitulo.get(k)!.push(l);
      }
      const totalEstorno = linhas.reduce((t, l) => t + Number(l.amount || 0), 0);

      if (dryRun) {
        return res.json({
          dryRun: true, titulosAfetados: porTitulo.size, linhasAEstornar: linhas.length,
          valorAEstornar: totalEstorno.toFixed(2),
          criterio: 'mantem o lancamento do Integra 2.0 (nota "Baixa automatica boleto BB" / com nosso numero); empate por paid_at mais antigo',
          amostra: linhas.slice(0, 25).map((l) => ({ pagamentoId: l.id, receivableId: l.receivable_id, valor: Number(l.amount), nossoNumero: l.chave, pagoEm: l.paid_at, nota: String(l.notes || '').slice(0, 60) })),
        });
      }

      const motivo = `Estorno de baixa duplicada do mesmo boleto (auditoria ${new Date().toISOString().slice(0, 10)})`;
      const idsLinhas = linhas.map((l) => String(l.id));
      let estornadas = 0;
      if (idsLinhas.length) {
        const upd: any = await db.execute(sql.raw(
          "UPDATE receivable_payments SET deleted_at = now(), deleted_by = '" + quem.replace(/'/g, "''") +
          "', deleted_reason = '" + motivo.replace(/'/g, "''") + "' WHERE deleted_at IS NULL AND id IN (" +
          idsLinhas.map((x) => "'" + x + "'").join(',') + ")"));
        estornadas = upd.rowCount ?? idsLinhas.length;
      }

      // Recalcula amount_paid e status a partir das linhas que SOBRARAM.
      const recalc: any[] = [];
      for (const [recId, ls] of porTitulo.entries()) {
        try {
          const antes: any = await db.execute(sql`SELECT title_number, amount::numeric AS amount, COALESCE(amount_paid,0)::numeric AS pago, status FROM receivables WHERE id = ${recId}`);
          const a = (antes.rows || [])[0]; if (!a) continue;
          const som: any = await db.execute(sql`SELECT COALESCE(SUM(amount::numeric),0) AS total FROM receivable_payments WHERE receivable_id = ${recId} AND deleted_at IS NULL`);
          const novo = Number((som.rows || [])[0]?.total || 0);
          const val = Number(a.amount || 0);
          await db.execute(sql.raw(
            "UPDATE receivables SET amount_paid = " + novo.toFixed(2) +
            ", status = (CASE WHEN " + novo.toFixed(2) + " >= amount::numeric - 0.005 THEN 'recebida' " +
            "WHEN (due_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'vencida' " +
            "ELSE 'a_vencer' END)::receivable_status, updated_at = now(), updated_by = 'estorno-duplicidade' WHERE id = '" + recId.replace(/'/g, "''") + "'"));
          const dep: any = await db.execute(sql`SELECT COALESCE(amount_paid,0)::numeric AS pago, status FROM receivables WHERE id = ${recId}`);
          const d = (dep.rows || [])[0] || {};
          recalc.push({ receivableId: recId, titulo: a.title_number, valor: val, antes: Number(a.pago), depois: Number(d.pago || 0), statusAntes: a.status, statusDepois: d.status, linhasEstornadas: ls.length });
          await logFinancialAudit({
            req, action: 'reverse', entity: 'receivable', entityId: String(recId),
            before: { amountPaid: Number(a.pago), status: a.status },
            after: { amountPaid: Number(d.pago || 0), status: d.status },
            amount: Number(a.pago) - Number(d.pago || 0),
            note: `${motivo} — ${ls.length} lancamento(s) estornado(s): ${ls.map((x: any) => x.id).join(', ')}`,
          });
        } catch (e: any) {
          recalc.push({ receivableId: recId, erro: String(e?.message || e).slice(0, 160) });
        }
      }

      res.json({
        dryRun: false, titulosAfetados: porTitulo.size, linhasEstornadas: estornadas,
        valorEstornado: totalEstorno.toFixed(2), estornadoPor: quem, motivo,
        observacao: 'As linhas NAO foram apagadas: seguem na tabela com deleted_at/deleted_by/deleted_reason e saem de todo calculo. Para reverter, basta limpar deleted_at.',
        titulos: recalc,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
    }
  });

  app.get('/api/admin/financial/auditoria-baixas', authenticateUser, isFinancialReadAuthorized, async (req: any, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query?.limit) || 300, 1), 2000);
      const soVencida = String(req.query?.status || 'todas').toLowerCase() === 'vencida';
      const filtroStatus = soVencida ? " AND r.status = 'vencida'" : "";
      const many = async (q: string) => { const r: any = await db.execute(sql.raw(q)); return ((r.rows || r) as any[]); };
      const hoje = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";
      const venc = "(r.due_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date";
      const base = "FROM receivables r WHERE r.deleted_at IS NULL AND r.status <> 'cancelada'" + filtroStatus;
      const cols = "r.id, r.title_number AS titulo, r.customer_name AS cliente, r.customer_document AS documento, r.amount::float AS valor, COALESCE(r.amount_paid,0)::float AS baixado, r.status, " + venc + " AS vencimento, r.payment_method AS forma, r.updated_by AS alterado_por";

      // A) PAGAMENTO DUPLICADO: mesmo titulo, mesmo valor, mesma data e mesma
      // referencia aparecendo mais de uma vez. E o achado mais grave: infla o
      // amount_paid e "quita" titulo que nao foi pago.
      // CORRIGIDO: agrupar por DATA escondia a maior parte do problema — a varredura
      // noturna lancava a mesma baixa em dias diferentes, e o Sistema 1.0 gravava com
      // paid_at diferente do nosso. A chave certa e (titulo + nosso numero): um boleto
      // paga UMA vez, entao duas linhas com o mesmo nosso numero no mesmo titulo sao
      // duplicata, nao importa a data nem quem escreveu.
      const chaveNosso = "COALESCE(NULLIF(rp.reference,''), substring(rp.notes from '[0-9]{10,20}'))";
      const duplicados = await many(
        "SELECT rp.receivable_id, r.title_number AS titulo, r.customer_name AS cliente, " +
        "r.amount::float AS valor_titulo, COALESCE(r.amount_paid,0)::float AS baixado, " +
        chaveNosso + " AS nosso_numero, COUNT(*)::int AS vezes, SUM(rp.amount::numeric)::float AS soma_lancada, " +
        "(SUM(rp.amount::numeric) - MAX(rp.amount::numeric))::float AS excesso, " +
        "array_agg(rp.id::text) AS pagamento_ids, array_agg(rp.amount::text) AS valores, " +
        "array_agg(to_char(rp.paid_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD')) AS datas, " +
        "array_agg(COALESCE(rp.created_by,'')) AS criado_por, array_agg(COALESCE(rp.notes,'')) AS notas " +
        "FROM receivable_payments rp JOIN receivables r ON r.id = rp.receivable_id " +
        "WHERE rp.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada' AND " + chaveNosso + " IS NOT NULL " +
        "GROUP BY rp.receivable_id, r.title_number, r.customer_name, r.amount, r.amount_paid, " + chaveNosso + " " +
        "HAVING COUNT(*) > 1 ORDER BY excesso DESC LIMIT " + limit);

      // B) amount_paid DIVERGE da soma dos pagamentos (para mais ou para menos)
      const divergencia = await many(
        "SELECT " + cols + ", p.total::float AS soma_pagamentos, (COALESCE(r.amount_paid,0) - p.total)::float AS diferenca, p.qtd " +
        base.replace('FROM receivables r WHERE', "FROM receivables r JOIN (SELECT receivable_id, SUM(amount::numeric) total, COUNT(*)::int qtd FROM receivable_payments WHERE deleted_at IS NULL GROUP BY receivable_id) p ON p.receivable_id = r.id WHERE") +
        " AND COALESCE(r.amount_paid,0)::numeric IS DISTINCT FROM p.total ORDER BY ABS(COALESCE(r.amount_paid,0) - p.total) DESC LIMIT " + limit);

      // C) SUPERBAIXA: baixado alem do valor do titulo
      const superbaixa = await many("SELECT " + cols + ", (COALESCE(r.amount_paid,0) - r.amount)::float AS excesso " + base +
        " AND COALESCE(r.amount_paid,0)::numeric > r.amount::numeric + 0.005 ORDER BY excesso DESC LIMIT " + limit);

      // D) QUITADO SEM STATUS: pago integral mas continua em aberto/vencida
      const quitadoSemStatus = await many("SELECT " + cols + " " + base +
        " AND r.status <> 'recebida' AND COALESCE(r.amount_paid,0)::numeric >= r.amount::numeric - 0.005 AND r.amount::numeric > 0 ORDER BY r.amount DESC LIMIT " + limit);

      // E) STATUS SEM LASTRO: marcado 'recebida' sem ter baixa integral
      const recebidaSemBaixa = await many("SELECT " + cols + ", (r.amount - COALESCE(r.amount_paid,0))::float AS falta " +
        "FROM receivables r WHERE r.deleted_at IS NULL AND r.status = 'recebida' AND COALESCE(r.amount_paid,0)::numeric < r.amount::numeric - 0.005 ORDER BY falta DESC LIMIT " + limit);

      // F) STATUS x VENCIMENTO trocados (a_vencer com data no passado e vice-versa)
      const statusVencimento = await many("SELECT " + cols + ", CASE WHEN r.status = 'a_vencer' THEN 'deveria ser vencida' ELSE 'deveria ser a_vencer' END AS esperado " + base +
        " AND r.status IN ('a_vencer','vencida') AND ((r.status = 'a_vencer' AND " + venc + " < " + hoje + ") OR (r.status = 'vencida' AND " + venc + " >= " + hoje + ")) ORDER BY r.due_date LIMIT " + limit);

      // G) RESIDUO: titulo em aberto com baixa parcial (tipicamente desconto do cliente)
      const residuo = await many("SELECT " + cols + ", (r.amount - COALESCE(r.amount_paid,0))::float AS saldo " + base +
        " AND r.status IN ('a_vencer','vencida') AND COALESCE(r.amount_paid,0)::numeric > 0 AND COALESCE(r.amount_paid,0)::numeric < r.amount::numeric - 0.005 ORDER BY saldo DESC LIMIT " + limit);

      // H) PAGAMENTO SEM CONTA (sem lastro bancario) em titulo ainda em aberto
      const semLastro = await many(
        "SELECT rp.id AS pagamento_id, rp.receivable_id, r.title_number AS titulo, r.customer_name AS cliente, rp.amount::float AS valor, " +
        "(rp.paid_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date AS pago_em, rp.payment_method AS forma, rp.created_by, rp.reference, rp.notes " +
        "FROM receivable_payments rp JOIN receivables r ON r.id = rp.receivable_id " +
        "WHERE rp.deleted_at IS NULL AND rp.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada' ORDER BY rp.paid_at DESC NULLS LAST LIMIT " + limit);

      // ESTORNOS JA FEITOS — a linha nao e apagada, entao o historico do ajuste fica
      // visivel aqui (quem estornou, quando e por que).
      let estornos: any[] = [];
      try {
        estornos = await many(
          "SELECT rp.id AS pagamento_id, rp.receivable_id, r.title_number AS titulo, r.customer_name AS cliente, " +
          "rp.amount::float AS valor, to_char(rp.deleted_at,'YYYY-MM-DD HH24:MI') AS estornado_em, " +
          "rp.deleted_by AS estornado_por, rp.deleted_reason AS motivo, rp.reference AS nosso_numero " +
          "FROM receivable_payments rp JOIN receivables r ON r.id = rp.receivable_id " +
          "WHERE rp.deleted_at IS NOT NULL ORDER BY rp.deleted_at DESC LIMIT " + limit);
      } catch (e: any) { /* coluna ainda nao existe: nenhum estorno feito */ }

      const soma = (xs: any[], k: string) => Number(xs.reduce((t, x) => t + Number(x[k] || 0), 0).toFixed(2));
      res.json({
        geradoEm: new Date().toISOString(),
        escopo: soVencida ? 'somente vencidas' : 'todos os titulos ativos',
        resumo: {
          pagamentoDuplicado: { n: duplicados.length, excesso: soma(duplicados, 'excesso') },
          amountPaidDivergente: { n: divergencia.length, diferenca: soma(divergencia, 'diferenca') },
          superbaixa: { n: superbaixa.length, excesso: soma(superbaixa, 'excesso') },
          quitadoSemStatus: { n: quitadoSemStatus.length, valor: soma(quitadoSemStatus, 'valor') },
          recebidaSemBaixa: { n: recebidaSemBaixa.length, falta: soma(recebidaSemBaixa, 'falta') },
          statusVencimentoErrado: { n: statusVencimento.length },
          residuoEmAberto: { n: residuo.length, saldo: soma(residuo, 'saldo') },
          pagamentoSemLastro: { n: semLastro.length, valor: soma(semLastro, 'valor') },
          estornosRealizados: { n: estornos.length, valor: soma(estornos, 'valor') },
        },
        pagamentoDuplicado: duplicados,
        amountPaidDivergente: divergencia,
        superbaixa,
        quitadoSemStatus,
        recebidaSemBaixa,
        statusVencimentoErrado: statusVencimento,
        residuoEmAberto: residuo,
        pagamentoSemLastro: semLastro,
        estornosRealizados: estornos,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
    }
  });

  // Colunas de estorno de movimento de conta. Aditivas e idempotentes (padrao dos
  // demais ensure*): a linha NUNCA e apagada, so marcada, para o ajuste ser
  // reversivel e auditavel. Nao vao no schema drizzle de proposito — coluna no
  // schema sem coluna no banco quebra todo SELECT da tabela.
  let __estornoColsReady = false;
  async function ensureEstornoColumns() {
    if (__estornoColsReady) return;
    try { await db.execute(sql`ALTER TABLE account_movements ADD COLUMN IF NOT EXISTS reversed_at timestamp`); } catch {}
    try { await db.execute(sql`ALTER TABLE account_movements ADD COLUMN IF NOT EXISTS reversed_by varchar`); } catch {}
    try { await db.execute(sql`ALTER TABLE account_movements ADD COLUMN IF NOT EXISTS reversed_reason text`); } catch {}
    __estornoColsReady = true;
  }

  // ============================================================================
  // RECONCILIACAO DO SALDO CONTRA O EXTRATO OFICIAL DO BANCO — SOMENTE LEITURA
  // GET /api/admin/financial/saldo-oficial[?accountId=]
  //
  // Responde "o saldo que o sistema mostra bate com o banco?" e, quando nao bate,
  // DE ONDE vem a diferenca. Tres saldos independentes por conta:
  //
  //   (1) GRAVADO  financial_accounts.balance — o numero que a tela mostra.
  //   (2) RAZAO    soma assinada de account_movements — o razao interno.
  //   (3) OFICIAL  ancora LEDGERBAL do extrato do banco + movimento do Livro
  //                (bank_statement_items) depois da ancora.
  //
  // So (3) e fonte de verdade: e o banco falando. (1) e (2) sao o sistema falando.
  //
  // QUAL ANCORA E "O EXTRATO OFICIAL": o BB exporta em dois formatos e eles NAO se
  // equivalem como fonte de saldo.
  //   * "Extrato conta corrente - MMAAAA.ofx" (internet banking): o DTASOF e o
  //     FECHAMENTO do periodo. E o extrato oficial.
  //   * "Extrato41483238163 - <timestamp>.ofx" (Gerenciador/API): o LEDGERBAL e
  //     FOTO DO INSTANTE DA EXPORTACAO. Exportado as 10h de D, ele carrega o saldo
  //     do fim de D-1 mas escreve DTASOF = D. Tratar isso como fechamento do dia da
  //     conferencia falsa — foi exatamente o que ocorreu em 03/08/2026: o extrato
  //     oficial marcava 5.059,87 e o do Gerenciador, no MESMO dia, -499,56.
  // Prioridade da ancora: nome do arquivo com "OFICIAL" > extrato mensal do
  // internet banking > Gerenciador. As do Gerenciador vao na resposta com
  // confiavel=false e NAO sao usadas como referencia quando existe uma melhor.
  //
  // A ancora de referencia e a MAIS RECENTE de maior prioridade. Dela sai o saldo
  // base da conta (base = saldoBanco - movimento do Livro ate a ancora); com a base,
  // o saldo calculado em qualquer data e base + movimento acumulado, e a conferencia
  // contra as demais ancoras mostra em que data o Livro descolou do banco. A ancora
  // de referencia fecha por construcao (calibracao) e vem marcada como tal.
  //
  // Nenhuma escrita. Nao concilia, nao da baixa, nao corrige saldo.
  // ============================================================================
  app.get('/api/admin/financial/saldo-oficial', authenticateUser, isFinancialAuthorized, async (req: any, res) => {
    try {
      await ensureEstornoColumns();
      const accountId = (req.query?.accountId as string) || null;
      const linhas = async (query: any): Promise<any[]> => { const r: any = await db.execute(query); return (r.rows || r) as any[]; };
      const n2 = (v: any) => Number(Number(v || 0).toFixed(2));

      const contas = await linhas(sql`
        SELECT id, name, COALESCE(balance::numeric, 0) AS saldo_gravado
        FROM financial_accounts
        WHERE (${accountId}::text IS NULL OR id = ${accountId})
        ORDER BY name`);

      const razao = await linhas(sql`
        SELECT financial_account_id AS acc, count(*) AS n,
               count(*) FILTER (WHERE type = 'credito') AS creditos,
               count(*) FILTER (WHERE type = 'debito') AS debitos,
               COALESCE(sum(CASE WHEN type = 'credito' THEN amount::numeric ELSE -amount::numeric END), 0) AS soma,
               min(created_at)::date AS de, max(created_at)::date AS ate
        FROM account_movements
        WHERE reversed_at IS NULL
          AND (${accountId}::text IS NULL OR financial_account_id = ${accountId})
        GROUP BY 1`);

      // Duplicata no razao: a MESMA origem (um boleto, um PIX) creditada mais de uma
      // vez. E o espelho contabil da baixa duplicada — cada baixa a mais gerou um
      // credito a mais, e o credito nao foi desfeito quando a baixa foi estornada.
      const dupRazao = await linhas(sql`
        SELECT financial_account_id AS acc, count(*) AS grupos,
               COALESCE(sum(n - 1), 0) AS linhas_excedentes,
               COALESCE(sum(excedente), 0) AS valor_excedente
        FROM (
          SELECT financial_account_id, source_type, source_id, count(*) AS n,
                 (count(*) - 1) * max(amount::numeric) AS excedente
          FROM account_movements
          WHERE source_id IS NOT NULL AND reversed_at IS NULL
            AND (${accountId}::text IS NULL OR financial_account_id = ${accountId})
          GROUP BY 1, 2, 3 HAVING count(*) > 1
        ) t GROUP BY 1`);

      // balance_after deveria ser uma cadeia: cada linha = a anterior +/- o valor.
      // Elo quebrado = duas escritas concorrentes leram o mesmo saldo (o modulo nao
      // usa transacao). Com elo quebrado, balance_after nao serve para reconstruir saldo.
      const elos = await linhas(sql`
        SELECT acc, count(*) FILTER (WHERE ba_ant IS NOT NULL AND round(ba - ba_ant, 2) <> round(amt, 2)) AS quebrados
        FROM (
          SELECT financial_account_id AS acc,
                 CASE WHEN type = 'credito' THEN amount::numeric ELSE -amount::numeric END AS amt,
                 balance_after::numeric AS ba,
                 lag(balance_after::numeric) OVER (PARTITION BY financial_account_id ORDER BY created_at, id) AS ba_ant
          FROM account_movements
          WHERE reversed_at IS NULL
            AND (${accountId}::text IS NULL OR financial_account_id = ${accountId})
        ) x GROUP BY acc`);

      const ancoras = await linhas(sql`
        SELECT s.financial_account_id AS acc, s.file_name AS arquivo,
               substring(i.raw_ofx from '"saldoData":"([^"]*)"') AS dt,
               substring(i.raw_ofx from '"saldoFinal":"([^"]*)"') AS bal
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
        WHERE i.raw_ofx LIKE '%saldoFinal%'
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
        GROUP BY 1, 2, 3, 4`);

      // Movimento diario do Livro. Linha ESPELHO (mesma transacao vinda de dois
      // arquivos) e linha informativa de SALDO ficam de fora: nao movimentaram dinheiro.
      const dias = await linhas(sql`
        SELECT s.financial_account_id AS acc, i.transaction_date::date::text AS d,
               COALESCE(sum(CASE WHEN i.type = 'C' THEN i.amount::numeric ELSE -i.amount::numeric END), 0) AS mov
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
        WHERE i.mirror_of IS NULL AND COALESCE(i.reconciliation_status, 'pending') <> 'saldo'
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
        GROUP BY 1, 2`);

      const porConta = (arr: any[]) => { const m: Record<string, any[]> = {}; for (const r of arr) (m[String(r.acc)] ||= []).push(r); return m; };
      const razaoPor = porConta(razao), dupPor = porConta(dupRazao), elosPor = porConta(elos);
      const ancPor = porConta(ancoras), diasPor = porConta(dias);

      const fonteDe = (arquivo: string) => /oficial/i.test(arquivo || '') ? 'oficial'
        : (/^\s*extrato\s+conta\s+corrente/i.test(arquivo || '') ? 'mensal' : 'gerenciador');
      const pesoDe = (f: string) => (f === 'oficial' ? 3 : f === 'mensal' ? 2 : 1);

      const saida = contas.map((c: any) => {
        const id = String(c.id);
        const rz = (razaoPor[id] || [])[0] || null;
        const dp = (dupPor[id] || [])[0] || null;
        const el = (elosPor[id] || [])[0] || null;
        const ds = (diasPor[id] || []).map((r: any) => ({ d: String(r.d), mov: Number(r.mov) })).sort((a, b) => (a.d < b.d ? -1 : 1));

        // uma ancora por data: fica a de maior prioridade de fonte
        const porData: Record<string, any> = {};
        for (const a of (ancPor[id] || [])) {
          if (!a.dt || a.bal === null || a.bal === undefined) continue;
          const f = fonteDe(String(a.arquivo || ''));
          const cand = { data: String(a.dt), saldoBanco: n2(a.bal), arquivo: String(a.arquivo || ''), fonte: f, confiavel: f !== 'gerenciador' };
          const atual = porData[cand.data];
          if (!atual || pesoDe(cand.fonte) > pesoDe(atual.fonte)) porData[cand.data] = cand;
        }
        const listaAnc = Object.values(porData).sort((a: any, b: any) => (a.data < b.data ? -1 : 1));

        // referencia = melhor fonte; entre as de mesma fonte, a mais recente
        let ref: any = null;
        for (const a of listaAnc) if (!ref || pesoDe(a.fonte) > pesoDe(ref.fonte) || (pesoDe(a.fonte) === pesoDe(ref.fonte) && a.data > ref.data)) ref = a;

        const somaAte = (D: string) => ds.reduce((s, r) => (r.d <= D ? s + r.mov : s), 0);
        const movTotal = ds.reduce((s, r) => s + r.mov, 0);
        const saldoBase = ref ? n2(ref.saldoBanco - somaAte(ref.data)) : null;
        const movApos = ref ? n2(movTotal - somaAte(ref.data)) : null;
        const saldoOficial = ref ? n2(ref.saldoBanco + (movApos as number)) : null;

        const conferencia = listaAnc.map((a: any) => {
          const calc = saldoBase === null ? null : n2(saldoBase + somaAte(a.data));
          return {
            data: a.data, arquivo: a.arquivo, fonte: a.fonte, confiavel: a.confiavel,
            saldoBanco: a.saldoBanco, saldoCalculado: calc,
            diferenca: calc === null ? null : n2(calc - a.saldoBanco),
            referencia: !!ref && a.data === ref.data && a.arquivo === ref.arquivo,
          };
        });

        const gravado = n2(c.saldo_gravado);
        const somaRazao = rz ? n2(rz.soma) : 0;
        const alertas: string[] = [];
        if (rz && Number(rz.debitos) === 0 && Number(rz.n) > 0) {
          alertas.push('account_movements nao tem NENHUM debito (' + rz.creditos + ' creditos, 0 debitos): pagamento a fornecedor nunca debitou a conta. O razao interno nao consegue produzir saldo.');
        }
        if (dp && Number(dp.linhas_excedentes) > 0) {
          alertas.push('Razao com credito duplicado: ' + dp.grupos + ' origens creditadas mais de uma vez, ' + dp.linhas_excedentes + ' linhas excedentes, R$ ' + n2(dp.valor_excedente) + ' a mais.');
        }
        if (el && Number(el.quebrados) > 0) {
          alertas.push('Cadeia de balance_after com ' + el.quebrados + ' elo(s) quebrado(s): houve escrita concorrente sem transacao. balance_after nao serve de saldo.');
        }
        if (!ref) alertas.push('Sem ancora de saldo: nenhum extrato desta conta trouxe LEDGERBAL (extratos importados antes do raw_ofx nao tem). Sem isso nao ha como conferir contra o banco.');
        else if (ref.fonte === 'gerenciador') alertas.push('A unica ancora disponivel vem do Gerenciador (foto do instante da exportacao). Importe o extrato mensal do internet banking para uma conferencia confiavel.');
        if (ref && Math.abs(gravado - (saldoOficial as number)) > 0.01) {
          alertas.push('Saldo GRAVADO diverge do banco em R$ ' + n2(gravado - (saldoOficial as number)) + '.');
        }
        const descolou = conferencia.filter((x: any) => !x.referencia && x.diferenca !== null && Math.abs(x.diferenca) > 0.01);
        if (descolou.length) alertas.push('O Livro descola do banco em ' + descolou.length + ' das ' + conferencia.length + ' ancoras. Primeira data com diferenca: ' + descolou[0].data + ' (R$ ' + descolou[0].diferenca + ').');

        return {
          conta: { id, nome: c.name },
          saldoGravado: gravado,
          razaoInterno: {
            movimentos: rz ? Number(rz.n) : 0, creditos: rz ? Number(rz.creditos) : 0, debitos: rz ? Number(rz.debitos) : 0,
            soma: somaRazao, de: rz ? rz.de : null, ate: rz ? rz.ate : null,
            elosQuebrados: el ? Number(el.quebrados) : 0,
            duplicados: { grupos: dp ? Number(dp.grupos) : 0, linhas: dp ? Number(dp.linhas_excedentes) : 0, valor: dp ? n2(dp.valor_excedente) : 0 },
          },
          extratoOficial: ref ? { data: ref.data, saldoBanco: ref.saldoBanco, arquivo: ref.arquivo, fonte: ref.fonte } : null,
          livro: { dias: ds.length, de: ds.length ? ds[0].d : null, ate: ds.length ? ds[ds.length - 1].d : null, movimento: n2(movTotal), movimentoAposAncora: movApos, saldoBase },
          saldoOficial,
          divergencias: {
            gravadoVsOficial: saldoOficial === null ? null : n2(gravado - saldoOficial),
            razaoVsOficial: saldoOficial === null ? null : n2(somaRazao - saldoOficial),
            razaoVsGravado: n2(somaRazao - gravado),
          },
          conferenciaPorAncora: conferencia,
          alertas,
        };
      });

      res.json({
        geradoEm: new Date().toISOString(),
        somenteLeitura: true,
        criterioDaAncora: 'arquivo com OFICIAL no nome > extrato mensal do internet banking > Gerenciador (foto do instante, confiavel=false)',
        contas: saida,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
    }
  });

  // ============================================================================
  // ESTORNO DOS CREDITOS DE COBRANCA SEM LASTRO — item 2
  // POST /api/admin/financial/estornar-creditos-duplicados
  //      { dryRun, sourceTypes, motivo, by }   — dryRun:true por padrao
  //
  // REGRA: cada credito na conta e o espelho de UMA baixa. Para cada cobranca
  // (chave = source_type + reference, que e o NOSSO NUMERO do boleto / o e2e do
  // PIX — a mesma chave do indice ux_receivable_payments_ref), o numero de
  // creditos que DEVE existir e o numero de baixas ATIVAS (receivable_payments
  // com deleted_at IS NULL) daquela reference. O que passar disso e credito sem
  // lastro e e estornado.
  //
  // A regra cobre DOIS defeitos diferentes, e o segundo e invisivel para qualquer
  // contagem de "duplicata":
  //   (a) credito DUPLICADO — a mesma cobranca creditada 2, 3 ou 13 vezes;
  //   (b) credito ORFAO — a baixa foi estornada e o credito ficou. E um credito
  //       UNICO: nao aparece em "source_id com mais de uma linha". So aparece
  //       quando se compara com a baixa.
  //
  // QUEM FICA: entre os creditos da mesma cobranca ficam os que casam em VALOR
  // com uma baixa ativa (1 para 1, mais antigo primeiro) e, se ainda faltar
  // credito para alguma baixa, completa-se com o mais antigo restante. Assim
  // pagamento parcial legitimo (duas baixas de valores diferentes no mesmo
  // boleto) e preservado por construcao, em vez de virar "duplicata".
  //
  // NAO apaga linha: marca reversed_at/reversed_by/reversed_reason — reversivel,
  // com trilha em financial_audit_log, no mesmo padrao do estorno de pagamento.
  //
  // NAO mexe em financial_accounts.balance. Corrigir so o credito trocaria um
  // numero errado por outro enquanto account_movements nao tiver DEBITO nenhum:
  // o saldo correto sai do extrato oficial (GET /api/admin/financial/saldo-oficial).
  // ============================================================================
  app.post('/api/admin/financial/estornar-creditos-duplicados', authenticateUser, isFinancialAuthorized, async (req: any, res) => {
    try {
      await ensureEstornoColumns();
      const dryRun = req.body?.dryRun !== false;
      const motivo = String(req.body?.motivo || 'Credito sem baixa ativa correspondente (duplicado ou orfao de baixa estornada)').slice(0, 300);
      const ator = actorOf(req);
      const por = String(req.body?.by || ator.email || ator.id || 'auditoria-financeira').slice(0, 120);
      const pedidos: string[] = Array.isArray(req.body?.sourceTypes) && req.body.sourceTypes.length
        ? req.body.sourceTypes.map((x: any) => String(x))
        : ['boleto_charge', 'pix_charge'];
      const tipos = pedidos.filter((t) => t === 'boleto_charge' || t === 'pix_charge');
      if (!tipos.length) return res.status(400).json({ error: 'sourceTypes aceita apenas boleto_charge e/ou pix_charge' });

      const linhas = async (query: any): Promise<any[]> => { const r: any = await db.execute(query); return (r.rows || r) as any[]; };
      const n2 = (v: any) => Number(Number(v || 0).toFixed(2));

      const creditos = await linhas(sql`
        SELECT id, financial_account_id AS acc, source_type, source_id, reference,
               amount::numeric AS valor, created_at
        FROM account_movements
        WHERE type = 'credito' AND reversed_at IS NULL
          AND source_type IN (${sql.join(tipos.map((t) => sql`${t}`), sql`, `)})
          AND reference IS NOT NULL AND reference <> ''
        ORDER BY reference, created_at, id`);

      // Baixas ativas por reference. Sem filtro por lista de reference: a lista
      // passa de mil itens e viraria um IN gigante — e o custo aqui e o mesmo.
      const pagamentos = await linhas(sql`
        SELECT reference, amount::numeric AS valor
        FROM receivable_payments
        WHERE deleted_at IS NULL AND reference IS NOT NULL AND reference <> ''`);

      // TRAVA CONTRA FALSO POSITIVO: baixa lancada SEM reference (conciliacao manual,
      // baixa a mao) nao casa por nosso numero e faria o credito parecer orfao. Se o
      // TITULO da cobranca tem baixa ativa, o credito nao e estornado — vai para
      // revisarManual, com o operador decidindo.
      const tituloComBaixa = new Set<string>();
      for (const tabela of ['boleto_charges', 'pix_charges']) {
        try {
          const r: any = await db.execute(sql.raw(
            'SELECT c.id AS sid FROM ' + tabela + ' c WHERE c.receivable_id IS NOT NULL AND EXISTS ' +
            '(SELECT 1 FROM receivable_payments p WHERE p.receivable_id = c.receivable_id AND p.deleted_at IS NULL)'));
          for (const x of ((r.rows || r) as any[])) tituloComBaixa.add(String(x.sid));
        } catch (e: any) { /* tabela ausente: trava so nao se aplica a ela */ }
      }

      const baixasPorRef: Record<string, number[]> = {};
      for (const p of pagamentos) (baixasPorRef[String(p.reference)] ||= []).push(n2(p.valor));

      const grupos: Record<string, any[]> = {};
      for (const c of creditos) (grupos[String(c.source_type) + '|' + String(c.reference)] ||= []).push(c);

      const aEstornar: any[] = [];
      const amostra: any[] = [];
      let gruposDuplicado = 0, gruposOrfao = 0;
      const revisarManual: any[] = [];
      for (const chave of Object.keys(grupos)) {
        const lista = grupos[chave];
        const sep = chave.indexOf('|');
        const tipo = chave.slice(0, sep), ref = chave.slice(sep + 1);
        const baixas = (baixasPorRef[ref] || []);
        if (lista.length <= baixas.length) continue;

        const restantes = baixas.slice();
        const ficam = new Set<string>();
        for (const c of lista) {
          const i = restantes.findIndex((v) => Math.abs(v - n2(c.valor)) < 0.005);
          if (i >= 0) { restantes.splice(i, 1); ficam.add(String(c.id)); }
        }
        for (const c of lista) {
          if (!restantes.length) break;
          if (!ficam.has(String(c.id))) { restantes.shift(); ficam.add(String(c.id)); }
        }
        const sobra = lista.filter((c: any) => !ficam.has(String(c.id)));
        if (!sobra.length) continue;
        if (baixas.length === 0 && lista.some((c: any) => tituloComBaixa.has(String(c.source_id)))) {
          if (revisarManual.length < 60) revisarManual.push({
            sourceType: tipo, reference: ref, creditos: lista.length,
            valor: n2(lista.reduce((s2: number, x: any) => s2 + Number(x.valor), 0)),
            motivo: 'titulo tem baixa ativa que nao casa por reference — conferir a mao',
          });
          continue;
        }
        if (baixas.length === 0) gruposOrfao++; else gruposDuplicado++;
        for (const c of sobra) aEstornar.push(c);
        if (amostra.length < 60) amostra.push({
          sourceType: tipo, reference: ref, creditos: lista.length, baixasAtivas: baixas.length,
          estornar: sobra.length, valor: n2(sobra.reduce((s: number, x: any) => s + Number(x.valor), 0)),
          caso: baixas.length === 0 ? 'orfao (baixa estornada)' : 'duplicado',
        });
      }

      const valorTotal = n2(aEstornar.reduce((s, x) => s + Number(x.valor), 0));
      const porConta: Record<string, { linhas: number; valor: number }> = {};
      for (const c of aEstornar) {
        const k = String(c.acc);
        porConta[k] ||= { linhas: 0, valor: 0 };
        porConta[k].linhas++; porConta[k].valor = n2(porConta[k].valor + Number(c.valor));
      }
      const resumo = {
        gruposDuplicado, gruposOrfao,
        linhas: aEstornar.length, valor: valorTotal,
        creditosAnalisados: creditos.length,
        naoEstornadosPorTerBaixaNoTitulo: revisarManual.length,
      };

      if (dryRun) return res.json({ dryRun: true, escopo: tipos, resumo, porConta, amostra, revisarManual, saldoNaoTocado: true });

      let estornadas = 0;
      for (let i = 0; i < aEstornar.length; i += 300) {
        const lote = aEstornar.slice(i, i + 300).map((c: any) => String(c.id));
        const u: any = await db.execute(sql`
          UPDATE account_movements
          SET reversed_at = now(), reversed_by = ${por}, reversed_reason = ${motivo}
          WHERE reversed_at IS NULL AND id IN (${sql.join(lote.map((x) => sql`${x}`), sql`, `)})`);
        estornadas += Number(u?.rowCount ?? 0);
      }
      try {
        await logFinancialAudit({
          req, action: 'reverse', entity: 'account_movements', entityId: null,
          amount: valorTotal, note: 'Estorno de credito sem baixa ativa: ' + estornadas + ' linha(s), ' +
            gruposDuplicado + ' cobranca(s) com credito duplicado e ' + gruposOrfao + ' com credito orfao. ' + motivo,
          after: { escopo: tipos, linhas: estornadas, valor: valorTotal, porConta },
        });
      } catch (e: any) { /* trilha e observabilidade: nao bloqueia */ }

      res.json({ dryRun: false, escopo: tipos, resumo: { ...resumo, linhas: estornadas }, porConta, amostra, revisarManual, saldoNaoTocado: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
    }
  });

  app.post('/api/admin/financial/repair-boleto-liquidado-sem-baixa', authenticateUser, isFinancialAuthorized, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 200);
      const days = Math.min(Math.max(Number(req.body?.days) || 365, 1), 3650);
      const pediuIds = Array.isArray(req.body?.boletoIds);
      const only: string[] = pediuIds
        ? req.body.boletoIds.map((x: any) => String(x).trim()).filter((x: string) => /^[0-9a-fA-F-]{8,40}$/.test(x))
        : [];
      // Se o operador MANDOU boletoIds e nenhum sobreviveu a validacao (id truncado no
      // copy/paste, aspas coladas, typo), abortar. Cair para lista vazia faria o filtro
      // sumir do WHERE e o reparo dirigido viraria reparo de TODOS os candidatos.
      if (pediuIds && only.length === 0) {
        return res.status(400).json({ error: 'boletoIds informado mas nenhum id valido (esperado UUID do boleto_charges)', recebidos: req.body.boletoIds });
      }

      const sel = `bc.id AS boleto_id, bc.nosso_numero, bc.valor_original, bc.status AS boleto_status, bc.created_at,
        r.id AS receivable_id, r.title_number, r.customer_name, r.amount, COALESCE(r.amount_paid, '0') AS amount_paid,
        r.status AS receivable_status, r.due_date`;
      // COALESCE em amount_paid: a coluna aceita NULL e NULL < x e NULL (linha sumia do
      // filtro) — justamente os titulos que nunca receberam baixa, o alvo do reparo.
      // boletoIds entra no WHERE (nao pode ser filtrado depois do LIMIT, senao pedir um
      // boleto especifico fora dos N mais recentes devolvia "0 candidatos" em silencio).
      const filtroIds = only.length ? ` AND bc.id IN (${only.map((x) => `'${x}'`).join(',')})` : '';
      // NOT EXISTS espelha o criterio de pendencia de settleBoletoCharge: titulo aberto
      // porque o boleto pagou MENOS que o emitido (desconto) ja tem pagamento deste
      // boleto e nao sera reparado. Sem isto o dry-run prometia reparar casos que o
      // settle depois recusaria, inflando "candidatos" e "valorEmAberto" — justo os
      // numeros que o operador usa para conferir antes de aplicar.
      const where = `lower(coalesce(bc.status,'')) IN ('liquidado','pago','recebido')
        AND r.deleted_at IS NULL AND r.status NOT IN ('recebida','cancelada')
        AND COALESCE(r.amount_paid, '0')::numeric < r.amount::numeric - 0.005
        AND NOT EXISTS (
          SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = r.id AND (
            (COALESCE(bc.nosso_numero,'') <> '' AND (rp.reference = bc.nosso_numero OR rp.notes LIKE '%nosso ' || bc.nosso_numero || '%'))
            OR COALESCE(bc.nosso_numero,'') = ''))
        AND bc.created_at > now() - make_interval(days => ${days})${filtroIds}`;

      // Um boleto pode ter varios titulos pendentes (boleto unificado): agrupamos por
      // boleto e guardamos TODOS os titulos, para o relatorio e a auditoria nao
      // mostrarem so o primeiro.
      const cand = new Map<string, any>();
      const add = (rows: any[]) => {
        for (const r of (rows || [])) {
          const k = String(r.boleto_id);
          if (!cand.has(k)) cand.set(k, { ...r, titulos: [] });
          const g = cand.get(k);
          if (!g.titulos.some((t: any) => String(t.receivable_id) === String(r.receivable_id))) {
            g.titulos.push({ receivable_id: r.receivable_id, title_number: r.title_number, customer_name: r.customer_name,
                             amount: Number(r.amount || 0), amount_paid: Number(r.amount_paid || 0), status: r.receivable_status, due_date: r.due_date });
          }
        }
      };

      // boleto simples (receivable_id direto)
      const q1: any = await db.execute(sql.raw(
        `SELECT ${sel} FROM boleto_charges bc JOIN receivables r ON r.id = bc.receivable_id WHERE ${where} ORDER BY bc.created_at DESC LIMIT ${limit}`));
      add(q1.rows);
      // boleto unificado (via tabela de juncao; pode nao existir em ambiente antigo)
      try {
        const q2: any = await db.execute(sql.raw(
          `SELECT ${sel} FROM boleto_charges bc JOIN boleto_charge_receivables bcr ON bcr.boleto_charge_id = bc.id JOIN receivables r ON r.id = bcr.receivable_id WHERE ${where} ORDER BY bc.created_at DESC LIMIT ${limit}`));
        add(q2.rows);
      } catch (e: any) { /* tabela ausente: so o caminho simples */ }

      // Ordena o conjunto MERGEADO antes de cortar. Cortar cada consulta em separado
      // fazia os boletos unificados nunca entrarem quando havia muitos simples.
      const todos = Array.from(cand.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const alvos = todos.slice(0, limit);
      const truncado = todos.length > alvos.length ? todos.length - alvos.length : 0;

      const bbb: any = await import('./bb-boleto-service');
      const itens: any[] = [];
      let reparados = 0, jaBaixados = 0, naoLiquidadoNoBB = 0, erros = 0, semDiferenca = 0;

      for (const a of alvos) {
        const emAbertoBoleto = a.titulos.reduce((t: number, x: any) => t + (x.amount - x.amount_paid), 0);
        const base = {
          boletoId: a.boleto_id, nossoNumero: a.nosso_numero,
          titulos: a.titulos.map((x: any) => ({ titulo: x.title_number, cliente: x.customer_name, valor: x.amount, jaBaixado: x.amount_paid, status: x.status, vencimento: x.due_date })),
          valorEmAberto: Number(emAbertoBoleto.toFixed(2)),
        };
        try {
          const c: any = await bbb.consultarBoletoChargeBB(a.boleto_id);
          if (!c?.ok) { erros++; itens.push({ ...base, resultado: 'erro_consulta_bb', erro: c?.error || null }); continue; }
          if (!c.liquidado) { naoLiquidadoNoBB++; itens.push({ ...base, resultado: 'nao_liquidado_no_bb', estadoBB: c.estado }); continue; }
          // GUARD: so e "baixa que faltou" se o BB pagou MAIS do que ja esta baixado.
          // Titulo aberto porque o cliente pagou menos que o emitido (desconto) tem
          // valorPagoBB == jaBaixado: o residuo e decisao contabil, nao falha de baixa.
          const jaBaixadoTotal = a.titulos.reduce((t: number, x: any) => t + Number(x.amount_paid || 0), 0);
          const deltaBB = Number(c.valorPago || 0) - jaBaixadoTotal;
          if (!(deltaBB > 0.005)) {
            semDiferenca++;
            itens.push({ ...base, resultado: 'sem_diferenca_vs_bb', estadoBB: c.estado, valorPagoBB: c.valorPago, jaBaixado: Number(jaBaixadoTotal.toFixed(2)) });
            continue;
          }
          const prev = { ...base, estadoBB: c.estado, valorPagoBB: c.valorPago, dataCreditoBB: c.dataCredito, aBaixar: Number(deltaBB.toFixed(2)) };
          // rawBB so no dry-run: permite conferir no retorno do proprio banco de onde
          // saiu o valor e a data antes de gravar qualquer coisa.
          if (dryRun) { itens.push({ ...prev, resultado: 'seria_reparado', rawBB: c.raw }); continue; }

          const r: any = await bbb.checkAndSettleBoleto(a.boleto_id, 'reparo-liquidado-sem-baixa');
          if (r?.alreadyPaid) { jaBaixados++; itens.push({ ...prev, resultado: 'ja_estava_baixado' }); continue; }
          // ok:true com settledCount 0 = nada foi gravado (o laco de baixa engole erro).
          // Sem esta checagem o endpoint diria "reparado" e gravaria auditoria de um
          // pagamento inexistente, com o titulo continuando vencido na tela.
          if (!r?.ok || !(Number(r?.settledCount || 0) > 0)) {
            erros++; itens.push({ ...prev, resultado: 'falhou', erro: r?.error || r?.message || 'nenhum titulo baixado' }); continue;
          }
          reparados++;
          itens.push({ ...prev, resultado: 'reparado', titulosBaixados: Number(r.settledCount), statusFinal: r?.receivableStatus || null });
          // Auditoria por TITULO (boleto unificado baixa varios de uma vez).
          for (const x of a.titulos) {
            // amount = o que foi baixado NESTE titulo (saldo dele), nunca o valor cheio
            // do boleto: em boleto unificado, repetir o total em cada linha multiplicaria
            // o reparo em qualquer soma por periodo do log de auditoria.
            const baixadoNoTitulo = Math.max(0, Math.min(Number(x.amount || 0) - Number(x.amount_paid || 0), Number(c.valorPago || 0)));
            await logFinancialAudit({
              req, action: 'pay', entity: 'receivable', entityId: String(x.receivable_id),
              before: { status: x.status, amountPaid: Number(x.amount_paid || 0) },
              after: { status: a.titulos.length === 1 ? (r?.receivableStatus || null) : null, amountPaid: Number(x.amount_paid || 0) + baixadoNoTitulo },
              amount: Number(baixadoNoTitulo.toFixed(2)),
              note: `Reparo: boleto ${a.nosso_numero} liquidado no BB (${c.estado}, credito ${c.dataCredito || 's/data'}, total pago R$ ${Number(c.valorPago || 0).toFixed(2)}) sem baixa no titulo`,
            });
          }
        } catch (e: any) { erros++; itens.push({ ...base, resultado: 'erro', erro: e?.message || String(e) }); }
      }

      const emAberto = alvos.reduce((t, a) => t + a.titulos.reduce((u: number, x: any) => u + (x.amount - x.amount_paid), 0), 0);
      res.json({
        dryRun, candidatos: alvos.length, valorEmAberto: emAberto.toFixed(2),
        reparados, jaBaixados, naoLiquidadoNoBB, semDiferenca, erros,
        naoProcessadosPorLimite: truncado, itens,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Garante o valor 'cartao' no enum de forma de pagamento (opcao unica "Cartao"
  // usada na baixa e na criacao de titulos, tanto a receber quanto a pagar). Sem
  // isso o front envia paymentMethod='cartao' e o Postgres rejeita (o enum so tinha
  // cartao_credito/cartao_debito) -> a baixa/criacao com cartao falhava com 500.
  // Aditivo e idempotente; roda uma vez no boot, antes de qualquer requisicao.
  db.execute(sql`ALTER TYPE financial_payment_method ADD VALUE IF NOT EXISTS 'cartao'`)
    .catch((e: any) => console.warn('[financial] ensure cartao payment method:', e?.message || e));

  // ============================================================================
  // TRAVAS NO BANCO contra baixa/cobranca em duplicidade
  // ----------------------------------------------------------------------------
  // Ate aqui TODAS as guardas do sistema eram "consulta e depois escreve" em
  // JavaScript — nao sobrevivem a duplo clique, a webhook reentregue no mesmo
  // instante nem a duas instancias do app. Um indice UNICO resolve a classe
  // inteira de uma vez, no nivel do banco, valendo para todos os caminhos.
  //
  // Sao criados so os que os dados atuais ja respeitam (conferido: 0 violacoes).
  // Ficaram de fora, por violacao existente que precisa de decisao humana:
  //   - account_movements (source_type, source_id, type): 391 creditos de boleto
  //     duplicados — espelho das baixas duplicadas, ainda inflando o saldo.
  //   - boleto_charges (receivable_id) ativo: 64 titulos com 2+ boletos vivos.
  //   - pix_charges (receivable_id) ATIVA: 19 titulos com 2 QR codes vivos.
  // Falha na criacao e logada em ERRO e NAO derruba o boot.
  // ============================================================================
  (async () => {
    const travas: Array<{ nome: string; sql: string }> = [
      { nome: 'ux_receivable_payments_ref',
        sql: `CREATE UNIQUE INDEX IF NOT EXISTS ux_receivable_payments_ref ON receivable_payments (receivable_id, reference) WHERE deleted_at IS NULL AND reference IS NOT NULL AND reference <> ''` },
      { nome: 'ux_payable_payments_ref',
        sql: `CREATE UNIQUE INDEX IF NOT EXISTS ux_payable_payments_ref ON payable_payments (payable_id, reference) WHERE reference IS NOT NULL AND reference <> ''` },
      { nome: 'ux_boleto_charges_nosso',
        sql: `CREATE UNIQUE INDEX IF NOT EXISTS ux_boleto_charges_nosso ON boleto_charges (numero_convenio, nosso_numero) WHERE nosso_numero IS NOT NULL` },
    ];
    for (const t of travas) {
      try { await db.execute(sql.raw(t.sql)); }
      catch (e: any) { console.error(`[financial] TRAVA ${t.nome} NAO criada (ha duplicidade nos dados):`, String(e?.message || e).slice(0, 200)); }
    }
  })();

  // ============================================================================
  // CHART OF ACCOUNTS
  // ============================================================================

  // FASE 3.4l - coluna aditiva: include_in_dre (default true). Contas com valor
  // false ficam de fora da DRE, mas seguem classificaveis e entram no fluxo de caixa.
  let __incDreReady = false;
  async function ensureIncludeInDreColumn() {
    if (__incDreReady) return;
    try { await db.execute(sql`ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS include_in_dre boolean NOT NULL DEFAULT true`); } catch {}
    __incDreReady = true;
  }
  async function incDreMap(): Promise<Map<string, boolean>> {
    await ensureIncludeInDreColumn();
    const q: any = await db.execute(sql`SELECT id, include_in_dre FROM chart_of_accounts`);
    return new Map((((q as any).rows) || []).map((x: any) => [String(x.id), x.include_in_dre !== false]));
  }
  // Sanitiza o payload de gravacao do plano de contas: mantem SO as colunas reais e
  // editaveis. Sem isso, o front manda o objeto inteiro (form = {...item}) com id e
  // createdAt (string ISO); ao passar createdAt para db.update().set(), o drizzle tenta
  // value.toISOString() numa string e quebra ("value.toISOString is not a function"),
  // impedindo QUALQUER edicao. Tambem mapeia o campo antigo instanceId -> omieInstanceId.
  function sanitizeChartAccount(body: any): any {
    const src = (body || {}) as any;
    const out: any = {};
    for (const k of ['code', 'name', 'type', 'parentId', 'dreGroup', 'omieInstanceId', 'isActive']) {
      if (src[k] !== undefined) out[k] = src[k];
    }
    if (out.omieInstanceId === undefined && src.instanceId !== undefined) {
      out.omieInstanceId = src.instanceId || null;
    }
    return out;
  }

  app.get('/api/financial/chart-of-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const accounts = await storage.getChartOfAccounts(instanceId);
      const fmap = await incDreMap();
      res.json(accounts.map((a: any) => ({ ...a, includeInDre: fmap.get(String(a.id)) !== false })));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.getChartOfAccount(req.params.id);
      if (!account) return res.status(404).json({ message: 'Conta não encontrada' });
      await ensureIncludeInDreColumn();
      const fq: any = await db.execute(sql`SELECT include_in_dre FROM chart_of_accounts WHERE id = ${req.params.id}`);
      const inc = ((((fq as any).rows) || [])[0]?.include_in_dre) !== false;
      res.json({ ...account, includeInDre: inc });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/chart-of-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await ensureIncludeInDreColumn();
      const { includeInDre } = (req.body || {}) as any;
      const rest = sanitizeChartAccount(req.body);
      const account: any = await storage.createChartOfAccount(rest);
      if (includeInDre === false) { try { await db.execute(sql`UPDATE chart_of_accounts SET include_in_dre = false WHERE id = ${account.id}`); } catch {} }
      res.status(201).json({ ...account, includeInDre: includeInDre !== false });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await ensureIncludeInDreColumn();
      const { includeInDre } = (req.body || {}) as any;
      const rest = sanitizeChartAccount(req.body);
      const account: any = Object.keys(rest).length
        ? await storage.updateChartOfAccount(req.params.id, rest)
        : await storage.getChartOfAccount(req.params.id);
      if (typeof includeInDre === 'boolean') { try { await db.execute(sql`UPDATE chart_of_accounts SET include_in_dre = ${includeInDre} WHERE id = ${req.params.id}`); } catch {} }
      const fq: any = await db.execute(sql`SELECT include_in_dre FROM chart_of_accounts WHERE id = ${req.params.id}`);
      const inc = ((((fq as any).rows) || [])[0]?.include_in_dre) !== false;
      res.json({ ...account, includeInDre: inc });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deleteChartOfAccount(req.params.id);
      res.json({ message: 'Conta removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/chart-of-accounts/seed', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const existing = await storage.getChartOfAccounts();
      if (existing.length > 0) {
        return res.status(400).json({ message: 'Plano de contas já possui registros. Limpe antes de popular novamente.' });
      }

      const dreAccounts = [
        { code: '1', name: 'Receita Bruta de Vendas', type: 'receita' as const, dreGroup: 'receita_bruta' },
        { code: '1.01', name: 'Devoluções/Descontos', type: 'receita' as const, dreGroup: 'devolucoes' },
        { code: '1.02', name: 'Impostos sobre Vendas (ICMS, PIS/COFINS, ISS)', type: 'receita' as const, dreGroup: 'impostos_vendas' },

        { code: '2', name: 'CPV', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.01', name: 'Matéria-prima (frutas/polpas)', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.02', name: 'Embalagens (garrafas/tampas/rótulos)', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.03', name: 'Energia e utilidades de produção', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.04', name: 'Mão de obra direta', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.05', name: 'Manutenção/limpeza fabril', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.06', name: 'Fretes de entrada', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.07', name: 'Análise produto', type: 'despesa' as const, dreGroup: 'cpv' },

        { code: '3', name: 'Despesas Comerciais', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.01', name: 'Comissões', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.02', name: 'Marketing', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.03', name: 'Salários logística', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.04', name: 'Locação veículo', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.05', name: 'Energia e utilidades de armazenamento', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.06', name: 'Manutenções (refrigeradores, veículos, máquinas)', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.07', name: 'Combustível, gelo, IPVA, manutenção', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.08', name: 'Representantes', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },

        { code: '4', name: 'Despesas Administrativas', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.01', name: 'Salários ADM', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.02', name: 'Serviços contábeis', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.03', name: 'TI (ERP, internet)', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.04', name: 'Energia ADM', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.05', name: 'Água/esgoto', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.06', name: 'Aluguel', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.07', name: 'Limpeza', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.08', name: 'Telefone', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.09', name: 'Material escritório', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },

        { code: '5', name: 'Despesas Gerais', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.01', name: 'Seguros', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.02', name: 'Taxas', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.03', name: 'Taxas bancárias', type: 'despesa' as const, dreGroup: 'despesas_gerais' },

        { code: '6', name: 'Outras Receitas/Despesas Operacionais', type: 'despesa' as const, dreGroup: 'outras_receitas_despesas' },

        { code: '7', name: 'Depreciação e Amortização', type: 'despesa' as const, dreGroup: 'depreciacao' },

        { code: '8', name: 'Receitas Financeiras', type: 'receita' as const, dreGroup: 'receitas_financeiras' },

        { code: '9', name: 'Despesas Financeiras (juros, tarifas)', type: 'despesa' as const, dreGroup: 'despesas_financeiras' },

        { code: '10', name: 'IRPJ/CSLL', type: 'despesa' as const, dreGroup: 'irpj_csll' },
      ];

      const created = [];
      for (const acc of dreAccounts) {
        const result = await storage.createChartOfAccount({
          code: acc.code,
          name: acc.name,
          type: acc.type,
          dreGroup: acc.dreGroup,
          isActive: true,
        });
        created.push(result);
      }

      res.json({ message: `${created.length} contas criadas com sucesso`, count: created.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // FINANCIAL ACCOUNTS (bank/cash)
  // ============================================================================

  const maskAccountSecrets = (account: any) => {
    if (!account) return account;
    const masked = { ...account };
    if (masked.interClientSecret) masked.interClientSecret = '***';
    if (masked.interCertificateCrt) masked.interCertificateCrt = '[CERTIFICADO CONFIGURADO]';
    if (masked.interCertificateKey) masked.interCertificateKey = '[CHAVE CONFIGURADA]';
    if (masked.bbClientSecret) masked.bbClientSecret = '***';
    if (masked.bbDevAppKey) masked.bbDevAppKey = masked.bbDevAppKey.substring(0, 6) + '***';
    if (masked.bbPixClientSecret) masked.bbPixClientSecret = '***';
    if (masked.bbPagamentosClientSecret) masked.bbPagamentosClientSecret = '***';
    if (masked.bbExtratoClientSecret) masked.bbExtratoClientSecret = '***';
    return masked;
  };

  app.get('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const accounts = await storage.getFinancialAccounts(instanceId);
      res.json(accounts.map(maskAccountSecrets));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.getFinancialAccount(req.params.id);
      if (!account) return res.status(404).json({ message: 'Conta financeira não encontrada' });
      res.json(maskAccountSecrets(account));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  const cleanAccountData = (data: any) => {
    const cleaned = { ...data };
    const decimalFields = ['balance', 'bbJurosPercentual', 'bbMultaPercentual'];
    for (const field of decimalFields) {
      if (cleaned[field] === '' || cleaned[field] === null || cleaned[field] === undefined) {
        cleaned[field] = field === 'balance' ? '0' : null;
      } else if (typeof cleaned[field] === 'string') {
        cleaned[field] = cleaned[field].replace(',', '.');
      }
    }
    const nullableStringFields = ['bankName', 'bankCode', 'agency', 'accountNumber', 'pixKey',
      'omieInstanceId', 'description', 'accountSubtype',
      'bbClientId', 'bbClientSecret', 'bbDevAppKey', 'bbConvenio', 'bbContrato',
      'bbCarteira', 'bbVariacaoCarteira', 'bbDiasCompensacao', 'bbSenhaBoletos',
      'bbInstrucaoLinha1', 'bbInstrucaoLinha2', 'bbInstrucaoLinha3', 'bbInstrucaoLinha4',
      'bbPixClientId', 'bbPixClientSecret',
      'bbPagamentosClientId', 'bbPagamentosClientSecret',
      'bbExtratoClientId', 'bbExtratoClientSecret',
      'interClientId', 'interClientSecret', 'interCertificateCrt', 'interCertificateKey'];
    for (const field of nullableStringFields) {
      if (cleaned[field] === '') cleaned[field] = null;
    }
    return cleaned;
  };

  app.post('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.createFinancialAccount(cleanAccountData(req.body));
      res.status(201).json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.updateFinancialAccount(req.params.id, cleanAccountData(req.body));
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deleteFinancialAccount(req.params.id);
      res.json({ message: 'Conta financeira removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/accounts/:id/test-bb-pix', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const result = await bbPixService.testConnection(req.params.id);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ============================================================================
  // ACCOUNT MOVEMENTS (immutable history - read only)
  // ============================================================================

  app.get('/api/financial/accounts/:id/movements', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.limit) filters.limit = parseInt(req.query.limit as string);
      if (req.query.offset) filters.offset = parseInt(req.query.offset as string);
      const movements = await storage.getAccountMovements(req.params.id, filters);
      // Movimento ESTORNADO (credito sem baixa, revertido) sai do extrato da conta.
      // O filtro e feito aqui porque reversed_at nao esta no schema drizzle.
      let visiveis: any[] = movements as any[];
      try {
        const r: any = await db.execute(sql`SELECT id FROM account_movements WHERE reversed_at IS NOT NULL AND financial_account_id = ${req.params.id}`);
        const fora = new Set(((r.rows || r) as any[]).map((x: any) => String(x.id)));
        if (fora.size) visiveis = visiveis.filter((m: any) => !fora.has(String(m.id)));
      } catch { /* coluna ainda nao criada: nada foi estornado */ }
      res.json(visiveis);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // PIX CHARGES (Cobranças PIX)
  // ============================================================================

  app.get('/api/financial/pix-charges', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.financialAccountId) filters.financialAccountId = req.query.financialAccountId;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.receivableId) filters.receivableId = req.query.receivableId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      const charges = await storage.getPixCharges(filters);
      res.json(charges);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/pix-charges/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const charge = await storage.getPixCharge(req.params.id);
      if (!charge) return res.status(404).json({ message: 'Cobrança PIX não encontrada' });
      res.json(charge);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/immediate', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const { accountId, amount, debtorName, debtorDocument, description, expirationSeconds, receivableId, customerId } = req.body;
      
      if (!accountId || !amount) {
        return res.status(400).json({ message: 'accountId e amount são obrigatórios' });
      }

      const charge = await bbPixService.createImmediateCharge(accountId, {
        amount: parseFloat(amount),
        debtorName,
        debtorDocument,
        description,
        expirationSeconds: expirationSeconds ? parseInt(expirationSeconds) : undefined,
        receivableId,
        customerId,
        createdBy: user?.email || null,
      });

      res.status(201).json(charge);
    } catch (error: any) {
      console.error('❌ [PIX-ROUTE] Erro ao criar cobrança imediata:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/due-date', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const { accountId, amount, dueDate, validityAfterDue, debtorName, debtorDocument, description, receivableId, customerId } = req.body;
      
      if (!accountId || !amount || !dueDate || !debtorName || !debtorDocument) {
        return res.status(400).json({ message: 'accountId, amount, dueDate, debtorName e debtorDocument são obrigatórios' });
      }

      const charge = await bbPixService.createDueDateCharge(accountId, {
        amount: parseFloat(amount),
        dueDate,
        validityAfterDue: validityAfterDue ? parseInt(validityAfterDue) : undefined,
        debtorName,
        debtorDocument,
        description,
        receivableId,
        customerId,
        createdBy: user?.email || null,
      });

      res.status(201).json(charge);
    } catch (error: any) {
      console.error('❌ [PIX-ROUTE] Erro ao criar cobrança com vencimento:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/:id/check-status', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const charge = await bbPixService.checkChargeStatus(req.params.id);
      res.json(charge);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-webhook', webhookTokenGuard, async (req, res) => {
    try {
      await bbPixService.handleWebhookNotification(req.body);
      res.status(200).json({ message: 'OK' });
    } catch (error: any) {
      console.error('❌ [PIX-WEBHOOK] Erro:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/accounts/:id/configure-webhook', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { webhookUrl } = req.body;
      if (!webhookUrl) return res.status(400).json({ message: 'webhookUrl é obrigatório' });
      await bbPixService.configureWebhook(req.params.id, webhookUrl);
      res.json({ message: 'Webhook configurado com sucesso' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // RECEIVABLES (Contas a Receber)
  // ============================================================================

  // FASE 3.1 - Regras de classificacao DRE de contas a pagar por fornecedor.
  // Aplicadas em massa via /api/financial/payable-rules/apply (dryRun por padrao)
  // e automaticamente na criacao de novas contas a pagar sem conta gerencial.
  const PAYABLE_RULES: Array<{ p: string; code: string }> = [
    { p: 'BANCO DO BRASIL', code: '5.03' },
    { p: 'SIMPLES NACIONAL', code: '1.02' },
    { p: 'SECRETARIA DA ECONOMIA', code: '1.02' },
    { p: 'DOHLER', code: '2.01' },
    { p: 'BLUEBERRY', code: '2.01' },
    { p: 'JOAQUIM CORREIA FLORENTINO', code: '2.01' },
    { p: 'HP GUIMARAES', code: '2.02' },
    { p: 'CAPITAL EMBALAGENS', code: '2.02' },
    { p: 'ELLOFLEX', code: '2.02' },
    { p: 'VANTAGEM ENERGIA', code: '2.03' },
    { p: 'NAIARA GOMES', code: '2.04' },
    { p: 'MARCELO CHAVES COSTA BARBOSA', code: '3.09' },
    { p: 'GILMAR MOREIRA', code: '3.03' },
    { p: 'VOLUS', code: '4.10' },
    { p: 'FLAVIO EVANGELISTA BAYLAO', code: '4.01' },
    { p: 'FGTS', code: '4.01' },
    { p: 'IMPERIAL EMPREENDIMENTOS', code: '4.06' },
    { p: 'BANCO VOLKSWAGEN', code: '9.01' },
    { p: 'BANCO VOTORANTIM', code: '9.01' },
  ];
  let __accByCode: { map: Record<string, string>; at: number } = { map: {}, at: 0 };
  async function chartAccountIdByCode(code: string): Promise<string | null> {
    const now = Date.now();
    if (now - __accByCode.at > 60000) {
      try {
        const q: any = await db.execute(sql`SELECT id, code FROM chart_of_accounts WHERE is_active = true`);
        const m: Record<string, string> = {};
        for (const r of ((q as any).rows || [])) m[String(r.code)] = String(r.id);
        __accByCode = { map: m, at: now };
      } catch {}
    }
    return __accByCode.map[code] || null;
  }
  // Regras DINAMICAS (criadas pela tela de revisao) - tabela payable_class_rules.
  let __rulesTableReady = false;
  async function ensurePayableRulesTable(): Promise<void> {
    if (__rulesTableReady) return;
    await db.execute(sql`CREATE TABLE IF NOT EXISTS payable_class_rules (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      pattern varchar NOT NULL UNIQUE,
      chart_account_id varchar NOT NULL,
      created_by varchar,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
    __rulesTableReady = true;
  }
  let __dynRules: { rows: Array<{ pattern: string; accountId: string }>; at: number } = { rows: [], at: 0 };
  async function dynamicPayableRules(): Promise<Array<{ pattern: string; accountId: string }>> {
    const now = Date.now();
    if (now - __dynRules.at < 60000) return __dynRules.rows;
    try {
      await ensurePayableRulesTable();
      const q: any = await db.execute(sql`SELECT pattern, chart_account_id FROM payable_class_rules ORDER BY created_at`);
      __dynRules = { rows: ((q as any).rows || []).map((r: any) => ({ pattern: String(r.pattern).toUpperCase(), accountId: String(r.chart_account_id) })), at: now };
    } catch {}
    return __dynRules.rows;
  }
  async function payableRuleAccountFor(supplierName: any): Promise<string | null> {
    const s = String(supplierName || '').toUpperCase();
    for (const r of PAYABLE_RULES) if (s.includes(r.p)) return await chartAccountIdByCode(r.code);
    for (const r of await dynamicPayableRules()) if (s.includes(r.pattern)) return r.accountId;
    return null;
  }

  app.post('/api/financial/payable-rules/apply', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const user = actorOf(req);
      const results: any[] = [];
      let total = 0;
      for (const r of PAYABLE_RULES) {
        const accId = await chartAccountIdByCode(r.code);
        if (!accId) { results.push({ regra: r.p, conta: r.code, erro: 'conta nao encontrada' }); continue; }
        const like = '%' + r.p + '%';
        if (dryRun) {
          const q: any = await db.execute(sql`SELECT count(*)::int AS n, COALESCE(sum(amount::numeric),0)::numeric(14,2) AS v FROM payables WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada' AND upper(supplier_name) LIKE ${like}`);
          const row = (q as any).rows?.[0] || {};
          results.push({ regra: r.p, conta: r.code, titulos: row.n ?? 0, valor: row.v ?? '0' });
          total += Number(row.n || 0);
        } else {
          const u: any = await db.execute(sql`UPDATE payables SET chart_account_id = ${accId}, updated_at = now(), updated_by = ${user?.email || 'payable-rules'} WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada' AND upper(supplier_name) LIKE ${like}`);
          const n = ((u as any)?.rowCount ?? 0) as number;
          results.push({ regra: r.p, conta: r.code, atualizados: n });
          total += n;
        }
      }
      res.json({ ok: true, dryRun, total, results });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // FASE 3.1 - Fornecedores com titulos sem classificacao, agrupados (tela de revisao).
  app.get('/api/financial/payables-unclassified', authenticateUser, isFinancialAuthorized, async (_req, res) => {
    try {
      const q: any = await db.execute(sql`
        SELECT upper(coalesce(supplier_name,'(SEM FORNECEDOR)')) AS fornecedor,
               count(*)::int AS titulos,
               COALESCE(sum(amount::numeric),0)::numeric(14,2) AS valor,
               max(coalesce(description,'')) AS exemplo
        FROM payables
        WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada'
        GROUP BY 1 ORDER BY 3 DESC LIMIT 200`);
      res.json((q as any).rows || []);
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // FASE 3.1 - Cria regra dinamica (fornecedor -> conta) e aplica na hora aos pendentes.
  app.post('/api/financial/payable-rules', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const pattern = String(req.body?.pattern || '').trim().toUpperCase();
      const accountId = String(req.body?.chartAccountId || '');
      if (pattern.length < 4) return res.status(400).json({ message: 'padrão muito curto (mínimo 4 caracteres)' });
      if (!accountId) return res.status(400).json({ message: 'conta gerencial obrigatória' });
      const acc: any = await db.execute(sql`SELECT id FROM chart_of_accounts WHERE id = ${accountId} AND is_active = true LIMIT 1`);
      if (!((acc as any).rows || []).length) return res.status(404).json({ message: 'conta gerencial não encontrada' });
      const user = actorOf(req);
      await ensurePayableRulesTable();
      await db.execute(sql`INSERT INTO payable_class_rules (pattern, chart_account_id, created_by) VALUES (${pattern}, ${accountId}, ${user?.email || null}) ON CONFLICT (pattern) DO UPDATE SET chart_account_id = ${accountId}`);
      __dynRules.at = 0;
      const like = '%' + pattern + '%';
      const u: any = await db.execute(sql`UPDATE payables SET chart_account_id = ${accountId}, updated_at = now(), updated_by = ${user?.email || 'payable-rules'} WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada' AND upper(supplier_name) LIKE ${like}`);
      await logFinancialAudit({ req, action: 'update', entity: 'payable', entityId: pattern, note: 'regra de classificação DRE criada/aplicada' });
      res.json({ ok: true, pattern, aplicados: ((u as any)?.rowCount ?? 0) as number });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.get('/api/financial/payable-rules', authenticateUser, isFinancialAuthorized, async (_req, res) => {
    try {
      await ensurePayableRulesTable();
      const q: any = await db.execute(sql`SELECT r.id, r.pattern, r.created_by, r.created_at, c.code, c.name FROM payable_class_rules r LEFT JOIN chart_of_accounts c ON c.id = r.chart_account_id ORDER BY r.created_at DESC`);
      res.json({ fixas: PAYABLE_RULES, dinamicas: (q as any).rows || [] });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // FASE 2 - PIX recebidos sem cobranca correspondente (capturados pelo webhook).
  // Lista de apoio: a baixa continua sendo feita pela Conciliacao 2.0 (extrato OFX).
  app.get('/api/financial/pix-nao-identificados', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await bbPixService.ensurePixUnmatchedTable();
      const status = String(req.query.status || 'pendente');
      const q: any = status === 'todos'
        ? await db.execute(sql`SELECT * FROM pix_unmatched ORDER BY created_at DESC LIMIT 300`)
        : await db.execute(sql`SELECT * FROM pix_unmatched WHERE status = ${status} ORDER BY created_at DESC LIMIT 300`);
      res.json((q as any).rows || []);
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.post('/api/financial/pix-nao-identificados/:id/status', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await bbPixService.ensurePixUnmatchedTable();
      const novo = String(req.body?.status || '');
      if (!['pendente', 'resolvido', 'ignorado'].includes(novo)) return res.status(400).json({ message: 'status invalido' });
      const user = actorOf(req);
      const u: any = await db.execute(sql`UPDATE pix_unmatched SET status = ${novo}, resolved_by = ${user?.email || null}, resolved_at = now(), notes = ${req.body?.notes || null} WHERE id = ${req.params.id}`);
      res.json({ ok: true, updated: ((u as any)?.rowCount ?? 0) as number });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // ==========================================================================
  // COMPROVANTE DE ENTREGA NA CONTA A RECEBER
  // A foto tirada pelo entregador no check-in é anexada automaticamente ao(s)
  // título(s) daquela NF (server/deliveryPipelineSync.ts). Aqui ficam a leitura,
  // o anexo manual e a busca direta pelo número da nota.
  // ==========================================================================

  app.get('/api/financial/receivables/:id/attachments', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const { ensureReceivableAttachmentsTable } = await import('./deliveryPipelineSync');
      await ensureReceivableAttachmentsTable();
      const q: any = await db.execute(sql`
        SELECT id, kind, file_name, mime_type, size_bytes, url, source, invoice_number, created_by, created_at
        FROM receivable_attachments WHERE receivable_id = ${req.params.id} ORDER BY created_at
      `);
      res.json((q as any).rows || []);
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.post('/api/financial/receivables/:id/attachments', authenticateUser, isFinancialAuthorized, async (req: any, res) => {
    try {
      const { kind, fileName, mimeType, base64 } = req.body || {};
      if (!fileName || !base64) return res.status(400).json({ message: 'fileName e base64 sao obrigatorios' });
      const { ensureReceivableAttachmentsTable } = await import('./deliveryPipelineSync');
      await ensureReceivableAttachmentsTable();
      const user = actorOf(req);
      const size = Math.floor((String(base64).length * 3) / 4);
      await db.execute(sql`
        INSERT INTO receivable_attachments (receivable_id, kind, file_name, mime_type, size_bytes, content_base64, source, created_by)
        VALUES (${req.params.id}, ${kind || 'outro'}, ${fileName}, ${mimeType || null}, ${size}, ${base64}, 'manual', ${user?.email || null})
      `);
      res.json({ ok: true });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.get('/api/financial/receivable-attachments/:attId/download', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const { ensureReceivableAttachmentsTable } = await import('./deliveryPipelineSync');
      await ensureReceivableAttachmentsTable();
      const q: any = await db.execute(sql`SELECT file_name, mime_type, url, content_base64 FROM receivable_attachments WHERE id = ${req.params.attId} LIMIT 1`);
      const row = ((q as any).rows || [])[0];
      if (!row) return res.status(404).json({ message: 'anexo nao encontrado' });
      // Comprovante do entregador: a imagem vive em photo_media, servida por URL.
      if (row.url) return res.redirect(row.url);
      if (!row.content_base64) return res.status(404).json({ message: 'anexo sem conteudo' });
      const buf = Buffer.from(row.content_base64, 'base64');
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name || 'anexo')}"`);
      res.send(buf);
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.delete('/api/financial/receivable-attachments/:attId', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { ensureReceivableAttachmentsTable } = await import('./deliveryPipelineSync');
      await ensureReceivableAttachmentsTable();
      await db.execute(sql`DELETE FROM receivable_attachments WHERE id = ${req.params.attId}`);
      res.json({ ok: true });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // Busca direta pelo numero da NF: devolve os titulos daquela nota e todos os
  // comprovantes de entrega (anexados + fotos das paradas de rota).
  app.get('/api/financial/comprovante-entrega', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const nfRaw = String(req.query.nf || '').trim();
      const nf = nfRaw.replace(/[^0-9]/g, '');
      if (!nf) return res.status(400).json({ message: 'informe o numero da NF (?nf=)' });
      const { ensureReceivableAttachmentsTable } = await import('./deliveryPipelineSync');
      await ensureReceivableAttachmentsTable();
      const like = `%${nf}%`;
      const q: any = await db.execute(sql`
        SELECT r.id, r.title_number, r.customer_name, r.amount, r.status, r.due_date,
               r.billing_pipeline_id, r.sales_card_id,
               COALESCE(bp.invoice_number, fi.invoice_number) AS invoice_number
        FROM receivables r
        LEFT JOIN billing_pipeline bp ON bp.id = r.billing_pipeline_id
        LEFT JOIN fiscal_invoices fi ON fi.id = r.fiscal_invoice_id
        WHERE r.deleted_at IS NULL
          AND (r.title_number LIKE ${like} OR bp.invoice_number = ${nf} OR fi.invoice_number = ${nf})
        ORDER BY r.created_at DESC
        LIMIT 50
      `);
      const titulos: any[] = (q as any).rows || [];
      if (!titulos.length) return res.json({ nf, titulos: [], comprovantes: [] });

      const ids = titulos.map((t: any) => t.id);
      const att: any = await db.execute(sql`
        SELECT id, receivable_id, kind, file_name, url, created_at
        FROM receivable_attachments WHERE receivable_id IN (${sql.join(ids.map((i: string) => sql`${i}`), sql`, `)})
        ORDER BY created_at
      `);
      const comprovantes: any[] = (att as any).rows || [];

      // Complemento: fotos ainda vivas nas paradas de rota (cards antigos, sem anexo).
      const pipeIds = titulos.map((t: any) => t.billing_pipeline_id).filter(Boolean);
      if (pipeIds.length) {
        const st: any = await db.execute(sql`
          SELECT id, billing_id, route_id, photos, status, check_in_time
          FROM delivery_route_stops
          WHERE photos IS NOT NULL AND jsonb_array_length(photos) > 0
            AND billing_id IN (${sql.join(pipeIds.map((i: string) => sql`${i}`), sql`, `)})
        `);
        for (const row of ((st as any).rows || [])) {
          let ph: string[] = [];
          try { ph = Array.isArray(row.photos) ? row.photos : JSON.parse(row.photos || '[]'); } catch {}
          for (const u of ph) {
            if (!comprovantes.some((c: any) => c.url === u)) {
              comprovantes.push({ id: null, receivable_id: null, kind: 'foto_parada', file_name: 'comprovante.jpg', url: u, created_at: row.check_in_time, stopStatus: row.status });
            }
          }
        }
      }
      res.json({ nf, titulos, comprovantes });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // Backfill: anexa aos titulos os comprovantes de entregas JA realizadas.
  app.post('/api/admin/financial/backfill-comprovantes', authenticateUser, isFinancialAuthorized, async (req: any, res) => {
    try {
      const { ensureReceivableAttachmentsTable, anexarComprovanteEntrega } = await import('./deliveryPipelineSync');
      await ensureReceivableAttachmentsTable();
      const dias = parseInt(String(req.body?.days || '90')) || 90;
      const q: any = await db.execute(sql`
        SELECT id, billing_id, sales_card_id, route_id, photos, status
        FROM delivery_route_stops
        WHERE photos IS NOT NULL AND jsonb_array_length(photos) > 0
          AND status IN ('efetuada', 'devolvida')
          AND COALESCE(completed_at, check_in_time, updated_at, created_at) > now() - (${dias}::text || ' days')::interval
        ORDER BY created_at DESC
        LIMIT 3000
      `);
      const rows: any[] = (q as any).rows || [];
      let anexados = 0, paradas = 0;
      for (const row of rows) {
        let ph: string[] = [];
        try { ph = Array.isArray(row.photos) ? row.photos : JSON.parse(row.photos || '[]'); } catch {}
        if (!ph.length) continue;
        const r = await anexarComprovanteEntrega({
          billingPipelineId: row.billing_id,
          salesCardId: row.sales_card_id,
          stopId: row.id,
          routeId: row.route_id,
          photoUrls: ph,
          actor: 'backfill',
          kind: row.status === 'devolvida' ? 'comprovante_devolucao' : 'comprovante_entrega',
        });
        anexados += r.anexados; if (r.anexados > 0) paradas++;
      }
      res.json({ ok: true, paradasAnalisadas: rows.length, paradasComAnexo: paradas, anexosCriados: anexados });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.get('/api/financial/receivables', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.customerId) filters.customerId = req.query.customerId;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.dueDateStart) filters.dueDateStart = new Date(req.query.dueDateStart as string);
      if (req.query.dueDateEnd) filters.dueDateEnd = new Date(req.query.dueDateEnd as string);
      if (req.query.paymentMethod) filters.paymentMethod = req.query.paymentMethod;
      if (req.query.chartAccountId) filters.chartAccountId = req.query.chartAccountId;
      
      const receivables = await storage.getReceivables(filters);
      const all = receivables as any[];
      // FASE 3.2 - paginacao opcional (?limit=&offset=). Sem os parametros, retorna tudo.
      const limitR = parseInt(String(req.query.limit || '')) || 0;
      const offsetR = parseInt(String(req.query.offset || '')) || 0;
      const pageR = limitR > 0 ? all.slice(offsetR, offsetR + limitR) : all;
      try { attachBadges(pageR, await badgeFlagsFor('receivable'), 'recebida'); } catch {}
      // Comprovante de entrega: anexa as fotos tiradas pelo entregador (delivery_route_stops.photos),
      // ligadas ao recebível por billing_pipeline (billingPipelineId) ou pelo sales_card_id. Batched.
      try {
        const pipeIds = Array.from(new Set(pageR.map((r: any) => r.billingPipelineId).filter(Boolean)));
        const cardIds = Array.from(new Set(pageR.map((r: any) => r.salesCardId).filter(Boolean)));
        if (pipeIds.length || cardIds.length) {
          const conds: any[] = [];
          if (pipeIds.length) conds.push(sql`billing_id IN (${sql.join(pipeIds.map((id: string) => sql`${id}`), sql`, `)})`);
          if (cardIds.length) conds.push(sql`sales_card_id IN (${sql.join(cardIds.map((id: string) => sql`${id}`), sql`, `)})`);
          const stopsRes: any = await db.execute(sql`
            SELECT billing_id, sales_card_id, photos
            FROM delivery_route_stops
            WHERE photos IS NOT NULL AND jsonb_array_length(photos) > 0 AND (${sql.join(conds, sql` OR `)})
          `);
          const stopRows: any[] = stopsRes?.rows || stopsRes || [];
          const byBilling = new Map<string, string[]>();
          const byCard = new Map<string, string[]>();
          for (const s of stopRows) {
            let ph: string[] = [];
            try { ph = Array.isArray(s.photos) ? s.photos : (s.photos ? JSON.parse(s.photos) : []); } catch {}
            if (!ph.length) continue;
            if (s.billing_id && !byBilling.has(s.billing_id)) byBilling.set(s.billing_id, ph);
            if (s.sales_card_id && !byCard.has(s.sales_card_id)) byCard.set(s.sales_card_id, ph);
          }
          for (const r of pageR as any[]) {
            r.deliveryPhotos = (r.billingPipelineId && byBilling.get(r.billingPipelineId)) || (r.salesCardId && byCard.get(r.salesCardId)) || [];
          }
        }
      } catch { /* nunca bloqueia a lista */ }
      // Comprovantes ANEXADOS ao título (receivable_attachments). Sobrevivem ao
      // replanejamento/exclusão da rota, ao contrário do join com as paradas.
      try {
        const ids = pageR.map((r: any) => r.id).filter(Boolean).slice(0, 5000);
        if (ids.length) {
          const { ensureReceivableAttachmentsTable } = await import('./deliveryPipelineSync');
          await ensureReceivableAttachmentsTable();
          // Consulta em lotes: sem filtro a lista pode trazer milhares de títulos e
          // um único IN gigante degrada o banco.
          const attRows: any[] = [];
          for (let i = 0; i < ids.length; i += 500) {
            const lote = ids.slice(i, i + 500);
            const parcial: any = await db.execute(sql`
              SELECT id, receivable_id, kind, file_name, mime_type, url, created_at
              FROM receivable_attachments
              WHERE receivable_id IN (${sql.join(lote.map((id: string) => sql`${id}`), sql`, `)})
              ORDER BY created_at
            `);
            attRows.push(...(parcial?.rows || []));
          }
          const att: any = { rows: attRows };
          const byRcv = new Map<string, any[]>();
          for (const a of (att?.rows || [])) {
            const arr = byRcv.get(a.receivable_id) || [];
            arr.push(a);
            byRcv.set(a.receivable_id, arr);
          }
          for (const r of pageR as any[]) {
            const lista = byRcv.get(r.id) || [];
            r.attachments = lista;
            if (lista.length) {
              const urls = lista.map((a: any) => a.url).filter(Boolean);
              const atuais: string[] = Array.isArray(r.deliveryPhotos) ? r.deliveryPhotos : [];
              r.deliveryPhotos = Array.from(new Set([...atuais, ...urls]));
            }
          }
        }
      } catch { /* nunca bloqueia a lista */ }
      // ?paged=1: retorna a PAGINA + um RESUMO (contagem e somas) calculado sobre TODO o
      // conjunto filtrado no servidor. Permite abrir a tela SEM filtro e ainda assim rapido:
      // manda so a 1a pagina e os totais vem do resumo (nao baixa 10k+ linhas no cliente).
      if (req.query.paged) {
        let amount = 0, paid = 0;
        for (const r of all) { amount += Number(r.amount || 0); paid += Number(r.amountPaid || 0); }
        return res.json({ rows: pageR, total: all.length, summary: { count: all.length, amount, paid, saldo: amount - paid } });
      }
      res.json(pageR);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const receivable = await storage.getReceivable(req.params.id);
      if (!receivable) return res.status(404).json({ message: 'Conta a receber não encontrada' });
      res.json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // HISTÓRICO COMPLETO da conta a receber: cobrança + documento (boleto/PIX) + recebimentos/baixas
  // + conciliações + auditoria, com DATAS de todos os fatos e USUÁRIOS responsáveis. Somente leitura.
  app.get('/api/financial/receivables/:id/history', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const id = req.params.id;
      const receivable: any = await storage.getReceivable(id);
      if (!receivable) return res.status(404).json({ message: 'Conta a receber não encontrada' });

      // Mapa email -> "Nome" para resolver responsáveis.
      const userMap: Record<string, string> = {};
      try {
        const users = await storage.getUsers();
        for (const u of users as any[]) {
          const nm = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;
          if (u.email) userMap[String(u.email).toLowerCase()] = nm;
        }
      } catch {}
      const uname = (e: any) => { if (!e) return null; const k = String(e).toLowerCase().trim(); return userMap[k] || e; };

      // NF-e vinculada
      let fiscalInvoice: any = null;
      if (receivable.fiscalInvoiceId) {
        try {
          const fi: any = await storage.getFiscalInvoice(receivable.fiscalInvoiceId);
          if (fi) fiscalInvoice = { id: fi.id, invoiceNumber: fi.invoiceNumber, status: fi.status, accessKey: fi.accessKey, emissionDate: fi.emissionDate, environment: fi.environment };
        } catch {}
      }

      // Boletos (documento de cobrança)
      let boletos: any[] = [];
      try {
        const b: any = await db.execute(sql`SELECT id, nosso_numero, linha_digitavel, codigo_barras, data_vencimento, valor_original, status, created_at, updated_by, deleted_at, deleted_by FROM boleto_charges WHERE receivable_id = ${id} ORDER BY created_at ASC`);
        boletos = (b.rows || []).map((r: any) => ({
          id: r.id, nossoNumero: r.nosso_numero, linhaDigitavel: r.linha_digitavel, codigoBarras: r.codigo_barras,
          dueDate: r.data_vencimento, amount: r.valor_original, status: r.status, createdAt: r.created_at,
          canceledAt: r.deleted_at, canceledBy: uname(r.deleted_by),
        }));
      } catch {}

      // PIX (documento de cobrança)
      let pix: any[] = [];
      try {
        const p: any = await db.execute(sql`SELECT id, txid, status, amount, amount_paid, end_to_end_id, due_date, expires_at, paid_at, created_by, created_at FROM pix_charges WHERE receivable_id = ${id} ORDER BY created_at ASC`);
        pix = (p.rows || []).map((r: any) => ({
          id: r.id, txid: r.txid, status: r.status, amount: r.amount, amountPaid: r.amount_paid,
          endToEndId: r.end_to_end_id, dueDate: r.due_date, expiresAt: r.expires_at, paidAt: r.paid_at,
          createdAt: r.created_at, createdBy: uname(r.created_by),
        }));
      } catch {}

      // Recebimentos / baixas
      let payments: any[] = [];
      try {
        const pays: any[] = await storage.getReceivablePayments(id);
        payments = (pays || []).map((pp: any) => ({
          id: pp.id, paidAt: pp.paidAt, amount: pp.amount, paymentMethod: pp.paymentMethod,
          reference: pp.reference, notes: pp.notes, financialAccountId: pp.financialAccountId,
          createdAt: pp.createdAt, createdBy: uname(pp.createdBy),
        }));
      } catch {}

      // Conciliações bancárias (extrato x título)
      let reconciliations: any[] = [];
      try {
        const rc: any = await db.execute(sql`
          SELECT m.id, m.amount, m.match_kind, m.title_amount_settled, m.interest, m.discount, m.created_by, m.created_at,
                 i.transaction_date, i.description AS item_description, i.document AS item_document, i.origin_name, i.amount AS item_amount,
                 i.matched_at, i.matched_by, i.reconciliation_status, i.notes AS item_notes,
                 s.file_name, fa.name AS account_name
          FROM bank_statement_item_matches m
          JOIN bank_statement_items i ON i.id = m.bank_statement_item_id
          LEFT JOIN bank_statements s ON s.id = i.statement_id
          LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
          WHERE m.receivable_id = ${id}
          ORDER BY COALESCE(i.matched_at, m.created_at) ASC`);
        reconciliations = (rc.rows || []).map((r: any) => ({
          id: r.id, amount: r.amount, matchKind: r.match_kind, settled: r.title_amount_settled, interest: r.interest, discount: r.discount,
          matchedAt: r.matched_at, matchedBy: uname(r.matched_by), createdAt: r.created_at, createdBy: uname(r.created_by),
          transactionDate: r.transaction_date, itemDescription: r.item_description, itemDocument: r.item_document, originName: r.origin_name, itemAmount: r.item_amount,
          status: r.reconciliation_status, statement: r.file_name, account: r.account_name, notes: r.item_notes,
        }));
      } catch {}
      // Fallback: item conciliado diretamente (sem linha de match)
      if (!reconciliations.length) {
        try {
          const rc2: any = await db.execute(sql`
            SELECT i.id, i.transaction_date, i.description AS item_description, i.amount AS item_amount, i.matched_at, i.matched_by, i.reconciliation_status, i.notes AS item_notes, s.file_name, fa.name AS account_name
            FROM bank_statement_items i LEFT JOIN bank_statements s ON s.id = i.statement_id LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
            WHERE i.matched_receivable_id = ${id} ORDER BY i.matched_at ASC`);
          reconciliations = (rc2.rows || []).map((r: any) => ({
            id: r.id, matchedAt: r.matched_at, matchedBy: uname(r.matched_by), transactionDate: r.transaction_date,
            itemDescription: r.item_description, itemAmount: r.item_amount, status: r.reconciliation_status,
            statement: r.file_name, account: r.account_name, notes: r.item_notes,
          }));
        } catch {}
      }

      // Auditoria financeira (create/update/pay/delete/reverse/status)
      let audit: any[] = [];
      try {
        const a: any = await db.execute(sql`SELECT action, user_email, user_role, amount, note, created_at FROM financial_audit_log WHERE entity = 'receivable' AND entity_id = ${id} ORDER BY created_at ASC`);
        audit = (a.rows || []).map((r: any) => ({ action: r.action, user: uname(r.user_email), role: r.user_role, amount: r.amount, note: r.note, at: r.created_at }));
      } catch {}

      // Linha do tempo consolidada
      const ACTION_LABEL: Record<string, string> = { create: 'Conta criada', update: 'Conta editada', delete: 'Conta excluída', pay: 'Baixa registrada', reverse: 'Baixa estornada', status: 'Status alterado', reconcile: 'Conciliação', config: 'Configuração' };
      const timeline: any[] = [];
      const push = (date: any, type: string, label: string, user?: any, detail?: any) => { if (date) timeline.push({ date, type, label, user: user || null, detail: detail || null }); };
      push(receivable.issueDate || receivable.createdAt, 'emissao', 'Conta a receber emitida', uname(receivable.createdBy), receivable.titleNumber ? `Título ${receivable.titleNumber}` : (fiscalInvoice ? `NF-e ${fiscalInvoice.invoiceNumber || ''}` : null));
      for (const b of boletos) push(b.createdAt, 'boleto', 'Boleto emitido', null, `Nosso nº ${b.nossoNumero || '-'}${b.dueDate ? ' · venc. ' + new Date(b.dueDate).toLocaleDateString('pt-BR') : ''}`);
      for (const b of boletos) if (b.canceledAt) push(b.canceledAt, 'boleto', 'Boleto cancelado', b.canceledBy, `Nosso nº ${b.nossoNumero || '-'}`);
      for (const p of pix) push(p.createdAt, 'pix', 'Cobrança PIX criada', p.createdBy, `txid ${String(p.txid || '').slice(0, 12)}…`);
      for (const p of payments) push(p.paidAt || p.createdAt, 'baixa', 'Recebimento / baixa', p.createdBy, `${p.paymentMethod || ''}${p.notes ? ' · ' + p.notes : ''}`.trim());
      for (const r of reconciliations) push(r.matchedAt || r.createdAt, 'conciliacao', 'Conciliação bancária', r.matchedBy || r.createdBy, `${r.statement ? 'Extrato ' + r.statement : ''}${r.account ? ' · ' + r.account : ''}`.trim() || null);
      for (const a of audit) if (a.action !== 'create' && a.action !== 'pay' && a.action !== 'reconcile') push(a.at, 'auditoria', ACTION_LABEL[a.action] || a.action, a.user, a.note);
      timeline.sort((x, y) => new Date(x.date).getTime() - new Date(y.date).getTime());

      res.json({
        receivable: {
          id: receivable.id, titleNumber: receivable.titleNumber, customerName: receivable.customerName, customerDocument: receivable.customerDocument,
          category: receivable.category, description: receivable.description, amount: receivable.amount, amountPaid: receivable.amountPaid,
          status: receivable.status, paymentMethod: receivable.paymentMethod, issueDate: receivable.issueDate, dueDate: receivable.dueDate,
          omieInstanceId: receivable.omieInstanceId, fiscalInvoiceId: receivable.fiscalInvoiceId, billingPipelineId: receivable.billingPipelineId,
          createdAt: receivable.createdAt, createdBy: uname(receivable.createdBy),
          updatedAt: receivable.updatedAt, updatedBy: uname(receivable.updatedBy),
          deletedAt: receivable.deletedAt, deletedBy: uname(receivable.deletedBy),
        },
        fiscalInvoice, boletos, pix, payments, reconciliations, audit, timeline,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/receivables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const data: any = { ...normalizeFinancialBody(req.body), createdBy: user?.email || null };
      if (!data.issueDate) data.issueDate = new Date();
      // FASE 3.4e - categoria DRE obrigatoria: default = receita bruta (venda); sem categoria, nao cria.
      if (!data.chartAccountId) {
        try {
          const q: any = await db.execute(sql`SELECT id FROM chart_of_accounts WHERE dre_group = 'receita_bruta' AND code LIKE '%.%' AND is_active = true ORDER BY code LIMIT 1`);
          data.chartAccountId = (q as any).rows?.[0]?.id || null;
        } catch {}
      }
      if (!data.chartAccountId) return res.status(400).json({ message: 'Selecione a categoria DRE (plano de contas). Nenhuma conta pode ser criada sem categoria.' });
      const receivable = await storage.createReceivable(data);
      await logFinancialAudit({ req, action: 'create', entity: 'receivable', entityId: receivable.id, after: receivable, amount: Number(receivable.amount) });
      res.status(201).json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getReceivable(req.params.id);
      const receivable = await storage.updateReceivable(req.params.id, normalizeFinancialBody(req.body));
      await logFinancialAudit({ req, action: 'update', entity: 'receivable', entityId: req.params.id, before, after: receivable });
      res.json(receivable);
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (msg.startsWith('BAIXA_TRAVADA')) return res.status(409).json({ message: msg.replace(/^BAIXA_TRAVADA:\s*/, '') });
      res.status(500).json({ message: msg });
    }
  });

  app.delete('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getReceivable(req.params.id);
      await storage.deleteReceivable(req.params.id, actorOf(req).email);
      await logFinancialAudit({ req, action: 'delete', entity: 'receivable', entityId: req.params.id, before, amount: before ? Number(before.amount) : null });
      res.json({ message: 'Conta a receber removida' });
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (msg.startsWith('BAIXA_TRAVADA')) return res.status(409).json({ message: msg.replace(/^BAIXA_TRAVADA:\s*/, '') });
      res.status(500).json({ message: msg });
    }
  });

  // Receivable Payments
  app.get('/api/financial/receivables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payments = await storage.getReceivablePayments(req.params.id);
      res.json(payments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/receivables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const exists = await storage.getReceivable(req.params.id);
      if (!exists) return res.status(404).json({ message: 'Recebível não encontrado' });
      const b = req.body || {};
      // FASE 2 - Trava de dupla baixa: titulo cancelado ou ja quitado nao aceita nova baixa.
      // Para lancar de novo, desfaca a baixa/conciliacao original (o titulo volta a ficar aberto).
      const amtBaixaR = parseFloat(String(b.amount ?? '0'));
      if (!(amtBaixaR > 0)) return res.status(400).json({ message: 'Valor da baixa deve ser maior que zero.' });
      if (String((exists as any).status) === 'cancelada') return res.status(409).json({ message: 'Título cancelado não aceita baixa.' });
      const jaPagoR = parseFloat((exists as any).amountPaid || '0');
      const totalR = parseFloat((exists as any).amount || '0');
      if (String((exists as any).status) === 'recebida' || (totalR > 0 && jaPagoR >= totalR - 0.005)) {
        return res.status(409).json({ message: 'Título já quitado/conciliado. Desfaça a baixa original antes de lançar nova.' });
      }
      const rawDate = b.paidAt || b.paymentDate || b.paidDate;
      const data: any = {
        receivableId: req.params.id,
        paidAt: rawDate ? new Date(rawDate) : new Date(),
        amount: String(b.amount ?? '0'),
        paymentMethod: b.paymentMethod || null,
        financialAccountId: b.financialAccountId || null,
        reference: b.reference || null,
        notes: b.notes || null,
        createdBy: user?.email || null,
      };
      const payment = await storage.createReceivablePayment(data);
      await logFinancialAudit({ req, action: 'pay', entity: 'receivable', entityId: req.params.id, amount: Number(data.amount), note: 'baixa' });

      const receivable = await storage.getReceivable(req.params.id);
      if (receivable) {
        const totalPaid = parseFloat(receivable.amountPaid || '0') + parseFloat(data.amount);
        const totalAmount = parseFloat(receivable.amount);
        const newStatus = totalPaid >= totalAmount ? 'recebida' : 'a_vencer';
        await storage.updateReceivable(req.params.id, { 
          amountPaid: totalPaid.toFixed(2),
          status: newStatus as any
        });
      }
      
      res.status(201).json(payment);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // BAIXA ADMINISTRATIVA (perdão/incobrável): fecha o título em 100% SEM entrada de
  // dinheiro (NÃO conta como recebimento no caixa). Exige MOTIVO e registra QUEM
  // executou (updated_by + auditoria financeira). Marca status 'cancelada' (estado
  // "fechado / não recebível" já usado no sistema — some das listas de aberto/vencido
  // e não entra em "recebido") e carimba o motivo em notes.
  app.post('/api/financial/receivables/:id/write-off', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const reason = String(req.body?.reason ?? '').trim();
      if (!reason) return res.status(400).json({ message: 'Informe o MOTIVO da baixa administrativa.' });
      const rec: any = await storage.getReceivable(req.params.id);
      if (!rec) return res.status(404).json({ message: 'Recebível não encontrado' });
      if (String(rec.status) === 'cancelada') return res.status(409).json({ message: 'Título já está cancelado/baixado.' });
      if (String(rec.status) === 'recebida') return res.status(409).json({ message: 'Título já recebido — desfaça o recebimento antes de dar baixa administrativa.' });
      const total = parseFloat(rec.amount || '0');
      const jaPago = parseFloat(rec.amountPaid || '0');
      const saldo = Math.max(0, total - jaPago);
      const stamp = `[BAIXA ADMINISTRATIVA ${new Date().toISOString().slice(0, 10)} por ${user?.email || '?'}] ${reason}`;
      const prevNotes = String(rec.notes || '');
      await storage.updateReceivable(req.params.id, {
        status: 'cancelada' as any,
        notes: prevNotes ? (prevNotes + '\n' + stamp) : stamp,
        updatedBy: user?.email || null,
      } as any);
      await logFinancialAudit({ req, action: 'status', entity: 'receivable', entityId: req.params.id, amount: saldo, note: 'baixa administrativa (100%): ' + reason });
      res.json({ ok: true, saldoBaixado: saldo, status: 'cancelada' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Débitos Vencidos = MESMA lista de "vencida" da Contas a Receber, agrupada por
  // cliente. Fonte LOCAL (2.0), não mais o Omie ERP (que estava divergindo). Reusa
  // getReceivables({status:'vencida'}) para bater EXATAMENTE com a aba Contas a Receber
  // (mesma regra de vencido por dia-calendário no fuso Brasil).
  app.get('/api/financial/overdue-debts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const digits = (s: any) => String(s == null ? '' : s).replace(/\D/g, '');
      const instanceId = (req.query.instanceId as string) || undefined;
      const rows: any[] = await storage.getReceivables(instanceId ? ({ status: 'vencida', instanceId } as any) : ({ status: 'vencida' } as any));
      const vencidas = rows.filter((r) => String(r.status) === 'vencida' && !r.deletedAt);
      // Telefone do cliente (por id e por documento) para os botões de WhatsApp.
      const phoneById = new Map<string, string>();
      const phoneByDoc = new Map<string, string>();
      try {
        const custRows: any = await db.execute(sql`SELECT id, phone, cnpj, cpf FROM customers`);
        for (const c of ((custRows as any).rows || [])) {
          if (!c.phone) continue;
          if (c.id) phoneById.set(String(c.id), String(c.phone));
          const doc = digits(c.cnpj || c.cpf || '');
          if (doc) phoneByDoc.set(doc, String(c.phone));
        }
      } catch {}
      const hojeMs = Date.parse(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) + 'T00:00:00Z');
      // isoBR = dia do VENCIMENTO (data de calendário gravada como meia-noite UTC).
      // Lido em BRT saía 1 dia antes => data_vencimento errada e dias_atraso +1.
      const isoBR = (d: any) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'UTC' });
      const fmtBR = (d: any) => { const [y, m, dd] = isoBR(d).split('-'); return `${dd}/${m}/${y}`; };
      const diasAtraso = (d: any) => Math.max(0, Math.round((hojeMs - Date.parse(isoBR(d) + 'T00:00:00Z')) / 86400000));
      const groups = new Map<string, any>();
      for (const r of vencidas) {
        const doc = digits(r.customerDocument || '');
        const key = doc || String(r.customerName || '').trim().toLowerCase() || String(r.customerId || r.id);
        const saldo = Math.max(0, Number(r.amount || 0) - Number(r.amountPaid || 0));
        const seller = r.sellerName || 'Sem vendedor';
        const tel = (r.customerId && phoneById.get(String(r.customerId))) || (doc && phoneByDoc.get(doc)) || '';
        let g = groups.get(key);
        if (!g) { g = { cliente: { codigo_cliente_omie: 0, nome_fantasia: r.customerName || '(sem nome)', cnpj_cpf: r.customerDocument || '', telefone: tel }, debitos: [], valorTotal: 0, diasMaximoAtraso: 0, vendedores: new Set<string>(), omieInstanceId: r.omieInstanceId || null }; groups.set(key, g); }
        const dias = diasAtraso(r.dueDate);
        g.debitos.push({ numero_documento: r.titleNumber || '', numero_documento_fiscal: r.titleNumber || '', codigo_lancamento_omie: 0, receivableId: r.id, valor: saldo, data_vencimento: fmtBR(r.dueDate), dias_atraso: dias, observacao: r.description || '', codigo_vendedor: seller });
        g.valorTotal += saldo;
        g.diasMaximoAtraso = Math.max(g.diasMaximoAtraso, dias);
        g.vendedores.add(seller);
        if (!g.cliente.telefone && tel) g.cliente.telefone = tel;
      }
      const debts = Array.from(groups.values()).map((g) => ({ ...g, vendedores: Array.from(g.vendedores) }));
      debts.sort((a, b) => (b.diasMaximoAtraso - a.diasMaximoAtraso) || (b.valorTotal - a.valorTotal));
      const totalAmount = debts.reduce((s, g) => s + g.valorTotal, 0);
      res.json({ debts, totalAmount, totalClients: debts.length, lastSyncAt: null });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // PAYABLES (Contas a Pagar)
  // ============================================================================

  app.get('/api/financial/payables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.supplierDocument) filters.supplierDocument = req.query.supplierDocument;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.dueDateStart) filters.dueDateStart = new Date(req.query.dueDateStart as string);
      if (req.query.dueDateEnd) filters.dueDateEnd = new Date(req.query.dueDateEnd as string);
      if (req.query.source) filters.source = req.query.source;
      if (req.query.chartAccountId) filters.chartAccountId = req.query.chartAccountId;
      
      const payables = await storage.getPayables(filters);
      // FASE 3.2 - paginacao opcional (?limit=&offset=). Sem os parametros, retorna tudo.
      const limitP = parseInt(String(req.query.limit || '')) || 0;
      const offsetP = parseInt(String(req.query.offset || '')) || 0;
      const pageP = limitP > 0 ? (payables as any[]).slice(offsetP, offsetP + limitP) : (payables as any[]);
      try { attachBadges(pageP, await badgeFlagsFor('payable'), 'paga'); } catch {}
      res.json(pageP);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payable = await storage.getPayable(req.params.id);
      if (!payable) return res.status(404).json({ message: 'Conta a pagar não encontrada' });
      res.json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const data: any = { ...normalizeFinancialBody(req.body), createdBy: user?.email || null };
      if (!data.issueDate) data.issueDate = new Date();
      // FASE 3.1 - classificacao DRE automatica por regra de fornecedor.
      if (!data.chartAccountId) { try { data.chartAccountId = await payableRuleAccountFor(data.supplierName); } catch {} }
      // FASE 3.4e - categoria DRE obrigatoria: sem categoria (manual ou por regra), nao cria.
      if (!data.chartAccountId) return res.status(400).json({ message: 'Selecione a categoria DRE (plano de contas). Nenhuma conta pode ser criada sem categoria.' });
      const rec = req.body.recurrence;
      // TRAVA ANTI-DUPLICIDADE (regra do Flavio): impede lancar 2x a mesma conta a pagar.
      // Bloqueia quando ja existe titulo NAO cancelado / NAO excluido com o mesmo fornecedor
      // (documento se houver, senao nome) + mesmo valor + vencimento a ate 7 dias de distancia.
      // Override explicito: body.allowDuplicate === true (ou force === true) para casos legitimos.
      const allowDup = req.body?.allowDuplicate === true || req.body?.force === true;
      if (!allowDup && !(rec && rec.freq && rec.freq !== 'none')) {
        try {
          const dd = data.dueDate instanceof Date ? data.dueDate : (data.dueDate ? new Date(data.dueDate) : null);
          const amt = (data.amount !== undefined && data.amount !== null && data.amount !== '') ? String(data.amount) : null;
          if (dd && amt) {
            const doc = data.supplierDocument ? String(data.supplierDocument).replace(/\D/g, '') : '';
            const nm = String(data.supplierName || '').trim().toUpperCase();
            const dupRes: any = await db.execute(sql`
              SELECT id, due_date, amount, status, created_at, created_by
              FROM payables
              WHERE deleted_at IS NULL
                AND status <> 'cancelada'
                AND amount::numeric = ${amt}::numeric
                AND due_date >= ${dd}::timestamp - interval '7 days'
                AND due_date <= ${dd}::timestamp + interval '7 days'
                AND (
                  (${doc} <> '' AND regexp_replace(COALESCE(supplier_document, ''), '[^0-9]', '', 'g') = ${doc})
                  OR (${doc} = '' AND upper(trim(supplier_name)) = ${nm})
                )
              ORDER BY created_at DESC
              LIMIT 1`);
            const hit = (dupRes?.rows ?? dupRes ?? [])[0];
            if (hit) {
              const dtxt = new Date(hit.due_date).toLocaleDateString('pt-BR');
              return res.status(409).json({
                duplicate: true,
                existing: { id: hit.id, dueDate: hit.due_date, amount: hit.amount, status: hit.status },
                message: 'Ja existe uma conta a pagar deste fornecedor com o mesmo valor e vencimento proximo (venc. ' + dtxt + '). Lancamento bloqueado para evitar duplicidade. Se for realmente uma segunda conta, confirme a duplicidade para prosseguir.',
              });
            }
          }
        } catch { /* nunca bloqueia a criacao por falha da checagem de duplicidade */ }
      }
      if (rec && rec.freq && rec.freq !== 'none') {
        const base = data.dueDate instanceof Date ? data.dueDate : (data.dueDate ? new Date(data.dueDate) : new Date());
        const dates = buildRecurrenceDates(base, rec);
        const items: any[] = [];
        for (const d of dates) { items.push(await storage.createPayable({ ...data, dueDate: d })); }
        await logFinancialAudit({ req, action: 'create', entity: 'payable', entityId: items[0]?.id, amount: Number(data.amount), note: 'recorrência ' + items.length + 'x' });
        return res.status(201).json({ recurring: true, count: items.length, items });
      }
      const payable = await storage.createPayable(data);
      await logFinancialAudit({ req, action: 'create', entity: 'payable', entityId: payable.id, after: payable, amount: Number(payable.amount) });
      res.status(201).json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ===== ANEXOS (DANFE / BOLETO) DE CONTAS A PAGAR =====
  // Armazenados no banco (base64) para durabilidade no Railway (disco efemero).
  // Reutilizavel por Contas a Pagar e por Compras (ambos criam payables).
  app.post('/api/financial/payables/:id/attachments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { kind, fileName, mimeType, base64 } = req.body || {};
      if (!fileName || !base64) return res.status(400).json({ message: 'fileName e base64 sao obrigatorios' });
      const clean = String(base64).replace(/^data:[^;]+;base64,/, '');
      const size = Math.floor(clean.length * 3 / 4);
      if (size > 15 * 1024 * 1024) return res.status(413).json({ message: 'Arquivo muito grande (limite 15MB).' });
      const k = ['danfe', 'boleto', 'outro'].includes(String(kind)) ? String(kind) : 'outro';
      const user = actorOf(req);
      const r: any = await db.execute(sql`INSERT INTO payable_attachments (id, payable_id, kind, file_name, mime_type, size_bytes, content_base64, created_by, created_at) VALUES (gen_random_uuid(), ${req.params.id}, ${k}, ${String(fileName)}, ${mimeType || null}, ${size}, ${clean}, ${user?.email || null}, now()) RETURNING id, kind, file_name, mime_type, size_bytes, created_at`);
      res.status(201).json(r.rows?.[0] || { ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.get('/api/financial/payables/:id/attachments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT id, kind, file_name, mime_type, size_bytes, created_at, created_by FROM payable_attachments WHERE payable_id = ${req.params.id} ORDER BY created_at ASC`);
      res.json(r.rows || []);
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.get('/api/financial/payable-attachments/:attId/download', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT file_name, mime_type, content_base64 FROM payable_attachments WHERE id = ${req.params.attId} LIMIT 1`);
      const row = r.rows?.[0];
      if (!row) return res.status(404).json({ message: 'Anexo nao encontrado' });
      const buf = Buffer.from(String(row.content_base64), 'base64');
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name || 'anexo')}"`);
      res.send(buf);
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.delete('/api/financial/payable-attachments/:attId', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try { await db.execute(sql`DELETE FROM payable_attachments WHERE id = ${req.params.attId}`); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.patch('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getPayable(req.params.id);
      const payable = await storage.updatePayable(req.params.id, normalizeFinancialBody(req.body));
      await logFinancialAudit({ req, action: 'update', entity: 'payable', entityId: req.params.id, before, after: payable });
      res.json(payable);
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (msg.startsWith('BAIXA_TRAVADA')) return res.status(409).json({ message: msg.replace(/^BAIXA_TRAVADA:\s*/, '') });
      res.status(500).json({ message: msg });
    }
  });

  app.delete('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getPayable(req.params.id);
      await storage.deletePayable(req.params.id, actorOf(req).email);
      await logFinancialAudit({ req, action: 'delete', entity: 'payable', entityId: req.params.id, before, amount: before ? Number(before.amount) : null });
      res.json({ message: 'Conta a pagar removida' });
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (msg.startsWith('BAIXA_TRAVADA')) return res.status(409).json({ message: msg.replace(/^BAIXA_TRAVADA:\s*/, '') });
      res.status(500).json({ message: msg });
    }
  });

  // FASE 1b - restauracao de soft-delete + lixeira (somente perfis financeiros).
  app.post('/api/financial/receivables/:id/restore', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const receivable = await storage.restoreReceivable(req.params.id);
      if (!receivable) return res.status(404).json({ message: 'Conta não encontrada' });
      await logFinancialAudit({ req, action: 'restore', entity: 'receivable', entityId: req.params.id, after: receivable });
      res.json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables/:id/restore', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payable = await storage.restorePayable(req.params.id);
      if (!payable) return res.status(404).json({ message: 'Conta não encontrada' });
      await logFinancialAudit({ req, action: 'restore', entity: 'payable', entityId: req.params.id, after: payable });
      res.json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/lixeira', authenticateUser, isFinancialAuthorized, async (_req, res) => {
    try {
      const [recs, pays] = await Promise.all([storage.getDeletedReceivables(), storage.getDeletedPayables()]);
      res.json({ receivables: recs, payables: pays });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Payable Payments
  // ---- Eventos de uma conta (pagar/receber): baixas + conciliacao bancaria ----
  // Tudo o que aconteceu com o titulo: cada pagamento registrado (data, valor,
  // forma, conta financeira, referencia, quem lancou) e a conciliacao bancaria
  // (lancamento do extrato, arquivo, data/hora, juros/desconto, quem conciliou).
  // READ-ONLY. Cada bloco em try/catch: se um falhar, o resto aparece.
  async function eventosDoTitulo(kind: 'payable' | 'receivable', id: string) {
    const out: any = { pagamentos: [], conciliacoes: [], auditoria: [], totalPago: 0 };
    const tbl = kind === 'payable' ? 'payable_payments' : 'receivable_payments';
    const fk = kind === 'payable' ? 'payable_id' : 'receivable_id';
    try {
      const r: any = await db.execute(sql`
        SELECT p.id, p.paid_at, p.amount, p.payment_method, p.reference, p.notes,
               p.created_by, p.created_at, p.financial_account_id, fa.name AS conta
        FROM ${sql.raw('"' + tbl + '"')} p
        LEFT JOIN financial_accounts fa ON fa.id = p.financial_account_id
        WHERE p.${sql.raw('"' + fk + '"')} = ${id}
        ORDER BY p.paid_at NULLS LAST, p.created_at`);
      out.pagamentos = (r.rows || r || []);
      out.totalPago = out.pagamentos.reduce((a: number, p: any) => a + Number(String(p.amount ?? '0').replace(/[^0-9.-]/g, '') || 0), 0);
    } catch (e: any) { out.erroPagamentos = String(e?.message || e).slice(0, 120); }
    try {
      const r: any = await db.execute(sql`
        SELECT m.id, m.amount, m.match_kind, m.title_amount_settled, m.interest, m.discount,
               m.created_by, m.created_at,
               i.id AS item_id, i.transaction_date, i.type, i.description, i.origin_name,
               i.origin_document, i.document, i.reconciliation_status, i.matched_at, i.matched_by,
               s.file_name, s.source, fa.name AS conta, s.omie_instance_id
        FROM bank_statement_item_matches m
        JOIN bank_statement_items i ON i.id = m.bank_statement_item_id
        LEFT JOIN bank_statements s ON s.id = i.statement_id
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE m.${sql.raw('"' + fk + '"')} = ${id}
        ORDER BY m.created_at DESC`);
      out.conciliacoes = (r.rows || r || []);
    } catch (e: any) { out.erroConciliacoes = String(e?.message || e).slice(0, 120); }
    try {
      const ids = out.conciliacoes.map((c: any) => String(c.item_id)).filter(Boolean);
      if (ids.length) {
        const inList = sql.join(ids.map((v: string) => sql`${v}`), sql`, `);
        const r: any = await db.execute(sql`
          SELECT event_at, action, amount, performed_by, bank_statement_item_id
          FROM reconciliation_audit_log
          WHERE bank_statement_item_id IN (${inList})
          ORDER BY event_at DESC LIMIT 30`);
        out.auditoria = (r.rows || r || []);
      }
    } catch { /* tabela de auditoria pode nao existir */ }
    return out;
  }
  app.get('/api/financial/payables/:id/eventos', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try { res.json(await eventosDoTitulo('payable', req.params.id)); }
    catch (error: any) { res.status(500).json({ message: error.message }); }
  });
  app.get('/api/financial/receivables/:id/eventos', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try { res.json(await eventosDoTitulo('receivable', req.params.id)); }
    catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.get('/api/financial/payables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payments = await storage.getPayablePayments(req.params.id);
      res.json(payments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const exists = await storage.getPayable(req.params.id);
      if (!exists) return res.status(404).json({ message: 'Conta a pagar não encontrada' });
      const b = req.body || {};
      // FASE 2 - Trava de dupla baixa: titulo cancelado ou ja quitado nao aceita nova baixa.
      // Para lancar de novo, desfaca a baixa/conciliacao original (o titulo volta a ficar aberto).
      const amtBaixaP = parseFloat(String(b.amount ?? '0'));
      if (!(amtBaixaP > 0)) return res.status(400).json({ message: 'Valor da baixa deve ser maior que zero.' });
      if (String((exists as any).status) === 'cancelada') return res.status(409).json({ message: 'Título cancelado não aceita baixa.' });
      const jaPagoP = parseFloat((exists as any).amountPaid || '0');
      const totalP = parseFloat((exists as any).amount || '0');
      if (String((exists as any).status) === 'paga' || (totalP > 0 && jaPagoP >= totalP - 0.005)) {
        return res.status(409).json({ message: 'Título já quitado/conciliado. Desfaça a baixa original antes de lançar nova.' });
      }
      const rawDate = b.paidAt || b.paymentDate || b.paidDate;
      const data: any = {
        payableId: req.params.id,
        paidAt: rawDate ? new Date(rawDate) : new Date(),
        amount: String(b.amount ?? '0'),
        paymentMethod: b.paymentMethod || null,
        financialAccountId: b.financialAccountId || null,
        reference: b.reference || null,
        notes: b.notes || null,
        createdBy: user?.email || null,
      };
      const payment = await storage.createPayablePayment(data);
      await logFinancialAudit({ req, action: 'pay', entity: 'payable', entityId: req.params.id, amount: Number(data.amount), note: 'baixa' });

      const payable = await storage.getPayable(req.params.id);
      if (payable) {
        const totalPaid = parseFloat(payable.amountPaid || '0') + parseFloat(data.amount);
        const totalAmount = parseFloat(payable.amount);
        // FIX: baixa parcial marcava 'a_vencer' mesmo com vencimento no passado,
        // tirando o titulo da lista de atrasados. Tolerancia de meio centavo para
        // arredondamento, e 'vencida' quando o vencimento ja passou (fuso de SP).
        const hojeBR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
        const dv: any = (payable as any).dueDate;
        const vencP = dv instanceof Date
          ? new Date(dv.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10)
          : (dv ? String(dv).slice(0, 10) : '');
        const newStatus = totalPaid >= totalAmount - 0.005
          ? 'paga'
          : (/^\d{4}-\d{2}-\d{2}$/.test(vencP) && vencP < hojeBR ? 'vencida' : 'a_vencer');
        await storage.updatePayable(req.params.id, {
          amountPaid: totalPaid.toFixed(2),
          status: newStatus as any
        });

        // FIX: pagar fornecedor NAO debitava a conta. Nao existia um unico
        // movimento de 'debito' no sistema inteiro — o saldo so subia, e o caixa
        // exibido ficava inflado por tudo que ja foi pago. O movimento e gravado
        // ANTES do saldo: se falhar, o saldo nao desce sem rastro.
        const contaId = (data as any).financialAccountId || (payable as any).financialAccountId || null;
        if (contaId) {
          try {
            const conta: any = await storage.getFinancialAccount(contaId);
            if (conta) {
              const saldoAtual = parseFloat(conta.balance || '0');
              const novoSaldo = saldoAtual - parseFloat(data.amount);
              await storage.createAccountMovement({
                financialAccountId: contaId,
                type: 'debito' as any,
                amount: parseFloat(data.amount).toFixed(2),
                balanceAfter: novoSaldo.toFixed(2),
                description: `Pagamento a fornecedor - ${(payable as any).supplierName || (payable as any).description || 'conta a pagar'}`,
                sourceType: 'payable', sourceId: String(req.params.id),
                omieInstanceId: (conta as any).omieInstanceId || null,
                createdBy: user?.email || 'sistema',
              } as any);
              await storage.updateFinancialAccount(contaId, { balance: novoSaldo.toFixed(2) } as any);
            }
          } catch (e: any) {
            console.error('[FINANCEIRO] debito da conta no pagamento de pagavel falhou:', e?.message || e);
          }
        }
      }

      res.status(201).json(payment);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // FASE 3.3 - FLUXO DE CAIXA (regime de caixa, por conta bancaria)
  // ============================================================================

  // Realizado = pagamentos efetivos (data em que o dinheiro entrou/saiu), excluindo
  // titulos cancelados/apagados. Previsto = titulos abertos pelo mes de vencimento
  // (valor restante). Tudo quebrado por conta bancaria ('sem_conta' quando nao ha).
  app.get('/api/financial/cashflow', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const year = parseInt(String(req.query.year || '')) || new Date().getFullYear();
      const startDate = new Date(Date.UTC(year, 0, 1));
      const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

      const accQ: any = await db.execute(sql`SELECT id, name, type, balance FROM financial_accounts WHERE is_active = true ORDER BY name`);
      const accounts = (((accQ as any).rows || []) as any[]).map((a: any) => ({ id: a.id, name: a.name, type: a.type, balance: Number(a.balance || 0) }));

      const bucketize = (rows: any[]) => {
        const out: Record<string, number[]> = { total: new Array(12).fill(0) };
        for (const r of rows) {
          const mi = Number(r.m) - 1;
          if (mi < 0 || mi > 11) continue;
          const key = r.acc || 'sem_conta';
          if (!out[key]) out[key] = new Array(12).fill(0);
          const v = Number(r.v || 0);
          out[key][mi] += v;
          out.total[mi] += v;
        }
        return out;
      };
      const scalarize = (rows: any[]) => {
        const out: Record<string, number> = { total: 0 };
        for (const r of rows) {
          const key = r.acc || 'sem_conta';
          const v = Number(r.v || 0);
          out[key] = (out[key] || 0) + v;
          out.total += v;
        }
        return out;
      };

      const realEntQ: any = await db.execute(sql`
        SELECT extract(month FROM p.paid_at)::int AS m,
               COALESCE(p.financial_account_id, t.financial_account_id) AS acc,
               COALESCE(sum(p.amount::numeric), 0) AS v
        FROM receivable_payments p
        JOIN receivables t ON t.id = p.receivable_id
        WHERE t.status <> 'cancelada' AND t.deleted_at IS NULL
          AND p.paid_at >= ${startDate} AND p.paid_at <= ${endDate}
        GROUP BY 1, 2`);
      const realSaiQ: any = await db.execute(sql`
        SELECT extract(month FROM p.paid_at)::int AS m,
               COALESCE(p.financial_account_id, t.financial_account_id) AS acc,
               COALESCE(sum(p.amount::numeric), 0) AS v
        FROM payable_payments p
        JOIN payables t ON t.id = p.payable_id
        WHERE t.status <> 'cancelada' AND t.deleted_at IS NULL
          AND p.paid_at >= ${startDate} AND p.paid_at <= ${endDate}
        GROUP BY 1, 2`);
      const prevEntQ: any = await db.execute(sql`
        SELECT extract(month FROM t.due_date)::int AS m,
               t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM receivables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date >= ${startDate} AND t.due_date <= ${endDate}
        GROUP BY 1, 2`);
      const prevSaiQ: any = await db.execute(sql`
        SELECT extract(month FROM t.due_date)::int AS m,
               t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM payables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date >= ${startDate} AND t.due_date <= ${endDate}
        GROUP BY 1, 2`);
      const atrEntQ: any = await db.execute(sql`
        SELECT t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM receivables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date < ${startDate}
        GROUP BY 1`);
      const atrSaiQ: any = await db.execute(sql`
        SELECT t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM payables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date < ${startDate}
        GROUP BY 1`);

      res.json({
        year,
        accounts,
        realizado: { entradas: bucketize((realEntQ as any).rows || []), saidas: bucketize((realSaiQ as any).rows || []) },
        previsto: { entradas: bucketize((prevEntQ as any).rows || []), saidas: bucketize((prevSaiQ as any).rows || []) },
        atrasados: { entradas: scalarize((atrEntQ as any).rows || []), saidas: scalarize((atrSaiQ as any).rows || []) },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // FASE 3.3 - Backfill de conta bancaria (dryRun por padrao; so preenche NULLs,
  // nunca sobrescreve). Ordem: A) conta do pagamento -> titulo; C) mapa por forma
  // de pagamento; D) legados baixados sem forma -> BB - MATRIZ; B) titulo -> pagamentos.
  app.post('/api/financial/backfill-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (actorOf(req) as any)?.email || 'backfill-f33';
      const accQ: any = await db.execute(sql`SELECT id, name FROM financial_accounts WHERE is_active = true`);
      const accRows = (((accQ as any).rows || []) as any[]);
      const byName = (n: string) => accRows.find((a: any) => String(a.name).trim().toUpperCase() === n)?.id || null;
      const MATRIZ = byName('BB - MATRIZ');
      const CAIXINHA = byName('CAIXINHA');
      const CARTOES = byName('CARTOES');
      if (!MATRIZ || !CAIXINHA || !CARTOES) {
        return res.status(400).json({ message: 'Contas BB - MATRIZ / CAIXINHA / CARTOES nao encontradas', encontradas: accRows.map((a: any) => a.name) });
      }

      const steps: any[] = [];
      const run = async (label: string, countQ: any, updateQ: any) => {
        const c: any = await db.execute(countQ);
        const candidatos = Number((c as any).rows?.[0]?.n || 0);
        let atualizados = 0;
        if (!dryRun && candidatos > 0) {
          const u: any = await db.execute(updateQ);
          atualizados = Number((u as any)?.rowCount ?? 0);
        }
        steps.push({ step: label, candidatos, atualizados });
      };

      // A0 - normaliza conta vazia ('') para NULL (heranca de importacoes antigas)
      await run('A0a recebiveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM receivables WHERE financial_account_id = ''`,
        sql`UPDATE receivables SET financial_account_id = NULL WHERE financial_account_id = ''`);
      await run('A0b pagaveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM payables WHERE financial_account_id = ''`,
        sql`UPDATE payables SET financial_account_id = NULL WHERE financial_account_id = ''`);
      await run('A0c pagamentos de recebiveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM receivable_payments WHERE financial_account_id = ''`,
        sql`UPDATE receivable_payments SET financial_account_id = NULL WHERE financial_account_id = ''`);
      await run('A0d pagamentos de pagaveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM payable_payments WHERE financial_account_id = ''`,
        sql`UPDATE payable_payments SET financial_account_id = NULL WHERE financial_account_id = ''`);

      // A1/A2 - conta do pagamento mais recente -> titulo sem conta
      await run('A1 recebiveis <- conta dos pagamentos',
        sql`SELECT count(*)::int AS n FROM receivables r
            WHERE r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'
              AND EXISTS (SELECT 1 FROM receivable_payments p WHERE p.receivable_id = r.id AND p.financial_account_id IS NOT NULL)`,
        sql`UPDATE receivables r SET financial_account_id = s.acc, updated_by = ${by}, updated_at = now()
            FROM (SELECT DISTINCT ON (receivable_id) receivable_id, financial_account_id AS acc
                  FROM receivable_payments WHERE financial_account_id IS NOT NULL
                  ORDER BY receivable_id, paid_at DESC) s
            WHERE r.id = s.receivable_id AND r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'`);
      await run('A2 pagaveis <- conta dos pagamentos',
        sql`SELECT count(*)::int AS n FROM payables r
            WHERE r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'
              AND EXISTS (SELECT 1 FROM payable_payments p WHERE p.payable_id = r.id AND p.financial_account_id IS NOT NULL)`,
        sql`UPDATE payables r SET financial_account_id = s.acc, updated_by = ${by}, updated_at = now()
            FROM (SELECT DISTINCT ON (payable_id) payable_id, financial_account_id AS acc
                  FROM payable_payments WHERE financial_account_id IS NOT NULL
                  ORDER BY payable_id, paid_at DESC) s
            WHERE r.id = s.payable_id AND r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'`);

      // C1/C2 - mapa por forma de pagamento (dinheiro -> CAIXINHA; cartao -> CARTOES; resto -> BB - MATRIZ)
      const mapCase = sql`CASE WHEN payment_method = 'dinheiro' THEN ${CAIXINHA}
                               WHEN payment_method IN ('cartao_credito', 'cartao_debito') THEN ${CARTOES}
                               ELSE ${MATRIZ} END`;
      await run('C1 recebiveis: mapa por forma de pagamento',
        sql`SELECT count(*)::int AS n FROM receivables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('recebida', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`,
        sql`UPDATE receivables SET financial_account_id = ${mapCase}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('recebida', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`);
      await run('C2 pagaveis: mapa por forma de pagamento',
        sql`SELECT count(*)::int AS n FROM payables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('paga', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`,
        sql`UPDATE payables SET financial_account_id = ${mapCase}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('paga', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`);

      // D1/D2 - legados ja baixados sem forma de pagamento -> BB - MATRIZ
      await run('D1 recebidas legadas (sem forma) -> BB - MATRIZ',
        sql`SELECT count(*)::int AS n FROM receivables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'recebida' AND payment_method IS NULL`,
        sql`UPDATE receivables SET financial_account_id = ${MATRIZ}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'recebida' AND payment_method IS NULL`);
      await run('D2 pagas legadas (sem forma) -> BB - MATRIZ',
        sql`SELECT count(*)::int AS n FROM payables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'paga' AND payment_method IS NULL`,
        sql`UPDATE payables SET financial_account_id = ${MATRIZ}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'paga' AND payment_method IS NULL`);

      // B1/B2 - conta do titulo -> pagamentos sem conta (depois de A/C/D)
      await run('B1 pagamentos de recebiveis <- conta do titulo',
        sql`SELECT count(*)::int AS n FROM receivable_payments p JOIN receivables r ON r.id = p.receivable_id
            WHERE p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`,
        sql`UPDATE receivable_payments p SET financial_account_id = r.financial_account_id
            FROM receivables r WHERE r.id = p.receivable_id
              AND p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`);
      await run('B2 pagamentos de pagaveis <- conta do titulo',
        sql`SELECT count(*)::int AS n FROM payable_payments p JOIN payables r ON r.id = p.payable_id
            WHERE p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`,
        sql`UPDATE payable_payments p SET financial_account_id = r.financial_account_id
            FROM payables r WHERE r.id = p.payable_id
              AND p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`);

      try { await logFinancialAudit({ req, action: 'config', entity: 'backfill_accounts', note: (dryRun ? 'dryRun ' : '') + JSON.stringify(steps).slice(0, 900) }); } catch {}
      res.json({ dryRun, contas: { MATRIZ, CAIXINHA, CARTOES }, steps });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // DRE (Income Statement) - Monthly Breakdown
  // ============================================================================

  app.get('/api/financial/dre', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const year = parseInt(req.query.year as string) || new Date().getFullYear();

      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      // FASE 2 - DRE nao considera titulos cancelados.
      const receivables = (await storage.getReceivables({ instanceId, startDate, endDate })).filter((r: any) => String(r.status) !== 'cancelada');
      const payables = (await storage.getPayables({ instanceId, startDate, endDate })).filter((p: any) => String(p.status) !== 'cancelada');
      const chartAccounts = await storage.getChartOfAccounts(instanceId);

      // FASE 3.4l - contas marcadas como fora da DRE (include_in_dre=false) nao geram
      // linhas na DRE. Continuam no accountMap (para nao caírem em "sem categoria") e
      // seguem no fluxo de caixa (regime caixa, por conta bancaria).
      const incFmap = await incDreMap();
      const inDre = (a: any) => incFmap.get(String(a.id)) !== false;

      const accountMap = new Map(chartAccounts.map(a => [a.id, a]));

      const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

      const getMonthIndex = (dateVal: any): number => {
        const d = new Date(dateVal);
        return d.getMonth();
      };

      const buildAccountMonthly = (accountId: string, items: any[], amountField: string = 'amount'): number[] => {
        const monthly = new Array(12).fill(0);
        for (const item of items) {
          if (item.chartAccountId === accountId) {
            const m = getMonthIndex(item.issueDate);
            if (m >= 0 && m < 12) {
              monthly[m] += parseFloat(item[amountField] || '0');
            }
          }
        }
        return monthly;
      }

      const dreGroups = [
        'receita_bruta', 'devolucoes', 'impostos_vendas',
        'cpv',
        'despesas_comerciais', 'despesas_administrativas', 'despesas_gerais',
        'outras_receitas_despesas', 'depreciacao',
        'receitas_financeiras', 'despesas_financeiras',
        'irpj_csll',
      ];

      const lines: any[] = [];

      for (const group of dreGroups) {
        const groupAccounts = chartAccounts.filter(a => a.dreGroup === group && inDre(a)).sort((a, b) => a.code.localeCompare(b.code));
        if (groupAccounts.length === 0) continue;

        const isGroupHeader = groupAccounts.find(a => !a.code.includes('.'));
        const childAccounts = groupAccounts.filter(a => a.code.includes('.'));

        for (const acc of childAccounts) {
          let monthly: number[];
          if (acc.type === 'receita') {
            monthly = buildAccountMonthly(acc.id, receivables);
          } else {
            monthly = buildAccountMonthly(acc.id, payables);
          }
          const total = monthly.reduce((s, v) => s + v, 0);
          lines.push({
            code: acc.code,
            name: acc.name,
            dreGroup: group,
            type: acc.type,
            isHeader: false,
            monthly,
            total,
            accountId: acc.id,
          });
        }
      }

      // FASE 3.1 - Devolucoes no DRE: alimentadas pelas NF-es de devolucao emitidas
      // (nature_of_operation com DEVOLU, ex: CFOP 1.202), pela data de emissao/criacao.
      try {
        const devAcc = chartAccounts.find(a => a.dreGroup === 'devolucoes' && a.code.includes('.') && inDre(a));
        if (devAcc) {
          const instCond = instanceId ? sql`AND omie_instance_id = ${instanceId}` : sql``;
          const dq: any = await db.execute(sql`
            SELECT extract(month FROM COALESCE(emission_date, created_at))::int AS m,
                   COALESCE(sum(total_invoice::numeric), 0) AS v
            FROM fiscal_invoices
            WHERE upper(coalesce(nature_of_operation, '')) LIKE '%DEVOLU%'
              AND COALESCE(emission_date, created_at) >= ${startDate}
              AND COALESCE(emission_date, created_at) <= ${endDate}
              AND status NOT IN ('draft', 'cancelled', 'cancelada', 'rejected', 'rejeitada')
              ${instCond}
            GROUP BY 1`);
          const monthly = new Array(12).fill(0);
          for (const r of ((dq as any).rows || [])) { const mi = Number(r.m) - 1; if (mi >= 0 && mi < 12) monthly[mi] = Number(r.v || 0); }
          const total = monthly.reduce((s, v) => s + v, 0);
          const idx = lines.findIndex(l => l.accountId === devAcc.id);
          const line = { code: devAcc.code, name: devAcc.name, dreGroup: 'devolucoes', type: devAcc.type, isHeader: false, monthly, total, accountId: devAcc.id };
          if (idx >= 0) lines[idx] = line; else lines.push(line);
        }
      } catch {}

      const unclassifiedRecMonthly = new Array(12).fill(0);
      for (const r of receivables) {
        if (!r.chartAccountId || !accountMap.has(r.chartAccountId)) {
          const m = getMonthIndex(r.issueDate);
          if (m >= 0 && m < 12) unclassifiedRecMonthly[m] += parseFloat(r.amount || '0');
        }
      }
      const unclassifiedRecTotal = unclassifiedRecMonthly.reduce((s, v) => s + v, 0);

      const unclassifiedPayMonthly = new Array(12).fill(0);
      for (const p of payables) {
        if (!p.chartAccountId || !accountMap.has(p.chartAccountId)) {
          const m = getMonthIndex(p.issueDate);
          if (m >= 0 && m < 12) unclassifiedPayMonthly[m] += parseFloat(p.amount || '0');
        }
      }
      const unclassifiedPayTotal = unclassifiedPayMonthly.reduce((s, v) => s + v, 0);

      const sumGroupMonthly = (group: string): number[] => {
        const monthly = new Array(12).fill(0);
        for (const line of lines) {
          if (line.dreGroup === group) {
            for (let i = 0; i < 12; i++) monthly[i] += line.monthly[i];
          }
        }
        return monthly;
      }

      const receitaBruta = sumGroupMonthly('receita_bruta');
      const devolucoes = sumGroupMonthly('devolucoes');
      const impostos = sumGroupMonthly('impostos_vendas');
      const cpvTotal = sumGroupMonthly('cpv');
      const despCom = sumGroupMonthly('despesas_comerciais');
      const despAdm = sumGroupMonthly('despesas_administrativas');
      const despGer = sumGroupMonthly('despesas_gerais');
      const outrasRD = sumGroupMonthly('outras_receitas_despesas');
      const depreciacao = sumGroupMonthly('depreciacao');
      const recFin = sumGroupMonthly('receitas_financeiras');
      const despFin = sumGroupMonthly('despesas_financeiras');
      const irpj = sumGroupMonthly('irpj_csll');

      const receitaLiquida = receitaBruta.map((v, i) => v - devolucoes[i] - impostos[i]);
      const lucroBruto = receitaLiquida.map((v, i) => v - cpvTotal[i]);
      const despOpTotal = despCom.map((v, i) => v + despAdm[i] + despGer[i] + outrasRD[i]);
      const ebitdaCalc = lucroBruto.map((v, i) => v - despCom[i] - despAdm[i] - despGer[i] - outrasRD[i]);
      const ebitCalc = ebitdaCalc.map((v, i) => v - depreciacao[i]);
      const resultadoFinanceiro = recFin.map((v, i) => v - despFin[i]);
      const resultadoAntesIR = ebitCalc.map((v, i) => v - despFin[i] + recFin[i]);
      const lucroLiquido = resultadoAntesIR.map((v, i) => v - irpj[i]);

      const sumArr = (arr: number[]) => arr.reduce((s, v) => s + v, 0);

      const computed = {
        receitaBruta: { monthly: receitaBruta, total: sumArr(receitaBruta) },
        devolucoes: { monthly: devolucoes, total: sumArr(devolucoes) },
        impostos: { monthly: impostos, total: sumArr(impostos) },
        receitaLiquida: { monthly: receitaLiquida, total: sumArr(receitaLiquida) },
        cpvTotal: { monthly: cpvTotal, total: sumArr(cpvTotal) },
        lucroBruto: { monthly: lucroBruto, total: sumArr(lucroBruto) },
        despesasComerciais: { monthly: despCom, total: sumArr(despCom) },
        despesasAdministrativas: { monthly: despAdm, total: sumArr(despAdm) },
        despesasGerais: { monthly: despGer, total: sumArr(despGer) },
        outrasReceitasDespesas: { monthly: outrasRD, total: sumArr(outrasRD) },
        despesasOperacionaisTotal: { monthly: despOpTotal.map((v, i) => v + depreciacao[i]), total: sumArr(despOpTotal) + sumArr(depreciacao) },
        depreciacao: { monthly: depreciacao, total: sumArr(depreciacao) },
        ebitda: { monthly: ebitdaCalc, total: sumArr(ebitdaCalc) },
        ebit: { monthly: ebitCalc, total: sumArr(ebitCalc) },
        receitasFinanceiras: { monthly: recFin, total: sumArr(recFin) },
        despesasFinanceiras: { monthly: despFin, total: sumArr(despFin) },
        resultadoFinanceiro: { monthly: resultadoFinanceiro, total: sumArr(resultadoFinanceiro) },
        resultadoAntesIR: { monthly: resultadoAntesIR, total: sumArr(resultadoAntesIR) },
        irpjCsll: { monthly: irpj, total: sumArr(irpj) },
        lucroLiquido: { monthly: lucroLiquido, total: sumArr(lucroLiquido) },
        unclassifiedReceivables: { monthly: unclassifiedRecMonthly, total: unclassifiedRecTotal },
        unclassifiedPayables: { monthly: unclassifiedPayMonthly, total: unclassifiedPayTotal },
      };

      res.json({
        year,
        months,
        lines,
        computed,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // XML SEARCH (from fiscal_invoices)
  // ============================================================================

  app.get('/api/financial/xml-documents', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { db } = await import('./db');
      const { fiscalInvoices } = await import('@shared/schema');
      const { eq, and, gte, lte, desc, isNotNull, or, like } = await import('drizzle-orm');
      
      const conditions: any[] = [];
      
      if (req.query.instanceId) {
        conditions.push(eq(fiscalInvoices.omieInstanceId, req.query.instanceId as string));
      }
      if (req.query.status) {
        conditions.push(eq(fiscalInvoices.status, req.query.status as string));
      }
      if (req.query.startDate) {
        conditions.push(gte(fiscalInvoices.emissionDate, new Date(req.query.startDate as string)));
      }
      if (req.query.endDate) {
        conditions.push(lte(fiscalInvoices.emissionDate, new Date(req.query.endDate as string)));
      }
      if (req.query.customerName) {
        conditions.push(like(fiscalInvoices.customerName, `%${req.query.customerName}%`));
      }
      if (req.query.accessKey) {
        conditions.push(eq(fiscalInvoices.accessKey, req.query.accessKey as string));
      }

      const hasXml = or(
        isNotNull(fiscalInvoices.xmlEnvio),
        isNotNull(fiscalInvoices.xmlRetorno),
        isNotNull(fiscalInvoices.xmlAutorizacao)
      );

      let query;
      if (conditions.length > 0) {
        query = db.select({
          id: fiscalInvoices.id,
          invoiceNumber: fiscalInvoices.invoiceNumber,
          series: fiscalInvoices.series,
          accessKey: fiscalInvoices.accessKey,
          status: fiscalInvoices.status,
          customerName: fiscalInvoices.customerName,
          customerCnpjCpf: fiscalInvoices.customerCnpjCpf,
          issuerName: fiscalInvoices.issuerName,
          issuerCnpj: fiscalInvoices.issuerCnpj,
          totalInvoice: fiscalInvoices.totalInvoice,
          emissionDate: fiscalInvoices.emissionDate,
          omieInstanceId: fiscalInvoices.omieInstanceId,
          hasXmlEnvio: fiscalInvoices.xmlEnvio,
          hasXmlRetorno: fiscalInvoices.xmlRetorno,
          hasXmlAutorizacao: fiscalInvoices.xmlAutorizacao,
        }).from(fiscalInvoices).where(and(...conditions)).orderBy(desc(fiscalInvoices.emissionDate));
      } else {
        query = db.select({
          id: fiscalInvoices.id,
          invoiceNumber: fiscalInvoices.invoiceNumber,
          series: fiscalInvoices.series,
          accessKey: fiscalInvoices.accessKey,
          status: fiscalInvoices.status,
          customerName: fiscalInvoices.customerName,
          customerCnpjCpf: fiscalInvoices.customerCnpjCpf,
          issuerName: fiscalInvoices.issuerName,
          issuerCnpj: fiscalInvoices.issuerCnpj,
          totalInvoice: fiscalInvoices.totalInvoice,
          emissionDate: fiscalInvoices.emissionDate,
          omieInstanceId: fiscalInvoices.omieInstanceId,
          hasXmlEnvio: fiscalInvoices.xmlEnvio,
          hasXmlRetorno: fiscalInvoices.xmlRetorno,
          hasXmlAutorizacao: fiscalInvoices.xmlAutorizacao,
        }).from(fiscalInvoices).orderBy(desc(fiscalInvoices.emissionDate));
      }

      const results = await query;
      
      const mapped = results.map(r => ({
        ...r,
        hasXmlEnvio: !!r.hasXmlEnvio,
        hasXmlRetorno: !!r.hasXmlRetorno,
        hasXmlAutorizacao: !!r.hasXmlAutorizacao,
      }));

      res.json(mapped);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/xml-documents/:id/download/:type', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { db } = await import('./db');
      const { fiscalInvoices } = await import('@shared/schema');
      const { eq } = await import('drizzle-orm');

      const [invoice] = await db.select().from(fiscalInvoices).where(eq(fiscalInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ message: 'NF-e não encontrada' });

      let xml: string | null = null;
      let filename = '';

      switch (req.params.type) {
        case 'envio':
          xml = invoice.xmlEnvio;
          filename = `nfe_envio_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        case 'retorno':
          xml = invoice.xmlRetorno;
          filename = `nfe_retorno_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        case 'autorizacao':
          xml = invoice.xmlAutorizacao;
          filename = `nfe_autorizacao_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        default:
          return res.status(400).json({ message: 'Tipo de XML inválido' });
      }

      if (!xml) return res.status(404).json({ message: 'XML não disponível' });

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(xml);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // SPED FISCAL
  // ============================================================================

  app.get('/api/financial/sped-exports', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const exports = await storage.getSpedExports(instanceId);
      res.json(exports);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/sped-exports/generate', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const { type, periodStart, periodEnd, omieInstanceId } = req.body;

      if (!type || !periodStart || !periodEnd) {
        return res.status(400).json({ message: 'Tipo, período inicial e final são obrigatórios' });
      }

      const { db } = await import('./db');
      const { fiscalInvoices, fiscalInvoiceItems } = await import('@shared/schema');
      const { eq, and, gte, lte, desc } = await import('drizzle-orm');

      const conditions: any[] = [
        gte(fiscalInvoices.emissionDate, new Date(periodStart)),
        lte(fiscalInvoices.emissionDate, new Date(periodEnd)),
      ];
      if (omieInstanceId) {
        conditions.push(eq(fiscalInvoices.omieInstanceId, omieInstanceId));
      }

      const invoices = await db.select().from(fiscalInvoices)
        .where(and(...conditions))
        .orderBy(desc(fiscalInvoices.emissionDate));

      const allItems: any[] = [];
      for (const inv of invoices) {
        const items = await db.select().from(fiscalInvoiceItems)
          .where(eq(fiscalInvoiceItems.invoiceId, inv.id));
        allItems.push(...items.map(item => ({ ...item, invoice: inv })));
      }

      const receivablesList = await storage.getReceivables({
        instanceId: omieInstanceId,
        startDate: new Date(periodStart),
        endDate: new Date(periodEnd),
      });

      const payablesList = await storage.getPayables({
        instanceId: omieInstanceId,
        startDate: new Date(periodStart),
        endDate: new Date(periodEnd),
      });

      let content = '';

      if (type === 'SPED_FISCAL') {
        content = generateSpedFiscal(invoices, allItems, receivablesList, payablesList, periodStart, periodEnd, omieInstanceId);
      } else if (type === 'BLOCO_K') {
        content = generateBlocoK(invoices, allItems, periodStart, periodEnd);
      } else {
        return res.status(400).json({ message: 'Tipo inválido. Use SPED_FISCAL ou BLOCO_K' });
      }

      const fileName = `${type}_${omieInstanceId || 'ALL'}_${periodStart.substring(0,7)}.txt`;

      const spedExport = await storage.createSpedExport({
        type,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        omieInstanceId: omieInstanceId || null,
        fileName,
        fileContent: content,
        status: 'generated',
        createdBy: user?.email || null,
      });

      res.status(201).json(spedExport);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/sped-exports/:id/download', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const exports = await storage.getSpedExports();
      const spedExport = exports.find(e => e.id === req.params.id);
      if (!spedExport) return res.status(404).json({ message: 'Exportação não encontrada' });

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${spedExport.fileName}"`);
      res.send(spedExport.fileContent || '');
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

function formatDecimal(value: string | number | null, decimals = 2): string {
  const num = typeof value === 'string' ? parseFloat(value) : (value || 0);
  return num.toFixed(decimals).replace('.', ',');
}

function generateSpedFiscal(
  invoices: any[], 
  items: any[], 
  receivables: any[],
  payables: any[],
  periodStart: string, 
  periodEnd: string,
  instanceId?: string
): string {
  const lines: string[] = [];
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  lines.push(`|0000|016|0|${formatDate(start)}|${formatDate(end)}|||${instanceId || ''}||||A|1|`);
  lines.push(`|0001|0|`);
  lines.push(`|0005|||||||||`);
  lines.push(`|0100|||||||||||||||||`);

  const productMap = new Map<string, any>();
  items.forEach(item => {
    if (item.productCode && !productMap.has(item.productCode)) {
      productMap.set(item.productCode, item);
    }
  });

  let itemIdx = 0;
  productMap.forEach((item, code) => {
    lines.push(`|0200|${code}|${item.productName || ''}||${item.ncm || ''}||${item.unit || 'UN'}|0|0|||0|`);
    itemIdx++;
  });

  lines.push(`|0990|${lines.length + 1}|`);

  lines.push(`|C001|0|`);
  
  invoices.forEach((inv, idx) => {
    const invItems = items.filter(i => i.invoice?.id === inv.id);
    lines.push(`|C100|0|1|${inv.customerCnpjCpf || ''}|55|00|${inv.series || '1'}|${inv.invoiceNumber || ''}|${inv.accessKey || ''}|${formatDate(inv.emissionDate || new Date())}|${formatDate(inv.emissionDate || new Date())}|${formatDecimal(inv.totalProducts)}|0,00|0,00|${formatDecimal(inv.totalDiscount)}|0,00|0,00|0,00|${formatDecimal(inv.totalProducts)}|9|0,00|${formatDecimal(inv.totalIcms)}|0,00|0,00|${formatDecimal(inv.totalPis)}|${formatDecimal(inv.totalCofins)}|0,00|0,00|0,00|0,00|`);
    
    invItems.forEach((item, itemIdx) => {
      lines.push(`|C170|${itemIdx + 1}|${item.productCode || ''}|${item.productName || ''}|${formatDecimal(item.quantity)}|${item.unit || 'UN'}|${formatDecimal(item.unitPrice)}|${formatDecimal(item.totalPrice)}|0,00|0|${item.cfop || inv.cfop || ''}|0|0,00|0,00|0,00|0,00|0,00|${item.ncm || ''}|0,00|0,00|0,00|0,00|`);
    });

    lines.push(`|C190|${inv.cfop || ''}|0|${formatDecimal(inv.totalProducts)}|${formatDecimal(inv.totalIcms)}|0,00|0,00|0,00|0,00|0,00|0,00|`);
  });

  lines.push(`|C990|${lines.length + 1}|`);

  lines.push(`|E001|0|`);
  lines.push(`|E100|${formatDate(start)}|${formatDate(end)}|`);
  lines.push(`|E110|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|`);
  lines.push(`|E990|${lines.length + 1}|`);

  lines.push(`|H001|0|`);
  lines.push(`|H005|${formatDate(end)}|0,00|0|`);
  lines.push(`|H990|${lines.length + 1}|`);

  lines.push(`|9001|0|`);
  lines.push(`|9900|0000|1|`);
  lines.push(`|9900|9999|1|`);
  lines.push(`|9990|${lines.length + 1}|`);
  lines.push(`|9999|${lines.length + 1}|`);

  return lines.join('\r\n');
}

function generateBlocoK(
  invoices: any[], 
  items: any[],
  periodStart: string, 
  periodEnd: string
): string {
  const lines: string[] = [];
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  lines.push(`|0000|016|0|${formatDate(start)}|${formatDate(end)}||||||||A|1|`);
  
  lines.push(`|K001|0|`);
  lines.push(`|K100|${formatDate(start)}|${formatDate(end)}|`);

  const productMap = new Map<string, { code: string; name: string; totalQty: number }>();
  items.forEach(item => {
    const code = item.productCode || '';
    if (code) {
      const existing = productMap.get(code);
      if (existing) {
        existing.totalQty += parseFloat(item.quantity || '0');
      } else {
        productMap.set(code, {
          code,
          name: item.productName || '',
          totalQty: parseFloat(item.quantity || '0'),
        });
      }
    }
  });

  productMap.forEach((prod) => {
    lines.push(`|K200|${formatDate(end)}|${prod.code}|${formatDecimal(prod.totalQty)}|0|0,00|`);
  });

  invoices.forEach((inv) => {
    const invItems = items.filter(i => i.invoice?.id === inv.id);
    if (invItems.length > 0) {
      lines.push(`|K230|${formatDate(inv.emissionDate || new Date())}|${invItems[0]?.productCode || ''}|${formatDecimal(invItems.reduce((sum: number, i: any) => sum + parseFloat(i.quantity || '0'), 0))}|`);
    }
  });

  lines.push(`|K990|${lines.length + 1}|`);

  lines.push(`|9001|0|`);
  lines.push(`|9900|K001|1|`);
  lines.push(`|9990|${lines.length + 1}|`);
  lines.push(`|9999|${lines.length + 1}|`);

  return lines.join('\r\n');
}
