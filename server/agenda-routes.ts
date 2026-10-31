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
import multer from "multer";
import { transcribeAudioSource } from "./chat-routes";

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
      // Anexos (arquivos/imagens) guardados no banco, como chat_media/photo_media
      await db.execute(sql`CREATE TABLE IF NOT EXISTS personal_agenda_files (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        item_id varchar NOT NULL,
        user_id varchar NOT NULL,
        filename varchar NOT NULL,
        mimetype varchar,
        size integer,
        data text NOT NULL,
        created_at timestamp DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_paf_item ON personal_agenda_files (item_id)`);
      // Nome dado pelo usuario a cada cor (ex.: #2a78d6 = "Visitas")
      await db.execute(sql`CREATE TABLE IF NOT EXISTS personal_agenda_color_names (
        user_id varchar NOT NULL,
        color varchar NOT NULL,
        name varchar NOT NULL,
        updated_at timestamp DEFAULT now(),
        PRIMARY KEY (user_id, color)
      )`);
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

/**
 * A coluna start_at/end_at e' `timestamp` SEM fuso e o driver devolve a string crua
 * ("2026-10-29 09:00:00"), que a tela interpreta como horario LOCAL (Brasilia).
 * Entao tudo que entra tem que ser gravado como horario-de-parede de Brasilia —
 * senao o 09:00 vira 12:00 (UTC) e cada arraste empurra o evento 3h p/ frente.
 */
