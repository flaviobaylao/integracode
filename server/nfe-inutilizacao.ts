// ═══════════════════════════════════════════════════════════════════════════
// INUTILIZAÇÃO DE NUMERAÇÃO NF-e / NFC-e (set/2026)
// ───────────────────────────────────────────────────────────────────────────
// Regra (Ajuste SINIEF 07/05, cl. 14ª): número pulado na sequência de um
// CNPJ + modelo + série deve ser inutilizado na SEFAZ até o 10º dia do mês
// seguinte. Esta tela:
//   1. LEVANTA as lacunas — a fonte de verdade é a CHAVE DE ACESSO das notas
//      de produção que CONSUMIRAM número (autorizada, cancelada, denegada).
//      O issuer_cnpj da tabela não é confiável para notas antigas; a chave é.
//      Nota rejeitada / rascunho / erro não consome número → vira lacuna.
//   2. ENVIA o pedido (NFeInutilizacao4) com o A1 do CNPJ e guarda o protocolo
//      em fiscal_inutilizacoes; faixas homologadas saem do levantamento.
//   3. Marca como 'inutilizada' as notas do Integra presas nessa faixa.
// Só leitura no levantamento; escrita só no envio (admin/administrativo).
//
// OUT/2026 (auditoria de numeração):
//   • nota DEVOLVIDA ('returned') consumiu número — antes virava "lacuna" e a SEFAZ
//     recusava a faixa inteira;
//   • números com INDÍCIO de uso na SEFAZ (autorizada antes, 539, falha de comunicação)
//     saem das faixas e vão para a lista "conferir na SEFAZ";
//   • faixa acima do limite da SEFAZ (10.000 números/pedido, rejeição 201) é dividida;
//   • LOTE no servidor (POST /lote): envia faixa a faixa com pausa, e quando a SEFAZ diz
//     que há número usado/inutilizado na faixa (241/256) divide ao meio até isolar o número;
//   • ALERTA diário por WhatsApp das lacunas com prazo (dia 10 do mês seguinte).
// ═══════════════════════════════════════════════════════════════════════════
import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import cron from "node-cron";
import { inutilizarNumeracao, UF_CODES } from "./sefaz-service";
import { sendUmblerTalkText } from "./chat-routes";
import { registerContabilidadeRoutes, registerContabilidadeFiscal, registerContabilidadeContabil } from "./contabilidade";
import { registerSpedFiscal } from "./sped-fiscal";
import { registerContabilidadeInsumos } from "./contabilidade-insumos";

const CUF_UF: Record<string, string> = Object.fromEntries(Object.entries(UF_CODES).map(([uf, c]) => [c, uf]));

const NOMES_CNPJ: Record<string, string> = {
  "28295493000153": "IND — Puro Indústria (matriz)",
  "28295493000234": "GYN — Puro Indústria (filial Goiânia)",
  "28295493000315": "BSB — Puro Indústria (filial Brasília)",
  "52921727000105": "SERV — Puro Serviços",
};

