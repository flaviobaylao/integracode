// ============================================================================
// INTEGRA 2.0 — IA de Atendimento · Painel de regras (Fase 1: config + UI)
// Self-contained. Wiring em server/index.ts:
//   import { registerIaAtendimento } from "./ia-atendimento-panel";
//   registerIaAtendimento(app);
// Painel: /api/admin/ia-atendimento/painel   (protegido por OFICIAL_ADMIN_KEY se setada)
// As Fases 2/3 (jobs de timeout e finalização) leem estas mesmas chaves do system_settings.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

async function getSetting(key: string, def: string): Promise<string> {
  try { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value; return v == null ? def : String(v).replace(/^"|"$/g, ''); } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'ia-painel')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

// Chaves e defaults
const KEYS: Record<string, string> = {
  agents_runtime_mode: 'off',              // WhatsApp: off | test | on
  agents_ig_mode: 'off',                   // Instagram: off | test | on
  ia_regra_responder_novas: 'on',          // #1 responder conversas iniciadas pelo cliente (quando NAO ha humano)
  ia_regra_timeout_on: 'off',              // #2 assumir apos X min sem resposta humana
  ia_timeout_min: '10',                    // minutos do #2
  ia_regra_finalizar_on: 'off',            // #3 finalizar conversas inativas
  ia_finalizar_min: '120',                 // minutos de inatividade do #3
  ia_despedida: 'Foi um prazer falar com voce! Qualquer coisa e so chamar aqui. 🧡',
  ia_canal_2630: 'on',                     // liga/desliga a acao da IA no numero 2630 (atendimento)
  ia_canal_1841: 'on',                     // liga/desliga a acao da IA no numero 1841 (HONESTAPI)
};
const MODES = ['agents_runtime_mode', 'agents_ig_mode'];
const TOGGLES = ['ia_regra_responder_novas', 'ia_regra_timeout_on', 'ia_regra_finalizar_on', 'ia_canal_2630', 'ia_canal_1841'];
const NUMS = ['ia_timeout_min', 'ia_finalizar_min'];

export function registerIaAtendimento(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/ia-atendimento/estado', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const out: any = {};
    for (const k of Object.keys(KEYS)) out[k] = await getSetting(k, KEYS[k]);
    res.json(out);
  });

  app.get('/api/admin/ia-atendimento/set', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const key = String(req.query.key || '');
    let value = String(req.query.value ?? '');
    if (!(key in KEYS)) return res.status(400).json({ error: 'key invalida' });
    if (MODES.includes(key) && !['off', 'test', 'on'].includes(value)) return res.status(400).json({ error: 'value invalido' });
    if (TOGGLES.includes(key) && !['on', 'off'].includes(value)) return res.status(400).json({ error: 'value invalido' });
    if (NUMS.includes(key)) { const n = parseInt(value, 10); if (!(n >= 1 && n <= 100000)) return res.status(400).json({ error: 'minutos invalidos' }); value = String(n); }
    if (key === 'ia_despedida') value = value.slice(0, 500);
    await setSetting(key, value);
    res.json({ ok: true, key, value });
  });

  app.get('/api/admin/ia-atendimento/painel', (req: any, res: any) => {
    if (!guard(req)) return res.status(403).send('Acesso negado. Use ?k=SUA_SENHA');
    res.set('Content-Type', 'text/html; charset=utf-8').send(PAGE_HTML);
  });
}

