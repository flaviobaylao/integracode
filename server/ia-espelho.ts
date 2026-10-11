// ============================================================================
// INTEGRA 2.0 — IA · Espelho das conversas no WhatsApp do gestor (11/10/2026)
//
// Pedido do Flavio: receber, em tempo real, copia de tudo que os agentes de IA conversam
// com os clientes. Cada troca (mensagem do cliente + resposta da IA) vira UMA mensagem no
// WhatsApp do(s) gestor(es), enviada pelo canal de saida padrao (7169) — numero diferente
// do que o cliente usa, para a copia nao se misturar com a conversa real.
//
// Quem chama: agent-runtime (resposta do agente), ia-repescagem (abertura), ia-saude
// (fallback). Nunca lanca; nunca espelha para o proprio telefone do cliente.
//
// Gates (system_settings):
//   ia_espelho_on        'on'|'off' (default on)
//   ia_espelho_destinos  CSV de telefones; vazio = gestor_whatsapp
//   ia_espelho_canal     numero Umbler de saida; vazio = canal_saida_padrao
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
const dig = (s: any) => String(s || '').replace(/\D/g, '');
function fmtTel(t: string): string {
  const d = dig(t).replace(/^55/, '');
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d;
}
async function nomeDaConversa(conversationId: string, phone: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT customer_name, customer_phone FROM chat_conversations WHERE id = ${conversationId} LIMIT 1`);
    const n = String(r.rows?.[0]?.customer_name || '').trim();
    return n && n !== dig(r.rows?.[0]?.customer_phone) ? n : fmtTel(phone);
  } catch { return fmtTel(phone); }
}

export async function espelharConversa(opts: {
  conversationId: string;
  phone: string;
  cliente?: string | null;      // texto que o cliente mandou (opcional)
  ia?: string | null;           // texto que a IA respondeu / enviou (opcional)
  agente?: string;              // 'whatsapp' | 'repescagem' | 'saude' ...
  nota?: string;                // ex.: 'ferramentas: registrar_pedido' / 'TRANSFERIDA'
}): Promise<void> {
  try {
    if ((await getSetting('ia_espelho_on', 'on')) !== 'on') return;
    const destinos = (await getSetting('ia_espelho_destinos', '') || await getSetting('gestor_whatsapp', '5562995782812'))
      .split(',').map(dig).filter(x => x.length >= 10);
    if (!destinos.length) return;
    const canal = dig(await getSetting('ia_espelho_canal', '')) || dig(await getSetting('canal_saida_padrao', '')) || undefined;
    const cli = dig(opts.phone);
    const nome = await nomeDaConversa(opts.conversationId, opts.phone);

    const partes: string[] = [`🤖 *IA · ${opts.agente || 'whatsapp'}* — ${nome} (${fmtTel(opts.phone)})`];
    if (opts.cliente && opts.cliente.trim()) partes.push(`👤 ${opts.cliente.trim().slice(0, 700)}`);
    if (opts.ia && opts.ia.trim()) partes.push(`🤖 ${opts.ia.trim().slice(0, 1200)}`);
    if (opts.nota) partes.push(`ℹ️ ${opts.nota.slice(0, 200)}`);
    const texto = partes.join('\n');

    const { sendUmblerTalkText } = await import('./chat-routes');
    for (const to of destinos) {
      if (to.slice(-8) === cli.slice(-8)) continue; // nao espelha para o proprio cliente (ex.: teste do gestor)
      try { await sendUmblerTalkText(to, texto, canal); } catch (e: any) { console.error('[IA-ESPELHO]', e?.message || e); }
    }
  } catch (e: any) { console.error('[IA-ESPELHO]', e?.message || e); }
}