let _ensured = false;
async function ensureTabela() {
  if (_ensured) return;
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS fiscal_inutilizacoes (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      cnpj varchar(14) NOT NULL,
      uf varchar(2) NOT NULL,
      modelo varchar(2) NOT NULL,
      serie integer NOT NULL,
      ano integer NOT NULL,
      numero_inicial integer NOT NULL,
      numero_final integer NOT NULL,
      justificativa text NOT NULL,
      ambiente varchar NOT NULL,
      status varchar NOT NULL,             -- homologada | rejeitada | erro
      c_stat varchar,
      x_motivo text,
      protocolo varchar,
      dh_recbto varchar,
      xml_enviado text,
      xml_recebido text,
      xml_completo text,
      notas_marcadas integer DEFAULT 0,
      created_by varchar,
      created_at timestamp NOT NULL DEFAULT now()
    )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_fiscal_inut_chave ON fiscal_inutilizacoes (cnpj, modelo, serie, status)`));
  await db.execute(sql.raw(`ALTER TABLE fiscal_inutilizacoes ADD COLUMN IF NOT EXISTS lote_id varchar`));
  _ensured = true;
}

type Faixa = { ini: number; fim: number; qtd: number; dataAntes: string | null; dataDepois: string | null; ano: number; statusIntegra: string[] };

function subtrair(faixas: { ini: number; fim: number }[], usadas: { ini: number; fim: number }[]) {
  let out = faixas.slice();
  for (const u of usadas) {
    const nx: { ini: number; fim: number }[] = [];
    for (const f of out) {
      if (u.fim < f.ini || u.ini > f.fim) { nx.push(f); continue; }
      if (u.ini > f.ini) nx.push({ ini: f.ini, fim: u.ini - 1 });
      if (u.fim < f.fim) nx.push({ ini: u.fim + 1, fim: f.fim });
    }
    out = nx;
  }
  return out;
}

// Limite da SEFAZ por pedido de inutilização: 10.000 números (rejeição 201).
// Usamos 9.000 de margem.
export const LIMITE_FAIXA = 9000;
function dividirNoLimite(faixas: { ini: number; fim: number }[]) {
  const out: { ini: number; fim: number }[] = [];
  for (const f of faixas) {
    for (let a = f.ini; a <= f.fim; a += LIMITE_FAIXA) out.push({ ini: a, fim: Math.min(f.fim, a + LIMITE_FAIXA - 1) });
  }
  return out;
}

export async function levantarLacunas(filtro: { cnpj?: string; desde?: string }) {
  await ensureTabela();
  const cnpjF = String(filtro.cnpj || "").replace(/\D/g, "");
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(filtro.desde || "")) ? String(filtro.desde) : null;

  // Pares consecutivos de números USADOS (pela chave) com salto > 1.
  const r: any = await db.execute(sql`
    WITH k AS (
      SELECT DISTINCT ON (access_key)
             substr(access_key,1,2) cuf, substr(access_key,7,14) c, substr(access_key,21,2) m,
             substr(access_key,23,3)::int s, substr(access_key,26,9)::int n, emission_date dt
      FROM fiscal_invoices
      WHERE environment = 'producao' AND length(access_key) = 44 AND access_key ~ '^[0-9]{44}$'
        AND (lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied','returned')
             OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%' OR status ILIKE '%devolv%')
        AND (${cnpjF} = '' OR substr(access_key,7,14) = ${cnpjF})
    ), w AS (
      SELECT cuf,c,m,s,n,dt, lag(n) OVER (PARTITION BY c,m,s ORDER BY n) p, lag(dt) OVER (PARTITION BY c,m,s ORDER BY n) pdt FROM k
    ), resumo AS (
      SELECT c,m,s, max(cuf) cuf, count(*)::int notas, min(n) primeiro, max(n) ultimo, max(dt) ultima_emissao FROM k GROUP BY 1,2,3
    )
    SELECT 'gap' tipo, w.c, w.m, w.s, w.cuf, (w.p+1) ini, (w.n-1) fim, w.pdt dt_antes, w.dt dt_depois, null::int notas, null::int primeiro, null::int ultimo, null::timestamp ultima_emissao
      FROM w WHERE w.n - w.p > 1 AND (${desde}::date IS NULL OR w.dt >= ${desde}::date)
    UNION ALL
    SELECT 'resumo', c, m, s, cuf, null, null, null, null, notas, primeiro, ultimo, ultima_emissao FROM resumo
    ORDER BY 2,3,4,6`);
  const rows: any[] = r.rows || r;

  const inut: any = await db.execute(sql`
    SELECT cnpj, modelo, serie, numero_inicial, numero_final FROM fiscal_inutilizacoes
    WHERE status = 'homologada' AND ambiente = 'producao'`);
  const inutRows: any[] = inut.rows || inut;

  // Notas do Integra que TÊM número mas não consumiram (rejeitada/erro/rascunho) — explica a lacuna.
  const presas: any = await db.execute(sql`
    SELECT regexp_replace(coalesce(issuer_cnpj,''),'[^0-9]','','g') c, coalesce(invoice_model,'55') m,
           coalesce(nullif(series,''),'1')::int s, invoice_number n, lower(coalesce(status,'')) st,
           (created_at > now() - interval '15 days') recente,
           -- INDÍCIO DE USO NA SEFAZ: já houve autorização com protocolo, rejeição 539
           -- (número usado por outra chave) ou o último contato foi falha de comunicação
           -- (desfecho desconhecido). Esses números NÃO entram em faixa: conferir antes.
           CASE
             WHEN EXISTS (SELECT 1 FROM fiscal_invoice_events e WHERE e.invoice_id = fiscal_invoices.id
                            AND e.event_type = 'autorizacao' AND e.status = 'success') THEN 'autorizada antes na SEFAZ'
             WHEN EXISTS (SELECT 1 FROM fiscal_invoice_events e WHERE e.invoice_id = fiscal_invoices.id
                            AND (e.event_type IN ('rejeicao_539','rejeicao_539_colisao','recuperacao_539') OR e.error_code = '539')) THEN 'rejeição 539 (número já usado na SEFAZ)'
             WHEN (SELECT e.event_type FROM fiscal_invoice_events e WHERE e.invoice_id = fiscal_invoices.id
                    ORDER BY e.created_at DESC LIMIT 1) = 'falha_comunicacao' THEN 'falha de comunicação (desfecho desconhecido)'
           END suspeita,
           id, customer_name cli
    FROM fiscal_invoices
    WHERE environment = 'producao' AND invoice_number IS NOT NULL
      AND NOT (lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied','returned','inutilizada')
               OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%' OR status ILIKE '%devolv%')
      AND (${cnpjF} = '' OR regexp_replace(coalesce(issuer_cnpj,''),'[^0-9]','','g') = ${cnpjF})`);
  const presasRows: any[] = presas.rows || presas;

  const grupos = new Map<string, any>();
  const key = (c: string, m: string, s: number) => `${c}|${m}|${s}`;
  for (const row of rows) {
    const k = key(row.c, row.m, Number(row.s));
    if (!grupos.has(k)) grupos.set(k, { cnpj: row.c, nome: NOMES_CNPJ[row.c] || row.c, uf: CUF_UF[row.cuf] || "GO", modelo: row.m, serie: Number(row.s), faixas: [] as Faixa[], conferir: [] as any[] });
    const g = grupos.get(k);
    if (row.tipo === "resumo") {
      Object.assign(g, { notas: row.notas, primeiro: Number(row.primeiro), ultimo: Number(row.ultimo), ultimaEmissao: row.ultima_emissao, uf: CUF_UF[row.cuf] || g.uf });
    } else {
      const partes = subtrair([{ ini: Number(row.ini), fim: Number(row.fim) }],
        inutRows.filter((i) => i.cnpj === row.c && i.modelo === row.m && Number(i.serie) === Number(row.s))
          .map((i) => ({ ini: Number(i.numero_inicial), fim: Number(i.numero_final) }))
          // Nota recente (15 dias) com número reservado e ainda sem desfecho (rascunho,
          // pendente, rejeitada aguardando reenvio) pode ser reemitida com o MESMO
          // número — nunca inutilizar esse número.
          .concat(presasRows.filter((x) => (x.recente || x.suspeita) && x.c === row.c && x.m === row.m && Number(x.s) === Number(row.s))
            .map((x) => ({ ini: Number(x.n), fim: Number(x.n) }))));
      for (const x of presasRows) {
        if (x.suspeita && x.c === row.c && x.m === row.m && Number(x.s) === Number(row.s) && Number(x.n) >= Number(row.ini) && Number(x.n) <= Number(row.fim)
            && !g.conferir.some((y: any) => y.numero === Number(x.n))) {
          g.conferir.push({ numero: Number(x.n), motivo: x.suspeita, statusIntegra: x.st, cliente: x.cli, invoiceId: x.id });
        }
      }
      const depois = row.dt_depois ? new Date(row.dt_depois) : null;
      for (const p of dividirNoLimite(partes)) {
        const st = presasRows.filter((x) => x.c === row.c && x.m === row.m && Number(x.s) === Number(row.s) && Number(x.n) >= p.ini && Number(x.n) <= p.fim).map((x) => x.st);
        g.faixas.push({
          ini: p.ini, fim: p.fim, qtd: p.fim - p.ini + 1,
          dataAntes: row.dt_antes ? new Date(row.dt_antes).toISOString() : null,
          dataDepois: depois ? depois.toISOString() : null,
          // Ano do pedido = ano em que a sequência "passou" pelos números (nota seguinte).
          ano: depois ? depois.getUTCFullYear() : new Date().getUTCFullYear(),
          statusIntegra: Array.from(new Set(st)),
        });
      }
    }
  }
  const lista = Array.from(grupos.values()).map((g) => ({
    ...g,
    totalFaixas: g.faixas.length,
    totalNumeros: g.faixas.reduce((a: number, f: Faixa) => a + f.qtd, 0),
  }));
  return { geradoEm: new Date().toISOString(), grupos: lista };
}

export function registerInutilizacaoRoutes(app: Express) {
  registerContabilidadeRoutes(app);
  registerContabilidadeFiscal(app);
  registerContabilidadeContabil(app);
  registerSpedFiscal(app);
  registerContabilidadeInsumos(app);
  const roles = requireRole(["admin", "administrative", "coordinator"]);
  const rolesEnvio = requireRole(["admin", "administrative"]);

  app.get("/api/fiscal/inutilizacao/lacunas", authenticateUser, roles, async (req, res) => {
    try {
      res.json(await levantarLacunas({ cnpj: String(req.query.cnpj || ""), desde: String(req.query.desde || "") }));
    } catch (e: any) {
      console.error("[INUTILIZACAO] lacunas:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/api/fiscal/inutilizacao", authenticateUser, roles, async (_req, res) => {
    try {
      await ensureTabela();
      const r: any = await db.execute(sql`
        SELECT id, cnpj, uf, modelo, serie, ano, numero_inicial, numero_final, justificativa, ambiente, status,
               c_stat, x_motivo, protocolo, dh_recbto, notas_marcadas, created_by, created_at
        FROM fiscal_inutilizacoes ORDER BY created_at DESC LIMIT 500`);
      res.json(r.rows || r);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/api/fiscal/inutilizacao/:id/xml", authenticateUser, roles, async (req, res) => {
    try {
      await ensureTabela();
      const r: any = await db.execute(sql`SELECT cnpj, modelo, serie, numero_inicial, numero_final, xml_completo, xml_recebido FROM fiscal_inutilizacoes WHERE id = ${req.params.id}`);
      const row = (r.rows || r)[0];
      if (!row) return res.status(404).json({ error: "não encontrado" });
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="inut_${row.cnpj}_${row.modelo}_${row.serie}_${row.numero_inicial}-${row.numero_final}.xml"`);
      res.send(row.xml_completo || row.xml_recebido || "");
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/api/fiscal/inutilizacao", authenticateUser, rolesEnvio, async (req: any, res) => {
    try {
      const b = req.body || {};
      const quem = req.currentUser?.email || req.currentUser?.id || req.user?.email || null;
      const r = await enviarFaixa({
        cnpj: b.cnpj, modelo: b.modelo, serie: b.serie, numeroInicial: b.numeroInicial, numeroFinal: b.numeroFinal,
        ambiente: b.ambiente, uf: b.uf, ano: b.ano, justificativa: b.justificativa,
      }, quem, null);
      if (r.http !== 200) return res.status(r.http).json(r.http === 422 ? r : { error: r.error });
      res.json(r);
    } catch (e: any) {
      console.error("[INUTILIZACAO] envio:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ── LOTE NO SERVIDOR ──────────────────────────────────────────────────────
  // Envia todas as faixas de um CNPJ/modelo/série. Exige confirmacao = "INUTILIZAR".
  app.post("/api/fiscal/inutilizacao/lote", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      const b = req.body || {};
      if (String(b.confirmacao || "").trim().toUpperCase() !== "INUTILIZAR") return res.status(400).json({ error: 'Digite INUTILIZAR para confirmar.' });
      const quem = req.currentUser?.email || req.currentUser?.id || req.user?.email || null;
      const job = await iniciarLote({
        cnpj: String(b.cnpj || "").replace(/\D/g, ""), modelo: String(b.modelo || "55"), serie: Number(b.serie),
        desde: String(b.desde || "2006-01-01"), justificativa: String(b.justificativa || JUST_PADRAO), ate: b.ate ? Number(b.ate) : null,
      }, quem);
      res.json(job);
    } catch (e: any) {
      res.status(e?.status || 500).json({ error: e?.message || String(e) });
    }
  });
  app.get("/api/fiscal/inutilizacao/lote", authenticateUser, roles, async (_req, res) => {
    res.json(Array.from(LOTES.values()).sort((a, b) => b.inicio.localeCompare(a.inicio)).slice(0, 20));
  });
  app.get("/api/fiscal/inutilizacao/lote/:id", authenticateUser, roles, async (req, res) => {
    const j = LOTES.get(String(req.params.id));
    if (!j) return res.status(404).json({ error: "lote não encontrado (o servidor pode ter reiniciado — o que já foi homologado está no histórico)" });
    res.json(j);
  });
  app.post("/api/fiscal/inutilizacao/lote/:id/parar", authenticateUser, requireRole(["admin"]), async (req, res) => {
    const j = LOTES.get(String(req.params.id));
    if (!j) return res.status(404).json({ error: "lote não encontrado" });
    j.pararPedido = true;
    res.json({ ok: true });
  });

  // ── ALERTA DIÁRIO ─────────────────────────────────────────────────────────
  app.get("/api/fiscal/inutilizacao/alerta", authenticateUser, roles, async (_req, res) => {
    try { res.json(await alertaLacunas(false)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post("/api/fiscal/inutilizacao/alerta/testar", authenticateUser, roles, async (req: any, res) => {
    try { res.json(await alertaLacunas(true, { forcar: true, to: req.body?.to })); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  agendarAlerta();
}


// ═══════════════════════════════════════════════════════════════════════════
// ENVIO DE UMA FAIXA (usado pela rota manual e pelo lote)
// ═══════════════════════════════════════════════════════════════════════════
const JUST_PADRAO = "Quebra de sequencia na numeracao por falha no sistema emissor - numeros nao utilizados";
const USADA_SQL = `(lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied','returned')
  OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%' OR status ILIKE '%devolv%')`;

type EnvioFaixa = { cnpj: any; modelo: any; serie: any; numeroInicial: any; numeroFinal: any; ambiente?: any; uf?: any; ano?: any; justificativa?: any };
export async function enviarFaixa(b: EnvioFaixa, quem: string | null, loteId: string | null): Promise<any> {
  await ensureTabela();
  const cnpj = String(b.cnpj || "").replace(/\D/g, "");
  const modelo = String(b.modelo || "55") === "65" ? "65" : "55";
  const serie = Number(b.serie);
  const ini = Math.trunc(Number(b.numeroInicial));
  const fim = Math.trunc(Number(b.numeroFinal));
  const ambiente = b.ambiente === "homologacao" ? "homologacao" : "producao";
  const uf = String(b.uf || "GO").toUpperCase();
  const ano = Math.trunc(Number(b.ano));
  const justificativa = String(b.justificativa || "");
  if (cnpj.length !== 14 || !(serie >= 0) || !(ini >= 1 && fim >= ini)) return { http: 400, error: "Dados da faixa inválidos." };
  if (fim - ini + 1 > 10000) return { http: 400, error: "A SEFAZ aceita no máximo 10.000 números por pedido (rejeição 201). Divida a faixa." };

  // Trava de segurança: nunca pedir faixa que contenha número já USADO (pela chave) em produção.
  if (ambiente === "producao") {
    const u: any = await db.execute(sql`
      SELECT substr(access_key,26,9)::int n FROM fiscal_invoices
      WHERE environment = 'producao' AND length(access_key) = 44 AND access_key ~ '^[0-9]{44}$'
        AND substr(access_key,7,14) = ${cnpj} AND substr(access_key,21,2) = ${modelo}
        AND substr(access_key,23,3)::int = ${serie}
        AND substr(access_key,26,9)::int BETWEEN ${ini} AND ${fim}
        AND ${sql.raw(USADA_SQL)}
      LIMIT 5`);
    const usados = (u.rows || u).map((x: any) => x.n);
    if (usados.length) return { http: 409, error: `A faixa contém número(s) já usados: ${usados.join(", ")}. Ajuste a faixa.` };
    const dup: any = await db.execute(sql`
      SELECT numero_inicial, numero_final FROM fiscal_inutilizacoes
      WHERE status = 'homologada' AND ambiente = 'producao' AND cnpj = ${cnpj} AND modelo = ${modelo} AND serie = ${serie}
        AND numero_inicial <= ${fim} AND numero_final >= ${ini} LIMIT 1`);
    const d = (dup.rows || dup)[0];
    if (d) return { http: 409, error: `Faixa sobrepõe inutilização já homologada (${d.numero_inicial}–${d.numero_final}).` };
  }

  const r = await inutilizarNumeracao({ cnpj, uf, modelo, serie, ano, numeroInicial: ini, numeroFinal: fim, justificativa, ambiente });
  const status = r.ok ? "homologada" : (r.cStat ? "rejeitada" : "erro");

  let marcadas = 0;
  if (r.ok && ambiente === "producao") {
    const up: any = await db.execute(sql`
      UPDATE fiscal_invoices SET status = 'inutilizada', updated_at = now()
      WHERE environment = 'producao'
        AND regexp_replace(coalesce(issuer_cnpj,''),'[^0-9]','','g') = ${cnpj}
        AND coalesce(invoice_model,'55') = ${modelo}
        AND coalesce(nullif(series,''),'1')::int = ${serie}
        AND invoice_number BETWEEN ${ini} AND ${fim}
        AND NOT (lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied','returned','inutilizada')
                 OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%' OR status ILIKE '%devolv%')`);
    marcadas = Number(up.rowCount || 0);
  }

  const ins: any = await db.execute(sql`
    INSERT INTO fiscal_inutilizacoes (cnpj, uf, modelo, serie, ano, numero_inicial, numero_final, justificativa, ambiente, status,
      c_stat, x_motivo, protocolo, dh_recbto, xml_enviado, xml_recebido, xml_completo, notas_marcadas, created_by, lote_id)
    VALUES (${cnpj}, ${uf}, ${modelo}, ${serie}, ${ano}, ${ini}, ${fim}, ${justificativa}, ${ambiente}, ${status},
      ${r.cStat}, ${r.xMotivo || r.error || null}, ${r.protocolo}, ${r.dhRecbto}, ${r.xmlEnviado || null}, ${r.xmlRecebido || null}, ${r.xmlCompleto || null}, ${marcadas}, ${quem}, ${loteId})
    RETURNING id`);
  const id = (ins.rows || ins)[0]?.id;
  console.log(`[INUTILIZACAO] ${cnpj} mod ${modelo} serie ${serie} ${ini}-${fim} (${ambiente}) → ${status} cStat=${r.cStat} ${r.xMotivo || r.error || ""}`);
  return { http: r.ok ? 200 : 422, id, status, ok: r.ok, cStat: r.cStat, xMotivo: r.xMotivo, protocolo: r.protocolo, error: r.error, notasMarcadas: marcadas };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOTE (job em memória; o que já foi homologado fica gravado e sai do
// levantamento, então reiniciar o servidor no meio só exige disparar de novo)
// ═══════════════════════════════════════════════════════════════════════════
type Lote = {
  id: string; cnpj: string; nome: string; modelo: string; serie: number; inicio: string; fim: string | null;
  status: "executando" | "concluido" | "interrompido";
  faixasPrevistas: number; numerosPrevistos: number; pedidos: number; homologadas: number; numerosInutilizados: number;
  usadosNaSefaz: { ini: number; fim: number; cStat: string; xMotivo: string }[];
  erros: { ini: number; fim: number; cStat: string | null; msg: string }[];
  motivoParada: string | null; quem: string | null; pararPedido?: boolean; atual?: string;
};
const LOTES = new Map<string, Lote>();
let loteEmExecucao: string | null = null;
const PAUSA_MS = 1500;
// 241 = um número da faixa já foi utilizado · 256 = uma NF-e da faixa já está inutilizada.
// Nesses casos a SEFAZ recusa a faixa INTEIRA: dividimos ao meio até isolar o número.
const CSTAT_DIVIDIR = new Set(["241", "256"]);
// 563 = já existe pedido de inutilização com a MESMA faixa → já está feito.
const CSTAT_JA_FEITA = new Set(["563"]);
// 656 = consumo indevido (muitas chamadas) → esperar e tentar de novo.
const CSTAT_ESPERAR = new Set(["656"]);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function iniciarLote(p: { cnpj: string; modelo: string; serie: number; desde: string; justificativa: string; ate: number | null }, quem: string | null) {
  if (loteEmExecucao) throw Object.assign(new Error(`Já há um lote em execução (${loteEmExecucao}). Aguarde ou pare-o.`), { status: 409 });
  if (String(p.justificativa).trim().length < 15) throw Object.assign(new Error("Justificativa com menos de 15 caracteres."), { status: 400 });
  const lev = await levantarLacunas({ cnpj: p.cnpj, desde: p.desde });
  const g: any = lev.grupos.find((x: any) => x.cnpj === p.cnpj && x.modelo === p.modelo && Number(x.serie) === Number(p.serie));
  if (!g) throw Object.assign(new Error("Grupo (CNPJ/modelo/série) não encontrado no levantamento."), { status: 404 });
  const faixas: { ini: number; fim: number; ano: number }[] = g.faixas
    .filter((f: any) => !p.ate || f.fim <= p.ate)
    .map((f: any) => ({ ini: f.ini, fim: f.fim, ano: f.ano }));
  if (!faixas.length) throw Object.assign(new Error("Nenhuma faixa a inutilizar nesse grupo."), { status: 400 });
  const id = `inut-${Date.now().toString(36)}`;
  const job: Lote = {
    id, cnpj: p.cnpj, nome: g.nome, modelo: p.modelo, serie: Number(p.serie), inicio: new Date().toISOString(), fim: null,
    status: "executando", faixasPrevistas: faixas.length, numerosPrevistos: faixas.reduce((a, f) => a + f.fim - f.ini + 1, 0),
    pedidos: 0, homologadas: 0, numerosInutilizados: 0, usadosNaSefaz: [], erros: [], motivoParada: null, quem,
  };
  LOTES.set(id, job);
  loteEmExecucao = id;
  void rodarLote(job, faixas, g.uf, p.justificativa).finally(() => { loteEmExecucao = null; });
  return job;
}

async function rodarLote(job: Lote, faixas: { ini: number; fim: number; ano: number }[], uf: string, just: string) {
  const fila = faixas.slice();
  let falhasSeguidas = 0;
  try {
    while (fila.length) {
      if (job.pararPedido) { job.status = "interrompido"; job.motivoParada = "parado pelo usuário"; break; }
      const f = fila.shift()!;
      job.atual = `${f.ini}–${f.fim}`;
      let r: any;
      try {
        r = await enviarFaixa({ cnpj: job.cnpj, modelo: job.modelo, serie: job.serie, numeroInicial: f.ini, numeroFinal: f.fim, ambiente: "producao", uf, ano: f.ano, justificativa: just }, job.quem, job.id);
      } catch (e: any) {
        r = { http: 500, ok: false, cStat: null, error: e?.message || String(e) };
      }
      job.pedidos++;
      const cs = r.cStat ? String(r.cStat) : "";
      if (r.ok) {
        job.homologadas++; job.numerosInutilizados += f.fim - f.ini + 1; falhasSeguidas = 0;
      } else if (CSTAT_JA_FEITA.has(cs)) {
        job.homologadas++; falhasSeguidas = 0;
      } else if (CSTAT_DIVIDIR.has(cs)) {
        falhasSeguidas = 0;
        if (f.fim > f.ini) {
          const meio = Math.floor((f.ini + f.fim) / 2);
          fila.unshift({ ini: f.ini, fim: meio, ano: f.ano }, { ini: meio + 1, fim: f.fim, ano: f.ano });
        } else {
          job.usadosNaSefaz.push({ ini: f.ini, fim: f.fim, cStat: cs, xMotivo: String(r.xMotivo || "") });
        }
      } else if (CSTAT_ESPERAR.has(cs)) {
        fila.unshift(f); await dormir(65_000);
      } else if (r.http === 409 || r.http === 400) {
        // trava local (número usado/sobreposição) — registra e segue
        job.erros.push({ ini: f.ini, fim: f.fim, cStat: null, msg: String(r.error || "") });
      } else {
        job.erros.push({ ini: f.ini, fim: f.fim, cStat: cs || null, msg: String(r.xMotivo || r.error || "") });
        falhasSeguidas++;
        // Rejeição que não é de faixa (certificado, schema, ambiente...) ou falha de rede
        // repetida: parar para não disparar centenas de pedidos errados.
        if (falhasSeguidas >= 3) { job.status = "interrompido"; job.motivoParada = `3 falhas seguidas — última: ${cs ? `cStat ${cs} ` : ""}${r.xMotivo || r.error || ""}`; break; }
      }
      await dormir(PAUSA_MS);
    }
    if (job.status === "executando") job.status = "concluido";
  } catch (e: any) {
    job.status = "interrompido"; job.motivoParada = e?.message || String(e);
  } finally {
    job.fim = new Date().toISOString(); job.atual = undefined;
    console.log(`[INUTILIZACAO][LOTE ${job.id}] ${job.nome}: ${job.status} — ${job.homologadas} homologadas, ${job.numerosInutilizados} números, ${job.usadosNaSefaz.length} usados na SEFAZ, ${job.erros.length} erros`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ALERTA DIÁRIO (dia útil, 08:10 BRT) — liga/desliga: system_settings
// 'nf_lacunas_alerta' = 'off' desliga (nasce ligado). Destino: telefone_gestor_relatorios.
// ═══════════════════════════════════════════════════════════════════════════
const TZ = "America/Sao_Paulo";
async function setting(key: string): Promise<string> {
  try { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`); return String((r.rows || r)[0]?.value || "").replace(/"/g, "").trim(); } catch { return ""; }
}
function hojeBR() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export async function alertaLacunas(enviar: boolean, opts?: { forcar?: boolean; to?: string }) {
  const hoje = hojeBR();
  const [y, m] = hoje.split("-").map(Number);
  const iniMesAnterior = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const lev = await levantarLacunas({ desde: iniMesAnterior });
  const pend: any = await db.execute(sql`
    SELECT regexp_replace(coalesce(issuer_cnpj,''),'[^0-9]','','g') c, count(*)::int n
    FROM fiscal_invoices WHERE environment = 'producao' AND invoice_number IS NOT NULL
      AND status IN ('draft','rejected') AND created_at > now() - interval '15 days' GROUP BY 1`);
  const pendRows: any[] = pend.rows || pend;
  const linhas: string[] = [];
  let total = 0;
  for (const g of lev.grupos as any[]) {
    const nPend = Number(pendRows.find((x) => x.c === g.cnpj)?.n || 0);
    if (!g.totalNumeros && !nPend && !g.conferir?.length) continue;
    total += g.totalNumeros;
    const sigla = String(g.nome).split(" ")[0];
    const partes = [];
    if (g.totalNumeros) partes.push(`${g.totalNumeros} nº pulado(s) em ${g.totalFaixas} faixa(s)`);
    if (nPend) partes.push(`${nPend} NF rejeitada/rascunho parada (retransmitir em até 15 dias)`);
    if (g.conferir?.length) partes.push(`${g.conferir.length} nº a conferir na SEFAZ`);
    linhas.push(`• ${sigla} mod ${g.modelo}/série ${g.serie}: ${partes.join(" · ")}`);
  }
  if (!linhas.length) return { ok: true, enviado: false, motivo: "sem_lacunas", total };
  const prazo = `10/${String(m).padStart(2, "0")}`;
  const msg = `⚠️ *Numeração de NF-e com saltos* (desde ${iniMesAnterior.split("-").reverse().join("/")}):\n\n${linhas.join("\n")}\n\nPrazo legal para inutilizar os saltos do mês passado: *${prazo}*. Abra Fiscal › Inutilização de NF.`;
  if (!enviar) return { ok: true, enviado: false, previa: true, msg, total };
  if (!opts?.forcar) {
    if ((await setting("nf_lacunas_alerta")) === "off") return { ok: true, enviado: false, motivo: "desligado" };
    if ((await setting("nf_lacunas_alerta_last")) === hoje) return { ok: true, enviado: false, motivo: "ja_enviado_hoje" };
  }
  const so = (s: string) => (s || "").replace(/[^0-9,]/g, "");
  const destinos = opts?.to ? [so(opts.to)] : Array.from(new Set(so(await setting("telefone_gestor_relatorios")).split(",").filter((x) => x.length >= 10)));
  if (!destinos.length) return { ok: true, enviado: false, motivo: "sem_destino", msg };
  let enviados = 0;
  for (const to of destinos) { try { const r = await sendUmblerTalkText(to, msg); if (r.success) enviados++; } catch {} }
  if (enviados && !opts?.forcar) {
    try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('nf_lacunas_alerta_last', ${hoje}, 'cron-nf-lacunas') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); } catch {}
  }
  return { ok: true, enviado: enviados > 0, enviados, destinos, msg };
}

let _alertaAgendado = false;
function agendarAlerta() {
  if (_alertaAgendado) return; _alertaAgendado = true;
  cron.schedule("10 8 * * 1-5", async () => {
    try { const r = await alertaLacunas(true); if (r.enviado) console.log("⚠️ [NF-LACUNAS] alerta enviado."); }
    catch (e: any) { console.error("[NF-LACUNAS] falha no cron:", e?.message || e); }
  }, { timezone: TZ });
  console.log("[NF-LACUNAS] alerta diário agendado (08:10 BRT, dias úteis).");
}
