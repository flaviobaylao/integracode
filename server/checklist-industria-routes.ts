// ============================================================================
// CHECK-LIST DA INDÚSTRIA + FUNCIONÁRIOS DA INDÚSTRIA — 09/set/2026
// ---------------------------------------------------------------------------
// Duas abas novas do módulo Indústria (/industria):
//   • "Check List"    — modelos de check-list (produção, despolpamento,
//                       limpeza…) e as EXECUÇÕES do dia a dia.
//   • "Funcionários"  — cadastro próprio dos funcionários da indústria
//                       (não são usuários do Integra; só são selecionados
//                       como responsáveis pelos itens do check-list).
//                       04/out/2026: + admissão, CPF, e-mail, CTPS/contrato,
//                       últimas férias e ANEXOS (documentos, ASO, ponto...).
//
// Modelo de dados (MODELO × EXECUÇÃO):
//   checklist_templates       — o modelo ("Check-list de Produção")
//   checklist_template_items  — os itens que devem ser registrados
//   checklist_runs            — uma execução do modelo (uma data/turno)
//   checklist_run_items       — os itens dessa execução: responsável,
//                               conforme/não conforme, observação, FOTO e o
//                               horário do evento.
// A execução copia (snapshot) os itens do modelo no momento em que é aberta —
// mudar o modelo depois NÃO altera execuções já feitas.
//
// FOTO (o ponto do pedido do Flavio):
//   • fonte = 'camera'  → foto tirada na hora pelo celular (input capture).
//     Data/hora do evento vêm do próprio registro (o servidor carimba
//     event_at = agora, horário de Brasília). O usuário não digita nada.
//   • fonte = 'upload'  → foto escolhida da galeria/computador. Nesse caso
//     data e hora são OBRIGATÓRIAS e informadas manualmente (event_at vem do
//     cliente); o backend recusa upload sem data/hora.
//   Uma foto por item, até 10MB, só imagem. Binário em base64 numa coluna
//   própria — a listagem NUNCA devolve a coluna photo_data (mesmo desenho dos
//   anexos de matéria-prima e dos documentos da empresa).
//
// O prefixo /api/industria já é protegido no index.ts
// (app.use('/api/industria', authenticateUser, requireRole(['admin']))), por
// isso as rotas aqui não repetem o middleware — igual a industria-routes.ts,
// raw-material-attachments-routes.ts e company-documents-routes.ts.
// ============================================================================
import type { Express } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB
const CONFORMIDADES = ["conforme", "nao_conforme", "na"]; // na = não se aplica
const RUN_STATUS = ["aberta", "concluida", "cancelada"];
const FONTES = ["camera", "upload"];
const MAX_ANEXO_BYTES = 15 * 1024 * 1024; // 15MB (igual aos documentos da empresa)
export const CATEGORIAS_ANEXO_FUNC = [
  "documentos_pessoais", // RG, CPF, CNH, comprovante de residência...
  "ctps_contrato",       // CTPS, contrato de trabalho, aditivos
  "aso",                 // atestados de saúde ocupacional
  "folha_ponto",         // folhas / espelhos de ponto
  "ferias",              // avisos e recibos de férias
  "treinamentos",        // certificados, treinamentos obrigatórios
  "outros",
];
const uploadAnexo = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ANEXO_BYTES } });

const uploadFoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES },
});

