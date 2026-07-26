// ============================================================================
// INTEGRA 2.0 — Gestão de Canais de Atendimento
// Painel único para gerenciar os números do ChatCenter. Por canal:
//   - Papel (principal / oficial / reserva) — informativo
//   - Canal ligado/desligado (o número inteiro)
//   - IA ligada/desligada naquele canal
//   - Horário de atividade (dias + início/fim, fuso de Brasília)
//   - Mensagem de fora do horário (aviso automático enviado ao cliente)
// Fora do horário: o canal envia o aviso automático (1x, com throttle) e a IA não age.
//
// Self-contained. Wiring em server/index.ts:
//   import { registerCanaisGestao } from "./canais-gestao";
//   registerCanaisGestao(app);
// Painel: /api/admin/canais/painel   (protegido por OFICIAL_ADMIN_KEY se setada)
//
// Enforcement exportado (usado pelo ia-takeover.ts):
//   avaliarCanal(conversationId) -> { canal, ativo, iaAtiva, dentroHorario, foraMsg }
//   registrarForaMsgEnviado / podeEnviarForaMsg  -> throttle do aviso automático
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'canais-gestao')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

// Canais gerenciados (papel fixo).
const CANAIS = [
  { n: '2630', nome: 'HONEST 2630', papel: 'principal', phone: '5562992682630' },
  { n: '1841', nome: 'HONESTAPI 1841', papel: 'oficial', phone: '5562994981841' },
  { n: '7169', nome: 'HONEST 7169', papel: 'reserva', phone: '5562993227169' },
];
const NUMS = CANAIS.map(c => c.n);

function ks(n: string) {
  return {
    ativo: 'canal_' + n + '_ativo',
    ia: 'ia_canal_' + n,
    dias: 'canal_' + n + '_dias',
    inicio: 'canal_' + n + '_inicio',
    fim: 'canal_' + n + '_fim',
    foraMsg: 'canal_' + n + '_fora_msg',
  };
}
const DEF = {
  ativo: 'on', ia: 'on', dias: '1,2,3,4,5,6', inicio: '08:00', fim: '18:30',
  foraMsg: 'Ola! No momento estamos fora do horario de atendimento. Retornaremos assim que possivel, no proximo horario comercial. 🕐',
};

