import { type Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { purchaseInvoices, omieInstances, payables, chartOfAccounts, digitalCertificates } from "@shared/schema";
import { eq, desc, and, sql, ilike, or } from "drizzle-orm";
import { nowBrazil } from "./brazilTimezone";
import * as xmlJs from "xml-js";

interface NFeItem {
  nItem: string;
  cProd: string;
  xProd: string;
  NCM: string;
  CFOP: string;
  uCom: string;
  qCom: string;
  vUnCom: string;
  vProd: string;
}

function stripNamespaces(xmlString: string): string {
  return xmlString
    .replace(/<\/?[\w]+:/g, (match) => match.charAt(0) === '<' && match.charAt(1) === '/' ? '</' : '<')
    .replace(/\sxmlns[^=]*="[^"]*"/g, '');
}

function parseNFeXml(xmlString: string): any {
  try {
    const cleanXml = stripNamespaces(xmlString);
    const result = xmlJs.xml2js(cleanXml, { compact: true, ignoreComment: true });
    const root = result as any;
    const nfeProc = root.nfeProc || root.NFe || root.nfe;
    const nfe = nfeProc?.NFe || nfeProc?.nfe || nfeProc;
    if (!nfe) throw new Error("Estrutura XML inválida: não encontrou elemento NFe");
    const infNFe = nfe.infNFe || nfe.infnfe;
    if (!infNFe) throw new Error("Estrutura XML inválida: não encontrou infNFe");

    const ide = infNFe.ide || {};
    const emit = infNFe.emit || {};
    const dest = infNFe.dest || {};
    const total = infNFe.total?.ICMSTot || infNFe.total?.icmstot || {};
    const detArray = Array.isArray(infNFe.det) ? infNFe.det : infNFe.det ? [infNFe.det] : [];

    const getText = (obj: any): string => {
      if (!obj) return "";
      if (typeof obj === "string") return obj;
      if (obj._text !== undefined) return String(obj._text);
      if (obj._cdata !== undefined) return String(obj._cdata);
      return "";
    };

    const accessKey = getText(infNFe._attributes?.Id)?.replace("NFe", "") || "";

    const items = detArray.map((det: any) => {
      const prod = det.prod || {};
      return {
        nItem: getText(det._attributes?.nItem),
        cProd: getText(prod.cProd),
        xProd: getText(prod.xProd),
        NCM: getText(prod.NCM),
        CFOP: getText(prod.CFOP),
        uCom: getText(prod.uCom),
        qCom: getText(prod.qCom),
        vUnCom: getText(prod.vUnCom),
        vProd: getText(prod.vProd),
      };
    });

    const taxes = {
      vBC: getText(total.vBC),
      vICMS: getText(total.vICMS),
      vICMSST: getText(total.vST),
      vPIS: getText(total.vPIS),
      vCOFINS: getText(total.vCOFINS),
      vIPI: getText(total.vIPI),
      vFrete: getText(total.vFrete),
      vSeg: getText(total.vSeg),
      vDesc: getText(total.vDesc),
      vOutro: getText(total.vOutro),
      vNF: getText(total.vNF),
    };

    return {
      accessKey,
      invoiceNumber: getText(ide.nNF),
      series: getText(ide.serie),
      issueDate: getText(ide.dhEmi),
      natureOfOperation: getText(ide.natOp),
      supplierName: getText(emit.xNome) || getText(emit.xFant),
      supplierDocument: getText(emit.CNPJ) || getText(emit.CPF),
      supplierIe: getText(emit.IE),
      recipientDocument: getText(dest.CNPJ) || getText(dest.CPF),
      recipientName: getText(dest.xNome),
      totalValue: getText(total.vNF),
      cfop: items.length > 0 ? items[0].CFOP : "",
      items,
      taxes,
    };
  } catch (err: any) {
    throw new Error(`Erro ao processar XML: ${err.message}`);
  }
}

async function ensurePurchaseInvoicesTable() {
  try {
    await db.execute(sql`
      ALTER TABLE omie_instances ADD COLUMN IF NOT EXISTS cnpj varchar
    `);
    await db.execute(sql`
      ALTER TABLE omie_instances ADD COLUMN IF NOT EXISTS default_account_code varchar
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS purchase_invoices (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        access_key varchar(44) UNIQUE,
        invoice_number varchar,
        series varchar DEFAULT '1',
        issue_date timestamp,
        supplier_name varchar NOT NULL,
        supplier_document varchar NOT NULL,
        supplier_ie varchar,
        total_value decimal(12,2) NOT NULL DEFAULT 0,
        items jsonb DEFAULT '[]'::jsonb,
        taxes jsonb DEFAULT '{}'::jsonb,
        status varchar NOT NULL DEFAULT 'detected',
        xml_content text,
        omie_instance_id varchar,
        chart_account_id varchar,
        payable_id varchar,
        is_stock_purchase boolean DEFAULT false,
        stock_processed boolean DEFAULT false,
        cfop varchar,
        nature_of_operation varchar,
        notes text,
        detected_at timestamp DEFAULT NOW(),
        imported_at timestamp,
        classified_at timestamp,
        created_by varchar,
        created_at timestamp DEFAULT NOW(),
        updated_at timestamp DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS seller_type varchar
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sales_goal_history (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id varchar,
        seller_type varchar NOT NULL,
        month integer NOT NULL,
        year integer NOT NULL,
        revenue_goal decimal(12,2),
        revenue_actual decimal(12,2),
        revenue_projected decimal(12,2),
        achievement_pct decimal(5,2),
        commission_pct decimal(5,2),
        commission_tier integer,
        working_days_total integer,
        working_days_elapsed integer,
        is_projected boolean DEFAULT true,
        created_at timestamp DEFAULT NOW(),
        updated_at timestamp DEFAULT NOW(),
        UNIQUE(seller_id, month, year)
      )
    `);
    console.log("✅ purchase_invoices table ensured");
  } catch (err: any) {
    console.error("⚠️ Error ensuring purchase_invoices table:", err.message);
  }
}

let __radarRunning = false;
// Executa o Radar de Compras (Distribuição DFe da SEFAZ) para todas as instâncias ativas.
// Reutilizável pelo endpoint manual E pelo agendador automático (sem HTTP/auth).
export async function runRadarScan(createdBy: string = "radar-auto"): Promise<any> {
  if (__radarRunning) return { ok: false, skipped: true, reason: "scan já em andamento" };
  __radarRunning = true;
  try {
    const onlyDig = (v: any) => (v == null ? "" : String(v)).replace(/\D/g, "");
    const { INSTANCE_COMPANY_DATA } = await import("./nfe-routes");
    const { fetchDistribuicaoDFe } = await import("./sefaz-service");
    const instances = await db.select().from(omieInstances).where(eq(omieInstances.isActive, true));
    const instancesWithCnpj = instances.filter((i: any) => onlyDig((INSTANCE_COMPANY_DATA as any)?.[i.name]?.cnpj || i.cnpj));
    if (instancesWithCnpj.length === 0) {
      return { ok: true, message: "Nenhuma instância com CNPJ cadastrado.", scanned: 0, found: 0, instances: [] };
    }
    const ourCnpjs = new Set<string>();
    for (const i of instances) { const c = onlyDig((INSTANCE_COMPANY_DATA as any)?.[i.name]?.cnpj || i.cnpj); if (c) ourCnpjs.add(c); }
    const getSetting = async (k: string) => { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${k} LIMIT 1`); const rows = (r as any).rows || r; return rows[0]?.value ?? null; };
    const setSetting = async (k: string, v: string) => { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${k}, ${v}, 'radar-compras') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'radar-compras', updated_at = now()`); };

    const results: any[] = [];
    let totalFound = 0;
    for (const inst of instancesWithCnpj) {
      const cd: any = (INSTANCE_COMPANY_DATA as any)[inst.name];
      const cnpj = onlyDig(cd?.cnpj || inst.cnpj);
      const uf = cd?.uf || "GO";
      if (!cnpj) continue;
      const envVal = await getSetting("fiscal_env_" + inst.id);
      const ambiente: "producao" | "homologacao" = envVal === "homologacao" ? "homologacao" : "producao";
      let ultNSU = onlyDig(await getSetting("dfe_ult_nsu_" + cnpj)) || "0";
      let found = 0, calls = 0, err: string | null = null, cStat: string | null = null;
      try {
        while (calls < 4) {
          calls++;
          const r: any = await fetchDistribuicaoDFe({ cnpj, uf, ultNSU, ambiente });
          cStat = r?.cStat || null;
          if (!r?.ok && r?.error) { err = r.error; break; }
          for (const doc of (r.docs || [])) {
            if ((doc.type === "resumo" || doc.type === "nota") && doc.accessKey && !doc.isCancellation && !ourCnpjs.has(onlyDig(doc.supplierDocument))) {
              const [ex] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.accessKey, doc.accessKey));
              if (!ex) {
                await db.insert(purchaseInvoices).values({
                  accessKey: doc.accessKey,
                  invoiceNumber: doc.invoiceNumber,
                  series: doc.series || "1",
                  issueDate: doc.issueDate || null,
                  supplierName: doc.supplierName || "(a identificar)",
                  supplierDocument: doc.supplierDocument || "",
                  supplierIe: doc.supplierIe,
                  totalValue: doc.totalValue || "0",
                  items: [],
                  status: "detected",
                  omieInstanceId: inst.id,
                  detectedAt: nowBrazil(),
                  createdBy,
                });
                found++; totalFound++;
              }
            }
          }
          const newUlt = onlyDig(r.ultNSU) || ultNSU;
          const maxNSU = onlyDig(r.maxNSU) || newUlt;
          ultNSU = newUlt;
          await setSetting("dfe_ult_nsu_" + cnpj, ultNSU);
          if (r.cStat === "137") break;
          try { if (BigInt(ultNSU || "0") >= BigInt(maxNSU || "0")) break; } catch (_e) { break; }
        }
      } catch (e: any) { err = e.message; }
      results.push({ instance: inst.name, cnpj, ambiente, found, ultNSU, calls, cStat, error: err });
    }
    try { await setSetting("radar_auto_last", JSON.stringify({ at: new Date().toISOString(), by: createdBy, found: totalFound, instances: results })); } catch (_e) {}
    return { ok: true, scanned: instancesWithCnpj.length, found: totalFound, instances: results };
  } finally { __radarRunning = false; }
}

