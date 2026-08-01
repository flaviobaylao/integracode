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
  _pronta = true;
}

export async function listarTemplates(): Promise<any[]> {
  await ensureTabela();
  const r: any = await db.execute(sql`SELECT label, umbler_id, categoria, corpo, observacao,
    to_char(updated_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS atualizado
    FROM whatsapp_templates ORDER BY label`);
  return r.rows || [];
}

// Sem ON CONFLICT: a tabela pode nao ter indice unico em label.
export async function salvarTemplate(t: { label: string; umblerId?: string; categoria?: string; corpo?: string; observacao?: string }): Promise<'criado'|'atualizado'> {
  await ensureTabela();
  const ex: any = await db.execute(sql`SELECT 1 FROM whatsapp_templates WHERE label = ${t.label} LIMIT 1`);
  if (ex.rows?.length) {
    await db.execute(sql`UPDATE whatsapp_templates SET
      umbler_id = coalesce(${t.umblerId || null}, umbler_id),
      categoria = coalesce(${t.categoria || null}, categoria),
      corpo     = coalesce(${t.corpo || null}, corpo),
      observacao= coalesce(${t.observacao || null}, observacao),
      updated_at = now() WHERE label = ${t.label}`);
    return 'atualizado';
  }
  await db.execute(sql`INSERT INTO whatsapp_templates (label, umbler_id, categoria, corpo, observacao, updated_at)
    VALUES (${t.label}, ${t.umblerId || null}, ${t.categoria || 'UTILITY'}, ${t.corpo || null}, ${t.observacao || null}, now())`);
  return 'criado';
}

// A doc publica do Talk nao documenta rota de listagem de templates.
// Em vez de chutar uma so, tenta as candidatas e devolve o que respondeu.
async function sondarUmbler(): Promise<any[]> {
  const token = process.env.UMBLER_TALK_TOKEN;
  if (!token) return [{ erro: 'UMBLER_TALK_TOKEN ausente' }];
  const org = encodeURIComponent(orgId());
  const caminhos = [
    '/v1/templates/?organizationId=' + org,
    '/v1/templates/?organizationId=' + org + '&channelId=' + encodeURIComponent(canalOficial()),
    '/v1/template-messages/?organizationId=' + org,
    '/v1/channels/' + encodeURIComponent(canalOficial()) + '/templates/?organizationId=' + org,
    '/v1/organizations/' + org + '/templates/',
  ];
  const out: any[] = [];
  for (const p of caminhos) {
    try {
      const r = await fetch(UMBLER_TALK_BASE + p, {
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const txt = await r.text();
      out.push({ caminho: p, http: r.status, amostra: txt.slice(0, 400) });
    } catch (e: any) { out.push({ caminho: p, erro: e?.message || String(e) }); }
  }
  return out;
}

export function registerOfficialTemplates(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/oficial/templates', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    try { res.json({ itens: await listarTemplates() }); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
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

  // Descobre qual rota do Umbler lista os templates aprovados nesta conta.
  app.get('/api/admin/oficial/templates/umbler', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    res.json({ tentativas: await sondarUmbler() });
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
  <div style="font-weight:700;margin-bottom:6px">Sonda da API do Umbler</div>
  <p class="sub" style="margin:0 0 8px">Descobre se existe rota de listagem de templates nesta conta. Util para conferir o ID sem abrir o painel do Umbler.</p>
  <button class="sec" onclick="sondar()">Sondar</button>
  <pre id="sonda" style="white-space:pre-wrap;font-size:12px;color:#8b98b0;margin-top:10px"></pre>
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
async function sondar(){
  document.getElementById('sonda').textContent = 'consultando...';
  const r = await fetch('/api/admin/oficial/templates/umbler'+q(''));
  const d = await r.json();
  document.getElementById('sonda').textContent = (d.tentativas||[]).map(t =>
    (t.caminho||'') + '  ->  ' + (t.http!=null ? 'HTTP '+t.http : 'ERRO '+(t.erro||'')) + '\\n' + (t.amostra||'')
  ).join('\\n\\n');
}
load();
</script>
</body></html>`;
