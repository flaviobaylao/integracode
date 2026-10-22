// ===========================================================================
// RECEBIMENTO DE TRANSFERÊNCIA COM CONFERÊNCIA (Flavio, 22/out/2026)
//
// A NF de transferência emitida na fábrica (IND) entra na filial (GYN) como lote
// BLOQUEADO (espelharTransferenciaPelosMovimentos, PR #118). A partir daqui:
//
//   1. O lote bloqueado só vira "em uso" pelo RECEBIMENTO: quem recebe confere
//      fisicamente os itens e informa a QUANTIDADE RECEBIDA. Quem pode receber
//      (desbloquear): admin + destinos de Chamados 'flavio' e 'lanucy' + extras
//      (padrão: Robson, por nome — system_settings 'recebimento_lote_extra',
//      mesmo formato de 'abertura_estoque_extra'). Lista de destinos substituível
//      em system_settings 'recebimento_lote_destinos' (JSON de keys).
//   2. Se a quantidade recebida for DIFERENTE da faturada (saldo bloqueado que a
//      transferência lançou), o próprio recebimento ajusta o lote para o recebido
//      (movimento 'adjust' com motivo) e abre o chamado
//      "DIVERGENCIA EM RECEBIMENTO" para 'naiara' e 'flavio' com os dados do
//      faturamento (NF, pedido, data, qtd) e do recebimento (qtd, obs, quem).
//   3. Todo desbloqueio grava na linha do lote (inventory_lots.desbloqueado_por /
//      _nome / _em / recebimento_id) quem foi o responsável — tanto no lote em uso
//      de destino quanto no lote bloqueado de origem — e fica em lote_recebimentos.
//   4. A promoção AUTOMÁTICA do bloqueado no faturamento (estoque-em-uso.ts) fica
//      DESLIGADA por padrão: estoque bloqueado só sai depois de conferido.
//      (system_settings 'estoque_promover_bloqueado' = 'on' religa o comportamento antigo.)
//
// Tabela criada sob demanda (fora do schema drizzle): lote_recebimentos.
// ===========================================================================
import type { Express, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { normalizarNumeroLote } from "./estoque-em-uso";

const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];
const EPS = 0.00005;
export const TITULO_DIVERGENCIA_RECEBIMENTO = "DIVERGENCIA EM RECEBIMENTO";
const DESTINOS_RECEBEM_PADRAO = ["flavio", "lanucy"];
const DESTINOS_NOTIFICADOS = ["naiara", "flavio"];
type Extra = { emails?: string[]; nomeLike?: string[]; userIds?: string[] };
const EXTRAS_PADRAO: Extra[] = [{ nomeLike: ["robson"] }];

