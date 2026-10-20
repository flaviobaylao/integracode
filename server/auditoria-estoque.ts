// server/auditoria-estoque.ts
// -----------------------------------------------------------------------------
// AUDITORIA DE MOVIMENTAÇÕES DE ESTOQUE (20/out/2026)
//
// Camada DETETIVE do estoque de produto acabado: a baixa em si já é protegida na
// escrita (transação + trava por pedido + FOR UPDATE + anti-duplicidade em
// estoque-em-uso.ts). O que faltava era conferir, o tempo todo, se o que está
// gravado fecha: trilha (inventory_movements) × saldo (inventory_lots) × NF
// (fiscal_invoice_items) × espelho da transferência — e apontar divergências
// antes que virem erro de estoque, de NF ou de CMV.
//
// Como funciona
//   - `executarAuditoria()` roda todas as checagens (SQL puro, somente leitura
//     nas tabelas de negócio) e PERSISTE os achados em inventory_audit_findings,
//     um por "fingerprint" (lote, NF+produto, movimento...). Achado que some de
//     uma rodada para outra é marcado RESOLVIDO sozinho; achado que persiste só
//     atualiza "visto por último". O gestor pode RECONHECER (ack) com um motivo
//     — some da lista de abertos mas continua auditável.
//   - Cron: rodada completa a cada hora (janela de 60 dias) + alerta WhatsApp
//     1x/dia (dia útil, 07:40 BRT) quando houver CRÍTICA aberta não reconhecida
//     (flag system_settings 'estoque_auditoria_alerta_ativo', nasce 'on').
//   - Extrato do lote: trilha completa com saldo corrente recomputado e marca de
//     QUEBRA onde previous_quantity não bate com o saldo anterior.
//
// Regra de ouro das checagens de trilha: dentro de uma transação todos os
// movimentos recebem o MESMO created_at (now()), então a ORDEM entre eles é
// indefinida. Por isso a conferência da trilha é independente de ordem: casa o
// multiconjunto de previous_quantity com o de new_quantity. Numa trilha íntegra
// sobra exatamente UM new (o saldo final) e UM previous (o saldo inicial).
// -----------------------------------------------------------------------------
import type { Express } from "express";
import cron from "node-cron";
import { createHash } from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { sendUmblerTalkText } from "./chat-routes";

const TZ = "America/Sao_Paulo";
const rows = (r: any) => (r?.rows ?? r ?? []) as any[];
const PAPEIS = ["admin", "coordinator", "administrative"];
const EPS = 0.0001;
// DATA-BASE: o livro de movimentos só ficou íntegro a partir da Auditoria de Estoque de
// 04/out/2026 (baixas retroativas + reparos). Antes disso há NF sem baixa e trilhas com
// lacuna por construção. As checagens NF × baixa, baixa sem NF, duplicidade e espelho de
// transferência só olham a partir desta data; lacunas de trilha anteriores viram "legado"
// (severidade média). Ajustável em system_settings 'estoque_auditoria_desde' (AAAA-MM-DD).
const DATA_BASE_PADRAO = "2026-10-04";
async function dataBase(): Promise<string> {
  const v = await setting("estoque_auditoria_desde");
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DATA_BASE_PADRAO;
}

export type Severidade = "critica" | "alta" | "media" | "info";

export const CHECAGENS: Record<string, { label: string; severidade: Severidade; descricao: string }> = {
  SALDO_NEGATIVO: { label: "Saldo negativo", severidade: "critica", descricao: "Lote ativo com quantidade abaixo de zero — fisicamente impossível." },
  TRILHA_X_SALDO: { label: "Trilha ≠ saldo", severidade: "critica", descricao: "O saldo final reconstruído pelos movimentos não é o saldo gravado no lote: alguém alterou a quantidade sem movimento, ou um movimento se perdeu." },
  TRILHA_QUEBRADA: { label: "Trilha com lacuna", severidade: "alta", descricao: "Há movimentos cujo 'saldo anterior' não encontra o 'saldo novo' de nenhum movimento anterior. O saldo de hoje fecha, mas a trilha tem buraco (ex.: lançamento retroativo)." },
  NF_SEM_BAIXA: { label: "NF autorizada sem baixa", severidade: "critica", descricao: "Item de NF-e autorizada (há mais de 1 h) sem nenhum consumo de estoque correspondente." },
  BAIXA_DIVERGENTE_NF: { label: "Baixa ≠ quantidade da NF", severidade: "critica", descricao: "A soma das baixas do item difere da quantidade na NF-e autorizada (a mais = baixa duplicada; a menos = baixa parcial)." },
  NF_CANCELADA_SEM_ESTORNO: { label: "NF cancelada sem estorno", severidade: "critica", descricao: "NF-e cancelada cuja baixa de estoque continua valendo (não foi estornada ao lote)." },
  BAIXA_SEM_NF: { label: "Baixa sem NF autorizada", severidade: "alta", descricao: "Consumo de estoque por faturamento (há mais de 2 h) cujo pedido não tem NF-e autorizada — NF rejeitada, cancelada ou nunca emitida." },
  BAIXA_DUPLICADA: { label: "Baixa duplicada", severidade: "critica", descricao: "Dois consumos idênticos (mesma origem, produto, lote e quantidade) em menos de 10 minutos." },
  TRANSFERENCIA_SEM_ESPELHO: { label: "Transferência sem espelho", severidade: "alta", descricao: "Saída na origem (IND/GYN) sem a entrada correspondente, em quantidade, no destino (GYN/BSB/SERV)." },
  LOTE_DUPLICADO: { label: "Lote duplicado", severidade: "media", descricao: "Mais de um registro ativo para o mesmo produto, instância, número de lote e tipo de estoque." },
  CMV_ZERADO: { label: "Lote sem CMV", severidade: "media", descricao: "Lote ativo com saldo e custo unitário vazio/zero — contamina CMV, DRE e preço de transferência." },
  AJUSTE_MANUAL: { label: "Ajuste manual recente", severidade: "info", descricao: "Ajuste manual de quantidade nos últimos 7 dias — para revisão, não é erro." },
};

