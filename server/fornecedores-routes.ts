// server/fornecedores-routes.ts
// Cadastro de Fornecedores — edição completa, dados de pagamento e anexos (14/out/2026).
//
//   - dados de pagamento: colunas novas em `suppliers` (ALTER no boot, idempotente)
//       forma de pagamento (boleto/transferência/PIX/...), prazo, banco, agência,
//       conta, tipo de conta, titular + documento, tipo/chave PIX, observações
//   - edição completa: PUT /api/suppliers/:id/cadastro grava TODOS os campos
//       (permite limpar campo; o PUT antigo /api/suppliers/:id usa COALESCE e fica
//       como está para quem já o chama)
//   - anexos: tabela supplier_attachments (base64, até 15MB — mesmo padrão do Comodatos)

import type { Express, Request, Response } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const ROLES = ["admin", "coordinator", "administrative"];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

export const FORMAS_PAGAMENTO = ["boleto", "transferencia", "pix", "dinheiro", "cartao", "deposito", "debito_automatico", "outro"];
export const TIPOS_CHAVE_PIX = ["cpf", "cnpj", "email", "telefone", "aleatoria"];
export const TIPOS_CONTA = ["corrente", "poupanca", "pagamento"];

const rows = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
const digits = (v: any) => (v == null ? "" : String(v)).replace(/\D/g, "");
const txt = (v: any, max = 500): string | null => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s === "" ? null : s;
};
const userId = (req: any) => req?.currentUser?.id || req?.user?.id || null;

let __ensured: Promise<void> | null = null;
export function ensureFornecedoresSchema(): Promise<void> {
  if (!__ensured) __ensured = (async () => {
    const stmts = [
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_method varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_code varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_name varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_agency varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account_type varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS account_holder_name varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS account_holder_document varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pix_key_type varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pix_key varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_notes text`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address_complement varchar`,
      `CREATE TABLE IF NOT EXISTS supplier_attachments (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        supplier_id varchar NOT NULL,
        file_name text, mimetype text, file_size integer NOT NULL DEFAULT 0,
        data text, descricao text,
        created_by varchar, created_at timestamptz DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_supplier_att_supplier ON supplier_attachments (supplier_id)`,
    ];
    for (const s of stmts) {
      try { await db.execute(sql.raw(s)); } catch (e: any) { console.warn("[FORNECEDORES] migração (ignorada):", e?.message); }
    }
  })().catch((e) => { __ensured = null; throw e; });
  return __ensured;
}

async function listarAnexos(supplierId: string) {
  const r = await db.execute(sql`
    SELECT id, file_name, mimetype, file_size, descricao, created_at
    FROM supplier_attachments WHERE supplier_id = ${supplierId} ORDER BY created_at DESC`);
  return rows(r);
}

