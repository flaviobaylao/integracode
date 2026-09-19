// server/official-entrega.ts
// -----------------------------------------------------------------------------
// A MENSAGEM CHEGOU? — rastreamento de entrega dos disparos do 1841
//
// O enum dispatch_status sempre teve 'entregue' e 'lida', mas NADA os escrevia:
// um disparo nascia 'fila', virava 'enviada' quando o Umbler aceitou, e morria
// ali. "Enviada" so quer dizer que a Meta aceitou o pedido — nao que o aparelho
// recebeu. Aparelho desligado, numero que bloqueou a empresa, chip cancelado:
// tudo isso aparecia como sucesso. Este arquivo fecha esse buraco.
//
// DUAS FONTES, porque nenhuma sozinha basta:
//   1. WEBHOOK (de graca, instantaneo) — o Umbler reenvia a mensagem quando o
//      estado muda; `aplicarEstadoDoWebhook` pega isso no meio do fluxo que ja
//      existe em chat-routes e atualiza na hora.
//   2. CONFERENCIA (paga em chamadas, definitiva) — nem todo estado gera
//      webhook, e webhook se perde. `conferirEntregas` pergunta ao Umbler, de
//      tempos em tempos, o estado das mensagens recentes que ainda estao como
//      'enviada'.
//
// NUNCA REGRIDE: uma mensagem lida nao volta a 'entregue' porque chegou um
// webhook atrasado. A ordem e fila < enviada < entregue < lida, e so avanca.
// 'falha' e terminal em qualquer ponto.
// -----------------------------------------------------------------------------
import { db } from "./db";
import { sql } from "drizzle-orm";

const UMBLER_BASE = "https://app-utalk.umbler.com/api";
/** Mesma organizacao que o resto do 1841 usa (env, com o id da Honest de reserva). */
const orgId = () => process.env.UMBLER_TALK_ORG_ID || "aZiQMy9bnyeDpiaY";

/** Quanto mais alto, mais adiante no caminho. So subimos nesta escala. */
const RANK: Record<string, number> = { fila: 0, enviada: 1, entregue: 2, lida: 3, resposta: 4 };

/**
 * Traduz o MessageState do Umbler para o nosso status.
 *
 * Por palavra-chave, de proposito: o Umbler ja mudou o nome dos estados
 * ('Sent' virou 'Delivered' em canais diferentes) e uma lista fechada de
 * strings quebraria calada na proxima mudanca — o disparo ficaria 'enviada'
 * para sempre sem ninguem notar.
 */
export function traduzirEstado(estado: string): "enviada" | "entregue" | "lida" | "falha" | null {
  const s = String(estado || "").toLowerCase();
  if (!s) return null;
  if (/fail|error|reject|undeliver|expired/.test(s)) return "falha";
  if (/read|visto|lida/.test(s)) return "lida";
  if (/deliver|entreg|received/.test(s)) return "entregue";
  if (/sent|enviad/.test(s)) return "enviada";
  return null; // sending, processing, queued: ainda a caminho, nao mexe
}

/** Aplica um estado novo, sem nunca andar para tras. Devolve o status final. */
async function avancar(id: string, atual: string, novo: string): Promise<string> {
  if (atual === "falha" || atual === "resposta") return atual;
  if (novo !== "falha" && (RANK[novo] ?? 0) <= (RANK[atual] ?? 0)) return atual;
  const col = novo === "entregue" ? sql`, delivered_at = COALESCE(delivered_at, now())`
            : novo === "lida" ? sql`, read_at = COALESCE(read_at, now()), delivered_at = COALESCE(delivered_at, now())`
            : sql``;
  await db.execute(sql`UPDATE official_dispatches SET status = ${novo}::dispatch_status, updated_at = now() ${col} WHERE id = ${id}`);
  return novo;
}

