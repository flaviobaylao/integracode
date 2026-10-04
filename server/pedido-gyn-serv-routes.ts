// ---------------------------------------------------------------------------
// PEDIDO DE VENDA GYN -> SERV (botão no Pipeline de Faturamento) — 04/out/2026
// ---------------------------------------------------------------------------
// A SERV (Puro Serviços) é abastecida por NF de VENDA da GYN a preço de CMV.
// Este botão monta esse pedido sozinho:
//   necessário por produto = soma dos PEDIDOS PENDENTES da SERV no pipeline
//                            (agendado / pedido / a_faturar) − estoque atual da SERV
//   lotes                  = lotes da GYN por FIFO (em uso primeiro, depois bloqueado)
//   preço unitário         = CMV ATUAL DA INDÚSTRIA (custo do último lote produzido
//                            na IND para o produto); sem lote na IND, cai no CMV do
//                            próprio lote da GYN
// O card nasce em 'a_faturar' com operation_type='transferencia' e destino SERV:
// na emissão, billing-pipeline-routes reconhece o CNPJ raiz diferente e sai como
// VENDA 5101/6101 (natureza "...transferencia entre empresas do grupo"), e o lote
// espelho entra na SERV com cmvUnit = o mesmo preço (mirrorTransferToDestination).
//
// Rotas (admin / coordinator / administrative):
//   GET  /api/billing-pipeline/pedido-gyn-serv/preview   → o que seria pedido
//   POST /api/billing-pipeline/pedido-gyn-serv           → cria o card
//        body opcional { itens: [{ productId, quantity }] } para ajustar quantidades
// ---------------------------------------------------------------------------
import type { Express } from "express";
import { randomUUID } from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { authenticateUser, requireRole } from "./authMiddleware";

const PAPEIS = ["admin", "coordinator", "administrative"];
const STAGES_PENDENTES = ["agendado", "pedido", "a_faturar"];

type Linha = {
  productId: string; nome: string;
  pedidosPendentes: number; pendente: number; estoqueServ: number; necessario: number;
  disponivelGyn: number; cmvInd: number | null; cmvOrigem: string;
  alocado: number; faltam: number; precoUnit: number | null; total: number;
  lotes: { lotId: string; lotNumber: string; quantidade: number; cmvLote: number | null; stockType: string }[];
};

