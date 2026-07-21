// ============================================================================
// INTEGRA 2.0 — Painel de controle dos Disparos 1841 (Utilitys)
// Página própria, servida pelo backend. Wiring já feito no index.ts.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { sendOfficialTemplate } from './official-dispatch';

async function getSetting(key: string, def: string): Promise<string> {
  try { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value; return v == null ? def : String(v).replace(/^"|"$/g, ''); } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'painel')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

const USE_CASES = ['rota_do_dia','pipeline','cobranca','repescagem','sdr'];

// valores de teste + botões de cada template (para o "Enviar teste")
const TEST_DEFAULTS: Record<string, { params: string[]; buttons: string[] }> = {
  visita_rota_dia:     { params: ['Cliente Teste','Celso','Hoje'],                buttons: ['Sim, confirmar','Não'] },
  entrega_programada:  { params: ['Cliente Teste','NF-TESTE','hoje'],             buttons: ['Ok, estarei esperando','Quero fazer um Ajuste'] },
  pedido_confirmado:   { params: ['Cliente Teste','TESTE','R$ 1,00'],             buttons: ['Ok, obrigado.','Tenho uma dúvida..'] },
  cobranca_vencimento: { params: ['Cliente Teste','NF-TESTE','R$ 1,00','hoje'],   buttons: ['Sim, estou ciente','Preciso da Chave Pix','Falar com o Financeiro'] },
  cobranca_vencida:    { params: ['Cliente Teste','NF-TESTE','R$ 1,00','ontem'],  buttons: ['Será pago hoje','Falar com Financeiro','Previsão de Pagamento'] },
};

export function registerOfficialPanel(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/oficial/estado', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const mode = await getSetting('oficial_dispatch_mode', 'off');
    const useCases: any = {};
    for (const uc of USE_CASES) useCases[uc] = await getSetting('oficial_' + uc, 'off');
    const fila: any = (await db.execute(sql`SELECT status, count(*)::int n FROM official_dispatches
      WHERE created_at::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date GROUP BY status`)).rows || [];
    const ultimos: any = (await db.execute(sql`SELECT customer_phone, template_label, status, use_case, error,
      to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS quando
      FROM official_dispatches ORDER BY created_at DESC LIMIT 20`)).rows || [];
    const custo: any = (await db.execute(sql`SELECT coalesce(sum(estimated_cost),0)::float c FROM official_dispatches
      WHERE status IN ('enviada','entregue','lida','resposta')
        AND created_at::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`)).rows?.[0]?.c || 0;
    res.json({ mode, useCases, fila, ultimos, custoHoje: custo });
  });

  app.get('/api/admin/oficial/set', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const key = String(req.query.key || '');
    const value = String(req.query.value || '');
    const allowed = ['oficial_dispatch_mode', ...USE_CASES.map(u => 'oficial_' + u)];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'key invalida' });
    if (key === 'oficial_dispatch_mode' && !['off', 'test', 'on'].includes(value)) return res.status(400).json({ error: 'value invalido' });
    if (key !== 'oficial_dispatch_mode' && !['on', 'off'].includes(value)) return res.status(400).json({ error: 'value invalido' });
    await setSetting(key, value);
    res.json({ ok: true, key, value });
  });

  // ENVIAR TESTE — escolhe número + template e envia direto (não passa pela fila)
  app.get('/api/admin/oficial/enviar-teste', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const to = String(req.query.to || '').replace(/\D/g, '');
    const tpl = String(req.query.tpl || '');
    if (!to) return res.status(400).json({ error: 'informe o numero (só dígitos, ex.: 5562999999999)' });
    const def = TEST_DEFAULTS[tpl];
    if (!def) return res.status(400).json({ error: 'template invalido' });
    const t: any = (await db.execute(sql`SELECT umbler_id FROM whatsapp_templates WHERE label = ${tpl} LIMIT 1`)).rows?.[0];
    if (!t) return res.status(400).json({ error: 'template nao encontrado no banco' });
    const postbackTexts = def.buttons.map((text, index) => ({ index, text }));
    const r = await sendOfficialTemplate(to, t.umbler_id, def.params, { postbackTexts });
    res.json(r);
  });

  app.get('/api/admin/oficial/painel', (req: any, res: any) => {
    if (!guard(req)) return res.status(403).send('Acesso negado. Use ?k=SUA_SENHA');
    res.set('Content-Type', 'text/html; charset=utf-8').send(PAGE_HTML);
  });
}

