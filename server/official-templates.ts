// ============================================================================
// INTEGRA 2.0 — Cadastro dos templates do 1841 (WhatsApp Business API / Umbler)
// O worker de disparos resolve `whatsapp_templates.label` -> `umbler_id` na hora
// de enviar. Este modulo da uma tela para esse cadastro, sem SQL na mao.
// Wiring: chamado por registerOfficialPanel(app) em ./official-panel.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const UMBLER_TALK_BASE = 'https://app-utalk.umbler.com/api';
function orgId(): string { return process.env.UMBLER_TALK_ORG_ID || 'aZiQMy9bnyeDpiaY'; }
function canalOficial(): string { return process.env.UMBLER_OFFICIAL_CHANNEL_ID || 'ajqNf-Vjp4yjcaJf'; }

// DDL preguicosa: roda na primeira chamada de endpoint, nunca no boot
// (DDL no boot ja derrubou o healthcheck do Railway uma vez).
let _pronta = false;
async function ensureTabela(): Promise<void> {
  if (_pronta) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id serial PRIMARY KEY,
    label varchar(120),
    umbler_id varchar(120),
    created_at timestamptz DEFAULT now()
  )`);
  // Colunas extras: se a tabela ja existia com outro formato, so acrescenta.
  await db.execute(sql`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS categoria varchar(20)`);
  await db.execute(sql`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS corpo text`);
  await db.execute(sql`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS observacao text`);
  await db.execute(sql`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS updated_at timestamptz`);
  await db.execute(sql`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS botoes jsonb`);

  // A tabela nasceu antes deste cadastro e tem colunas legadas NOT NULL sem default
  // (ex.: meta_template_id) que este fluxo nao tem como preencher — a API do Umbler nao
  // devolve id da Meta. Sem soltar o NOT NULL, todo template NOVO falha no INSERT.
  // Nao mexe em id/label/umbler_id, que sao os que o disparo usa de fato.
  try {
    const cols: any = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'whatsapp_templates' AND is_nullable = 'NO' AND column_default IS NULL
        AND column_name NOT IN ('id','label','umbler_id')`);
    for (const c of (cols.rows || [])) {
      const nome = String(c.column_name || '');
      if (!/^[a-z_][a-z0-9_]*$/i.test(nome)) continue;
      await db.execute(sql.raw(`ALTER TABLE whatsapp_templates ALTER COLUMN "${nome}" DROP NOT NULL`));
      console.log('[OFICIAL-TEMPLATES] NOT NULL removido de', nome);
    }
  } catch (e: any) { console.error('[OFICIAL-TEMPLATES] ajuste de colunas legadas:', e?.message); }

  _pronta = true;
}

