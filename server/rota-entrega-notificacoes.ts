// ─────────────────────────────────────────────────────────────────────────────
// ROTA DE ENTREGAS — tempo por entrega + avisos de WhatsApp (23/ago/2026)
//
// O que este módulo faz:
//  1. TEMPO DA ENTREGA: o entregador toca "Iniciar Entrega" ao chegar no cliente
//     (delivery_started_at na parada) e a entrega termina na foto do comprovante
//     ou na devolução. A duração (segundos) fica na parada e, quando a entrega é
//     EFETUADA, alimenta o cadastro do cliente: último tempo, tempo MÉDIO
//     (média incremental) e contagem — base para estimar rotas no futuro.
//  2. AVISOS DE WHATSAPP:
//     - Rota iniciada → avisa que a 1ª entrega está próxima (qual pedido).
//     - Entrega efetuada/devolvida → informa a entrega concluída (com horário de
//       início, fim e tempo gasto) e qual é a PRÓXIMA entrega da rota.
//     Destinatários: vendedor do pedido entregue, vendedor da próxima entrega,
//     coordenadores de vendas + administradores (role coordinator/admin ativos
//     com telefone) e os números fixos (system_settings 'rota_notif_fixos',
//     padrão 5562995782812).
//
// Envio pelo mesmo caminho dos avisos internos (enviarInterno: canais comuns
// primeiro, oficial por último). Fire-and-forget: nunca derruba o fluxo da
// entrega. Log em automation_dispatch_log (trigger_event rota.iniciada /
// entrega.finalizada / entrega.devolvida).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";

const FIXOS_PADRAO = "5562995782812";

// ── Schema aditivo e idempotente ─────────────────────────────────────────────
let schemaReady = false;
export async function ensureEntregaTempoSchema(): Promise<void> {
  if (schemaReady) return;
  const stmts = [
    `ALTER TABLE delivery_route_stops ADD COLUMN IF NOT EXISTS delivery_started_at timestamp`,
    `ALTER TABLE delivery_route_stops ADD COLUMN IF NOT EXISTS delivery_duration_seconds integer`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS entregas_cronometradas integer DEFAULT 0`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS entrega_tempo_medio_seg integer`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS entrega_tempo_ultimo_seg integer`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS entrega_ultima_em timestamp`,
    `CREATE TABLE IF NOT EXISTS automation_dispatch_log (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      automation_id varchar,
      automation_name varchar,
      trigger_event varchar,
      recipient_phone varchar,
      message text,
      status varchar,
      error text,
      mode varchar,
      created_at timestamp DEFAULT now()
    )`,
  ];
  let tudoOk = true;
  for (const s of stmts) {
    try { await db.execute(sql.raw(s)); }
    catch (e: any) { tudoOk = false; console.warn("[ROTA-NOTIF] ensure:", e?.message); }
  }
  // Só marca pronto quando TODAS passaram — se um ALTER esbarrar no lock_timeout
  // do boot (ver server/db.ts), a próxima chamada tenta de novo.
  if (tudoOk) schemaReady = true;
}

// ── Tempo médio no cadastro do cliente (média incremental) ───────────────────
// SET usa os valores ANTIGOS da linha (semântica do SQL), então a média sai certa:
// nova_média = (média_antiga*qtd_antiga + duração) / (qtd_antiga + 1)
export async function registrarTempoEntregaCliente(customerId: string, durationSeconds: number, quando: Date): Promise<void> {
  if (!customerId || !isFinite(durationSeconds) || durationSeconds < 0) return;
  try {
    await ensureEntregaTempoSchema();
    await db.execute(sql`
      UPDATE customers SET
        entrega_tempo_ultimo_seg = ${Math.round(durationSeconds)},
        entrega_ultima_em = ${quando},
        entrega_tempo_medio_seg = CAST(ROUND(
          (COALESCE(entrega_tempo_medio_seg, 0)::numeric * COALESCE(entregas_cronometradas, 0) + ${Math.round(durationSeconds)})
          / (COALESCE(entregas_cronometradas, 0) + 1)
        ) AS integer),
        entregas_cronometradas = COALESCE(entregas_cronometradas, 0) + 1
      WHERE id = ${customerId}`);
  } catch (e: any) {
    console.error("[ROTA-NOTIF] registrarTempoEntregaCliente:", e?.message);
  }
}

