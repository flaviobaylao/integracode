// ============================================================================
// PASTA DE ARQUIVOS DO VENDEDOR — 16/out/2026
// ---------------------------------------------------------------------------
// Um repositório de arquivos por vendedor, dentro do cadastro de Vendedores
// (/sellers). Funciona como a "pasta daquele vendedor": contrato de prestação
// de serviço, documentos pessoais, cartão CNPJ e inscrições (no caso dos PJ),
// dados bancários, termos de comodato de equipamento, certificados de
// treinamento, planilhas de comissão, fotos — qualquer arquivo que se refira
// àquele vendedor.
//
// Desenho igual ao dos anexos de funcionário da indústria e aos documentos da
// empresa: multer em memória -> binário em base64 numa coluna própria do
// Postgres. O disco do container do Railway é efêmero, por isso NÃO se grava
// em pasta de arquivos. A listagem NUNCA devolve a coluna `data`; o conteúdo
// só sai pela rota de download.
//
// A tabela é criada por CREATE TABLE IF NOT EXISTS no primeiro uso porque o
// build de produção não roda `db:push` (mesma razão de company_documents,
// industry_employee_attachments e raw_material_attachments não estarem no
// shared/schema.ts).
//
// ACESSO: diferente de /api/industria, o prefixo /api/users não tem guarda
// global no index.ts — por isso cada rota declara os middlewares. Arquivo de
// vendedor é material de RH/contrato, então fica restrito a admin,
// coordinator e administrative (os mesmos perfis que já editam o cadastro do
// vendedor na tela). O próprio vendedor NÃO enxerga a pasta.
// ============================================================================
import type { Express } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const MAX_ARQUIVO_BYTES = 15 * 1024 * 1024; // 15MB (igual aos documentos da empresa)

// Pastas dentro da pasta do vendedor. Rótulos ficam no front.
export const CATEGORIAS_ARQUIVO_VENDEDOR = [
  "contrato",            // contrato de prestação de serviço, aditivos, distrato
  "documentos_pessoais", // RG, CPF, CNH, comprovante de residência
  "empresa_pj",          // cartão CNPJ, inscrição estadual/municipal, contrato social
  "dados_bancarios",     // dados de conta, chave PIX, comprovantes
  "comissoes",           // planilhas e demonstrativos de comissão
  "treinamentos",        // certificados, materiais de treinamento
  "equipamentos",        // termos de comodato: celular, chip, expositor, veículo
  "outros",
];

const PERFIS_COM_ACESSO = ["admin", "coordinator", "administrative"];
const guard = [authenticateUser, requireRole(PERFIS_COM_ACESSO)];

const uploadArquivo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARQUIVO_BYTES },
});

// Converte o erro do multer em 400 com mensagem legível (um erro solto vira 500).
function multerArquivo(req: any, res: any, next: any) {
  uploadArquivo.single("arquivo")(req, res, (err: any) => {
    if (err) {
      const msg = err?.code === "LIMIT_FILE_SIZE"
        ? "Arquivo acima de 15MB"
        : (err?.message || "Falha no upload do arquivo");
      return res.status(400).json({ message: msg });
    }
    next();
  });
}

let schemaReady: Promise<void> | null = null;
export function ensureSellerDocumentsSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS seller_documents (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "seller_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
        "category varchar NOT NULL DEFAULT 'outros', " +
        "description text, " +
        "reference_date date, " +
        "file_name text NOT NULL, " +
        "mimetype text, " +
        "file_size integer NOT NULL DEFAULT 0, " +
        "data text NOT NULL, " +
        "created_by varchar, " +
        "created_at timestamptz DEFAULT now())"
      ));
      for (const ix of [
        "CREATE INDEX IF NOT EXISTS idx_seller_docs_seller ON seller_documents (seller_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_seller_docs_category ON seller_documents (seller_id, category)",
      ]) {
        await db.execute(sql.raw(ix)).catch(() => {});
      }
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

function dataOuNull(v: any): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toISODate(v: any): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapArquivo(row: any) {
  return {
    id: row.id,
    sellerId: row.seller_id,
    category: row.category || "outros",
    description: row.description || "",
    referenceDate: toISODate(row.reference_date),
    fileName: row.file_name,
    mimetype: row.mimetype || null,
    fileSize: Number(row.file_size || 0),
    createdAt: row.created_at,
    createdByName: row.created_by_name || "",
    url: `/api/users/${row.seller_id}/arquivos/${row.id}/download`,
  };
}

