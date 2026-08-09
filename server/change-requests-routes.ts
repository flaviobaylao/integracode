// =============================================================================
//  INTEGRA 2.0 — Solicitações de Alteração (inbox de Administração)
//  server/change-requests-routes.ts — registrar em server/index.ts:
//      import { registerChangeRequestsRoutes } from "./change-requests-routes";
//      registerChangeRequestsRoutes(app);
//
//  Fluxo: qualquer usuário abre "Solicitar Alteração" num card (presencial,
//  virtual, repescagem ou lead). A solicitação cai numa caixa de entrada que só
//  o Admin vê. O Admin faz as alterações manualmente no sistema e fecha a tarefa
//  com Efetuadas / Parcial / Rejeitadas. O resultado volta a aparecer no card.
//
//  AUTOSSUFICIENTE: ensureTables() cria a tabela no boot (o build de produção
//  NÃO roda db:push). Todo handler é async + try/catch (nunca derruba o processo).
//  Fase 1: sem áudio (o campo "Outro" é texto). Áudio transcrito entra na Fase 2.
// =============================================================================
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : Array.isArray(r) ? r : []);

const safe = (fn: (req: Request, res: Response) => Promise<any>) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      console.error("[solicitacoes-alteracao] erro na rota:", req.method, req.path, e?.message, e?.stack);
      if (!res.headersSent) res.status(500).json({ error: e?.message || "erro interno" });
    }
  };

// Tipos válidos de alteração e status.
const VALID_TYPES = new Set(["periodicidade", "dia_rota", "area_vendas", "inicio_atendimento", "inativar", "outro"]);
const VALID_ENTITY = new Set(["customer", "lead", "repescagem"]);
const VALID_RESOLUTION = new Set(["efetuadas", "parcial", "rejeitadas"]);

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS change_requests (
     id                 varchar PRIMARY KEY DEFAULT gen_random_uuid(),
     entity_type        varchar NOT NULL,
     entity_id          varchar NOT NULL,
     customer_id        varchar,
     entity_name        varchar,
     seller_id          varchar,
     seller_name        varchar,
     types              jsonb NOT NULL DEFAULT '[]'::jsonb,
     details            jsonb NOT NULL DEFAULT '{}'::jsonb,
     status             varchar NOT NULL DEFAULT 'pending',
     requested_by       varchar,
     requested_by_name  varchar,
     resolved_by        varchar,
     resolved_by_name   varchar,
     resolution_note    text,
     created_at         timestamptz DEFAULT now(),
     resolved_at        timestamptz
   );`,
  `CREATE INDEX IF NOT EXISTS idx_cr_entity ON change_requests (entity_type, entity_id);`,
  `CREATE INDEX IF NOT EXISTS idx_cr_status ON change_requests (status);`,
  `CREATE INDEX IF NOT EXISTS idx_cr_created ON change_requests (created_at DESC);`,
  // No máximo UMA solicitação pendente por entidade (bloqueia duplicadas no mesmo card).
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_cr_pending ON change_requests (entity_type, entity_id) WHERE status = 'pending';`,
  // 💬 Histórico de conversa (vendedor ⇄ admin) — mensagens da solicitação.
  `ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS messages jsonb NOT NULL DEFAULT '[]'::jsonb;`,
];

let _tablesReady: Promise<void> | null = null;
export function ensureTables(): Promise<void> {
  if (_tablesReady) return _tablesReady;
  _tablesReady = (async () => {
    for (const stmt of DDL) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (e: any) {
        console.error("[solicitacoes-alteracao] ensureTables stmt falhou:", e?.message);
      }
    }
    console.log("[solicitacoes-alteracao] ensureTables: tabela verificada/criada.");
  })();
  return _tablesReady;
}

const userName = (u: any): string => {
  const n = ((u?.firstName || "") + " " + (u?.lastName || "")).trim();
  return n || (u?.email ? String(u.email).split("@")[0] : "") || "Usuário";
};