// Resolve o canal (n) de uma conversa: oficial_1841 -> 1841; channel_phone 7169 -> 7169; senao -> 2630.
async function canalDaConversa(conversationId: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT last_inbound_channel, channel_phone FROM chat_conversations WHERE id = ${conversationId} LIMIT 1`);
    const row = r.rows?.[0];
    if (row?.last_inbound_channel === 'oficial_1841') return '1841';
    const ph = String(row?.channel_phone || '').replace(/\D/g, '');
    if (ph.endsWith('993227169')) return '7169';
    return '2630';
  } catch { return '2630'; }
}

// Dentro do horário de atividade? (fuso de Brasília)
function dentroHorario(dias: string, inicio: string, fim: string, now = new Date()): boolean {
  const br = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dow = br.getDay(); // 0=domingo
  const diasArr = String(dias).split(',').map(s => parseInt(s.trim(), 10)).filter(x => !isNaN(x));
  if (diasArr.length && !diasArr.includes(dow)) return false;
  const [hi, mi] = String(inicio).split(':').map(x => parseInt(x, 10));
  const [hf, mf] = String(fim).split(':').map(x => parseInt(x, 10));
  const mins = br.getHours() * 60 + br.getMinutes();
  const ini = (isNaN(hi) ? 0 : hi) * 60 + (isNaN(mi) ? 0 : mi);
  const f = (isNaN(hf) ? 23 : hf) * 60 + (isNaN(mf) ? 59 : mf);
  return mins >= ini && mins < f;
}

// Avaliação de um canal para o runtime da IA.
export async function avaliarCanal(conversationId: string): Promise<{ canal: string; ativo: boolean; iaAtiva: boolean; dentroHorario: boolean; foraMsg: string }> {
  const n = await canalDaConversa(conversationId);
  const k = ks(n);
  const ativo = (await getSetting(k.ativo, DEF.ativo)) !== 'off';
  const iaAtiva = (await getSetting(k.ia, DEF.ia)) !== 'off';
  const dh = dentroHorario(await getSetting(k.dias, DEF.dias), await getSetting(k.inicio, DEF.inicio), await getSetting(k.fim, DEF.fim));
  const foraMsg = await getSetting(k.foraMsg, DEF.foraMsg);
  return { canal: n, ativo, iaAtiva, dentroHorario: dh, foraMsg };
}

// Canal (por telefone de saída) está ligado? (para bloquear envio quando o canal está off)
export async function canalAtivoPorTelefone(phone: string): Promise<boolean> {
  const ph = String(phone || '').replace(/\D/g, '');
  let n = '2630';
  if (ph.endsWith('994981841')) n = '1841'; else if (ph.endsWith('993227169')) n = '7169';
  return (await getSetting('canal_' + n + '_ativo', 'on')) !== 'off';
}

// Throttle do aviso de fora do horário: no máximo 1 a cada 4h por conversa.
export async function podeEnviarForaMsg(conversationId: string): Promise<boolean> {
  const ts = await getSetting('canal_fora_ts:' + conversationId, '0');
  const last = parseInt(ts, 10) || 0;
  return (Date.now() - last) > 4 * 3600 * 1000;
}
export async function registrarForaMsgEnviado(conversationId: string): Promise<void> {
  try { await setSetting('canal_fora_ts:' + conversationId, String(Date.now())); } catch {}
}

export function registerCanaisGestao(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/canais/estado', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const out: any = {};
    for (const c of CANAIS) {
      const k = ks(c.n);
      out[c.n] = {
        nome: c.nome, papel: c.papel, phone: c.phone,
        ativo: await getSetting(k.ativo, DEF.ativo),
        ia: await getSetting(k.ia, DEF.ia),
        dias: await getSetting(k.dias, DEF.dias),
        inicio: await getSetting(k.inicio, DEF.inicio),
        fim: await getSetting(k.fim, DEF.fim),
        foraMsg: await getSetting(k.foraMsg, DEF.foraMsg),
      };
    }
    res.json({ canais: out });
  });

  app.get('/api/admin/canais/set', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const n = String(req.query.n || '');
    const campo = String(req.query.campo || '');
    let value = String(req.query.value ?? '');
    if (!NUMS.includes(n)) return res.status(400).json({ error: 'canal invalido' });
    const k: any = ks(n);
    if (!(campo in k)) return res.status(400).json({ error: 'campo invalido' });
    if ((campo === 'ativo' || campo === 'ia') && !['on', 'off'].includes(value)) return res.status(400).json({ error: 'value invalido' });
    if (campo === 'dias') { const d = value.split(',').map(s => parseInt(s.trim(), 10)).filter(x => x >= 0 && x <= 6); value = d.join(','); }
    if (campo === 'inicio' || campo === 'fim') { if (!/^\d{1,2}:\d{2}$/.test(value)) return res.status(400).json({ error: 'hora invalida' }); }
    if (campo === 'foraMsg') value = value.slice(0, 500);
    await setSetting(k[campo], value);
    res.json({ ok: true, n, campo, value });
  });

  app.get('/api/admin/canais/painel', (req: any, res: any) => {
    if (!guard(req)) return res.status(403).send('Acesso negado. Use ?k=SUA_SENHA');
    res.set('Content-Type', 'text/html; charset=utf-8').send(PAGE_HTML);
  });

  console.log('[CANAIS-GESTAO] registrado (/api/admin/canais/painel + estado/set)');
}

const PAGE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gestão de Canais</title>
<style>
  :root{--bg:#0f1420;--card:#1a2233;--line:#2a3446;--txt:#e6ebf5;--mut:#8b98b0;--off:#6b7280;--on:#2fae66;--red:#e0576b;--gold:#d9a441;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 18px;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
  .top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .nome{font-weight:700;font-size:16px}
  .papel{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;margin-left:8px}
  .p-principal{background:rgba(47,174,102,.18);color:#7ee0a6}.p-oficial{background:rgba(217,164,65,.18);color:#e8c07a}.p-reserva{background:rgba(139,152,176,.2);color:#c3ccdb}
  .phone{color:var(--mut);font-size:12px}
  .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--line);margin-top:8px}
  .lbl{min-width:150px;color:var(--mut);font-size:13px}
  button{border:0;border-radius:8px;padding:7px 13px;font-weight:600;cursor:pointer;color:#fff;margin-left:6px}
  .b-on{background:var(--on)}.b-off{background:var(--off)}.dim{opacity:.35;filter:grayscale(.5)}
  input,textarea{background:#0e1626;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 9px;font-size:14px}
  input[type=time]{width:110px}
  .dias label{margin-right:6px;font-size:13px;user-select:none;cursor:pointer}
  .foot{color:var(--mut);font-size:12px;margin-top:8px}.msg{color:var(--mut);font-size:12px;margin-left:8px}
</style></head><body>
<h1>Gestão de Canais de Atendimento</h1>
<p class="sub">Honest Sucos · liga/desliga canais e IA, horário de atividade e aviso de fora do horário · salva na hora · fuso de Brasília</p>
<div id="cards"></div>
<div class="foot" id="foot"></div>
<script>
const K=new URLSearchParams(location.search).get('k')||'';
const q=s=>'?k='+encodeURIComponent(K)+s;
const DIAS=[['1','Seg'],['2','Ter'],['3','Qua'],['4','Qui'],['5','Sex'],['6','Sáb'],['0','Dom']];
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
async function setV(n,campo,value){ await fetch('/api/admin/canais/set'+q('&n='+n+'&campo='+campo+'&value='+encodeURIComponent(value))); load(); }
async function setMsg(n){ const t=document.getElementById('msg_'+n).value; const m=document.getElementById('msgst_'+n); m.textContent='Salvando...';
  try{ const r=await(await fetch('/api/admin/canais/set'+q('&n='+n+'&campo=foraMsg&value='+encodeURIComponent(t)))).json(); m.textContent=r.ok?'✓ salvo':('erro: '+(r.error||'')); }catch(e){ m.textContent='erro'; } }
function toggleDia(n,d,dias){ const set=new Set(dias.split(',').filter(x=>x!=='')); if(set.has(d))set.delete(d); else set.add(d); const ord=['1','2','3','4','5','6','0']; const v=ord.filter(x=>set.has(x)).join(','); setV(n,'dias',v); }
async function load(){
  try{
    const d=(await(await fetch('/api/admin/canais/estado'+q(''))).json()).canais||{};
    const wrap=document.getElementById('cards'); wrap.innerHTML='';
    for(const n of Object.keys(d)){
      const c=d[n]; const on=c.ativo!=='off'; const iaon=c.ia!=='off';
      const diasSet=new Set(String(c.dias||'').split(',').filter(x=>x!==''));
      const diasHtml=DIAS.map(([dv,dl])=>'<label><input type="checkbox" '+(diasSet.has(dv)?'checked':'')+' onchange="toggleDia(\\''+n+'\\',\\''+dv+'\\',\\''+esc(c.dias)+'\\')"> '+dl+'</label>').join('');
      wrap.insertAdjacentHTML('beforeend',
      '<div class="card">'+
        '<div class="top"><div><span class="nome">'+esc(c.nome)+'</span><span class="papel p-'+c.papel+'">'+c.papel+'</span> <span class="phone">+'+esc(c.phone)+'</span></div></div>'+
        '<div class="row"><span class="lbl">Canal (número inteiro)</span>'+
          '<button class="'+(on?'b-on':'b-off dim')+'" onclick="setV(\\''+n+'\\',\\'ativo\\',\\'on\\')">ligado</button>'+
          '<button class="'+(!on?'b-off':'b-off dim')+'" onclick="setV(\\''+n+'\\',\\'ativo\\',\\'off\\')">desligado</button></div>'+
        '<div class="row"><span class="lbl">IA neste canal</span>'+
          '<button class="'+(iaon?'b-on':'b-off dim')+'" onclick="setV(\\''+n+'\\',\\'ia\\',\\'on\\')">on</button>'+
          '<button class="'+(!iaon?'b-off':'b-off dim')+'" onclick="setV(\\''+n+'\\',\\'ia\\',\\'off\\')">off</button></div>'+
        '<div class="row"><span class="lbl">Dias de atividade</span><span class="dias">'+diasHtml+'</span></div>'+
        '<div class="row"><span class="lbl">Horário</span>'+
          '<input type="time" value="'+esc(c.inicio)+'" onchange="setV(\\''+n+'\\',\\'inicio\\',this.value)"> às '+
          '<input type="time" value="'+esc(c.fim)+'" onchange="setV(\\''+n+'\\',\\'fim\\',this.value)"></div>'+
        '<div class="row" style="display:block"><span class="lbl" style="display:block;margin-bottom:6px">Mensagem de fora do horário</span>'+
          '<textarea id="msg_'+n+'" rows="2" style="width:100%">'+esc(c.foraMsg)+'</textarea>'+
          '<button class="b-on" style="margin:8px 0 0" onclick="setMsg(\\''+n+'\\')">Salvar mensagem</button><span class="msg" id="msgst_'+n+'"></span></div>'+
      '</div>');
    }
    document.getElementById('foot').textContent='Atualizado '+new Date().toLocaleTimeString('pt-BR');
  }catch(e){ document.getElementById('foot').textContent='Erro: '+e; }
}
load(); setInterval(load,20000);
</script>
</body></html>`;