// ---------------------------------------------------------------------------
// schema (criado no boot, sem migration manual)
// ---------------------------------------------------------------------------
let schemaReady: Promise<void> | null = null;
export function ensureChecklistSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS industry_employees (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "name text NOT NULL, " +
        "role_name text, " +               // função: envasador, líder de produção...
        "registration varchar, " +         // matrícula
        "phone varchar, " +
        "instance_name varchar NOT NULL DEFAULT 'IND', " +
        "is_active boolean NOT NULL DEFAULT true, " +
        "notes text, " +
        "created_by varchar, updated_by varchar, " +
        "created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS checklist_templates (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "name text NOT NULL, " +
        "description text, " +
        "instance_name varchar NOT NULL DEFAULT 'IND', " +
        "is_active boolean NOT NULL DEFAULT true, " +
        "created_by varchar, updated_by varchar, " +
        "created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS checklist_template_items (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "template_id varchar NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE, " +
        "position integer NOT NULL DEFAULT 0, " +
        "title text NOT NULL, " +
        "description text, " +
        "requires_photo boolean NOT NULL DEFAULT false, " +
        "is_active boolean NOT NULL DEFAULT true, " +
        "created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS checklist_runs (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "template_id varchar REFERENCES checklist_templates(id) ON DELETE SET NULL, " +
        "template_name text NOT NULL, " +
        "run_date date NOT NULL, " +
        "shift varchar, " +                // turno (texto livre: manhã, tarde...)
        "instance_name varchar NOT NULL DEFAULT 'IND', " +
        "status varchar NOT NULL DEFAULT 'aberta', " +
        "notes text, " +
        "production_order_id varchar, " +  // opcional: amarra a execução a uma OP
        "closed_at timestamptz, " +
        "created_by varchar, updated_by varchar, " +
        "created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS checklist_run_items (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "run_id varchar NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE, " +
        "template_item_id varchar, " +
        "position integer NOT NULL DEFAULT 0, " +
        "title text NOT NULL, " +
        "description text, " +
        "requires_photo boolean NOT NULL DEFAULT false, " +
        "employee_id varchar REFERENCES industry_employees(id) ON DELETE SET NULL, " +
        "employee_name text, " +           // snapshot do nome no momento do registro
        "conformidade varchar, " +         // conforme | nao_conforme | na | null (pendente)
        "notes text, " +
        "event_at timestamptz, " +         // data/hora do evento (câmera=automático, upload=manual)
        "photo_source varchar, " +         // camera | upload
        "photo_name text, photo_mimetype text, photo_size integer NOT NULL DEFAULT 0, " +
        "photo_data text, " +
        "registered_by varchar, " +
        "registered_at timestamptz, " +
        "created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())"
      ));
      // Dados trabalhistas do funcionário (04/out/2026): admissão, CPF, e-mail,
      // CTPS/contrato e últimas férias. ALTER idempotente — tabela já existia.
      for (const col of [
        "admission_date date",            // data de admissão
        "cpf varchar(14)",                // só dígitos (11)
        "email varchar(160)",
        "work_card_number varchar(60)",   // nº da CTPS OU nº do contrato
        "last_vacation_date date",        // data das últimas férias
      ]) await db.execute(sql.raw(`ALTER TABLE industry_employees ADD COLUMN IF NOT EXISTS ${col}`)).catch(() => {});
      // Anexos do funcionário (cópia de documentos, ASO, folhas de ponto...).
      // Vários por funcionário; binário em base64, listagem nunca devolve `data`.
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS industry_employee_attachments (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "employee_id varchar NOT NULL REFERENCES industry_employees(id) ON DELETE CASCADE, " +
        "category varchar NOT NULL DEFAULT 'outros', " +
        "description text, " +
        "reference_date date, " +         // data a que o anexo se refere (ex.: mês da folha de ponto, data do ASO)
        "file_name text NOT NULL, mimetype text, file_size integer NOT NULL DEFAULT 0, " +
        "data text NOT NULL, " +
        "created_by varchar, created_at timestamptz DEFAULT now())"
      ));
      for (const ix of [
        "CREATE INDEX IF NOT EXISTS idx_ind_emp_attach_emp ON industry_employee_attachments (employee_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_cl_items_template ON checklist_template_items (template_id, position)",
        "CREATE INDEX IF NOT EXISTS idx_cl_runs_date ON checklist_runs (run_date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_cl_runs_template ON checklist_runs (template_id)",
        "CREATE INDEX IF NOT EXISTS idx_cl_run_items_run ON checklist_run_items (run_id, position)",
        "CREATE INDEX IF NOT EXISTS idx_industry_employees_active ON industry_employees (is_active)",
      ]) await db.execute(sql.raw(ix)).catch(() => {});
    })().catch((e: any) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function hojeBR(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function agoraISO(): string {
  return new Date().toISOString();
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

// event_at do upload manual: aceita "2026-09-09T14:30" (datetime-local),
// "2026-09-09 14:30" ou ISO completo. Sem timezone = horário de Brasília.
function parseEventAt(v: any): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const base = s.replace(" ", "T");
    const comSeg = base.length === 16 ? base + ":00" : base;
    const d = new Date(comSeg + "-03:00"); // America/Sao_Paulo (UTC-3, sem DST desde 2019)
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function podeEditar(user: any): boolean {
  return ["admin", "coordinator"].includes(user?.role || "");
}

function multerFoto(req: any, res: any, next: any) {
  uploadFoto.single("foto")(req, res, (err: any) => {
    if (err) {
      const msg = err?.code === "LIMIT_FILE_SIZE"
        ? "Foto acima de 10MB"
        : (err?.message || "Falha no upload da foto");
      return res.status(400).json({ message: msg });
    }
    next();
  });
}

function multerAnexo(req: any, res: any, next: any) {
  uploadAnexo.single("arquivo")(req, res, (err: any) => {
    if (err) {
      const msg = err?.code === "LIMIT_FILE_SIZE"
        ? "Arquivo acima de 15MB"
        : (err?.message || "Falha no upload do anexo");
      return res.status(400).json({ message: msg });
    }
    next();
  });
}

// CPF: guarda só dígitos; valida tamanho e dígitos verificadores.
// Devolve { ok, value } — value = null quando vazio (campo opcional).
function normalizarCpf(v: any): { ok: boolean; value: string | null } {
  const d = String(v ?? "").replace(/\D/g, "");
  if (!d) return { ok: true, value: null };
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return { ok: false, value: null };
  const dv = (base: string, peso: number) => {
    let soma = 0;
    for (const c of base) soma += Number(c) * peso--;
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  if (dv(d.slice(0, 9), 10) !== Number(d[9]) || dv(d.slice(0, 10), 11) !== Number(d[10])) return { ok: false, value: null };
  return { ok: true, value: d };
}

function emailOuNull(v: any): { ok: boolean; value: string | null } {
  const s = String(v ?? "").trim().toLowerCase().slice(0, 160);
  if (!s) return { ok: true, value: null };
  return { ok: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), value: s };
}

const COLS_EMPLOYEE = sql`id, name, role_name, registration, phone, instance_name, is_active,
  notes, admission_date, cpf, email, work_card_number, last_vacation_date, created_at, updated_at`;

function mapEmployee(row: any) {
  return {
    id: row.id,
    name: row.name,
    roleName: row.role_name || "",
    registration: row.registration || "",
    phone: row.phone || "",
    instanceName: row.instance_name || "IND",
    isActive: row.is_active !== false,
    notes: row.notes || "",
    admissionDate: toISODate(row.admission_date),
    cpf: row.cpf || "",
    email: row.email || "",
    workCardNumber: row.work_card_number || "",
    lastVacationDate: toISODate(row.last_vacation_date),
    attachmentsCount: Number(row.attachments_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAnexo(row: any) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    category: row.category || "outros",
    description: row.description || "",
    referenceDate: toISODate(row.reference_date),
    fileName: row.file_name,
    mimetype: row.mimetype || null,
    fileSize: Number(row.file_size || 0),
    createdAt: row.created_at,
    url: `/api/industria/funcionarios/${row.employee_id}/anexos/${row.id}/arquivo`,
  };
}

function mapTemplateItem(row: any) {
  return {
    id: row.id,
    templateId: row.template_id,
    position: Number(row.position || 0),
    title: row.title,
    description: row.description || "",
    requiresPhoto: row.requires_photo === true,
    isActive: row.is_active !== false,
  };
}

function mapTemplate(row: any, itens: any[] = []) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    instanceName: row.instance_name || "IND",
    isActive: row.is_active !== false,
    itens,
    totalItens: itens.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRunItem(row: any) {
  return {
    id: row.id,
    runId: row.run_id,
    templateItemId: row.template_item_id,
    position: Number(row.position || 0),
    title: row.title,
    description: row.description || "",
    requiresPhoto: row.requires_photo === true,
    employeeId: row.employee_id || null,
    employeeName: row.employee_name || "",
    conformidade: row.conformidade || null,
    notes: row.notes || "",
    eventAt: row.event_at || null,
    photoSource: row.photo_source || null,
    photoName: row.photo_name || null,
    photoMimetype: row.photo_mimetype || null,
    photoSize: Number(row.photo_size || 0),
    hasPhoto: !!row.photo_name,
    registeredAt: row.registered_at || null,
    // pendente = ainda não tem conformidade, ou exige foto e não tem
    pendente: !row.conformidade || (row.requires_photo === true && !row.photo_name),
  };
}

function resumoDosItens(itens: any[]) {
  return {
    total: itens.length,
    conformes: itens.filter((i) => i.conformidade === "conforme").length,
    naoConformes: itens.filter((i) => i.conformidade === "nao_conforme").length,
    naoAplica: itens.filter((i) => i.conformidade === "na").length,
    pendentes: itens.filter((i) => i.pendente).length,
    comFoto: itens.filter((i) => i.hasPhoto).length,
    fotosPendentes: itens.filter((i) => i.requiresPhoto && !i.hasPhoto).length,
  };
}

function mapRun(row: any, itens: any[] | null = null) {
  const base: any = {
    id: row.id,
    templateId: row.template_id,
    templateName: row.template_name,
    runDate: toISODate(row.run_date),
    shift: row.shift || "",
    instanceName: row.instance_name || "IND",
    status: row.status,
    notes: row.notes || "",
    productionOrderId: row.production_order_id || null,
    closedAt: row.closed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (itens) {
    base.itens = itens;
    base.resumo = resumoDosItens(itens);
  } else {
    base.resumo = {
      total: Number(row.total_itens || 0),
      conformes: Number(row.conformes || 0),
      naoConformes: Number(row.nao_conformes || 0),
      naoAplica: Number(row.nao_aplica || 0),
      pendentes: Number(row.pendentes || 0),
      comFoto: Number(row.com_foto || 0),
      fotosPendentes: Number(row.fotos_pendentes || 0),
    };
  }
  return base;
}

const COLS_RUN_ITEM = sql`id, run_id, template_item_id, position, title, description,
  requires_photo, employee_id, employee_name, conformidade, notes, event_at,
  photo_source, photo_name, photo_mimetype, photo_size, registered_at,
  created_at, updated_at`;

async function carregarItensDaExecucao(runId: string) {
  const r: any = await db.execute(sql`
    SELECT ${COLS_RUN_ITEM} FROM checklist_run_items
    WHERE run_id = ${runId} ORDER BY position, created_at`);
  return (r.rows || []).map(mapRunItem);
}

// ---------------------------------------------------------------------------
// rotas
// ---------------------------------------------------------------------------
export function registerChecklistIndustriaRoutes(app: Express) {
  ensureChecklistSchema().catch((e: any) =>
    console.error("[CHECKLIST-IND] schema:", e?.message || e)
  );

  // =========================================================================
  // FUNCIONÁRIOS DA INDÚSTRIA
  // =========================================================================
  app.get("/api/industria/funcionarios", async (req: any, res) => {
    try {
      await ensureChecklistSchema();
      const incluirInativos = String(req.query?.incluirInativos || "") === "1";
      const conds: any[] = [sql`true`];
      if (!incluirInativos) conds.push(sql`is_active = true`);
      const r: any = await db.execute(sql`
        SELECT e.id, e.name, e.role_name, e.registration, e.phone, e.instance_name, e.is_active,
               e.notes, e.admission_date, e.cpf, e.email, e.work_card_number, e.last_vacation_date,
               e.created_at, e.updated_at,
               (SELECT COUNT(*)::int FROM industry_employee_attachments a WHERE a.employee_id = e.id) AS attachments_count
        FROM industry_employees e
        WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY e.is_active DESC, e.name`);
      const funcionarios = (r.rows || []).map(mapEmployee);
      res.json({
        funcionarios,
        resumo: {
          total: funcionarios.length,
          ativos: funcionarios.filter((f: any) => f.isActive).length,
          inativos: funcionarios.filter((f: any) => !f.isActive).length,
        },
      });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] funcionarios listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar funcionários" });
    }
  });

  app.post("/api/industria/funcionarios", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const name = String(b.name ?? "").trim().slice(0, 200);
      if (!name) return res.status(400).json({ message: "Informe o nome do funcionário" });
      const cpf = normalizarCpf(b.cpf);
      if (!cpf.ok) return res.status(400).json({ message: "CPF inválido" });
      const email = emailOuNull(b.email);
      if (!email.ok) return res.status(400).json({ message: "E-mail inválido" });
      if (b.admissionDate && !dataOuNull(b.admissionDate)) return res.status(400).json({ message: "Data de admissão inválida" });
      if (b.lastVacationDate && !dataOuNull(b.lastVacationDate)) return res.status(400).json({ message: "Data das últimas férias inválida" });
      const r: any = await db.execute(sql`
        INSERT INTO industry_employees
          (name, role_name, registration, phone, instance_name, is_active, notes,
           admission_date, cpf, email, work_card_number, last_vacation_date,
           created_by, updated_by, updated_at)
        VALUES (${name},
                ${String(b.roleName ?? "").trim().slice(0, 120) || null},
                ${String(b.registration ?? "").trim().slice(0, 60) || null},
                ${String(b.phone ?? "").trim().slice(0, 40) || null},
                ${String(b.instanceName ?? "IND").trim().toUpperCase().slice(0, 40) || "IND"},
                ${b.isActive === false ? false : true},
                ${String(b.notes ?? "").slice(0, 2000) || null},
                ${dataOuNull(b.admissionDate)}, ${cpf.value}, ${email.value},
                ${String(b.workCardNumber ?? "").trim().slice(0, 60) || null},
                ${dataOuNull(b.lastVacationDate)},
                ${req.currentUser?.id || null}, ${req.currentUser?.id || null}, now())
        RETURNING ${COLS_EMPLOYEE}`);
      const f = mapEmployee(r.rows?.[0] || {});
      console.log(`[CHECKLIST-IND] funcionário criado: ${f.name}${f.roleName ? ` (${f.roleName})` : ""}`);
      res.json({ message: "Funcionário cadastrado", funcionario: f });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] funcionario criar:", e?.message || e);
      res.status(500).json({ message: "Falha ao cadastrar funcionário" });
    }
  });

  app.patch("/api/industria/funcionarios/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const sets: any[] = [];
      if (b.name !== undefined) {
        const name = String(b.name ?? "").trim().slice(0, 200);
        if (!name) return res.status(400).json({ message: "Informe o nome do funcionário" });
        sets.push(sql`name = ${name}`);
      }
      if (b.roleName !== undefined) sets.push(sql`role_name = ${String(b.roleName ?? "").trim().slice(0, 120) || null}`);
      if (b.registration !== undefined) sets.push(sql`registration = ${String(b.registration ?? "").trim().slice(0, 60) || null}`);
      if (b.phone !== undefined) sets.push(sql`phone = ${String(b.phone ?? "").trim().slice(0, 40) || null}`);
      if (b.instanceName !== undefined) sets.push(sql`instance_name = ${String(b.instanceName ?? "IND").trim().toUpperCase().slice(0, 40) || "IND"}`);
      if (b.isActive !== undefined) sets.push(sql`is_active = ${b.isActive === true || b.isActive === "true"}`);
      if (b.notes !== undefined) sets.push(sql`notes = ${String(b.notes ?? "").slice(0, 2000) || null}`);
      if (b.admissionDate !== undefined) {
        if (b.admissionDate && !dataOuNull(b.admissionDate)) return res.status(400).json({ message: "Data de admissão inválida" });
        sets.push(sql`admission_date = ${dataOuNull(b.admissionDate)}`);
      }
      if (b.cpf !== undefined) {
        const cpf = normalizarCpf(b.cpf);
        if (!cpf.ok) return res.status(400).json({ message: "CPF inválido" });
        sets.push(sql`cpf = ${cpf.value}`);
      }
      if (b.email !== undefined) {
        const email = emailOuNull(b.email);
        if (!email.ok) return res.status(400).json({ message: "E-mail inválido" });
        sets.push(sql`email = ${email.value}`);
      }
      if (b.workCardNumber !== undefined) sets.push(sql`work_card_number = ${String(b.workCardNumber ?? "").trim().slice(0, 60) || null}`);
      if (b.lastVacationDate !== undefined) {
        if (b.lastVacationDate && !dataOuNull(b.lastVacationDate)) return res.status(400).json({ message: "Data das últimas férias inválida" });
        sets.push(sql`last_vacation_date = ${dataOuNull(b.lastVacationDate)}`);
      }
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_by = ${req.currentUser?.id || null}`, sql`updated_at = now()`);
      const r: any = await db.execute(sql`
        UPDATE industry_employees SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id}
        RETURNING ${COLS_EMPLOYEE}`);
      if (!r.rows?.length) return res.status(404).json({ message: "Funcionário não encontrado" });
      res.json({ message: "Funcionário atualizado", funcionario: mapEmployee(r.rows[0]) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] funcionario editar:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar funcionário" });
    }
  });

  // Exclusão só se o funcionário nunca foi usado num check-list; caso contrário,
  // inativa (preserva o histórico de quem respondeu o quê).
  app.delete("/api/industria/funcionarios/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const uso: any = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM checklist_run_items WHERE employee_id = ${req.params.id}`);
      if (Number(uso.rows?.[0]?.n || 0) > 0) {
        await db.execute(sql`
          UPDATE industry_employees SET is_active = false, updated_at = now(),
            updated_by = ${req.currentUser?.id || null} WHERE id = ${req.params.id}`);
        return res.json({ message: "Funcionário já usado em check-lists — foi INATIVADO em vez de excluído", inativado: true });
      }
      await db.execute(sql`DELETE FROM industry_employees WHERE id = ${req.params.id}`);
      res.json({ message: "Funcionário removido" });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] funcionario remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover funcionário" });
    }
  });

  // -------------------------------------------------------------------------
  // ANEXOS DO FUNCIONÁRIO (04/out/2026): cópia de documentos, ASO, folhas de
  // ponto, férias, treinamentos... Vários por funcionário, até 15MB cada.
  // -------------------------------------------------------------------------
  app.get("/api/industria/funcionarios/:id/anexos", async (req: any, res) => {
    try {
      await ensureChecklistSchema();
      const r: any = await db.execute(sql`
        SELECT id, employee_id, category, description, reference_date, file_name, mimetype, file_size, created_at
        FROM industry_employee_attachments WHERE employee_id = ${req.params.id}
        ORDER BY created_at DESC`);
      res.json({ anexos: (r.rows || []).map(mapAnexo), categorias: CATEGORIAS_ANEXO_FUNC });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] anexos listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar anexos" });
    }
  });

  app.post("/api/industria/funcionarios/:id/anexos", multerAnexo, async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ message: "Selecione um arquivo" });
      const ex: any = await db.execute(sql`SELECT id FROM industry_employees WHERE id = ${req.params.id}`);
      if (!ex.rows?.length) return res.status(404).json({ message: "Funcionário não encontrado" });
      const b = req.body || {};
      const category = CATEGORIAS_ANEXO_FUNC.includes(String(b.category || "")) ? String(b.category) : "outros";
      const description = String(b.description ?? "").trim().slice(0, 300) || null;
      const referenceDate = dataOuNull(b.referenceDate);
      const r: any = await db.execute(sql`
        INSERT INTO industry_employee_attachments
          (employee_id, category, description, reference_date, file_name, mimetype, file_size, data, created_by)
        VALUES (${req.params.id}, ${category}, ${description}, ${referenceDate},
                ${(file.originalname || "anexo").slice(0, 200)}, ${file.mimetype || "application/octet-stream"},
                ${file.size}, ${file.buffer.toString("base64")}, ${req.currentUser?.id || null})
        RETURNING id, employee_id, category, description, reference_date, file_name, mimetype, file_size, created_at`);
      const anexo = mapAnexo(r.rows?.[0] || {});
      console.log(`[CHECKLIST-IND] anexo funcionário ${req.params.id}: ${anexo.fileName} (${category}, ${anexo.fileSize}B)`);
      res.json({ message: "Anexo adicionado", anexo });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] anexo criar:", e?.message || e);
      res.status(500).json({ message: "Falha ao anexar arquivo" });
    }
  });

  // Abrir/baixar. Inline por padrão; ?download=1 baixa.
  app.get("/api/industria/funcionarios/:id/anexos/:anexoId/arquivo", async (req: any, res) => {
    try {
      await ensureChecklistSchema();
      const r: any = await db.execute(sql`
        SELECT file_name, mimetype, data FROM industry_employee_attachments
        WHERE id = ${req.params.anexoId} AND employee_id = ${req.params.id}`);
      const row = r.rows?.[0];
      if (!row || !row.data) return res.status(404).json({ message: "Arquivo não encontrado" });
      const buf = Buffer.from(String(row.data), "base64");
      const disp = req.query?.download ? "attachment" : "inline";
      const nome = String(row.file_name || "anexo").replace(/["\\]/g, "");
      res.setHeader("Content-Type", String(row.mimetype || "application/octet-stream"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${disp}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(buf);
    } catch (e: any) {
      console.error("[CHECKLIST-IND] anexo arquivo:", e?.message || e);
      res.status(500).json({ message: "Falha ao ler o arquivo" });
    }
  });

  app.delete("/api/industria/funcionarios/:id/anexos/:anexoId", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      await db.execute(sql`
        DELETE FROM industry_employee_attachments WHERE id = ${req.params.anexoId} AND employee_id = ${req.params.id}`);
      res.json({ message: "Anexo removido" });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] anexo remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover anexo" });
    }
  });

  // =========================================================================
  // MODELOS DE CHECK-LIST (+ itens)
  // =========================================================================
  app.get("/api/industria/checklists", async (req: any, res) => {
    try {
      await ensureChecklistSchema();
      const incluirInativos = String(req.query?.incluirInativos || "") === "1";
      const conds: any[] = [sql`true`];
      if (!incluirInativos) conds.push(sql`is_active = true`);
      const t: any = await db.execute(sql`
        SELECT id, name, description, instance_name, is_active, created_at, updated_at
        FROM checklist_templates WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY is_active DESC, name`);
      const templates = t.rows || [];
      const i: any = await db.execute(sql`
        SELECT id, template_id, position, title, description, requires_photo, is_active
        FROM checklist_template_items WHERE is_active = true ORDER BY position, created_at`);
      const porTemplate: Record<string, any[]> = {};
      for (const row of i.rows || []) {
        (porTemplate[row.template_id] ||= []).push(mapTemplateItem(row));
      }
      const lista = templates.map((row: any) => mapTemplate(row, porTemplate[row.id] || []));
      res.json({
        checklists: lista,
        resumo: {
          total: lista.length,
          ativos: lista.filter((c: any) => c.isActive).length,
          itens: lista.reduce((s: number, c: any) => s + c.totalItens, 0),
        },
      });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] modelos listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar check-lists" });
    }
  });

  // Cria o modelo. Aceita `itens: [{title, description, requiresPhoto}]` de uma vez.
  app.post("/api/industria/checklists", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const name = String(b.name ?? "").trim().slice(0, 200);
      if (!name) return res.status(400).json({ message: "Informe o nome do check-list" });
      const r: any = await db.execute(sql`
        INSERT INTO checklist_templates (name, description, instance_name, is_active,
                                         created_by, updated_by, updated_at)
        VALUES (${name},
                ${String(b.description ?? "").slice(0, 2000) || null},
                ${String(b.instanceName ?? "IND").trim().toUpperCase().slice(0, 40) || "IND"},
                ${b.isActive === false ? false : true},
                ${req.currentUser?.id || null}, ${req.currentUser?.id || null}, now())
        RETURNING id, name, description, instance_name, is_active, created_at, updated_at`);
      const tpl = r.rows[0];
      const itens = Array.isArray(b.itens) ? b.itens : [];
      let pos = 0;
      for (const it of itens) {
        const title = String(it?.title ?? "").trim().slice(0, 300);
        if (!title) continue;
        await db.execute(sql`
          INSERT INTO checklist_template_items (template_id, position, title, description, requires_photo)
          VALUES (${tpl.id}, ${pos++}, ${title},
                  ${String(it?.description ?? "").slice(0, 1000) || null},
                  ${it?.requiresPhoto === true || it?.requiresPhoto === "true"})`);
      }
      const criados = await db.execute(sql`
        SELECT id, template_id, position, title, description, requires_photo, is_active
        FROM checklist_template_items WHERE template_id = ${tpl.id} ORDER BY position`) as any;
      console.log(`[CHECKLIST-IND] modelo criado: ${tpl.name} (${(criados.rows || []).length} itens)`);
      res.json({ message: "Check-list cadastrado", checklist: mapTemplate(tpl, (criados.rows || []).map(mapTemplateItem)) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] modelo criar:", e?.message || e);
      res.status(500).json({ message: "Falha ao cadastrar check-list" });
    }
  });

  app.patch("/api/industria/checklists/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const sets: any[] = [];
      if (b.name !== undefined) {
        const name = String(b.name ?? "").trim().slice(0, 200);
        if (!name) return res.status(400).json({ message: "Informe o nome do check-list" });
        sets.push(sql`name = ${name}`);
      }
      if (b.description !== undefined) sets.push(sql`description = ${String(b.description ?? "").slice(0, 2000) || null}`);
      if (b.instanceName !== undefined) sets.push(sql`instance_name = ${String(b.instanceName ?? "IND").trim().toUpperCase().slice(0, 40) || "IND"}`);
      if (b.isActive !== undefined) sets.push(sql`is_active = ${b.isActive === true || b.isActive === "true"}`);
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_by = ${req.currentUser?.id || null}`, sql`updated_at = now()`);
      const r: any = await db.execute(sql`
        UPDATE checklist_templates SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id}
        RETURNING id, name, description, instance_name, is_active, created_at, updated_at`);
      if (!r.rows?.length) return res.status(404).json({ message: "Check-list não encontrado" });
      const itens: any = await db.execute(sql`
        SELECT id, template_id, position, title, description, requires_photo, is_active
        FROM checklist_template_items WHERE template_id = ${req.params.id} AND is_active = true
        ORDER BY position, created_at`);
      res.json({ message: "Check-list atualizado", checklist: mapTemplate(r.rows[0], (itens.rows || []).map(mapTemplateItem)) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] modelo editar:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar check-list" });
    }
  });

  // Excluir o modelo: se já tem execuções, inativa (não apaga histórico).
  app.delete("/api/industria/checklists/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const uso: any = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM checklist_runs WHERE template_id = ${req.params.id}`);
      if (Number(uso.rows?.[0]?.n || 0) > 0) {
        await db.execute(sql`
          UPDATE checklist_templates SET is_active = false, updated_at = now(),
            updated_by = ${req.currentUser?.id || null} WHERE id = ${req.params.id}`);
        return res.json({ message: "Check-list já possui execuções — foi INATIVADO em vez de excluído", inativado: true });
      }
      await db.execute(sql`DELETE FROM checklist_templates WHERE id = ${req.params.id}`);
      res.json({ message: "Check-list removido" });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] modelo remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover check-list" });
    }
  });

  // --- itens do modelo -----------------------------------------------------
  app.post("/api/industria/checklists/:id/itens", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const title = String(b.title ?? "").trim().slice(0, 300);
      if (!title) return res.status(400).json({ message: "Informe o item do check-list" });
      const tpl: any = await db.execute(sql`SELECT id FROM checklist_templates WHERE id = ${req.params.id}`);
      if (!tpl.rows?.length) return res.status(404).json({ message: "Check-list não encontrado" });
      const p: any = await db.execute(sql`
        SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM checklist_template_items
        WHERE template_id = ${req.params.id}`);
      const r: any = await db.execute(sql`
        INSERT INTO checklist_template_items (template_id, position, title, description, requires_photo)
        VALUES (${req.params.id}, ${Number(p.rows?.[0]?.pos || 0)}, ${title},
                ${String(b.description ?? "").slice(0, 1000) || null},
                ${b.requiresPhoto === true || b.requiresPhoto === "true"})
        RETURNING id, template_id, position, title, description, requires_photo, is_active`);
      res.json({ message: "Item adicionado", item: mapTemplateItem(r.rows[0]) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] item criar:", e?.message || e);
      res.status(500).json({ message: "Falha ao adicionar item" });
    }
  });

  app.patch("/api/industria/checklists/:id/itens/:itemId", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const sets: any[] = [];
      if (b.title !== undefined) {
        const title = String(b.title ?? "").trim().slice(0, 300);
        if (!title) return res.status(400).json({ message: "Informe o item do check-list" });
        sets.push(sql`title = ${title}`);
      }
      if (b.description !== undefined) sets.push(sql`description = ${String(b.description ?? "").slice(0, 1000) || null}`);
      if (b.requiresPhoto !== undefined) sets.push(sql`requires_photo = ${b.requiresPhoto === true || b.requiresPhoto === "true"}`);
      if (b.position !== undefined) sets.push(sql`position = ${Number(b.position) || 0}`);
      if (b.isActive !== undefined) sets.push(sql`is_active = ${b.isActive === true || b.isActive === "true"}`);
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_at = now()`);
      const r: any = await db.execute(sql`
        UPDATE checklist_template_items SET ${sql.join(sets, sql`, `)}
        WHERE id = ${req.params.itemId} AND template_id = ${req.params.id}
        RETURNING id, template_id, position, title, description, requires_photo, is_active`);
      if (!r.rows?.length) return res.status(404).json({ message: "Item não encontrado" });
      res.json({ message: "Item atualizado", item: mapTemplateItem(r.rows[0]) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] item editar:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar item" });
    }
  });

  app.delete("/api/industria/checklists/:id/itens/:itemId", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      await db.execute(sql`
        DELETE FROM checklist_template_items
        WHERE id = ${req.params.itemId} AND template_id = ${req.params.id}`);
      res.json({ message: "Item removido" });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] item remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover item" });
    }
  });

  // Reordenar itens: body { ordem: [itemId, itemId, ...] }
  app.patch("/api/industria/checklists/:id/ordem", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const ordem = Array.isArray(req.body?.ordem) ? req.body.ordem : [];
      let pos = 0;
      for (const itemId of ordem) {
        await db.execute(sql`
          UPDATE checklist_template_items SET position = ${pos++}, updated_at = now()
          WHERE id = ${String(itemId)} AND template_id = ${req.params.id}`);
      }
      res.json({ message: "Ordem atualizada" });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] ordem:", e?.message || e);
      res.status(500).json({ message: "Falha ao reordenar" });
    }
  });

  // =========================================================================
  // EXECUÇÕES (o preenchimento do dia a dia)
  // =========================================================================
  // Lista com resumo agregado por execução. Filtros: ?de=&ate=&templateId=&status=
  app.get("/api/industria/checklist-execucoes", async (req: any, res) => {
    try {
      await ensureChecklistSchema();
      const de = dataOuNull(req.query?.de);
      const ate = dataOuNull(req.query?.ate);
      const templateId = String(req.query?.templateId || "").trim();
      const status = String(req.query?.status || "").trim();
      const conds: any[] = [sql`true`];
      if (de) conds.push(sql`r.run_date >= ${de}`);
      if (ate) conds.push(sql`r.run_date <= ${ate}`);
      if (templateId) conds.push(sql`r.template_id = ${templateId}`);
      if (status && RUN_STATUS.includes(status)) conds.push(sql`r.status = ${status}`);
      const r: any = await db.execute(sql`
        SELECT r.id, r.template_id, r.template_name, r.run_date, r.shift, r.instance_name,
               r.status, r.notes, r.production_order_id, r.closed_at, r.created_at, r.updated_at,
               COUNT(i.id)::int AS total_itens,
               COUNT(*) FILTER (WHERE i.conformidade = 'conforme')::int AS conformes,
               COUNT(*) FILTER (WHERE i.conformidade = 'nao_conforme')::int AS nao_conformes,
               COUNT(*) FILTER (WHERE i.conformidade = 'na')::int AS nao_aplica,
               COUNT(*) FILTER (WHERE i.conformidade IS NULL OR (i.requires_photo AND i.photo_name IS NULL))::int AS pendentes,
               COUNT(*) FILTER (WHERE i.photo_name IS NOT NULL)::int AS com_foto,
               COUNT(*) FILTER (WHERE i.requires_photo AND i.photo_name IS NULL)::int AS fotos_pendentes
        FROM checklist_runs r
        LEFT JOIN checklist_run_items i ON i.run_id = r.id
        WHERE ${sql.join(conds, sql` AND `)}
        GROUP BY r.id
        ORDER BY r.run_date DESC, r.created_at DESC
        LIMIT 500`);
      const execucoes = (r.rows || []).map((row: any) => mapRun(row));
      const hoje = hojeBR();
      res.json({
        execucoes,
        resumo: {
          total: execucoes.length,
          hoje: execucoes.filter((e: any) => e.runDate === hoje).length,
          abertas: execucoes.filter((e: any) => e.status === "aberta").length,
          concluidas: execucoes.filter((e: any) => e.status === "concluida").length,
          naoConformes: execucoes.reduce((s: number, e: any) => s + (e.resumo?.naoConformes || 0), 0),
          pendentes: execucoes.reduce((s: number, e: any) => s + (e.resumo?.pendentes || 0), 0),
        },
        hoje,
      });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] execucoes listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar execuções" });
    }
  });

  app.get("/api/industria/checklist-execucoes/:id", async (req: any, res) => {
    try {
      await ensureChecklistSchema();
      const r: any = await db.execute(sql`
        SELECT id, template_id, template_name, run_date, shift, instance_name, status,
               notes, production_order_id, closed_at, created_at, updated_at
        FROM checklist_runs WHERE id = ${req.params.id}`);
      if (!r.rows?.length) return res.status(404).json({ message: "Execução não encontrada" });
      const itens = await carregarItensDaExecucao(req.params.id);
      res.json({ execucao: mapRun(r.rows[0], itens) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] execucao abrir:", e?.message || e);
      res.status(500).json({ message: "Falha ao abrir a execução" });
    }
  });

  // Abrir execução: copia (snapshot) os itens ativos do modelo.
  app.post("/api/industria/checklist-execucoes", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const templateId = String(b.templateId ?? "").trim();
      if (!templateId) return res.status(400).json({ message: "Selecione o check-list" });
      const t: any = await db.execute(sql`
        SELECT id, name, instance_name FROM checklist_templates WHERE id = ${templateId}`);
      if (!t.rows?.length) return res.status(404).json({ message: "Check-list não encontrado" });
      const tpl = t.rows[0];
      const runDate = dataOuNull(b.runDate) || hojeBR();

      const itens: any = await db.execute(sql`
        SELECT id, position, title, description, requires_photo
        FROM checklist_template_items
        WHERE template_id = ${templateId} AND is_active = true
        ORDER BY position, created_at`);
      if (!(itens.rows || []).length) {
        return res.status(400).json({ message: "Esse check-list ainda não tem itens cadastrados" });
      }

      const r: any = await db.execute(sql`
        INSERT INTO checklist_runs (template_id, template_name, run_date, shift, instance_name,
                                    status, notes, production_order_id, created_by, updated_by, updated_at)
        VALUES (${templateId}, ${tpl.name}, ${runDate},
                ${String(b.shift ?? "").trim().slice(0, 60) || null},
                ${String(b.instanceName ?? tpl.instance_name ?? "IND").trim().toUpperCase().slice(0, 40)},
                'aberta',
                ${String(b.notes ?? "").slice(0, 2000) || null},
                ${String(b.productionOrderId ?? "").trim() || null},
                ${req.currentUser?.id || null}, ${req.currentUser?.id || null}, now())
        RETURNING id, template_id, template_name, run_date, shift, instance_name, status,
                  notes, production_order_id, closed_at, created_at, updated_at`);
      const run = r.rows[0];

      for (const it of itens.rows) {
        await db.execute(sql`
          INSERT INTO checklist_run_items (run_id, template_item_id, position, title, description, requires_photo)
          VALUES (${run.id}, ${it.id}, ${Number(it.position || 0)}, ${it.title},
                  ${it.description || null}, ${it.requires_photo === true})`);
      }
      const criados = await carregarItensDaExecucao(run.id);
      console.log(`[CHECKLIST-IND] execução aberta: ${tpl.name} em ${runDate} (${criados.length} itens)`);
      res.json({ message: "Check-list aberto", execucao: mapRun(run, criados) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] execucao criar:", e?.message || e);
      res.status(500).json({ message: "Falha ao abrir o check-list" });
    }
  });

  // Cabeçalho da execução (turno, obs., status). Concluir exige tudo respondido.
  app.patch("/api/industria/checklist-execucoes/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const atual: any = await db.execute(sql`
        SELECT id, status FROM checklist_runs WHERE id = ${req.params.id}`);
      if (!atual.rows?.length) return res.status(404).json({ message: "Execução não encontrada" });

      const sets: any[] = [];
      if (b.shift !== undefined) sets.push(sql`shift = ${String(b.shift ?? "").trim().slice(0, 60) || null}`);
      if (b.notes !== undefined) sets.push(sql`notes = ${String(b.notes ?? "").slice(0, 2000) || null}`);
      if (b.runDate !== undefined) {
        const d = dataOuNull(b.runDate);
        if (!d) return res.status(400).json({ message: "Data inválida" });
        sets.push(sql`run_date = ${d}`);
      }
      if (b.status !== undefined) {
        const status = String(b.status ?? "").trim();
        if (!RUN_STATUS.includes(status)) return res.status(400).json({ message: "Status inválido" });
        if (status === "concluida") {
          const itens = await carregarItensDaExecucao(req.params.id);
          const pend = itens.filter((i: any) => i.pendente);
          if (pend.length && String(b.forcar || "") !== "1") {
            return res.status(400).json({
              message: `Faltam ${pend.length} item(ns): responder conforme/não conforme` +
                (pend.some((i: any) => i.requiresPhoto && !i.hasPhoto) ? " e anexar as fotos obrigatórias" : ""),
              pendentes: pend.map((i: any) => i.title),
            });
          }
          sets.push(sql`closed_at = now()`);
        } else {
          sets.push(sql`closed_at = NULL`);
        }
        sets.push(sql`status = ${status}`);
      }
      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(sql`updated_by = ${req.currentUser?.id || null}`, sql`updated_at = now()`);

      const r: any = await db.execute(sql`
        UPDATE checklist_runs SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id}
        RETURNING id, template_id, template_name, run_date, shift, instance_name, status,
                  notes, production_order_id, closed_at, created_at, updated_at`);
      const itens = await carregarItensDaExecucao(req.params.id);
      res.json({ message: "Execução atualizada", execucao: mapRun(r.rows[0], itens) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] execucao editar:", e?.message || e);
      res.status(500).json({ message: "Falha ao atualizar a execução" });
    }
  });

  app.delete("/api/industria/checklist-execucoes/:id", async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      await db.execute(sql`DELETE FROM checklist_runs WHERE id = ${req.params.id}`);
      res.json({ message: "Execução removida" });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] execucao remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover a execução" });
    }
  });

  // -------------------------------------------------------------------------
  // REGISTRO DE UM ITEM (responsável, conformidade, observação e FOTO)
  // multipart: employeeId, conformidade, notes, fonte(camera|upload), eventAt, foto?
  //   fonte=camera → event_at = agora (servidor). eventAt do cliente é ignorado.
  //   fonte=upload → eventAt OBRIGATÓRIO (data e hora digitadas).
  //   removerFoto=1 → apaga a foto do item.
  // -------------------------------------------------------------------------
  app.patch("/api/industria/checklist-execucoes/:id/itens/:itemId", multerFoto, async (req: any, res) => {
    try {
      if (!podeEditar(req.currentUser)) return res.status(403).json({ message: "Access denied" });
      await ensureChecklistSchema();
      const b = req.body || {};
      const run: any = await db.execute(sql`
        SELECT id, status, template_name FROM checklist_runs WHERE id = ${req.params.id}`);
      if (!run.rows?.length) return res.status(404).json({ message: "Execução não encontrada" });
      if (run.rows[0].status === "concluida" && String(b.reabrir || "") !== "1") {
        return res.status(400).json({ message: "Check-list já concluído — reabra para editar" });
      }
      const item: any = await db.execute(sql`
        SELECT id, requires_photo, photo_name FROM checklist_run_items
        WHERE id = ${req.params.itemId} AND run_id = ${req.params.id}`);
      if (!item.rows?.length) return res.status(404).json({ message: "Item não encontrado" });

      const sets: any[] = [];
      const file = req.file as Express.Multer.File | undefined;

      // responsável (snapshot do nome)
      if (b.employeeId !== undefined) {
        const empId = String(b.employeeId ?? "").trim();
        if (!empId) {
          sets.push(sql`employee_id = NULL`, sql`employee_name = NULL`);
        } else {
          const f: any = await db.execute(sql`SELECT id, name FROM industry_employees WHERE id = ${empId}`);
          if (!f.rows?.length) return res.status(400).json({ message: "Funcionário não encontrado" });
          sets.push(sql`employee_id = ${empId}`, sql`employee_name = ${f.rows[0].name}`);
        }
      }

      // conformidade
      if (b.conformidade !== undefined) {
        const c = String(b.conformidade ?? "").trim();
        if (c && !CONFORMIDADES.includes(c)) return res.status(400).json({ message: "Conformidade inválida" });
        sets.push(sql`conformidade = ${c || null}`);
      }

      if (b.notes !== undefined) sets.push(sql`notes = ${String(b.notes ?? "").slice(0, 2000) || null}`);

      // foto + data/hora do evento
      if (file) {
        if (!String(file.mimetype || "").startsWith("image/")) {
          return res.status(400).json({ message: "Envie um arquivo de imagem" });
        }
        const fonte = String(b.fonte ?? "upload").trim();
        if (!FONTES.includes(fonte)) return res.status(400).json({ message: "Origem da foto inválida" });

        let eventAt: string | null;
        if (fonte === "camera") {
          // foto tirada na hora: data/hora do evento carimbadas pelo servidor
          eventAt = agoraISO();
        } else {
          eventAt = parseEventAt(b.eventAt);
          if (!eventAt) {
            return res.status(400).json({ message: "Foto enviada da galeria: informe a data e a hora do evento" });
          }
        }
        sets.push(
          sql`photo_name = ${(file.originalname || "foto.jpg").slice(0, 200)}`,
          sql`photo_mimetype = ${file.mimetype || "image/jpeg"}`,
          sql`photo_size = ${file.size}`,
          sql`photo_data = ${file.buffer.toString("base64")}`,
          sql`photo_source = ${fonte}`,
          sql`event_at = ${eventAt}`,
        );
      } else if (String(b.removerFoto || "") === "1") {
        sets.push(
          sql`photo_name = NULL`, sql`photo_mimetype = NULL`, sql`photo_size = 0`,
          sql`photo_data = NULL`, sql`photo_source = NULL`,
        );
      } else if (b.eventAt !== undefined) {
        // correção manual da data/hora de um item já registrado
        const ev = parseEventAt(b.eventAt);
        if (String(b.eventAt ?? "").trim() && !ev) return res.status(400).json({ message: "Data/hora do evento inválida" });
        sets.push(sql`event_at = ${ev}`);
      }

      if (!sets.length) return res.status(400).json({ message: "Nada para atualizar" });
      sets.push(
        sql`registered_by = ${req.currentUser?.id || null}`,
        sql`registered_at = now()`,
        sql`updated_at = now()`,
      );

      const r: any = await db.execute(sql`
        UPDATE checklist_run_items SET ${sql.join(sets, sql`, `)}
        WHERE id = ${req.params.itemId} AND run_id = ${req.params.id}
        RETURNING ${COLS_RUN_ITEM}`);
      const atualizado = mapRunItem(r.rows[0]);
      if (file) {
        console.log(`[CHECKLIST-IND] foto (${atualizado.photoSource}) no item "${atualizado.title}" — ${atualizado.photoSize}B, evento ${atualizado.eventAt}`);
      }
      await db.execute(sql`UPDATE checklist_runs SET updated_at = now() WHERE id = ${req.params.id}`);
      const itens = await carregarItensDaExecucao(req.params.id);
      res.json({ message: "Item registrado", item: atualizado, resumo: resumoDosItens(itens) });
    } catch (e: any) {
      console.error("[CHECKLIST-IND] item registrar:", e?.message || e);
      res.status(500).json({ message: "Falha ao registrar o item" });
    }
  });

  // Foto do item (inline; ?download=1 baixa).
  app.get("/api/industria/checklist-execucoes/:id/itens/:itemId/foto", async (req: any, res) => {
    try {
      await ensureChecklistSchema();
      const r: any = await db.execute(sql`
        SELECT photo_name, photo_mimetype, photo_data FROM checklist_run_items
        WHERE id = ${req.params.itemId} AND run_id = ${req.params.id}`);
      const row = r.rows?.[0];
      if (!row || !row.photo_data) return res.status(404).json({ message: "Foto não encontrada" });
      const buf = Buffer.from(String(row.photo_data), "base64");
      const disp = req.query?.download ? "attachment" : "inline";
      const nome = String(row.photo_name || "foto.jpg").replace(/["\\]/g, "");
      res.setHeader("Content-Type", String(row.photo_mimetype || "image/jpeg"));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Content-Disposition", `${disp}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(buf);
    } catch (e: any) {
      console.error("[CHECKLIST-IND] foto:", e?.message || e);
      res.status(500).json({ message: "Falha ao ler a foto" });
    }
  });
}