export type Achado = {
  check: string;
  severidade: Severidade;
  instanceId: string | null;
  instanceName: string | null;
  productId: string | null;
  productName: string | null;
  lotId: string | null;
  lotNumber: string | null;
  ref: string | null;          // NF, pedido, etc.
  esperado: number | null;
  encontrado: number | null;
  detalhes: Record<string, any>;
  fingerprint: string;
};

const fp = (...parts: Array<string | number | null | undefined>) =>
  createHash("sha1").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 32);
const num = (v: any) => (v === null || v === undefined ? null : Number(v));

// ── Schema (aditivo, idempotente) ─────────────────────────────────────────────
export async function ensureAuditoriaEstoqueSchema(): Promise<void> {
  const run = (q: string) => db.execute(sql.raw(q)).catch((e: any) =>
    console.error("[auditoria-estoque] schema:", String(e?.message || e).slice(0, 160)));
  await run(`CREATE TABLE IF NOT EXISTS inventory_audit_runs (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
    started_at timestamp NOT NULL DEFAULT now(),
    finished_at timestamp,
    trigger varchar NOT NULL DEFAULT 'cron',
    by_user varchar,
    dias integer,
    total integer,
    novos integer,
    resolvidos integer,
    por_severidade jsonb,
    por_check jsonb,
    erro text
  )`);
  await run(`CREATE TABLE IF NOT EXISTS inventory_audit_findings (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
    fingerprint varchar NOT NULL UNIQUE,
    check_code varchar NOT NULL,
    severity varchar NOT NULL,
    status varchar NOT NULL DEFAULT 'open',
    instance_id varchar,
    instance_name varchar,
    product_id varchar,
    product_name varchar,
    lot_id varchar,
    lot_number varchar,
    ref varchar,
    expected numeric(14,4),
    actual numeric(14,4),
    details jsonb,
    first_seen_at timestamp NOT NULL DEFAULT now(),
    last_seen_at timestamp NOT NULL DEFAULT now(),
    last_run_id varchar,
    resolved_at timestamp,
    ack_at timestamp,
    ack_by varchar,
    ack_note text
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inv_audit_status ON inventory_audit_findings (status, severity, last_seen_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inv_audit_lot ON inventory_audit_findings (lot_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inv_mov_source ON inventory_movements (source_id, product_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inv_mov_lot_created ON inventory_movements (lot_id, created_at)`);
  await run(`INSERT INTO system_settings (key, value, updated_by) VALUES ('estoque_auditoria_alerta_ativo', 'on', 'auditoria-estoque') ON CONFLICT (key) DO NOTHING`);
}

// ── Checagens ─────────────────────────────────────────────────────────────────
async function chkSaldoNegativo(): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    SELECT il.id, il.lot_number, il.quantity, il.stock_type, il.product_id, pr.name pname, il.instance_id, oi.name iname
    FROM inventory_lots il JOIN products pr ON pr.id = il.product_id LEFT JOIN omie_instances oi ON oi.id = il.instance_id
    WHERE COALESCE(il.is_active, true) AND il.quantity < 0`));
  return r.map((x) => ({
    check: "SALDO_NEGATIVO", severidade: "critica", instanceId: x.instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pname,
    lotId: x.id, lotNumber: x.lot_number, ref: null, esperado: 0, encontrado: num(x.quantity), detalhes: { stockType: x.stock_type }, fingerprint: fp("SALDO_NEGATIVO", x.id),
  }));
}

// Trilha × saldo, independente de ordem (ver cabeçalho).
async function chkTrilha(desde: string): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    WITH vals AS (
      SELECT lot_id, v, SUM(s) AS bal FROM (
        SELECT lot_id, round(new_quantity, 4) v, 1 s FROM inventory_movements
        UNION ALL SELECT lot_id, round(previous_quantity, 4), -1 FROM inventory_movements) x GROUP BY lot_id, v),
    agg AS (
      SELECT lot_id,
             SUM(CASE WHEN bal > 0 THEN bal ELSE 0 END) finais,
             SUM(CASE WHEN bal < 0 THEN -bal ELSE 0 END) iniciais,
             MAX(CASE WHEN bal > 0 THEN v END) final_v
      FROM vals GROUP BY lot_id),
    prim AS (SELECT DISTINCT ON (lot_id) lot_id, previous_quantity p0, created_at c0 FROM inventory_movements ORDER BY lot_id, created_at ASC),
    -- última "lacuna": movimento mais recente cujo previous não casa com new de ninguém (excluindo o primeiro da trilha)
    lac AS (
      SELECT m.lot_id, MAX(m.created_at) ultima FROM inventory_movements m
      JOIN vals v ON v.lot_id = m.lot_id AND v.v = round(m.previous_quantity, 4) AND v.bal < 0
      JOIN prim p ON p.lot_id = m.lot_id AND m.created_at > p.c0
      GROUP BY m.lot_id)
    SELECT il.id, il.lot_number, il.stock_type, il.quantity, il.is_active, il.created_at lot_created, il.product_id, pr.name pname, il.instance_id, oi.name iname,
           a.finais, a.iniciais, COALESCE(a.final_v, p.p0) esperado, l.ultima,
           (SELECT COUNT(*) FROM inventory_movements m WHERE m.lot_id = il.id) nmov
    FROM inventory_lots il JOIN agg a ON a.lot_id = il.id JOIN prim p ON p.lot_id = il.id LEFT JOIN lac l ON l.lot_id = il.id
    JOIN products pr ON pr.id = il.product_id LEFT JOIN omie_instances oi ON oi.id = il.instance_id
    WHERE a.finais > 1 OR a.iniciais > 1 OR abs(il.quantity - COALESCE(a.final_v, p.p0)) > ${EPS}`));
  const out: Achado[] = [];
  for (const x of r) {
    const saldoDifere = Math.abs(Number(x.quantity) - Number(x.esperado)) > EPS;
    const check = saldoDifere ? "TRILHA_X_SALDO" : "TRILHA_QUEBRADA";
    // Lacuna só anterior à data-base = legado (média): o saldo gravado é o número confiável.
    const legado = !x.ultima || String(x.ultima).slice(0, 10) < desde;
    out.push({
      check, severidade: legado ? "media" : CHECAGENS[check].severidade, instanceId: x.instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pname,
      lotId: x.id, lotNumber: x.lot_number, ref: null, esperado: num(x.esperado), encontrado: num(x.quantity),
      detalhes: { stockType: x.stock_type, legado, lacunas: Math.max(Number(x.finais) - 1, Number(x.iniciais) - 1, 0), ultimaLacunaEm: x.ultima, movimentos: Number(x.nmov), loteAtivo: !!x.is_active, loteCriadoEm: x.lot_created },
      fingerprint: fp(check, x.id),
    });
  }
  return out;
}