const fmtQtd = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Number.isInteger(r) ? String(r) : r.toFixed(4).replace(/0+$/, "").replace(".", ",");
};
const fmtDT = (d: any) => (d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
const nomeDe = (u: any): string => {
  const n = [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();
  return n || u?.email || "Usuário";
};

let ensured: Promise<void> | null = null;
export function ensureRecebimentoLoteSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS desbloqueado_por varchar`);
      await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS desbloqueado_por_nome varchar`);
      await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS desbloqueado_em timestamp`);
      await db.execute(sql`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS recebimento_id varchar`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS lote_recebimentos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        lot_id varchar NOT NULL,
        lot_destino_id varchar,
        product_id varchar NOT NULL,
        product_name varchar,
        instance_id varchar NOT NULL,
        instance_name varchar,
        lot_number varchar NOT NULL,
        qtd_faturada numeric(14,4) NOT NULL,
        qtd_recebida numeric(14,4) NOT NULL,
        divergencia numeric(14,4) NOT NULL DEFAULT 0,
        origem jsonb,
        observacao text,
        recebido_por varchar NOT NULL,
        recebido_por_nome varchar,
        recebido_por_email varchar,
        chamado_ids jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lote_recebimentos_lot ON lote_recebimentos (lot_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lote_recebimentos_num ON lote_recebimentos (product_id, lot_number)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lote_recebimentos_data ON lote_recebimentos (created_at)`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

async function getSetting(key: string): Promise<string | null> {
  try { return rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`))[0]?.value ?? null; } catch { return null; }
}

// Promoção automática do bloqueado no faturamento: desligada por padrão desde 22/out/2026.
export async function promoverBloqueadoNoFaturamento(): Promise<boolean> {
  return (await getSetting("estoque_promover_bloqueado")) === "on";
}

async function responsaveisExtras(): Promise<Set<string>> {
  let cfg: Extra[] = EXTRAS_PADRAO;
  const raw = await getSetting("recebimento_lote_extra");
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) cfg = p; } catch { /* padrão */ } }
  const ids = new Set<string>();
  if (!cfg.length) return ids;
  const users = rows(await db.execute(sql`SELECT id, lower(coalesce(email,'')) AS email, lower(coalesce(first_name,'')) AS fn FROM users WHERE is_active = true`));
  for (const e of cfg) {
    for (const id of e.userIds || []) ids.add(String(id));
    const emails = (e.emails || []).map((x) => x.toLowerCase());
    for (const u of users) if (emails.includes(u.email)) ids.add(String(u.id));
    for (const pat of e.nomeLike || []) {
      const pre = pat.toLowerCase().replace(/%$/, "");
      for (const u of users) if (u.fn.startsWith(pre) || u.email.startsWith(pre)) ids.add(String(u.id));
    }
  }
  return ids;
}

export async function quemPodeReceber(): Promise<Set<string>> {
  const { getDestinos } = await import("./chamados-routes");
  const destinos = await getDestinos();
  let keys = DESTINOS_RECEBEM_PADRAO;
  const raw = await getSetting("recebimento_lote_destinos");
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) keys = p.map(String); } catch { /* padrão */ } }
  const ids = await responsaveisExtras();
  for (const d of destinos) if (keys.includes(d.key)) for (const id of d.userIds) ids.add(String(id));
  return ids;
}

export async function podeReceberLote(user: any): Promise<boolean> {
  if (!user) return false;
  if (String(user.role) === "admin") return true;
  return (await quemPodeReceber()).has(String(user.id));
}

// ---------------------------------------------------------------------------
// MOVER SALDO ENTRE TIPOS (bloqueado ⇄ em uso) — rotina única, usada pelo
// bloquear/desbloquear manual (inventory-routes) e pelo recebimento.
// O saldo vai para o lote de MESMO NÚMERO do tipo de destino (mescla se existe,
// cria se não existe). A linha de origem fica com o que sobrou.
// ---------------------------------------------------------------------------
export type MoverTipoResultado = { origemId: string; origemSaldo: number; destinoId: string; destinoSaldo: number; criado: boolean };

export async function moverTipoLote(opts: {
  lotId: string;
  destino: "in_use" | "blocked";
  quantidade?: number | null; // null/undefined = saldo todo
  motivo: string;
  user: any;
  recebimentoId?: string | null;
  tx?: any;
}): Promise<MoverTipoResultado> {
  const quem = opts.user?.email || opts.user?.id || null;
  const quemId = opts.user?.id ? String(opts.user.id) : null;
  const quemNome = nomeDe(opts.user);
  const motivo = String(opts.motivo || "").trim();
  if (motivo.length < 3) throw new Error("Informe o motivo do bloqueio/desbloqueio.");

  const run = async (tx: any): Promise<MoverTipoResultado> => {
    const existing = rows(await tx.execute(sql`SELECT * FROM inventory_lots WHERE id = ${opts.lotId} LIMIT 1`))[0];
    if (!existing) throw new Error("Lote não encontrado");
    if (existing.stock_type === opts.destino) throw new Error(`O lote já está ${opts.destino === "in_use" ? "em uso" : "bloqueado"}.`);
    const numLote = normalizarNumeroLote(existing.lot_number) || "SEM-LOTE";
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"estoque-mover-tipo:" + existing.product_id + ":" + existing.instance_id + ":" + numLote}))`);
    const origem = rows(await tx.execute(sql`SELECT * FROM inventory_lots WHERE id = ${opts.lotId} FOR UPDATE`))[0];
    const prevOrigem = parseFloat(origem.quantity) || 0;
    const qty = opts.quantidade != null && Number.isFinite(Number(opts.quantidade)) ? Number(opts.quantidade) : prevOrigem;
    if (qty <= 0) throw new Error("Quantidade a mover deve ser maior que zero.");
    if (qty - prevOrigem > 1e-9) throw new Error(`Quantidade a mover (${fmtQtd(qty)}) maior que o saldo do lote (${fmtQtd(prevOrigem)}).`);
    const novoOrigem = Math.max(0, prevOrigem - qty);
    const unitRaw = origem.unit_cost;
    const unit = unitRaw != null && Number(unitRaw) > 0 ? Number(unitRaw) : null;
    const acao = opts.destino === "in_use" ? "unblock" : "block";
    const rotulo = opts.destino === "in_use" ? "Desbloqueio" : "Bloqueio";
    const deTxt = origem.stock_type === "in_use" ? "Em Uso" : "Bloqueado";
    const paraTxt = opts.destino === "in_use" ? "Em Uso" : "Bloqueado";
    const carimbo = opts.destino === "in_use"
      ? sql`, desbloqueado_por = ${quemId}, desbloqueado_por_nome = ${quemNome}, desbloqueado_em = now(), recebimento_id = ${opts.recebimentoId || null}`
      : sql``;

    await tx.execute(sql`
      UPDATE inventory_lots SET quantity = ${novoOrigem.toFixed(4)},
        total_cost = ${unit != null ? (unit * novoOrigem).toFixed(2) : null},
        updated_at = now() ${carimbo}
      WHERE id = ${origem.id}`);

    const exist = rows(await tx.execute(sql`
      SELECT * FROM inventory_lots
      WHERE product_id = ${origem.product_id} AND instance_id = ${origem.instance_id} AND stock_type = ${opts.destino}
        AND UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${numLote}
      ORDER BY is_active DESC, created_at ASC LIMIT 1 FOR UPDATE`))[0];
    let destinoId: string; let prevDestino = 0; let criado = false;
    if (exist) {
      destinoId = exist.id; prevDestino = parseFloat(exist.quantity) || 0;
      const novo = prevDestino + qty;
      await tx.execute(sql`
        UPDATE inventory_lots SET quantity = ${novo.toFixed(4)}, is_active = true,
          unit_cost = COALESCE(unit_cost, ${unit != null ? unit.toFixed(4) : null}),
          total_cost = CASE WHEN COALESCE(unit_cost, ${unit != null ? unit.toFixed(4) : null}) IS NOT NULL
                            THEN (COALESCE(unit_cost, ${unit != null ? unit.toFixed(4) : null})::numeric * ${novo.toFixed(4)}::numeric) ELSE total_cost END,
          production_order_id = COALESCE(production_order_id, ${origem.production_order_id || null}),
          updated_at = now() ${carimbo}
        WHERE id = ${destinoId}`);
    } else {
      criado = true;
      const ins = rows(await tx.execute(sql`
        INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, min_quantity, unit_cost, total_cost, production_order_id, notes, is_active, created_at, updated_at,
                                    desbloqueado_por, desbloqueado_por_nome, desbloqueado_em, recebimento_id)
        VALUES (gen_random_uuid()::varchar, ${origem.product_id}, ${origem.instance_id}, ${opts.destino}, ${numLote}, ${qty.toFixed(4)}, ${origem.min_quantity || "0"},
                ${unit != null ? unit.toFixed(4) : null}, ${unit != null ? (unit * qty).toFixed(2) : null}, ${origem.production_order_id || null},
                ${`${rotulo} do lote ${numLote} (${deTxt.toLowerCase()} → ${paraTxt.toLowerCase()}) — ${motivo.slice(0, 200)}`}, true, now(), now(),
                ${opts.destino === "in_use" ? quemId : null}, ${opts.destino === "in_use" ? quemNome : null}, ${opts.destino === "in_use" ? sql`now()` : null}, ${opts.destino === "in_use" ? (opts.recebimentoId || null) : null})
        RETURNING id`));
      destinoId = ins[0].id;
    }

    const nota = `${rotulo} de estoque: ${fmtQtd(qty)} un. ${deTxt} → ${paraTxt} — ${motivo.slice(0, 300)}`;
    await tx.execute(sql`
      INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
      VALUES (gen_random_uuid()::varchar, ${origem.id}, ${origem.product_id}, ${origem.instance_id}, ${acao}, ${(-qty).toFixed(4)}, ${prevOrigem.toFixed(4)}, ${novoOrigem.toFixed(4)},
              'manual', ${destinoId}, ${numLote}, ${nota + " (saída)"}, ${quem}, now())`);
    await tx.execute(sql`
      INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
      VALUES (gen_random_uuid()::varchar, ${destinoId}, ${origem.product_id}, ${origem.instance_id}, ${acao}, ${qty.toFixed(4)}, ${prevDestino.toFixed(4)}, ${(prevDestino + qty).toFixed(4)},
              'manual', ${origem.id}, ${numLote}, ${nota + " (entrada)"}, ${quem}, now())`);
    console.log(`🔒 [ESTOQUE] ${rotulo} ${numLote}: ${fmtQtd(qty)} (${origem.stock_type} → ${opts.destino}) por ${quemNome} — ${motivo}`);
    return { origemId: origem.id, origemSaldo: novoOrigem, destinoId, destinoSaldo: prevDestino + qty, criado };
  };

  if (opts.tx) return run(opts.tx);
  return db.transaction(run);
}

