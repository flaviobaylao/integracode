// FICHA TÉCNICA DO PRODUTO (PDF) — 29/ago/2026
// ---------------------------------------------------------------------------
// Cada produto do catálogo pode ter UM PDF de ficha técnica anexado.
//
// Por que uma tabela separada (product_datasheets) e não uma coluna em products,
// como foi feito com as imagens (base64 dentro do próprio registro): a listagem
// /api/products devolve o catálogo inteiro para a tela e para várias rotinas.
// Um PDF de 300KB por produto viajaria em toda leitura do catálogo. Aqui o
// binário fica isolado, e o catálogo carrega só o metadado (nome, tamanho, data).
//
// O texto do PDF é extraído no upload e guardado em extracted_text. É esse campo
// que os agentes de IA leem — ver a ferramenta consultar_ficha_tecnica em
// agent-runtime.ts. Extração é best-effort: PDF que é imagem escaneada não tem
// texto e o anexo continua valendo (download e envio ao cliente seguem funcionando),
// só não alimenta a IA. A tela avisa quando isso acontece.
import type { Express } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_TEXT_CHARS = 60000; // o que sobra vira ruído no prompt da IA

const uploadFicha = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname || "");
    if (!ok) return cb(new Error("Somente arquivos PDF são aceitos"));
    cb(null, true);
  },
});