async function montarPreview(ajustes?: Record<string, number>) {
  const instR: any = await db.execute(sql`SELECT id, name, display_name, cnpj FROM omie_instances WHERE COALESCE(is_active, true)`);
  const inst = (instR.rows || []) as any[];
  const byName = (n: string) => inst.find((i) => String(i.name || "").toUpperCase() === n);
  const gyn = byName("GYN"); const serv = byName("SERV"); const ind = byName("IND");
  if (!gyn || !serv) throw new Error("Instâncias GYN/SERV não encontradas");

  // Cliente de destino = cadastro da Puro Serviços (CNPJ da instância SERV).
  const cnpjServ = String(serv.cnpj || "").replace(/\D/g, "");
  const custR: any = await db.execute(sql`
    SELECT id, name, fantasy_name, cnpj FROM customers
    WHERE regexp_replace(COALESCE(cnpj, ''), '\\D', '', 'g') = ${cnpjServ}
    ORDER BY COALESCE(is_active, true) DESC, created_at ASC LIMIT 1`);
  const cliente = (custR.rows || [])[0] || null;

  // 1) Pedidos pendentes da SERV (não faturados), fora transferências.
  const pendR: any = await db.execute(sql`
    SELECT bp.id, bp.order_number, bp.customer_name, bp.stage, bp.products
    FROM billing_pipeline bp
    WHERE UPPER(COALESCE(bp.omie_instance_name, '')) = 'SERV'
      AND bp.stage::text IN ('agendado', 'pedido', 'a_faturar')
      AND LOWER(COALESCE(bp.operation_type, '')) <> 'transferencia'`);
  const pendente: Record<string, { qtd: number; pedidos: Set<string>; nome: string }> = {};
  for (const r of (pendR.rows || [])) {
    let prods: any = r.products; if (typeof prods === "string") { try { prods = JSON.parse(prods); } catch { prods = []; } }
    if (!Array.isArray(prods)) continue;
    for (const p of prods) {
      const pid = String(p?.id || ""); const q = Number(p?.quantity) || 0;
      if (!pid || q <= 0) continue;
      const a = (pendente[pid] = pendente[pid] || { qtd: 0, pedidos: new Set(), nome: String(p?.name || "") });
      a.qtd += q; a.pedidos.add(String(r.id));
    }
  }

  // 2) Estoque atual da SERV (em uso + bloqueado).
  const servR: any = await db.execute(sql`
    SELECT product_id, SUM(quantity) AS qtd FROM inventory_lots
    WHERE instance_id = ${String(serv.id)} AND stock_type IN ('in_use', 'blocked') AND COALESCE(is_active, true)
    GROUP BY 1`);
  const estoqueServ: Record<string, number> = {};
  for (const r of (servR.rows || [])) estoqueServ[String(r.product_id)] = Number(r.qtd) || 0;

  // 3) CMV atual da indústria = custo do último lote produzido na IND por produto.
  const cmvR: any = ind ? await db.execute(sql`
    SELECT DISTINCT ON (product_id) product_id, unit_cost
    FROM inventory_lots
    WHERE instance_id = ${String(ind.id)} AND unit_cost IS NOT NULL AND unit_cost::numeric > 0
    ORDER BY product_id, created_at DESC`) : { rows: [] };
  const cmvInd: Record<string, number> = {};
  for (const r of (cmvR.rows || [])) cmvInd[String(r.product_id)] = Number(r.unit_cost);

  // 4) Lotes da GYN com saldo, FIFO (em uso antes de bloqueado, depois mais antigo).
  const lotR: any = await db.execute(sql`
    SELECT id, product_id, lot_number, quantity, unit_cost, stock_type, production_order_id, created_at
    FROM inventory_lots
    WHERE instance_id = ${String(gyn.id)} AND stock_type IN ('in_use', 'blocked') AND COALESCE(is_active, true) AND quantity::numeric > 0
    ORDER BY product_id, (stock_type = 'blocked'), created_at ASC, lot_number ASC`);
  const lotesGyn: Record<string, any[]> = {};
  for (const r of (lotR.rows || [])) (lotesGyn[String(r.product_id)] = lotesGyn[String(r.product_id)] || []).push(r);

  const prodR: any = await db.execute(sql`SELECT id, name FROM products`);
  const nomeProd: Record<string, string> = {};
  for (const r of (prodR.rows || [])) nomeProd[String(r.id)] = String(r.name || "");

  // Produtos a considerar: os pendentes + os ajustados à mão.
  const ids = new Set<string>([...Object.keys(pendente), ...Object.keys(ajustes || {})]);
  const linhas: Linha[] = [];
  for (const pid of Array.from(ids)) {
    const pend = pendente[pid];
    const est = estoqueServ[pid] || 0;
    const necessarioCalc = Math.max(0, Math.ceil((pend?.qtd || 0) - est));
    const necessario = ajustes && pid in ajustes ? Math.max(0, Math.round(ajustes[pid])) : necessarioCalc;
    const lotes = lotesGyn[pid] || [];
    const disponivel = lotes.reduce((s, l) => s + (Number(l.quantity) || 0), 0);

    let resta = necessario; const aloc: Linha["lotes"] = [];
    for (const l of lotes) {
      if (resta <= 0) break;
      const q = Math.min(resta, Number(l.quantity) || 0); if (q <= 0) continue;
      const cl = l.unit_cost != null && Number(l.unit_cost) > 0 ? Number(l.unit_cost) : null;
      aloc.push({ lotId: String(l.id), lotNumber: String(l.lot_number || ""), quantidade: q, cmvLote: cl, stockType: String(l.stock_type) });
      resta -= q;
    }
    const alocado = necessario - resta;
    const cmvI = cmvInd[pid] ?? null;
    const cmvLoteFallback = aloc.find((a) => a.cmvLote != null)?.cmvLote ?? null;
    const precoUnit = cmvI ?? cmvLoteFallback;
    linhas.push({
      productId: pid, nome: nomeProd[pid] || pend?.nome || pid,
      pedidosPendentes: pend ? pend.pedidos.size : 0, pendente: Math.round(pend?.qtd || 0), estoqueServ: Math.round(est * 1000) / 1000,
      necessario, disponivelGyn: Math.round(disponivel * 1000) / 1000, cmvInd: cmvI, cmvOrigem: cmvI != null ? "IND" : (cmvLoteFallback != null ? "lote GYN" : "sem CMV"),
      alocado, faltam: resta, precoUnit, total: precoUnit != null ? Math.round(precoUnit * alocado * 100) / 100 : 0, lotes: aloc,
    });
  }
  linhas.sort((a, b) => b.necessario - a.necessario || a.nome.localeCompare(b.nome));
  const pedidosDistintos = new Set<string>(); for (const p of Object.values(pendente)) p.pedidos.forEach((x) => pedidosDistintos.add(x));
  return {
    gyn, serv, cliente, linhas,
    resumo: {
      pedidosPendentes: pedidosDistintos.size,
      produtos: linhas.length,
      necessario: linhas.reduce((s, l) => s + l.necessario, 0),
      alocado: linhas.reduce((s, l) => s + l.alocado, 0),
      faltam: linhas.reduce((s, l) => s + l.faltam, 0),
      semCmv: linhas.filter((l) => l.alocado > 0 && l.precoUnit == null).length,
      total: Math.round(linhas.reduce((s, l) => s + l.total, 0) * 100) / 100,
    },
  };
}