// ---------------------------------------------------------------------------
// ORIGEM de um lote bloqueado: as entradas por transferência (replenish) ainda
// vivas, com o pedido e a NF-e de transferência que as geraram.
// ---------------------------------------------------------------------------
export type OrigemTransferencia = {
  movimentoId: string; data: string; quantidade: number; cardId: string | null; pedido: string | null;
  nfNumero: number | null; nfSerie: string | null; nfData: string | null; nfStatus: string | null; nfId: string | null;
  origemInstancia: string | null; notas: string;
};

export async function origensDoLoteBloqueado(lotId: string): Promise<OrigemTransferencia[]> {
  const r = rows(await db.execute(sql`
    SELECT m.id, m.created_at, m.quantity::float8 AS qtd, m.source_id, m.notes,
           bp.order_number, bp.omie_instance_name,
           fi.id AS nf_id, fi.invoice_number, fi.series, fi.status AS nf_status,
           COALESCE(fi.emission_date, fi.authorization_date, fi.created_at) AS nf_data
      FROM inventory_movements m
      LEFT JOIN billing_pipeline bp ON bp.id = m.source_id
      LEFT JOIN LATERAL (
        SELECT f.* FROM fiscal_invoices f
         WHERE bp.sales_card_id IS NOT NULL AND f.sales_card_id = bp.sales_card_id
           AND f.status IN ('authorized','returned','processing','cancelled')
         ORDER BY CASE f.status WHEN 'authorized' THEN 0 WHEN 'returned' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END, f.created_at DESC
         LIMIT 1) fi ON true
     WHERE m.lot_id = ${lotId} AND m.movement_type = 'replenish'
       AND COALESCE(m.notes, '') NOT LIKE '%[estornado]%' AND COALESCE(m.notes, '') NOT LIKE '%[estorno-transferencia]%'
     ORDER BY m.created_at ASC`));
  return r.map((x) => ({
    movimentoId: String(x.id), data: x.created_at, quantidade: Number(x.qtd) || 0,
    cardId: x.source_id ? String(x.source_id) : null, pedido: x.order_number ? String(x.order_number) : null,
    nfNumero: x.invoice_number != null ? Number(x.invoice_number) : null, nfSerie: x.series ? String(x.series) : null,
    nfData: x.nf_data || null, nfStatus: x.nf_status ? String(x.nf_status) : null, nfId: x.nf_id ? String(x.nf_id) : null,
    origemInstancia: x.omie_instance_name ? String(x.omie_instance_name) : null, notas: String(x.notes || ""),
  }));
}

