// ============================================================================
// FÁBRICA — CHECKLIST DE PRODUÇÃO + MANUTENÇÃO DE MÁQUINAS (05/set/2026)
// (módulo Indústria › abas "Checklist" e "Manutenção")
//
// Pedido do Flavio:
//  - Cada DIA de produção tem um checklist. Itens a verificar são criados por
//    dia; cada item guarda data, hora do registro, usuário que registrou e uma
//    foto (com timestamp).
//  - Aba Manutenção: máquinas da fábrica com suas manutenções corretivas e
//    preventivas; cada máquina aceita observações (dados técnicos) e fotos das
//    partes e das manutenções realizadas.
//  - (06/set) "permita anexar arquivos": qualquer arquivo (manual, NF de compra,
//    laudo, planilha, PDF) na máquina ou numa manutenção — tabela machine_files,
//    até 25MB, rotas /api/industria/maquinas/:id/arquivos e /maquinas/arquivos/:id.
//
// Mesmo desenho de company-documents-routes.ts / anexos de MP: binário em
// base64 numa coluna própria, listagem NUNCA devolve a coluna data, arquivo
// servido por rota própria. Prefixo /api/industria já protegido no index.ts
// (authenticateUser + requireRole(['admin'])); perfil "industria" é promovido a
// admin no authenticateUser.
//
// Timestamp da foto: o CLIENTE carimba data/hora/usuário na própria imagem
// (canvas) antes de subir, e o SERVIDOR grava taken_at = now() — os dois, para
// a foto ser prova mesmo fora do sistema (impressa/exportada) e para o
// carimbo não depender do relógio do celular.
// ============================================================================
import type { Express } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";

const MAX_FOTO_BYTES = 12 * 1024 * 1024; // 12MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FOTO_BYTES } });
const MAX_ARQUIVO_BYTES = 25 * 1024 * 1024; // 25MB — manuais, laudos, NFs, planilhas
const uploadArquivo = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARQUIVO_BYTES } });

const STATUS_ITEM = ["pendente", "ok", "nao_conforme", "nao_aplicavel"];
const TIPOS_MANUT = ["preventiva", "corretiva", "preditiva", "inspecao"];
const STATUS_MANUT = ["agendada", "em_andamento", "realizada", "cancelada"];
const STATUS_MAQ = ["ativa", "parada", "manutencao", "desativada"];