// ── Destinatários ────────────────────────────────────────────────────────────
function soDigitos(v: any): string { return String(v ?? "").replace(/\D/g, ""); }

function normalizaFone(raw: any): string | null {
  let d = soDigitos(raw);
  if (!d) return null;
  if (!d.startsWith("55") && (d.length === 10 || d.length === 11)) d = "55" + d;
  return d.length >= 12 ? d : null;
}

async function fonesFixos(): Promise<string[]> {
  let csv = FIXOS_PADRAO;
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'rota_notif_fixos' LIMIT 1`);
    const v = r?.rows?.[0]?.value;
    if (v) csv = String(v).replace(/^"(.*)"$/, "$1");
  } catch {}
  return csv.split(/[;,]/).map(normalizaFone).filter(Boolean) as string[];
}

// Coordenadores de vendas + administradores do sistema, ativos e com telefone.
async function fonesGestores(): Promise<string[]> {
  try {
    const r: any = await db.execute(sql`
      SELECT phone FROM users
      WHERE role IN ('admin', 'coordinator') AND is_active IS NOT FALSE
        AND phone IS NOT NULL AND phone <> ''`);
    return (r?.rows || []).map((u: any) => normalizaFone(u.phone)).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

// Vendedor responsável pelo pedido da parada: 1º o vendedor do sales_card,
// senão o vendedor da carteira do cliente.
async function vendedorDoStop(stop: any): Promise<{ nome: string; fone: string | null }> {
  const tenta = async (userId: any) => {
    if (!userId) return null;
    try {
      const u: any = await storage.getUser(String(userId));
      if (!u) return null;
      const nome = `${u.firstName || ""} ${u.lastName || ""}`.trim() || (u.email ? String(u.email).split("@")[0] : "");
      return { nome: nome || "Vendedor", fone: normalizaFone(u.phone) };
    } catch { return null; }
  };
  if (stop?.salesCardId) {
    try {
      const r: any = await db.execute(sql`SELECT seller_id FROM sales_cards WHERE id = ${String(stop.salesCardId)} LIMIT 1`);
      const v = await tenta(r?.rows?.[0]?.seller_id);
      if (v) return v;
    } catch {}
  }
  if (stop?.customerId) {
    try {
      const c: any = await storage.getCustomer(String(stop.customerId));
      const v = await tenta((c as any)?.sellerId);
      if (v) return v;
    } catch {}
  }
  return { nome: "", fone: null };
}

// ── Envio + log ──────────────────────────────────────────────────────────────
async function enviar(triggerEvent: string, fones: string[], msg: string): Promise<{ sent: number; failed: number }> {
  await ensureEntregaTempoSchema();
  const unicos = Array.from(new Set(fones.filter(Boolean)));
  let sent = 0, failed = 0;
  for (const fone of unicos) {
    let ok = false, err: string | null = null;
    try {
      const { enviarInterno } = await import("./envio-texto");
      const r = await enviarInterno(fone, msg);
      ok = !!r?.success;
      err = r?.error || null;
    } catch (e: any) {
      err = e?.message || "erro";
    }
    ok ? sent++ : failed++;
    try {
      await db.execute(sql`INSERT INTO automation_dispatch_log
        (automation_name, trigger_event, recipient_phone, message, status, error, mode)
        VALUES ('rota-entrega', ${triggerEvent}, ${fone}, ${msg}, ${ok ? "sent" : "failed"}, ${err}, 'on')`);
    } catch {}
  }
  console.log(`[ROTA-NOTIF] ${triggerEvent} sent=${sent} failed=${failed}`);
  return { sent, failed };
}

const fmtHora = (d: any) => {
  try {
    return new Date(d).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
};

export function fmtDuracao(seg: number): string {
  const s = Math.max(0, Math.round(seg));
  const min = Math.floor(s / 60);
  const resto = s % 60;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}min`;
  }
  return resto > 0 && min < 10 ? `${min}min ${resto}s` : `${min} min`;
}

