// ---------------------------------------------------------------------------
// DESTINO DAS ENTRADAS DE ESTOQUE (Flavio, 23/out/2026)
// ---------------------------------------------------------------------------
// "Preciso conferir o destino de todos os itens que deram entrada no estoque,
// com a nota fiscal correspondente de saída."
//
// Livro ENTRADA → SAÍDA por (produto, instância, lote):
//   ENTRADAS: produção (OP), transferência recebida (NF-e/pedido de origem),
//             compra (NF de entrada), ajuste manual positivo, estorno (NF
//             cancelada/devolvida que devolveu unidades ao lote), criação de lote.
//   SAÍDAS:   cada NF de saída que consumiu o lote (nº, série, data, destinatário,
//             CFOP/natureza, status, quantidade), inclusive transferências para
//             outra filial; baixa viva SEM NF autorizada aparece marcada;
//             ajuste manual negativo.
//   SALDO:    em uso + bloqueado hoje.
//   FECHAMENTO: entradas − saídas com NF − saídas sem NF − ajustes(−) − saldo
//             = "sem destino explicado" (deve ser 0).
//
// Só leitura. Base: inventory_movements (trilha), inventory_lots (saldo),
// fiscal_invoices / billing_pipeline (resolução da NF de cada baixa), production_orders,
// purchase_invoices, lote_recebimentos.
// GET /api/destino-estoque?de=AAAA-MM-DD&ate=AAAA-MM-DD&instanceId=&productId=&somenteAbertos=1
//   `de`/`ate` filtram pela data da ENTRADA (lote cuja primeira entrada cai no período).
// ---------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { CFOP_TRANSFERENCIA } from "./rastreabilidade-lote-routes";

const PAPEIS = ["admin", "coordinator", "administrative", "industria"];
const rowsOf = (r: any): any[] => (r?.rows || r || []) as any[];
const num = (v: any) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const VIVO = sql.raw(`COALESCE(m.notes, '') NOT LIKE '%[estornado]%' AND COALESCE(m.notes, '') NOT LIKE '%[estorno-transferencia]%'`);

export type Entrada = { tipo: "producao" | "transferencia" | "compra" | "ajuste" | "estorno" | "criacao" | "desconhecida"; data: string; quantidade: number; ref: string; refId: string | null; detalhe: string; por: string | null };
export type Saida = { tipo: "nf" | "sem_nf" | "ajuste"; data: string; quantidade: number; nfId: string | null; nfNumero: number | null; nfSerie: string | null; nfStatus: string | null; cfop: string | null; natureza: string | null; transferencia: boolean; destinatario: string | null; destinatarioDoc: string | null; instanciaEmissora: string | null; pedido: string | null; detalhe: string; nfTemLote: boolean | null };
export type GrupoLote = {
  chave: string; productId: string; produto: string; instanceId: string; instancia: string; lote: string;
  primeiraEntrada: string | null; entradas: Entrada[]; saidas: Saida[];
  totais: { entradas: number; saidasNf: number; saidasSemNf: number; ajustesNeg: number; saldoEmUso: number; saldoBloqueado: number; naoExplicado: number };
  situacao: "fechado" | "em_estoque" | "divergente";
  alertas: string[];
};

