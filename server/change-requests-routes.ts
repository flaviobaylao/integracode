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
      ${dateOk ? sql`AND to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') = ${dq}` : sql``}
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

  // --------------------------------------------------------------------------
  // GET /api/admin/order-customer/:customerId — recupera o NOME/DOCUMENTO do
  // cliente preservado em pedidos/recebíveis, mesmo quando o cadastro foi removido
  // (pedidos "Cliente não encontrado"). Fonte: billing_pipeline → receivables.
  // --------------------------------------------------------------------------
  app.get("/api/admin/order-customer/:customerId", authenticateUser, requireRole(["admin"]), safe(async (req, res) => {
    const cid = String(req.params.customerId || "");
    if (!cid) return res.status(400).json({ error: "customerId obrigatório" });
    const existe = rowsOf(await db.execute(sql`SELECT id, COALESCE(NULLIF(fantasy_name,''),name) AS nome, cnpj, cpf, is_active FROM customers WHERE id = ${cid} LIMIT 1`));
    let nome: string | null = null, documento: string | null = null, fonte: string | null = null;
    const bp = rowsOf(await db.execute(sql`SELECT customer_name, customer_document FROM billing_pipeline WHERE customer_id = ${cid} AND customer_name IS NOT NULL ORDER BY created_at DESC LIMIT 1`));
    if (bp.length) { nome = bp[0].customer_name; documento = bp[0].customer_document || null; fonte = "billing_pipeline"; }
    if (!nome) {
      const rc = rowsOf(await db.execute(sql`SELECT customer_name, customer_document FROM receivables WHERE customer_id = ${cid} AND customer_name IS NOT NULL ORDER BY created_at DESC LIMIT 1`));
      if (rc.length) { nome = rc[0].customer_name; documento = rc[0].customer_document || null; fonte = "receivables"; }
    }
    res.json({
      customerId: cid,
      existeNoCadastro: existe.length > 0,
      cadastro: existe.length ? { nome: existe[0].nome, cnpj: existe[0].cnpj, cpf: existe[0].cpf, isActive: existe[0].is_active } : null,
      nomePreservado: nome,
      documentoPreservado: documento,
      fonte,
    });
  }));

  // --------------------------------------------------------------------------
  // Item 1 — Verificações automáticas no Inbox:
  //   (a) cadastros ATIVOS sem vendedor resolvível, sem dia de rota ou sem periodicidade;
  //   (b) ÓRFÃOS: pedido/recebível órfão apontando p/ cliente que não existe mais.
  // Cria change_requests do "Sistema" (dedup pelo índice ux_cr_pending).
  // --------------------------------------------------------------------------
  const SISTEMA = { id: null, firstName: "Sistema", lastName: "", email: "sistema" };
  async function criarVerificacaoSistema(opts: {
    entityId: string; entityName: string | null; sellerId: string | null; sellerName: string | null;
    types: string[]; note: string; customerId: string | null;
  }): Promise<boolean> {
    const jaTem = rowsOf(await db.execute(sql`SELECT 1 FROM change_requests WHERE entity_type='customer' AND entity_id=${opts.entityId} AND status='pending' LIMIT 1`));
    if (jaTem.length) return false;
    const types = (opts.types || []).filter((t) => VALID_TYPES.has(t));
    const details = { outro: opts.note.slice(0, 4000) };
    const seed = mkMsg("admin", SISTEMA, opts.note, "system");
    try {
      await db.execute(sql`
        INSERT INTO change_requests
          (entity_type, entity_id, customer_id, entity_name, seller_id, seller_name,
           types, details, status, requested_by, requested_by_name, messages)
        VALUES
          ('customer', ${opts.entityId}, ${opts.customerId}, ${opts.entityName}, ${opts.sellerId}, ${opts.sellerName},
           ${JSON.stringify(types.length ? types : ["outro"])}::jsonb, ${JSON.stringify(details)}::jsonb, 'pending',
           NULL, 'Sistema', ${JSON.stringify([seed])}::jsonb)`);
      return true;
    } catch (e: any) {
      if (String(e?.message || "").includes("ux_cr_pending")) return false;
      throw e;
    }
  }

  async function scanInbox(dryRun: boolean, limit: number): Promise<any> {
    await ensureTables();
    const semVendedorSql = sql`NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.seller_id OR u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(COALESCE(c.seller_id,''),'omie-vendor-',''))`;
    const semDiaSql = sql`(c.weekdays IS NULL OR btrim(c.weekdays::text) IN ('', '[]', 'null', '""'))`;
    const semPerSql = sql`(c.visit_periodicity IS NULL)`;
    // (a) cadastros incompletos
    const incompletos = rowsOf(await db.execute(sql`
      SELECT c.id, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome, c.seller_id,
             ${semDiaSql} AS sem_dia, ${semPerSql} AS sem_per, ${semVendedorSql} AS sem_vend,
             (SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM users u
               WHERE u.id = c.seller_id OR u.omie_vendor_code = c.seller_id
                  OR u.omie_vendor_code = replace(COALESCE(c.seller_id,''),'omie-vendor-','') LIMIT 1) AS vendedor
        FROM customers c
       WHERE c.is_active = true AND c.is_lead IS NOT TRUE AND c.is_supplier IS NOT TRUE AND c.is_colaborador IS NOT TRUE
         AND ( ${semDiaSql} OR ${semPerSql} OR ${semVendedorSql} )
         AND NOT EXISTS (SELECT 1 FROM change_requests cr WHERE cr.entity_type='customer' AND cr.entity_id=c.id AND cr.status='pending')
       ORDER BY c.updated_at DESC NULLS LAST
       LIMIT ${limit}`));
    // (b) órfãos: referenciados por pedido bloqueado, sales_card pendente ou recebível em aberto, mas sem cadastro
    const orfaos = rowsOf(await db.execute(sql`
      WITH refs AS (
        SELECT DISTINCT customer_id FROM blocked_orders WHERE status='blocked' AND customer_id IS NOT NULL
        UNION SELECT DISTINCT customer_id FROM sales_cards WHERE status IN ('pending','overdue') AND customer_id IS NOT NULL
        UNION SELECT DISTINCT customer_id FROM receivables WHERE customer_id IS NOT NULL AND deleted_at IS NULL AND (amount - COALESCE(amount_paid,0)) > 0
      )
      SELECT r.customer_id AS cid,
             (SELECT customer_name FROM billing_pipeline WHERE customer_id = r.customer_id AND customer_name IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS nome_bp,
             (SELECT customer_name FROM receivables WHERE customer_id = r.customer_id AND customer_name IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS nome_rc
        FROM refs r
       WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = r.customer_id)
         AND NOT EXISTS (SELECT 1 FROM change_requests cr WHERE cr.entity_type='customer' AND cr.entity_id=r.customer_id AND cr.status='pending')
       LIMIT ${limit}`));

    let criadosIncompletos = 0, criadosOrfaos = 0;
    if (!dryRun) {
      for (const c of incompletos) {
        const falta: string[] = [];
        const types: string[] = [];
        if (c.sem_vend === true) { falta.push("vendedor"); }
        if (c.sem_dia === true) { falta.push("dia de rota"); types.push("dia_rota"); }
        if (c.sem_per === true) { falta.push("periodicidade"); types.push("periodicidade"); }
        const note = `⚠️ Verificação automática: cadastro incompleto — faltando ${falta.join(", ")}. Revisar e completar.`;
        if (await criarVerificacaoSistema({ entityId: c.id, entityName: c.nome, sellerId: c.seller_id, sellerName: c.vendedor || null, types, note, customerId: c.id })) criadosIncompletos++;
      }
      for (const o of orfaos) {
        const nome = o.nome_bp || o.nome_rc || "(nome não recuperado)";
        const note = `⚠️ Cadastro ÓRFÃO: existe pedido/recebível/visita em aberto, mas o cliente não está mais cadastrado. Nome preservado: "${nome}". Regularizar (recriar cadastro ou cancelar/inativar as pendências).`;
        if (await criarVerificacaoSistema({ entityId: o.cid, entityName: nome, sellerId: null, sellerName: null, types: ["inativar"], note, customerId: o.cid })) criadosOrfaos++;
      }
    }
    return {
      dryRun,
      incompletosEncontrados: incompletos.length,
      orfaosEncontrados: orfaos.length,
      criadosIncompletos, criadosOrfaos,
      amostraIncompletos: incompletos.slice(0, 10).map((c: any) => ({ id: c.id, nome: c.nome, semDia: c.sem_dia, semPer: c.sem_per, semVend: c.sem_vend })),
      amostraOrfaos: orfaos.slice(0, 10).map((o: any) => ({ id: o.cid, nome: o.nome_bp || o.nome_rc })),
    };
  }

  app.post("/api/admin/inbox-scan", authenticateUser, requireRole(["admin"]), safe(async (req, res) => {
    const dryRun = req.body?.dryRun !== false;
    const limit = Math.min(Math.max(parseInt(String(req.body?.limit || "500"), 10) || 500, 1), 2000);
    res.json({ ok: true, ...(await scanInbox(dryRun, limit)) });
  }));

  // --------------------------------------------------------------------------
  // POST /api/admin/regularize-orphans — regulariza o PASSIVO de órfãos (cliente
  // inexistente): cancela sales_cards pendentes, rejeita pedidos bloqueados e faz
  // soft-cancel (deleted_at) dos recebíveis em aberto órfãos. dryRun por padrão.
  // Depois disso, só órfãos NOVOS voltam a ser detectados pelo scan do Inbox.
  // --------------------------------------------------------------------------
  app.post("/api/admin/regularize-orphans", authenticateUser, requireRole(["admin"]), safe(async (req, res) => {
    const dryRun = req.body?.dryRun !== false;
    const naoExiste = (col: string) => sql.raw(`NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = ${col})`);
    // contagens
    const cCards = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM sales_cards sc WHERE sc.status IN ('pending','overdue') AND sc.customer_id IS NOT NULL AND ${naoExiste("sc.customer_id")}`))[0]?.n || 0;
    const cBlocked = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM blocked_orders bo WHERE bo.status='blocked' AND bo.customer_id IS NOT NULL AND ${naoExiste("bo.customer_id")}`))[0]?.n || 0;
    const cReceb = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM receivables r WHERE r.deleted_at IS NULL AND (r.amount - COALESCE(r.amount_paid,0)) > 0 AND r.customer_id IS NOT NULL AND ${naoExiste("r.customer_id")}`))[0]?.n || 0;
    if (dryRun) return res.json({ ok: true, dryRun: true, salesCards: cCards, pedidosBloqueados: cBlocked, recebiveis: cReceb, total: cCards + cBlocked + cReceb });
    const erros: string[] = [];
    try { await db.execute(sql`UPDATE sales_cards SET status='cancelled', updated_at=now() WHERE status IN ('pending','overdue') AND customer_id IS NOT NULL AND ${naoExiste("sales_cards.customer_id")}`); } catch (e: any) { erros.push("sales_cards: " + (e?.message || e)); }
    // Pedido bloqueado órfão: o enum blocked_order_status não tem "cancelado" — como o cliente não existe, removemos o registro.
    try { await db.execute(sql`DELETE FROM blocked_orders WHERE status='blocked' AND customer_id IS NOT NULL AND ${naoExiste("blocked_orders.customer_id")}`); } catch (e: any) { erros.push("blocked_orders: " + (e?.message || e)); }
    try { await db.execute(sql`UPDATE receivables SET deleted_at=now() WHERE deleted_at IS NULL AND (amount - COALESCE(amount_paid,0)) > 0 AND customer_id IS NOT NULL AND ${naoExiste("receivables.customer_id")}`); } catch (e: any) { erros.push("receivables: " + (e?.message || e)); }
    res.json({ ok: erros.length === 0, dryRun: false, salesCardsCancelados: cCards, pedidosRemovidos: cBlocked, recebiveisSoftCancel: cReceb, total: cCards + cBlocked + cReceb, erros });
  }));

  // GET /api/admin/suppliers-sem-documento — lista os clientes marcados como
  // Fornecedor que estão SEM CNPJ/CPF (não migram por documento). Para revisão.
  app.get("/api/admin/suppliers-sem-documento", authenticateUser, requireRole(["admin"]), safe(async (_req, res) => {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, COALESCE(NULLIF(fantasy_name,''), name) AS nome, cnpj, cpf, city, phone, seller_id
        FROM customers
       WHERE is_supplier = true
         AND COALESCE(NULLIF(regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g'),''),
                      NULLIF(regexp_replace(COALESCE(cpf,''),'[^0-9]','','g'),'')) IS NULL
       ORDER BY nome`));
    res.json({ total: rows.length, clientes: rows });
  }));

  // Job periódico. No BOOT roda só em dry-run (apenas conta/loga, não cria) para
  // não inundar o Inbox num deploy; a criação real acontece a cada 6h e no endpoint manual.
  const rodarScan = (dry: boolean) => { scanInbox(dry, 1000).then((r) => console.log(`[inbox-scan] dry=${dry} incompletos=${r.incompletosEncontrados} orfaos=${r.orfaosEncontrados} criados=${r.criadosIncompletos}+${r.criadosOrfaos}`)).catch((e) => console.error("[inbox-scan] erro:", e?.message)); };
  setTimeout(() => rodarScan(true), 60_000);
  setInterval(() => rodarScan(false), 6 * 60 * 60 * 1000);
}