export function registerPurchaseRoutes(app: Express) {
  ensurePurchaseInvoicesTable();

  app.get("/api/purchases", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const { status, omieInstanceId, search, limit = "100" } = req.query;
      let conditions: any[] = [];

      if (status && status !== "all") {
        conditions.push(eq(purchaseInvoices.status, status));
      }
      if (omieInstanceId) {
        conditions.push(eq(purchaseInvoices.omieInstanceId, omieInstanceId));
      }
      if (search) {
        conditions.push(
          or(
            ilike(purchaseInvoices.supplierName, `%${search}%`),
            ilike(purchaseInvoices.supplierDocument, `%${search}%`),
            ilike(purchaseInvoices.invoiceNumber, `%${search}%`),
            ilike(purchaseInvoices.accessKey, `%${search}%`)
          )
        );
      }

      const query = conditions.length > 0
        ? db.select().from(purchaseInvoices).where(and(...conditions)).orderBy(desc(purchaseInvoices.issueDate)).limit(parseInt(limit as string))
        : db.select().from(purchaseInvoices).orderBy(desc(purchaseInvoices.issueDate)).limit(parseInt(limit as string));

      const results = await query;
      res.json(results);
    } catch (err: any) {
      console.error("[PURCHASES] List error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/purchases/certificates-status", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const instances = await db.select().from(omieInstances).where(eq(omieInstances.isActive, true));
      const certs = await db.select().from(digitalCertificates);
      
      const result = instances.map(inst => {
        const matchedCert = inst.cnpj 
          ? certs.find(c => {
              const instCnpj = (inst.cnpj || '').replace(/\D/g, '');
              const certCnpj = (c.cnpj || '').replace(/\D/g, '');
              return instCnpj && certCnpj && instCnpj === certCnpj;
            })
          : null;
        
        return {
          instanceId: inst.id,
          instanceName: inst.name,
          displayName: inst.displayName,
          tagColor: inst.tagColor,
          cnpj: inst.cnpj,
          hasCertificate: !!matchedCert,
          certificateId: matchedCert?.id || null,
          certificateCompany: matchedCert?.companyName || null,
          certificateValid: matchedCert ? new Date(matchedCert.validUntil!) > new Date() : false,
          certificateExpiry: matchedCert?.validUntil || null,
          certificateActive: matchedCert?.isActive || false,
        };
      });
      
      const unmatchedCerts = certs.filter(c => {
        const certCnpj = (c.cnpj || '').replace(/\D/g, '');
        return !instances.some(inst => {
          const instCnpj = (inst.cnpj || '').replace(/\D/g, '');
          return instCnpj && certCnpj && instCnpj === certCnpj;
        });
      });
      
      res.json({ instances: result, unmatchedCertificates: unmatchedCerts, totalCertificates: certs.length });
    } catch (err: any) {
      console.error("[PURCHASES] Certificates status error:", err.message);
      res.json({ instances: [], unmatchedCertificates: [], totalCertificates: 0 });
    }
  });

  app.get("/api/purchases/stats/summary", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'detected') as detected,
          COUNT(*) FILTER (WHERE status = 'imported') as imported,
          COUNT(*) FILTER (WHERE status = 'classified') as classified,
          COUNT(*) FILTER (WHERE status = 'linked') as linked,
          COUNT(*) FILTER (WHERE status = 'paid') as paid,
          COALESCE(SUM(CAST(total_value AS numeric)), 0) as total_value,
          COALESCE(SUM(CAST(total_value AS numeric)) FILTER (WHERE status IN ('linked', 'paid')), 0) as linked_value,
          COUNT(*) FILTER (WHERE is_stock_purchase = true) as stock_purchases
        FROM purchase_invoices
        WHERE status != 'cancelled'
      `);
      const rows = result.rows || result;
      const stats = Array.isArray(rows) ? rows[0] : rows;
      res.json(stats || { total: 0, detected: 0, imported: 0, classified: 0, linked: 0, paid: 0, total_value: 0, linked_value: 0, stock_purchases: 0 });
    } catch (err: any) {
      console.error('❌ [PURCHASE-STATS] Error:', err.message);
      res.json({ total: 0, detected: 0, imported: 0, classified: 0, linked: 0, paid: 0, total_value: 0, linked_value: 0, stock_purchases: 0 });
    }
  });

  app.post("/api/purchases/radar/scan", authenticateUser, requireRole(["admin", "coordinator"]), async (req: any, res) => {
    try {
      const out = await runRadarScan(req.userId || "radar-manual");
      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/purchases/:id", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const [invoice] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ error: "Nota fiscal não encontrada" });
      res.json(invoice);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/purchases/import-xml", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const { xmlContent, omieInstanceId } = req.body;
      if (!xmlContent) return res.status(400).json({ error: "XML obrigatório" });

      const parsed = parseNFeXml(xmlContent);

      let existing: any = null;
      if (parsed.accessKey) {
        [existing] = await db.select().from(purchaseInvoices)
          .where(eq(purchaseInvoices.accessKey, parsed.accessKey));
        // Só recusa se já foi realmente importada (ou além). Nota apenas DETECTADA
        // pelo Radar (só o resumo) deve ser ENRIQUECIDA com o XML, não recusada.
        if (existing && existing.status !== "detected") {
          return res.status(409).json({ error: "Nota fiscal já importada", existingId: existing.id });
        }
      }

      let matchedInstanceId = omieInstanceId;
      if (!matchedInstanceId && parsed.recipientDocument) {
        const instances = await db.select().from(omieInstances).where(eq(omieInstances.isActive, true));
        const cleanDoc = parsed.recipientDocument.replace(/\D/g, "");
        const match = instances.find(i => i.cnpj && i.cnpj.replace(/\D/g, "") === cleanDoc);
        if (match) matchedInstanceId = match.id;
      }

      const issueDateParsed = parsed.issueDate ? new Date(parsed.issueDate) : null;

      // Nota já DETECTADA pelo Radar: completa o registro com o XML (itens/impostos)
      // e passa para "imported" — inicia o recebimento sem exigir manifestação SEFAZ.
      if (existing && existing.status === "detected") {
        const [invoice] = await db.update(purchaseInvoices).set({
          invoiceNumber: parsed.invoiceNumber,
          series: parsed.series || "1",
          issueDate: issueDateParsed,
          supplierName: parsed.supplierName,
          supplierDocument: parsed.supplierDocument,
          supplierIe: parsed.supplierIe,
          totalValue: parsed.totalValue || "0",
          items: parsed.items,
          taxes: parsed.taxes,
          status: "imported",
          xmlContent: xmlContent,
          cfop: parsed.cfop,
          natureOfOperation: parsed.natureOfOperation,
          omieInstanceId: matchedInstanceId || existing.omieInstanceId,
          importedAt: nowBrazil(),
          updatedAt: nowBrazil(),
        }).where(eq(purchaseInvoices.id, existing.id)).returning();
        return res.json(invoice);
      }

      const [invoice] = await db.insert(purchaseInvoices).values({
        accessKey: parsed.accessKey || null,
        invoiceNumber: parsed.invoiceNumber,
        series: parsed.series || "1",
        issueDate: issueDateParsed,
        supplierName: parsed.supplierName,
        supplierDocument: parsed.supplierDocument,
        supplierIe: parsed.supplierIe,
        totalValue: parsed.totalValue || "0",
        items: parsed.items,
        taxes: parsed.taxes,
        status: "imported",
        xmlContent: xmlContent,
        omieInstanceId: matchedInstanceId,
        cfop: parsed.cfop,
        natureOfOperation: parsed.natureOfOperation,
        importedAt: nowBrazil(),
        createdBy: req.userId,
      }).returning();

      res.json(invoice);
    } catch (err: any) {
      console.error("[PURCHASES] Import XML error:", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/purchases/:id/classify", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const { chartAccountId, isStockPurchase, notes } = req.body;
      if (!chartAccountId) return res.status(400).json({ error: "Categoria do plano de contas obrigatória" });

      const [updated] = await db.update(purchaseInvoices)
        .set({
          chartAccountId,
          isStockPurchase: isStockPurchase || false,
          notes,
          status: "classified",
          classifiedAt: nowBrazil(),
          updatedAt: nowBrazil(),
        })
        .where(eq(purchaseInvoices.id, req.params.id))
        .returning();

      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/purchases/:id/create-payable", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const { dueDate, financialAccountId, paymentMethod, description } = req.body;

      const [invoice] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ error: "NF de compra não encontrada" });
      if (invoice.payableId) return res.status(400).json({ error: "Conta a pagar já vinculada" });
      if (invoice.status !== "classified") return res.status(400).json({ error: "NF precisa estar classificada antes de criar conta a pagar" });
      if (!dueDate) return res.status(400).json({ error: "Data de vencimento obrigatória" });

      const [payable] = await db.insert(payables).values({
        titleNumber: `NF-${invoice.invoiceNumber || "SN"}`,
        supplierName: invoice.supplierName,
        supplierDocument: invoice.supplierDocument,
        description: description || `Compra NF ${invoice.invoiceNumber} - ${invoice.supplierName}`,
        issueDate: invoice.issueDate || nowBrazil(),
        dueDate: dueDate ? new Date(dueDate) : nowBrazil(),
        amount: invoice.totalValue,
        amountPaid: "0",
        status: "a_vencer",
        paymentMethod: paymentMethod || "boleto",
        financialAccountId: financialAccountId || null,
        chartAccountId: invoice.chartAccountId || null,
        source: "radar",
        omieInstanceId: invoice.omieInstanceId || null,
        createdBy: req.userId,
      }).returning();

      const [updatedInvoice] = await db.update(purchaseInvoices)
        .set({
          payableId: payable.id,
          status: "linked",
          updatedAt: nowBrazil(),
        })
        .where(eq(purchaseInvoices.id, req.params.id))
        .returning();

      res.json({ invoice: updatedInvoice, payable });
    } catch (err: any) {
      console.error("[PURCHASES] Create payable error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/purchases/:id/process-stock", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const { itemMappings } = req.body;

      const [invoice] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ error: "NF de compra não encontrada" });
      if (!invoice.isStockPurchase) return res.status(400).json({ error: "NF não marcada como compra de estoque" });
      if (invoice.stockProcessed) return res.status(400).json({ error: "Estoque já processado para esta NF" });

      if (!itemMappings || !Array.isArray(itemMappings) || itemMappings.length === 0) {
        return res.status(400).json({ error: "Mapeamento de itens obrigatório" });
      }

      const results: any[] = [];
      for (const mapping of itemMappings) {
        const { productId, instanceId, quantity, lotNumber } = mapping;
        if (!productId || !quantity) continue;

        const targetInstanceId = instanceId || invoice.omieInstanceId;
        const lot = lotNumber || `NF-${invoice.invoiceNumber}-${new Date().toISOString().slice(0, 10)}`;

        const existingLotRes: any = await db.execute(sql`
          SELECT id, quantity FROM inventory_lots
          WHERE product_id = ${productId} AND instance_id = ${targetInstanceId} AND stock_type = 'in_use'
          LIMIT 1
        `);
        const existingLot = ((existingLotRes as any).rows || existingLotRes)[0];

        if (existingLot) {
          await db.execute(sql`
            UPDATE inventory_lots SET quantity = quantity + ${quantity}, lot_number = ${lot}, updated_at = NOW()
            WHERE id = ${(existingLot as any).id}
          `);
        } else {
          await db.execute(sql`
            INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, created_at, updated_at)
            VALUES (gen_random_uuid(), ${productId}, ${targetInstanceId}, 'in_use', ${lot}, ${quantity}, NOW(), NOW())
          `);
        }

        await db.execute(sql`
          INSERT INTO inventory_movements (id, product_id, instance_id, movement_type, source_type, source_id, quantity, previous_quantity, new_quantity, notes, created_by, created_at)
          VALUES (gen_random_uuid(), ${productId}, ${targetInstanceId}, 'replenish', 'invoice', ${invoice.id}, ${quantity}, 0, ${quantity}, ${`Entrada NF ${invoice.invoiceNumber} - ${invoice.supplierName}`}, ${(req as any).currentUser?.id || (req as any).currentUser?.email || 'radar-compras'}, NOW())
        `);

        results.push({ productId, quantity, lotNumber: lot });
      }

      const [updatedInvoice] = await db.update(purchaseInvoices)
        .set({ stockProcessed: true, updatedAt: nowBrazil() })
        .where(eq(purchaseInvoices.id, req.params.id))
        .returning();

      res.json({ invoice: updatedInvoice, stockEntries: results });
    } catch (err: any) {
      console.error("[PURCHASES] Process stock error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/purchases/:id/status", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const { status } = req.body;
      const validTransitions: Record<string, string[]> = {
        detected: ["imported", "cancelled"],
        imported: ["classified", "cancelled"],
        classified: ["linked", "cancelled"],
        linked: ["paid", "cancelled"],
        paid: [],
        cancelled: [],
      };

      const [invoice] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ error: "NF não encontrada" });

      const allowed = validTransitions[invoice.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `Transição inválida: ${invoice.status} → ${status}` });
      }

      const [updated] = await db.update(purchaseInvoices)
        .set({ status, updatedAt: nowBrazil() })
        .where(eq(purchaseInvoices.id, req.params.id))
        .returning();

      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/purchases/:id", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      await db.delete(purchaseInvoices).where(eq(purchaseInvoices.id, req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/purchases/:id/process-raw-materials", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const { itemMappings } = req.body;
      const [invoice] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ error: "NF de compra não encontrada" });
      if (!invoice.isStockPurchase) return res.status(400).json({ error: "NF não marcada como compra de estoque" });
      if (invoice.stockProcessed) return res.status(400).json({ error: "Entrada de estoque já processada para esta NF" });
      if (!itemMappings || !Array.isArray(itemMappings) || itemMappings.length === 0) {
        return res.status(400).json({ error: "Mapeamento de itens obrigatório" });
      }
      const results: any[] = [];
      for (const mapping of itemMappings) {
        const rawMaterialId = mapping.rawMaterialId;
        const qty = Number(mapping.quantity);
        if (!rawMaterialId || !qty || isNaN(qty)) continue;
        const uc = (mapping.unitCost !== undefined && mapping.unitCost !== null && mapping.unitCost !== "") ? Number(mapping.unitCost) : null;
        // db.execute retorna { rows } — NAO e iteravel (destruturar como array quebra:
        // "(intermediate value) is not iterable"). Pega a 1a linha via .rows.
        const curRes: any = await db.execute(sql`SELECT quantity, unit_cost FROM raw_materials WHERE id = ${rawMaterialId} LIMIT 1`);
        const cur = ((curRes as any).rows || curRes)[0];
        if (!cur) continue;
        const prev = Number((cur as any).quantity || 0);
        const next = prev + qty;
        await db.execute(sql`UPDATE raw_materials SET quantity = ${next}, unit_cost = COALESCE(${uc}, unit_cost), updated_at = NOW() WHERE id = ${rawMaterialId}`);
        await db.execute(sql`
          INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, notes, created_by, created_at, unit_cost)
          VALUES (gen_random_uuid(), ${rawMaterialId}, 'entrada_compra', ${qty}, ${prev}, ${next}, ${`Entrada NF ${invoice.invoiceNumber || "SN"} - ${invoice.supplierName}`}, ${(req as any).currentUser?.id || (req as any).currentUser?.email || 'radar-compras'}, NOW(), ${uc})
        `);
        results.push({ rawMaterialId, quantity: qty, previousQuantity: prev, newQuantity: next, unitCost: uc });
      }
      if (results.length === 0) return res.status(400).json({ error: "Nenhum item válido para dar entrada" });
      const [updatedInvoice] = await db.update(purchaseInvoices)
        .set({ stockProcessed: true, updatedAt: nowBrazil() })
        .where(eq(purchaseInvoices.id, req.params.id))
        .returning();
      res.json({ invoice: updatedInvoice, entries: results });
    } catch (err: any) {
      console.error("[PURCHASES] Process raw materials error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // ===== Fornecedores — cadastro GERIDO no 2.0 (suppliers, sync do 1.0 cortado) =====
  const supDigits = (v: any) => (v == null ? "" : String(v)).replace(/\D/g, "");
  const supRows = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));

  app.get("/api/suppliers", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const search = (req.query.search as string) || "";
      const like = `%${search}%`;
      const r = await db.execute(sql`
        SELECT id, name, company_name, cnpj, cpf, state_registration, email, phone,
               default_chart_account_id, default_category, omie_instance_id, is_active
        FROM suppliers
        WHERE is_active IS NOT FALSE
          AND (${search} = '' OR name ILIKE ${like} OR company_name ILIKE ${like} OR cnpj ILIKE ${like} OR cpf ILIKE ${like})
        ORDER BY name LIMIT 500`);
      res.json(supRows(r));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/suppliers/match", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const doc = supDigits(req.query.document);
      if (!doc || doc.length < 11) return res.json({ supplier: null });
      const r = await db.execute(sql`
        SELECT id, name, company_name, cnpj, cpf, state_registration, email, phone,
               default_chart_account_id, default_category, omie_instance_id, is_active
        FROM suppliers
        WHERE regexp_replace(COALESCE(cnpj,''), '\D', '', 'g') = ${doc}
           OR regexp_replace(COALESCE(cpf,''),  '\D', '', 'g') = ${doc}
        LIMIT 1`);
      res.json({ supplier: supRows(r)[0] || null });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/suppliers", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const b = req.body || {};
      const name = (b.name || b.companyName || "").toString().trim();
      if (!name) return res.status(400).json({ error: "Nome do fornecedor obrigatório" });
      const cnpj = supDigits(b.cnpj);
      const cpf = supDigits(b.cpf);
      if (cnpj || cpf) {
        const ex = await db.execute(sql`
          SELECT id FROM suppliers
          WHERE (${cnpj} <> '' AND regexp_replace(COALESCE(cnpj,''),'\D','','g') = ${cnpj})
             OR (${cpf}  <> '' AND regexp_replace(COALESCE(cpf,''), '\D','','g') = ${cpf})
          LIMIT 1`);
        const exRows = supRows(ex);
        if (exRows[0]) return res.status(409).json({ error: "Fornecedor já cadastrado", existingId: exRows[0].id });
      }
      const r = await db.execute(sql`
        INSERT INTO suppliers (id, name, company_name, cnpj, cpf, state_registration, email, phone,
          contact_name, address, address_number, neighborhood, city, state, zip_code,
          default_chart_account_id, default_category, omie_instance_id, notes, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${name}, ${b.companyName || null}, ${cnpj || null}, ${cpf || null},
          ${b.stateRegistration || null}, ${b.email || null}, ${b.phone || null}, ${b.contactName || null},
          ${b.address || null}, ${b.addressNumber || null}, ${b.neighborhood || null}, ${b.city || null},
          ${b.state || null}, ${supDigits(b.zipCode) || null}, ${b.defaultChartAccountId || null},
          ${b.defaultCategory || null}, ${b.omieInstanceId || null}, ${b.notes || null}, true, NOW(), NOW())
        RETURNING id, name, cnpj, cpf, default_chart_account_id, default_category`);
      res.json(supRows(r)[0]);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put("/api/suppliers/:id", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const b = req.body || {};
      const r = await db.execute(sql`
        UPDATE suppliers SET
          name = COALESCE(${b.name ?? null}, name),
          company_name = COALESCE(${b.companyName ?? null}, company_name),
          email = COALESCE(${b.email ?? null}, email),
          phone = COALESCE(${b.phone ?? null}, phone),
          default_chart_account_id = COALESCE(${b.defaultChartAccountId ?? null}, default_chart_account_id),
          default_category = COALESCE(${b.defaultCategory ?? null}, default_category),
          is_active = COALESCE(${b.isActive ?? null}, is_active),
          updated_at = NOW()
        WHERE id = ${req.params.id}
        RETURNING id`);
      const rows = supRows(r);
      if (!rows[0]) return res.status(404).json({ error: "Fornecedor não encontrado" });
      res.json({ ok: true, id: rows[0].id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // ===== Importar NF-e por CHAVE (SEFAZ Distribuição DFe — usa o A1 do CNPJ destinatário) =====
  app.post("/api/purchases/import-by-key", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const chave = (req.body?.chave || "").toString().replace(/\D/g, "");
      const instanceId = (req.body?.instanceId || "").toString();
      if (chave.length !== 44) return res.status(400).json({ error: "Chave de acesso inválida (precisa ter 44 dígitos)." });
      if (!instanceId) return res.status(400).json({ error: "Selecione a empresa (instância) destinatária da nota." });

      const [inst] = await db.select().from(omieInstances).where(eq(omieInstances.id, instanceId));
      if (!inst) return res.status(404).json({ error: "Instância não encontrada" });

      const { INSTANCE_COMPANY_DATA } = await import("./nfe-routes");
      const cd: any = (INSTANCE_COMPANY_DATA as any)[inst.name];
      const cnpj = ((cd?.cnpj || inst.cnpj || "") as string).replace(/\D/g, "");
      const uf = (cd?.uf || "GO") as string;
      if (!cnpj) return res.status(400).json({ error: "CNPJ da instância não configurado (necessário certificado A1)." });

      const [existing] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.accessKey, chave));
      if (existing && existing.status !== "detected") return res.status(409).json({ error: "Nota fiscal já importada", existingId: existing.id });

      let ambiente: "producao" | "homologacao" = "producao";
      try {
        const s = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${"fiscal_env_" + instanceId} LIMIT 1`);
        const row: any = (s as any).rows ? (s as any).rows[0] : (Array.isArray(s) ? s[0] : null);
        if (row && String(row.value) === "homologacao") ambiente = "homologacao";
      } catch (_e) { /* default producao */ }

      const { fetchNFeByChave, manifestarCiencia } = await import("./sefaz-service");
      let result: any = await fetchNFeByChave({ chave, uf, cnpj, ambiente });

      // Só o RESUMO veio (cStat 138 sem XML completo): faz a Ciência da Operação
      // (manifestação do destinatário) para a SEFAZ liberar o procNFe, e refaz a consulta.
      let manifestacao: any = null;
      if (!result?.fullXml && result?.cStat === "138") {
        manifestacao = await manifestarCiencia({ chave, cnpj, ambiente });
        if (manifestacao?.ok) {
          await new Promise((r) => setTimeout(r, 1500));
          result = await fetchNFeByChave({ chave, uf, cnpj, ambiente });
        }
      }

      if (!result?.ok || !result?.fullXml) {
        if (result?.cStat === "138" && !result?.fullXml) {
          const maniMsg = manifestacao
            ? (manifestacao.ok
                ? " A manifestação (Ciência da Operação) foi registrada, mas o XML ainda não retornou — tente novamente em alguns instantes."
                : ` A manifestação automática não foi aceita pela SEFAZ (${manifestacao.xMotivo || manifestacao.error || "motivo não informado"}${manifestacao.cStat ? ", cStat " + manifestacao.cStat : ""}).`)
            : "";
          return res.status(422).json({
            error: `A nota foi localizada na SEFAZ, mas o XML completo ainda não está disponível para download.${maniMsg} Você também pode receber usando "Importar XML" com o arquivo enviado pelo fornecedor.`,
            cStat: "138",
            resumoOnly: true,
            manifestacao: manifestacao || null,
          });
        }
        return res.status(422).json({ error: `SEFAZ: ${result?.xMotivo || result?.error || "não foi possível obter o XML da nota"}${result?.cStat ? ` (cStat ${result.cStat})` : ""}`, cStat: result?.cStat || null });
      }

      const parsed = parseNFeXml(result.fullXml);
      const issueDateParsed = parsed.issueDate ? new Date(parsed.issueDate) : null;
      let invoice: any;
      let enriched = false;
      if (existing && existing.status === "detected") {
        [invoice] = await db.update(purchaseInvoices).set({
          invoiceNumber: parsed.invoiceNumber,
          series: parsed.series || "1",
          issueDate: issueDateParsed,
          supplierName: parsed.supplierName,
          supplierDocument: parsed.supplierDocument,
          supplierIe: parsed.supplierIe,
          totalValue: parsed.totalValue || "0",
          items: parsed.items,
          taxes: parsed.taxes,
          status: "imported",
          xmlContent: result.fullXml,
          cfop: parsed.cfop,
          natureOfOperation: parsed.natureOfOperation,
          importedAt: nowBrazil(),
          updatedAt: nowBrazil(),
        }).where(eq(purchaseInvoices.id, existing.id)).returning();
        enriched = true;
      } else {
        [invoice] = await db.insert(purchaseInvoices).values({
          accessKey: parsed.accessKey || chave,
          invoiceNumber: parsed.invoiceNumber,
          series: parsed.series || "1",
          issueDate: issueDateParsed,
          supplierName: parsed.supplierName,
          supplierDocument: parsed.supplierDocument,
          supplierIe: parsed.supplierIe,
          totalValue: parsed.totalValue || "0",
          items: parsed.items,
          taxes: parsed.taxes,
          status: "imported",
          xmlContent: result.fullXml,
          omieInstanceId: instanceId,
          cfop: parsed.cfop,
          natureOfOperation: parsed.natureOfOperation,
          importedAt: nowBrazil(),
          createdBy: req.userId,
        }).returning();
      }

      res.json({ invoice, ambiente, enriched });
    } catch (err: any) {
      console.error("[PURCHASES] Import by key error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log("✅ Purchase/Radar routes registered");
}
