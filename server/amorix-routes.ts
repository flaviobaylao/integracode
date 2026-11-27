// server/amorix-routes.ts
// =============================================================================
// RAIA AMORIX do Pipeline (19/nov/2026)
//
// Pedido SELL-OUT (cliente final cuja carteira e' um vendedor 'distribuidor') nao e' faturado pela
// Honest. Nesta raia ele vira uma COPIA DO PEDIDO em PDF, e' enviado a Amorix (WhatsApp, via
// Umbler) e, quando ela entrega, vai para 'entregue' com o selo "via Amorix".
//
// Rotas (todas exigem admin/administrativo/coordenacao):
//   GET  /api/billing-pipeline/:id/amorix/pdf            -> PDF do pedido (inline)
//   POST /api/billing-pipeline/:id/amorix/enviar         -> gera o PDF, envia ao WhatsApp da Amorix
//                                                           e move para a raia 'amorix' se ainda em 'pedido'
//   POST /api/billing-pipeline/:id/amorix/entregue       -> 'entregue' + amorix_entregue_em
//   POST /api/billing-pipeline/:id/amorix/faturar-honest -> excecao: segue o fluxo normal (volta a 'pedido')
//   GET  /api/distribuidores/sellers                     -> ids dos vendedores distribuidores (telas)
//   GET/PUT /api/distribuidores/config                   -> amorix_whatsapp_pedidos (system_settings)
// =============================================================================
import type { Express } from "express";
import { jsPDF } from "jspdf";
import { nanoid } from "nanoid";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { authenticateUser } from "./authMiddleware";
import { agora, paredeBR } from "@shared/tempo";
import { vendedoresDistribuidores, papelPodeLancarParaDistribuidor, infoDistribuidorDoCliente } from "./distribuidor";