// Como a tabela e legada, vale enxergar o formato dela pela propria tela.
export async function colunasDaTabela(): Promise<any[]> {
  const r: any = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_name = 'whatsapp_templates' ORDER BY ordinal_position`);
  return r.rows || [];
}

export async function listarTemplates(): Promise<any[]> {
  await ensureTabela();
  const r: any = await db.execute(sql`SELECT label, umbler_id, categoria, corpo, observacao, botoes,
    to_char(updated_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS atualizado
    FROM whatsapp_templates ORDER BY label`);
  return r.rows || [];
}

// Sem ON CONFLICT: a tabela pode nao ter indice unico em label.
export async function salvarTemplate(t: { label: string; umblerId?: string; categoria?: string; corpo?: string; observacao?: string; botoes?: string[] }): Promise<'criado'|'atualizado'> {
  await ensureTabela();
  const bt = t.botoes && t.botoes.length ? JSON.stringify(t.botoes) : null;
  const ex: any = await db.execute(sql`SELECT 1 FROM whatsapp_templates WHERE label = ${t.label} LIMIT 1`);
  if (ex.rows?.length) {
    await db.execute(sql`UPDATE whatsapp_templates SET
      umbler_id = coalesce(${t.umblerId || null}, umbler_id),
      categoria = coalesce(${t.categoria || null}, categoria),
      corpo     = coalesce(${t.corpo || null}, corpo),
      observacao= coalesce(${t.observacao || null}, observacao),
      botoes    = coalesce(${bt}::jsonb, botoes),
      updated_at = now() WHERE label = ${t.label}`);
    return 'atualizado';
  }
  await db.execute(sql`INSERT INTO whatsapp_templates (label, umbler_id, categoria, corpo, observacao, botoes, updated_at)
    VALUES (${t.label}, ${t.umblerId || null}, ${t.categoria || 'UTILITY'}, ${t.corpo || null}, ${t.observacao || null}, ${bt}::jsonb, now())`);
  return 'criado';
}

// Rota confirmada na conta da Honest: GET /v1/templates/?organizationId=..&channelId=..
// Devolve label, category, status (APPROVED/PENDING/REJECTED) e o corpo de cada template.
export async function templatesDoUmbler(): Promise<{ itens: any[]; bruto?: any; erro?: string }> {
  const token = process.env.UMBLER_TALK_TOKEN;
  if (!token) return { itens: [], erro: 'UMBLER_TALK_TOKEN ausente' };
  const url = UMBLER_TALK_BASE + '/v1/templates/?organizationId=' + encodeURIComponent(orgId())
    + '&channelId=' + encodeURIComponent(canalOficial());
  try {
    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const txt = await r.text();
    if (!r.ok) return { itens: [], erro: 'HTTP ' + r.status + ': ' + txt.slice(0, 200) };
    const j: any = JSON.parse(txt);
    const brutos: any[] = j.items || j.Items || (Array.isArray(j) ? j : []);
    const corpoDe = (t: any) => {
      const b = t.body ?? t.Body ?? t.content ?? t.Content;
      if (b == null) return '';
      if (typeof b === 'string') return b;
      return String(b.content ?? b.Content ?? b.text ?? b.Text ?? '');
    };
    const itens = brutos.map((t: any) => ({
      id: t.id ?? t.Id ?? t.templateId ?? t.TemplateId ?? null,
      label: t.label ?? t.Label ?? t.name ?? t.Name ?? '',
      categoria: t.category ?? t.Category ?? null,
      status: t.status ?? t.Status ?? null,
      corpo: corpoDe(t),
      canal: t.channel?.id ?? null,
      botoes: Array.isArray(t.buttons) ? t.buttons.map((b: any) => String(b?.text ?? '')).filter(Boolean) : [],
    }));
    // O primeiro item cru fica junto: se algum campo mudar de nome, da para ver aqui.
    return { itens, bruto: brutos[0] || null };
  } catch (e: any) { return { itens: [], erro: e?.message || String(e) }; }
}

// Traz do Umbler para a tabela local tudo que estiver aprovado.
async function importarDoUmbler(): Promise<any> {
  const { itens, erro } = await templatesDoUmbler();
  if (erro) return { erro };
  const resumo: any = { criados: [], atualizados: [], ignorados: [] };
  for (const t of itens) {
    if (!t.label || !t.id) { resumo.ignorados.push({ label: t.label, motivo: 'sem id ou label' }); continue; }
    if (String(t.status || '').toUpperCase() !== 'APPROVED') { resumo.ignorados.push({ label: t.label, motivo: 'status ' + t.status }); continue; }
    const r = await salvarTemplate({ label: t.label, umblerId: t.id, categoria: t.categoria || 'UTILITY', corpo: t.corpo || undefined, botoes: t.botoes });
    (r === 'criado' ? resumo.criados : resumo.atualizados).push(t.label);
  }
  return resumo;
}

// ---------------------------------------------------------------------------
// Linha de debitos em aberto para a variavel do template de pedido bloqueado.
// Regra IDENTICA a que decide o bloqueio (storage.getOverdueDebtByDocument):
// titulo em aberto, vencido no fuso de Brasilia, fora os historicos do Omie.
// Variavel de template NAO aceita quebra de linha — por isso, uma linha so.
// ---------------------------------------------------------------------------
const TETO_TITULOS = 4;
const PISO_BLOQUEIO = 50;

export async function linhaDebitos(documento: string): Promise<{
  linha: string; total: string; totalNum: number; titulos: any[]; bloqueia: boolean;
}> {
  const doc = String(documento || '').replace(/\D/g, '');
  const vazio = { linha: '', total: 'R$ 0,00', totalNum: 0, titulos: [] as any[], bloqueia: false };
  if (!doc) return vazio;
  const r: any = await db.execute(sql`
    SELECT title_number,
           to_char(due_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS venc,
           (amount - COALESCE(amount_paid, 0))::float AS saldo
    FROM receivables
    WHERE deleted_at IS NULL
      AND (amount - COALESCE(amount_paid, 0)) > 0
      AND COALESCE(import_origin, '') <> 'omie_historico'
      AND status IN ('a_vencer', 'vencida')
      AND (due_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND regexp_replace(COALESCE(customer_document, ''), '[^0-9]', '', 'g') = ${doc}
    ORDER BY due_date`);
  const titulos = r.rows || [];
  if (!titulos.length) return vazio;
  const brl = (n: number) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalNum = titulos.reduce((s: number, t: any) => s + Number(t.saldo || 0), 0);
  // O title_number ja costuma vir rotulado ("NF-104434"). So prefixa quando nao vem.
  const rotulo = (n: any) => {
    const s = String(n || '').trim();
    if (!s) return 'Titulo s/n';
    return /^(nf|nfe|titulo)/i.test(s) ? s : 'NF ' + s;
  };
  const mostra = titulos.slice(0, TETO_TITULOS)
    .map((t: any) => `${rotulo(t.title_number)} venc. ${t.venc} ${brl(t.saldo)}`);
  const sobra = titulos.length - mostra.length;
  if (sobra > 0) mostra.push(`e mais ${sobra} título${sobra > 1 ? 's' : ''}`);
  // Blindagem: a variavel nao pode ter quebra de linha, tab, nem 4+ espacos seguidos.
  const linha = mostra.join(' · ').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return { linha, total: brl(totalNum), totalNum, titulos, bloqueia: totalNum > PISO_BLOQUEIO };
}

// ---------------------------------------------------------------------------
// ENCERRAMENTO PELO BOTAO 1
// O template de aviso ("recebemos seu pedido") tem botoes de resposta rapida. Quando o
// cliente toca no PRIMEIRO ("Ok, obrigado."), ele nao esta abrindo atendimento — esta
// dando o assunto por encerrado. Sem esta regra, a IA recebe um "Ok, obrigado." solto,
// nao sabe do que se trata e responde a saudacao padrao ("Posso ajudar?"), reabrindo
// uma conversa que ja tinha acabado.
//
// NAO e "o primeiro botao encerra": no pedido_confirmado_debito o primeiro botao e
// "Me envie a(s) 2ª via(s)", que precisa da IA e nao de um agradecimento. O que encerra
// e o botao de ACEITE — por isso a regra compara com uma lista de frases de aceite.
//
// So vale quando: (a) houve disparo para este telefone nas ultimas horas, (b) o caso de
// uso esta na lista (default: pipeline — a rota do dia tem fluxo proprio, onde
// "Sim, confirmar" CONFIRMA a visita), (c) o texto bate com algum BOTAO daquele template
// e (d) esse botao esta na lista de aceite. Fora disso, a IA atende normalmente.
//
// Chaves: ia_encerra_botao (on|off) · ia_encerra_casos · ia_encerra_horas ·
//         ia_encerra_texto · ia_encerra_frases
// ---------------------------------------------------------------------------
const ENCERRA_TEXTO_PADRAO = 'Nós que agradecemos! Qualquer coisa, é só chamar por aqui. 🧡';
const ENCERRA_FRASES_PADRAO = 'Ok, obrigado.|Ok, estarei esperando|Sim, estou ciente|Entendi, obrigado|Obrigado';

function normalizarResposta(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')                       // tira pontuacao e emoji
    .replace(/\s+/g, ' ').trim();
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

export async function botaoDeEncerramento(phone: string, texto: string): Promise<string | null> {
  try {
    if ((await getSetting('ia_encerra_botao', 'on')) !== 'on') return null;
    const t = normalizarResposta(texto);
    if (!t || t.length > 60) return null;

    let d = String(phone || '').replace(/\D/g, '');
    if (d && !d.startsWith('55') && (d.length === 10 || d.length === 11)) d = '55' + d;
    if (!d) return null;
    // Compara pelos 8 finais: a base tem numero com e sem o 9o digito.
    const fim = d.slice(-8);

    const horas = Math.max(1, parseInt(await getSetting('ia_encerra_horas', '48'), 10) || 48);
    // Olha os ultimos disparos, nao so o ultimo: o cliente pode receber dois avisos e
    // responder o botao do primeiro. Com LIMIT 1 esse toque viraria conversa nova.
    const disp: any = await db.execute(sql`
      SELECT template_label, use_case FROM official_dispatches
      WHERE right(customer_phone, 8) = ${fim}
        AND status IN ('enviada','entregue','lida','resposta')
        AND sent_at > now() - make_interval(hours => ${horas})
      ORDER BY sent_at DESC LIMIT 5`);
    const recentes = disp.rows || [];
    if (!recentes.length) return null;

    const casos = (await getSetting('ia_encerra_casos', 'pipeline')).split(',').map(s => s.trim()).filter(Boolean);
    const labels = recentes
      .filter((d: any) => casos.includes(String(d.use_case || '')))
      .map((d: any) => String(d.template_label || ''));
    if (!labels.length) return null;

    const tpl: any = await db.execute(sql`SELECT botoes FROM whatsapp_templates WHERE label = ANY(${labels})`);
    const botoes: string[] = (tpl.rows || []).flatMap((r: any) => Array.isArray(r.botoes) ? r.botoes : []);
    // Tem que ser um botao de um daqueles templates — assim um "obrigado" digitado no meio
    // de uma conversa de verdade nunca encerra nada.
    if (!botoes.some(b => normalizarResposta(b) === t)) return null;

    const aceites = (await getSetting('ia_encerra_frases', ENCERRA_FRASES_PADRAO))
      .split('|').map(normalizarResposta).filter(Boolean);
    if (!aceites.includes(t)) return null;

    return (await getSetting('ia_encerra_texto', ENCERRA_TEXTO_PADRAO)).slice(0, 400);
  } catch (e: any) {
    console.error('[ENCERRA-BOTAO]', e?.message || e);
    return null;   // qualquer erro: segue o fluxo normal da IA
  }
}

// Quantas variaveis o corpo do template usa (maior indice de {{n}}).
function qtdVariaveis(corpo: string): number {
  let max = 0;
  for (const m of String(corpo || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, parseInt(m[1], 10) || 0);
  return max;
}

export function registerOfficialTemplates(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/oficial/templates', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const itens = await listarTemplates();
      res.json({ itens, colunas: req.query.colunas ? await colunasDaTabela() : undefined });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/admin/oficial/templates/set', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const label = String(req.query.label || '').trim();
    if (!/^[a-z0-9_]{3,60}$/.test(label)) return res.status(400).json({ error: 'label invalida (use minusculas, numeros e _)' });
    const categoria = String(req.query.categoria || 'UTILITY').toUpperCase();
    if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(categoria)) return res.status(400).json({ error: 'categoria invalida' });
    try {
      const r = await salvarTemplate({
        label,
        umblerId: String(req.query.umbler_id || '').trim() || undefined,
        categoria,
        corpo: String(req.query.corpo || '') || undefined,
        observacao: String(req.query.observacao || '') || undefined,
      });
      res.json({ ok: true, resultado: r, label });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/admin/oficial/templates/remover', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const label = String(req.query.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label obrigatoria' });
    try { await ensureTabela(); await db.execute(sql`DELETE FROM whatsapp_templates WHERE label = ${label}`); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Lista o que existe de fato na conta do Umbler (com status de aprovacao).
  app.get('/api/admin/oficial/templates/umbler', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    res.json(await templatesDoUmbler());
  });

  // Copia os aprovados do Umbler para a tabela local.
  app.get('/api/admin/oficial/templates/importar', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    try { res.json(await importarDoUmbler()); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Previa da linha de debitos com dados reais — so leitura, nao envia nada.
  app.get('/api/admin/oficial/templates/previa-debito', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const doc = String(req.query.doc || '').replace(/\D/g, '');
    if (!doc) return res.status(400).json({ error: 'informe ?doc=<cpf ou cnpj>' });
    try {
      const d = await linhaDebitos(doc);
      res.json({
        documento: doc, ...d,
        aviso: d.titulos.length && !d.bloqueia ? 'abaixo do piso de R$ ' + PISO_BLOQUEIO + ' — nao bloqueia o pedido' : null,
        tamanhoDaVariavel: d.linha.length,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Envio de teste de UM template, so para numero da allowlist de teste.
  app.get('/api/admin/oficial/templates/enviar-teste', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const label = String(req.query.label || '').trim();
    const params = String(req.query.params || '').split('|').map(s => s.trim()).filter(s => s !== '');
    if (!label) return res.status(400).json({ error: 'informe ?label=' });

    // Destino: SEMPRE da allowlist de teste. Sem allowlist, nao envia.
    const permitidos = (process.env.INTEGRA_OFICIAL_TEST_PHONES || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
    if (!permitidos.length) return res.status(400).json({ error: 'INTEGRA_OFICIAL_TEST_PHONES vazia — teste bloqueado' });
    const pedido = String(req.query.to || '').replace(/\D/g, '');
    const to = pedido || permitidos[0];
    if (!permitidos.includes(to)) return res.status(400).json({ error: 'numero fora da allowlist de teste', permitidos: permitidos.map(p => p.slice(0, 4) + '****' + p.slice(-4)) });

    try {
      await ensureTabela();
      const t: any = await db.execute(sql`SELECT umbler_id, corpo FROM whatsapp_templates WHERE label = ${label} LIMIT 1`);
      const row = t.rows?.[0];
      if (!row?.umbler_id) return res.status(400).json({ error: 'template sem umbler_id cadastrado' });

      // Confere a contagem ANTES de gastar: parametro a menos/a mais volta erro 132000 do Meta.
      const esperado = qtdVariaveis(row.corpo || '');
      if (esperado && params.length !== esperado) {
        return res.status(400).json({ error: `este template usa ${esperado} variavel(is) e voce mandou ${params.length}`, corpo: row.corpo });
      }
      const ruim = params.find(p => /[\r\n\t]/.test(p) || / {4,}/.test(p));
      if (ruim) return res.status(400).json({ error: 'parametro com quebra de linha, tab ou 4+ espacos — o Meta recusa', parametro: ruim });

      const { sendOfficialTemplate } = await import('./official-dispatch');
      const r = await sendOfficialTemplate(to, row.umbler_id, params);

      // Registra na fila como disparo de teste. Sem isso, a resposta do cliente ao
      // botao nao encontra o disparo de origem e a regra de encerramento nao vale
      // para o teste — o comportamento testado nao seria o de producao.
      if (r.success) {
        const caso = String(req.query.use_case || 'pipeline');
        // customer_id opcional: com ele, o teste reproduz o vinculo que a producao tem —
        // e so assim da para testar consultar_pedido / segunda_via, que identificam o
        // cliente pelo disparo quando o telefone (de teste) nao esta no cadastro.
        const cliente = String(req.query.customer_id || '').trim() || null;
        try {
          await db.execute(sql`INSERT INTO official_dispatches
            (customer_id, customer_phone, template_label, category, use_case, params, campaign, estimated_cost, status, mode, sent_at)
            VALUES (${cliente}, ${to}, ${label}, 'UTILITY', ${caso}::dispatch_use_case, ${JSON.stringify(params)}::jsonb,
              'teste-manual', 0.04, 'enviada'::dispatch_status, 'test', now())`);
        } catch (e: any) { console.warn('[TEMPLATES] teste nao registrado na fila:', e?.message); }
      }
      res.json({ ...r, to: to.slice(0, 4) + '****' + to.slice(-4), label, params });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/admin/oficial/templates/painel', (req: any, res: any) => {
    if (!guard(req)) return res.status(403).send('Acesso negado. Use ?k=SUA_SENHA');
    res.set('Content-Type', 'text/html; charset=utf-8').send(PAGE_HTML);
  });

  console.log('[OFICIAL-TEMPLATES] registrado (/api/admin/oficial/templates/painel)');
}

const PAGE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Templates 1841 — Cadastro</title>
<style>
  :root{--bg:#0f1420;--card:#1a2233;--line:#2a3446;--txt:#e6ebf5;--mut:#8b98b0;--on:#2fae66;--red:#e0576b;--amb:#d9a441;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);
    font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 20px;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
  label{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px}
  input,textarea,select{width:100%;background:#111827;border:1px solid var(--line);border-radius:8px;
    color:var(--txt);padding:9px 11px;font:14px system-ui;font-family:inherit}
  textarea{min-height:96px;resize:vertical}
  button{border:0;border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer;background:var(--on);color:#fff}
  button.sec{background:#334155} button.del{background:var(--red)}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:600}
  code{background:#111827;padding:1px 6px;border-radius:5px;font-size:12px}
  .falta{color:#f0a1ae;font-weight:600} .ok{color:#7ee0a6;font-weight:600}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .aviso{background:rgba(217,164,65,.12);border:1px solid var(--amb);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
</style></head><body>
<h1>Templates do 1841 · cadastro</h1>
<p class="sub">O disparo procura o template pelo <b>label</b> e envia usando o <b>ID do Umbler</b>. Sem o ID preenchido, o disparo falha com "template nao encontrado".</p>

<div class="card">
  <div class="aviso">O texto do template <b>nao</b> e criado aqui — ele e criado e aprovado no painel do Umbler
  (Configuracoes ➝ Templates do WhatsApp Business API). Esta tela so guarda o vinculo entre o nome que o
  codigo usa e o ID que o Umbler devolveu, mais uma copia do texto para consulta.</div>
  <div class="grid">
    <div>
      <label>Label (o nome usado no codigo)</label>
      <input id="label" placeholder="pedido_confirmado">
      <label>ID do template no Umbler</label>
      <input id="umbler_id" placeholder="alrAa2wGrlHC-83p">
      <label>Categoria</label>
      <select id="categoria"><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select>
    </div>
    <div>
      <label>Corpo (copia do texto aprovado, so para consulta)</label>
      <textarea id="corpo" placeholder="Ola {{1}}, seu pedido ..."></textarea>
      <label>Observacao</label>
      <input id="observacao" placeholder="quando dispara, o que vai em cada variavel">
    </div>
  </div>
  <div style="margin-top:14px"><button onclick="salvar()">Salvar</button>
    <button class="sec" onclick="limpar()">Limpar</button>
    <span id="msg" style="margin-left:12px;font-size:13px"></span></div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:6px">Cadastrados</div>
  <table><thead><tr><th>Label</th><th>ID Umbler</th><th>Cat.</th><th>Corpo</th><th>Atualizado</th><th></th></tr></thead>
  <tbody id="rows"></tbody></table>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:6px">Enviar teste</div>
  <p class="sub" style="margin:0 0 8px">Manda <b>um</b> template para o numero de teste, com os valores que voce digitar.
  Confere a quantidade de variaveis antes de gastar o envio. So aceita numero da allowlist de teste.</p>
  <div class="grid">
    <div>
      <label>Label</label><input id="tLabel" placeholder="pedido_confirmado">
      <label>Numero (em branco = primeiro da allowlist)</label><input id="tTo" placeholder="5562999883656">
    </div>
    <div>
      <label>Valores, separados por | (na ordem das variaveis)</label>
      <input id="tParams" placeholder="Padaria Estrela|INT-4a2b9c1d|R$ 1.240,00">
      <label>&nbsp;</label>
      <button onclick="enviarTeste()">Enviar teste</button>
    </div>
  </div>
  <pre id="tOut" style="white-space:pre-wrap;font-size:12px;color:#8b98b0;margin-top:10px"></pre>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:6px">Previa da linha de debitos</div>
  <p class="sub" style="margin:0 0 8px">Monta a variavel do template de pedido bloqueado com os titulos reais do cliente. So leitura — nao envia nada.</p>
  <div style="display:flex;gap:10px;align-items:center">
    <input id="dDoc" placeholder="CPF ou CNPJ do cliente" style="max-width:280px">
    <button class="sec" onclick="previaDebito()">Ver</button>
  </div>
  <pre id="dOut" style="white-space:pre-wrap;font-size:12px;color:#8b98b0;margin-top:10px"></pre>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:6px">O que existe na conta do Umbler</div>
  <p class="sub" style="margin:0 0 8px">Lista direto da API do Umbler, com o status de aprovacao de cada um. <b>Importar</b> copia os aprovados para a tabela acima.</p>
  <button class="sec" onclick="verUmbler()">Listar</button>
  <button onclick="importar()">Importar aprovados</button>
  <span id="msg2" style="margin-left:12px;font-size:13px"></span>
  <div id="umbler"></div>
</div>

<script>
const K = new URLSearchParams(location.search).get('k') || '';
const q = s => '?k='+encodeURIComponent(K)+s;
const ESPERADOS = ['visita_rota_dia','pedido_confirmado','pedido_saiu_entrega','pedido_entregue','entrega_nao_realizada'];
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function load(){
  const r = await fetch('/api/admin/oficial/templates'+q(''));
  const d = await r.json();
  const itens = d.itens || [];
  const mapa = {}; itens.forEach(i=>mapa[i.label]=i);
  const linhas = ESPERADOS.map(l => mapa[l] || {label:l, faltando:true})
    .concat(itens.filter(i=>ESPERADOS.indexOf(i.label)<0));
  document.getElementById('rows').innerHTML = linhas.map(i =>
    '<tr><td><b>'+esc(i.label)+'</b></td>'+
    '<td>'+(i.umbler_id ? '<code>'+esc(i.umbler_id)+'</code>' : '<span class="falta">falta cadastrar</span>')+'</td>'+
    '<td>'+esc(i.categoria||'')+'</td>'+
    '<td style="max-width:340px;color:#8b98b0">'+esc((i.corpo||'').slice(0,160))+'</td>'+
    '<td>'+esc(i.atualizado||'')+'</td>'+
    '<td><button class="sec" onclick="editar(\\''+i.label+'\\')">editar</button></td></tr>').join('');
  window._itens = mapa;
}
function editar(l){
  const i = (window._itens||{})[l] || {label:l};
  document.getElementById('label').value = i.label||l;
  document.getElementById('umbler_id').value = i.umbler_id||'';
  document.getElementById('categoria').value = i.categoria||'UTILITY';
  document.getElementById('corpo').value = i.corpo||'';
  document.getElementById('observacao').value = i.observacao||'';
  window.scrollTo({top:0,behavior:'smooth'});
}
function limpar(){ ['label','umbler_id','corpo','observacao'].forEach(id=>document.getElementById(id).value=''); }
async function salvar(){
  const p = new URLSearchParams();
  p.set('label', document.getElementById('label').value.trim());
  p.set('umbler_id', document.getElementById('umbler_id').value.trim());
  p.set('categoria', document.getElementById('categoria').value);
  p.set('corpo', document.getElementById('corpo').value);
  p.set('observacao', document.getElementById('observacao').value);
  const r = await fetch('/api/admin/oficial/templates/set'+q('&'+p.toString()));
  const d = await r.json();
  document.getElementById('msg').innerHTML = d.ok
    ? '<span class="ok">salvo ('+d.resultado+')</span>'
    : '<span class="falta">'+esc(d.error||'erro')+'</span>';
  load();
}
async function enviarTeste(){
  const p = new URLSearchParams();
  p.set('label', document.getElementById('tLabel').value.trim());
  p.set('params', document.getElementById('tParams').value);
  const to = document.getElementById('tTo').value.trim(); if(to) p.set('to', to);
  if(!confirm('Isso envia uma mensagem de verdade para o numero de teste. Confirma?')) return;
  document.getElementById('tOut').textContent = 'enviando...';
  const r = await fetch('/api/admin/oficial/templates/enviar-teste'+q('&'+p.toString()));
  document.getElementById('tOut').textContent = JSON.stringify(await r.json(), null, 2);
}
async function previaDebito(){
  const doc = document.getElementById('dDoc').value.replace(/\\D/g,'');
  if(!doc){ document.getElementById('dOut').textContent = 'informe o documento'; return; }
  document.getElementById('dOut').textContent = 'consultando...';
  const r = await fetch('/api/admin/oficial/templates/previa-debito'+q('&doc='+doc));
  const d = await r.json();
  document.getElementById('dOut').textContent = d.error ? d.error :
    ('variavel da lista:\\n' + (d.linha || '(sem titulos vencidos)') +
     '\\n\\ntotal: ' + d.total + '   titulos: ' + (d.titulos||[]).length +
     '   caracteres: ' + d.tamanhoDaVariavel +
     '\\nbloqueia o pedido: ' + (d.bloqueia ? 'sim' : 'nao') + (d.aviso ? '  (' + d.aviso + ')' : ''));
}
async function verUmbler(){
  document.getElementById('umbler').innerHTML = '<p class="sub">consultando...</p>';
  const r = await fetch('/api/admin/oficial/templates/umbler'+q(''));
  const d = await r.json();
  if(d.erro){ document.getElementById('umbler').innerHTML = '<p class="falta">'+esc(d.erro)+'</p>'; return; }
  document.getElementById('umbler').innerHTML =
    '<table><thead><tr><th>Label</th><th>ID</th><th>Cat.</th><th>Status</th><th>Corpo</th></tr></thead><tbody>'+
    (d.itens||[]).map(t=>'<tr><td><b>'+esc(t.label)+'</b></td><td><code>'+esc(t.id)+'</code></td>'+
      '<td>'+esc(t.categoria)+'</td><td class="'+(String(t.status).toUpperCase()==='APPROVED'?'ok':'falta')+'">'+esc(t.status)+'</td>'+
      '<td style="max-width:420px;color:#8b98b0">'+esc(t.corpo).slice(0,300)+'</td></tr>').join('')+
    '</tbody></table>';
}
async function importar(){
  document.getElementById('msg2').textContent = 'importando...';
  const r = await fetch('/api/admin/oficial/templates/importar'+q(''));
  const d = await r.json();
  document.getElementById('msg2').innerHTML = d.erro ? '<span class="falta">'+esc(d.erro)+'</span>'
    : '<span class="ok">criados: '+(d.criados||[]).length+' · atualizados: '+(d.atualizados||[]).length+' · ignorados: '+(d.ignorados||[]).length+'</span>';
  load(); verUmbler();
}
load();
</script>
</body></html>`;
