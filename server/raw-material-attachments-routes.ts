// ANEXOS DE ESPECIFICAÇÃO TÉCNICA DA MATÉRIA-PRIMA — 01/set/2026
// ---------------------------------------------------------------------------
// Cada matéria-prima (raw_materials) pode ter VÁRIOS arquivos anexados:
// laudos, fichas de especificação do fornecedor, certificados, fotos do rótulo,
// planilhas de análise. Aceita qualquer tipo de arquivo (PDF, imagem, Word,
// Excel, texto), até 15MB por arquivo.
//
// O prefixo /api/industria já é protegido no index.ts
// (app.use('/api/industria', authenticateUser, requireRole(['admin']))), por isso
// as rotas aqui não repetem o middleware — igual às demais de industria-routes.
//
// Mesmo desenho da ficha técnica do produto (product-datasheet-routes.ts):
// tabela separada com o binário em base64, para que a listagem de materiais
// (/api/industria/raw-materials, lida a cada abertura da aba) continue leve —
// os endpoints de lista aqui NUNCA devolvem a coluna data.
//
// De PDF e texto o conteúdo é extraído no upload (extracted_text), best-effort:
// PDF escaneado não tem camada de texto e o anexo continua valendo, só não
// alimenta busca/IA. A tela avisa quando isso acontece.
import type { Express } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_TEXT_CHARS = 60000;
const MAX_ANEXOS_POR_MATERIAL = 20;

const uploadAnexo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