const PAGE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Disparos 1841 — Painel</title>
<style>
  :root{--bg:#0f1420;--card:#1a2233;--line:#2a3446;--txt:#e6ebf5;--mut:#8b98b0;
        --off:#6b7280;--test:#d9a441;--on:#2fae66;--red:#e0576b;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);
    font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 20px;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
  .row:first-child{border-top:0}
  button{border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;color:#0b0f17;margin-left:6px}
  .b-off{background:var(--off);color:#fff} .b-test{background:var(--test)} .b-on{background:var(--on);color:#fff}
  .b-send{background:#3b82f6;color:#fff;margin:0}
  .dim{opacity:.35;filter:grayscale(.5)}
  input,select{background:#0e1626;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 10px;font-size:14px}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-weight:700;font-size:13px}
  .m-off{background:var(--off);color:#fff}.m-test{background:var(--test);color:#0b0f17}.m-on{background:var(--on);color:#fff}
  .tiles{display:flex;gap:12px;flex-wrap:wrap}
  .tile{background:#111827;border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:110px}
  .tile b{font-size:22px;display:block} .tile span{color:var(--mut);font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--mut);font-weight:600} .st{padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600}
  .s-enviada,.s-entregue,.s-lida,.s-resposta{background:rgba(47,174,102,.18);color:#7ee0a6}
  .s-fila{background:rgba(217,164,65,.18);color:#e8c07a} .s-falha,.s-suprimida{background:rgba(224,87,107,.18);color:#f0a1ae}
  .foot{color:var(--mut);font-size:12px;margin-top:8px}
</style></head><body>
<h1>Disparos 1841 · Painel de controle</h1>
<p class="sub">Honest Sucos · WhatsApp API oficial (HONESTAPI) · atualiza sozinho a cada 10s</p>

<div class="card">
  <div class="row"><div><b>Modo geral</b><br><span class="sub" style="margin:0">off = desligado · test = só números de teste · on = clientes reais</span></div>
    <div>Atual: <span id="modeBadge" class="badge m-off">—</span>
      <span style="margin-left:10px">
        <button class="b-off" onclick="setMode('off')">off</button>
        <button class="b-test" onclick="setMode('test')">test</button>
        <button class="b-on" onclick="setMode('on')">on</button>
      </span></div>
  </div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:8px">Enviar teste (escolha o número)</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input id="testTo" placeholder="Número (ex.: 5562999999999)" style="min-width:230px">
    <select id="testTpl">
      <option value="visita_rota_dia">visita_rota_dia</option>
      <option value="entrega_programada">entrega_programada</option>
      <option value="pedido_confirmado">pedido_confirmado</option>
      <option value="cobranca_vencimento">cobranca_vencimento</option>
      <option value="cobranca_vencida">cobranca_vencida</option>
    </select>
    <button class="b-send" onclick="enviarTeste()">Enviar teste</button>
    <span id="testMsg" class="sub" style="margin:0"></span>
  </div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:6px">Casos de uso (liga/desliga)</div>
  <div id="useCases"></div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:12px">Hoje</div>
  <div class="tiles" id="tiles"></div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:8px">Últimos disparos</div>
  <table><thead><tr><th>Quando</th><th>Telefone</th><th>Template</th><th>Caso</th><th>Status</th><th>Erro</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <div class="foot" id="foot"></div>
</div>

<script>
const K = new URLSearchParams(location.search).get('k') || '';
const q = s => '?k='+encodeURIComponent(K)+s;
const UC_LABEL = {rota_do_dia:'Rota do dia',pipeline:'Pipeline (pedido/entrega)',cobranca:'Cobrança',repescagem:'Repescagem (mkt)',sdr:'SDR (mkt)'};
async function load(){
  try{
    const d = await (await fetch('/api/admin/oficial/estado'+q(''))).json();
    const mb = document.getElementById('modeBadge'); mb.textContent = d.mode; mb.className = 'badge m-'+d.mode;
    document.getElementById('useCases').innerHTML = Object.keys(UC_LABEL).map(uc=>{
      const on = d.useCases[uc]==='on';
      return '<div class="row"><div>'+UC_LABEL[uc]+'</div><div>'+
        '<button class="'+(on?'b-on':'b-off dim')+'" onclick="setUC(\\''+uc+'\\',\\'on\\')">on</button>'+
        '<button class="'+(!on?'b-off':'b-off dim')+'" onclick="setUC(\\''+uc+'\\',\\'off\\')">off</button></div></div>';
    }).join('');
    const byStatus = {}; (d.fila||[]).forEach(x=>byStatus[x.status]=x.n);
    const total = Object.values(byStatus).reduce((a,b)=>a+b,0);
    const tiles = [['Total hoje',total],['Enviadas',(byStatus.enviada||0)+(byStatus.entregue||0)+(byStatus.lida||0)],
      ['Na fila',byStatus.fila||0],['Falhas',byStatus.falha||0],['Custo estimado','R$ '+(d.custoHoje||0).toFixed(2)]];
    document.getElementById('tiles').innerHTML = tiles.map(t=>'<div class="tile"><b>'+t[1]+'</b><span>'+t[0]+'</span></div>').join('');
    document.getElementById('rows').innerHTML = (d.ultimos||[]).map(m=>
      '<tr><td>'+m.quando+'</td><td>'+m.customer_phone+'</td><td>'+(m.template_label||'')+'</td><td>'+(m.use_case||'')+
      '</td><td><span class="st s-'+m.status+'">'+m.status+'</span></td><td style="color:#f0a1ae">'+(m.error||'')+'</td></tr>').join('')
      || '<tr><td colspan="6" style="color:#8b98b0">Nenhum disparo ainda.</td></tr>';
    document.getElementById('foot').textContent = 'Atualizado '+new Date().toLocaleTimeString('pt-BR');
  }catch(e){ document.getElementById('foot').textContent = 'Erro ao carregar: '+e; }
}
async function setMode(v){
  if(v==='on' && !confirm('Ligar em modo ON envia para CLIENTES REAIS. Confirma?')) return;
  await fetch('/api/admin/oficial/set'+q('&key=oficial_dispatch_mode&value='+v)); load();
}
async function setUC(uc,v){ await fetch('/api/admin/oficial/set'+q('&key=oficial_'+uc+'&value='+v)); load(); }
async function enviarTeste(){
  const to = document.getElementById('testTo').value.replace(/\\D/g,'');
  const tpl = document.getElementById('testTpl').value;
  const msg = document.getElementById('testMsg');
  if(!to){ msg.textContent='Informe o número.'; return; }
  msg.textContent = 'Enviando...';
  try{
    const r = await (await fetch('/api/admin/oficial/enviar-teste'+q('&to='+to+'&tpl='+tpl))).json();
    msg.textContent = r.success ? 'Enviado! (chat '+(r.chatId||'')+')' : ('Falhou: '+(r.error||'erro'));
  }catch(e){ msg.textContent = 'Erro: '+e; }
}
load(); setInterval(load, 10000);
</script>
</body></html>`;
