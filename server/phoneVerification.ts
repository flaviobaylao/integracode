import { db } from './db';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { sendUmblerTalkText } from './chat-routes';

// ============================================================================
// CONFIRMACAO DE TELEFONE DO COMPRADOR VIA LINK (WhatsApp)
// - Nao bloqueia o pedido. O telefone valido continua obrigatorio (trava),
//   mas a confirmacao pelo comprador e assincrona.
// - Toda vez que o numero do cliente muda, dispara um novo link de confirmacao.
// - Se o comprador nao confirmar em 24h, o Clientes Ativos destaca o numero em vermelho.
// A tabela e criada sob demanda (CREATE TABLE IF NOT EXISTS) — sem migracao manual.
// ============================================================================

let __pvEnsured = false;
export async function ensurePhoneVerification(): Promise<void> {
  if (__pvEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS phone_verifications (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar,
      phone varchar NOT NULL,
      phone_digits varchar NOT NULL,
      customer_name varchar,
      token varchar NOT NULL UNIQUE,
      status varchar NOT NULL DEFAULT 'pending',
      sent_ok boolean,
      send_error text,
      created_by varchar,
      sent_at timestamptz DEFAULT now(),
      confirmed_at timestamptz
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pv_customer ON phone_verifications (customer_id, sent_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pv_token ON phone_verifications (token)`);
  __pvEnsured = true;
}

function publicBase(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'https://integracode-production.up.railway.app').replace(/\/+$/, '');
}

function esc(s: any): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

/**
 * Dispara a confirmacao de telefone para um numero novo/alterado.
 * Best-effort e NAO deve bloquear o fluxo que a chamou (chame sem await ou com catch).
 */
export async function triggerPhoneConfirmation(
  customerId: string | null,
  phone: string,
  name?: string | null,
  createdBy?: string | null
): Promise<{ ok: boolean; token?: string; sent?: boolean; error?: string }> {
  try {
    await ensurePhoneVerification();
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) {
      return { ok: false, error: 'telefone invalido' };
    }
    const token = randomUUID().replace(/-/g, '');
    // Supersede confirmacoes pendentes anteriores do mesmo cliente (numero mudou)
    if (customerId) {
      try { await db.execute(sql`UPDATE phone_verifications SET status='superseded' WHERE customer_id=${customerId} AND status='pending'`); } catch {}
    }
    await db.execute(sql`
      INSERT INTO phone_verifications (customer_id, phone, phone_digits, customer_name, token, status, created_by)
      VALUES (${customerId}, ${phone}, ${digits}, ${name || null}, ${token}, 'pending', ${createdBy || null})`);
    const link = publicBase() + '/confirmar-telefone/' + token;
    const nm = String(name || '').trim() || 'seu cadastro';
    const msg = `Olá! A Honest Sucos registrou este número como contato de *${nm}*. Se este número é seu, confirme aqui: ${link} . Leva 5 segundos e garante que você receba os avisos do seu pedido e da entrega. 🧃`;
    let sent = false; let err: string | null = null;
    try {
      const r = await sendUmblerTalkText(digits, msg);
      sent = !!(r && r.success);
      err = (r && r.error) || null;
    } catch (e: any) {
      err = (e && e.message) ? e.message : 'erro no envio';
    }
    try { await db.execute(sql`UPDATE phone_verifications SET sent_ok=${sent}, send_error=${err} WHERE token=${token}`); } catch {}
    console.log(`[PHONE-VERIF] customer=${customerId} to=${digits} sent=${sent} err=${err || ''}`);
    return { ok: true, token, sent, error: err || undefined };
  } catch (e: any) {
    console.warn('[PHONE-VERIF] erro (ignorado):', e && e.message ? e.message : e);
    return { ok: false, error: e && e.message ? e.message : 'erro' };
  }
}

function pageHtml(title: string, body: string): string {
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f1f5f9;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(2,6,23,.12);max-width:420px;width:100%;padding:28px;text-align:center}
.logo{font-weight:800;font-size:20px;color:#16a34a;letter-spacing:.5px;margin-bottom:6px}
h1{font-size:20px;margin:8px 0 6px}
p{font-size:15px;line-height:1.5;color:#334155;margin:8px 0}
b{color:#0f172a}
button{margin-top:16px;width:100%;padding:14px 16px;font-size:16px;font-weight:700;border:0;border-radius:12px;background:#16a34a;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.ok{color:#16a34a;font-weight:700;font-size:17px;margin-top:14px}
.err{color:#dc2626;font-weight:600;margin-top:14px}
.muted{color:#64748b;font-size:13px;margin-top:14px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export function registerPhoneVerification(
  app: Express,
  deps: { authenticateUser: any; requireRole?: any }
): void {
  const { authenticateUser } = deps;

  // Pagina publica de confirmacao — apenas EXIBE o botao (nao confirma no carregamento,
  // para nao ser auto-confirmada pelo robo de preview de link do WhatsApp).
  app.get('/confirmar-telefone/:token', async (req: any, res) => {
    try {
      await ensurePhoneVerification();
      const { token } = req.params;
      const rows: any = await db.execute(sql`SELECT customer_name, phone, status FROM phone_verifications WHERE token=${token} LIMIT 1`);
      const row = (rows.rows || rows)[0];
      res.set('Content-Type', 'text/html; charset=utf-8');
      if (!row) {
        return res.status(404).send(pageHtml('Link inválido', `<div class="logo">Honest Sucos</div><h1>Link inválido</h1><p>Este link de confirmação não é válido ou expirou.</p>`));
      }
      if (row.status === 'confirmed') {
        return res.send(pageHtml('Já confirmado', `<div class="logo">Honest Sucos</div><h1>✅ Número já confirmado</h1><p>Obrigado! Este número já foi confirmado.</p>`));
      }
      const nm = String(row.customer_name || '').trim();
      const who = nm ? `contato de <b>${esc(nm)}</b>` : 'seu contato';
      return res.send(pageHtml('Confirmar telefone', `
        <div class="logo">Honest Sucos</div>
        <h1>Confirme seu número</h1>
        <p>A <b>Honest Sucos</b> registrou este WhatsApp como ${who}.</p>
        <p>É este mesmo o seu número de contato?</p>
        <button id="btn">Sim, é o meu número</button>
        <div id="msg"></div>
        <div class="muted">Usamos seu contato apenas para confirmar pedidos e entregas.</div>
        <script>
        document.getElementById('btn').addEventListener('click', async function(){
          var b=this; b.disabled=true; b.textContent='Confirmando...';
          try{
            var r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'}});
            var ok=r.ok; var j={}; try{j=await r.json();}catch(e){}
            b.style.display='none';
            document.getElementById('msg').innerHTML = ok ? '<div class="ok">✅ Número confirmado! Obrigado.</div>' : '<div class="err">Não foi possível confirmar. Tente novamente.</div>';
          }catch(e){ b.style.display='none'; document.getElementById('msg').innerHTML='<div class="err">Falha de conexão. Tente novamente.</div>'; }
        });
        </script>`));
    } catch (e: any) {
      res.status(500).set('Content-Type', 'text/html; charset=utf-8').send(pageHtml('Erro', `<div class="logo">Honest Sucos</div><h1>Erro</h1><p>Não foi possível abrir a confirmação agora.</p>`));
    }
  });

  // Confirmacao efetiva (POST) — acionada pelo botao.
  app.post('/confirmar-telefone/:token', async (req: any, res) => {
    try {
      await ensurePhoneVerification();
      const { token } = req.params;
      const rows: any = await db.execute(sql`SELECT id, status FROM phone_verifications WHERE token=${token} LIMIT 1`);
      const row = (rows.rows || rows)[0];
      if (!row) return res.status(404).json({ ok: false, message: 'Link inválido' });
      if (row.status !== 'confirmed') {
        await db.execute(sql`UPDATE phone_verifications SET status='confirmed', confirmed_at=now() WHERE token=${token} AND status <> 'confirmed'`);
      }
      console.log(`[PHONE-VERIF] confirmado token=${token}`);
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ ok: false, message: 'Erro ao confirmar' });
    }
  });

  // Status de confirmacao por cliente (para destacar em vermelho no Clientes Ativos).
  // Retorna a ULTIMA verificacao de cada cliente: { [customerId]: { status, sentAt, over24h } }
  app.get('/api/customers/phone-verification-status', authenticateUser, async (req: any, res) => {
    try {
      await ensurePhoneVerification();
      const rows: any = await db.execute(sql`
        SELECT DISTINCT ON (customer_id) customer_id, status, sent_at, confirmed_at
        FROM phone_verifications
        WHERE customer_id IS NOT NULL
        ORDER BY customer_id, sent_at DESC`);
      const list = rows.rows || rows;
      const now = Date.now();
      const out: Record<string, any> = {};
      for (const r of list) {
        const sentMs = r.sent_at ? new Date(r.sent_at).getTime() : 0;
        const over24h = r.status === 'pending' && sentMs > 0 && (now - sentMs) > 24 * 60 * 60 * 1000;
        out[r.customer_id] = {
          status: r.status,
          sentAt: r.sent_at,
          confirmedAt: r.confirmed_at,
          over24h,
        };
      }
      res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.json(out);
    } catch (e: any) {
      console.error('[PHONE-VERIF] status erro:', e && e.message);
      res.status(500).json({ message: 'Falha ao buscar status' });
    }
  });

  // Envio de TESTE (admin) — dispara o link para um numero avulso, sem tocar em cliente.
  app.post('/api/admin/phone-verification/test-send', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      if (!user || !['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado.' });
      }
      const phone = String((req.body && req.body.phone) || '').trim();
      const name = String((req.body && req.body.name) || 'Teste Honest').trim();
      if (!phone) return res.status(400).json({ message: 'Informe o telefone.' });
      const r = await triggerPhoneConfirmation(null, phone, name, user.id);
      return res.json(r);
    } catch (e: any) {
      return res.status(500).json({ message: 'Erro no envio de teste', error: e && e.message });
    }
  });
}