let _schemaOk = false;
/** delivered_at / read_at: quando chegou e quando foi lida. Idempotente. */
export async function ensureEntregaSchema(): Promise<void> {
  if (_schemaOk) return;
  try {
    await db.execute(sql`ALTER TABLE official_dispatches ADD COLUMN IF NOT EXISTS delivered_at timestamptz`);
    await db.execute(sql`ALTER TABLE official_dispatches ADD COLUMN IF NOT EXISTS read_at timestamptz`);
    await db.execute(sql`ALTER TABLE official_dispatches ADD COLUMN IF NOT EXISTS conferido_em timestamptz`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS official_dispatches_msg_idx ON official_dispatches (umbler_message_id) WHERE umbler_message_id IS NOT NULL`);
    _schemaOk = true;
  } catch (e: any) { console.warn("[ENTREGA-1841] schema:", e?.message); }
}

/**
 * Chamado de dentro do webhook do Umbler, com a mensagem crua que ele mandou.
 * Se aquela mensagem for um disparo nosso, atualiza o estado na hora e de graca.
 * Nunca lanca: webhook nao pode cair por causa disto.
 */
export async function aplicarEstadoDoWebhook(lastMessage: any): Promise<{ id: string; de: string; para: string } | null> {
  try {
    const msgId = String(lastMessage?.Id || lastMessage?.id || "");
    const estado = String(lastMessage?.MessageState || lastMessage?.messageState || "");
    if (!msgId || !estado) return null;
    const novo = traduzirEstado(estado);
    if (!novo) return null;
    await ensureEntregaSchema();
    const r: any = await db.execute(sql`SELECT id, status::text AS status FROM official_dispatches WHERE umbler_message_id = ${msgId} LIMIT 1`);
    const d = r.rows?.[0];
    if (!d) return null; // mensagem de conversa comum, nao um disparo
    const final = await avancar(String(d.id), String(d.status), novo);
    if (final === d.status) return null;
    console.log(`[ENTREGA-1841] ${msgId}: ${d.status} → ${final} (${estado})`);
    return { id: String(d.id), de: String(d.status), para: final };
  } catch { return null; }
}

async function estadoNoUmbler(messageId: string, orgId: string): Promise<string | null> {
  try {
    const r = await fetch(`${UMBLER_BASE}/v1/messages/${encodeURIComponent(messageId)}/?organizationId=${encodeURIComponent(orgId)}`, {
      headers: { Authorization: "Bearer " + process.env.UMBLER_TALK_TOKEN, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const m: any = await r.json();
    return String(m?.MessageState || m?.messageState || m?.LastMessage?.MessageState || "") || null;
  } catch { return null; }
}

/**
 * Pergunta ao Umbler o estado dos disparos recentes que ainda estao 'enviada'.
 * Roda no cron. Limite por rodada para nao estourar a API nem o tempo do job.
 */
export async function conferirEntregas(limite = 40): Promise<{ conferidos: number; mudaram: number; porStatus: Record<string, number>; erro?: string }> {
  const out = { conferidos: 0, mudaram: 0, porStatus: {} as Record<string, number> };
  if (!process.env.UMBLER_TALK_TOKEN) return { ...out, erro: "UMBLER_TALK_TOKEN ausente" };
  const org = orgId();
  await ensureEntregaSchema();

  // Janela de 3 dias: depois disso o estado nao muda mais e a consulta seria gasto puro.
  // Reconfere no maximo a cada 20 min a mesma mensagem.
  const q: any = await db.execute(sql`
    SELECT id, umbler_message_id, status::text AS status FROM official_dispatches
     WHERE status::text = 'enviada' AND umbler_message_id IS NOT NULL
       AND sent_at > now() - interval '3 days'
       AND (conferido_em IS NULL OR conferido_em < now() - interval '20 minutes')
     ORDER BY sent_at DESC LIMIT ${limite}`);

  for (const d of (q.rows || [])) {
    const estado = await estadoNoUmbler(String(d.umbler_message_id), org);
    await db.execute(sql`UPDATE official_dispatches SET conferido_em = now() WHERE id = ${d.id}`);
    out.conferidos++;
    const novo = estado ? traduzirEstado(estado) : null;
    if (!novo) continue;
    const final = await avancar(String(d.id), String(d.status), novo);
    if (final !== d.status) { out.mudaram++; out.porStatus[final] = (out.porStatus[final] || 0) + 1; }
  }
  if (out.conferidos) console.log(`[ENTREGA-1841] conferidos ${out.conferidos}, mudaram ${out.mudaram}`, out.porStatus);
  return out;
}

/** Quadro de entrega de um período: quantas chegaram, quantas foram lidas, quantas não chegaram. */
export async function panoramaEntrega(dias = 7): Promise<any> {
  await ensureEntregaSchema();
  const r: any = await db.execute(sql`
    SELECT count(*) FILTER (WHERE status::text IN ('enviada','entregue','lida','resposta'))::int AS enviadas,
           count(*) FILTER (WHERE status::text IN ('entregue','lida','resposta'))::int AS entregues,
           count(*) FILTER (WHERE status::text IN ('lida','resposta'))::int AS lidas,
           count(*) FILTER (WHERE status::text = 'resposta')::int AS responderam,
           count(*) FILTER (WHERE status::text = 'falha')::int AS falhas,
           count(*) FILTER (WHERE status::text = 'enviada' AND sent_at < now() - interval '30 minutes')::int AS sem_confirmacao,
           round(avg(EXTRACT(EPOCH FROM (delivered_at - sent_at))) FILTER (WHERE delivered_at IS NOT NULL)::numeric, 0) AS seg_ate_entrega
      FROM official_dispatches
     WHERE created_at > now() - make_interval(days => ${dias})`);
  const x = r.rows?.[0] || {};
  const n = (v: any) => Number(v || 0);
  return {
    dias, enviadas: n(x.enviadas), entregues: n(x.entregues), lidas: n(x.lidas),
    responderam: n(x.responderam), falhas: n(x.falhas), semConfirmacao: n(x.sem_confirmacao),
    segundosAteEntrega: x.seg_ate_entrega == null ? null : n(x.seg_ate_entrega),
    // A taxa que interessa: das que saíram, quantas o aparelho confirmou.
    pctEntrega: n(x.enviadas) ? Math.round((n(x.entregues) / n(x.enviadas)) * 1000) / 10 : null,
    pctLeitura: n(x.entregues) ? Math.round((n(x.lidas) / n(x.entregues)) * 1000) / 10 : null,
  };
}
