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
    const r = await salvarTemplate({ label: t.label, umblerId: t.id, categoria: t.categoria || 'UTILITY', corpo: t.corpo || undefined });
    (r === 'criado' ? resumo.criados : resumo.atualizados).push(t.label);
  }
  return resumo;
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