export function registerSellerDocumentsRoutes(app: Express) {
  // -------------------------------------------------------------------------
  // Contagem por vendedor — alimenta o badge "N arquivos" no card da listagem
  // sem precisar de uma requisição por vendedor.
  // Precisa vir ANTES de /api/users/:id/arquivos? Não: caminhos têm números de
  // segmentos diferentes, o Express não confunde. Mantido junto por clareza.
  // -------------------------------------------------------------------------
  app.get("/api/users/arquivos/resumo", ...guard, async (_req: any, res) => {
    try {
      await ensureSellerDocumentsSchema();
      const r: any = await db.execute(sql`
        SELECT seller_id, COUNT(1)::int AS total, MAX(created_at) AS ultimo
        FROM seller_documents GROUP BY seller_id`);
      const porVendedor: Record<string, { total: number; ultimo: any }> = {};
      for (const row of r.rows || []) {
        porVendedor[String(row.seller_id)] = {
          total: Number(row.total || 0),
          ultimo: row.ultimo,
        };
      }
      res.json({ porVendedor });
    } catch (e: any) {
      console.error("[ARQ-VENDEDOR] resumo:", e?.message || e);
      res.status(500).json({ message: "Falha ao carregar o resumo de arquivos" });
    }
  });

  // -------------------------------------------------------------------------
  // Listar a pasta de um vendedor. Nunca devolve a coluna `data`.
  // -------------------------------------------------------------------------
  app.get("/api/users/:id/arquivos", ...guard, async (req: any, res) => {
    try {
      await ensureSellerDocumentsSchema();
      const categoria = String(req.query?.categoria || "").trim();
      const busca = String(req.query?.busca || "").trim();
      const conds: any[] = [sql`d.seller_id = ${req.params.id}`];
      if (categoria && CATEGORIAS_ARQUIVO_VENDEDOR.includes(categoria)) {
        conds.push(sql`d.category = ${categoria}`);
      }
      if (busca) {
        const like = `%${busca}%`;
        conds.push(sql`(d.file_name ILIKE ${like} OR d.description ILIKE ${like})`);
      }
      const r: any = await db.execute(sql`
        SELECT d.id, d.seller_id, d.category, d.description, d.reference_date,
               d.file_name, d.mimetype, d.file_size, d.created_at,
               NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS created_by_name
        FROM seller_documents d
        LEFT JOIN users u ON u.id = d.created_by
        WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY d.created_at DESC`);
      res.json({
        arquivos: (r.rows || []).map(mapArquivo),
        categorias: CATEGORIAS_ARQUIVO_VENDEDOR,
      });
    } catch (e: any) {
      console.error("[ARQ-VENDEDOR] listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar os arquivos do vendedor" });
    }
  });

  // -------------------------------------------------------------------------
  // Enviar um arquivo para a pasta do vendedor.
  // -------------------------------------------------------------------------
  app.post("/api/users/:id/arquivos", ...guard, multerArquivo, async (req: any, res) => {
    try {
      await ensureSellerDocumentsSchema();
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Selecione um arquivo" });

      const ex: any = await db.execute(sql`SELECT id FROM users WHERE id = ${req.params.id}`);
      if (!ex.rows?.length) return res.status(404).json({ message: "Vendedor não encontrado" });

      const b = req.body || {};
      const category = CATEGORIAS_ARQUIVO_VENDEDOR.includes(String(b.category || ""))
        ? String(b.category)
        : "outros";
      const description = String(b.description ?? "").trim().slice(0, 300) || null;
      const referenceDate = dataOuNull(b.referenceDate);

      const r: any = await db.execute(sql`
        INSERT INTO seller_documents
          (seller_id, category, description, reference_date, file_name, mimetype, file_size, data, created_by)
        VALUES (${req.params.id}, ${category}, ${description}, ${referenceDate},
                ${(file.originalname || "arquivo").slice(0, 200)},
                ${file.mimetype || "application/octet-stream"},
                ${file.size}, ${file.buffer.toString("base64")}, ${req.currentUser?.id || null})
        RETURNING id, seller_id, category, description, reference_date, file_name, mimetype, file_size, created_at`);

      const arquivo = mapArquivo(r.rows?.[0] || {});
      console.log(`[ARQ-VENDEDOR] ${req.params.id}: ${arquivo.fileName} (${category}, ${arquivo.fileSize}B)`);
      res.json({ message: "Arquivo enviado", arquivo });
    } catch (e: any) {
      console.error("[ARQ-VENDEDOR] enviar:", e?.message || e);
      res.status(500).json({ message: "Falha ao enviar o arquivo" });
    }
  });

  // -------------------------------------------------------------------------
  // Renomear / reclassificar sem reenviar o binário.
  // -------------------------------------------------------------------------
  app.patch("/api/users/:id/arquivos/:docId", ...guard, async (req: any, res) => {
    try {
      await ensureSellerDocumentsSchema();
      const b = req.body || {};
      const sets: any[] = [];
      if (typeof b.category === "string" && CATEGORIAS_ARQUIVO_VENDEDOR.includes(b.category)) {
        sets.push(sql`category = ${b.category}`);
      }
      if (typeof b.description === "string") {
        sets.push(sql`description = ${b.description.trim().slice(0, 300) || null}`);
      }
      if (typeof b.referenceDate === "string") {
        sets.push(sql`reference_date = ${dataOuNull(b.referenceDate)}`);
      }
      if (typeof b.fileName === "string" && b.fileName.trim()) {
        sets.push(sql`file_name = ${b.fileName.trim().slice(0, 200)}`);
      }
      if (!sets.length) return res.status(400).json({ message: "Nada a alterar" });

      const r: any = await db.execute(sql`
        UPDATE seller_documents SET ${sql.join(sets, sql`, `)}
        WHERE id = ${req.params.docId} AND seller_id = ${req.params.id}
        RETURNING id, seller_id, category, description, reference_date, file_name, mimetype, file_size, created_at`);
      if (!r.rows?.length) return res.status(404).json({ message: "Arquivo não encontrado" });
      res.json({ message: "Arquivo atualizado", arquivo: mapArquivo(r.rows[0]) });
    } catch (e: any) {
      console.error("[ARQ-VENDEDOR] atualizar:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar o arquivo" });
    }
  });

  // -------------------------------------------------------------------------
  // Abrir/baixar. Inline por padrão (PDF e imagem abrem no navegador);
  // ?download=1 força o download.
  // -------------------------------------------------------------------------
  app.get("/api/users/:id/arquivos/:docId/download", ...guard, async (req: any, res) => {
    try {
      await ensureSellerDocumentsSchema();
      const r: any = await db.execute(sql`
        SELECT file_name, mimetype, data FROM seller_documents
        WHERE id = ${req.params.docId} AND seller_id = ${req.params.id}`);
      const row = r.rows?.[0];
      if (!row || !row.data) return res.status(404).json({ message: "Arquivo não encontrado" });
      const buf = Buffer.from(String(row.data), "base64");
      const disp = req.query?.download ? "attachment" : "inline";
      const nome = String(row.file_name || "arquivo").replace(/["\\]/g, "");
      res.setHeader("Content-Type", String(row.mimetype || "application/octet-stream"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${disp}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(buf);
    } catch (e: any) {
      console.error("[ARQ-VENDEDOR] download:", e?.message || e);
      res.status(500).json({ message: "Falha ao ler o arquivo" });
    }
  });

  // -------------------------------------------------------------------------
  // Excluir. Só admin apaga — coordenação e administrativo enviam e consultam.
  // -------------------------------------------------------------------------
  app.delete("/api/users/:id/arquivos/:docId", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      await ensureSellerDocumentsSchema();
      const r: any = await db.execute(sql`
        DELETE FROM seller_documents
        WHERE id = ${req.params.docId} AND seller_id = ${req.params.id}
        RETURNING file_name`);
      if (!r.rows?.length) return res.status(404).json({ message: "Arquivo não encontrado" });
      console.log(`[ARQ-VENDEDOR] excluído ${req.params.docId} de ${req.params.id}`);
      res.json({ message: "Arquivo excluído" });
    } catch (e: any) {
      console.error("[ARQ-VENDEDOR] excluir:", e?.message || e);
      res.status(500).json({ message: "Falha ao excluir o arquivo" });
    }
  });
}
