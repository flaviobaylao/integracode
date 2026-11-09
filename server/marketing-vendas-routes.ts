// ============================================================================
// MARKETING DE VENDAS — 09/nov/2026
// ---------------------------------------------------------------------------
// Pasta única de material de venda para toda a equipe (vendedor externo,
// interno/telemarketing, coordenação): tabelas de preços, portfólio, posts
// e cards para mandar ao cliente no WhatsApp. Antes as tabelas circulavam
// soltas em downloads e no Drive de cada um; aqui fica a versão oficial.
//
// Desenho igual ao da pasta do vendedor (seller-documents-routes.ts): multer em
// memória -> base64 numa coluna do Postgres (o disco do Railway é efêmero).
// A listagem nunca devolve a coluna `data`; o conteúdo sai só pela rota do
// arquivo. Tabela criada por CREATE TABLE IF NOT EXISTS no primeiro uso.
//
// ACESSO: qualquer usuário logado vê e baixa. Enviar, editar e tirar do ar:
// admin, coordinator e administrative. Excluir de vez: só admin. "Tirar do ar"
// (ativo=false) esconde da equipe sem apagar — a versão antiga continua
// recuperável pelo gestor.
// ============================================================================
import type { Express } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const MAX_ARQUIVO_BYTES = 15 * 1024 * 1024;

export const CATEGORIAS_MARKETING_VENDAS = [
  "tabelas",    // tabelas de preços (PJ, PF, por região/instância)
  "portfolio",  // portfólio, apresentação da marca
  "posts",      // posts e cards para WhatsApp/Instagram
  "pdv",        // material de ponto de venda, mockups, geladeira
  "outros",
];

const GESTORES = ["admin", "coordinator", "administrative"];
const podeGerir = [authenticateUser, requireRole(GESTORES)];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARQUIVO_BYTES } });
function multerArquivo(req: any, res: any, next: any) {
  upload.single("arquivo")(req, res, (err: any) => {
    if (err) {
      const msg = err?.code === "LIMIT_FILE_SIZE" ? "Arquivo acima de 15MB" : (err?.message || "Falha no upload");
      return res.status(400).json({ message: msg });
    }
    next();
  });
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS marketing_vendas_materiais (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "titulo text NOT NULL, " +
        "categoria varchar NOT NULL DEFAULT 'outros', " +
        "descricao text, " +
        "ordem integer NOT NULL DEFAULT 0, " +
        "ativo boolean NOT NULL DEFAULT true, " +
        "file_name text NOT NULL, " +
        "mimetype text, " +
        "file_size integer NOT NULL DEFAULT 0, " +
        "data text NOT NULL, " +
        "created_by varchar, " +
        "created_at timestamptz DEFAULT now(), " +
        "updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_mkt_vendas_cat ON marketing_vendas_materiais (categoria, ativo, ordem)"
      )).catch(() => {});
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