// 💬 Conversa: rótulos e helpers para montar as mensagens do histórico.
const TYPE_LABEL_SRV: Record<string, string> = {
  periodicidade: "Periodicidade", dia_rota: "Dia de Rota", area_vendas: "Área de vendas",
  presencial_virtual: "Presencial/Virtual",
  inicio_atendimento: "Início de atendimento", inativar: "Inativar", outro: "Outro",
};
const RESOLUTION_LABEL: Record<string, string> = {
  efetuadas: "Alterações efetuadas", parcial: "Alterações efetuadas parcialmente", rejeitadas: "Alterações rejeitadas",
};
function summarizeRequest(types: string[], details: any): string {
  const d = details || {};
  const parts: string[] = [];
  for (const t of (types || [])) {
    if (t === "periodicidade" && d.periodicidade) parts.push(`Periodicidade → ${d.periodicidade}`);
    else if (t === "dia_rota" && Array.isArray(d.diaRota) && d.diaRota.length) parts.push(`Dia de Rota → ${d.diaRota.join(", ")}`);
    else if (t === "area_vendas" && d.areaVendas) parts.push(`Área de vendas → ${d.areaVendas}`);
    else if (t === "presencial_virtual" && d.modalidade) parts.push(`Modalidade → ${d.modalidade === "virtual" ? "Virtual" : "Presencial"}`);
    else if (t === "inicio_atendimento" && d.inicioAtendimento) parts.push(`Início de atendimento → ${d.inicioAtendimento}`);
    else if (t === "outro" && d.outro) parts.push(`Outro: ${d.outro}`);
    else parts.push(TYPE_LABEL_SRV[t] || t);
  }
  return parts.join("; ");
}
function newMsgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function mkMsg(role: "seller" | "admin", u: any, text: string, kind: string, extra?: any) {
  return {
    id: newMsgId(), role, by: u?.id || null, byName: userName(u),
    text: String(text || "").slice(0, 4000), at: new Date().toISOString(), kind, ...(extra || {}),
  };
}

