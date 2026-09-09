// DOCUMENTOS DA EMPRESA (módulo Indústria › aba Documentos) — 05/set/2026
// ---------------------------------------------------------------------------
// Repositório de documentos institucionais/regulatórios da Honest: alvará
// sanitário, licença de funcionamento, AVCB, contrato social, certificado
// digital, laudos, registro de produto etc. Cada registro tem:
//   nome · instância (IND/GYN/SERV/BSB…) · vigência (início/fim) · status ·
//   arquivo anexado (opcional, qualquer tipo, até 15MB) · observações.
//
// O prefixo /api/industria já é protegido no index.ts
// (app.use('/api/industria', authenticateUser, requireRole(['admin']))), por
// isso as rotas aqui não repetem o middleware — igual a industria-routes.ts e
// raw-material-attachments-routes.ts.
//
// Mesmo desenho dos anexos de matéria-prima: binário em base64 numa coluna
// própria; a listagem NUNCA devolve a coluna data.
//
// Status é manual (vigente / em_renovacao / vencido / suspenso), mas a lista
// devolve também `situacao` calculada pela data de vigência (vencido /
// a_vencer em 30 dias / em_dia / sem_vigencia) para o alerta na tela — o
// documento pode estar marcado "vigente" e já ter passado da data.
//
// A lista de instâncias vem do cadastro de filiais (tabela omie_instances,
// name/display_name). É só o cadastro local de filiais — nenhuma chamada à
// API do Omie.
import type { Express } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const STATUS_VALIDOS = ["vigente", "em_renovacao", "vencido", "suspenso"];
const DIAS_ALERTA = 30;
const CORES_CATEGORIA = ["emerald", "blue", "amber", "violet", "rose", "cyan", "orange", "slate"];
// Sugestões iniciais — criadas só na primeira vez (tabela vazia). A partir daí
// quem manda é o cadastro do usuário (aba Documentos › Categorias).
const CATEGORIAS_PADRAO = [
  { name: "Regulatório / Sanitário", color: "emerald" },
  { name: "Fiscal", color: "blue" },
  { name: "Jurídico / Societário", color: "violet" },
  { name: "Certificados", color: "amber" },
  { name: "Laudos e Análises", color: "cyan" },
  { name: "Códigos de Barras", color: "orange" },
  { name: "Outros", color: "slate" },
];

const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