// NF-e × baixa: por item (NF, produto). Baixa líquida = consumos não estornados
// ligados ao card do pipeline (sales_card_id) ou à própria NF.
async function chkNfXBaixa(dias: number, desde: string): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    WITH nf AS (
      SELECT fi.id nf_id, fi.invoice_number, fi.status, fi.cfop, fi.sales_card_id, fi.omie_instance_id, fi.customer_name, fi.created_at, fi.authorization_date, fi.cancellation_date
      FROM fiscal_invoices fi
      WHERE fi.status IN ('authorized', 'cancelled') AND fi.operation_type IN ('venda', 'saida') AND fi.import_origin IS NULL
        AND fi.created_at >= GREATEST(NOW() - (${dias} * INTERVAL '1 day'), ${desde}::timestamp) AND fi.created_at <= NOW() - INTERVAL '1 hour' AND fi.sales_card_id IS NOT NULL),
    itens AS (
      SELECT i.invoice_id, i.product_id, MAX(i.product_name) pname, SUM(i.quantity) q
      FROM fiscal_invoice_items i JOIN nf ON nf.nf_id = i.invoice_id WHERE i.product_id IS NOT NULL GROUP BY 1, 2),
    fontes AS (
      SELECT nf.nf_id, bp.id src FROM nf JOIN billing_pipeline bp ON bp.sales_card_id = nf.sales_card_id
      UNION SELECT nf.nf_id, nf.nf_id FROM nf),
    mov AS (
      SELECT f.nf_id, m.product_id, SUM(m.quantity) cons, COUNT(*) n, MIN(m.created_at) primeiro, MAX(m.created_at) ultimo
      FROM fontes f JOIN inventory_movements m ON m.source_id = f.src
      WHERE m.movement_type = 'consume' AND m.source_type = 'invoice'
        AND COALESCE(m.notes, '') NOT LIKE '%[estornado]%' AND COALESCE(m.notes, '') NOT LIKE '%[estorno-transferencia]%'
      GROUP BY 1, 2)
    SELECT nf.*, i.product_id, i.pname, i.q, COALESCE(mv.cons, 0) cons, COALESCE(mv.n, 0) n, mv.ultimo, oi.name iname, pr.name pnome
    FROM nf JOIN itens i ON i.invoice_id = nf.nf_id
    LEFT JOIN mov mv ON mv.nf_id = nf.nf_id AND mv.product_id = i.product_id
    LEFT JOIN omie_instances oi ON oi.id = nf.omie_instance_id LEFT JOIN products pr ON pr.id = i.product_id
    WHERE (nf.status = 'authorized' AND abs(i.q - COALESCE(mv.cons, 0)) > ${EPS})
       OR (nf.status = 'cancelled' AND COALESCE(mv.cons, 0) > ${EPS})`));
  return r.map((x) => {
    const q = Number(x.q), cons = Number(x.cons);
    const check = x.status === "cancelled" ? "NF_CANCELADA_SEM_ESTORNO" : cons <= EPS ? "NF_SEM_BAIXA" : "BAIXA_DIVERGENTE_NF";
    return {
      check, severidade: CHECAGENS[check].severidade, instanceId: x.omie_instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pnome || x.pname,
      lotId: null, lotNumber: null, ref: `NF ${x.invoice_number}`, esperado: x.status === "cancelled" ? 0 : q, encontrado: cons,
      detalhes: { nfId: x.nf_id, nfNumero: x.invoice_number, nfStatus: x.status, cfop: x.cfop, cliente: x.customer_name, salesCardId: x.sales_card_id, consumos: Number(x.n), emitidaEm: x.created_at, canceladaEm: x.cancellation_date },
      fingerprint: fp(check, x.nf_id, x.product_id),
    } as Achado;
  });
}

// Consumo por faturamento sem NF autorizada para o pedido.
async function chkBaixaSemNf(dias: number, desde: string): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    WITH c AS (
      SELECT m.source_id, m.product_id, m.instance_id, SUM(m.quantity) q, COUNT(*) n, MAX(m.created_at) ultimo, MAX(m.notes) nota
      FROM inventory_movements m
      WHERE m.movement_type = 'consume' AND m.source_type = 'invoice'
        AND m.created_at >= GREATEST(NOW() - (${dias} * INTERVAL '1 day'), ${desde}::timestamp) AND m.created_at <= NOW() - INTERVAL '2 hours'
        AND COALESCE(m.notes, '') NOT LIKE '%[estornado]%' AND COALESCE(m.notes, '') NOT LIKE '%[estorno-transferencia]%'
      GROUP BY 1, 2, 3)
    SELECT c.*, bp.order_number, bp.customer_name, bp.stage::text stage, pr.name pname, oi.name iname
    FROM c LEFT JOIN billing_pipeline bp ON bp.id = c.source_id
    JOIN products pr ON pr.id = c.product_id LEFT JOIN omie_instances oi ON oi.id = c.instance_id
    WHERE NOT EXISTS (SELECT 1 FROM fiscal_invoices f WHERE f.id = c.source_id AND f.status IN ('authorized', 'returned'))
      AND NOT EXISTS (SELECT 1 FROM fiscal_invoices f WHERE bp.sales_card_id IS NOT NULL AND f.sales_card_id = bp.sales_card_id AND f.status IN ('authorized', 'returned'))`));
  return r.map((x) => ({
    check: "BAIXA_SEM_NF", severidade: "alta", instanceId: x.instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pname,
    lotId: null, lotNumber: null, ref: x.order_number ? `Pedido ${x.order_number}` : `Origem ${String(x.source_id).slice(0, 8)}`, esperado: 0, encontrado: num(x.q),
    detalhes: { sourceId: x.source_id, cliente: x.customer_name, etapaCard: x.stage, consumos: Number(x.n), ultimoEm: x.ultimo, nota: x.nota },
    fingerprint: fp("BAIXA_SEM_NF", x.source_id, x.product_id),
  }));
}