function pedidoLabel(stop: any): string {
  return stop?.orderNumber
    ? `Pedido ${stop.orderNumber}`
    : (stop?.salesCardId ? `Pedido INT-${String(stop.salesCardId).substring(0, 8)}` : "Pedido s/ nº");
}

async function proximaParada(routeId: string, aposStopOrder?: number): Promise<any | null> {
  try {
    const r: any = await db.execute(sql`
      SELECT id, customer_id AS "customerId", customer_name AS "customerName",
             sales_card_id AS "salesCardId", order_number AS "orderNumber", stop_order AS "stopOrder"
      FROM delivery_route_stops
      WHERE route_id = ${routeId} AND status = 'pendente'
        ${aposStopOrder != null ? sql`AND stop_order <> ${aposStopOrder}` : sql``}
      ORDER BY stop_order ASC LIMIT 1`);
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}

// ── Aviso: rota iniciada (1ª entrega próxima) ────────────────────────────────
export async function notifyRotaIniciada(routeId: string): Promise<void> {
  try {
    const rr: any = await db.execute(sql`
      SELECT id, route_name AS "routeName", driver_name AS "driverName", total_deliveries AS "totalDeliveries", start_time AS "startTime"
      FROM delivery_routes WHERE id = ${routeId} LIMIT 1`);
    const route = rr?.rows?.[0];
    if (!route) return;

    const primeira = await proximaParada(routeId);
    if (!primeira) return;

    const vend = await vendedorDoStop(primeira);
    const msg =
      `🚚 *ROTA DE ENTREGAS INICIADA*\n` +
      `Entregador: ${route.driverName || ""}\n` +
      `Início: ${fmtHora(route.startTime || new Date())}\n\n` +
      `📦 *1ª entrega (a caminho):*\n` +
      `${pedidoLabel(primeira)} — ${primeira.customerName}` +
      (vend.nome ? `\nVendedor: ${vend.nome}` : "");

    const fones = [vend.fone, ...(await fonesFixos()), ...(await fonesGestores())].filter(Boolean) as string[];
    await enviar("rota.iniciada", fones, msg);
  } catch (e: any) {
    console.error("[ROTA-NOTIF] notifyRotaIniciada:", e?.message);
  }
}

// ── Aviso: entrega efetuada/devolvida + próxima entrega ──────────────────────
export async function notifyEntregaFinalizada(params: {
  stop: any;             // parada já atualizada
  route: any;            // rota da parada
  tipo: "efetuada" | "devolvida";
  inicio: Date | null;   // delivery_started_at
  fim: Date;             // conclusão
  duracaoSeg: number | null;
  motivo?: string;       // devolução
}): Promise<void> {
  try {
    const { stop, route, tipo, inicio, fim, duracaoSeg, motivo } = params;

    const vendEntrega = await vendedorDoStop(stop);
    const proxima = await proximaParada(String(stop.routeId || route?.id), Number(stop.stopOrder));
    const vendProxima = proxima ? await vendedorDoStop(proxima) : { nome: "", fone: null };

    const cabecalho = tipo === "efetuada" ? "✅ *ENTREGA EFETUADA*" : "🔴 *PEDIDO DEVOLVIDO*";
    let msg =
      `${cabecalho}\n` +
      `${pedidoLabel(stop)} — ${stop.customerName}\n` +
      (vendEntrega.nome ? `Vendedor: ${vendEntrega.nome}\n` : "") +
      `Entregador: ${route?.driverName || ""}\n` +
      (motivo ? `Motivo: ${motivo}\n` : "") +
      (inicio ? `🕐 Início: ${fmtHora(inicio)} · Fim: ${fmtHora(fim)}\n` : `🕐 Concluída às ${fmtHora(fim)}\n`) +
      (duracaoSeg != null ? `⏱️ Tempo da entrega: ${fmtDuracao(duracaoSeg)}` : "");

    msg = msg.trimEnd() + "\n\n";
    if (proxima) {
      msg +=
        `➡️ *PRÓXIMA ENTREGA:*\n` +
        `${pedidoLabel(proxima)} — ${proxima.customerName}` +
        (vendProxima.nome ? `\nVendedor: ${vendProxima.nome}` : "");
    } else {
      msg += `🏁 Esta era a última entrega da rota.`;
    }

    const fones = [vendEntrega.fone, vendProxima.fone, ...(await fonesFixos()), ...(await fonesGestores())].filter(Boolean) as string[];
    await enviar(tipo === "efetuada" ? "entrega.finalizada" : "entrega.devolvida", fones, msg);
  } catch (e: any) {
    console.error("[ROTA-NOTIF] notifyEntregaFinalizada:", e?.message);
  }
}

// ── Teste: envia amostras SOMENTE para o número de teste ─────────────────────
// (automations_test_number, padrão 5562995782812). Não alcança vendedor nenhum.
export async function testarNotificacoesRota(): Promise<any> {
  let testNumber = "5562995782812";
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'automations_test_number' LIMIT 1`);
    const v = r?.rows?.[0]?.value;
    if (v) testNumber = String(v).replace(/^"(.*)"$/, "$1");
  } catch {}
  const fone = normalizaFone(testNumber);
  if (!fone) return { ok: false, error: "número de teste inválido" };

  const agoraD = new Date();
  const inicioD = new Date(agoraD.getTime() - 7 * 60 * 1000 - 23 * 1000);

  const msg1 =
    `🧪 TESTE — mensagem de exemplo\n\n` +
    `🚚 *ROTA DE ENTREGAS INICIADA*\n` +
    `Entregador: Motorista Teste\n` +
    `Início: ${fmtHora(agoraD)}\n\n` +
    `📦 *1ª entrega (a caminho):*\n` +
    `Pedido 12345 — CLIENTE TESTE LTDA\nVendedor: Vendedor Teste`;

  const msg2 =
    `🧪 TESTE — mensagem de exemplo\n\n` +
    `✅ *ENTREGA EFETUADA*\n` +
    `Pedido 12345 — CLIENTE TESTE LTDA\n` +
    `Vendedor: Vendedor Teste\n` +
    `Entregador: Motorista Teste\n` +
    `🕐 Início: ${fmtHora(inicioD)} · Fim: ${fmtHora(agoraD)}\n` +
    `⏱️ Tempo da entrega: ${fmtDuracao(7 * 60 + 23)}\n\n` +
    `➡️ *PRÓXIMA ENTREGA:*\n` +
    `Pedido 12346 — OUTRO CLIENTE TESTE\nVendedor: Vendedora Teste 2`;

  const msg3 =
    `🧪 TESTE — mensagem de exemplo\n\n` +
    `🔴 *PEDIDO DEVOLVIDO*\n` +
    `Pedido 12346 — OUTRO CLIENTE TESTE\n` +
    `Vendedor: Vendedora Teste 2\n` +
    `Entregador: Motorista Teste\n` +
    `Motivo: Cliente fechado no horário\n` +
    `🕐 Início: ${fmtHora(inicioD)} · Fim: ${fmtHora(agoraD)}\n` +
    `⏱️ Tempo da entrega: ${fmtDuracao(7 * 60 + 23)}\n\n` +
    `🏁 Esta era a última entrega da rota.`;

  const r1 = await enviar("rota.iniciada.teste", [fone], msg1);
  const r2 = await enviar("entrega.finalizada.teste", [fone], msg2);
  const r3 = await enviar("entrega.devolvida.teste", [fone], msg3);
  return { ok: true, testNumber: fone, resultados: { rotaIniciada: r1, entregaEfetuada: r2, entregaDevolvida: r3 } };
}