export function registerFornecedoresRoutes(app: Express) {
  const guard = [authenticateUser, requireRole(ROLES)] as any[];
  ensureFornecedoresSchema().catch((e) => console.error("[FORNECEDORES] ensure:", e?.message));

  // Cadastro completo + anexos (para o formulário de edição)
  app.get("/api/suppliers/:id/cadastro", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureFornecedoresSchema();
      const r = await db.execute(sql`SELECT * FROM suppliers WHERE id = ${req.params.id} LIMIT 1`);
      const s = rows(r)[0];
      if (!s) return res.status(404).json({ error: "Fornecedor não encontrado" });
      res.json({ ...s, anexos: await listarAnexos(req.params.id) });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // Edição completa (grava todos os campos; vazio = limpa)
  app.put("/api/suppliers/:id/cadastro", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureFornecedoresSchema();
      const b = req.body || {};
      const id = req.params.id;
      const name = txt(b.name, 300) || txt(b.companyName, 300);
      if (!name) return res.status(400).json({ error: "Nome do fornecedor obrigatório" });
      const cnpj = digits(b.cnpj);
      const cpf = digits(b.cpf);
      if (cnpj || cpf) {
        const ex = rows(await db.execute(sql`
          SELECT id, name FROM suppliers
          WHERE id <> ${id} AND (
            (${cnpj} <> '' AND regexp_replace(COALESCE(cnpj,''),'\D','','g') = ${cnpj})
            OR (${cpf} <> '' AND regexp_replace(COALESCE(cpf,''),'\D','','g') = ${cpf}))
          LIMIT 1`));
        if (ex[0]) return res.status(409).json({ error: `CNPJ/CPF já usado no fornecedor "${ex[0].name}"`, existingId: ex[0].id });
      }
      const pm = txt(b.paymentMethod, 40);
      if (pm && !FORMAS_PAGAMENTO.includes(pm)) return res.status(400).json({ error: "Forma de pagamento inválida" });
      const pixType = txt(b.pixKeyType, 20);
      if (pixType && !TIPOS_CHAVE_PIX.includes(pixType)) return res.status(400).json({ error: "Tipo de chave PIX inválido" });
      const accType = txt(b.bankAccountType, 20);
      if (accType && !TIPOS_CONTA.includes(accType)) return res.status(400).json({ error: "Tipo de conta inválido" });
      const isActive = b.isActive === undefined || b.isActive === null ? true : !!b.isActive;

      const r = await db.execute(sql`
        UPDATE suppliers SET
          name = ${name},
          company_name = ${txt(b.companyName, 300)},
          cnpj = ${cnpj || null},
          cpf = ${cpf || null},
          state_registration = ${txt(b.stateRegistration, 40)},
          email = ${txt(b.email, 200)},
          phone = ${txt(b.phone, 60)},
          contact_name = ${txt(b.contactName, 200)},
          address = ${txt(b.address, 300)},
          address_number = ${txt(b.addressNumber, 30)},
          address_complement = ${txt(b.addressComplement, 200)},
          neighborhood = ${txt(b.neighborhood, 150)},
          city = ${txt(b.city, 150)},
          state = ${txt(b.state, 2)?.toUpperCase() ?? null},
          zip_code = ${digits(b.zipCode) || null},
          default_category = ${txt(b.defaultCategory, 150)},
          notes = ${txt(b.notes, 4000)},
          is_active = ${isActive},
          payment_method = ${pm},
          payment_terms = ${txt(b.paymentTerms, 100)},
          bank_code = ${txt(b.bankCode, 10)},
          bank_name = ${txt(b.bankName, 150)},
          bank_agency = ${txt(b.bankAgency, 20)},
          bank_account = ${txt(b.bankAccount, 40)},
          bank_account_type = ${accType},
          account_holder_name = ${txt(b.accountHolderName, 200)},
          account_holder_document = ${digits(b.accountHolderDocument) || null},
          pix_key_type = ${pixType},
          pix_key = ${txt(b.pixKey, 150)},
          payment_notes = ${txt(b.paymentNotes, 2000)},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING id`);
      if (!rows(r)[0]) return res.status(404).json({ error: "Fornecedor não encontrado" });
      console.log("[FORNECEDORES] cadastro atualizado", id, "por", userId(req));
      res.json({ ok: true, id });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ===== Anexos =====
  app.post("/api/suppliers/:id/anexos", ...guard, (req: Request, res: Response, next: any) => {
    upload.single("arquivo")(req as any, res as any, (err: any) => {
      if (err) return res.status(400).json({ error: err?.code === "LIMIT_FILE_SIZE" ? "Arquivo acima de 15MB" : (err?.message || "Falha no upload") });
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      await ensureFornecedoresSchema();
      const f = (req as any).file;
      if (!f) return res.status(400).json({ error: "Envie o arquivo no campo 'arquivo'" });
      const ex = rows(await db.execute(sql`SELECT id FROM suppliers WHERE id = ${req.params.id} LIMIT 1`));
      if (!ex[0]) return res.status(404).json({ error: "Fornecedor não encontrado" });
      const r = await db.execute(sql`
        INSERT INTO supplier_attachments (supplier_id, file_name, mimetype, file_size, data, descricao, created_by)
        VALUES (${req.params.id}, ${f.originalname}, ${f.mimetype}, ${f.size}, ${f.buffer.toString("base64")},
                ${txt(req.body?.descricao, 300)}, ${userId(req)})
        RETURNING id, file_name, mimetype, file_size, descricao, created_at`);
      res.status(201).json(rows(r)[0]);
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.get("/api/suppliers/anexos/:attId", ...guard, async (req: Request, res: Response) => {
    try {
      const r = await db.execute(sql`SELECT file_name, mimetype, data FROM supplier_attachments WHERE id = ${req.params.attId}`);
      const row = rows(r)[0];
      if (!row?.data) return res.status(404).json({ error: "Anexo não encontrado" });
      const buf = Buffer.from(String(row.data), "base64");
      const nome = encodeURIComponent(row.file_name || "anexo");
      const disp = req.query.download ? "attachment" : "inline";
      res.setHeader("Content-Type", row.mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `${disp}; filename*=UTF-8''${nome}`);
      res.send(buf);
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.delete("/api/suppliers/anexos/:attId", ...guard, async (req: Request, res: Response) => {
    try {
      await db.execute(sql`DELETE FROM supplier_attachments WHERE id = ${req.params.attId}`);
      console.log("[FORNECEDORES] anexo excluído", req.params.attId, "por", userId(req));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });
}