let schemaReady: Promise<void> | null = null;
export function ensureCompanyDocumentsSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS company_documents (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "name text NOT NULL, " +
        "instance_name varchar NOT NULL DEFAULT 'IND', " +
        "valid_from date, " +
        "valid_until date, " +
        "status varchar NOT NULL DEFAULT 'vigente', " +
        "notes text, " +
        "file_name text, " +
        "mimetype text, " +
        "file_size integer NOT NULL DEFAULT 0, " +
        "data text, " +
        "created_by varchar, " +
        "updated_by varchar, " +
        "created_at timestamptz DEFAULT now(), " +
        "updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_company_documents_instance ON company_documents (instance_name)"
      )).catch(() => {});
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_company_documents_valid_until ON company_documents (valid_until)"
      )).catch(() => {});
      // --- categorias de documento (05/set → categoria obrigatória, 09/set/2026) ---
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS company_document_categories (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "name text NOT NULL, " +
        "description text, " +
        "color varchar NOT NULL DEFAULT 'slate', " +
        "sort_order integer NOT NULL DEFAULT 0, " +
        "is_active boolean NOT NULL DEFAULT true, " +
        "created_at timestamptz DEFAULT now(), " +
        "updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_company_doc_categories_name ON company_document_categories (lower(name))"
      )).catch(() => {});
      await db.execute(sql.raw(
        "ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS category_id varchar"
      )).catch(() => {});
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_company_documents_category ON company_documents (category_id)"
      )).catch(() => {});
      // Seed only once (tabela vazia) — depois disso o cadastro é do usuário.
      const cnt: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM company_document_categories`);
      if (Number(cnt.rows?.[0]?.n || 0) === 0) {
        for (let i = 0; i < CATEGORIAS_PADRAO.length; i++) {
          const c = CATEGORIAS_PADRAO[i];
          await db.execute(sql`
            INSERT INTO company_document_categories (name, color, sort_order)
            VALUES (${c.name}, ${c.color}, ${i})
            ON CONFLICT DO NOTHING`).catch(() => {});
        }
      }
      // Todo documento precisa de categoria: os antigos caem em "Outros".
      const semCat: any = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM company_documents WHERE category_id IS NULL`);
      if (Number(semCat.rows?.[0]?.n || 0) > 0) {
        const outros: any = await db.execute(sql`
          SELECT id FROM company_document_categories WHERE lower(name) = 'outros' LIMIT 1`);
        let outrosId = outros.rows?.[0]?.id;
        if (!outrosId) {
          const ins: any = await db.execute(sql`
            INSERT INTO company_document_categories (name, color, sort_order)
            VALUES ('Outros', 'slate', 99) RETURNING id`);
          outrosId = ins.rows?.[0]?.id;
        }
        if (outrosId) {
          await db.execute(sql`
            UPDATE company_documents SET category_id = ${outrosId} WHERE category_id IS NULL`);
        }
      }
    })().catch((e: any) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function hojeBR(): string {
  // data civil de Brasília (yyyy-mm-dd), sem depender do TZ do container
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function diasAte(dataISO: string | null): number | null {
  if (!dataISO) return null;
  const a = new Date(hojeBR() + "T00:00:00Z").getTime();
  const b = new Date(String(dataISO).slice(0, 10) + "T00:00:00Z").getTime();
  if (isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function situacaoDe(validUntil: string | null): { situacao: string; diasRestantes: number | null } {
  const d = diasAte(validUntil);
  if (d === null) return { situacao: "sem_vigencia", diasRestantes: null };
  if (d < 0) return { situacao: "vencido", diasRestantes: d };
  if (d <= DIAS_ALERTA) return { situacao: "a_vencer", diasRestantes: d };
  return { situacao: "em_dia", diasRestantes: d };
}

function dataOuNull(v: any): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function toISODate(v: any): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapRow(row: any) {
  const validUntil = toISODate(row.valid_until);
  const { situacao, diasRestantes } = situacaoDe(validUntil);
  return {
    id: row.id,
    name: row.name,
    instanceName: row.instance_name,
    validFrom: toISODate(row.valid_from),
    validUntil,
    status: row.status,
    notes: row.notes || "",
    fileName: row.file_name || null,
    mimetype: row.mimetype || null,
    fileSize: Number(row.file_size || 0),
    hasFile: !!row.file_name,
    categoryId: row.category_id || null,
    categoryName: row.category_name || null,
    categoryColor: row.category_color || "slate",
    situacao,
    diasRestantes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function podeEditar(user: any): boolean {
  return ["admin", "coordinator"].includes(user?.role || "");
}

function multerSingle(req: any, res: any, next: any) {
  uploadDoc.single("arquivo")(req, res, (err: any) => {
    if (err) {
      const msg = err?.code === "LIMIT_FILE_SIZE"
        ? "Arquivo acima de 15MB"
        : (err?.message || "Falha no upload");
      return res.status(400).json({ message: msg });
    }
    next();
  });
}

function validarCampos(body: any, parcial = false): { erro?: string; campos?: any } {
  const campos: any = {};
  if (!parcial || body.name !== undefined) {
    const name = String(body.name ?? "").trim().slice(0, 200);
    if (!name) return { erro: "Informe o nome do documento" };
    campos.name = name;
  }
  if (!parcial || body.instanceName !== undefined) {
    const inst = String(body.instanceName ?? "").trim().toUpperCase().slice(0, 40);
    if (!inst) return { erro: "Informe a instância" };
    campos.instanceName = inst;
  }
  if (!parcial || body.status !== undefined) {
    const status = String(body.status ?? "vigente").trim();
    if (!STATUS_VALIDOS.includes(status)) return { erro: "Status inválido" };
    campos.status = status;
  }
  if (body.validFrom !== undefined) {
    if (String(body.validFrom ?? "").trim() && !dataOuNull(body.validFrom)) return { erro: "Data de início inválida" };
    campos.validFrom = dataOuNull(body.validFrom);
  }
  if (body.validUntil !== undefined) {
    if (String(body.validUntil ?? "").trim() && !dataOuNull(body.validUntil)) return { erro: "Data de fim inválida" };
    campos.validUntil = dataOuNull(body.validUntil);
  }
  if (campos.validFrom && campos.validUntil && campos.validFrom > campos.validUntil) {
    return { erro: "Início da vigência não pode ser depois do fim" };
  }
  if (!parcial || body.categoryId !== undefined) {
    const cat = String(body.categoryId ?? "").trim();
    if (!cat) return { erro: "Selecione a categoria do documento" };
    campos.categoryId = cat;
  }
  if (body.notes !== undefined) campos.notes = String(body.notes ?? "").slice(0, 2000) || null;
  return { campos };
}

// ---------------------------------------------------------------------------
// rotas
// ---------------------------------------------------------------------------
export function registerCompanyDocumentsRoutes(app: Express) {
  ensureCompanyDocumentsSchema().catch((e: any) =>
    console.error("[DOCS-EMPRESA] schema:", e?.message || e)
  );

  // Instâncias disponíveis para o select (cadastro local de filiais).
  app.get("/api/industria/documentos/instancias", async (_req: any, res) => {
    try {
      const r: any = await db.execute(sql`
        SELECT name, display_name FROM omie_instances
        WHERE is_active = true ORDER BY is_default DESC, name`).catch(() => ({ rows: [] }));
      const lista = (r.rows || []).map((row: any) => ({
        name: String(row.name || "").toUpperCase(),
        displayName: row.display_name || row.name,
      }));
      // Garante IND (indústria) mesmo se o cadastro de filiais não a tiver.
      if (!lista.some((i: any) => i.name === "IND")) lista.unshift({ name: "IND", displayName: "Indústria" });
      // Inclui instâncias já usadas em documentos (não perde histórico se uma filial for desativada).
      await ensureCompanyDocumentsSchema();
      const usadas: any = await db.execute(sql`SELECT DISTINCT instance_name FROM company_documents`);
      for (const row of usadas.rows || []) {
        const nm = String(row.instance_name || "").toUpperCase();
        if (nm && !lista.some((i: any) => i.name === nm)) lista.push({ name: nm, displayName: nm });
      }
      res.json(lista);
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] instancias:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar instâncias" });
    }
  });

  // -------------------------------------------------------------------------
  // CATEGORIAS DE DOCUMENTO (cadastro livre; todo documento tem uma)
  // Registradas ANTES de /:id para não serem capturadas pela rota com parâmetro.
  // -------------------------------------------------------------------------
  app.get("/api/industria/documentos/categorias", async (_req: any, res) => {
    try {
      await ensureCompanyDocumentsSchema();
      const r: any = await db.execute(sql`
        SELECT c.id, c.name, c.description, c.color, c.sort_order, c.is_active,
               COUNT(d.id)::int AS total_documentos
        FROM company_document_categories c
        LEFT JOIN company_documents d ON d.category_id = c.id
        GROUP BY c.id
        ORDER BY c.sort_order, c.name`);
      res.json((r.rows || []).map((row: any) => ({
        id: row.id,
        name: row.name,
        description: row.description || "",
        color: row.color || "slate",
        sortOrder: Number(row.sort_order || 0),
        isActive: row.is_active !== false,
        totalDocumentos: Number(row.total_documentos || 0),
      })));
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] categorias:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar categorias" });
    }
  });

  app.post("/api/industria/documentos/categorias", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureCompanyDocumentsSchema();
      const name = String(req.body?.name ?? "").trim().slice(0, 120);
      if (!name) return res.status(400).json({ message: "Informe o nome da categoria" });
      const dup: any = await db.execute(sql`
        SELECT id FROM company_document_categories WHERE lower(name) = ${name.toLowerCase()}`);
      if (dup.rows?.length) return res.status(400).json({ message: "Já existe uma categoria com esse nome" });
      const color = CORES_CATEGORIA.includes(String(req.body?.color || "")) ? String(req.body.color) : "slate";
      const description = String(req.body?.description ?? "").slice(0, 300) || null;
      const ordem = Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 50;
      const r: any = await db.execute(sql`
        INSERT INTO company_document_categories (name, description, color, sort_order)
        VALUES (${name}, ${description}, ${color}, ${ordem})
        RETURNING id, name, description, color, sort_order, is_active`);
      const row = r.rows?.[0] || {};
      console.log(`[DOCS-EMPRESA] categoria criada: ${name}`);
      res.json({ message: "Categoria cadastrada", categoria: { id: row.id, name: row.name, description: row.description || "", color: row.color, sortOrder: Number(row.sort_order || 0), isActive: row.is_active !== false, totalDocumentos: 0 } });
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] criar categoria:", e?.message || e);
      res.status(500).json({ message: "Falha ao cadastrar categoria" });
    }
  });

  app.patch("/api/industria/documentos/categorias/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureCompanyDocumentsSchema();
      const { id } = req.params;
      const sets: any[] = [];
      if (req.body?.name !== undefined) {
        const name = String(req.body.name ?? "").trim().slice(0, 120);
        if (!name) return res.status(400).json({ message: "Informe o nome da categoria" });
        const dup: any = await db.execute(sql`
          SELECT id FROM company_document_categories WHERE lower(name) = ${name.toLowerCase()} AND id <> ${id}`);
        if (dup.rows?.length) return res.status(400).json({ message: "Já existe uma categoria com esse nome" });
        sets.push(sql`name = ${name}`);
      }
      if (req.body?.description !== undefined) sets.push(sql`description = ${String(req.body.description ?? "").slice(0, 300) || null}`);
      if (req.body?.color !== undefined) {
        const color = CORES_CATEGORIA.includes(String(req.body.color || "")) ? String(req.body.color) : "slate";
        sets.push(sql`color = ${color}`);
      }
      if (req.body?.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))) sets.push(sql`sort_order = ${Number(req.body.sortOrder)}`);
      if (req.body?.isActive !== undefined) sets.push(sql`is_active = ${!!req.body.isActive}`);
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_at = now()`);
      const r: any = await db.execute(sql`
        UPDATE company_document_categories SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id}
        RETURNING id, name, description, color, sort_order, is_active`);
      if (!r.rows?.length) return res.status(404).json({ message: "Categoria não encontrada" });
      const row = r.rows[0];
      res.json({ message: "Categoria atualizada", categoria: { id: row.id, name: row.name, description: row.description || "", color: row.color, sortOrder: Number(row.sort_order || 0), isActive: row.is_active !== false } });
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] editar categoria:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar categoria" });
    }
  });

  // Excluir só se não houver documento usando a categoria (o documento nunca
  // pode ficar órfão — categoria é obrigatória).
  app.delete("/api/industria/documentos/categorias/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureCompanyDocumentsSchema();
      const { id } = req.params;
      const uso: any = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM company_documents WHERE category_id = ${id}`);
      const n = Number(uso.rows?.[0]?.n || 0);
      if (n > 0) return res.status(400).json({ message: `Categoria em uso por ${n} documento(s). Mova-os para outra categoria antes de excluir.` });
      await db.execute(sql`DELETE FROM company_document_categories WHERE id = ${id}`);
      res.json({ message: "Categoria removida" });
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] remover categoria:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover categoria" });
    }
  });

  // Lista (metadados; nunca o binário). Filtros opcionais: ?instancia=GYN&status=vigente
  app.get("/api/industria/documentos", async (req: any, res) => {
    try {
      await ensureCompanyDocumentsSchema();
      const inst = String(req.query?.instancia || "").trim().toUpperCase();
      const status = String(req.query?.status || "").trim();
      const categoria = String(req.query?.categoria || "").trim();
      const conds: any[] = [sql`true`];
      if (inst) conds.push(sql`d.instance_name = ${inst}`);
      if (status && STATUS_VALIDOS.includes(status)) conds.push(sql`d.status = ${status}`);
      if (categoria) conds.push(sql`d.category_id = ${categoria}`);
      const r: any = await db.execute(sql`
        SELECT d.id, d.name, d.instance_name, d.valid_from, d.valid_until, d.status, d.notes,
               d.file_name, d.mimetype, d.file_size, d.created_at, d.updated_at,
               d.category_id, c.name AS category_name, c.color AS category_color
        FROM company_documents d
        LEFT JOIN company_document_categories c ON c.id = d.category_id
        WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, d.valid_until NULLS LAST, d.name`);
      const docs = (r.rows || []).map(mapRow);
      const resumo = {
        total: docs.length,
        vigentes: docs.filter((d: any) => d.status === "vigente" && d.situacao !== "vencido").length,
        aVencer: docs.filter((d: any) => d.situacao === "a_vencer").length,
        vencidos: docs.filter((d: any) => d.situacao === "vencido" || d.status === "vencido").length,
        semArquivo: docs.filter((d: any) => !d.hasFile).length,
        semCategoria: docs.filter((d: any) => !d.categoryId).length,
      };
      res.json({ documentos: docs, resumo, diasAlerta: DIAS_ALERTA });
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar documentos" });
    }
  });

  // Criar (multipart: campos + arquivo opcional).
  app.post("/api/industria/documentos", multerSingle, async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureCompanyDocumentsSchema();
      const v = validarCampos(req.body || {});
      if (v.erro) return res.status(400).json({ message: v.erro });
      const c = v.campos;
      const catOk: any = await db.execute(sql`SELECT id FROM company_document_categories WHERE id = ${c.categoryId}`);
      if (!catOk.rows?.length) return res.status(400).json({ message: "Categoria inválida" });
      const file = req.file as Express.Multer.File | undefined;
      const fileName = file ? (file.originalname || "documento").slice(0, 200) : null;
      const mimetype = file ? (file.mimetype || "application/octet-stream") : null;
      const fileSize = file ? file.size : 0;
      const b64 = file ? file.buffer.toString("base64") : null;

      const r: any = await db.execute(sql`
        INSERT INTO company_documents
          (name, instance_name, category_id, valid_from, valid_until, status, notes,
           file_name, mimetype, file_size, data, created_by, updated_by, updated_at)
        VALUES
          (${c.name}, ${c.instanceName}, ${c.categoryId}, ${c.validFrom ?? null}, ${c.validUntil ?? null},
           ${c.status}, ${c.notes ?? null},
           ${fileName}, ${mimetype}, ${fileSize}, ${b64},
           ${req.currentUser?.id || null}, ${req.currentUser?.id || null}, now())
        RETURNING id, name, instance_name, category_id, valid_from, valid_until, status, notes,
                  file_name, mimetype, file_size, created_at, updated_at`);
      const doc = mapRow(r.rows?.[0] || {});
      console.log(`[DOCS-EMPRESA] criado: ${doc.name} (${doc.instanceName})${fileName ? ` + ${fileName} ${fileSize}B` : ""}`);
      res.json({ message: "Documento cadastrado", documento: doc });
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] criar:", e?.message || e);
      res.status(500).json({ message: "Falha ao cadastrar documento" });
    }
  });

  // Editar (multipart: campos parciais + arquivo opcional que SUBSTITUI o atual;
  // removerArquivo=1 apaga o anexo sem enviar outro).
  app.patch("/api/industria/documentos/:id", multerSingle, async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureCompanyDocumentsSchema();
      const { id } = req.params;
      const atual: any = await db.execute(sql`SELECT id FROM company_documents WHERE id = ${id}`);
      if (!atual.rows?.length) return res.status(404).json({ message: "Documento não encontrado" });

      const v = validarCampos(req.body || {}, true);
      if (v.erro) return res.status(400).json({ message: v.erro });
      const c = v.campos;
      if (c.categoryId !== undefined) {
        const catOk: any = await db.execute(sql`SELECT id FROM company_document_categories WHERE id = ${c.categoryId}`);
        if (!catOk.rows?.length) return res.status(400).json({ message: "Categoria inválida" });
      }

      const sets: any[] = [];
      if (c.name !== undefined) sets.push(sql`name = ${c.name}`);
      if (c.instanceName !== undefined) sets.push(sql`instance_name = ${c.instanceName}`);
      if (c.status !== undefined) sets.push(sql`status = ${c.status}`);
      if (c.categoryId !== undefined) sets.push(sql`category_id = ${c.categoryId}`);
      if (c.validFrom !== undefined) sets.push(sql`valid_from = ${c.validFrom}`);
      if (c.validUntil !== undefined) sets.push(sql`valid_until = ${c.validUntil}`);
      if (c.notes !== undefined) sets.push(sql`notes = ${c.notes}`);

      const file = req.file as Express.Multer.File | undefined;
      if (file) {
        sets.push(sql`file_name = ${(file.originalname || "documento").slice(0, 200)}`);
        sets.push(sql`mimetype = ${file.mimetype || "application/octet-stream"}`);
        sets.push(sql`file_size = ${file.size}`);
        sets.push(sql`data = ${file.buffer.toString("base64")}`);
      } else if (String(req.body?.removerArquivo || "") === "1") {
        sets.push(sql`file_name = NULL`, sql`mimetype = NULL`, sql`file_size = 0`, sql`data = NULL`);
      }
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_by = ${req.currentUser?.id || null}`, sql`updated_at = now()`);

      const r: any = await db.execute(sql`
        UPDATE company_documents SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id}
        RETURNING id, name, instance_name, category_id, valid_from, valid_until, status, notes,
                  file_name, mimetype, file_size, created_at, updated_at`);
      res.json({ message: "Documento atualizado", documento: mapRow(r.rows?.[0] || {}) });
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] editar:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar documento" });
    }
  });

  // Abrir/baixar o arquivo. Inline por padrão; ?download=1 baixa.
  app.get("/api/industria/documentos/:id/arquivo", async (req: any, res) => {
    try {
      await ensureCompanyDocumentsSchema();
      const r: any = await db.execute(sql`
        SELECT file_name, mimetype, data FROM company_documents WHERE id = ${req.params.id}`);
      const row = r.rows?.[0];
      if (!row || !row.data) return res.status(404).json({ message: "Arquivo não encontrado" });
      const buf = Buffer.from(String(row.data), "base64");
      const disp = req.query?.download ? "attachment" : "inline";
      const nome = String(row.file_name || "documento").replace(/["\\]/g, "");
      res.setHeader("Content-Type", String(row.mimetype || "application/octet-stream"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${disp}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(buf);
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] arquivo:", e?.message || e);
      res.status(500).json({ message: "Falha ao ler o arquivo" });
    }
  });

  app.delete("/api/industria/documentos/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureCompanyDocumentsSchema();
      await db.execute(sql`DELETE FROM company_documents WHERE id = ${req.params.id}`);
      res.json({ message: "Documento removido" });
    } catch (e: any) {
      console.error("[DOCS-EMPRESA] remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover documento" });
    }
  });
}
