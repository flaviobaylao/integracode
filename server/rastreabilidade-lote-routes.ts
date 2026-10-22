// ---------------------------------------------------------------------------
// RASTREABILIDADE DE LOTE (Faturamentos › aba Rastreabilidade) — 22/out/2026
// ---------------------------------------------------------------------------
// Lista TODAS as notas fiscais faturadas que levaram o lote "X" (do produto "Y",
// opcional) e mostra a INSTÂNCIA que emitiu cada nota (IND, GYN, BSB, SERV).
//
// Regras do Flavio (22/out/2026):
//   - NÃO considerar transferências (IND→GYN 5151/1151, →BSB 5409/6409, 5152,
//     devolução de transferência 5208/5209 e qualquer natureza com "TRANSF",
//     inclusive a venda GYN→SERV "transferencia entre empresas do grupo").
//   - Considerar TODOS os outros tipos: venda, troca, amostra, bonificação,
//     devolução de venda (entrada), etc.
//
// Fontes (somente leitura):
//   fiscal_invoice_items.lot_number  → "H051026" ou, quando a baixa consumiu mais
//                                      de um lote, "H051026 (18) / H161026 (12)"
//   fiscal_invoice_items.product_name→ notas antigas sem lot_number têm o lote só
//                                      no nome ("... - Lote: H120626, h180626")
//   fiscal_invoices.omie_instance_id → instância emissora; fallback pelo CNPJ do
//                                      emitente casado com omie_instances.cnpj
//
// "Faturada" = NF-e de PRODUÇÃO autorizada ('authorized') ou autorizada e depois
// devolvida ('returned'). Canceladas só com ?incluirCanceladas=1. Rascunho,
// rejeitada e inutilizada nunca entram. Mesma NF registrada em duplicidade
// (CNPJ emitente + série + número + entrada/saída) aparece uma vez só.
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const PAPEIS = ["admin", "coordinator", "administrative"];

/** CFOPs de transferência (e devolução de transferência), sem ponto. */
export const CFOP_TRANSFERENCIA = [
  "5151", "5152", "5153", "5155", "5156", "5408", "5409", "5208", "5209",
  "6151", "6152", "6153", "6155", "6156", "6408", "6409", "6208", "6209",
  "1151", "1152", "1153", "1154", "1408", "1409", "1208", "1209",
  "2151", "2152", "2153", "2154", "2408", "2409", "2208", "2209",
];

/** Normaliza o número do lote para comparação: maiúsculo, sem espaços. */
export const normLote = (s: string) => String(s || "").toUpperCase().replace(/\s+/g, "").trim();

const rowsOf = (r: any): any[] => (r?.rows || r || []) as any[];
const num = (v: any) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/** Trecho de SQL: texto do lote do item (coluna própria ou "Lote: ..." no nome). */
const LOTE_TXT = sql.raw(
  `COALESCE(NULLIF(TRIM(it.lot_number), ''), substring(it.product_name from '[Ll][Oo][Tt][Ee]:[[:space:]]*(.+)$'))`,
);
const CFOP_FORA = sql.raw(CFOP_TRANSFERENCIA.map((c) => `'${c}'`).join(","));

