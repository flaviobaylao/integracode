import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

// ─────────────────────────────────────────────────────────────────────────────
// Importação do histórico de NF-e do Omie (backup "BKP OMIE") para o Integra 2.0.
//
// Popula fiscal_invoices (cabeçalho) + fiscal_invoice_items (itens/produtos),
// sinalizando tudo com import_origin='omie_historico' + import_batch_id.
// Dedup pela chave de acesso (access_key). Só INSERT do que falta — nunca
// atualiza/apaga registro existente. Idempotente.
//
// Colunas import_origin / import_batch_id são garantidas no boot (index.ts).
// ──────────────────────────────────────────────────────────────────────────────

const onlyDigits = (s: any) => String(s ?? "").replace(/\D/g, "");

// cache CNPJ(normalizado) -> omie_instances.id
let _instMap: Record<string, string> | null = null;
async function instanceIdByCnpj(cnpj: string): Promise<string | null> {
  if (!_instMap) {
    _instMap = {};
    try {
      const r: any = await db.execute(sql`SELECT id, cnpj FROM omie_instances WHERE cnpj IS NOT NULL`);
      for (const row of (r.rows || [])) {
        const k = onlyDigits(row.cnpj);
        if (k) _instMap[k] = row.id;
      }
    } catch (e: any) {
      console.warn("[omie-import] falha ao carregar omie_instances:", e?.message);
    }
  }
  return _instMap[onlyDigits(cnpj)] || null;
}

function isAdmin(req: any): boolean {
  const u = req.currentUser;
  return !!u && (u.role === "admin" || u.role === "administrative");
}