export function registerPedidoGynServRoutes(app: Express) {
  app.get("/api/billing-pipeline/pedido-gyn-serv/preview", authenticateUser, requireRole(PAPEIS), async (_req: any, res) => {
    try {
      const p = await montarPreview();
      res.json({
        origem: { instanceId: p.gyn.id, name: p.gyn.name }, destino: { instanceId: p.serv.id, name: p.serv.name, cnpj: p.serv.cnpj },
        cliente: p.cliente ? { id: p.cliente.id, nome: p.cliente.fantasy_name || p.cliente.name, cnpj: p.cliente.cnpj } : null,
        linhas: p.linhas, resumo: p.resumo,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/billing-pipeline/pedido-gyn-serv", authenticateUser, requireRole(PAPEIS), async (req: any, res) => {
    try {
      const itensIn: any[] = Array.isArray(req.body?.itens) ? req.body.itens : [];
      const ajustes: Record<string, number> | undefined = itensIn.length
        ? Object.fromEntries(itensIn.filter((i) => i?.productId).map((i) => [String(i.productId), Number(i.quantity) || 0]))
        : undefined;
      const p = await montarPreview(ajustes);
      if (!p.cliente) return res.status(400).json({ error: `Cadastre a Puro Serviços (CNPJ ${p.serv.cnpj}) em Clientes para ser o destinatário da NF` });
      const comAloc = p.linhas.filter((l) => l.alocado > 0);
      if (!comAloc.length) return res.status(400).json({ error: "Nada a pedir: os pedidos pendentes da SERV já estão cobertos pelo estoque dela (ou a GYN não tem saldo)" });
      const semPreco = comAloc.filter((l) => l.precoUnit == null);
      if (semPreco.length) return res.status(400).json({ error: `Sem CMV para precificar: ${semPreco.map((l) => l.nome).join(", ")}` });

      const produtos: any[] = []; let total = 0;
      for (const l of comAloc) {
        for (const a of l.lotes) {
          const unit = Number(l.precoUnit);
          const totalPrice = Number((unit * a.quantidade).toFixed(2)); total += totalPrice;
          produtos.push({
            id: l.productId, name: l.nome, quantity: a.quantidade,
            unitPrice: Number(unit.toFixed(4)), totalPrice,
            lotId: a.lotId, lotNumber: a.lotNumber,
            // CMV que o lote vai carregar na SERV = o preço pago (CMV atual da indústria).
            cmvUnit: Number(unit.toFixed(4)),
            transferToInstanceId: String(p.serv.id), transferToInstanceName: p.serv.name,
          });
        }
      }

      const user = req.currentUser || req.user;
      const quem = user?.email || "system";
      const salesCardId = randomUUID();
      const orderNumber = `TRF-${salesCardId.substring(0, 8).toUpperCase()}`;
      const agoraISO = new Date().toISOString();
      const resumo = comAloc.map((l) => `${l.nome.replace(/^SUCO MISTO DE FRUTA\s*-\s*/i, "")} x${l.alocado}`).join(", ");
      const cabecalho = `Venda GYN -> SERV a CMV da industria (abastece ${p.resumo.pedidosPendentes} pedido(s) pendente(s) da SERV): ${resumo}`;

      const item = await storage.createBillingPipelineItem({
        salesCardId,
        customerId: p.cliente.id,
        customerName: p.cliente.fantasy_name || p.cliente.name || p.serv.display_name,
        customerDocument: p.cliente.cnpj || p.serv.cnpj || null,
        sellerId: user?.id || null,
        sellerName: user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email : null,
        stage: "a_faturar",
        scheduledBillingDate: null,
        orderNumber,
        saleValue: total.toFixed(2),
        paymentMethod: null,
        operationType: "transferencia",
        products: produtos as any,
        notes: [cabecalho, req.body?.notes ? String(req.body.notes).slice(0, 300) : null].filter(Boolean).join(" | ").slice(0, 1000),
        omieInstanceId: String(p.gyn.id),
        omieInstanceName: p.gyn.display_name || p.gyn.name || null,
        stageHistory: [{ stage: "a_faturar", changedAt: agoraISO, changedBy: quem }],
        createdBy: quem,
      } as any);

      console.log(`🔁 [GYN->SERV] ${orderNumber} ${produtos.length} linha(s) R$ ${total.toFixed(2)} por ${quem}`);
      res.status(201).json({ ok: true, item, orderNumber, total, linhas: comAloc.length, faltam: p.resumo.faltam });
    } catch (e: any) {
      console.error("[GYN->SERV]", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