function mapMaterial(row: any) {
  const v = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  return {
    id: row.id,
    titulo: row.titulo,
    categoria: row.categoria || "outros",
    descricao: row.descricao || "",
    ordem: Number(row.ordem || 0),
    ativo: row.ativo !== false,
    fileName: row.file_name,
    mimetype: row.mimetype || null,
    fileSize: Number(row.file_size || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByName: row.created_by_name || "",
    // ?v= muda quando o arquivo muda: o service worker não serve versão velha.
    url: `/api/marketing-vendas/${row.id}/arquivo?v=${v}`,
  };
}

const COLS = sql`m.id, m.titulo, m.categoria, m.descricao, m.ordem, m.ativo, m.file_name, m.mimetype,
                 m.file_size, m.created_at, m.updated_at`;

export function registerMarketingVendasRoutes(app: Express) {
  // Lista. Equipe vê só os ativos; gestor pode pedir ?todos=1.
  app.get("/api/marketing-vendas", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const role = String(req.currentUser?.role || "");
      const todos = req.query?.todos && GESTORES.includes(role);
      const r: any = await db.execute(sql`
        SELECT ${COLS}, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS created_by_name
        FROM marketing_vendas_materiais m
        LEFT JOIN users u ON u.id = m.created_by
        ${todos ? sql`` : sql`WHERE m.ativo = true`}
        ORDER BY m.categoria, m.ordem, m.titulo`);
      res.json({
        materiais: (r.rows || []).map(mapMaterial),
        categorias: CATEGORIAS_MARKETING_VENDAS,
        podeGerir: GESTORES.includes(role),
      });
    } catch (e: any) {
      console.error("[MKT-VENDAS] listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar o material" });
    }
  });

  // Abrir / baixar (?download=1). Inativo só abre para gestor.
  app.get("/api/marketing-vendas/:id/arquivo", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const r: any = await db.execute(sql`
        SELECT file_name, mimetype, data, ativo FROM marketing_vendas_materiais WHERE id = ${req.params.id}`);
      const row = r.rows?.[0];
      const role = String(req.currentUser?.role || "");
      if (!row || !row.data || (row.ativo === false && !GESTORES.includes(role))) {
        return res.status(404).json({ message: "Material não encontrado" });
      }
      const buf = Buffer.from(String(row.data), "base64");
      const nome = String(row.file_name || "material").replace(/["\\]/g, "");
      res.setHeader("Content-Type", String(row.mimetype || "application/octet-stream"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${req.query?.download ? "attachment" : "inline"}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.end(buf);
    } catch (e: any) {
      console.error("[MKT-VENDAS] arquivo:", e?.message || e);
      res.status(500).json({ message: "Falha ao ler o arquivo" });
    }
  });

  // Enviar material novo.
  app.post("/api/marketing-vendas", ...podeGerir, multerArquivo, async (req: any, res) => {
    try {
      await ensureSchema();
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Selecione um arquivo" });
      const b = req.body || {};
      const categoria = CATEGORIAS_MARKETING_VENDAS.includes(String(b.categoria || "")) ? String(b.categoria) : "outros";
      const titulo = String(b.titulo || "").trim().slice(0, 120) ||
        String(file.originalname || "Material").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 120);
      const descricao = String(b.descricao ?? "").trim().slice(0, 300) || null;
      const ordem = Number.isFinite(Number(b.ordem)) ? Math.trunc(Number(b.ordem)) : 0;
      const r: any = await db.execute(sql`
        INSERT INTO marketing_vendas_materiais
          (titulo, categoria, descricao, ordem, file_name, mimetype, file_size, data, created_by)
        VALUES (${titulo}, ${categoria}, ${descricao}, ${ordem},
                ${(file.originalname || "material").slice(0, 200)},
                ${file.mimetype || "application/octet-stream"}, ${file.size},
                ${file.buffer.toString("base64")}, ${req.currentUser?.id || null})
        RETURNING id, titulo, categoria, descricao, ordem, ativo, file_name, mimetype, file_size, created_at, updated_at`);
      const material = mapMaterial(r.rows?.[0] || {});
      console.log(`[MKT-VENDAS] novo: ${material.titulo} (${categoria}, ${material.fileSize}B)`);
      res.json({ message: "Material publicado", material });
    } catch (e: any) {
      console.error("[MKT-VENDAS] enviar:", e?.message || e);
      res.status(500).json({ message: "Falha ao enviar o material" });
    }
  });

  // Trocar o arquivo mantendo título/posição (nova versão da tabela).
  app.put("/api/marketing-vendas/:id/arquivo", ...podeGerir, multerArquivo, async (req: any, res) => {
    try {
      await ensureSchema();
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Selecione um arquivo" });
      const r: any = await db.execute(sql`
        UPDATE marketing_vendas_materiais
        SET file_name = ${(file.originalname || "material").slice(0, 200)},
            mimetype = ${file.mimetype || "application/octet-stream"}, file_size = ${file.size},
            data = ${file.buffer.toString("base64")}, updated_at = now()
        WHERE id = ${req.params.id}
        RETURNING id, titulo, categoria, descricao, ordem, ativo, file_name, mimetype, file_size, created_at, updated_at`);
      if (!r.rows?.length) return res.status(404).json({ message: "Material não encontrado" });
      res.json({ message: "Arquivo substituído", material: mapMaterial(r.rows[0]) });
    } catch (e: any) {
      console.error("[MKT-VENDAS] substituir:", e?.message || e);
      res.status(500).json({ message: "Falha ao substituir o arquivo" });
    }
  });

  // Editar título, categoria, descrição, ordem, ativo.
  app.patch("/api/marketing-vendas/:id", ...podeGerir, async (req: any, res) => {
    try {
      await ensureSchema();
      const b = req.body || {};
      const sets: any[] = [];
      if (typeof b.titulo === "string" && b.titulo.trim()) sets.push(sql`titulo = ${b.titulo.trim().slice(0, 120)}`);
      if (typeof b.categoria === "string" && CATEGORIAS_MARKETING_VENDAS.includes(b.categoria)) sets.push(sql`categoria = ${b.categoria}`);
      if (typeof b.descricao === "string") sets.push(sql`descricao = ${b.descricao.trim().slice(0, 300) || null}`);
      if (b.ordem !== undefined && Number.isFinite(Number(b.ordem))) sets.push(sql`ordem = ${Math.trunc(Number(b.ordem))}`);
      if (typeof b.ativo === "boolean") sets.push(sql`ativo = ${b.ativo}`);
      if (!sets.length) return res.status(400).json({ message: "Nada a alterar" });
      sets.push(sql`updated_at = now()`);
      const r: any = await db.execute(sql`
        UPDATE marketing_vendas_materiais SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id}
        RETURNING id, titulo, categoria, descricao, ordem, ativo, file_name, mimetype, file_size, created_at, updated_at`);
      if (!r.rows?.length) return res.status(404).json({ message: "Material não encontrado" });
      res.json({ message: "Material atualizado", material: mapMaterial(r.rows[0]) });
    } catch (e: any) {
      console.error("[MKT-VENDAS] atualizar:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar o material" });
    }
  });

  // Excluir de vez — só admin.
  app.delete("/api/marketing-vendas/:id", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      await ensureSchema();
      const r: any = await db.execute(sql`DELETE FROM marketing_vendas_materiais WHERE id = ${req.params.id} RETURNING titulo`);
      if (!r.rows?.length) return res.status(404).json({ message: "Material não encontrado" });
      res.json({ message: "Material excluído" });
    } catch (e: any) {
      console.error("[MKT-VENDAS] excluir:", e?.message || e);
      res.status(500).json({ message: "Falha ao excluir o material" });
    }
  });
}