export function registerOmieNfeImportRoutes(app: Express): void {
  // ── Importar um lote de NF-e ────────────────────────────────────────────────
  app.post("/api/admin/import/omie-nfe", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      const { batchId, dryRun, invoices } = req.body || {};
      if (!batchId) return res.status(400).json({ message: "batchId obrigatório" });
      if (!Array.isArray(invoices)) return res.status(400).json({ message: "invoices[] obrigatório" });

      let inserted = 0, skipped = 0, itemsInserted = 0, failed = 0;
      const errors: any[] = [];

      for (const inv of invoices) {
        const ak = onlyDigits(inv?.accessKey);
        try {
          if (ak.length !== 44) { failed++; errors.push({ ak: inv?.accessKey, e: "accessKey inválida" }); continue; }

          // Dedup: já existe?
          const ex: any = await db.execute(sql`SELECT id FROM fiscal_invoices WHERE access_key = ${ak} LIMIT 1`);
          if (ex.rows && ex.rows.length) { skipped++; continue; }

          const items = Array.isArray(inv.items) ? inv.items : [];
          if (dryRun) { inserted++; itemsInserted += items.length; continue; }

          const instId = await instanceIdByCnpj(inv.issuerCnpj);
          const env = String(inv.tpAmb) === "1" ? "producao" : "homologacao";
          const status = inv.status || "authorized";

          const ins: any = await db.execute(sql`
            INSERT INTO fiscal_invoices (
              invoice_number, series, access_key, status, operation_type,
              nature_of_operation, cfop,
              issuer_name, issuer_cnpj, issuer_ie,
              customer_name, customer_cnpj_cpf, customer_ie, customer_address,
              customer_bairro, customer_cep, customer_city, customer_uf,
              total_products, total_discount, total_icms, total_pis, total_cofins, total_ipi, total_invoice,
              emission_date, authorization_date, xml_autorizacao,
              environment, omie_instance_id, fin_nfe,
              import_origin, import_batch_id
            ) VALUES (
              ${inv.invoiceNumber ?? null}, ${inv.series ?? "1"}, ${ak}, ${status}, 'saida',
              ${inv.natureOfOperation ?? null}, ${inv.cfop ?? null},
              ${inv.issuerName ?? null}, ${onlyDigits(inv.issuerCnpj) || null}, ${inv.issuerIe ?? null},
              ${inv.customerName ?? null}, ${onlyDigits(inv.customerDoc) || null}, ${inv.customerIe ?? null}, ${inv.customerAddress ?? null},
              ${inv.customerBairro ?? null}, ${onlyDigits(inv.customerCep) || null}, ${inv.customerCity ?? null}, ${inv.customerUf ?? null},
              ${inv.totalProducts ?? 0}, ${inv.totalDiscount ?? 0}, ${inv.totalIcms ?? 0}, ${inv.totalPis ?? 0}, ${inv.totalCofins ?? 0}, ${inv.totalIpi ?? 0}, ${inv.totalInvoice ?? 0},
              ${inv.emissionDate ?? null}, ${inv.authorizationDate ?? inv.emissionDate ?? null}, ${inv.xml ?? null},
              ${env}, ${instId}, ${inv.finNFe ?? "1"},
              'omie_historico', ${batchId}
            ) RETURNING id
          `);
          const invoiceId = ins.rows?.[0]?.id;
          if (!invoiceId) { failed++; errors.push({ ak, e: "sem id retornado" }); continue; }
          inserted++;

          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            await db.execute(sql`
              INSERT INTO fiscal_invoice_items (
                invoice_id, item_number, product_code, product_name,
                ncm, cest, cfop, unit, quantity, unit_price, total_price,
                csosn, cst_icms, valor_icms,
                import_origin, import_batch_id
              ) VALUES (
                ${invoiceId}, ${it.itemNumber ?? (i + 1)}, ${it.productCode ?? null}, ${it.productName ?? "PRODUTO"},
                ${it.ncm ?? null}, ${it.cest ?? null}, ${it.cfop ?? null}, ${it.unit ?? "UN"},
                ${it.quantity ?? 0}, ${it.unitPrice ?? 0}, ${it.totalPrice ?? 0},
                ${it.csosn ?? null}, ${it.cstIcms ?? null}, ${it.valorIcms ?? 0},
                'omie_historico', ${batchId}
              )
            `);
            itemsInserted++;
          }
        } catch (e: any) {
          failed++;
          if (errors.length < 30) errors.push({ ak, e: e?.message || String(e) });
        }
      }

      res.json({ ok: true, dryRun: !!dryRun, received: invoices.length, inserted, skipped, itemsInserted, failed, errors });
    } catch (error: any) {
      console.error("[omie-import] erro:", error);
      res.status(500).json({ message: "Falha na importação", error: error?.message });
    }
  });

  // ── Resumo do que já foi importado ──────────────────────────────────────────
  app.get("/api/admin/import/omie-nfe/summary", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      const q = req.query.batchId ? sql`WHERE import_batch_id = ${String(req.query.batchId)}` : sql`WHERE import_origin = 'omie_historico'`;
      const inv: any = await db.execute(sql`SELECT count(*)::int AS n, coalesce(sum(total_invoice),0)::numeric AS total FROM fiscal_invoices ${q}`);
      const items: any = await db.execute(sql`SELECT count(*)::int AS n FROM fiscal_invoice_items ${q}`);
      const byInst: any = await db.execute(sql`SELECT issuer_cnpj, count(*)::int AS n FROM fiscal_invoices ${q} GROUP BY issuer_cnpj ORDER BY n DESC`);
      res.json({ invoices: inv.rows?.[0]?.n ?? 0, invoicesTotal: inv.rows?.[0]?.total ?? 0, items: items.rows?.[0]?.n ?? 0, byIssuer: byInst.rows || [] });
    } catch (error: any) {
      res.status(500).json({ message: error?.message });
    }
  });

  // ── Rollback de um lote (segurança) ─────────────────────────────────────────
  app.post("/api/admin/import/omie-nfe/rollback", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      const { batchId, confirm } = req.body || {};
      if (!batchId || confirm !== batchId) return res.status(400).json({ message: "batchId + confirm (igual ao batchId) obrigatórios" });
      const di: any = await db.execute(sql`DELETE FROM fiscal_invoice_items WHERE import_batch_id = ${batchId}`);
      const dh: any = await db.execute(sql`DELETE FROM fiscal_invoices WHERE import_batch_id = ${batchId}`);
      res.json({ ok: true, deletedItems: di.rowCount ?? null, deletedInvoices: dh.rowCount ?? null });
    } catch (error: any) {
      res.status(500).json({ message: error?.message });
    }
  });
}