async function chkBaixaDuplicada(dias: number, desde: string): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    SELECT m.source_id, m.product_id, m.lot_id, m.lot_number, m.quantity, m.instance_id, COUNT(*) n, MIN(m.created_at) p, MAX(m.created_at) u, pr.name pname, oi.name iname, bp.order_number
    FROM inventory_movements m JOIN products pr ON pr.id = m.product_id LEFT JOIN omie_instances oi ON oi.id = m.instance_id LEFT JOIN billing_pipeline bp ON bp.id = m.source_id
    WHERE m.movement_type = 'consume' AND m.created_at >= GREATEST(NOW() - (${dias} * INTERVAL '1 day'), ${desde}::timestamp)
      AND COALESCE(m.notes, '') NOT LIKE '%[estornado]%'
    GROUP BY m.source_id, m.product_id, m.lot_id, m.lot_number, m.quantity, m.instance_id, pr.name, oi.name, bp.order_number
    HAVING COUNT(*) > 1 AND MAX(m.created_at) - MIN(m.created_at) <= INTERVAL '10 minutes'`));
  return r.map((x) => ({
    check: "BAIXA_DUPLICADA", severidade: "critica", instanceId: x.instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pname,
    lotId: x.lot_id, lotNumber: x.lot_number, ref: x.order_number ? `Pedido ${x.order_number}` : `Origem ${String(x.source_id).slice(0, 8)}`,
    esperado: num(x.quantity), encontrado: Number(x.quantity) * Number(x.n),
    detalhes: { sourceId: x.source_id, vezes: Number(x.n), entre: [x.p, x.u] }, fingerprint: fp("BAIXA_DUPLICADA", x.source_id, x.product_id, x.lot_id, x.quantity),
  }));
}

// Transferência: saída (consume na origem) × entrada (replenish no destino), por produto, mesmo card.
async function chkTransferenciaEspelho(dias: number, desde: string): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    WITH t AS (
      SELECT bp.id card_id, bp.order_number, bp.omie_instance_name origem
      FROM billing_pipeline bp
      WHERE LOWER(COALESCE(bp.operation_type, '')) = 'transferencia' AND bp.stage::text NOT IN ('lixeira', 'agendado', 'pedido', 'a_faturar')
        AND EXISTS (SELECT 1 FROM fiscal_invoices f WHERE f.sales_card_id = bp.sales_card_id AND f.status = 'authorized'
                    AND f.created_at >= GREATEST(NOW() - (${dias} * INTERVAL '1 day'), ${desde}::timestamp))),
    sai AS (
      SELECT m.source_id, m.product_id, SUM(m.quantity) q FROM inventory_movements m JOIN t ON t.card_id = m.source_id
      WHERE m.movement_type = 'consume' AND COALESCE(m.notes, '') NOT LIKE '%[estornado]%' AND COALESCE(m.notes, '') NOT LIKE '%[estorno-transferencia]%' GROUP BY 1, 2),
    ent AS (
      SELECT m.source_id, m.product_id, SUM(m.quantity) q, MAX(oi.name) destino FROM inventory_movements m JOIN t ON t.card_id = m.source_id LEFT JOIN omie_instances oi ON oi.id = m.instance_id
      WHERE m.movement_type = 'replenish' AND COALESCE(m.notes, '') NOT LIKE '%[estornado]%' GROUP BY 1, 2)
    SELECT t.card_id, t.order_number, t.origem, COALESCE(sai.product_id, ent.product_id) product_id, pr.name pname,
           COALESCE(sai.q, 0) saida, COALESCE(ent.q, 0) entrada, ent.destino
    FROM t LEFT JOIN sai ON sai.source_id = t.card_id FULL JOIN ent ON ent.source_id = sai.source_id AND ent.product_id = sai.product_id
    LEFT JOIN products pr ON pr.id = COALESCE(sai.product_id, ent.product_id)
    WHERE t.card_id IS NOT NULL AND abs(COALESCE(sai.q, 0) - COALESCE(ent.q, 0)) > ${EPS}`));
  return r.filter((x) => x.product_id).map((x) => ({
    check: "TRANSFERENCIA_SEM_ESPELHO", severidade: "alta", instanceId: null, instanceName: [x.origem, x.destino].filter(Boolean).join(" → ") || null, productId: x.product_id, productName: x.pname,
    lotId: null, lotNumber: null, ref: `Pedido ${x.order_number || String(x.card_id).slice(0, 8)}`, esperado: num(x.saida), encontrado: num(x.entrada),
    detalhes: { cardId: x.card_id, origem: x.origem, destino: x.destino }, fingerprint: fp("TRANSFERENCIA_SEM_ESPELHO", x.card_id, x.product_id),
  }));
}