const PAGE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IA de Atendimento — Regras</title>
<style>
  :root{--bg:#0f1420;--card:#1a2233;--line:#2a3446;--txt:#e6ebf5;--mut:#8b98b0;
        --off:#6b7280;--test:#d9a441;--on:#2fae66;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);
    font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 18px;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
  .ttl{font-weight:700;margin-bottom:6px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
  .row:first-child{border-top:0}
  .desc{color:var(--mut);font-size:12px;max-width:60%}
  button{border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;color:#0b0f17;margin-left:6px}
  .b-off{background:var(--off);color:#fff}.b-test{background:var(--test)}.b-on{background:var(--on);color:#fff}
  .dim{opacity:.35;filter:grayscale(.5)}
  input,textarea{background:#0e1626;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 10px;font-size:14px}
  input[type=number]{width:80px}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-weight:700;font-size:12px}
  .m-off{background:var(--off);color:#fff}.m-test{background:var(--test);color:#0b0f17}.m-on{background:var(--on);color:#fff}
  .foot{color:var(--mut);font-size:12px;margin-top:8px}
</style></head><body>
<h1>IA de Atendimento · Regras</h1>
<p class="sub">Honest Sucos · liga/desliga a IA por canal e configura as regras de atuação · salva na hora</p>

<div class="card">
  <div class="ttl">Canais de ação da IA</div>
  <div class="row"><div>WhatsApp <span class="desc">(atendimento 2630 + respostas do 1841)</span></div>
    <div>Atual: <span id="b_agents_runtime_mode" class="badge m-off">—</span>
      <span style="margin-left:8px">
        <button class="b-off" onclick="setMode('agents_runtime_mode','off')">off</button>
        <button class="b-test" onclick="setMode('agents_runtime_mode','test')">test</button>
        <button class="b-on" onclick="setMode('agents_runtime_mode','on')">on</button>
      </span></div></div>
  <div class="row"><div>Instagram</div>
    <div>Atual: <span id="b_agents_ig_mode" class="badge m-off">—</span>
      <span style="margin-left:8px">
        <button class="b-off" onclick="setMode('agents_ig_mode','off')">off</button>
        <button class="b-test" onclick="setMode('agents_ig_mode','test')">test</button>
        <button class="b-on" onclick="setMode('agents_ig_mode','on')">on</button>
      </span></div></div>
  <div class="row"><div>Número 2630 <span class="desc">(atendimento — HONEST2)</span></div>
    <div id="t_ia_canal_2630"></div></div>
  <div class="row"><div>Número 1841 <span class="desc">(HONESTAPI oficial — respostas a disparos)</span></div>
    <div id="t_ia_canal_1841"></div></div>
</div>

<div class="card">
  <div class="ttl">Regras de atuação (WhatsApp)</div>

  <div class="row"><div>Responder conversas iniciadas pelo cliente
      <div class="desc">A IA responde quando o cliente inicia e não há um humano no atendimento.</div></div>
    <div id="t_ia_regra_responder_novas"></div></div>

  <div class="row"><div>Assumir após X min sem resposta humana
      <div class="desc">Se um vendedor/telemarketing ficar sem responder uma pergunta do cliente por X minutos, a IA assume a conversa.</div></div>
    <div style="display:flex;align-items:center;gap:8px">
      <input type="number" id="n_ia_timeout_min" min="1" onchange="setNum('ia_timeout_min', this.value)"> min
      <span id="t_ia_regra_timeout_on"></span></div></div>

  <div class="row"><div>Finalizar conversas inativas
      <div class="desc">Após X min sem novas mensagens, a IA envia a despedida e encerra a conversa.</div></div>
    <div style="display:flex;align-items:center;gap:8px">
      <input type="number" id="n_ia_finalizar_min" min="1" onchange="setNum('ia_finalizar_min', this.value)"> min
      <span id="t_ia_regra_finalizar_on"></span></div></div>

  <div style="padding-top:12px;border-top:1px solid var(--line);margin-top:6px">
    <div style="margin-bottom:6px">Mensagem de despedida</div>
    <textarea id="txt_ia_despedida" rows="2" style="width:100%"></textarea>
    <button class="b-on" style="margin:8px 0 0" onclick="salvarDespedida()">Salvar despedida</button>
    <span id="despMsg" class="sub" style="margin-left:8px"></span>
  </div>
</div>
<div class="foot" id="foot"></div>

<script>
const K = new URLSearchParams(location.search).get('k') || '';
const q = s => '?k='+encodeURIComponent(K)+s;
function tglHtml(key,on){ return '<button class="'+(on?'b-on':'b-off dim')+'" onclick="setTgl(\\''+key+'\\',\\'on\\')">on</button>'+
  '<button class="'+(!on?'b-off':'b-off dim')+'" onclick="setTgl(\\''+key+'\\',\\'off\\')">off</button>'; }
async function load(){
  try{
    const d = await (await fetch('/api/admin/ia-atendimento/estado'+q(''))).json();
    for(const m of ['agents_runtime_mode','agents_ig_mode']){ const b=document.getElementById('b_'+m); b.textContent=d[m]; b.className='badge m-'+d[m]; }
    for(const t of ['ia_regra_responder_novas','ia_regra_timeout_on','ia_regra_finalizar_on','ia_canal_2630','ia_canal_1841']) document.getElementById('t_'+t).innerHTML=tglHtml(t, d[t]==='on');
    document.getElementById('n_ia_timeout_min').value=d.ia_timeout_min;
    document.getElementById('n_ia_finalizar_min').value=d.ia_finalizar_min;
    const ta=document.getElementById('txt_ia_despedida'); if(document.activeElement!==ta) ta.value=d.ia_despedida;
    document.getElementById('foot').textContent='Atualizado '+new Date().toLocaleTimeString('pt-BR');
  }catch(e){ document.getElementById('foot').textContent='Erro: '+e; }
}
async function setMode(key,v){ if(v==='on' && !confirm('Ligar em ON faz a IA responder CLIENTES REAIS neste canal. Confirma?')) return; await fetch('/api/admin/ia-atendimento/set'+q('&key='+key+'&value='+v)); load(); }
async function setTgl(key,v){ await fetch('/api/admin/ia-atendimento/set'+q('&key='+key+'&value='+v)); load(); }
async function setNum(key,v){ await fetch('/api/admin/ia-atendimento/set'+q('&key='+key+'&value='+encodeURIComponent(v))); load(); }
async function salvarDespedida(){ const t=document.getElementById('txt_ia_despedida').value; const m=document.getElementById('despMsg'); m.textContent='Salvando...';
  try{ const r=await(await fetch('/api/admin/ia-atendimento/set'+q('&key=ia_despedida&value='+encodeURIComponent(t)))).json(); m.textContent=r.ok?'✓ salvo':('erro: '+(r.error||'')); }catch(e){ m.textContent='erro: '+e; } }
load(); setInterval(load, 15000);
</script>
</body></html>`;
