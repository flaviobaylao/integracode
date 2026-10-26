// server/agenda-routes.ts
// -----------------------------------------------------------------------------
// MINHA AGENDA — agenda pessoal no estilo Google Agenda (26/10/2026)
//
// A tabela `personal_agenda_items` veio do 1.0 (sync ja desligado) e nao esta
// no schema drizzle. O 2.0 passa a ser o DONO dela: este modulo garante as
// colunas que a tela usa (ALTER ... IF NOT EXISTS no boot) e expoe CRUD por
// usuario. Cada pessoa ve e edita SO a propria agenda (user_id = usuario da
// sessao). Sem recorrencia, sem compartilhamento, sem lembretes — por decisao.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const COR_PADRAO = "#2a78d6";
const STATUS = new Set(["pending", "done"]);
const PRIORIDADE = new Set(["low", "medium", "high"]);

let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS personal_agenda_items (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id varchar,
        kind varchar DEFAULT 'event',
        title varchar NOT NULL,
        description text,
        start_at timestamp,
        end_at timestamp,
        all_day boolean DEFAULT false,
        location varchar,
        priority varchar DEFAULT 'medium',
        status varchar DEFAULT 'pending',
        recurrence varchar,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      )`);
      await db.execute(sql`ALTER TABLE personal_agenda_items ADD COLUMN IF NOT EXISTS color varchar`);
      await db.execute(sql`ALTER TABLE personal_agenda_items ADD COLUMN IF NOT EXISTS location varchar`);
      await db.execute(sql`ALTER TABLE personal_agenda_items ADD COLUMN IF NOT EXISTS all_day boolean DEFAULT false`);
      await db.execute(sql`ALTER TABLE personal_agenda_items ADD COLUMN IF NOT EXISTS end_at timestamp`);
      await db.execute(sql`ALTER TABLE personal_agenda_items ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now()`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_pai_user_start ON personal_agenda_items (user_id, start_at)`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

function userIdOf(req: Request): string | null {
  const u: any = (req as any).currentUser || (req as any).user || null;
  return u?.id ? String(u.id) : null;
}