export function registerRastreabilidadeLoteRoutes(app: Express) {
  const guard = [authenticateUser, requireRole(PAPEIS)];

  // Produtos que já saíram em NF com lote (para o seletor) e, se ?productId=,
  // os lotes conhecidos desse produto (NF + estoque) para sugerir no campo.
  app.get("/api/rastreabilidade-lote/opcoes", ...guard, async (req: any, res) => {
    try {
      const productId = req.query.productId ? String(req.query.productId) : null;
      const produtos = rowsOf(await db.execute(sql`
        SELECT p.id, p.name
          FROM products p
         WHERE p.id IN (SELECT l.product_id FROM inventory_lots l
                        UNION
                        SELECT it.product_id FROM fiscal_invoice_items it WHERE COALESCE(it.lot_number, '') <> '')
         ORDER BY p.name
      `)).map((p) => ({ id: String(p.id), name: String(p.name || "") }));

      let lotes: string[] = [];
      if (productId) {
        const r = rowsOf(await db.execute(sql`
          SELECT DISTINCT UPPER(TRIM(regexp_replace(t.tok, '[[:space:]]*[(].*$', ''))) AS lote
            FROM fiscal_invoice_items it
            JOIN fiscal_invoices fi ON fi.id = it.invoice_id
            , LATERAL regexp_split_to_table(${LOTE_TXT}, '[[:space:]]*[/,;][[:space:]]*') AS t(tok)
           WHERE it.product_id = ${productId} AND fi.environment = 'producao'
          UNION
          SELECT DISTINCT UPPER(TRIM(l.lot_number)) FROM inventory_lots l WHERE l.product_id = ${productId}
        `));
        lotes = Array.from(new Set(r.map((x) => String(x.lote || "").trim()).filter(Boolean)))
          .sort((a, b) => b.localeCompare(a));
      }
      res.json({ produtos, lotes });
    } catch (e: any) {
      console.error("[RASTREABILIDADE] opcoes:", e?.message);
      res.status(500).json({ message: e?.message || String(e) });
    }
  });

  // =========================================================================
  // LINHA DO TEMPO DO LOTE (22/out/2026) — rastreamento do começo ao fim:
  //   produção (OP) → saídas da fábrica por NF (inclusive transferência) →
  //   entrada bloqueada na filial → recebimento/conferência (quem, quanto) →
  //   saídas da filial por NF → saldos atuais; mais TODOS os movimentos de
  //   estoque do lote e as DIVERGÊNCIAS encontradas entre NF, movimentos e saldo.
  // GET /api/rastreabilidade-lote/linha-do-tempo?lote=H051026&productId=...
  // =========================================================================
  app.get("/api/rastreabilidade-lote/linha-do-tempo", ...guard, async (req: any, res) => {
    try {
      const lote = String(req.query.lote || "").trim();
      if (normLote(lote).length < 2) return res.status(400).json({ message: "Informe o lote." });
      const productId = req.query.productId ? String(req.query.productId) : null;
      const alvo = normLote(lote);
      const like = `%${lote.toUpperCase()}%`;
      const TRF = CFOP_TRANSFERENCIA;

      // 1) Produção: ordens com esse número de lote.
      const producao = rowsOf(await db.execute(sql`
        SELECT po.id, po.order_number, po.product_id, po.product_name, po.quantity::float8 AS quantity, po.instance_name, po.status,
               po.production_date, po.end_date, po.lot_expiry_date, po.lot_number, po.created_by,
               (SELECT COALESCE(SUM(m.quantity::float8), 0) FROM inventory_movements m
                 WHERE m.source_type = 'order' AND m.source_id = po.id AND m.movement_type = 'replenish'
                   AND COALESCE(m.notes, '') NOT LIKE '%[estornado]%') AS qtd_lancada
          FROM production_orders po
         WHERE UPPER(REPLACE(TRIM(COALESCE(po.lot_number, '')), ' ', '')) = ${alvo}
           AND (${productId}::text IS NULL OR po.product_id = ${productId}::text)
         ORDER BY po.created_at ASC`));

      // 2) Lotes (linhas) com esse número, em todas as instâncias.
      const lotes = rowsOf(await db.execute(sql`
        SELECT l.id, l.product_id, p.name AS product_name, l.instance_id, COALESCE(oi.display_name, oi.name) AS instancia, oi.name AS inst_code,
               l.stock_type, l.quantity::float8 AS quantity, l.is_active, l.unit_cost::float8 AS unit_cost, l.production_order_id, l.notes,
               l.desbloqueado_por_nome, l.desbloqueado_em, l.recebimento_id, l.created_at, l.updated_at
          FROM inventory_lots l
          LEFT JOIN products p ON p.id = l.product_id
          LEFT JOIN omie_instances oi ON oi.id = l.instance_id
         WHERE UPPER(REPLACE(TRIM(l.lot_number), ' ', '')) = ${alvo}
           AND (${productId}::text IS NULL OR l.product_id = ${productId}::text)
         ORDER BY oi.name, l.created_at ASC`));
      const lotIds = lotes.map((l) => String(l.id));

      // 3) Movimentos de estoque dos lotes (todos), com NF/pedido resolvidos.
      const movimentos = lotIds.length ? rowsOf(await db.execute(sql`
        SELECT m.id, m.lot_id, m.product_id, m.instance_id, COALESCE(oi.display_name, oi.name) AS instancia, oi.name AS inst_code,
               m.movement_type, m.quantity::float8 AS quantity, m.previous_quantity::float8 AS previous_quantity, m.new_quantity::float8 AS new_quantity,
               m.source_type, m.source_id, m.notes, m.created_by, m.created_at,
               l.stock_type AS lot_stock_type,
               bp.order_number AS pedido, bp.sales_card_id,
               COALESCE(fi.id, fi2.id) AS nf_id, COALESCE(fi.invoice_number, fi2.invoice_number) AS nf_numero, COALESCE(fi.status, fi2.status) AS nf_status,
               COALESCE(fi.cfop, fi2.cfop) AS nf_cfop, COALESCE(fi.nature_of_operation, fi2.nature_of_operation) AS nf_natureza,
               COALESCE(fi.customer_name, fi2.customer_name) AS nf_cliente
          FROM inventory_movements m
          JOIN inventory_lots l ON l.id = m.lot_id
          LEFT JOIN omie_instances oi ON oi.id = m.instance_id
          LEFT JOIN fiscal_invoices fi ON m.source_type = 'invoice' AND fi.id = m.source_id
          LEFT JOIN billing_pipeline bp ON m.source_type = 'invoice' AND fi.id IS NULL AND bp.id = m.source_id
          LEFT JOIN LATERAL (
            SELECT f.* FROM fiscal_invoices f
             WHERE bp.sales_card_id IS NOT NULL AND f.sales_card_id = bp.sales_card_id AND f.environment = 'producao'
             ORDER BY CASE f.status WHEN 'authorized' THEN 0 WHEN 'returned' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END, f.created_at DESC
             LIMIT 1) fi2 ON true
         WHERE m.lot_id IN (${sql.join(lotIds.map((i) => sql`${i}`), sql`, `)})
         ORDER BY m.created_at ASC, m.id`)) : [];

      // 4) Notas fiscais (TODAS, inclusive transferências) com o lote no item.
      const notas = rowsOf(await db.execute(sql`
        WITH itens AS (
          SELECT fi.id AS invoice_id, fi.invoice_number, fi.series, fi.status, fi.operation_type, fi.nature_of_operation,
                 fi.customer_name, fi.customer_cnpj_cpf, fi.customer_city, fi.customer_uf, fi.issuer_cnpj, fi.omie_instance_id, fi.created_at,
                 fi.sales_card_id,
                 COALESCE(fi.emission_date, fi.authorization_date, fi.created_at) AS data_nf,
                 COALESCE(NULLIF(it.cfop, ''), fi.cfop) AS cfop,
                 it.id AS item_id, it.item_number, it.product_id, it.product_name, it.quantity::float8 AS quantity,
                 ${LOTE_TXT} AS lote_txt
            FROM fiscal_invoice_items it
            JOIN fiscal_invoices fi ON fi.id = it.invoice_id
           WHERE fi.environment = 'producao'
             AND fi.status IN ('authorized', 'returned', 'cancelled', 'processing')
             AND (${productId}::text IS NULL OR it.product_id = ${productId}::text)
             AND (UPPER(COALESCE(it.lot_number, '')) LIKE ${like} OR UPPER(it.product_name) LIKE ${like})
        ), tok AS (
          SELECT i.*, t.tok, COUNT(*) OVER (PARTITION BY i.item_id) AS n_lotes
            FROM itens i, LATERAL regexp_split_to_table(i.lote_txt, '[[:space:]]*[/,;][[:space:]]*') AS t(tok)
        )
        SELECT tok.*,
               NULLIF(replace(substring(tok.tok from '[(]([0-9.,]+)[)]'), ',', '.'), '')::numeric::float8 AS qtd_lote,
               COALESCE(oi.display_name, oi2.display_name, oi.name, oi2.name) AS inst_nome, COALESCE(oi.name, oi2.name) AS inst_code
          FROM tok
          LEFT JOIN omie_instances oi ON oi.id = tok.omie_instance_id
          LEFT JOIN omie_instances oi2 ON oi.id IS NULL AND COALESCE(oi2.cnpj, '') <> ''
               AND regexp_replace(oi2.cnpj, '[^0-9]', '', 'g') = regexp_replace(COALESCE(tok.issuer_cnpj, ''), '[^0-9]', '', 'g')
         WHERE UPPER(regexp_replace(regexp_replace(tok.tok, '[[:space:]]*[(].*$', ''), '[[:space:]]+', '', 'g')) = ${alvo}
         ORDER BY data_nf ASC, tok.invoice_number ASC, tok.item_number`));
      const ehTrf = (x: any) => TRF.includes(String(x.cfop || "").replace(/\D/g, "")) || String(x.nature_of_operation || "").toUpperCase().includes("TRANSF");
      const nfs = notas.map((x) => {
        const nLotes = Number(x.n_lotes || 1);
        const qtdLote = x.qtd_lote != null ? num(x.qtd_lote) : nLotes === 1 ? num(x.quantity) : null;
        const entrada = String(x.operation_type || "saida") === "entrada";
        return {
          invoiceId: String(x.invoice_id), numero: x.invoice_number != null ? Number(x.invoice_number) : null, serie: String(x.series || ""),
          data: x.data_nf, status: String(x.status), tipo: entrada ? "entrada" : "saida", cfop: String(x.cfop || ""), natureza: String(x.nature_of_operation || ""),
          transferencia: ehTrf(x), instancia: String(x.inst_nome || "") || "(não identificada)", instCode: String(x.inst_code || ""),
          cliente: String(x.customer_name || ""), clienteDoc: String(x.customer_cnpj_cpf || ""), cidade: [x.customer_city, x.customer_uf].filter(Boolean).join("/"),
          produto: String(x.product_name || "").replace(/\s*-\s*lote:.*$/i, ""), productId: x.product_id ? String(x.product_id) : null,
          qtdItem: num(x.quantity), qtdLote, lotesDoItem: String(x.lote_txt || ""), salesCardId: x.sales_card_id ? String(x.sales_card_id) : null,
          sinal: entrada ? -1 : 1,
        };
      });

      // 5) Recebimentos (conferências) do lote.
      let recebimentos: any[] = [];
      try {
        recebimentos = rowsOf(await db.execute(sql`
          SELECT * FROM lote_recebimentos WHERE UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${alvo}
             AND (${productId}::text IS NULL OR product_id = ${productId}::text) ORDER BY created_at ASC`));
      } catch { recebimentos = []; }

      // 6) Balanço por instância pelos movimentos (recalculado) × saldo gravado.
      const porInst = new Map<string, any>();
      const instDe = (code: string, nome: string) => {
        const k = code || nome || "?";
        if (!porInst.has(k)) porInst.set(k, { instancia: nome || code, code: k, producao: 0, entradasTransferencia: 0, ajustes: 0, estornos: 0, consumos: 0, bloqueiosLiquido: 0, saldoRecalculado: 0, saldoEmUso: 0, saldoBloqueado: 0, nfSaida: 0, nfSaidaTransf: 0, nfEntrada: 0 });
        return porInst.get(k);
      };
      for (const l of lotes) {
        const b = instDe(String(l.inst_code || ""), String(l.instancia || ""));
        if (l.stock_type === "in_use") b.saldoEmUso += num(l.quantity); else b.saldoBloqueado += num(l.quantity);
      }
      const vivo = (m: any) => !/\[estornado\]|\[estorno-transferencia\]/.test(String(m.notes || ""));
      for (const m of movimentos) {
        const b = instDe(String(m.inst_code || ""), String(m.instancia || ""));
        const q = num(m.quantity), t = String(m.movement_type);
        if (t === "replenish") { if (m.source_type === "order") b.producao += q; else b.entradasTransferencia += q; b.saldoRecalculado += q; }
        else if (t === "consume") { if (vivo(m)) { b.consumos += Math.abs(q); b.saldoRecalculado -= Math.abs(q); } }
        else if (t === "adjust") { b.ajustes += q; b.saldoRecalculado += q; }
        else if (t === "cancel_reversal") { b.estornos += q; b.saldoRecalculado += q; }
        else if (t === "block" || t === "unblock" || t === "transfer") { /* troca de tipo dentro da mesma instância: soma zero */ }
      }
      for (const n of nfs) {
        if (n.status === "cancelled" || n.qtdLote == null) continue;
        const b = instDe(n.instCode, n.instancia);
        if (n.tipo === "entrada") b.nfEntrada += n.qtdLote;
        else if (n.transferencia) b.nfSaidaTransf += n.qtdLote; else b.nfSaida += n.qtdLote;
      }

      // 7) Divergências.
      const divergencias: Array<{ tipo: string; gravidade: "alta" | "media" | "info"; texto: string; ref?: any }> = [];
      const r2 = (v: number) => Math.round(v * 100) / 100;
      // 7a) saldo recalculado × gravado
      for (const b of Array.from(porInst.values())) {
        const gravado = b.saldoEmUso + b.saldoBloqueado;
        if (Math.abs(b.saldoRecalculado - gravado) > 0.001) {
          divergencias.push({ tipo: "saldo", gravidade: "alta", texto: `${b.instancia}: saldo gravado ${r2(gravado)} ≠ saldo recalculado pelos movimentos ${r2(b.saldoRecalculado)} (diferença ${r2(gravado - b.saldoRecalculado)}).` });
        }
      }
      // 7b) NF autorizada de saída com lote sem consumo correspondente (por NF)
      const consumoPorNf = new Map<string, number>();
      for (const m of movimentos) {
        if (String(m.movement_type) !== "consume" || !vivo(m)) continue;
        const k = m.nf_id ? String(m.nf_id) : `src:${m.source_id}`;
        consumoPorNf.set(k, (consumoPorNf.get(k) || 0) + Math.abs(num(m.quantity)));
      }
      const nfPorId = new Map<string, { numero: number | null; inst: string; qtd: number; status: string; transf: boolean; entrada: boolean }>();
      for (const n of nfs) {
        const e = nfPorId.get(n.invoiceId) || { numero: n.numero, inst: n.instancia, qtd: 0, status: n.status, transf: n.transferencia, entrada: n.tipo === "entrada" };
        if (n.qtdLote != null) e.qtd += n.qtdLote;
        nfPorId.set(n.invoiceId, e);
      }
      const nfsVistas = new Set<string>();
      for (const [id, e] of Array.from(nfPorId.entries())) {
        nfsVistas.add(id);
        if (e.entrada) continue;
        const cons = consumoPorNf.get(id);
        if (e.status === "authorized" || e.status === "returned") {
          if (cons == null) divergencias.push({ tipo: "nf_sem_baixa", gravidade: "alta", texto: `NF-e ${e.numero ?? "(s/nº)"} (${e.inst}) saiu com ${r2(e.qtd)} un do lote, mas não há baixa de estoque ligada a ela (consumo pode estar ligado ao card do pedido — verificar).`, ref: { invoiceId: id } });
          else if (Math.abs(cons - e.qtd) > 0.001) divergencias.push({ tipo: "nf_qtd", gravidade: "alta", texto: `NF-e ${e.numero ?? "(s/nº)"} (${e.inst}): ${r2(e.qtd)} un do lote na nota × ${r2(cons)} un baixadas do estoque.`, ref: { invoiceId: id } });
        } else if (e.status === "cancelled" && cons != null && cons > 0.001) {
          divergencias.push({ tipo: "nf_cancelada_com_baixa", gravidade: "alta", texto: `NF-e ${e.numero ?? "(s/nº)"} (${e.inst}) está CANCELADA mas a baixa de ${r2(cons)} un do lote continua viva (não estornada).`, ref: { invoiceId: id } });
        }
      }
      // 7c) consumo vivo sem NF autorizada
      for (const [k, q] of Array.from(consumoPorNf.entries())) {
        if (nfsVistas.has(k)) continue;
        const m = movimentos.find((x) => String(x.movement_type) === "consume" && (x.nf_id ? String(x.nf_id) === k : `src:${x.source_id}` === k));
        const st = m?.nf_status ? String(m.nf_status) : null;
        if (st === "authorized" || st === "returned") {
          divergencias.push({ tipo: "baixa_nf_sem_lote", gravidade: "media", texto: `Baixa de ${r2(q)} un (${m?.instancia}) ligada à NF-e ${m?.nf_numero ?? "?"}, mas a nota não traz este lote no item (lote não registrado na NF).`, ref: { invoiceId: m?.nf_id } });
        } else {
          divergencias.push({ tipo: "baixa_sem_nf", gravidade: "alta", texto: `Baixa de ${r2(q)} un (${m?.instancia}) sem NF-e autorizada (pedido ${m?.pedido || m?.source_id || "?"}${st ? ", NF " + st : ""}) — mercadoria saiu do estoque sem documento fiscal vivo.`, ref: { sourceId: m?.source_id } });
        }
      }
      // 7d) transferências: saída origem × entrada destino × recebido
      const saidaTrf = Array.from(porInst.values()).reduce((s, b) => s + b.nfSaidaTransf, 0);
      const entradaTrf = Array.from(porInst.values()).reduce((s, b) => s + b.entradasTransferencia, 0);
      if (saidaTrf > 0.001 || entradaTrf > 0.001) {
        if (Math.abs(saidaTrf - entradaTrf) > 0.001) divergencias.push({ tipo: "transferencia", gravidade: "alta", texto: `Transferências: ${r2(saidaTrf)} un saíram em NF-e de transferência, mas ${r2(entradaTrf)} un entraram nas filiais.` });
      }
      for (const rc of recebimentos) {
        if (Math.abs(num(rc.divergencia)) > 0.001) divergencias.push({ tipo: "recebimento", gravidade: "media", texto: `Recebimento em ${rc.instance_name || rc.instance_id} (${new Date(rc.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}, ${rc.recebido_por_nome}): faturado ${r2(num(rc.qtd_faturada))}, recebido ${r2(num(rc.qtd_recebida))} (${num(rc.divergencia) > 0 ? "+" : ""}${r2(num(rc.divergencia))}).${rc.observacao ? " Obs.: " + rc.observacao : ""}` });
      }
      // 7e) bloqueado ainda sem conferência
      for (const b of Array.from(porInst.values())) {
        if (b.saldoBloqueado > 0.001) divergencias.push({ tipo: "bloqueado", gravidade: "info", texto: `${b.instancia}: ${r2(b.saldoBloqueado)} un bloqueadas aguardando conferência de recebimento.` });
      }
      // 7f) ajustes manuais
      for (const m of movimentos) {
        if (String(m.movement_type) === "adjust" && Math.abs(num(m.quantity)) > 0.001 && !/Lote criado com quantidade inicial/.test(String(m.notes || "")))
          divergencias.push({ tipo: "ajuste", gravidade: "info", texto: `${m.instancia}: ajuste manual de ${num(m.quantity) > 0 ? "+" : ""}${r2(num(m.quantity))} un em ${new Date(m.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} por ${m.created_by || "?"} — ${String(m.notes || "").slice(0, 160)}` });
      }
      // 7g) produção × lançado
      for (const po of producao) {
        if (Math.abs(num(po.quantity) - num(po.qtd_lancada)) > 0.001 && num(po.qtd_lancada) > 0)
          divergencias.push({ tipo: "producao", gravidade: "media", texto: `OP ${po.order_number}: produzido ${r2(num(po.quantity))} × lançado no estoque ${r2(num(po.qtd_lancada))}.` });
      }

      // 8) Destinação total (de onde veio e para onde foi cada unidade).
      const produzido = producao.reduce((s, po) => s + (num(po.qtd_lancada) > 0 ? num(po.qtd_lancada) : num(po.quantity)), 0);
      const vendido = nfs.filter((n) => n.status !== "cancelled" && !n.transferencia && n.qtdLote != null).reduce((s, n) => s + n.sinal * n.qtdLote!, 0);
      const emEstoque = lotes.reduce((s, l) => s + num(l.quantity), 0);
      const ajustesTotal = Array.from(porInst.values()).reduce((s, b) => s + b.ajustes, 0);
      const destinacao = { produzido, vendidoLiquido: r2(vendido), emEstoque: r2(emEstoque), ajustes: r2(ajustesTotal), naoExplicado: r2(produzido + ajustesTotal - vendido - emEstoque) };
      if (produzido > 0 && Math.abs(destinacao.naoExplicado) > 0.5) divergencias.unshift({ tipo: "destinacao", gravidade: "alta", texto: `Destinação: produzido ${r2(produzido)} + ajustes ${r2(ajustesTotal)} − vendido/trocado/amostra (líquido) ${r2(vendido)} − em estoque ${r2(emEstoque)} = ${destinacao.naoExplicado} un sem destino explicado.` });

      res.json({
        geradoEm: new Date().toISOString(), lote: alvo, productId,
        producao: producao.map((po) => ({ ...po, quantity: num(po.quantity), qtdLancada: num(po.qtd_lancada) })),
        lotes: lotes.map((l) => ({ ...l, quantity: num(l.quantity) })),
        movimentos: movimentos.map((m) => ({ ...m, quantity: num(m.quantity), previous_quantity: m.previous_quantity != null ? num(m.previous_quantity) : null, new_quantity: m.new_quantity != null ? num(m.new_quantity) : null, vivo: vivo(m) })),
        notas: nfs, recebimentos,
        balanco: Array.from(porInst.values()).map((b) => ({ ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === "number" ? r2(v) : v])) })),
        destinacao, divergencias,
      });
    } catch (e: any) {
      console.error("[RASTREABILIDADE] linha-do-tempo:", e?.message);
      res.status(500).json({ message: e?.message || String(e) });
    }
  });

  // GET /api/rastreabilidade-lote?lote=H051026&productId=...&incluirCanceladas=1
  app.get("/api/rastreabilidade-lote", ...guard, async (req: any, res) => {
    try {
      const lote = String(req.query.lote || "").trim();
      if (normLote(lote).length < 2) return res.status(400).json({ message: "Informe o lote." });
      const productId = req.query.productId ? String(req.query.productId) : null;
      const incluirCanceladas = ["1", "true", "sim"].includes(String(req.query.incluirCanceladas || "").toLowerCase());
      const statuses = incluirCanceladas ? ["authorized", "returned", "cancelled"] : ["authorized", "returned"];
      const alvo = normLote(lote);
      const like = `%${lote.toUpperCase()}%`;

      const r = rowsOf(await db.execute(sql`
        WITH itens AS (
          SELECT fi.id AS invoice_id, fi.invoice_number, fi.series, fi.status, fi.operation_type,
                 fi.nature_of_operation, fi.fin_nfe, fi.customer_id, fi.customer_name, fi.customer_cnpj_cpf,
                 fi.customer_city, fi.customer_uf, fi.access_key, fi.issuer_cnpj, fi.issuer_name,
                 fi.omie_instance_id, fi.created_at, fi.cancellation_date,
                 COALESCE(fi.emission_date, fi.authorization_date, fi.created_at) AS data_nf,
                 COALESCE(NULLIF(it.cfop, ''), fi.cfop) AS cfop,
                 it.id AS item_id, it.item_number, it.product_id, it.product_name,
                 it.quantity, it.unit_price, it.total_price,
                 ${LOTE_TXT} AS lote_txt
            FROM fiscal_invoice_items it
            JOIN fiscal_invoices fi ON fi.id = it.invoice_id
           WHERE fi.environment = 'producao'
             AND fi.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})
             AND (${productId}::text IS NULL OR it.product_id = ${productId}::text)
             AND (UPPER(COALESCE(it.lot_number, '')) LIKE ${like} OR UPPER(it.product_name) LIKE ${like})
             AND regexp_replace(COALESCE(NULLIF(it.cfop, ''), fi.cfop, ''), '[^0-9]', '', 'g') NOT IN (${CFOP_FORA})
             AND UPPER(COALESCE(fi.nature_of_operation, '')) NOT LIKE '%TRANSF%'
        ), tok AS (
          SELECT i.*, t.tok, COUNT(*) OVER (PARTITION BY i.item_id) AS n_lotes
            FROM itens i, LATERAL regexp_split_to_table(i.lote_txt, '[[:space:]]*[/,;][[:space:]]*') AS t(tok)
        )
        SELECT tok.*,
               UPPER(regexp_replace(regexp_replace(tok.tok, '[[:space:]]*[(].*$', ''), '[[:space:]]+', '', 'g')) AS lote,
               NULLIF(replace(substring(tok.tok from '[(]([0-9.,]+)[)]'), ',', '.'), '')::numeric AS qtd_lote,
               COALESCE(oi.display_name, oi2.display_name) AS inst_nome,
               COALESCE(oi.id, oi2.id) AS inst_id,
               p.name AS produto_cadastro
          FROM tok
          LEFT JOIN omie_instances oi ON oi.id = tok.omie_instance_id
          LEFT JOIN omie_instances oi2 ON oi.id IS NULL
               AND COALESCE(oi2.cnpj, '') <> ''
               AND regexp_replace(oi2.cnpj, '[^0-9]', '', 'g') = regexp_replace(COALESCE(tok.issuer_cnpj, ''), '[^0-9]', '', 'g')
          LEFT JOIN products p ON p.id = tok.product_id
         WHERE UPPER(regexp_replace(regexp_replace(tok.tok, '[[:space:]]*[(].*$', ''), '[[:space:]]+', '', 'g')) = ${alvo}
         ORDER BY data_nf DESC, tok.invoice_number DESC, tok.item_number
      `));

      // Uma NF por (CNPJ emitente, série, número, entrada/saída): fica o registro mais recente.
      const chaveNf = (x: any) => [
        String(x.issuer_cnpj || "").replace(/\D/g, ""), String(x.series || ""),
        x.invoice_number != null ? String(x.invoice_number) : `id:${x.invoice_id}`, String(x.operation_type || "saida"),
      ].join("|");
      const vencedora = new Map<string, { id: string; created: number }>();
      for (const x of r) {
        const k = chaveNf(x), c = new Date(x.created_at).getTime();
        const v = vencedora.get(k);
        if (!v || c > v.created) vencedora.set(k, { id: String(x.invoice_id), created: c });
      }

      const linhas = r
        .filter((x) => vencedora.get(chaveNf(x))?.id === String(x.invoice_id))
        .map((x) => {
          const qtdItem = num(x.quantity);
          const nLotes = Number(x.n_lotes || 1);
          // Lote único no item → a quantidade do item é toda do lote.
          // Vários lotes com "(qtd)" → a quantidade do lote. Vários sem qtd → desconhecida.
          const qtdLote = x.qtd_lote != null ? num(x.qtd_lote) : nLotes === 1 ? qtdItem : null;
          const entrada = String(x.operation_type || "saida") === "entrada";
          return {
            invoiceId: String(x.invoice_id),
            numero: x.invoice_number != null ? Number(x.invoice_number) : null,
            serie: x.series ? String(x.series) : "",
            data: x.data_nf,
            status: String(x.status),
            tipo: entrada ? "entrada" : "saida",
            cfop: String(x.cfop || ""),
            natureza: String(x.nature_of_operation || ""),
            instancia: String(x.inst_nome || "") || "(não identificada)",
            instanciaId: x.inst_id ? String(x.inst_id) : null,
            emitenteCnpj: String(x.issuer_cnpj || ""),
            cliente: String(x.customer_name || ""),
            clienteId: x.customer_id ? String(x.customer_id) : null,
            clienteDoc: String(x.customer_cnpj_cpf || ""),
            cidade: [x.customer_city, x.customer_uf].filter(Boolean).join("/"),
            chave: String(x.access_key || ""),
            productId: x.product_id ? String(x.product_id) : null,
            produto: String(x.produto_cadastro || String(x.product_name || "").replace(/\s*-\s*lote:.*$/i, "")),
            lote: String(x.lote || ""),
            lotesDoItem: String(x.lote_txt || ""),
            qtdItem,
            qtdLote,
            // Sinal para o saldo: saída tira do mercado (+), entrada (devolução) volta (−).
            sinal: entrada ? -1 : 1,
            valorUnit: num(x.unit_price),
          };
        });

      res.json({ geradoEm: new Date().toISOString(), lote: alvo, productId, incluirCanceladas, linhas });
    } catch (e: any) {
      console.error("[RASTREABILIDADE] consulta:", e?.message);
      res.status(500).json({ message: e?.message || String(e) });
    }
  });
}