const TZ_BR = "America/Sao_Paulo";
function toBrtNaive(d: Date | null | undefined): string | null {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ_BR, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .formatToParts(d).reduce((o: any, x) => { o[x.type] = x.value; return o; }, {});
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute}:${parts.second}`;
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
  // grava como horario-de-parede de Brasilia (ver toBrtNaive)
  if (has("start") || !partial) out.start_at = toBrtNaive(out.start_at);
  if (has("end") || !partial) out.end_at = toBrtNaive(out.end_at);
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
          AND start_at < ${toBrtNaive(end)}::timestamp
          AND COALESCE(end_at, start_at + interval '1 hour') > ${toBrtNaive(start)}::timestamp
          ${q ? sql`AND (lower(title) LIKE ${"%" + q + "%"} OR lower(COALESCE(location,'')) LIKE ${"%" + q + "%"} OR lower(COALESCE(description,'')) LIKE ${"%" + q + "%"})` : sql``}
        ORDER BY start_at`);
      res.json((r.rows || []).map(rowOut));
    } catch (e: any) {
      console.error("[AGENDA] list:", e);
      res.status(500).json({ message: e?.message || "Erro ao listar agenda" });
    }
  });

  // Cores ja usadas pelo usuario (vira a lista de "categorias" da lateral)
  // CLIENTES DA ROTA DO DIA no calendario (27/out/2026). Mesma regua da Rota do Dia:
  // visit_agenda (gerada pela periodicidade, dia da semana e semana do mes do cadastro e
  // regravada quando o cadastro muda) + cliente ativo, nao fornecedor/lead, ja iniciado.
  // Vendedor ve so os proprios clientes (carteira atual); admin/adm/coordenacao veem
  // todos, com filtro opcional ?sellers=id1,id2 (ids de usuario).
  const ADM_ROLES = ["admin", "administrative", "coordinator"];
  // So carteiras de vendedores externos e telemarketing. Contas de sistema/canal
  // (HOTSITE, INSTAGRAM, SISTEMA, Flavio, "Honest ...") ficam fora do calendario.
  const filtroCarteira = (a: string) => sql.raw(`${a}.role IN ('vendedor','telemarketing')
          AND COALESCE(${a}.first_name,'') || ' ' || COALESCE(${a}.last_name,'') !~* '(hotsite|instagram|sistema|flavio|fl[aá]vio|honest)'`);
  app.get("/api/agenda/clientes-rota", authenticateUser, async (req: Request, res: Response) => {
    try {
      const u: any = (req as any).currentUser || (req as any).user || null;
      if (!u?.id) { res.status(401).json({ message: "Unauthorized" }); return; }
      const adm = ADM_ROLES.includes(String(u.role || ""));
      const start = parseDate(req.query.start) || new Date(Date.now() - 7 * 86400_000);
      const end = parseDate(req.query.end) || new Date(Date.now() + 35 * 86400_000);
      if (end.getTime() - start.getTime() > 62 * 86400_000) { res.status(400).json({ message: "Período máximo de 62 dias" }); return; }
      const ini = start.toISOString().slice(0, 10), fim = end.toISOString().slice(0, 10);
      const pedidos = String(req.query.sellers || "").split(",").map((x) => x.trim()).filter(Boolean);
      const escopo: string[] = adm ? pedidos : [String(u.id)];
      const r: any = await db.execute(sql`
        SELECT DISTINCT ON (c.id, to_char(v.scheduled_date, 'YYYY-MM-DD'))
               to_char(v.scheduled_date, 'YYYY-MM-DD') AS dia,
               c.id AS customer_id,
               COALESCE(NULLIF(c.fantasy_name, ''), c.name) AS nome,
               c.city AS cidade, c.neighborhood AS bairro,
               LOWER(COALESCE(c.visit_periodicity::text, 'semanal')) AS periodicidade,
               c.semana_atendimento AS semana,
               (COALESCE(v.is_virtual, false) OR COALESCE(c.virtual_service, false)) AS virtual,
               u.id AS seller_id,
               NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS seller_nome
        FROM visit_agenda v
        JOIN customers c ON c.id = v.customer_id
        JOIN users u ON (u.id = c.seller_id OR u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(COALESCE(c.seller_id, ''), 'omie-vendor-', ''))
        WHERE v.scheduled_date::date >= ${ini}::date AND v.scheduled_date::date < ${fim}::date
          AND COALESCE(v.visit_status, 'pending') <> 'cancelled'
          AND c.is_active = true
          AND COALESCE(c.is_supplier, false) = false
          AND COALESCE(c.is_lead, false) = false
          AND (c.service_start_date IS NULL OR c.service_start_date::date <= v.scheduled_date::date)
          AND ${filtroCarteira("u")}
          ${escopo.length ? sql`AND u.id IN (${sql.join(escopo.map((x) => sql`${x}`), sql`, `)})` : sql``}
        ORDER BY c.id, to_char(v.scheduled_date, 'YYYY-MM-DD'), u.id`);
      const rows = (r.rows || []) as any[];
      rows.sort((a, b) => String(a.dia).localeCompare(String(b.dia)) || String(a.seller_nome || "").localeCompare(String(b.seller_nome || "")) || String(a.nome).localeCompare(String(b.nome)));
      res.json({ admin: adm, clientes: rows.map((x) => ({ dia: x.dia, id: x.customer_id, nome: x.nome, cidade: x.cidade || "", bairro: x.bairro || "", periodicidade: x.periodicidade, semana: x.semana ?? null, virtual: !!x.virtual, sellerId: String(x.seller_id), sellerNome: x.seller_nome || "" })) });
    } catch (e: any) {
      console.error("[AGENDA] clientes-rota:", e);
      res.status(500).json({ message: e?.message || "Erro ao listar clientes da rota" });
    }
  });

  // Vendedores para o filtro (somente admin/adm/coordenacao).
  app.get("/api/agenda/vendedores", authenticateUser, async (req: Request, res: Response) => {
    const u: any = (req as any).currentUser || (req as any).user || null;
    if (!u?.id || !ADM_ROLES.includes(String(u.role || ""))) { res.json([]); return; }
    try {
      const r: any = await db.execute(sql`
        SELECT u.id, NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS nome
        FROM users u WHERE u.is_active = true AND ${filtroCarteira("u")} ORDER BY 2`);
      res.json((r.rows || []).filter((x: any) => x.nome).map((x: any) => ({ id: String(x.id), nome: x.nome })));
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro" }); }
  });

  app.get("/api/agenda/colors", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const r: any = await db.execute(sql`
        WITH usadas AS (
          SELECT COALESCE(color, ${COR_PADRAO}) AS color, count(*)::int AS n
          FROM personal_agenda_items WHERE user_id = ${uid} GROUP BY 1
        )
        SELECT u.color, u.n, cn.name
        FROM usadas u
        LEFT JOIN personal_agenda_color_names cn ON cn.user_id = ${uid} AND cn.color = u.color
        ORDER BY u.n DESC, u.color`);
      res.json((r.rows || []).map((x: any) => ({ color: x.color, n: Number(x.n || 0), name: x.name || null })));
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Erro" });
    }
  });

  // Renomear uma cor (nome vazio apaga o apelido e volta a mostrar o codigo)
  app.put("/api/agenda/colors/:color", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const color = corValida("#" + String(req.params.color || "").replace(/^#/, ""));
      const name = String(req.body?.name ?? "").trim().slice(0, 60);
      if (!name) {
        await db.execute(sql`DELETE FROM personal_agenda_color_names WHERE user_id = ${uid} AND color = ${color}`);
        return res.json({ color, name: null });
      }
      await db.execute(sql`
        INSERT INTO personal_agenda_color_names (user_id, color, name, updated_at) VALUES (${uid}, ${color}, ${name}, now())
        ON CONFLICT (user_id, color) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`);
      res.json({ color, name });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Erro ao renomear cor" });
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

  // Audio gravado no formulario do evento -> texto (OpenAI Whisper, mesma funcao do ChatCenter)
  const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
  app.post("/api/agenda/transcribe", authenticateUser, uploadAudio.single("audio"), async (req: Request, res: Response) => {
    try {
      const f = (req as any).file as { buffer: Buffer; mimetype: string } | undefined;
      if (!f || !f.buffer?.length) return res.status(400).json({ message: "Nenhum áudio recebido" });
      if (!process.env.OPENAI_API_KEY) return res.status(503).json({ message: "Transcrição indisponível (OPENAI_API_KEY ausente)" });
      const mt = f.mimetype || "audio/webm";
      const text = await transcribeAudioSource(`data:${mt};base64,${f.buffer.toString("base64")}`, mt);
      if (!text) return res.status(422).json({ message: "Não foi possível transcrever o áudio" });
      res.json({ text });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Erro na transcrição" });
    }
  });

  // ---------- anexos ----------
  const uploadFiles = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 10 } });
  const fileOut = (f: any) => ({ id: f.id, filename: f.filename, mimetype: f.mimetype || "application/octet-stream", size: Number(f.size || 0), createdAt: f.created_at, url: `/api/agenda/files/${f.id}` });
  const donoDoItem = async (uid: string, itemId: string) => {
    const r: any = await db.execute(sql`SELECT id FROM personal_agenda_items WHERE id = ${itemId} AND user_id = ${uid}`);
    return !!r.rows?.length;
  };

  app.get("/api/agenda/items/:id/files", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      if (!(await donoDoItem(uid, req.params.id))) return res.status(404).json({ message: "Evento não encontrado" });
      const r: any = await db.execute(sql`SELECT id, filename, mimetype, size, created_at FROM personal_agenda_files WHERE item_id = ${req.params.id} ORDER BY created_at`);
      res.json((r.rows || []).map(fileOut));
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro ao listar anexos" }); }
  });

  app.post("/api/agenda/items/:id/files", authenticateUser, uploadFiles.array("files", 10), async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      if (!(await donoDoItem(uid, req.params.id))) return res.status(404).json({ message: "Evento não encontrado" });
      const files = ((req as any).files || []) as Array<{ buffer: Buffer; mimetype: string; originalname: string; size: number }>;
      if (!files.length) return res.status(400).json({ message: "Nenhum arquivo recebido" });
      const out: any[] = [];
      for (const f of files) {
        const nome = String(f.originalname || "arquivo").slice(0, 200);
        const r: any = await db.execute(sql`
          INSERT INTO personal_agenda_files (id, item_id, user_id, filename, mimetype, size, data, created_at)
          VALUES (gen_random_uuid()::text, ${req.params.id}, ${uid}, ${nome}, ${f.mimetype || "application/octet-stream"}, ${f.size}, ${f.buffer.toString("base64")}, now())
          RETURNING id, filename, mimetype, size, created_at`);
        out.push(fileOut(r.rows[0]));
      }
      res.status(201).json(out);
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro ao anexar" }); }
  });

  // Serve o arquivo (cookie same-origin acompanha <img src>/<a href>)
  app.get("/api/agenda/files/:id", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const r: any = await db.execute(sql`SELECT filename, mimetype, data FROM personal_agenda_files WHERE id = ${req.params.id} AND user_id = ${uid} LIMIT 1`);
      const row = r.rows?.[0];
      if (!row) return res.status(404).send("not found");
      const buf = Buffer.from(String(row.data), "base64");
      res.setHeader("Content-Type", row.mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(buf);
    } catch (e: any) { res.status(500).send("erro"); }
  });

  app.delete("/api/agenda/files/:id", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const r: any = await db.execute(sql`DELETE FROM personal_agenda_files WHERE id = ${req.params.id} AND user_id = ${uid} RETURNING id`);
      if (!r.rows?.length) return res.status(404).json({ message: "Anexo não encontrado" });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || "Erro ao excluir anexo" }); }
  });

  app.delete("/api/agenda/items/:id", authenticateUser, async (req: Request, res: Response) => {
    const uid = await guard(req, res); if (!uid) return;
    try {
      const r: any = await db.execute(sql`
        DELETE FROM personal_agenda_items WHERE id = ${req.params.id} AND user_id = ${uid} RETURNING id`);
      if (r.rows?.length) await db.execute(sql`DELETE FROM personal_agenda_files WHERE item_id = ${req.params.id}`).catch(() => {});
      if (!r.rows?.length) return res.status(404).json({ message: "Evento não encontrado" });
      res.json({ ok: true, id: req.params.id });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Erro ao excluir" });
    }
  });
}