function parseDate(v: any): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function corValida(c: any): string {
  const s = String(c || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : COR_PADRAO;
}

function rowOut(r: any) {
  return {
    id: r.id,
    title: r.title,
    description: r.description || "",
    start: r.start_at,
    end: r.end_at,
    allDay: !!r.all_day,
    location: r.location || "",
    color: r.color || COR_PADRAO,
    status: r.status || "pending",
    priority: r.priority || "medium",
    kind: r.kind || "event",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Normaliza o corpo de POST/PATCH. `partial` = so' os campos presentes. */
function parseBody(b: any, partial: boolean) {
  const out: Record<string, any> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b || {}, k);
  if (!partial || has("title")) {
    const t = String(b?.title ?? "").trim();
    if (!t) throw new Error("Título é obrigatório");
    out.title = t.slice(0, 200);
  }
  if (!partial || has("start")) {
    const s = parseDate(b?.start);
    if (!s) throw new Error("Data/hora de início inválida");
    out.start_at = s;
  }
  if (!partial || has("end")) out.end_at = parseDate(b?.end);
  if (!partial || has("allDay")) out.all_day = !!b?.allDay;
  if (!partial || has("description")) out.description = String(b?.description ?? "").slice(0, 4000);
  if (!partial || has("location")) out.location = String(b?.location ?? "").slice(0, 300);
  if (!partial || has("color")) out.color = corValida(b?.color);
  if (!partial || has("status")) out.status = STATUS.has(b?.status) ? b.status : "pending";
  if (!partial || has("priority")) out.priority = PRIORIDADE.has(b?.priority) ? b.priority : "medium";
  if (!partial || has("kind")) out.kind = String(b?.kind || "event").slice(0, 40);
  // fim antes do inicio num evento com hora: forca 1h (como faz o Google)
  if (out.start_at && out.end_at && !out.all_day && out.end_at <= out.start_at) {
    out.end_at = new Date(out.start_at.getTime() + 3600_000);
  }
  return out;
}

export function registerAgenda(app: Express) {
  ensureTable().catch((e) => console.error("[AGENDA] ensureTable:", e?.message || e));

  const guard = async (req: Request, res: Response): Promise<string | null> => {
    const uid = userIdOf(req);
    if (!uid) { res.status(401).json({ message: "Unauthorized" }); return null; }
    try { await ensureTable(); } catch (e: any) { res.status(500).json({ message: "Agenda indisponível: " + (e?.message || e) }); return null; }
    return uid;
  };

  // Eventos do usuario num periodo (start/end = ISO; default mes corrente +-1)
  app.get("/api/agenda/items", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const start = parseDate(req.query.start) || new Date(Date.now() - 45 * 86400_000);
      const end = parseDate(req.query.end) || new Date(Date.now() + 90 * 86400_000);
      const q = String(req.query.q || "").trim().toLowerCase();
      const r: any = await db.execute(sql`
        SELECT * FROM personal_agenda_items
        WHERE user_id = ${uid}
          AND start_at IS NOT NULL
          AND start_at < ${end}
          AND COALESCE(end_at, start_at + interval '1 hour') > ${start}
          ${q ? sql`AND (lower(title) LIKE ${"%" + q + "%"} OR lower(COALESCE(location,'')) LIKE ${"%" + q + "%"} OR lower(COALESCE(description,'')) LIKE ${"%" + q + "%"})` : sql``}
        ORDER BY start_at`);
      res.json((r.rows || []).map(rowOut));
    } catch (e: any) {
      console.error("[AGENDA] list:", e);
      res.status(500).json({ message: e?.message || "Erro ao listar agenda" });
    }
  });

  // Cores ja usadas pelo usuario (vira a lista de "categorias" da lateral)
  app.get("/api/agenda/colors", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const r: any = await db.execute(sql`
        SELECT COALESCE(color, ${COR_PADRAO}) AS color, count(*)::int AS n
        FROM personal_agenda_items WHERE user_id = ${uid}
        GROUP BY 1 ORDER BY n DESC, 1`);
      res.json(r.rows || []);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Erro" });
    }
  });

  app.post("/api/agenda/items", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const d = parseBody(req.body, false);
      const r: any = await db.execute(sql`
        INSERT INTO personal_agenda_items
          (id, user_id, kind, title, description, start_at, end_at, all_day, location, priority, status, color, created_at, updated_at)
        VALUES
          (gen_random_uuid()::text, ${uid}, ${d.kind}, ${d.title}, ${d.description}, ${d.start_at}, ${d.end_at}, ${d.all_day},
           ${d.location}, ${d.priority}, ${d.status}, ${d.color}, now(), now())
        RETURNING *`);
      res.status(201).json(rowOut(r.rows[0]));
    } catch (e: any) {
      const msg = e?.message || "Erro ao criar evento";
      res.status(/obrigat|inválid/i.test(msg) ? 400 : 500).json({ message: msg });
    }
  });

  app.patch("/api/agenda/items/:id", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const d = parseBody(req.body, true);
      const sets: any[] = [];
      const push = (col: string, v: any) => sets.push(sql`${sql.raw(col)} = ${v}`);
      for (const [k, v] of Object.entries(d)) push(k, v);
      if (!sets.length) return res.status(400).json({ message: "Nada para alterar" });
      sets.push(sql`updated_at = now()`);
      const r: any = await db.execute(sql`
        UPDATE personal_agenda_items SET ${sql.join(sets, sql`, `)}
        WHERE id = ${req.params.id} AND user_id = ${uid}
        RETURNING *`);
      if (!r.rows?.length) return res.status(404).json({ message: "Evento não encontrado" });
      res.json(rowOut(r.rows[0]));
    } catch (e: any) {
      const msg = e?.message || "Erro ao salvar evento";
      res.status(/obrigat|inválid/i.test(msg) ? 400 : 500).json({ message: msg });
    }
  });

  app.delete("/api/agenda/items/:id", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const r: any = await db.execute(sql`
        DELETE FROM personal_agenda_items WHERE id = ${req.params.id} AND user_id = ${uid} RETURNING id`);
      if (!r.rows?.length) return res.status(404).json({ message: "Evento não encontrado" });
      res.json({ ok: true, id: req.params.id });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Erro ao excluir" });
    }
  });
}