let schemaReady: Promise<void> | null = null;
export function ensureRawMaterialAttachmentSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS raw_material_attachments (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "raw_material_id varchar NOT NULL, " +
        "file_name text NOT NULL, " +
        "mimetype text NOT NULL DEFAULT 'application/octet-stream', " +
        "file_size integer NOT NULL DEFAULT 0, " +
        "data text NOT NULL, " +
        "description text, " +
        "extracted_text text, " +
        "extract_status varchar NOT NULL DEFAULT 'pending', " +
        "uploaded_by varchar, " +
        "created_at timestamptz DEFAULT now(), " +
        "updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_rma_material ON raw_material_attachments (raw_material_id)"
      )).catch(() => {});
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_rma_text ON raw_material_attachments USING gin (to_tsvector('portuguese', coalesce(extracted_text,'')))"
      )).catch(() => {});
    })().catch((e: any) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// Limpeza obrigatória: o Postgres recusa NUL (0x00) em coluna text e PDF de
// designer vem cheio deles — sem isso o INSERT derruba o upload inteiro.
function limparTexto(raw: string): string {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extrairTexto(
  buffer: Buffer,
  mimetype: string,
  fileName: string
): Promise<{ text: string; status: string }> {
  const ehPdf = mimetype === "application/pdf" || /\.pdf$/i.test(fileName);
  const ehTexto = /^text\//.test(mimetype) || /\.(txt|csv|md)$/i.test(fileName);
  try {
    if (ehPdf) {
      // pdf-parse é CJS; o bundle do servidor é ESM com --packages=external,
      // então o import dinâmico resolve em runtime pelo node_modules.
      // @ts-ignore — pdf-parse não publica tipos.
      const mod: any = await import("pdf-parse/lib/pdf-parse.js");
      const pdfParse = mod?.default || mod;
      const parsed = await pdfParse(buffer);
      const text = limparTexto(parsed?.text || "");
      if (!text) return { text: "", status: "sem_texto" };
      return { text: text.slice(0, MAX_TEXT_CHARS), status: "ok" };
    }
    if (ehTexto) {
      const text = limparTexto(buffer.toString("utf8"));
      if (!text) return { text: "", status: "sem_texto" };
      return { text: text.slice(0, MAX_TEXT_CHARS), status: "ok" };
    }
    // Imagem, Word, Excel: anexo vale igual, só não vira texto.
    return { text: "", status: "nao_aplicavel" };
  } catch (e: any) {
    console.warn("[MP-ANEXOS] falha ao extrair texto:", e?.message || e);
    return { text: "", status: "falha" };
  }
}

function podeEditar(user: any): boolean {
  return ["admin", "coordinator"].includes(user?.role || "");
}

export function registerRawMaterialAttachmentRoutes(app: Express) {
  ensureRawMaterialAttachmentSchema().catch((e: any) =>
    console.error("[MP-ANEXOS] schema:", e?.message || e)
  );

  // Contagem por material — a aba Matéria-Prima pede uma vez e sabe quais
  // materiais já têm especificação anexada (badge na tabela).
  app.get("/api/industria/raw-materials/attachments/summary", async (_req: any, res) => {
    try {
      await ensureRawMaterialAttachmentSchema();
      const r: any = await db.execute(sql`
        SELECT raw_material_id, count(*)::int AS total, max(updated_at) AS updated_at
        FROM raw_material_attachments GROUP BY raw_material_id`);
      const out: Record<string, any> = {};
      for (const row of r.rows || []) {
        out[String(row.raw_material_id)] = {
          total: Number(row.total || 0),
          updatedAt: row.updated_at,
        };
      }
      res.json(out);
    } catch (e: any) {
      console.error("[MP-ANEXOS] resumo:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar anexos" });
    }
  });

  // Lista os anexos de um material (metadados; nunca o binário).
  app.get("/api/industria/raw-materials/:id/attachments", async (req: any, res) => {
    try {
      await ensureRawMaterialAttachmentSchema();
      const r: any = await db.execute(sql`
        SELECT id, file_name, mimetype, file_size, description, extract_status,
               length(coalesce(extracted_text,'')) AS text_length, created_at, updated_at
        FROM raw_material_attachments
        WHERE raw_material_id = ${req.params.id}
        ORDER BY created_at`);
      res.json((r.rows || []).map((row: any) => ({
        id: row.id,
        fileName: row.file_name,
        mimetype: row.mimetype,
        fileSize: Number(row.file_size || 0),
        description: row.description || "",
        extractStatus: row.extract_status,
        textLength: Number(row.text_length || 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })));
    } catch (e: any) {
      console.error("[MP-ANEXOS] listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar anexos" });
    }
  });

  // Anexar um ou vários arquivos ao material.
  app.post(
    "/api/industria/raw-materials/:id/attachments",
    (req: any, res, next) =>
      uploadAnexo.array("arquivos", 10)(req, res, (err: any) => {
        if (err) {
          const msg = err?.code === "LIMIT_FILE_SIZE"
            ? "Arquivo acima de 15MB"
            : (err?.message || "Falha no upload");
          return res.status(400).json({ message: msg });
        }
        next();
      }),
    async (req: any, res) => {
      try {
        if (!podeEditar(req.currentUser)) {
          return res.status(403).json({ message: "Access denied" });
        }
        const { id } = req.params;
        const files = (req.files || []) as Express.Multer.File[];
        if (!files.length) return res.status(400).json({ message: "Nenhum arquivo enviado" });

        const mat: any = await db.execute(
          sql`SELECT id, name FROM raw_materials WHERE id = ${id}`
        );
        if (!mat.rows?.length) {
          return res.status(404).json({ message: "Matéria-prima não encontrada" });
        }

        await ensureRawMaterialAttachmentSchema();
        const atual: any = await db.execute(sql`
          SELECT count(*)::int AS n FROM raw_material_attachments WHERE raw_material_id = ${id}`);
        const jaTem = Number(atual.rows?.[0]?.n || 0);
        if (jaTem + files.length > MAX_ANEXOS_POR_MATERIAL) {
          return res.status(400).json({
            message: `Limite de ${MAX_ANEXOS_POR_MATERIAL} anexos por matéria-prima (já há ${jaTem}).`,
          });
        }

        const descricao = typeof req.body?.description === "string"
          ? req.body.description.slice(0, 500) : null;

        const criados: any[] = [];
        for (const file of files) {
          const nome = (file.originalname || "anexo").slice(0, 200);
          const mimetype = file.mimetype || "application/octet-stream";
          const { text, status } = await extrairTexto(file.buffer, mimetype, nome);
          const b64 = file.buffer.toString("base64");
          const r: any = await db.execute(sql`
            INSERT INTO raw_material_attachments
              (raw_material_id, file_name, mimetype, file_size, data, description,
               extracted_text, extract_status, uploaded_by, updated_at)
            VALUES
              (${id}, ${nome}, ${mimetype}, ${file.size}, ${b64}, ${descricao},
               ${text}, ${status}, ${req.currentUser?.id || null}, now())
            RETURNING id, file_name, mimetype, file_size, description, extract_status, created_at`);
          const row = r.rows?.[0] || {};
          criados.push({
            id: row.id,
            fileName: row.file_name,
            mimetype: row.mimetype,
            fileSize: Number(row.file_size || 0),
            description: row.description || "",
            extractStatus: row.extract_status,
            textLength: text.length,
            createdAt: row.created_at,
          });
          console.log(
            `[MP-ANEXOS] ${mat.rows[0].name}: ${nome} (${file.size}B), texto=${status} ${text.length} chars`
          );
        }

        res.json({ message: criados.length > 1 ? "Anexos enviados" : "Anexo enviado", anexos: criados });
      } catch (e: any) {
        console.error("[MP-ANEXOS] upload:", e?.message || e);
        res.status(500).json({ message: "Falha ao anexar arquivo" });
      }
    }
  );

  // Download/visualização de um anexo. Inline por padrão; ?download=1 baixa.
  app.get("/api/industria/raw-material-attachments/:attId", async (req: any, res) => {
    try {
      await ensureRawMaterialAttachmentSchema();
      const r: any = await db.execute(sql`
        SELECT file_name, mimetype, data FROM raw_material_attachments WHERE id = ${req.params.attId}`);
      const row = r.rows?.[0];
      if (!row) return res.status(404).json({ message: "Anexo não encontrado" });
      const buf = Buffer.from(String(row.data), "base64");
      const disp = req.query?.download ? "attachment" : "inline";
      const nome = String(row.file_name || "anexo").replace(/["\\]/g, "");
      res.setHeader("Content-Type", String(row.mimetype || "application/octet-stream"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${disp}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(buf);
    } catch (e: any) {
      console.error("[MP-ANEXOS] download:", e?.message || e);
      res.status(500).json({ message: "Falha ao ler o anexo" });
    }
  });

  app.delete("/api/industria/raw-material-attachments/:attId", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) {
        return res.status(403).json({ message: "Access denied" });
      }
      await ensureRawMaterialAttachmentSchema();
      await db.execute(sql`DELETE FROM raw_material_attachments WHERE id = ${req.params.attId}`);
      res.json({ message: "Anexo removido" });
    } catch (e: any) {
      console.error("[MP-ANEXOS] remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover o anexo" });
    }
  });
}