async function chkLoteDuplicado(): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    SELECT il.instance_id, il.product_id, il.lot_number, il.stock_type, COUNT(*) n, SUM(il.quantity) q, array_agg(il.id) ids, pr.name pname, oi.name iname
    FROM inventory_lots il JOIN products pr ON pr.id = il.product_id LEFT JOIN omie_instances oi ON oi.id = il.instance_id
    WHERE COALESCE(il.is_active, true) GROUP BY 1, 2, 3, 4, pr.name, oi.name HAVING COUNT(*) > 1`));
  return r.map((x) => ({
    check: "LOTE_DUPLICADO", severidade: "media", instanceId: x.instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pname,
    lotId: null, lotNumber: x.lot_number, ref: null, esperado: 1, encontrado: Number(x.n),
    detalhes: { stockType: x.stock_type, saldoSomado: Number(x.q), loteIds: x.ids }, fingerprint: fp("LOTE_DUPLICADO", x.instance_id, x.product_id, x.lot_number, x.stock_type),
  }));
}

async function chkCmvZerado(): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    SELECT il.id, il.lot_number, il.quantity, il.stock_type, il.unit_cost, il.product_id, il.instance_id, pr.name pname, oi.name iname
    FROM inventory_lots il JOIN products pr ON pr.id = il.product_id LEFT JOIN omie_instances oi ON oi.id = il.instance_id
    WHERE COALESCE(il.is_active, true) AND il.quantity > 0 AND COALESCE(il.unit_cost, 0) <= 0`));
  return r.map((x) => ({
    check: "CMV_ZERADO", severidade: "media", instanceId: x.instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pname,
    lotId: x.id, lotNumber: x.lot_number, ref: null, esperado: null, encontrado: num(x.quantity), detalhes: { stockType: x.stock_type, unitCost: x.unit_cost }, fingerprint: fp("CMV_ZERADO", x.id),
  }));
}

async function chkAjusteManual(): Promise<Achado[]> {
  const r = rows(await db.execute(sql`
    SELECT m.id, m.lot_id, m.lot_number, m.product_id, m.instance_id, m.quantity, m.previous_quantity, m.new_quantity, m.notes, m.created_by, m.created_at, pr.name pname, oi.name iname
    FROM inventory_movements m JOIN products pr ON pr.id = m.product_id LEFT JOIN omie_instances oi ON oi.id = m.instance_id
    WHERE m.movement_type = 'adjust' AND m.created_at >= NOW() - INTERVAL '7 days'`));
  return r.map((x) => ({
    check: "AJUSTE_MANUAL", severidade: "info", instanceId: x.instance_id, instanceName: x.iname, productId: x.product_id, productName: x.pname,
    lotId: x.lot_id, lotNumber: x.lot_number, ref: null, esperado: num(x.previous_quantity), encontrado: num(x.new_quantity),
    detalhes: { delta: Number(x.new_quantity) - Number(x.previous_quantity), por: x.created_by, em: x.created_at, nota: x.notes }, fingerprint: fp("AJUSTE_MANUAL", x.id),
  }));
}

export async function coletarAchados(dias = 60): Promise<Achado[]> {
  const desde = await dataBase();
  const partes = await Promise.all([
    chkSaldoNegativo(), chkTrilha(desde), chkNfXBaixa(dias, desde), chkBaixaSemNf(dias, desde), chkBaixaDuplicada(dias, desde),
    chkTransferenciaEspelho(dias, desde), chkLoteDuplicado(), chkCmvZerado(), chkAjusteManual(),
  ]);
  return partes.flat();
}