// ---------------------------------------------------------------------------
// RECEBER (conferir + desbloquear) um lote bloqueado.
// ---------------------------------------------------------------------------
export async function receberLote(opts: { lotId: string; quantidadeRecebida: number; observacao?: string | null; user: any }) {
  await ensureRecebimentoLoteSchema();
  const lot = rows(await db.execute(sql`
    SELECT l.*, p.name AS product_name, oi.name AS instance_name, oi.display_name AS instance_display
      FROM inventory_lots l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN omie_instances oi ON oi.id = l.instance_id
     WHERE l.id = ${opts.lotId} LIMIT 1`))[0];
  if (!lot) throw Object.assign(new Error("Lote não encontrado"), { status: 404 });
  if (lot.stock_type !== "blocked") throw Object.assign(new Error("Este lote não está bloqueado — nada a receber."), { status: 400 });
  const faturada = parseFloat(lot.quantity) || 0;
  if (faturada <= EPS) throw Object.assign(new Error("Lote bloqueado sem saldo — nada a receber."), { status: 400 });
  const recebida = Number(opts.quantidadeRecebida);
  if (!Number.isFinite(recebida) || recebida < 0) throw Object.assign(new Error("Informe a quantidade recebida (zero ou mais)."), { status: 400 });
  const observacao = String(opts.observacao || "").trim();
  const divergencia = Math.round((recebida - faturada) * 10000) / 10000;
  if (Math.abs(divergencia) > EPS && observacao.length < 3) {
    throw Object.assign(new Error("Quantidade recebida diferente da faturada: descreva o que foi encontrado (observação obrigatória)."), { status: 400 });
  }
  const origens = await origensDoLoteBloqueado(opts.lotId);
  const user = opts.user;
  const nome = nomeDe(user);
  const numLote = normalizarNumeroLote(lot.lot_number);
  const instNome = String(lot.instance_display || lot.instance_name || "");

  const resultado = await db.transaction(async (tx) => {
    const ins = rows(await tx.execute(sql`
      INSERT INTO lote_recebimentos (lot_id, product_id, product_name, instance_id, instance_name, lot_number, qtd_faturada, qtd_recebida, divergencia, origem, observacao,
                                     recebido_por, recebido_por_nome, recebido_por_email)
      VALUES (${lot.id}, ${lot.product_id}, ${lot.product_name || null}, ${lot.instance_id}, ${instNome || null}, ${numLote},
              ${faturada.toFixed(4)}, ${recebida.toFixed(4)}, ${divergencia.toFixed(4)}, ${JSON.stringify(origens)}::jsonb, ${observacao || null},
              ${String(user.id)}, ${nome}, ${user.email || null})
      RETURNING id`));
    const recebimentoId = String(ins[0].id);
    const quem = user?.email || user?.id || null;

    // 1) Divergência: ajusta o saldo bloqueado para o que realmente chegou (trilha no movimento).
    if (Math.abs(divergencia) > EPS) {
      await tx.execute(sql`UPDATE inventory_lots SET quantity = ${recebida.toFixed(4)}, updated_at = now() WHERE id = ${lot.id}`);
      await tx.execute(sql`
        INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
        VALUES (gen_random_uuid()::varchar, ${lot.id}, ${lot.product_id}, ${lot.instance_id}, 'adjust', ${divergencia.toFixed(4)}, ${faturada.toFixed(4)}, ${recebida.toFixed(4)},
                'manual', ${recebimentoId}, ${numLote},
                ${`Conferência de recebimento: faturado ${fmtQtd(faturada)}, recebido ${fmtQtd(recebida)} (${divergencia > 0 ? "+" : ""}${fmtQtd(divergencia)}) — ${observacao.slice(0, 300)} [recebimento ${recebimentoId}]`},
                ${quem}, now())`);
    }

    // 2) Desbloqueio do que foi recebido (carimba o responsável nas duas linhas).
    let mov: MoverTipoResultado | null = null;
    if (recebida > EPS) {
      mov = await moverTipoLote({
        lotId: lot.id, destino: "in_use", quantidade: recebida, user, recebimentoId, tx,
        motivo: `Recebimento conferido por ${nome}: ${fmtQtd(recebida)} un (faturado ${fmtQtd(faturada)})${observacao ? " — " + observacao.slice(0, 200) : ""}`,
      });
      await tx.execute(sql`UPDATE lote_recebimentos SET lot_destino_id = ${mov.destinoId} WHERE id = ${recebimentoId}`);
    } else {
      // Nada recebido: a linha bloqueada fica zerada (vai para Estoques Finalizados), com o responsável.
      await tx.execute(sql`UPDATE inventory_lots SET desbloqueado_por = ${String(user.id)}, desbloqueado_por_nome = ${nome}, desbloqueado_em = now(), recebimento_id = ${recebimentoId}, updated_at = now() WHERE id = ${lot.id}`);
    }
    return { recebimentoId, mov };
  });

  // 3) Chamado de divergência (fora da transação; nunca derruba o recebimento).
  let chamadoIds: string[] = [];
  if (Math.abs(divergencia) > EPS) {
    try {
      const { abrirChamadoSistema } = await import("./chamados-routes");
      const linhasOrigem = origens.length
        ? origens.map((o) => `  • NF-e ${o.nfNumero != null ? o.nfNumero + (o.nfSerie && o.nfSerie !== "1" ? "/" + o.nfSerie : "") : "(sem número)"}${o.nfStatus ? " [" + o.nfStatus + "]" : ""} — pedido ${o.pedido || "—"} — ${fmtDT(o.nfData || o.data)} — ${fmtQtd(o.quantidade)} un${o.origemInstancia ? " de " + o.origemInstancia : ""}`).join("\n")
        : "  • (entrada sem NF de transferência identificada)";
      const descricao = [
        `Produto: ${lot.product_name || lot.product_id}`,
        `Lote: ${numLote}`,
        `Instância de recebimento: ${instNome || lot.instance_id}`,
        ``,
        `FATURAMENTO (transferência):`,
        linhasOrigem,
        `  Quantidade faturada (saldo bloqueado): ${fmtQtd(faturada)} un`,
        ``,
        `RECEBIMENTO:`,
        `  Quantidade recebida: ${fmtQtd(recebida)} un`,
        `  Divergência: ${divergencia > 0 ? "+" : ""}${fmtQtd(divergencia)} un`,
        `  Observação: ${observacao || "—"}`,
        `  Recebido/desbloqueado por: ${nome}${user.email ? " (" + user.email + ")" : ""} em ${fmtDT(new Date())}`,
        ``,
        `O lote ${numLote} foi ajustado para ${fmtQtd(recebida)} un e desbloqueado. Recebimento nº ${resultado.recebimentoId}.`,
      ].join("\n");
      chamadoIds = await abrirChamadoSistema({
        destinoKeys: DESTINOS_NOTIFICADOS, assunto: TITULO_DIVERGENCIA_RECEBIMENTO, descricao, prioridade: "Urgente",
        autor: { id: String(user.id), nome, role: String(user.role || "") },
      });
      await db.execute(sql`UPDATE lote_recebimentos SET chamado_ids = ${JSON.stringify(chamadoIds)}::jsonb WHERE id = ${resultado.recebimentoId}`);
    } catch (e: any) {
      console.error("[recebimento-lote] chamado de divergência falhou:", e?.message || e);
    }
  }

  return { recebimentoId: resultado.recebimentoId, lote: numLote, faturada, recebida, divergencia, chamadoIds, mov: resultado.mov };
}

