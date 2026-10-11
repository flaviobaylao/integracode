// ============================================================================
// INTEGRA 2.0 — Campanha de confirmação de telefone pelo canal oficial 1841
// (Plano Dobrar Vendas, semana 1 — 11/10/2026)
//
// Só 162 dos 1.058 clientes ativos tinham telefone confirmado. Esta rotina manda o
// template `confirmar_whatsapp` ("Este é o WhatsApp de pedidos de {{1}}?") com os botões
// "Sim, é este número" / "Não, outro número" pela fila oficial (official-dispatch:
// teto diário, horário comercial, opt-out, antirrepetição por campanha).
//
//   SIM -> phone_verifications.status='confirmed' (mesma tabela da trava de venda) + agradece.
//   NÃO -> pede o número certo; quando o cliente manda um telefone, grava em
//          customers.phone (o antigo vai para notes) e dispara a confirmação para o novo.
//
// Gates (system_settings):
//   confirmacao_tel_on        'on'|'off' (default on)
//   confirmacao_tel_lote      quantos enfileirar por rodada (default 200)
//   confirmacao_tel_hora      hora BRT da rodada diária (default 9)
//   oficial_confirmacao       'on' (gate do caso de uso na fila oficial)
//   oficial_mode_confirmacao  off|test|on (default: o geral)
//
// Rotas (admin): GET /api/admin/confirmacao-telefone?dry=1 | ?run=1[&limit=N]
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const TEMPLATE = 'confirmar_whatsapp';
const USE_CASE = 'confirmacao';
const TZ = 'America/Sao_Paulo';
const dig = (s: any) => String(s || '').replace(/\D/g, '');
function hojeBR(): string { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function horaBR(): number { return parseInt(new Date().toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', hour12: false }), 10) || 0; }
function normalizar(t: string): string {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'confirmacao-tel')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
}

// Celular normalizado (55 + DDD + 9 dígitos); null se não for celular.
export function celular(phone: any): string | null {
  let d = dig(phone).replace(/^55/, '');
  if (d.length === 10 && /^[1-9][0-9][6-9]/.test(d)) d = d.slice(0, 2) + '9' + d.slice(2);
  if (!/^[1-9][0-9]9[0-9]{8}$/.test(d)) return null;
  return '55' + d;
}

let _schema = false;
async function ensureSchema() {
  if (_schema) return;
  try { await db.execute(sql`ALTER TYPE dispatch_use_case ADD VALUE IF NOT EXISTS 'confirmacao'`); } catch {}
  try { const { ensurePhoneVerification } = await import('./phoneVerification'); await ensurePhoneVerification(); } catch {}
  _schema = true;
}

// Clientes ativos (compraram nos últimos 180 d), celular válido, sem confirmação válida
// e sem disparo desta campanha nos últimos 30 d.
async function selecionar(limit: number): Promise<Array<{ id: string; nome: string; tel: string }>> {
  const r: any = await db.execute(sql`
    SELECT c.id, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome, c.phone
    FROM customers c
    WHERE COALESCE(c.is_active, true) = true
      AND COALESCE(c.situacao, '') NOT ILIKE 'inativo'
      AND COALESCE(c.is_supplier, false) = false
      AND regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') ~ '^(55)?[1-9][0-9](9[0-9]{8}|[6-9][0-9]{7})$'
      AND EXISTS (SELECT 1 FROM fiscal_invoices f WHERE f.customer_id = c.id AND f.status = 'authorized' AND f.emission_date > now() - interval '180 days')
      AND NOT EXISTS (SELECT 1 FROM phone_verifications v WHERE v.customer_id = c.id AND v.status = 'confirmed'
                        AND right(v.phone_digits, 8) = right(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g'), 8))
      AND NOT EXISTS (SELECT 1 FROM official_dispatches d WHERE d.customer_id = c.id AND d.use_case = 'confirmacao'
                        AND d.created_at > now() - interval '30 days')
    ORDER BY (SELECT max(f2.emission_date) FROM fiscal_invoices f2 WHERE f2.customer_id = c.id) DESC
    LIMIT ${limit}`);
  const out: Array<{ id: string; nome: string; tel: string }> = [];
  for (const x of (r.rows || []) as any[]) {
    const tel = celular(x.phone);
    if (tel) out.push({ id: String(x.id), nome: String(x.nome || '').trim(), tel });
  }
  return out;
}

function titulo(t: string): string {
  return t.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m) => m.toUpperCase()).replace(/\b(Ltda|Me|Epp|Eireli|S\/a)\b\.?/gi, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export async function confirmacaoTick(opts: { force?: boolean; dry?: boolean; limit?: number } = {}): Promise<any> {
  await ensureSchema();
  if ((await getSetting('confirmacao_tel_on', 'on')) !== 'on' && !opts.force) return { ran: false, reason: 'off' };
  // Template precisa estar importado e aprovado.
  const t: any = await db.execute(sql`SELECT umbler_id FROM whatsapp_templates WHERE label = ${TEMPLATE} LIMIT 1`);
  if (!t.rows?.[0]?.umbler_id) return { ran: false, reason: `template ${TEMPLATE} ainda nao importado/aprovado` };
  const lote = Math.max(1, Math.min(1000, opts.limit || parseInt(await getSetting('confirmacao_tel_lote', '200'), 10) || 200));
  const alvos = await selecionar(lote);
  if (opts.dry) return { ran: true, dry: true, alvos: alvos.length, amostra: alvos.slice(0, 20) };
  const { enqueueOfficialDispatch } = await import('./official-dispatch');
  const res: Record<string, number> = {};
  for (const a of alvos) {
    try {
      const r = await enqueueOfficialDispatch({ customerId: a.id, customerPhone: a.tel, templateLabel: TEMPLATE, params: [titulo(a.nome) || 'sua empresa'], useCase: USE_CASE, campaign: 'confirmacao:' + hojeBR() + ':' + a.id, category: 'UTILITY' });
      res[r] = (res[r] || 0) + 1;
    } catch (e: any) { res['erro'] = (res['erro'] || 0) + 1; }
  }
  await setSetting('confirmacao_tel_last_run', hojeBR());
  console.log('[CONFIRMACAO-TEL] enfileirados', JSON.stringify(res));
  return { ran: true, alvos: alvos.length, resultado: res };
}

// ---------------------------------------------------------------------------
// Resposta do cliente ao template (chamado por ia-takeover.reactiveInbound antes da IA).
// Devolve o texto a responder, ou null quando não tem a ver com a confirmação.
// ---------------------------------------------------------------------------
export async function respostaDaConfirmacao(phone: string, texto: string): Promise<string | null> {
  try {
    const d = dig(phone);
    if (d.length < 8) return null;
    const disp: any = await db.execute(sql`
      SELECT id, customer_id, customer_phone FROM official_dispatches
      WHERE right(customer_phone, 8) = ${d.slice(-8)} AND use_case = 'confirmacao'
        AND status IN ('enviada','entregue','lida','resposta')
        AND sent_at > now() - interval '72 hours'
      ORDER BY sent_at DESC LIMIT 1`);
    const disp0 = disp.rows?.[0];
    if (!disp0) return null;
    const cid = String(disp0.customer_id || '');
    const t = normalizar(texto);
    if (!t || t.length > 80) return null;

    // SIM
    if (/^(sim e este numero|sim|e este|este mesmo|isso|confirmo|confirmar|ok|correto)$/.test(t)) {
      try {
        await db.execute(sql`UPDATE phone_verifications SET status = 'superseded' WHERE customer_id = ${cid} AND status = 'pending'`);
        await db.execute(sql`INSERT INTO phone_verifications (customer_id, phone, phone_digits, token, status, created_by, sent_ok, sent_at, confirmed_at)
          VALUES (${cid}, ${'+' + d}, ${d}, ${'botao-' + Date.now()}, 'confirmed', 'ia:confirmacao', true, now(), now())`);
        await db.execute(sql`UPDATE official_dispatches SET status = 'resposta'::dispatch_status, updated_at = now() WHERE id = ${disp0.id}`);
      } catch (e: any) { console.error('[CONFIRMACAO-TEL] gravar', e?.message || e); }
      return 'Perfeito, número confirmado! 🧡 Por aqui você recebe os avisos de pedido e entrega da Honest, e pode fazer pedidos a qualquer hora — é só mandar mensagem.';
    }
    // NÃO
    if (/^(nao outro numero|nao|outro numero|nao e este|errado)$/.test(t)) {
      await setSetting('confirmacao_aguarda_num:' + d.slice(-8), cid);
      return 'Sem problema! Me manda o número de WhatsApp correto para pedidos (com DDD) que eu atualizo o cadastro. 📱';
    }
    // Cliente mandou um número depois do NÃO
    const aguardando = await getSetting('confirmacao_aguarda_num:' + d.slice(-8), '');
    if (aguardando && aguardando === cid) {
      const novo = celular(texto);
      if (novo) {
        try {
          const c: any = await db.execute(sql`SELECT phone FROM customers WHERE id = ${cid} LIMIT 1`);
          const antigo = String(c.rows?.[0]?.phone || '');
          await db.execute(sql`UPDATE customers SET phone = ${novo}, notes = concat_ws(E'\n', NULLIF(notes,''), ${'Telefone anterior ' + antigo + ' trocado pelo cliente em ' + hojeBR() + ' (confirmacao WhatsApp)'}), updated_at = now() WHERE id = ${cid}`);
          await db.execute(sql`DELETE FROM system_settings WHERE key = ${'confirmacao_aguarda_num:' + d.slice(-8)}`);
          // Confirmação para o número novo (template; se não der, link).
          try {
            const { enqueueOfficialDispatch } = await import('./official-dispatch');
            const nome: any = await db.execute(sql`SELECT COALESCE(NULLIF(fantasy_name,''), name) AS n FROM customers WHERE id = ${cid}`);
            await enqueueOfficialDispatch({ customerId: cid, customerPhone: novo, templateLabel: TEMPLATE, params: [titulo(String(nome.rows?.[0]?.n || '')) || 'sua empresa'], useCase: USE_CASE, campaign: 'confirmacao:novo:' + cid + ':' + novo, category: 'UTILITY' });
          } catch {}
        } catch (e: any) { console.error('[CONFIRMACAO-TEL] trocar', e?.message || e); }
        return `Anotado! Atualizei o cadastro para (${novo.slice(2, 4)}) ${novo.slice(4, 9)}-${novo.slice(9)} e mandei a confirmação lá. Obrigado! 🧡`;
      }
    }
    return null;
  } catch (e: any) { console.error('[CONFIRMACAO-TEL] resposta', e?.message || e); return null; }
}

export function registerConfirmacaoTelefone(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;
  app.get('/api/admin/confirmacao-telefone', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const run = String(req.query.run || '') === '1';
    const limit = parseInt(String(req.query.limit || ''), 10) || undefined;
    try { res.json(await confirmacaoTick({ force: true, dry: !run, limit })); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  // Rodada diária (dias úteis) na hora configurada; a fila oficial cuida do ritmo e do teto.
  try {
    setInterval(async () => {
      try {
        if ((await getSetting('confirmacao_tel_on', 'on')) !== 'on') return;
        const { ehDiaUtil } = await import('./ia-fila');
        if (!(await ehDiaUtil())) return;
        const hora = parseInt(await getSetting('confirmacao_tel_hora', '9'), 10) || 9;
        if (horaBR() < hora || horaBR() > hora + 2) return;
        if ((await getSetting('confirmacao_tel_last_run', '')) === hojeBR()) return;
        await confirmacaoTick();
      } catch (e: any) { console.error('[CONFIRMACAO-TEL] tick', e?.message || e); }
    }, 60 * 1000);
  } catch {}
  console.log('[CONFIRMACAO-TEL] registrado (template confirmar_whatsapp pelo 1841, rodada diaria)');
}