export function registerDestinoEstoqueRoutes(app: Express) {
  const guard = [authenticateUser, requireRole(PAPEIS)];

  app.get("/api/destino-estoque", ...guard, async (req: any, res) => {
    try {
      const hoje = new Date();
      const de = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de || "")) ? String(req.query.de) : new Date(hoje.getTime() - 60 * 86400000).toISOString().slice(0, 10);
      const ate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ate || "")) ? String(req.query.ate) : hoje.toISOString().slice(0, 10);
      const instanceId = req.query.instanceId ? String(req.query.instanceId) : null;
      const productId = req.query.productId ? String(req.query.productId) : null;
      const somenteAbertos = ["1", "true", "sim"].includes(String(req.query.somenteAbertos || "").toLowerCase());

      // Grupos (produto, instância, lote) com alguma ENTRADA no período.
      // + lotes SEM nenhuma entrada registrada (criados fora da trilha) cuja criação cai no
      //   período: aparecem como divergentes ("sem entrada registrada").
      const grupos = rowsOf(await db.execute(sql`
        WITH com_entrada AS (
          SELECT l.product_id, l.instance_id, UPPER(REPLACE(TRIM(l.lot_number), ' ', '')) AS lote,
                 MIN(m.created_at) AS primeira_entrada
            FROM inventory_movements m
            JOIN inventory_lots l ON l.id = m.lot_id
           WHERE (m.movement_type = 'replenish' OR (m.movement_type IN ('adjust', 'cancel_reversal') AND m.quantity > 0))
             AND ${VIVO}
           GROUP BY 1, 2, 3
        ), sem_entrada AS (
          SELECT l.product_id, l.instance_id, UPPER(REPLACE(TRIM(l.lot_number), ' ', '')) AS lote, MIN(l.created_at) AS primeira_entrada
            FROM inventory_lots l
           WHERE NOT EXISTS (SELECT 1 FROM com_entrada c WHERE c.product_id = l.product_id AND c.instance_id = l.instance_id AND c.lote = UPPER(REPLACE(TRIM(l.lot_number), ' ', '')))
             AND (l.quantity > 0 OR EXISTS (SELECT 1 FROM inventory_movements m WHERE m.lot_id = l.id AND m.movement_type = 'consume'))
           GROUP BY 1, 2, 3
        ), todos AS (SELECT * FROM com_entrada UNION ALL SELECT * FROM sem_entrada)
        SELECT * FROM todos t
         WHERE (${instanceId}::text IS NULL OR t.instance_id = ${instanceId}::text)
           AND (${productId}::text IS NULL OR t.product_id = ${productId}::text)
           AND (t.primeira_entrada AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${de}::date AND ${ate}::date
         ORDER BY t.primeira_entrada DESC`));
      if (!grupos.length) return res.json({ de, ate, grupos: [], resumo: resumoDe([]) });

      // Todos os lotes (linhas) desses grupos.
      const chaves = grupos.map((g) => `${g.product_id}|${g.instance_id}|${g.lote}`);
      const lotes = rowsOf(await db.execute(sql`
        SELECT l.id, l.product_id, l.instance_id, UPPER(REPLACE(TRIM(l.lot_number), ' ', '')) AS lote, l.stock_type, l.quantity::float8 AS quantity, l.is_active,
               p.name AS produto, COALESCE(oi.display_name, oi.name) AS instancia
          FROM inventory_lots l
          LEFT JOIN products p ON p.id = l.product_id
          LEFT JOIN omie_instances oi ON oi.id = l.instance_id
         WHERE (l.product_id || '|' || l.instance_id || '|' || UPPER(REPLACE(TRIM(l.lot_number), ' ', ''))) IN (${sql.join(chaves.map((c) => sql`${c}`), sql`, `)})`));
      const lotIds = lotes.map((l) => String(l.id));
      const chaveDoLote = new Map(lotes.map((l) => [String(l.id), `${l.product_id}|${l.instance_id}|${l.lote}`]));

      // Movimentos dos lotes, com NF/pedido/OP/compra resolvidos.
      const movs = lotIds.length ? rowsOf(await db.execute(sql`
        SELECT m.id, m.lot_id, m.movement_type, m.quantity::float8 AS quantity, m.source_type, m.source_id, m.notes, m.created_by, m.created_at,
               (${VIVO}) AS vivo,
               po.order_number AS op_numero, po.production_date AS op_data,
               bp.order_number AS pedido, bp.sales_card_id, bp.omie_instance_name AS pedido_inst, bp.operation_type AS pedido_tipo,
               COALESCE(fi.id, fi2.id) AS nf_id, COALESCE(fi.invoice_number, fi2.invoice_number) AS nf_numero, COALESCE(fi.series, fi2.series) AS nf_serie,
               COALESCE(fi.status, fi2.status) AS nf_status, COALESCE(fi.cfop, fi2.cfop) AS nf_cfop, COALESCE(fi.nature_of_operation, fi2.nature_of_operation) AS nf_natureza,
               COALESCE(fi.customer_name, fi2.customer_name) AS nf_cliente, COALESCE(fi.customer_cnpj_cpf, fi2.customer_cnpj_cpf) AS nf_cliente_doc,
               COALESCE(fi.operation_type, fi2.operation_type) AS nf_op,
               COALESCE(fi.emission_date, fi.authorization_date, fi.created_at, fi2.emission_date, fi2.authorization_date, fi2.created_at) AS nf_data,
               COALESCE(oi.display_name, oi.name, oi2.display_name, oi2.name) AS nf_inst,
               pi.invoice_number AS compra_numero, pi.supplier_name AS compra_fornecedor,
               EXISTS (SELECT 1 FROM fiscal_invoice_items it WHERE it.invoice_id = COALESCE(fi.id, fi2.id) AND it.product_id = m.product_id
                         AND UPPER(COALESCE(it.lot_number, '') || ' ' || it.product_name) LIKE '%' || UPPER(REPLACE(TRIM(m.lot_number), ' ', '')) || '%') AS nf_tem_lote
          FROM inventory_movements m
          LEFT JOIN production_orders po ON m.source_type = 'order' AND po.id = m.source_id
          LEFT JOIN fiscal_invoices fi ON m.source_type = 'invoice' AND fi.id = m.source_id
          LEFT JOIN billing_pipeline bp ON m.source_type = 'invoice' AND fi.id IS NULL AND bp.id = m.source_id
          LEFT JOIN LATERAL (
            SELECT f.* FROM fiscal_invoices f
             WHERE bp.sales_card_id IS NOT NULL AND f.sales_card_id = bp.sales_card_id AND f.environment = 'producao'
             ORDER BY CASE f.status WHEN 'authorized' THEN 0 WHEN 'returned' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END, f.created_at DESC
             LIMIT 1) fi2 ON true
          LEFT JOIN omie_instances oi ON oi.id = fi.omie_instance_id
          LEFT JOIN omie_instances oi2 ON oi.id IS NULL AND oi2.id = fi2.omie_instance_id
          LEFT JOIN purchase_invoices pi ON m.source_type = 'invoice' AND fi.id IS NULL AND bp.id IS NULL AND pi.id = m.source_id
         WHERE m.lot_id IN (${sql.join(lotIds.map((i) => sql`${i}`), sql`, `)})
           AND m.movement_type IN ('replenish', 'consume', 'adjust', 'cancel_reversal')
         ORDER BY m.created_at ASC`)) : [];

      // Montagem por grupo.
      const mapa = new Map<string, GrupoLote>();
      for (const g of grupos) {
        const chave = `${g.product_id}|${g.instance_id}|${g.lote}`;
        const l0 = lotes.find((l) => `${l.product_id}|${l.instance_id}|${l.lote}` === chave);
        mapa.set(chave, {
          chave, productId: String(g.product_id), produto: String(l0?.produto || g.product_id), instanceId: String(g.instance_id), instancia: String(l0?.instancia || g.instance_id), lote: String(g.lote),
          primeiraEntrada: g.primeira_entrada || null, entradas: [], saidas: [],
          totais: { entradas: 0, saidasNf: 0, saidasSemNf: 0, ajustesNeg: 0, saldoEmUso: 0, saldoBloqueado: 0, naoExplicado: 0 }, situacao: "em_estoque", alertas: [],
        });
      }
      for (const l of lotes) {
        const gp = mapa.get(`${l.product_id}|${l.instance_id}|${l.lote}`); if (!gp) continue;
        if (l.stock_type === "in_use") gp.totais.saldoEmUso += num(l.quantity); else gp.totais.saldoBloqueado += num(l.quantity);
      }
      const ehTrf = (cfop: any, nat: any) => CFOP_TRANSFERENCIA.includes(String(cfop || "").replace(/\D/g, "")) || String(nat || "").toUpperCase().includes("TRANSF");
      // Baixas agrupadas por NF (ou por origem sem NF) dentro do grupo.
      const saidaPorNf = new Map<string, Saida>();
      for (const m of movs) {
        const gp = mapa.get(chaveDoLote.get(String(m.lot_id)) || ""); if (!gp) continue;
        const q = num(m.quantity), t = String(m.movement_type), vivo = !!m.vivo;
        if (t === "replenish") {
          if (!vivo) continue;
          let e: Entrada;
          if (m.source_type === "order") e = { tipo: "producao", data: m.created_at, quantidade: q, ref: `OP ${m.op_numero || m.source_id}`, refId: m.source_id, detalhe: m.op_data ? `produção ${new Date(m.op_data).toLocaleDateString("pt-BR", { timeZone: "UTC" })}` : "", por: m.created_by };
          else if (m.pedido || m.nf_id) e = { tipo: "transferencia", data: m.created_at, quantidade: q, ref: m.nf_numero != null ? `NF-e ${m.nf_numero}${m.nf_serie && m.nf_serie !== "1" ? "/" + m.nf_serie : ""}` : `pedido ${m.pedido}`, refId: m.nf_id || m.source_id, detalhe: `transferência ${m.pedido ? "pedido " + m.pedido : ""} de ${m.pedido_inst || m.nf_inst || "?"}${m.nf_status && m.nf_status !== "authorized" ? " [NF " + m.nf_status + "]" : ""}`, por: m.created_by };
          else if (m.compra_numero) e = { tipo: "compra", data: m.created_at, quantidade: q, ref: `NF entrada ${m.compra_numero}`, refId: m.source_id, detalhe: String(m.compra_fornecedor || ""), por: m.created_by };
          else e = { tipo: "desconhecida", data: m.created_at, quantidade: q, ref: String(m.source_id || "—"), refId: m.source_id, detalhe: String(m.notes || ""), por: m.created_by };
          gp.entradas.push(e);
        } else if (t === "adjust") {
          if (q > 0) gp.entradas.push({ tipo: /Lote criado com quantidade inicial/.test(String(m.notes || "")) ? "criacao" : "ajuste", data: m.created_at, quantidade: q, ref: "ajuste manual", refId: m.id, detalhe: String(m.notes || ""), por: m.created_by });
          else if (q < 0) gp.saidas.push({ tipo: "ajuste", data: m.created_at, quantidade: -q, nfId: null, nfNumero: null, nfSerie: null, nfStatus: null, cfop: null, natureza: null, transferencia: false, destinatario: null, destinatarioDoc: null, instanciaEmissora: null, pedido: null, detalhe: `${m.notes || "ajuste manual"}${m.created_by ? " — " + m.created_by : ""}`, nfTemLote: null });
        } else if (t === "cancel_reversal") {
          if (q > 0) gp.entradas.push({ tipo: "estorno", data: m.created_at, quantidade: q, ref: m.nf_numero != null ? `estorno NF-e ${m.nf_numero}` : "estorno", refId: m.nf_id || m.source_id, detalhe: String(m.notes || ""), por: m.created_by });
          else if (q < 0) gp.saidas.push({ tipo: "ajuste", data: m.created_at, quantidade: -q, nfId: m.nf_id || null, nfNumero: m.nf_numero ?? null, nfSerie: m.nf_serie || null, nfStatus: m.nf_status || null, cfop: null, natureza: null, transferencia: false, destinatario: null, destinatarioDoc: null, instanciaEmissora: null, pedido: m.pedido || null, detalhe: `estorno de entrada — ${m.notes || ""}`, nfTemLote: null });
        } else if (t === "consume") {
          if (!vivo) continue;
          const temNf = !!m.nf_id && ["authorized", "returned"].includes(String(m.nf_status));
          const k = `${gp.chave}|${temNf ? "nf:" + m.nf_id : "src:" + (m.nf_id || m.source_id)}`;
          const ex = saidaPorNf.get(k);
          if (ex) { ex.quantidade += Math.abs(q); continue; }
          const s: Saida = {
            tipo: temNf ? "nf" : "sem_nf", data: m.nf_data || m.created_at, quantidade: Math.abs(q),
            nfId: m.nf_id || null, nfNumero: m.nf_numero ?? null, nfSerie: m.nf_serie || null, nfStatus: m.nf_status || null,
            cfop: m.nf_cfop || null, natureza: m.nf_natureza || null, transferencia: ehTrf(m.nf_cfop, m.nf_natureza) || String(m.pedido_tipo || "").toLowerCase() === "transferencia",
            destinatario: m.nf_cliente || null, destinatarioDoc: m.nf_cliente_doc || null, instanciaEmissora: m.nf_inst || m.pedido_inst || null, pedido: m.pedido || null,
            detalhe: temNf ? "" : (m.nf_id ? `NF ${m.nf_status} — baixa continua viva` : `pedido ${m.pedido || m.source_id} sem NF-e autorizada`),
            nfTemLote: temNf ? !!m.nf_tem_lote : null,
          };
          saidaPorNf.set(k, s); gp.saidas.push(s);
        }
      }

      // Totais, fechamento, situação.
      const out: GrupoLote[] = [];
      for (const gp of Array.from(mapa.values())) {
        const t = gp.totais;
        t.entradas = r2(gp.entradas.reduce((s, e) => s + e.quantidade, 0));
        t.saidasNf = r2(gp.saidas.filter((s) => s.tipo === "nf").reduce((s, x) => s + x.quantidade, 0));
        t.saidasSemNf = r2(gp.saidas.filter((s) => s.tipo === "sem_nf").reduce((s, x) => s + x.quantidade, 0));
        t.ajustesNeg = r2(gp.saidas.filter((s) => s.tipo === "ajuste").reduce((s, x) => s + x.quantidade, 0));
        t.saldoEmUso = r2(t.saldoEmUso); t.saldoBloqueado = r2(t.saldoBloqueado);
        t.naoExplicado = r2(t.entradas - t.saidasNf - t.saidasSemNf - t.ajustesNeg - t.saldoEmUso - t.saldoBloqueado);
        if (Math.abs(t.naoExplicado) > 0.01) gp.alertas.push(`${t.naoExplicado > 0 ? "+" : ""}${t.naoExplicado} un sem destino explicado (entradas ≠ saídas + saldo)`);
        if (t.saidasSemNf > 0) gp.alertas.push(`${t.saidasSemNf} un baixadas sem NF-e autorizada`);
        for (const s of gp.saidas) if (s.tipo === "nf" && s.nfTemLote === false) gp.alertas.push(`NF-e ${s.nfNumero}: ${s.quantidade} un baixadas deste lote, mas a nota não traz o lote no item`);
        if (t.ajustesNeg > 0) gp.alertas.push(`${t.ajustesNeg} un retiradas por ajuste manual (sem NF)`);
        if (gp.entradas.some((e) => e.tipo === "desconhecida")) gp.alertas.push("entrada de origem não identificada");
        if (!gp.entradas.length) gp.alertas.unshift("lote sem nenhuma entrada registrada na trilha (criado fora do sistema de movimentos)");
        gp.saidas.sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
        gp.situacao = gp.alertas.length ? "divergente" : (t.saldoEmUso + t.saldoBloqueado > 0.01 ? "em_estoque" : "fechado");
        if (somenteAbertos && gp.situacao === "fechado") continue;
        out.push(gp);
      }
      res.json({ geradoEm: new Date().toISOString(), de, ate, instanceId, productId, grupos: out, resumo: resumoDe(out) });
    } catch (e: any) {
      console.error("[DESTINO-ESTOQUE]", e?.message);
      res.status(500).json({ message: e?.message || String(e) });
    }
  });
}

function resumoDe(gs: GrupoLote[]) {
  const s = { lotes: gs.length, divergentes: 0, emEstoque: 0, fechados: 0, entradas: 0, saidasNf: 0, saidasSemNf: 0, ajustesNeg: 0, saldo: 0, naoExplicado: 0, nfs: 0 };
  const nfs = new Set<string>();
  for (const g of gs) {
    s[g.situacao === "divergente" ? "divergentes" : g.situacao === "em_estoque" ? "emEstoque" : "fechados"]++;
    s.entradas += g.totais.entradas; s.saidasNf += g.totais.saidasNf; s.saidasSemNf += g.totais.saidasSemNf; s.ajustesNeg += g.totais.ajustesNeg;
    s.saldo += g.totais.saldoEmUso + g.totais.saldoBloqueado; s.naoExplicado += g.totais.naoExplicado;
    for (const x of g.saidas) if (x.nfId) nfs.add(x.nfId);
  }
  s.nfs = nfs.size;
  for (const k of ["entradas", "saidasNf", "saidasSemNf", "ajustesNeg", "saldo", "naoExplicado"] as const) s[k] = r2(s[k]);
  return s;
}