// ── Execução + persistência ───────────────────────────────────────────────────
let _rodando: Promise<any> | null = null;
export async function executarAuditoria(opts?: { trigger?: string; by?: string | null; dias?: number }) {
  if (_rodando) return _rodando; // single-flight: cron e botão ao mesmo tempo não duplicam
  _rodando = (async () => {
    const dias = Math.max(7, Math.min(365, opts?.dias || 60));
    const runId = rows(await db.execute(sql`INSERT INTO inventory_audit_runs (trigger, by_user, dias) VALUES (${opts?.trigger || "cron"}, ${opts?.by || null}, ${dias}) RETURNING id`))[0]?.id;
    try {
      const achados = await coletarAchados(dias);
      const fps = achados.map((a) => a.fingerprint);
      let novos = 0;
      for (const a of achados) {
        const r = rows(await db.execute(sql`
          INSERT INTO inventory_audit_findings (fingerprint, check_code, severity, status, instance_id, instance_name, product_id, product_name, lot_id, lot_number, ref, expected, actual, details, last_run_id)
          VALUES (${a.fingerprint}, ${a.check}, ${a.severidade}, 'open', ${a.instanceId}, ${a.instanceName}, ${a.productId}, ${a.productName}, ${a.lotId}, ${a.lotNumber}, ${a.ref},
                  ${a.esperado}, ${a.encontrado}, ${JSON.stringify(a.detalhes)}::jsonb, ${runId})
          ON CONFLICT (fingerprint) DO UPDATE SET
            last_seen_at = now(), last_run_id = EXCLUDED.last_run_id, expected = EXCLUDED.expected, actual = EXCLUDED.actual, details = EXCLUDED.details,
            instance_name = COALESCE(EXCLUDED.instance_name, inventory_audit_findings.instance_name),
            -- achado que tinha sido resolvido e voltou: reabre
            status = CASE WHEN inventory_audit_findings.status = 'resolved' THEN 'open' ELSE inventory_audit_findings.status END,
            resolved_at = CASE WHEN inventory_audit_findings.status = 'resolved' THEN NULL ELSE inventory_audit_findings.resolved_at END
          RETURNING (xmax = 0) AS inserted`));
        if (r[0]?.inserted) novos++;
      }
      // O que estava aberto/reconhecido e não apareceu nesta rodada → resolvido.
      const res = rows(await db.execute(sql`
        UPDATE inventory_audit_findings SET status = 'resolved', resolved_at = now()
        WHERE status IN ('open', 'ack') AND NOT (fingerprint = ANY(${fps}::varchar[])) RETURNING id`));
      const porSev: Record<string, number> = {}; const porCheck: Record<string, number> = {};
      for (const a of achados) { porSev[a.severidade] = (porSev[a.severidade] || 0) + 1; porCheck[a.check] = (porCheck[a.check] || 0) + 1; }
      await db.execute(sql`UPDATE inventory_audit_runs SET finished_at = now(), total = ${achados.length}, novos = ${novos}, resolvidos = ${res.length}, por_severidade = ${JSON.stringify(porSev)}::jsonb, por_check = ${JSON.stringify(porCheck)}::jsonb WHERE id = ${runId}`);
      console.log(`🔎 [AUDITORIA-ESTOQUE] ${achados.length} achado(s) (${novos} novos, ${res.length} resolvidos) — ${JSON.stringify(porSev)}`);
      return { runId, total: achados.length, novos, resolvidos: res.length, porSeveridade: porSev, porCheck };
    } catch (e: any) {
      await db.execute(sql`UPDATE inventory_audit_runs SET finished_at = now(), erro = ${String(e?.message || e).slice(0, 500)} WHERE id = ${runId}`).catch(() => {});
      throw e;
    }
  })();
  try { return await _rodando; } finally { _rodando = null; }
}

// ── Extrato do lote (trilha com saldo corrente e marcação de quebras) ─────────
// Movimentos da mesma transação têm o mesmo created_at: dentro do grupo, a ordem é
// reconstruída encadeando previous → new (greedy). Fora disso, created_at manda.
export async function extratoDoLote(lotId: string) {
  const lote = rows(await db.execute(sql`
    SELECT il.*, pr.name product_name, oi.name instance_name FROM inventory_lots il JOIN products pr ON pr.id = il.product_id LEFT JOIN omie_instances oi ON oi.id = il.instance_id WHERE il.id = ${lotId}`))[0];
  if (!lote) return null;
  const movs = rows(await db.execute(sql`
    SELECT m.*, bp.order_number, bp.customer_name,
      (SELECT f.invoice_number FROM fiscal_invoices f WHERE f.id = m.source_id OR (bp.sales_card_id IS NOT NULL AND f.sales_card_id = bp.sales_card_id) ORDER BY f.created_at DESC LIMIT 1) nf
    FROM inventory_movements m LEFT JOIN billing_pipeline bp ON bp.id = m.source_id
    WHERE m.lot_id = ${lotId} ORDER BY m.created_at ASC`));
  // agrupa por created_at e encadeia
  const grupos: any[][] = [];
  for (const m of movs) { const g = grupos[grupos.length - 1]; if (g && String(g[0].created_at) === String(m.created_at)) g.push(m); else grupos.push([m]); }
  const ordenados: any[] = [];
  let saldo: number | null = null;
  for (const g of grupos) {
    const pend: any[] = [...g];
    while (pend.length) {
      const alvo: number | null = saldo;
      let i: number = alvo === null ? 0 : pend.findIndex((x: any) => Math.abs(Number(x.previous_quantity) - alvo) <= EPS);
      if (i < 0) i = 0;
      const m: any = pend.splice(i, 1)[0];
      const prev: number = Number(m.previous_quantity), novo: number = Number(m.new_quantity);
      const quebra = saldo !== null && Math.abs(prev - saldo) > EPS;
      ordenados.push({ ...m, saldoAntesEsperado: saldo, quebra, delta: novo - prev });
      saldo = novo;
    }
  }
  const saldoAtual = Number(lote.quantity);
  return {
    lote: { id: lote.id, lotNumber: lote.lot_number, stockType: lote.stock_type, quantity: saldoAtual, unitCost: lote.unit_cost, isActive: lote.is_active, createdAt: lote.created_at, productId: lote.product_id, productName: lote.product_name, instanceId: lote.instance_id, instanceName: lote.instance_name },
    movimentos: ordenados,
    saldoTrilha: saldo,
    fecha: saldo === null ? null : Math.abs(saldo - saldoAtual) <= EPS,
    quebras: ordenados.filter((m) => m.quebra).length,
  };
}