let schemaReady: Promise<void> | null = null;
export function ensureFabricaSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const run = (s: string) => db.execute(sql.raw(s));
      await run(`CREATE TABLE IF NOT EXISTS production_checklists (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        checklist_date date NOT NULL UNIQUE,
        notes text,
        created_by varchar, created_by_name varchar,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
      await run(`CREATE TABLE IF NOT EXISTS production_checklist_items (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        checklist_id varchar NOT NULL,
        position integer NOT NULL DEFAULT 0,
        description text NOT NULL,
        status varchar NOT NULL DEFAULT 'pendente',
        notes text,
        checked_at timestamptz, checked_by varchar, checked_by_name varchar,
        photo_name text, photo_mimetype text, photo_size integer NOT NULL DEFAULT 0, photo_data text,
        photo_taken_at timestamptz, photo_by varchar, photo_by_name varchar,
        created_by varchar, created_by_name varchar,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
      await run(`CREATE INDEX IF NOT EXISTS idx_pci_checklist ON production_checklist_items (checklist_id, position)`).catch(() => {});

      await run(`CREATE TABLE IF NOT EXISTS machines (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        name text NOT NULL,
        code varchar, sector varchar, brand varchar, model varchar, serial_number varchar,
        manufacture_year integer, acquisition_date date,
        status varchar NOT NULL DEFAULT 'ativa',
        preventive_interval_days integer,
        technical_data text, notes text,
        created_by varchar, updated_by varchar,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
      await run(`CREATE TABLE IF NOT EXISTS machine_notes (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        machine_id varchar NOT NULL,
        title varchar, content text NOT NULL,
        created_by varchar, created_by_name varchar, created_at timestamptz DEFAULT now())`);
      await run(`CREATE INDEX IF NOT EXISTS idx_machine_notes_machine ON machine_notes (machine_id, created_at)`).catch(() => {});
      await run(`CREATE TABLE IF NOT EXISTS machine_maintenances (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        machine_id varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'preventiva',
        status varchar NOT NULL DEFAULT 'agendada',
        scheduled_date date, done_date date,
        description text, performed_by varchar, cost numeric(14,2), downtime_hours numeric(8,2),
        notes text,
        created_by varchar, created_by_name varchar,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
      await run(`CREATE INDEX IF NOT EXISTS idx_machine_maint_machine ON machine_maintenances (machine_id, scheduled_date)`).catch(() => {});
      await run(`CREATE TABLE IF NOT EXISTS machine_photos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        machine_id varchar NOT NULL,
        maintenance_id varchar,
        caption text,
        file_name text, mimetype text, file_size integer NOT NULL DEFAULT 0, data text,
        taken_at timestamptz DEFAULT now(),
        created_by varchar, created_by_name varchar, created_at timestamptz DEFAULT now())`);
      await run(`CREATE INDEX IF NOT EXISTS idx_machine_photos_machine ON machine_photos (machine_id, taken_at)`).catch(() => {});
      // Arquivos de qualquer tipo (manual, NF de compra, laudo, planilha...) da máquina ou de uma manutenção
      await run(`CREATE TABLE IF NOT EXISTS machine_files (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        machine_id varchar NOT NULL,
        maintenance_id varchar,
        description text,
        file_name text NOT NULL, mimetype text, file_size integer NOT NULL DEFAULT 0, data text,
        created_by varchar, created_by_name varchar, created_at timestamptz DEFAULT now())`);
      await run(`CREATE INDEX IF NOT EXISTS idx_machine_files_machine ON machine_files (machine_id, created_at)`).catch(() => {});
    })().catch((e: any) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
const hojeBR = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const isoDate = (v: any): string | null => {
  const s = String(v ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const toISO = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const str = (v: any, max = 500): string | null => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
const num = (v: any): number | null => { if (v === "" || v == null) return null; const n = Number(String(v).replace(",", ".")); return isFinite(n) ? n : null; };
const quem = (req: any) => ({ id: req.currentUser?.id || null, nome: [req.currentUser?.firstName, req.currentUser?.lastName].filter(Boolean).join(" ") || req.currentUser?.email || null });
const podeEditar = (user: any) => ["admin", "coordinator"].includes(user?.role || "");

function multerFoto(req: any, res: any, next: any) {
  upload.single("arquivo")(req, res, (err: any) => {
    if (err) return res.status(400).json({ message: err?.code === "LIMIT_FILE_SIZE" ? "Foto acima de 12MB" : (err?.message || "Falha no upload") });
    next();
  });
}
function multerArquivo(req: any, res: any, next: any) {
  uploadArquivo.single("arquivo")(req, res, (err: any) => {
    if (err) return res.status(400).json({ message: err?.code === "LIMIT_FILE_SIZE" ? "Arquivo acima de 25MB" : (err?.message || "Falha no upload") });
    next();
  });
}
function servirBinario(res: any, row: any, campo = "data", nomeCampo = "file_name", mimeCampo = "mimetype") {
  if (!row || !row[campo]) return res.status(404).json({ message: "Arquivo não encontrado" });
  const buf = Buffer.from(String(row[campo]), "base64");
  res.setHeader("Content-Type", String(row[mimeCampo] || "application/octet-stream"));
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Content-Disposition", `inline; filename="${String(row[nomeCampo] || "foto.jpg").replace(/["\\]/g, "")}"`);
  res.setHeader("Cache-Control", "private, max-age=600");
  res.end(buf);
}

const mapItem = (r: any) => ({
  id: r.id, checklistId: r.checklist_id, position: Number(r.position || 0), description: r.description,
  status: r.status, notes: r.notes || "",
  checkedAt: r.checked_at, checkedBy: r.checked_by_name || r.checked_by || null,
  hasPhoto: !!r.photo_name, photoName: r.photo_name || null, photoTakenAt: r.photo_taken_at, photoBy: r.photo_by_name || r.photo_by || null,
  createdAt: r.created_at, createdBy: r.created_by_name || r.created_by || null, updatedAt: r.updated_at,
});

// ---------------------------------------------------------------------------
export function registerFabricaRoutes(app: Express) {
  ensureFabricaSchema().catch((e: any) => console.error("[FABRICA] schema:", e?.message || e));

  // ======================= CHECKLIST DE PRODUÇÃO =======================

  // Dias com checklist (para o calendário/lista lateral), com contagem por status.
  app.get("/api/industria/checklist/dias", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const ini = isoDate(req.query.de) || new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const fim = isoDate(req.query.ate) || "2999-12-31";
      const r: any = await db.execute(sql`
        SELECT c.id, c.checklist_date, c.notes, c.created_by_name,
               COUNT(i.id)::int AS total,
               COUNT(i.id) FILTER (WHERE i.status = 'ok')::int AS ok,
               COUNT(i.id) FILTER (WHERE i.status = 'nao_conforme')::int AS nao_conforme,
               COUNT(i.id) FILTER (WHERE i.status = 'pendente')::int AS pendentes,
               COUNT(i.id) FILTER (WHERE i.photo_name IS NOT NULL)::int AS fotos
        FROM production_checklists c
        LEFT JOIN production_checklist_items i ON i.checklist_id = c.id
        WHERE c.checklist_date BETWEEN ${ini} AND ${fim}
        GROUP BY c.id ORDER BY c.checklist_date DESC`);
      res.json({ dias: (r.rows || []).map((x: any) => ({ id: x.id, date: toISO(x.checklist_date), notes: x.notes || "", createdBy: x.created_by_name, total: x.total, ok: x.ok, naoConforme: x.nao_conforme, pendentes: x.pendentes, fotos: x.fotos })) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Checklist de um dia (null se ainda não existe) + itens.
  app.get("/api/industria/checklist/:date", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const d = isoDate(req.params.date);
      if (!d) return res.status(400).json({ message: "Data inválida (yyyy-mm-dd)" });
      const c: any = await db.execute(sql`SELECT * FROM production_checklists WHERE checklist_date = ${d} LIMIT 1`);
      const ck = (c.rows || [])[0];
      if (!ck) return res.json({ checklist: null, items: [] });
      const it: any = await db.execute(sql`SELECT id, checklist_id, position, description, status, notes, checked_at, checked_by, checked_by_name, photo_name, photo_taken_at, photo_by, photo_by_name, created_at, created_by, created_by_name, updated_at FROM production_checklist_items WHERE checklist_id = ${ck.id} ORDER BY position, created_at`);
      res.json({ checklist: { id: ck.id, date: toISO(ck.checklist_date), notes: ck.notes || "", createdBy: ck.created_by_name, createdAt: ck.created_at }, items: (it.rows || []).map(mapItem) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  const garantirChecklist = async (d: string, req: any) => {
    const u = quem(req);
    const r: any = await db.execute(sql`
      INSERT INTO production_checklists (checklist_date, created_by, created_by_name)
      VALUES (${d}, ${u.id}, ${u.nome})
      ON CONFLICT (checklist_date) DO UPDATE SET updated_at = now()
      RETURNING *`);
    return (r.rows || [])[0];
  };

  // Observação do dia
  app.patch("/api/industria/checklist/:date", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const d = isoDate(req.params.date);
      if (!d) return res.status(400).json({ message: "Data inválida" });
      const ck = await garantirChecklist(d, req);
      await db.execute(sql`UPDATE production_checklists SET notes = ${str(req.body?.notes, 2000)}, updated_at = now() WHERE id = ${ck.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Novo item a verificar no dia (cria o checklist do dia se não existir).
  app.post("/api/industria/checklist/:date/itens", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const d = isoDate(req.params.date);
      if (!d) return res.status(400).json({ message: "Data inválida" });
      const lista: string[] = Array.isArray(req.body?.descriptions) ? req.body.descriptions : [req.body?.description];
      const descs = lista.map((x) => str(x, 500)).filter(Boolean) as string[];
      if (!descs.length) return res.status(400).json({ message: "Informe o item a verificar" });
      const ck = await garantirChecklist(d, req);
      const u = quem(req);
      const pos: any = await db.execute(sql`SELECT COALESCE(MAX(position), 0)::int AS p FROM production_checklist_items WHERE checklist_id = ${ck.id}`);
      let p = Number((pos.rows || [])[0]?.p || 0);
      const criados: any[] = [];
      for (const desc of descs) {
        p += 1;
        const r: any = await db.execute(sql`
          INSERT INTO production_checklist_items (checklist_id, position, description, created_by, created_by_name)
          VALUES (${ck.id}, ${p}, ${desc}, ${u.id}, ${u.nome}) RETURNING *`);
        criados.push(mapItem((r.rows || [])[0]));
      }
      res.status(201).json({ ok: true, items: criados });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Copia os itens (só descrições) do último checklist anterior à data.
  app.post("/api/industria/checklist/:date/copiar-anterior", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const d = isoDate(req.params.date);
      if (!d) return res.status(400).json({ message: "Data inválida" });
      const prev: any = await db.execute(sql`SELECT id, checklist_date FROM production_checklists WHERE checklist_date < ${d} ORDER BY checklist_date DESC LIMIT 1`);
      const src = (prev.rows || [])[0];
      if (!src) return res.status(404).json({ message: "Não há checklist anterior para copiar" });
      const its: any = await db.execute(sql`SELECT description FROM production_checklist_items WHERE checklist_id = ${src.id} ORDER BY position, created_at`);
      const ck = await garantirChecklist(d, req);
      const u = quem(req);
      const existentes: any = await db.execute(sql`SELECT description FROM production_checklist_items WHERE checklist_id = ${ck.id}`);
      const ja = new Set((existentes.rows || []).map((x: any) => String(x.description).trim().toUpperCase()));
      const pos: any = await db.execute(sql`SELECT COALESCE(MAX(position), 0)::int AS p FROM production_checklist_items WHERE checklist_id = ${ck.id}`);
      let p = Number((pos.rows || [])[0]?.p || 0); let n = 0;
      for (const it of (its.rows || [])) {
        if (ja.has(String(it.description).trim().toUpperCase())) continue;
        p += 1; n += 1;
        await db.execute(sql`INSERT INTO production_checklist_items (checklist_id, position, description, created_by, created_by_name) VALUES (${ck.id}, ${p}, ${it.description}, ${u.id}, ${u.nome})`);
      }
      res.json({ ok: true, copiados: n, de: toISO(src.checklist_date) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Registrar verificação (status/observação/descrição). Mudar o status grava
  // hora e usuário do registro.
  app.patch("/api/industria/checklist/itens/:id", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const b = req.body || {};
      const cur: any = await db.execute(sql`SELECT * FROM production_checklist_items WHERE id = ${req.params.id}`);
      const it = (cur.rows || [])[0];
      if (!it) return res.status(404).json({ message: "Item não encontrado" });
      const u = quem(req);
      const sets: any[] = [];
      if (b.description !== undefined) { const dsc = str(b.description, 500); if (!dsc) return res.status(400).json({ message: "Descrição vazia" }); sets.push(sql`description = ${dsc}`); }
      if (b.notes !== undefined) sets.push(sql`notes = ${str(b.notes, 2000)}`);
      if (b.status !== undefined) {
        if (!STATUS_ITEM.includes(String(b.status))) return res.status(400).json({ message: "Status inválido" });
        sets.push(sql`status = ${String(b.status)}`);
        if (String(b.status) === "pendente") sets.push(sql`checked_at = NULL`, sql`checked_by = NULL`, sql`checked_by_name = NULL`);
        else sets.push(sql`checked_at = now()`, sql`checked_by = ${u.id}`, sql`checked_by_name = ${u.nome}`);
      }
      if (b.position !== undefined && num(b.position) != null) sets.push(sql`position = ${Math.round(num(b.position)!)}`);
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_at = now()`);
      const r: any = await db.execute(sql`UPDATE production_checklist_items SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id} RETURNING id, checklist_id, position, description, status, notes, checked_at, checked_by, checked_by_name, photo_name, photo_taken_at, photo_by, photo_by_name, created_at, created_by, created_by_name, updated_at`);
      res.json({ ok: true, item: mapItem((r.rows || [])[0]) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Foto do item (substitui a anterior). taken_at = agora, no servidor.
  app.post("/api/industria/checklist/itens/:id/foto", multerFoto, async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Envie a foto no campo 'arquivo'" });
      if (!/^image\//.test(file.mimetype || "")) return res.status(400).json({ message: "Só imagens são aceitas" });
      const u = quem(req);
      const r: any = await db.execute(sql`
        UPDATE production_checklist_items SET
          photo_name = ${(file.originalname || "foto.jpg").slice(0, 200)}, photo_mimetype = ${file.mimetype}, photo_size = ${file.size},
          photo_data = ${file.buffer.toString("base64")}, photo_taken_at = now(), photo_by = ${u.id}, photo_by_name = ${u.nome},
          updated_at = now()
        WHERE id = ${req.params.id}
        RETURNING id, checklist_id, position, description, status, notes, checked_at, checked_by, checked_by_name, photo_name, photo_taken_at, photo_by, photo_by_name, created_at, created_by, created_by_name, updated_at`);
      const row = (r.rows || [])[0];
      if (!row) return res.status(404).json({ message: "Item não encontrado" });
      res.json({ ok: true, item: mapItem(row) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.get("/api/industria/checklist/itens/:id/foto", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const r: any = await db.execute(sql`SELECT photo_name AS file_name, photo_mimetype AS mimetype, photo_data AS data FROM production_checklist_items WHERE id = ${req.params.id}`);
      servirBinario(res, (r.rows || [])[0]);
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.delete("/api/industria/checklist/itens/:id/foto", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      await db.execute(sql`UPDATE production_checklist_items SET photo_name = NULL, photo_mimetype = NULL, photo_size = 0, photo_data = NULL, photo_taken_at = NULL, photo_by = NULL, photo_by_name = NULL, updated_at = now() WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.delete("/api/industria/checklist/itens/:id", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await db.execute(sql`DELETE FROM production_checklist_items WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // ============================= MÁQUINAS ==============================

  const mapMaquina = (m: any) => ({
    id: m.id, name: m.name, code: m.code || "", sector: m.sector || "", brand: m.brand || "", model: m.model || "",
    serialNumber: m.serial_number || "", manufactureYear: m.manufacture_year, acquisitionDate: toISO(m.acquisition_date),
    status: m.status, preventiveIntervalDays: m.preventive_interval_days, technicalData: m.technical_data || "", notes: m.notes || "",
    createdAt: m.created_at, updatedAt: m.updated_at,
    ultimaPreventiva: toISO(m.ultima_preventiva), ultimaCorretiva: toISO(m.ultima_corretiva), proximaAgendada: toISO(m.proxima_agendada),
    // proxima preventiva sugerida = ultima preventiva + intervalo (quando os dois existem)
    proximaPreventivaSugerida: m.ultima_preventiva && m.preventive_interval_days
      ? new Date(new Date(toISO(m.ultima_preventiva) + "T00:00:00Z").getTime() + Number(m.preventive_interval_days) * 86400000).toISOString().slice(0, 10) : null,
    manutencoes: Number(m.manutencoes || 0), fotos: Number(m.fotos || 0), observacoes: Number(m.observacoes || 0), arquivos: Number(m.arquivos || 0),
  });
  const mapArquivo = (f: any) => ({ id: f.id, maintenanceId: f.maintenance_id, description: f.description || "", fileName: f.file_name, mimetype: f.mimetype, fileSize: Number(f.file_size || 0), createdBy: f.created_by_name, createdAt: f.created_at });
  const SELECT_MAQ = sql`
    SELECT m.*,
      (SELECT MAX(done_date) FROM machine_maintenances x WHERE x.machine_id = m.id AND x.type = 'preventiva' AND x.status = 'realizada') AS ultima_preventiva,
      (SELECT MAX(done_date) FROM machine_maintenances x WHERE x.machine_id = m.id AND x.type = 'corretiva' AND x.status = 'realizada') AS ultima_corretiva,
      (SELECT MIN(scheduled_date) FROM machine_maintenances x WHERE x.machine_id = m.id AND x.status IN ('agendada','em_andamento') AND x.scheduled_date >= CURRENT_DATE) AS proxima_agendada,
      (SELECT COUNT(*) FROM machine_maintenances x WHERE x.machine_id = m.id) AS manutencoes,
      (SELECT COUNT(*) FROM machine_photos x WHERE x.machine_id = m.id) AS fotos,
      (SELECT COUNT(*) FROM machine_files x WHERE x.machine_id = m.id) AS arquivos,
      (SELECT COUNT(*) FROM machine_notes x WHERE x.machine_id = m.id) AS observacoes
    FROM machines m`;

  app.get("/api/industria/maquinas", async (_req: any, res) => {
    try {
      await ensureFabricaSchema();
      const r: any = await db.execute(sql`${SELECT_MAQ} ORDER BY m.status = 'desativada', m.name`);
      res.json({ maquinas: (r.rows || []).map(mapMaquina) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  const camposMaquina = (b: any, parcial: boolean) => {
    const c: any = {};
    if (!parcial || b.name !== undefined) { c.name = str(b.name, 200); if (!c.name) return { erro: "Informe o nome da máquina" }; }
    for (const k of ["code", "sector", "brand", "model", "serialNumber"]) if (b[k] !== undefined) c[k] = str(b[k], 120);
    if (b.manufactureYear !== undefined) c.manufactureYear = num(b.manufactureYear) != null ? Math.round(num(b.manufactureYear)!) : null;
    if (b.acquisitionDate !== undefined) c.acquisitionDate = isoDate(b.acquisitionDate);
    if (b.status !== undefined) { if (!STATUS_MAQ.includes(String(b.status))) return { erro: "Status inválido" }; c.status = String(b.status); }
    if (b.preventiveIntervalDays !== undefined) c.preventiveIntervalDays = num(b.preventiveIntervalDays) != null ? Math.round(num(b.preventiveIntervalDays)!) : null;
    if (b.technicalData !== undefined) c.technicalData = str(b.technicalData, 8000);
    if (b.notes !== undefined) c.notes = str(b.notes, 4000);
    return { c };
  };

  app.post("/api/industria/maquinas", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      const v = camposMaquina(req.body || {}, false); if (v.erro) return res.status(400).json({ message: v.erro });
      const c = v.c!; const u = quem(req);
      const r: any = await db.execute(sql`
        INSERT INTO machines (name, code, sector, brand, model, serial_number, manufacture_year, acquisition_date, status, preventive_interval_days, technical_data, notes, created_by, updated_by)
        VALUES (${c.name}, ${c.code ?? null}, ${c.sector ?? null}, ${c.brand ?? null}, ${c.model ?? null}, ${c.serialNumber ?? null}, ${c.manufactureYear ?? null}, ${c.acquisitionDate ?? null}, ${c.status ?? "ativa"}, ${c.preventiveIntervalDays ?? null}, ${c.technicalData ?? null}, ${c.notes ?? null}, ${u.id}, ${u.id})
        RETURNING id`);
      const id = (r.rows || [])[0].id;
      const m: any = await db.execute(sql`${SELECT_MAQ} WHERE m.id = ${id}`);
      res.status(201).json({ ok: true, maquina: mapMaquina((m.rows || [])[0]) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.patch("/api/industria/maquinas/:id", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      const v = camposMaquina(req.body || {}, true); if (v.erro) return res.status(400).json({ message: v.erro });
      const c = v.c!; const sets: any[] = [];
      const col: Record<string, string> = { name: "name", code: "code", sector: "sector", brand: "brand", model: "model", serialNumber: "serial_number", manufactureYear: "manufacture_year", acquisitionDate: "acquisition_date", status: "status", preventiveIntervalDays: "preventive_interval_days", technicalData: "technical_data", notes: "notes" };
      for (const k of Object.keys(c)) sets.push(sql`${sql.raw(col[k])} = ${c[k]}`);
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_by = ${quem(req).id}`, sql`updated_at = now()`);
      await db.execute(sql`UPDATE machines SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id}`);
      const m: any = await db.execute(sql`${SELECT_MAQ} WHERE m.id = ${req.params.id}`);
      if (!(m.rows || []).length) return res.status(404).json({ message: "Máquina não encontrada" });
      res.json({ ok: true, maquina: mapMaquina((m.rows || [])[0]) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.delete("/api/industria/maquinas/:id", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      const id = req.params.id;
      await db.execute(sql`DELETE FROM machine_photos WHERE machine_id = ${id}`);
      await db.execute(sql`DELETE FROM machine_files WHERE machine_id = ${id}`);
      await db.execute(sql`DELETE FROM machine_maintenances WHERE machine_id = ${id}`);
      await db.execute(sql`DELETE FROM machine_notes WHERE machine_id = ${id}`);
      await db.execute(sql`DELETE FROM machines WHERE id = ${id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Detalhe: máquina + observações + manutenções + fotos (metadados)
  app.get("/api/industria/maquinas/:id", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const m: any = await db.execute(sql`${SELECT_MAQ} WHERE m.id = ${req.params.id}`);
      const maq = (m.rows || [])[0];
      if (!maq) return res.status(404).json({ message: "Máquina não encontrada" });
      const notas: any = await db.execute(sql`SELECT * FROM machine_notes WHERE machine_id = ${maq.id} ORDER BY created_at DESC`);
      const man: any = await db.execute(sql`SELECT * FROM machine_maintenances WHERE machine_id = ${maq.id} ORDER BY COALESCE(done_date, scheduled_date) DESC NULLS LAST, created_at DESC`);
      const fotos: any = await db.execute(sql`SELECT id, machine_id, maintenance_id, caption, file_name, mimetype, file_size, taken_at, created_by_name, created_at FROM machine_photos WHERE machine_id = ${maq.id} ORDER BY taken_at DESC`);
      const arqs: any = await db.execute(sql`SELECT id, maintenance_id, description, file_name, mimetype, file_size, created_by_name, created_at FROM machine_files WHERE machine_id = ${maq.id} ORDER BY created_at DESC`);
      res.json({
        arquivos: (arqs.rows || []).map(mapArquivo),
        maquina: mapMaquina(maq),
        observacoes: (notas.rows || []).map((n: any) => ({ id: n.id, title: n.title || "", content: n.content, createdBy: n.created_by_name || n.created_by, createdAt: n.created_at })),
        manutencoes: (man.rows || []).map((x: any) => ({ id: x.id, type: x.type, status: x.status, scheduledDate: toISO(x.scheduled_date), doneDate: toISO(x.done_date), description: x.description || "", performedBy: x.performed_by || "", cost: x.cost != null ? Number(x.cost) : null, downtimeHours: x.downtime_hours != null ? Number(x.downtime_hours) : null, notes: x.notes || "", createdBy: x.created_by_name || x.created_by, createdAt: x.created_at })),
        fotos: (fotos.rows || []).map((f: any) => ({ id: f.id, maintenanceId: f.maintenance_id, caption: f.caption || "", fileName: f.file_name, mimetype: f.mimetype, fileSize: Number(f.file_size || 0), takenAt: f.taken_at, createdBy: f.created_by_name, createdAt: f.created_at })),
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Observações (dados técnicos, ocorrências)
  app.post("/api/industria/maquinas/:id/observacoes", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const content = str(req.body?.content, 8000);
      if (!content) return res.status(400).json({ message: "Informe a observação" });
      const u = quem(req);
      const r: any = await db.execute(sql`INSERT INTO machine_notes (machine_id, title, content, created_by, created_by_name) VALUES (${req.params.id}, ${str(req.body?.title, 200)}, ${content}, ${u.id}, ${u.nome}) RETURNING *`);
      const n = (r.rows || [])[0];
      res.status(201).json({ ok: true, observacao: { id: n.id, title: n.title || "", content: n.content, createdBy: n.created_by_name, createdAt: n.created_at } });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.delete("/api/industria/maquinas/observacoes/:id", async (req: any, res) => {
    try { await ensureFabricaSchema(); if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" }); await db.execute(sql`DELETE FROM machine_notes WHERE id = ${req.params.id}`); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Manutenções
  const camposManut = (b: any) => {
    const c: any = {};
    if (b.type !== undefined) { if (!TIPOS_MANUT.includes(String(b.type))) return { erro: "Tipo inválido" }; c.type = String(b.type); }
    if (b.status !== undefined) { if (!STATUS_MANUT.includes(String(b.status))) return { erro: "Status inválido" }; c.status = String(b.status); }
    if (b.scheduledDate !== undefined) c.scheduledDate = isoDate(b.scheduledDate);
    if (b.doneDate !== undefined) c.doneDate = isoDate(b.doneDate);
    if (b.description !== undefined) c.description = str(b.description, 4000);
    if (b.performedBy !== undefined) c.performedBy = str(b.performedBy, 200);
    if (b.cost !== undefined) c.cost = num(b.cost);
    if (b.downtimeHours !== undefined) c.downtimeHours = num(b.downtimeHours);
    if (b.notes !== undefined) c.notes = str(b.notes, 4000);
    // realizada sem data -> hoje
    if (c.status === "realizada" && b.doneDate === undefined) c.doneDate = c.doneDate ?? hojeBR();
    return { c };
  };
  app.post("/api/industria/maquinas/:id/manutencoes", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const v = camposManut(req.body || {}); if (v.erro) return res.status(400).json({ message: v.erro });
      const c = v.c!; const u = quem(req);
      if (!c.type) c.type = "preventiva";
      if (!c.status) c.status = c.doneDate ? "realizada" : "agendada";
      if (c.status === "realizada" && !c.doneDate) c.doneDate = hojeBR();
      if (!c.scheduledDate && !c.doneDate) return res.status(400).json({ message: "Informe a data (agendada ou realizada)" });
      const r: any = await db.execute(sql`
        INSERT INTO machine_maintenances (machine_id, type, status, scheduled_date, done_date, description, performed_by, cost, downtime_hours, notes, created_by, created_by_name)
        VALUES (${req.params.id}, ${c.type}, ${c.status}, ${c.scheduledDate ?? null}, ${c.doneDate ?? null}, ${c.description ?? null}, ${c.performedBy ?? null}, ${c.cost ?? null}, ${c.downtimeHours ?? null}, ${c.notes ?? null}, ${u.id}, ${u.nome})
        RETURNING id`);
      res.status(201).json({ ok: true, id: (r.rows || [])[0].id });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.patch("/api/industria/maquinas/manutencoes/:id", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const v = camposManut(req.body || {}); if (v.erro) return res.status(400).json({ message: v.erro });
      const c = v.c!; const sets: any[] = [];
      const col: Record<string, string> = { type: "type", status: "status", scheduledDate: "scheduled_date", doneDate: "done_date", description: "description", performedBy: "performed_by", cost: "cost", downtimeHours: "downtime_hours", notes: "notes" };
      for (const k of Object.keys(c)) sets.push(sql`${sql.raw(col[k])} = ${c[k]}`);
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_at = now()`);
      await db.execute(sql`UPDATE machine_maintenances SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.delete("/api/industria/maquinas/manutencoes/:id", async (req: any, res) => {
    try {
      await ensureFabricaSchema(); if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await db.execute(sql`UPDATE machine_photos SET maintenance_id = NULL WHERE maintenance_id = ${req.params.id}`);
      await db.execute(sql`UPDATE machine_files SET maintenance_id = NULL WHERE maintenance_id = ${req.params.id}`);
      await db.execute(sql`DELETE FROM machine_maintenances WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Arquivos (qualquer tipo) da máquina ou de uma manutenção (maintenanceId no form)
  app.post("/api/industria/maquinas/:id/arquivos", multerArquivo, async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Envie o arquivo no campo 'arquivo'" });
      const maq: any = await db.execute(sql`SELECT id FROM machines WHERE id = ${req.params.id}`);
      if (!(maq.rows || [])[0]) return res.status(404).json({ message: "Máquina não encontrada" });
      const u = quem(req);
      const maintenanceId = str(req.body?.maintenanceId, 60);
      const nome = Buffer.from(file.originalname || "arquivo", "latin1").toString("utf8").slice(0, 200);
      const r: any = await db.execute(sql`
        INSERT INTO machine_files (machine_id, maintenance_id, description, file_name, mimetype, file_size, data, created_by, created_by_name)
        VALUES (${req.params.id}, ${maintenanceId}, ${str(req.body?.description, 300)}, ${nome}, ${file.mimetype || "application/octet-stream"}, ${file.size}, ${file.buffer.toString("base64")}, ${u.id}, ${u.nome})
        RETURNING id, maintenance_id, description, file_name, mimetype, file_size, created_by_name, created_at`);
      res.status(201).json({ ok: true, arquivo: mapArquivo((r.rows || [])[0]) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.get("/api/industria/maquinas/arquivos/:id/download", async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const r: any = await db.execute(sql`SELECT file_name, mimetype, data FROM machine_files WHERE id = ${req.params.id}`);
      const row = (r.rows || [])[0];
      if (!row || !row.data) return res.status(404).json({ message: "Arquivo não encontrado" });
      const buf = Buffer.from(String(row.data), "base64");
      const inline = /^(image\/|application\/pdf)/.test(String(row.mimetype || "")) && req.query.download !== "1";
      res.setHeader("Content-Type", String(row.mimetype || "application/octet-stream"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(String(row.file_name || "arquivo"))}`);
      res.setHeader("Cache-Control", "private, max-age=600");
      res.end(buf);
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.patch("/api/industria/maquinas/arquivos/:id", async (req: any, res) => {
    try { await ensureFabricaSchema(); await db.execute(sql`UPDATE machine_files SET description = ${str(req.body?.description, 300)} WHERE id = ${req.params.id}`); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.delete("/api/industria/maquinas/arquivos/:id", async (req: any, res) => {
    try { await ensureFabricaSchema(); if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" }); await db.execute(sql`DELETE FROM machine_files WHERE id = ${req.params.id}`); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Fotos da máquina (partes) ou de uma manutenção (maintenanceId no form)
  app.post("/api/industria/maquinas/:id/fotos", multerFoto, async (req: any, res) => {
    try {
      await ensureFabricaSchema();
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Envie a foto no campo 'arquivo'" });
      if (!/^image\//.test(file.mimetype || "")) return res.status(400).json({ message: "Só imagens são aceitas" });
      const u = quem(req);
      const maintenanceId = str(req.body?.maintenanceId, 60);
      const r: any = await db.execute(sql`
        INSERT INTO machine_photos (machine_id, maintenance_id, caption, file_name, mimetype, file_size, data, taken_at, created_by, created_by_name)
        VALUES (${req.params.id}, ${maintenanceId}, ${str(req.body?.caption, 300)}, ${(file.originalname || "foto.jpg").slice(0, 200)}, ${file.mimetype}, ${file.size}, ${file.buffer.toString("base64")}, now(), ${u.id}, ${u.nome})
        RETURNING id, machine_id, maintenance_id, caption, file_name, mimetype, file_size, taken_at, created_by_name, created_at`);
      const f = (r.rows || [])[0];
      res.status(201).json({ ok: true, foto: { id: f.id, maintenanceId: f.maintenance_id, caption: f.caption || "", fileName: f.file_name, mimetype: f.mimetype, fileSize: Number(f.file_size || 0), takenAt: f.taken_at, createdBy: f.created_by_name, createdAt: f.created_at } });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.get("/api/industria/maquinas/fotos/:id/arquivo", async (req: any, res) => {
    try { await ensureFabricaSchema(); const r: any = await db.execute(sql`SELECT file_name, mimetype, data FROM machine_photos WHERE id = ${req.params.id}`); servirBinario(res, (r.rows || [])[0]); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.delete("/api/industria/maquinas/fotos/:id", async (req: any, res) => {
    try { await ensureFabricaSchema(); if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" }); await db.execute(sql`DELETE FROM machine_photos WHERE id = ${req.params.id}`); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  console.log("✅ Fabrica routes (checklist de producao + manutencao) registradas");
}