const mapRow = (r: any) => ({
  id: r.id,
  entityType: r.entity_type,
  entityId: r.entity_id,
  customerId: r.customer_id,
  entityName: r.entity_name,
  sellerId: r.seller_id,
  sellerName: r.seller_name,
  types: r.types || [],
  details: r.details || {},
  status: r.status,
  requestedBy: r.requested_by,
  requestedByName: r.requested_by_name,
  resolvedBy: r.resolved_by,
  resolvedByName: r.resolved_by_name,
  resolutionNote: r.resolution_note,
  messages: Array.isArray(r.messages) ? r.messages : [],
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

export function registerChangeRequestsRoutes(app: Express) {
  void ensureTables();

  // --------------------------------------------------------------------------
  // POST /api/change-requests — cria uma solicitação (qualquer usuário logado).
  // --------------------------------------------------------------------------
  app.post("/api/change-requests", authenticateUser, safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const b = req.body || {};
    const entityType = String(b.entityType || "").trim();
    const entityId = String(b.entityId || "").trim();
    if (!VALID_ENTITY.has(entityType)) return res.status(400).json({ error: "entityType inválido" });
    if (!entityId) return res.status(400).json({ error: "entityId obrigatório" });

    const types: string[] = Array.isArray(b.types) ? b.types.filter((t: any) => VALID_TYPES.has(String(t))) : [];
    if (types.length === 0) return res.status(400).json({ error: "Selecione ao menos um tipo de alteração." });

    // Normaliza os detalhes só dos tipos marcados.
    const inD = b.details || {};
    const details: any = {};
    if (types.includes("periodicidade") && inD.periodicidade) {
      if (!["mensal", "quinzenal", "semanal"].includes(String(inD.periodicidade)))
        return res.status(400).json({ error: "Periodicidade inválida." });
      details.periodicidade = String(inD.periodicidade);
    }
    if (types.includes("dia_rota")) {
      const dias = Array.isArray(inD.diaRota) ? inD.diaRota.map((d: any) => String(d)).filter(Boolean) : [];
      details.diaRota = dias;
    }
    if (types.includes("area_vendas") && inD.areaVendas) {
      if (!["interno", "externo"].includes(String(inD.areaVendas)))
        return res.status(400).json({ error: "Área de vendas inválida." });
      details.areaVendas = String(inD.areaVendas);
    }
    if (types.includes("inicio_atendimento") && inD.inicioAtendimento) {
      details.inicioAtendimento = String(inD.inicioAtendimento);
    }
    if (types.includes("outro") && inD.outro) {
      details.outro = String(inD.outro).slice(0, 4000);
    }

    // Já existe pendente para esta entidade? (o índice único também protege)
    const existing = rowsOf(await db.execute(sql`
      SELECT * FROM change_requests
      WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND status = 'pending'
      LIMIT 1`));
    if (existing.length > 0) {
      return res.status(409).json({ error: "Já existe uma solicitação pendente para este cadastro.", existing: mapRow(existing[0]) });
    }

    const entityName = b.entityName ? String(b.entityName).slice(0, 300) : null;
    const customerId = b.customerId ? String(b.customerId) : null;
    const sellerId = b.sellerId ? String(b.sellerId) : null;
    const sellerName = b.sellerName ? String(b.sellerName).slice(0, 200) : null;

    // 💬 Primeira mensagem do histórico: a própria solicitação (do vendedor).
    const seedMsg = mkMsg("seller", u, summarizeRequest(types, details) || "Solicitação de alteração", "request");
    const messages = [seedMsg];

    let inserted;
    try {
      inserted = rowsOf(await db.execute(sql`
        INSERT INTO change_requests
          (entity_type, entity_id, customer_id, entity_name, seller_id, seller_name,
           types, details, status, requested_by, requested_by_name, messages)
        VALUES
          (${entityType}, ${entityId}, ${customerId}, ${entityName}, ${sellerId}, ${sellerName},
           ${JSON.stringify(types)}::jsonb, ${JSON.stringify(details)}::jsonb, 'pending', ${u?.id || null}, ${userName(u)},
           ${JSON.stringify(messages)}::jsonb)
        RETURNING *`));
    } catch (e: any) {
      // Corrida com o índice único parcial → tratar como "já existe pendente".
      if (String(e?.message || "").includes("ux_cr_pending")) {
        return res.status(409).json({ error: "Já existe uma solicitação pendente para este cadastro." });
      }
      throw e;
    }
    res.json(mapRow(inserted[0]));
  }));

  // --------------------------------------------------------------------------
  // GET /api/change-requests — inbox (admin). ?status=pending|resolved|all
  // --------------------------------------------------------------------------
  app.get("/api/change-requests", authenticateUser, requireRole(["admin"]), safe(async (req, res) => {
    await ensureTables();
    const status = String(req.query.status || "pending");
    let rows;
    if (status === "pending") {
      rows = rowsOf(await db.execute(sql`SELECT * FROM change_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 500`));
    } else if (status === "resolved") {
      rows = rowsOf(await db.execute(sql`SELECT * FROM change_requests WHERE status <> 'pending' ORDER BY resolved_at DESC NULLS LAST, created_at DESC LIMIT 500`));
    } else {
      rows = rowsOf(await db.execute(sql`SELECT * FROM change_requests ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 500`));
    }
    // Contagem de pendentes (para o badge do menu).
    const cnt = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM change_requests WHERE status = 'pending'`));
    res.json({ pendingCount: cnt[0]?.n || 0, requests: rows.map(mapRow) });
  }));

  // --------------------------------------------------------------------------
  // GET /api/change-requests/states?keys=customer:ID,lead:ID,repescagem:ID
  //   Retorna o mapa { "entityType:entityId": <última solicitação> } para os
  //   cards decidirem o que mostrar (botão / selo pendente / selo de resultado).
  // --------------------------------------------------------------------------
  app.get("/api/change-requests/states", authenticateUser, safe(async (req, res) => {
    await ensureTables();
    const raw = String(req.query.keys || "").trim();
    if (!raw) return res.json({});
    const wanted = new Set<string>();
    const ids: string[] = [];
    for (const p of raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 800)) {
      const idx = p.indexOf(":");
      if (idx <= 0) continue;
      const t = p.slice(0, idx);
      const id = p.slice(idx + 1);
      if (!VALID_ENTITY.has(t) || !id) continue;
      wanted.add(t + ":" + id);
      ids.push(id);
    }
    if (ids.length === 0) return res.json({});
    // Busca por entity_id (ANY) e casa o par exato entity_type:entity_id no JS.
    // Linhas ordenadas por created_at DESC → a primeira vista de cada chave é a mais recente.
    const uniqIds = Array.from(new Set(ids));
    const inList = sql.join(uniqIds.map((id) => sql`${id}`), sql`, `);
    // Escopo por dia (item 2): quando ?date=YYYY-MM-DD é enviado, só considera solicitações
    // criadas naquele dia (BRT). Assim uma "Efetuada" de ontem não espelha na rota de hoje.
    const dq = String(req.query.date || "").replace(/[^0-9-]/g, "");
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dq);
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM change_requests
      WHERE entity_id IN (${inList})
      ${dateOk ? sql`AND to_char(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') = ${dq}` : sql``}
      ORDER BY created_at DESC`));
    const out: Record<string, any> = {};
    for (const r of rows) {
      const key = r.entity_type + ":" + r.entity_id;
      if (!wanted.has(key) || out[key]) continue;
      out[key] = mapRow(r);
    }
    return res.json(out);
  }));

  // --------------------------------------------------------------------------
  // POST /api/change-requests/:id/resolve — admin fecha a tarefa.
  //   body: { status: 'efetuadas'|'parcial'|'rejeitadas', note?: string }
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/:id/resolve", authenticateUser, requireRole(["admin"]), safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const id = String(req.params.id);
    const status = String((req.body || {}).status || "");
    if (!VALID_RESOLUTION.has(status)) return res.status(400).json({ error: "status de resolução inválido" });
    const note = (req.body || {}).note ? String((req.body || {}).note).slice(0, 2000) : null;
    // 💬 Anexa a resposta do admin ao histórico (texto = observação; senão o rótulo do resultado).
    const adminMsg = mkMsg("admin", u, note || RESOLUTION_LABEL[status] || status, "resolution", { status });
    const updated = rowsOf(await db.execute(sql`
      UPDATE change_requests
      SET status = ${status}, resolution_note = ${note},
          resolved_by = ${u?.id || null}, resolved_by_name = ${userName(u)}, resolved_at = now(),
          messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([adminMsg])}::jsonb
      WHERE id = ${id}
      RETURNING *`));
    if (updated.length === 0) return res.status(404).json({ error: "Solicitação não encontrada." });
    res.json(mapRow(updated[0]));
  }));

  // --------------------------------------------------------------------------
  // POST /api/change-requests/:id/cancel — admin: CANCELA/REABRE uma solicitação já
  //   resolvida (efetuadas/parcial/rejeitadas), devolvendo o CARD ao estado normal e
  //   UTILIZÁVEL (deixa de ficar cinza/travado). Registra no histórico. (30/jul/2026)
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/:id/cancel", authenticateUser, requireRole(["admin"]), safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const id = String(req.params.id);
    const note = (req.body || {}).note ? String((req.body || {}).note).slice(0, 2000) : null;
    const msg = mkMsg("admin", u, note || "Solicitação cancelada — card reabilitado.", "cancel");
    const updated = rowsOf(await db.execute(sql`
      UPDATE change_requests
      SET status = 'cancelled',
          resolved_by = ${u?.id || null}, resolved_by_name = ${userName(u)}, resolved_at = now(),
          messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb
      WHERE id = ${id}
      RETURNING *`));
    if (updated.length === 0) return res.status(404).json({ error: "Solicitação não encontrada." });
    res.json(mapRow(updated[0]));
  }));

  // --------------------------------------------------------------------------
  // POST /api/change-requests/:id/reply — mensagem no histórico (vendedor ⇄ admin).
  //   body: { text: string, resend?: boolean }
  //   - Qualquer usuário logado pode responder (papel = admin | seller).
  //   - resend=true (retorno do vendedor): REABRE a solicitação para 'pending'
  //     (volta à caixa do admin), preservando toda a conversa.
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/:id/reply", authenticateUser, safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const id = String(req.params.id);
    const text = String((req.body || {}).text || "").trim();
    const resend = (req.body || {}).resend === true;
    if (!text && !resend) return res.status(400).json({ error: "Escreva uma mensagem." });
    const role: "admin" | "seller" = (u?.role === "admin") ? "admin" : "seller";

    const cur = rowsOf(await db.execute(sql`SELECT * FROM change_requests WHERE id = ${id} LIMIT 1`));
    if (cur.length === 0) return res.status(404).json({ error: "Solicitação não encontrada." });
    const row = cur[0];

    // Reabrir para pending exige que não haja OUTRA pendente para a mesma entidade.
    if (resend && row.status !== "pending") {
      const other = rowsOf(await db.execute(sql`
        SELECT id FROM change_requests
        WHERE entity_type = ${row.entity_type} AND entity_id = ${row.entity_id}
          AND status = 'pending' AND id <> ${id} LIMIT 1`));
      if (other.length > 0) return res.status(409).json({ error: "Já existe outra solicitação pendente para este cadastro." });
    }

    const msg = mkMsg(role, u, text || "Solicitação reenviada para nova análise.", resend ? "resend" : "reply");
    let updated;
    try {
      if (resend) {
        updated = rowsOf(await db.execute(sql`
          UPDATE change_requests
          SET status = 'pending', resolved_by = NULL, resolved_by_name = NULL,
              resolution_note = NULL, resolved_at = NULL,
              messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb
          WHERE id = ${id}
          RETURNING *`));
      } else {
        updated = rowsOf(await db.execute(sql`
          UPDATE change_requests
          SET messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb
          WHERE id = ${id}
          RETURNING *`));
      }
    } catch (e: any) {
      if (String(e?.message || "").includes("ux_cr_pending"))
        return res.status(409).json({ error: "Já existe outra solicitação pendente para este cadastro." });
      throw e;
    }
    res.json(mapRow(updated[0]));
  }));

  // --------------------------------------------------------------------------
  // POST /api/change-requests/transcribe — Fase 2: transcreve áudio (Whisper) do
  //   campo "Outro". Recebe { audio: dataURL } e devolve { text }.
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/transcribe", authenticateUser, safe(async (req, res) => {
    const src = String((req.body || {}).audio || "");
    if (!src.startsWith("data:")) return res.status(400).json({ error: "áudio inválido" });
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "Transcrição indisponível (OPENAI_API_KEY não configurada)." });
    const m = src.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return res.status(400).json({ error: "formato de áudio inválido" });
    const mt = m[1];
    const buffer = Buffer.from(m[2], "base64");
    if (!buffer.length) return res.status(400).json({ error: "áudio vazio" });
    const ext = /webm/.test(mt) ? "webm" : /ogg|opus/.test(mt) ? "ogg" : /mpeg|mp3/.test(mt) ? "mp3" : /wav/.test(mt) ? "wav" : /m4a|mp4|aac/.test(mt) ? "m4a" : "webm";
    const mod: any = await import("openai");
    const OpenAI = mod.default || mod.OpenAI || mod;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const fileArg = typeof mod.toFile === "function"
      ? await mod.toFile(buffer, `audio.${ext}`, { type: mt })
      : new File([buffer], `audio.${ext}`, { type: mt });
    const resp = await client.audio.transcriptions.create({ file: fileArg, model: "whisper-1", language: "pt" });
    res.json({ text: resp && resp.text ? String(resp.text).trim() : "" });
  }));

  // --------------------------------------------------------------------------
  // GET /api/admin/clientes-reativados — VARREDURA (admin, somente leitura):
  //   clientes que foram INATIVADOS no histórico (customer_change_history:
  //   Ativo -> Não) mas que HOJE estão ATIVOS (reativados pelo sync antigo do Omie,
  //   antes do desvinculo). Serve para reinativar em lote.
  // --------------------------------------------------------------------------
  app.get("/api/admin/clientes-reativados", authenticateUser, requireRole(["admin"]), safe(async (_req, res) => {
    const rows = rowsOf(await db.execute(sql`
      SELECT c.id,
             COALESCE(NULLIF(c.fantasy_name, ''), c.name) AS nome,
             c.cpf, c.cnpj, c.omie_status, c.seller_id,
             MAX(h.created_at) AS ultima_inativacao,
             COUNT(*) AS eventos_inativacao
      FROM customers c
      JOIN customer_change_history h ON h.customer_id = c.id
      WHERE h.field = 'isActive' AND h.new_value = 'Não' AND c.is_active = true
      GROUP BY c.id, nome, c.cpf, c.cnpj, c.omie_status, c.seller_id
      ORDER BY ultima_inativacao DESC`));
    res.json({
      total: rows.length,
      clientes: rows.map((r: any) => ({
        id: r.id, nome: r.nome, cpf: r.cpf, cnpj: r.cnpj,
        omieStatus: r.omie_status, sellerId: r.seller_id,
        ultimaInativacao: r.ultima_inativacao, eventosInativacao: Number(r.eventos_inativacao) || 0,
      })),
    });
  }));
}