// ── Alerta WhatsApp (1x/dia, dia útil) ────────────────────────────────────────
function hojeBR(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function diaUtilBR(): boolean { const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date()); return !["Sat", "Sun"].includes(wd); }
async function setting(key: string): Promise<string> { try { return String(rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`))[0]?.value || "").trim(); } catch { return ""; } }

export async function enviarAlertaAuditoria(apply: boolean, opts?: { ignorarFlag?: boolean; toOverride?: string }) {
  const abertos = rows(await db.execute(sql`
    SELECT check_code, COUNT(*) n FROM inventory_audit_findings WHERE status = 'open' AND severity IN ('critica', 'alta') GROUP BY 1 ORDER BY 2 DESC`));
  const criticas = rows(await db.execute(sql`SELECT COUNT(*) n FROM inventory_audit_findings WHERE status = 'open' AND severity = 'critica'`))[0]?.n || 0;
  if (!abertos.length) return { ok: true, enviado: false, motivo: "sem_achados" };
  const linhas = abertos.map((a) => `• ${CHECAGENS[a.check_code]?.label || a.check_code}: ${a.n}`).join("\n");
  const msg = `🔎 *Auditoria de Estoque — ${new Date().toLocaleDateString("pt-BR", { timeZone: TZ })}*\n${Number(criticas)} crítica(s) e ${abertos.reduce((s, a) => s + Number(a.n), 0) - Number(criticas)} alta(s) em aberto:\n${linhas}\n\nVer e tratar: Integra › Produtos & Estoque › Auditoria de Estoque.`;
  if (!apply) return { ok: true, enviado: false, previa: true, msg };
  if (!opts?.ignorarFlag && (await setting("estoque_auditoria_alerta_ativo")) !== "on") return { ok: true, enviado: false, motivo: "flag_desligada" };
  if (!opts?.ignorarFlag && Number(criticas) === 0) return { ok: true, enviado: false, motivo: "sem_critica" };
  const hoje = hojeBR();
  if (!opts?.ignorarFlag && (await setting("estoque_auditoria_alerta_last")) === hoje) return { ok: true, enviado: false, motivo: "ja_enviado_hoje" };
  const so = (s: string) => (s || "").replace(/[^0-9,]/g, "");
  const destinos = opts?.toOverride ? [so(opts.toOverride)] : Array.from(new Set(so(await setting("telefone_gestor_relatorios")).split(",").map((x) => x.trim()).filter((x) => x.length >= 10)));
  if (!destinos.length) return { ok: true, enviado: false, motivo: "sem_destino" };
  let enviados = 0; const detalhes: any[] = [];
  for (const to of destinos) { try { const r = await sendUmblerTalkText(to, msg); if (r.success) enviados++; else detalhes.push({ to, err: r.error }); } catch (e: any) { detalhes.push({ to, err: String(e?.message || e) }); } }
  if (enviados > 0) await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('estoque_auditoria_alerta_last', ${hoje}, 'auditoria-estoque') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`).catch(() => {});
  return { ok: true, enviado: enviados > 0, enviados, destinos, detalhes };
}

// ── Rotas + cron ──────────────────────────────────────────────────────────────
let _agendado = false;
export function initAuditoriaEstoque(app?: Express) {
  if (app) {
    const g1 = authenticateUser, g2 = requireRole(PAPEIS);

    app.get("/api/auditoria-estoque/checagens", g1, g2, (_req, res) => res.json(CHECAGENS));

    app.get("/api/auditoria-estoque/resumo", g1, g2, async (_req, res) => {
      try {
        const porSev = rows(await db.execute(sql`SELECT severity, status, COUNT(*) n FROM inventory_audit_findings GROUP BY 1, 2`));
        const ultima = rows(await db.execute(sql`SELECT * FROM inventory_audit_runs ORDER BY started_at DESC LIMIT 1`))[0] || null;
        const alertaAtivo = (await setting("estoque_auditoria_alerta_ativo")) === "on";
        res.json({ porSeveridade: porSev, ultimaExecucao: ultima, alertaAtivo, rodando: !!_rodando, desde: await dataBase() });
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    app.get("/api/auditoria-estoque/achados", g1, g2, async (req, res) => {
      try {
        const status = String(req.query.status || "open");          // open | ack | resolved | all
        const sev = String(req.query.severidade || "");
        const check = String(req.query.check || "");
        const inst = String(req.query.instancia || "");
        const q = String(req.query.q || "").trim();
        const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit || "1000"), 10) || 1000));
        const r = rows(await db.execute(sql`
          SELECT * FROM inventory_audit_findings
          WHERE (${status} = 'all' OR status = ${status})
            AND (${sev} = '' OR severity = ${sev})
            AND (${check} = '' OR check_code = ${check})
            AND (${inst} = '' OR instance_name = ${inst})
            AND (${q} = '' OR product_name ILIKE '%' || ${q} || '%' OR lot_number ILIKE '%' || ${q} || '%' OR ref ILIKE '%' || ${q} || '%')
          ORDER BY CASE severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, last_seen_at DESC
          LIMIT ${limit}`));
        res.json(r);
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    app.post("/api/auditoria-estoque/executar", g1, g2, async (req: any, res) => {
      try {
        const u = req.currentUser || req.user;
        const r = await executarAuditoria({ trigger: "manual", by: u?.email || u?.id || null, dias: req.body?.dias });
        res.json(r);
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    app.post("/api/auditoria-estoque/achados/:id/reconhecer", g1, g2, async (req: any, res) => {
      try {
        const u = req.currentUser || req.user;
        const nota = String(req.body?.nota || "").trim();
        if (nota.length < 3) return res.status(400).json({ message: "Informe o motivo do reconhecimento." });
        const r = rows(await db.execute(sql`UPDATE inventory_audit_findings SET status = 'ack', ack_at = now(), ack_by = ${u?.email || u?.id || null}, ack_note = ${nota} WHERE id = ${req.params.id} AND status = 'open' RETURNING id`));
        if (!r.length) return res.status(404).json({ message: "Achado não encontrado ou já tratado." });
        res.json({ ok: true });
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    app.post("/api/auditoria-estoque/achados/:id/reabrir", g1, g2, async (req, res) => {
      try {
        const r = rows(await db.execute(sql`UPDATE inventory_audit_findings SET status = 'open', ack_at = NULL, ack_by = NULL, ack_note = NULL WHERE id = ${req.params.id} AND status = 'ack' RETURNING id`));
        if (!r.length) return res.status(404).json({ message: "Achado não encontrado." });
        res.json({ ok: true });
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    app.get("/api/auditoria-estoque/lote/:lotId/extrato", g1, g2, async (req, res) => {
      try {
        const r = await extratoDoLote(String(req.params.lotId));
        if (!r) return res.status(404).json({ message: "Lote não encontrado." });
        res.json(r);
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    // Busca de lotes para abrir o extrato sem passar por um achado.
    app.get("/api/auditoria-estoque/lotes", g1, g2, async (req, res) => {
      try {
        const q = String(req.query.q || "").trim();
        if (q.length < 2) return res.json([]);
        const r = rows(await db.execute(sql`
          SELECT il.id, il.lot_number, il.stock_type, il.quantity, il.is_active, pr.name product_name, oi.name instance_name
          FROM inventory_lots il JOIN products pr ON pr.id = il.product_id LEFT JOIN omie_instances oi ON oi.id = il.instance_id
          WHERE il.lot_number ILIKE '%' || ${q} || '%' OR pr.name ILIKE '%' || ${q} || '%'
          ORDER BY COALESCE(il.is_active, true) DESC, il.updated_at DESC NULLS LAST LIMIT 50`));
        res.json(r);
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    app.get("/api/auditoria-estoque/execucoes", g1, g2, async (_req, res) => {
      try { res.json(rows(await db.execute(sql`SELECT * FROM inventory_audit_runs ORDER BY started_at DESC LIMIT 30`))); } catch (e: any) { res.status(500).json({ message: e.message }); }
    });

    app.get("/api/auditoria-estoque/alerta", g1, g2, async (_req, res) => {
      try { res.json(await enviarAlertaAuditoria(false)); } catch (e: any) { res.status(500).json({ message: e.message }); }
    });
    app.post("/api/auditoria-estoque/alerta/testar", g1, g2, async (req, res) => {
      try { res.json(await enviarAlertaAuditoria(true, { ignorarFlag: true, toOverride: req.body?.to })); } catch (e: any) { res.status(500).json({ message: e.message }); }
    });
    app.post("/api/auditoria-estoque/alerta/flag", g1, g2, async (req, res) => {
      try {
        const v = req.body?.ativo ? "on" : "off";
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('estoque_auditoria_alerta_ativo', ${v}, 'auditoria-estoque') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
        res.json({ ok: true, ativo: v === "on" });
      } catch (e: any) { res.status(500).json({ message: e.message }); }
    });
  }

  if (_agendado) return; _agendado = true;
  // Rodada completa a cada hora (minuto 20, fora do pico de faturamento da virada da hora).
  cron.schedule("20 * * * *", async () => {
    try { await executarAuditoria({ trigger: "cron" }); } catch (e: any) { console.error("[AUDITORIA-ESTOQUE] cron:", e?.message || e); }
  }, { timezone: TZ });
  // Alerta diário 07:40 BRT (dia útil) — só com crítica aberta.
  cron.schedule("40 7 * * *", async () => {
    try {
      if (!diaUtilBR()) return;
      await executarAuditoria({ trigger: "cron-alerta" }).catch(() => {});
      const r = await enviarAlertaAuditoria(true);
      if (r.enviado) console.log(`⚠️ [AUDITORIA-ESTOQUE] alerta enviado para ${r.enviados} destino(s).`);
    } catch (e: any) { console.error("[AUDITORIA-ESTOQUE] alerta:", e?.message || e); }
  }, { timezone: TZ });
  // Primeira rodada 2 min após o boot (schema já criado), para a tela não nascer vazia.
  setTimeout(() => { executarAuditoria({ trigger: "boot" }).catch((e: any) => console.error("[AUDITORIA-ESTOQUE] boot:", e?.message || e)); }, 120_000);
}