let schemaReady: Promise<void> | null = null;
export function ensureDatasheetSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS product_datasheets (" +
        "product_id varchar PRIMARY KEY, " +
        "file_name text NOT NULL, " +
        "mimetype text NOT NULL DEFAULT 'application/pdf', " +
        "file_size integer NOT NULL DEFAULT 0, " +
        "data text NOT NULL, " +
        "extracted_text text, " +
        "extract_status varchar NOT NULL DEFAULT 'pending', " +
        "uploaded_by varchar, " +
        "created_at timestamptz DEFAULT now(), " +
        "updated_at timestamptz DEFAULT now())"
      ));
      // Busca textual da ficha (usada pela IA quando o cliente pergunta por um
      // atributo — "sem açúcar", "vegano" — sem citar o produto pelo nome).
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_product_datasheets_text ON product_datasheets USING gin (to_tsvector('portuguese', coalesce(extracted_text,'')))"
      )).catch(() => {});
    })().catch((e: any) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// Extração best-effort. pdf-parse é CJS; o bundle do servidor é ESM com
// --packages=external, então o import dinâmico resolve em runtime pelo
// node_modules. Se a lib faltar ou o PDF não tiver camada de texto, devolve
// vazio em vez de derrubar o upload.
async function extractPdfText(buffer: Buffer): Promise<{ text: string; status: string }> {
  try {
    // @ts-ignore — pdf-parse não publica tipos; o import é resolvido em runtime.
    const mod: any = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = mod?.default || mod;
    const parsed = await pdfParse(buffer);
    const text = String(parsed?.text || "")
      // O Postgres recusa NUL (0x00) em coluna text — e PDF de designer vem cheio
      // deles junto com outros caracteres de controle. Sem esta limpeza o INSERT
      // morre com "invalid byte sequence for encoding UTF8" e o upload inteiro
      // falha, mesmo com o PDF perfeito. Pego no harness com um PDF real.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return { text: "", status: "sem_texto" };
    return { text: text.slice(0, MAX_TEXT_CHARS), status: "ok" };
  } catch (e: any) {
    console.warn("[FICHA-TECNICA] falha ao extrair texto:", e?.message || e);
    return { text: "", status: "falha" };
  }
}

function podeEditar(user: any): boolean {
  return ["admin", "coordinator"].includes(user?.role || "");
}

export function registerProductDatasheetRoutes(app: Express) {
  ensureDatasheetSchema().catch((e: any) =>
    console.error("[FICHA-TECNICA] schema:", e?.message || e)
  );

  // Metadados de TODAS as fichas — a tela do catálogo pede uma vez e sabe quais
  // produtos já têm anexo. Nunca devolve o binário.
  app.get("/api/products/datasheets", authenticateUser, async (_req: any, res) => {
    try {
      await ensureDatasheetSchema();
      const r: any = await db.execute(sql`
        SELECT product_id, file_name, file_size, extract_status,
               length(coalesce(extracted_text,'')) AS text_length, updated_at
        FROM product_datasheets`);
      const out: Record<string, any> = {};
      for (const row of r.rows || []) {
        out[String(row.product_id)] = {
          fileName: row.file_name,
          fileSize: Number(row.file_size || 0),
          extractStatus: row.extract_status,
          textLength: Number(row.text_length || 0),
          updatedAt: row.updated_at,
        };
      }
      res.json(out);
    } catch (e: any) {
      console.error("[FICHA-TECNICA] listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar fichas técnicas" });
    }
  });

  // Anexar/substituir a ficha técnica de um produto.
  app.post(
    "/api/products/:id/ficha-tecnica",
    authenticateUser,
    (req: any, res, next) =>
      uploadFicha.single("ficha")(req, res, (err: any) => {
        if (err) {
          const msg = err?.code === "LIMIT_FILE_SIZE"
            ? "PDF acima de 15MB"
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
        const file = req.file as Express.Multer.File | undefined;
        if (!file) return res.status(400).json({ message: "Nenhum PDF enviado" });

        const prod: any = await db.execute(
          sql`SELECT id, name FROM products WHERE id = ${id}`
        );
        if (!prod.rows?.length) {
          return res.status(404).json({ message: "Produto não encontrado" });
        }

        await ensureDatasheetSchema();
        const { text, status } = await extractPdfText(file.buffer);
        const b64 = file.buffer.toString("base64");
        const nome = (file.originalname || "ficha-tecnica.pdf").slice(0, 200);

        await db.execute(sql`
          INSERT INTO product_datasheets
            (product_id, file_name, mimetype, file_size, data, extracted_text, extract_status, uploaded_by, updated_at)
          VALUES
            (${id}, ${nome}, ${file.mimetype || "application/pdf"}, ${file.size}, ${b64}, ${text}, ${status}, ${req.currentUser?.id || null}, now())
          ON CONFLICT (product_id) DO UPDATE SET
            file_name = EXCLUDED.file_name,
            mimetype = EXCLUDED.mimetype,
            file_size = EXCLUDED.file_size,
            data = EXCLUDED.data,
            extracted_text = EXCLUDED.extracted_text,
            extract_status = EXCLUDED.extract_status,
            uploaded_by = EXCLUDED.uploaded_by,
            updated_at = now()`);

        console.log(
          `[FICHA-TECNICA] ${prod.rows[0].name}: ${nome} (${file.size}B), texto=${status} ${text.length} chars`
        );
        res.json({
          message: "Ficha técnica anexada",
          fileName: nome,
          fileSize: file.size,
          extractStatus: status,
          textLength: text.length,
        });
      } catch (e: any) {
        console.error("[FICHA-TECNICA] upload:", e?.message || e);
        res.status(500).json({ message: "Falha ao anexar ficha técnica" });
      }
    }
  );

  // Download/visualização. Serve inline para abrir no navegador; ?download=1 baixa.
  const servirPdf = async (req: any, res: any) => {
    try {
      await ensureDatasheetSchema();
      const { id } = req.params;
      const r: any = await db.execute(sql`
        SELECT file_name, mimetype, data FROM product_datasheets WHERE product_id = ${id}`);
      const row = r.rows?.[0];
      if (!row) return res.status(404).json({ message: "Este produto não tem ficha técnica" });
      const buf = Buffer.from(String(row.data), "base64");
      const disp = req.query?.download ? "attachment" : "inline";
      const nome = String(row.file_name || "ficha-tecnica.pdf").replace(/["\\]/g, "");
      res.setHeader("Content-Type", String(row.mimetype || "application/pdf"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${disp}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(buf);
    } catch (e: any) {
      console.error("[FICHA-TECNICA] download:", e?.message || e);
      res.status(500).json({ message: "Falha ao ler ficha técnica" });
    }
  };

  app.get("/api/products/:id/ficha-tecnica", authenticateUser, servirPdf);
  // Rota pública: é o link que os agentes de IA mandam para o cliente no
  // WhatsApp. Ficha técnica é material de divulgação — não expõe preço,
  // cliente nem nada interno, só o PDF que a equipe anexou.
  app.get("/api/public/products/:id/ficha-tecnica", servirPdf);

  app.delete("/api/products/:id/ficha-tecnica", authenticateUser, async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) {
        return res.status(403).json({ message: "Access denied" });
      }
      await ensureDatasheetSchema();
      await db.execute(sql`DELETE FROM product_datasheets WHERE product_id = ${req.params.id}`);
      res.json({ message: "Ficha técnica removida" });
    } catch (e: any) {
      console.error("[FICHA-TECNICA] remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover ficha técnica" });
    }
  });
}