// ---------------------------------------------------------------------------
// ROTAS
// ---------------------------------------------------------------------------
export function registerRecebimentoLote(app: Express) {
  ensureRecebimentoLoteSchema().catch((e: any) => console.error("[recebimento-lote] schema", e?.message || e));

  app.get("/api/recebimento-lote/acesso", authenticateUser, async (req: any, res: Response) => {
    try { res.json({ podeReceber: await podeReceberLote(req.currentUser) }); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Lotes bloqueados com saldo, com a origem (NF/pedido de transferência) — a fila de recebimento.
  app.get("/api/recebimento-lote/pendentes", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureRecebimentoLoteSchema();
      const pode = await podeReceberLote(req.currentUser);
      const papelVe = ["admin", "coordinator", "administrative", "industria"].includes(String(req.currentUser?.role));
      if (!pode && !papelVe) return res.status(403).json({ message: "Sem permissão para ver a fila de recebimento." });
      const lotes = rows(await db.execute(sql`
        SELECT l.id, l.product_id, p.name AS product_name, l.instance_id, COALESCE(oi.display_name, oi.name) AS instance_name, oi.name AS instance_code,
               l.lot_number, l.quantity::float8 AS quantity, l.unit_cost::float8 AS unit_cost, l.created_at, l.updated_at, l.notes
          FROM inventory_lots l
          LEFT JOIN products p ON p.id = l.product_id
          LEFT JOIN omie_instances oi ON oi.id = l.instance_id
         WHERE l.stock_type = 'blocked' AND l.is_active = true AND l.quantity > 0
         ORDER BY oi.name, l.created_at ASC, p.name`));
      const out = [];
      for (const l of lotes) out.push({ ...l, origens: await origensDoLoteBloqueado(String(l.id)) });
      res.json({ podeReceber: pode, lotes: out });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.get("/api/recebimento-lote/historico", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureRecebimentoLoteSchema();
      const dias = Math.min(365, Math.max(1, parseInt(String(req.query.dias || "60"), 10) || 60));
      const r = rows(await db.execute(sql`
        SELECT * FROM lote_recebimentos WHERE created_at >= now() - (${dias}::text || ' days')::interval ORDER BY created_at DESC LIMIT 500`));
      res.json(r);
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.post("/api/recebimento-lote/:lotId/receber", authenticateUser, async (req: any, res: Response) => {
    try {
      if (!(await podeReceberLote(req.currentUser))) {
        return res.status(403).json({ message: "Só os responsáveis pelo recebimento (Flávio, Lanucy, Robson ou admin) podem conferir e desbloquear lotes." });
      }
      const r = await receberLote({
        lotId: String(req.params.lotId), quantidadeRecebida: Number(req.body?.quantidadeRecebida),
        observacao: req.body?.observacao, user: req.currentUser,
      });
      res.json({ success: true, ...r });
    } catch (e: any) {
      res.status(e?.status || 500).json({ message: e?.message || String(e) });
    }
  });
}