const rows = (r: any) => (r?.rows ?? r ?? []) as any[];
async function getSetting(key: string): Promise<string | null> {
  try { return rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`))[0]?.value ?? null; } catch { return null; }
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.execute(sql`INSERT INTO system_settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}
const fmtBRL = (v: any) => (parseFloat(String(v ?? 0)) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDoc = (d: any) => { const s = String(d || "").replace(/\D/g, ""); return s.length === 14 ? s.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : s.length === 11 ? s.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : s; };

function somenteGestor(req: any, res: any): boolean {
  const user = req.currentUser || req.user;
  if (!papelPodeLancarParaDistribuidor(user?.role)) { res.status(403).json({ message: "Só admin, administrativo ou coordenação." }); return false; }
  return true;
}

/** Monta o PDF (copia do pedido) e devolve o buffer. */
async function gerarPdfPedidoAmorix(item: any): Promise<Buffer> {
  const customer: any = item.customerId ? await storage.getCustomer(item.customerId).catch(() => null) : null;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210; let y = 16;
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.text("PEDIDO PARA ATENDIMENTO — AMORIX", 14, y); y += 7;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(90);
  doc.text("Honest Sucos Naturais · cópia do pedido para separação e entrega pelo distribuidor. Sem valor fiscal.", 14, y); y += 8;
  doc.setTextColor(0);
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text(`Pedido ${item.orderNumber || item.id}`, 14, y);
  doc.setFont("helvetica", "normal"); doc.text(`Emitido em ${paredeBR(agora())}`, W - 14, y, { align: "right" }); y += 8;

  const linha = (k: string, v: string) => { if (!v) return; doc.setFont("helvetica", "bold"); doc.text(k, 14, y); doc.setFont("helvetica", "normal"); const t = doc.splitTextToSize(v, W - 14 - 48); doc.text(t, 48, y); y += 5 * t.length; };
  linha("Cliente", String(customer?.fantasyName || item.customerName || ""));
  linha("Razão social", String(customer?.companyName || customer?.name || ""));
  linha("CNPJ/CPF", fmtDoc(item.customerDocument || customer?.cnpj || customer?.cpf));
  const end = [customer?.address, customer?.neighborhood, customer?.city, customer?.state, customer?.zipCode].filter(Boolean).join(", ");
  linha("Endereço", end);
  linha("Contato", [customer?.contact, customer?.phone].filter(Boolean).join(" · "));
  linha("Vendedor", String(item.sellerName || "Amorix"));
  if (item.notes) linha("Observações", String(item.notes));
  y += 4;

  // Tabela de itens
  const prods: any[] = Array.isArray(item.products) ? item.products : [];
  doc.setFillColor(238, 240, 244); doc.rect(14, y - 4, W - 28, 7, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  doc.text("Produto", 16, y); doc.text("Qtd", 140, y, { align: "right" }); doc.text("Ref. PJ (un)", 170, y, { align: "right" }); doc.text("Total ref.", W - 16, y, { align: "right" }); y += 6;
  doc.setFont("helvetica", "normal");
  let totalQtd = 0, totalRef = 0;
  for (const p of prods) {
    const q = parseFloat(String(p?.quantity ?? 0)) || 0; const u = parseFloat(String(p?.unitPrice ?? 0)) || 0; const t = (p?.totalPrice != null && String(p.totalPrice) !== "") ? (parseFloat(String(p.totalPrice)) || 0) : q * u;
    totalQtd += q; totalRef += t;
    const nome = doc.splitTextToSize(String(p?.name || p?.productName || "Produto"), 110);
    doc.text(nome, 16, y); doc.text(String(q), 140, y, { align: "right" }); doc.text(u ? u.toFixed(2).replace(".", ",") : "-", 170, y, { align: "right" }); doc.text(t ? fmtBRL(t) : "-", W - 16, y, { align: "right" });
    y += 5 * nome.length + 1;
    if (y > 270) { doc.addPage(); y = 20; }
  }
  doc.setDrawColor(200); doc.line(14, y, W - 14, y); y += 5;
  doc.setFont("helvetica", "bold"); doc.text("Total", 16, y); doc.text(`${totalQtd} un`, 140, y, { align: "right" }); doc.text(fmtBRL(totalRef), W - 16, y, { align: "right" }); y += 8;
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(110);
  doc.text("Preços de referência da tabela PJ da Honest, apenas para conferência. O faturamento e a entrega deste pedido são feitos pela Amorix Alimentos.", 14, y, { maxWidth: W - 28 });
  return Buffer.from(doc.output("arraybuffer"));
}

export function registerAmorixRoutes(app: Express) {
  // Vendedores distribuidores (para as telas bloquearem o lancamento de pedido).
  app.get("/api/distribuidores/sellers", authenticateUser, async (_req: any, res) => {
    res.json(await vendedoresDistribuidores());
  });

  // Classificacao de um cliente (sell-out?) + se o usuario logado pode lancar pedido para ele.
  app.get("/api/distribuidores/cliente/:customerId", authenticateUser, async (req: any, res) => {
    const info = await infoDistribuidorDoCliente(req.params.customerId);
    const user = req.currentUser || req.user;
    res.json({ ...info, podeLancar: !info.sellout || papelPodeLancarParaDistribuidor(user?.role) });
  });

  app.get("/api/distribuidores/config", authenticateUser, async (req: any, res) => {
    if (!somenteGestor(req, res)) return;
    res.json({ amorixWhatsappPedidos: (await getSetting("amorix_whatsapp_pedidos")) || "" });
  });
  app.put("/api/distribuidores/config", authenticateUser, async (req: any, res) => {
    if (!somenteGestor(req, res)) return;
    const tel = String(req.body?.amorixWhatsappPedidos || "").replace(/\D/g, "");
    await setSetting("amorix_whatsapp_pedidos", tel);
    res.json({ ok: true, amorixWhatsappPedidos: tel });
  });

  app.get("/api/billing-pipeline/:id/amorix/pdf", authenticateUser, async (req: any, res) => {
    try {
      if (!somenteGestor(req, res)) return;
      const item: any = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: "Pedido não encontrado" });
      const buf = await gerarPdfPedidoAmorix(item);
      await db.execute(sql`UPDATE billing_pipeline SET amorix_pdf_em = COALESCE(amorix_pdf_em, now()) WHERE id = ${item.id}`);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="pedido-amorix-${item.orderNumber || item.id}.pdf"`);
      res.send(buf);
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro ao gerar PDF" }); }
  });

  app.post("/api/billing-pipeline/:id/amorix/enviar", authenticateUser, async (req: any, res) => {
    try {
      if (!somenteGestor(req, res)) return;
      const user = req.currentUser || req.user;
      const item: any = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: "Pedido não encontrado" });
      if (!item.amorixSellout) return res.status(400).json({ message: "Este pedido não é de cliente da carteira Amorix." });
      const destino = ((await getSetting("amorix_whatsapp_pedidos")) || "").replace(/\D/g, "");
      if (!destino) return res.status(400).json({ code: "SEM_DESTINO", message: "Cadastre o WhatsApp de pedidos da Amorix (Administração do Sistema › Distribuidor) antes de enviar." });

      const buf = await gerarPdfPedidoAmorix(item);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS chat_media (id text PRIMARY KEY, mimetype text, filename text, data text, created_at timestamptz DEFAULT now())`);
      const mid = nanoid(16);
      const fname = `pedido-amorix-${item.orderNumber || item.id}.pdf`;
      await db.execute(sql`INSERT INTO chat_media (id, mimetype, filename, data) VALUES (${mid}, ${"application/pdf"}, ${fname}, ${buf.toString("base64")})`);
      const prodDomain = (process.env.BASE_URL || process.env.APP_URL || "https://integracode-production.up.railway.app").replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const absUrl = `https://${prodDomain}/api/chat-media/${mid}`;

      const { sendUmblerTalkMedia } = await import("./chat-routes");
      const prods: any[] = Array.isArray(item.products) ? item.products : [];
      const qtd = prods.reduce((t, p) => t + (parseFloat(String(p?.quantity ?? 0)) || 0), 0);
      const caption = `Pedido ${item.orderNumber || ""} — ${item.customerName} — ${qtd} un. Cópia do pedido para atendimento pela Amorix (sem NF da Honest).`;
      const r = await sendUmblerTalkMedia(destino, absUrl, caption);
      if (!r.success) return res.status(502).json({ message: `Falha ao enviar pelo WhatsApp: ${r.error || "erro"}`, pdfUrl: absUrl });

      const hist = Array.isArray(item.stageHistory) ? [...item.stageHistory] : [];
      const updates: any = { amorixEnviadoEm: agora(), amorixEnviadoPor: user?.email || null, amorixPdfEm: item.amorixPdfEm || agora() };
      if (["pedido", "agendado"].includes(String(item.stage))) {
        updates.stage = "amorix";
        hist.push({ stage: "amorix", changedAt: paredeBR(agora()), changedBy: `${user?.email || "sistema"} (enviado à Amorix)` });
        updates.stageHistory = hist;
      }
      await storage.updateBillingPipelineItem(item.id, updates);
      res.json({ ok: true, pdfUrl: absUrl, destino, messageId: r.messageId });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro ao enviar" }); }
  });

  app.post("/api/billing-pipeline/:id/amorix/entregue", authenticateUser, async (req: any, res) => {
    try {
      if (!somenteGestor(req, res)) return;
      const user = req.currentUser || req.user;
      const item: any = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: "Pedido não encontrado" });
      if (!item.amorixSellout) return res.status(400).json({ message: "Este pedido não é de cliente da carteira Amorix." });
      const hist = Array.isArray(item.stageHistory) ? [...item.stageHistory] : [];
      hist.push({ stage: "entregue", changedAt: paredeBR(agora()), changedBy: `${user?.email || "sistema"} (entregue pela Amorix)` });
      await storage.updateBillingPipelineItem(item.id, { stage: "entregue", amorixEntregueEm: agora(), stageHistory: hist } as any);
      // Positivacao do cliente final: ultima compra = hoje (mesmo sem NF da Honest).
      try { await db.execute(sql`UPDATE customers SET last_sale_date = GREATEST(COALESCE(last_sale_date, '1900-01-01'::timestamp), now()) WHERE id = ${item.customerId}`); } catch {}
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro" }); }
  });

  app.post("/api/billing-pipeline/:id/amorix/faturar-honest", authenticateUser, async (req: any, res) => {
    try {
      if (!somenteGestor(req, res)) return;
      const user = req.currentUser || req.user;
      const item: any = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: "Pedido não encontrado" });
      if (!item.amorixSellout) return res.status(400).json({ message: "Este pedido não é de cliente da carteira Amorix." });
      const hist = Array.isArray(item.stageHistory) ? [...item.stageHistory] : [];
      const updates: any = { faturarHonestPor: user?.email || "gestor" };
      if (String(item.stage) === "amorix") { updates.stage = "pedido"; hist.push({ stage: "pedido", changedAt: paredeBR(agora()), changedBy: `${user?.email || "gestor"} (exceção: faturar pela Honest)` }); updates.stageHistory = hist; }
      await storage.updateBillingPipelineItem(item.id, updates);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro" }); }
  });
}
