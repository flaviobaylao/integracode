// ============================================================================
// INTEGRA 2.0 — Correcao Profissional (por usuario) · Gestao
// Liga/desliga, POR USUARIO de telemarketing, a reescrita automatica das
// mensagens (profissional, objetiva, cortes, com ortografia corrigida) que a
// Claude aplica no envio. Default: LIGADO.
//
// Self-contained. Wiring em server/index.ts:
//   import { registerPolishGestao } from "./polish-gestao";
//   registerPolishGestao(app);
// Painel: /api/admin/polish/painel   (protegido por OFICIAL_ADMIN_KEY se setada)
//
// Enforcement exportado (usado pelo endpoint /api/chat/polish-message):
//   polishAtivoParaUsuario(userId) -> boolean (default true)
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
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'polish-gestao')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

// A correcao profissional esta ligada para este usuario? (default: sim)
export async function polishAtivoParaUsuario(userId: string): Promise<boolean> {
  if (!userId) return true;
  return (await getSetting('polish_user:' + userId, 'on')) !== 'off';
}

// Lista os usuarios de telemarketing (nome + ativo no sistema).
async function listarTelemarketing(): Promise<Array<{ id: string; nome: string; ativoSistema: boolean }>> {
  try {
    const r: any = await db.execute(sql`
      SELECT id, first_name, last_name, is_active
      FROM users WHERE role = 'telemarketing'
      ORDER BY is_active DESC, first_name ASC NULLS LAST`);
    return (r.rows || []).map((u: any) => ({
      id: String(u.id),
      nome: ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || String(u.id),
      ativoSistema: u.is_active === true || u.is_active === 't' || u.is_active === 1,
    }));
  } catch { return []; }
}

export function registerPolishGestao(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  // Estado: lista os usuarios de telemarketing + se a correcao esta ligada para cada um.
  app.get('/api/admin/polish/estado', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const users = await listarTelemarketing();
    const out: any[] = [];
    for (const u of users) {
      const on = (await getSetting('polish_user:' + u.id, 'on')) !== 'off';
      out.push({ id: u.id, nome: u.nome, ativoSistema: u.ativoSistema, polish: on ? 'on' : 'off' });
    }
    res.json({ usuarios: out });
  });

  // Set: liga/desliga a correcao para um usuario especifico.
  app.get('/api/admin/polish/set', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const userId = String(req.query.userId || '');
    const value = String(req.query.value || '');
    if (!userId) return res.status(400).json({ error: 'userId invalido' });
    if (!['on', 'off'].includes(value)) return res.status(400).json({ error: 'value invalido' });
    await setSetting('polish_user:' + userId, value);
    res.json({ ok: true, userId, value });
  });

  app.get('/api/admin/polish/painel', (req: any, res: any) => {
    if (!guard(req)) return res.status(403).send('Acesso negado. Use ?k=SUA_SENHA');
    res.set('Content-Type', 'text/html; charset=utf-8').send(PAGE_HTML);
  });

  console.log('[POLISH-GESTAO] registrado (/api/admin/polish/painel + estado/set)');
}

const PAGE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Correcao Profissional por Usuario</title>
<style>
  :root{--bg:#0f1420;--card:#1a2233;--line:#2a3446;--txt:#e6ebf5;--mut:#8b98b0;--off:#6b7280;--on:#2fae66;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 18px;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 18px;margin-bottom:16px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
  .row:first-child{border-top:0}
  .nome{font-weight:600}.tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:700;background:rgba(139,152,176,.2);color:#c3ccdb}
  .tag.inativo{background:rgba(224,87,107,.18);color:#f0a5b0}
  button{border:0;border-radius:8px;padding:7px 13px;font-weight:600;cursor:pointer;color:#fff;margin-left:6px}
  .b-on{background:var(--on)}.b-off{background:var(--off)}.dim{opacity:.35;filter:grayscale(.5)}
  .foot{color:var(--mut);font-size:12px;margin-top:8px}
</style></head><body>
<h1>Correcao Profissional &middot; por usuario (telemarketing)</h1>
<p class="sub">Honest Sucos &middot; liga/desliga a reescrita automatica da Claude no envio, por usuario &middot; salva na hora</p>
<div class="card" id="lista"></div>
<div class="foot" id="foot"></div>
<script>
const K=new URLSearchParams(location.search).get('k')||'';
const q=s=>'?k='+encodeURIComponent(K)+s;
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function setV(id,value){ await fetch('/api/admin/polish/set'+q('&userId='+encodeURIComponent(id)+'&value='+value)); load(); }
async function load(){
  try{
    const d=(await(await fetch('/api/admin/polish/estado'+q(''))).json()).usuarios||[];
    const wrap=document.getElementById('lista'); wrap.innerHTML='';
    if(!d.length){ wrap.innerHTML='<div class="row">Nenhum usuario de telemarketing encontrado.</div>'; }
    for(const u of d){ const on=u.polish!=='off';
      wrap.insertAdjacentHTML('beforeend',
      '<div class="row"><div><span class="nome">'+esc(u.nome)+'</span>'+
        (u.ativoSistema?'':'<span class="tag inativo">inativo</span>')+'</div>'+
        '<div>'+
          '<button class="'+(on?'b-on':'b-off dim')+'" onclick="setV(\\''+u.id+'\\',\\'on\\')">ligado</button>'+
          '<button class="'+(!on?'b-off':'b-off dim')+'" onclick="setV(\\''+u.id+'\\',\\'off\\')">desligado</button>'+
        '</div></div>');
    }
    document.getElementById('foot').textContent='Atualizado '+new Date().toLocaleTimeString('pt-BR');
  }catch(e){ document.getElementById('foot').textContent='Erro: '+e; }
}
load(); setInterval(load,20000);
</script>
</body></html>`;
