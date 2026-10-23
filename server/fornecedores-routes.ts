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
//
// Fornecedores críticos (23/out/2026):
//   - suppliers.is_critical + critical_approved_by (naiara|flavio) + critical_approved_at
//     + critical_valid_until (vigência da aprovação) + critical_notes
//   - tabela supplier_pendencias: documentos exigidos do cadastro (licença, laudo, alvará…)
//     com vigência própria e anexo (supplier_attachments.id)
//   - GET /api/suppliers/criticos/relatorio: todos os críticos com cadastro + pendências + situação

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
      // ---- fornecedores críticos ----
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_critical boolean NOT NULL DEFAULT false`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS critical_approved_by varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS critical_approved_at date`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS critical_valid_until date`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS critical_notes text`,
      `CREATE TABLE IF NOT EXISTS supplier_pendencias (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        supplier_id varchar NOT NULL,
        tipo varchar NOT NULL,
        descricao text,
        valid_until date,
        attachment_id varchar,
        created_by varchar, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_supplier_pend_supplier ON supplier_pendencias (supplier_id)`,
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

// ===== Fornecedores críticos =====
export const APROVADORES_CRITICO = ["naiara", "flavio"];
const dateOrNull = (v: any): string | null => {
  const s = txt(v, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const hoje = () => new Date().toISOString().slice(0, 10);
const diasAte = (d: any): number | null => {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  const ms = new Date(`${s}T00:00:00Z`).getTime() - new Date(`${hoje()}T00:00:00Z`).getTime();
  return Math.round(ms / 86400000);
};
// situação de uma data de vigência: vencido | vencendo (≤30 dias) | em_dia | sem_vigencia
export function situacaoVigencia(d: any): "vencido" | "vencendo" | "em_dia" | "sem_vigencia" {
  const n = diasAte(d);
  if (n == null) return "sem_vigencia";
  if (n < 0) return "vencido";
  if (n <= 30) return "vencendo";
  return "em_dia";
}
// situação de uma pendência: sem anexo → "pendente"; com anexo → situação da vigência
export function situacaoPendencia(p: any) {
  if (!p?.attachment_id) return "pendente";
  const v = situacaoVigencia(p.valid_until);
  return v === "sem_vigencia" ? "ok" : v === "em_dia" ? "ok" : v; // ok | vencendo | vencido
}
// situação consolidada do fornecedor crítico
export function situacaoFornecedor(s: any, pend: any[]) {
  if (!s?.critical_approved_by) return "nao_aprovado";
  const sit = pend.map(situacaoPendencia);
  const vig = situacaoVigencia(s.critical_valid_until);
  if (sit.includes("pendente")) return "pendente";
  if (vig === "vencido" || sit.includes("vencido")) return "vencido";
  if (vig === "vencendo" || sit.includes("vencendo")) return "vencendo";
  return "regular";
}

async function listarPendencias(supplierId: string) {
  const r = await db.execute(sql`
    SELECT p.id, p.supplier_id, p.tipo, p.descricao, p.valid_until, p.attachment_id,
           p.created_at, p.updated_at,
           a.file_name AS anexo_nome, a.mimetype AS anexo_mimetype, a.file_size AS anexo_tamanho
    FROM supplier_pendencias p
    LEFT JOIN supplier_attachments a ON a.id = p.attachment_id
    WHERE p.supplier_id = ${supplierId}
    ORDER BY p.created_at ASC`);
  return rows(r).map((p: any) => ({ ...p, situacao: situacaoPendencia(p) }));
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
      const pendencias = await listarPendencias(req.params.id);
      res.json({ ...s, anexos: await listarAnexos(req.params.id), pendencias, situacao_critico: s.is_critical ? situacaoFornecedor(s, pendencias) : null });
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

      // fornecedor crítico
      const isCritical = !!b.isCritical;
      const aprovador = txt(b.criticalApprovedBy, 40)?.toLowerCase() ?? null;
      if (aprovador && !APROVADORES_CRITICO.includes(aprovador)) return res.status(400).json({ error: "Aprovador inválido (Naiara ou Flavio)" });
      const aprovadoEm = dateOrNull(b.criticalApprovedAt) ?? (aprovador ? hoje() : null);
      const vigenciaAte = dateOrNull(b.criticalValidUntil);

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
          is_critical = ${isCritical},
          critical_approved_by = ${aprovador},
          critical_approved_at = ${aprovador ? aprovadoEm : null},
          critical_valid_until = ${vigenciaAte},
          critical_notes = ${txt(b.criticalNotes, 2000)},
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

  // ===== Pendências do cadastro (fornecedor crítico) =====
  app.get("/api/suppliers/:id/pendencias", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureFornecedoresSchema();
      res.json(await listarPendencias(req.params.id));
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // cria a pendência; arquivo opcional no campo 'arquivo' (multipart) — vira anexo do fornecedor
  app.post("/api/suppliers/:id/pendencias", ...guard, (req: Request, res: Response, next: any) => {
    upload.single("arquivo")(req as any, res as any, (err: any) => {
      if (err) return res.status(400).json({ error: err?.code === "LIMIT_FILE_SIZE" ? "Arquivo acima de 15MB" : (err?.message || "Falha no upload") });
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      await ensureFornecedoresSchema();
      const id = req.params.id;
      const ex = rows(await db.execute(sql`SELECT id FROM suppliers WHERE id = ${id} LIMIT 1`));
      if (!ex[0]) return res.status(404).json({ error: "Fornecedor não encontrado" });
      const tipo = txt(req.body?.tipo, 120);
      if (!tipo) return res.status(400).json({ error: "Informe o tipo da pendência (ex.: Licença sanitária, Laudo)" });
      const descricao = txt(req.body?.descricao, 1000);
      const validUntil = dateOrNull(req.body?.validUntil ?? req.body?.valid_until);

      let attachmentId: string | null = null;
      const f = (req as any).file;
      if (f) {
        const a = rows(await db.execute(sql`
          INSERT INTO supplier_attachments (supplier_id, file_name, mimetype, file_size, data, descricao, created_by)
          VALUES (${id}, ${f.originalname}, ${f.mimetype}, ${f.size}, ${f.buffer.toString("base64")},
                  ${`Pendência: ${tipo}${validUntil ? ` (vigência até ${validUntil})` : ""}`}, ${userId(req)})
          RETURNING id`));
        attachmentId = a[0]?.id ?? null;
      }
      const r = rows(await db.execute(sql`
        INSERT INTO supplier_pendencias (supplier_id, tipo, descricao, valid_until, attachment_id, created_by)
        VALUES (${id}, ${tipo}, ${descricao}, ${validUntil}, ${attachmentId}, ${userId(req)})
        RETURNING id`));
      const lista = await listarPendencias(id);
      res.status(201).json(lista.find((p: any) => p.id === r[0]?.id) ?? { id: r[0]?.id });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // atualiza tipo/descrição/vigência e, se vier arquivo, troca o anexo
  app.put("/api/suppliers/pendencias/:pendId", ...guard, (req: Request, res: Response, next: any) => {
    upload.single("arquivo")(req as any, res as any, (err: any) => {
      if (err) return res.status(400).json({ error: err?.code === "LIMIT_FILE_SIZE" ? "Arquivo acima de 15MB" : (err?.message || "Falha no upload") });
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      await ensureFornecedoresSchema();
      const pendId = req.params.pendId;
      const atual = rows(await db.execute(sql`SELECT * FROM supplier_pendencias WHERE id = ${pendId} LIMIT 1`))[0];
      if (!atual) return res.status(404).json({ error: "Pendência não encontrada" });
      const b = req.body || {};
      const tipo = b.tipo !== undefined ? (txt(b.tipo, 120) ?? atual.tipo) : atual.tipo;
      const descricao = b.descricao !== undefined ? txt(b.descricao, 1000) : atual.descricao;
      const validUntil = (b.validUntil !== undefined || b.valid_until !== undefined)
        ? dateOrNull(b.validUntil ?? b.valid_until) : (atual.valid_until ? String(atual.valid_until).slice(0, 10) : null);

      let attachmentId: string | null = atual.attachment_id ?? null;
      const f = (req as any).file;
      if (f) {
        const a = rows(await db.execute(sql`
          INSERT INTO supplier_attachments (supplier_id, file_name, mimetype, file_size, data, descricao, created_by)
          VALUES (${atual.supplier_id}, ${f.originalname}, ${f.mimetype}, ${f.size}, ${f.buffer.toString("base64")},
                  ${`Pendência: ${tipo}${validUntil ? ` (vigência até ${validUntil})` : ""}`}, ${userId(req)})
          RETURNING id`));
        const novoId = a[0]?.id ?? null;
        if (novoId && attachmentId) {
          // anexo antigo da pendência sai junto (era só dela)
          await db.execute(sql`DELETE FROM supplier_attachments WHERE id = ${attachmentId}`);
        }
        attachmentId = novoId;
      } else if (b.removerAnexo === "1" || b.removerAnexo === true) {
        if (attachmentId) await db.execute(sql`DELETE FROM supplier_attachments WHERE id = ${attachmentId}`);
        attachmentId = null;
      }
      await db.execute(sql`
        UPDATE supplier_pendencias SET tipo = ${tipo}, descricao = ${descricao}, valid_until = ${validUntil},
          attachment_id = ${attachmentId}, updated_at = NOW()
        WHERE id = ${pendId}`);
      const lista = await listarPendencias(atual.supplier_id);
      res.json(lista.find((p: any) => p.id === pendId));
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.delete("/api/suppliers/pendencias/:pendId", ...guard, async (req: Request, res: Response) => {
    try {
      const atual = rows(await db.execute(sql`SELECT attachment_id FROM supplier_pendencias WHERE id = ${req.params.pendId} LIMIT 1`))[0];
      if (!atual) return res.status(404).json({ error: "Pendência não encontrada" });
      if (atual.attachment_id) await db.execute(sql`DELETE FROM supplier_attachments WHERE id = ${atual.attachment_id}`);
      await db.execute(sql`DELETE FROM supplier_pendencias WHERE id = ${req.params.pendId}`);
      console.log("[FORNECEDORES] pendência excluída", req.params.pendId, "por", userId(req));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ===== Relatório: todos os fornecedores críticos com o cadastro + pendências =====
  app.get("/api/suppliers/criticos/relatorio", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureFornecedoresSchema();
      const incluirInativos = req.query.inativos === "1";
      const forn = rows(await db.execute(sql`
        SELECT id, name, company_name, cnpj, cpf, state_registration, email, phone, contact_name,
               address, address_number, address_complement, neighborhood, city, state, zip_code,
               default_category, notes, is_active, payment_method, payment_terms,
               is_critical, critical_approved_by, critical_approved_at, critical_valid_until, critical_notes,
               created_at, updated_at
        FROM suppliers
        WHERE is_critical = true ${incluirInativos ? sql`` : sql`AND COALESCE(is_active, true) = true`}
        ORDER BY name ASC`));
      const ids = forn.map((f: any) => f.id);
      let pend: any[] = [];
      if (ids.length) {
        pend = rows(await db.execute(sql`
          SELECT p.id, p.supplier_id, p.tipo, p.descricao, p.valid_until, p.attachment_id, p.created_at, p.updated_at,
                 a.file_name AS anexo_nome
          FROM supplier_pendencias p
          LEFT JOIN supplier_attachments a ON a.id = p.attachment_id
          WHERE p.supplier_id IN (${sql.join(ids.map((i: string) => sql`${i}`), sql`, `)})
          ORDER BY p.created_at ASC`));
      }
      const porForn = new Map<string, any[]>();
      for (const p of pend) {
        const lista = porForn.get(p.supplier_id) ?? [];
        lista.push({ ...p, situacao: situacaoPendencia(p), dias_para_vencer: diasAte(p.valid_until) });
        porForn.set(p.supplier_id, lista);
      }
      const itens = forn.map((f: any) => {
        const pendencias = porForn.get(f.id) ?? [];
        return {
          ...f,
          pendencias,
          total_pendencias: pendencias.length,
          pendencias_sem_anexo: pendencias.filter((p) => p.situacao === "pendente").length,
          pendencias_vencidas: pendencias.filter((p) => p.situacao === "vencido").length,
          pendencias_vencendo: pendencias.filter((p) => p.situacao === "vencendo").length,
          situacao_vigencia: situacaoVigencia(f.critical_valid_until),
          dias_para_vencer: diasAte(f.critical_valid_until),
          situacao: situacaoFornecedor(f, pendencias),
        };
      });
      const resumo = {
        total: itens.length,
        regular: itens.filter((i) => i.situacao === "regular").length,
        vencendo: itens.filter((i) => i.situacao === "vencendo").length,
        vencido: itens.filter((i) => i.situacao === "vencido").length,
        pendente: itens.filter((i) => i.situacao === "pendente").length,
        nao_aprovado: itens.filter((i) => i.situacao === "nao_aprovado").length,
      };
      res.json({ gerado_em: new Date().toISOString(), resumo, itens });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });
}
