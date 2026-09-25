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
// 🐛 21/set/2026: "presencial_virtual" existe no formulário do vendedor (ChangeRequestControl)
// desde jul/2026, mas nunca esteve nesta lista — o tipo era descartado no filtro abaixo e a
// solicitação SÓ de modalidade caía em "Selecione ao menos um tipo de alteração.".
const VALID_TYPES = new Set(["periodicidade", "dia_rota", "area_vendas", "presencial_virtual", "inicio_atendimento", "inativar", "dia_sobrecarregado", "outro"]);
// 'agenda_dia' nao e' um cadastro: e' uma CELULA do quadro da Agenda da Carteira
// (vendedor|canal|dia da semana) que passou do teto de clientes por dia.
const VALID_ENTITY = new Set(["customer", "lead", "repescagem", "agenda_dia"]);
const VALID_RESOLUTION = new Set(["efetuadas", "parcial", "rejeitadas", "lido"]);

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
  // 🏷️ kind: 'solicitacao' = pedido do vendedor a resolver; 'report' = registro do vendedor
  // no card (não-venda, justificativa, atendimento virtual, desfecho de lead) que o admin só lê.
  `ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS kind varchar NOT NULL DEFAULT 'solicitacao';`,
  // No máximo UMA solicitação pendente por entidade — mas SÓ para kind='solicitacao'. Reports
  // podem coexistir (vários por card) e não colidem com uma solicitação real. Substitui o índice
  // antigo (sem escopo de kind) pelo escopado.
  `DROP INDEX IF EXISTS ux_cr_pending;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_cr_pending_sol ON change_requests (entity_type, entity_id) WHERE status = 'pending' AND kind = 'solicitacao';`,
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
  inicio_atendimento: "Início de atendimento", inativar: "Inativar",
  dia_sobrecarregado: "Dia sobrecarregado", outro: "Outro",
};
const RESOLUTION_LABEL: Record<string, string> = {
  efetuadas: "Alterações efetuadas", parcial: "Alterações efetuadas parcialmente", rejeitadas: "Alterações rejeitadas",
  lido: "Report lido",
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
    else if (t === "dia_sobrecarregado" && d.outro) parts.push(String(d.outro));
    else if (t === "outro" && d.outro) parts.push(`Outro: ${d.outro}`);
    else parts.push(TYPE_LABEL_SRV[t] || t);
  }
  return parts.join("; ");
}
function newMsgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
// 🗑️ Pendência removida pelo admin: mensagem admin kind='pendencia_removida' DEPOIS da última
// réplica encerra a pendência (some do box da rota, do selo no card e da trava do Fechar Rota)
// sem apagar o report nem a conversa. Uma NOVA réplica do admin reabre normalmente.
const pendenciaRemovida = (msgs: any[], lastAdminReply: number) =>
  msgs.some((m: any, i: number) => i > lastAdminReply && m && m.role === "admin" && m.kind === "pendencia_removida");
function mkMsg(role: "seller" | "admin", u: any, text: string, kind: string, extra?: any) {
  return {
    id: newMsgId(), role, by: u?.id || null, byName: userName(u),
    text: String(text || "").slice(0, 4000), at: new Date().toISOString(), kind, ...(extra || {}),
  };
}

const mapRow = (r: any) => ({
  id: r.id,
  kind: r.kind || "solicitacao",
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

// 🗂️ REPORT → INBOX. Registra no Inbox (change_requests, kind='report') um "report" que o
// vendedor fez no card da Rota do Dia (não-venda, justificativa, atendimento virtual, desfecho
// de lead). REGRA: só entra no Inbox se o vendedor ESCREVEU algo na caixa de texto (texto não
// vazio) — motivo/opção sozinho não gera report. Best-effort: nunca deixa a ação principal falhar.
const REPORT_KIND_LABEL: Record<string, string> = {
  nao_venda: "Não-venda",
  justificativa: "Justificativa de não-visita",
  debito: "Prestação de contas (débito)",
  atendimento_virtual: "Atendimento virtual",
  lead_desfecho: "Desfecho de lead",
};
export async function registrarReportInbox(p: {
  entityType: "customer" | "lead";
  entityId: string;
  customerId?: string | null;
  sellerId?: string | null;
  sellerName?: string | null;
  reportKind: string;      // 'nao_venda' | 'justificativa' | 'debito' | 'atendimento_virtual' | 'lead_desfecho'
  motivo?: string | null;  // rótulo do motivo/opção selecionada
  texto: string;           // observação escrita (obrigatória — só cria se tiver conteúdo)
}): Promise<void> {
  try {
    const texto = String(p?.texto || "").trim();
    if (!texto) return; // ➜ só vai pro Inbox se o vendedor escreveu algo
    if (!p?.entityId) return;
    await ensureTables();
    // Descobre nomes (cliente/lead e vendedor) quando não vieram prontos.
    let entityName: string | null = null;
    try {
      if (p.entityType === "customer") {
        const cr = rowsOf(await db.execute(sql`SELECT fantasy_name, name FROM customers WHERE id = ${p.customerId || p.entityId} LIMIT 1`));
        entityName = cr[0]?.fantasy_name || cr[0]?.name || null;
      } else {
        const lr = rowsOf(await db.execute(sql`SELECT fantasy_name FROM leads WHERE id = ${p.entityId} LIMIT 1`));
        entityName = lr[0]?.fantasy_name || null;
      }
    } catch {}
    let sellerName: string | null = p.sellerName ? String(p.sellerName).slice(0, 200) : null;
    try {
      if (!sellerName && p.sellerId) {
        const ur = rowsOf(await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${p.sellerId} LIMIT 1`));
        const u = ur[0];
        if (u) sellerName = (((u.first_name || "") + " " + (u.last_name || "")).trim() || (u.email ? String(u.email).split("@")[0] : "")) || null;
      }
    } catch {}
    const motivoLabel = p.motivo ? String(p.motivo).slice(0, 200) : "";
    const catLabel = REPORT_KIND_LABEL[p.reportKind] || "Report";
    const details = { reportKind: p.reportKind, reportLabel: catLabel, motivo: motivoLabel, texto: texto.slice(0, 4000) };
    const seedMsg = {
      id: newMsgId(), role: "seller", by: p.sellerId || null, byName: sellerName || "Vendedor",
      text: ((motivoLabel ? motivoLabel + " — " : "") + texto).slice(0, 4000),
      at: new Date().toISOString(), kind: "report",
    };
    await db.execute(sql`
      INSERT INTO change_requests
        (entity_type, entity_id, customer_id, entity_name, seller_id, seller_name,
         types, details, status, kind, requested_by, requested_by_name, messages)
      VALUES
        (${p.entityType}, ${p.entityId}, ${p.customerId || null}, ${entityName}, ${p.sellerId || null}, ${sellerName},
         ${JSON.stringify([])}::jsonb, ${JSON.stringify(details)}::jsonb, 'pending', 'report', ${p.sellerId || null}, ${sellerName},
         ${JSON.stringify([seedMsg])}::jsonb)`);
  } catch (e: any) {
    console.warn("[REPORT-INBOX] falha ao registrar report:", e?.message);
  }
}

// 🗂️ SOLICITAÇÃO → INBOX. Cria uma SOLICITAÇÃO DE ALTERAÇÃO real (kind='solicitacao', tipo "Outro"
// com o texto do atendimento) que cai nas Pendentes do Inbox do admin. Usada quando o vendedor
// registra um atendimento virtual com a flag "Solicitação de Alteração". Best-effort: respeita o
// índice único (1 pendente por cliente) e nunca derruba a ação principal.
export async function criarSolicitacaoInbox(p: {
  entityType: "customer" | "lead";
  entityId: string;
  customerId?: string | null;
  sellerId?: string | null;
  sellerName?: string | null;
  texto: string;
}): Promise<void> {
  try {
    const texto = String(p?.texto || "").trim();
    if (!texto || !p?.entityId) return;
    await ensureTables();
    // Já existe uma solicitação pendente para esta entidade? Não duplica (respeita ux_cr_pending_sol).
    const existing = rowsOf(await db.execute(sql`
      SELECT id FROM change_requests
      WHERE entity_type = ${p.entityType} AND entity_id = ${p.entityId}
        AND status = 'pending' AND kind = 'solicitacao' LIMIT 1`));
    if (existing.length > 0) return;
    let entityName: string | null = null;
    try {
      if (p.entityType === "customer") {
        const cr = rowsOf(await db.execute(sql`SELECT fantasy_name, name FROM customers WHERE id = ${p.customerId || p.entityId} LIMIT 1`));
        entityName = cr[0]?.fantasy_name || cr[0]?.name || null;
      } else {
        const lr = rowsOf(await db.execute(sql`SELECT fantasy_name FROM leads WHERE id = ${p.entityId} LIMIT 1`));
        entityName = lr[0]?.fantasy_name || null;
      }
    } catch {}
    let sellerName: string | null = p.sellerName ? String(p.sellerName).slice(0, 200) : null;
    try {
      if (!sellerName && p.sellerId) {
        const ur = rowsOf(await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${p.sellerId} LIMIT 1`));
        const u = ur[0];
        if (u) sellerName = (((u.first_name || "") + " " + (u.last_name || "")).trim() || (u.email ? String(u.email).split("@")[0] : "")) || null;
      }
    } catch {}
    const details = { outro: texto.slice(0, 4000) };
    const seedMsg = {
      id: newMsgId(), role: "seller", by: p.sellerId || null, byName: sellerName || "Vendedor",
      text: texto.slice(0, 4000), at: new Date().toISOString(), kind: "request",
    };
    try {
      await db.execute(sql`
        INSERT INTO change_requests
          (entity_type, entity_id, customer_id, entity_name, seller_id, seller_name,
           types, details, status, kind, requested_by, requested_by_name, messages)
        VALUES
          (${p.entityType}, ${p.entityId}, ${p.customerId || null}, ${entityName}, ${p.sellerId || null}, ${sellerName},
           ${JSON.stringify(["outro"])}::jsonb, ${JSON.stringify(details)}::jsonb, 'pending', 'solicitacao', ${p.sellerId || null}, ${sellerName},
           ${JSON.stringify([seedMsg])}::jsonb)`);
    } catch (e: any) {
      if (!String(e?.message || "").includes("ux_cr_pending")) throw e; // conflito de pendência = ok, ignora
    }
  } catch (e: any) {
    console.warn("[SOLIC-INBOX] falha ao criar solicitação:", e?.message);
  }
}

// 🔔 Pendências do Inbox do vendedor (usado pelo box da Rota do Dia e pela trava do Fechar Rota):
// reports/solicitações com réplica do admin (kind='reply') ainda sem resposta do vendedor e não
// removidas pelo admin. `respondidasHoje` = respondidas em `date` (linha verde no box).
export async function listarPendenciasInbox(sellerId: string, date: string): Promise<{ pendentes: any[]; respondidasHoje: any[] }> {
  await ensureTables();
  const diaBRT = (iso: string) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(iso)); } catch { return ""; } };
  const rows = rowsOf(await db.execute(sql`
    SELECT * FROM change_requests
    WHERE (seller_id = ${sellerId} OR requested_by = ${sellerId})
      AND kind IN ('report', 'solicitacao') AND status <> 'cancelled'
      AND created_at >= now() - interval '90 days'
    ORDER BY created_at DESC LIMIT 300`));
  const pendentes: any[] = [];
  const respondidasHoje: any[] = [];
  for (const r of rows) {
    const msgs = (Array.isArray(r.messages) ? r.messages : []).filter((m: any) => m && m.kind !== "whatsapp");
    let lastAdminReply = -1;
    for (let i = 0; i < msgs.length; i++) if (msgs[i].role === "admin" && msgs[i].kind === "reply") lastAdminReply = i;
    if (lastAdminReply < 0) continue;
    if (pendenciaRemovida(msgs, lastAdminReply)) continue; // excluída pelo admin
    let answeredAt: string | null = null;
    for (let i = lastAdminReply + 1; i < msgs.length; i++) if (msgs[i].role === "seller") { answeredAt = msgs[i].at || null; break; }
    const base = { ...mapRow(r), messages: msgs, adminReplyAt: msgs[lastAdminReply].at || null };
    if (!answeredAt) pendentes.push({ ...base, pendingReply: true });
    else if (answeredAt && diaBRT(answeredAt) === date) respondidasHoje.push({ ...base, answeredAt });
  }
  return { pendentes, respondidasHoje };
}

// 💰 PREVISÃO DE PAGAMENTO — cron diário (07:00 BRT, chamado pelo scheduler).
// Reports cuja `details.previsaoPagamento` chegou (hoje ou atrasada) e que ainda não foram
// avisados: lança uma réplica automática do sistema (kind='reply') — o card entra no box
// "Pendências do Inbox" da Rota do Dia do vendedor e trava o Fechar Rota até ele responder —
// e, para vendedor EXTERNO (role vendedor / seller_type vendedor_*), manda WhatsApp no celular.
// Telemarketing fica só com a bandeira no sistema. Idempotente: grava `previsaoAvisadaEm`.
export async function avisarPrevisoesPagamento(): Promise<{ avisados: number; whatsapp: number }> {
  let avisados = 0, whatsapp = 0;
  try {
    await ensureTables();
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM change_requests
      WHERE (details->>'previsaoPagamento') IS NOT NULL
        AND (details->>'previsaoPagamento') <= ${hoje}
        AND (details->>'previsaoAvisadaEm') IS NULL
      ORDER BY created_at DESC LIMIT 200`));
    for (const r of rows) {
      try {
        const d: any = r.details || {};
        const prev = String(d.previsaoPagamento || "");
        const dataBR = prev.split("-").reverse().join("/");
        const cliente = r.entity_name || r.entity_id;
        const texto = `💰 Hoje é a data que ${cliente} prometeu pagar (${dataBR}). Faça a cobrança e responda aqui o que o cliente disse.`;
        const msg = {
          id: newMsgId(), role: "admin", by: null, byName: "Integra (automático)",
          text: texto, at: new Date().toISOString(), kind: "reply", previsaoPagamento: prev,
        };
        d.previsaoAvisadaEm = new Date().toISOString();
        await db.execute(sql`
          UPDATE change_requests
          SET details = ${JSON.stringify(d)}::jsonb,
              messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb,
              status = CASE WHEN kind = 'report' THEN 'pending' ELSE status END
          WHERE id = ${r.id}`);
        avisados++;

        // Vendedor externo → WhatsApp no celular dele. Telemarketing → só a bandeira.
        const sid = r.seller_id || r.requested_by;
        if (!sid) continue;
        const ur = rowsOf(await db.execute(sql`SELECT phone, role, seller_type FROM users WHERE id = ${sid} LIMIT 1`));
        const usr = ur[0];
        if (!usr) continue;
        const externo = String(usr.role || "") === "vendedor" && String(usr.seller_type || "") !== "telemarketing";
        const fone = String(usr.phone || "").replace(/\D/g, "");
        if (!externo || !fone) continue;
        const { enviarInterno } = await import("./envio-texto");
        const linhas = [
          `💰 *Cobrança de hoje — ${cliente}*`,
          `O cliente prometeu pagar em *${dataBR}*.`,
          d.texto ? `_Seu registro: ${String(d.texto).trim()}_` : "",
          "Faça a cobrança e responda a pendência na sua Rota do Dia.",
        ].filter(Boolean);
        const env = await enviarInterno(fone, linhas.join("\n"));
        if (env?.success) whatsapp++;
        else console.warn("[PREVISAO-PGTO] WhatsApp falhou:", env?.error);
      } catch (e: any) { console.warn("[PREVISAO-PGTO] item falhou:", e?.message); }
    }
    if (avisados) console.log(`[PREVISAO-PGTO] ${avisados} aviso(s), ${whatsapp} por WhatsApp.`);
  } catch (e: any) { console.error("[PREVISAO-PGTO] cron falhou:", e?.message); }
  return { avisados, whatsapp };
}

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
    if (types.includes("presencial_virtual") && inD.modalidade) {
      if (!["presencial", "virtual"].includes(String(inD.modalidade)))
        return res.status(400).json({ error: "Modalidade inválida." });
      details.modalidade = String(inD.modalidade);
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
    const mapped = rows.map(mapRow);
    // 📲 Enriquece cada card: telefone (cliente/lead) + flag de REPESCAGEM (assignment pendente).
    try {
      const custIds = Array.from(new Set(mapped.filter((m: any) => m.entityType === "customer").map((m: any) => m.customerId || m.entityId).filter(Boolean)));
      const leadIds = Array.from(new Set(mapped.filter((m: any) => m.entityType === "lead").map((m: any) => m.entityId).filter(Boolean)));
      const phoneByKey = new Map<string, string>();
      const cityByKey = new Map<string, string>();
      const bairroByKey = new Map<string, string>();
      const lastOrderByKey = new Map<string, string>();
      const repescagemSet = new Set<string>();
      if (custIds.length) {
        const inCust = sql.join((custIds as string[]).map((id) => sql`${id}`), sql`, `);
        const cr = rowsOf(await db.execute(sql`SELECT id, phone, city, neighborhood FROM customers WHERE id IN (${inCust})`));
        for (const c of cr) {
          if (c.phone) phoneByKey.set("customer:" + c.id, String(c.phone));
          if (c.city) cityByKey.set("customer:" + c.id, String(c.city));
          if (c.neighborhood) bairroByKey.set("customer:" + c.id, String(c.neighborhood));
        }
        // Repescagem: cliente com atribuição de repescagem PENDENTE.
        const rp = rowsOf(await db.execute(sql`SELECT DISTINCT customer_id FROM repescagem_assignments WHERE status = 'pending' AND customer_id IN (${inCust})`));
        for (const r of rp) if (r.customer_id) repescagemSet.add(String(r.customer_id));
        // 🛒 Última compra (18/set/2026): mesma fonte do resto do sistema — último item do
        // billing_pipeline com nota fiscal atribuída (faturado→entregue), por cliente.
        try {
          const lo = rowsOf(await db.execute(sql`
            SELECT customer_id, MAX(created_at) AS ultima
            FROM billing_pipeline
            WHERE invoice_number IS NOT NULL AND invoice_number <> '' AND customer_id IN (${inCust})
            GROUP BY customer_id`));
          for (const r of lo) if (r.customer_id && r.ultima) lastOrderByKey.set("customer:" + r.customer_id, new Date(r.ultima).toISOString());
        } catch (_e: any) { console.warn("[INBOX] ultima compra:", _e?.message); }
      }
      if (leadIds.length) {
        const lr = rowsOf(await db.execute(sql`SELECT id, phone, city, neighborhood FROM leads WHERE id IN (${sql.join((leadIds as string[]).map((id) => sql`${id}`), sql`, `)})`));
        for (const l of lr) {
          if (l.phone) phoneByKey.set("lead:" + l.id, String(l.phone));
          if (l.city) cityByKey.set("lead:" + l.id, String(l.city));
          if (l.neighborhood) bairroByKey.set("lead:" + l.id, String(l.neighborhood));
        }
      }
      for (const m of mapped as any[]) {
        const key = m.entityType === "customer" ? "customer:" + (m.customerId || m.entityId) : m.entityType + ":" + m.entityId;
        m.phone = phoneByKey.get(key) || null;
        m.city = cityByKey.get(key) || null;
        m.neighborhood = bairroByKey.get(key) || null;
        m.lastOrderAt = lastOrderByKey.get(key) || null;
        m.isRepescagem = m.entityType === "customer" && repescagemSet.has(String(m.customerId || m.entityId));
      }
    } catch { /* enriquecimento opcional — nunca quebra a listagem */ }
    res.json({ pendingCount: cnt[0]?.n || 0, requests: mapped });
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
      AND kind = 'solicitacao'
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
  // GET /api/change-requests/report-states?keys=customer:ID,lead:ID
  //   Mapa { "entityType:entityId": <último report c/ RÉPLICA do admin> } para o
  //   vendedor ver a resposta do admin no card do atendimento (Rota do Dia) e
  //   responder de volta. Só retorna reports (kind='report') que já têm ao menos
  //   uma mensagem do admin — senão não há nada para o vendedor ver.
  // --------------------------------------------------------------------------
  app.get("/api/change-requests/report-states", authenticateUser, safe(async (req, res) => {
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
    const uniqIds = Array.from(new Set(ids));
    const inList = sql.join(uniqIds.map((id) => sql`${id}`), sql`, `);
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM change_requests
      WHERE entity_id IN (${inList}) AND kind = 'report'
      ORDER BY created_at DESC`));
    const out: Record<string, any> = {};
    for (const r of rows) {
      const key = r.entity_type + ":" + r.entity_id;
      if (!wanted.has(key) || out[key]) continue;
      // Registro de "Envio Whatsapp" (kind='whatsapp') é só trilha do admin — não conta como
      // réplica ao vendedor nem entra na conversa que ele vê no card.
      const msgs = (Array.isArray(r.messages) ? r.messages : []).filter((m: any) => m && m.kind !== "whatsapp");
      const hasAdminReply = msgs.some((m: any) => m && m.role === "admin");
      if (!hasAdminReply) continue; // só interessa ao vendedor quando o admin respondeu
      { let lr = -1; msgs.forEach((m: any, i: number) => { if (m.role === "admin" && m.kind === "reply") lr = i; }); if (lr >= 0 && pendenciaRemovida(msgs, lr)) continue; }
      const last = msgs[msgs.length - 1] || {};
      out[key] = { ...mapRow(r), messages: msgs, hasAdminReply, lastRole: last.role || null };
    }
    return res.json(out);
  }));

  // --------------------------------------------------------------------------
  // GET /api/change-requests/pending-replies?keys=customer:ID,lead:ID
  //   Para o VENDEDOR: mapa { "type:id": <report/solicitação> } dos cadastros cujo
  //   ADMIN deixou uma RÉPLICA (mensagem kind='reply') ainda NÃO RESPONDIDA pelo
  //   vendedor. Usado no Fechar Rota para EXIGIR resposta antes de fechar o dia.
  //   Considera reports E solicitações; avalia a mais recente por cadastro.
  //   "Respondida" = existe mensagem do vendedor (role='seller') após a última
  //   réplica do admin. Resoluções ("lido"/efetuadas…) NÃO contam como réplica.
  // --------------------------------------------------------------------------
  app.get("/api/change-requests/pending-replies", authenticateUser, safe(async (req, res) => {
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
    const uniqIds = Array.from(new Set(ids));
    const inList = sql.join(uniqIds.map((id) => sql`${id}`), sql`, `);
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM change_requests
      WHERE entity_id IN (${inList}) AND kind IN ('report', 'solicitacao') AND status <> 'cancelled'
      ORDER BY created_at DESC`));
    const out: Record<string, any> = {};
    const seen = new Set<string>();
    for (const r of rows) {
      const key = r.entity_type + ":" + r.entity_id;
      if (!wanted.has(key) || seen.has(key)) continue;
      seen.add(key); // avalia SOMENTE a solicitação/report mais recente do cadastro
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      let lastAdminReply = -1;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m && m.role === "admin" && m.kind === "reply") lastAdminReply = i;
      }
      if (lastAdminReply < 0) continue; // sem réplica do admin
      if (pendenciaRemovida(msgs, lastAdminReply)) continue; // excluída pelo admin → não trava
      let answered = false;
      for (let i = lastAdminReply + 1; i < msgs.length; i++) {
        if (msgs[i] && msgs[i].role === "seller") { answered = true; break; }
      }
      if (answered) continue; // vendedor já respondeu → não trava
      out[key] = { ...mapRow(r), pendingReply: true };
    }
    return res.json(out);
  }));

  // --------------------------------------------------------------------------
  // GET /api/change-requests/inbox-pendencias?sellerId=ID&date=YYYY-MM-DD
  //   Box "Pendências do Inbox" da Rota do Dia (16/set/2026). Para o VENDEDOR: todos os seus
  //   reports/solicitações em que o ADMIN deixou uma RÉPLICA (mensagem kind='reply') que ele
  //   ainda NÃO respondeu — independentemente de o cliente estar na rota de hoje ou de a rota
  //   do dia do report já ter sido fechada. O cliente filtra os que já estão nos cards da rota
  //   (esses seguem com o selo "Resposta do admin" no próprio card).
  //   - pendentes:       réplica do admin sem resposta do vendedor
  //   - respondidasHoje: respondidas pelo vendedor em `date` (linha verde no box)
  //   Só comunicação: não cria parada, não conta como cliente e não trava o Fechar Rota.
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // POST /api/change-requests/:id/atribuir-vendedor — 23/set/2026.
  //   Cards abertos pelo SISTEMA (cadastro incompleto etc.) não têm vendedor: o admin escolhe
  //   para quem mandar. A réplica cai na Rota do Dia desse vendedor como qualquer outra e,
  //   opcionalmente, o cliente é REZONEADO para ele (troca o vendedor do cadastro).
  //   body: { sellerId, sellerName?, texto, rezonear?: boolean }
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/:id/atribuir-vendedor", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const id = String(req.params.id);
    const b = req.body || {};
    const sellerId = String(b.sellerId || "").trim();
    const texto = String(b.texto || "").trim();
    const rezonear = b.rezonear === true;
    if (!sellerId) return res.status(400).json({ error: "Escolha o vendedor." });
    if (!texto) return res.status(400).json({ error: "Escreva a mensagem ao vendedor." });

    const cur = rowsOf(await db.execute(sql`SELECT * FROM change_requests WHERE id = ${id} LIMIT 1`));
    if (cur.length === 0) return res.status(404).json({ error: "Solicitação não encontrada." });
    const row = cur[0];

    // Nome do vendedor: o que veio do cliente ou o do cadastro.
    let sellerName = b.sellerName ? String(b.sellerName).slice(0, 200) : "";
    try {
      if (!sellerName) {
        const ur = rowsOf(await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${sellerId} LIMIT 1`));
        const usr = ur[0];
        if (usr) sellerName = ((`${usr.first_name || ""} ${usr.last_name || ""}`).trim() || String(usr.email || "").split("@")[0]) || "";
      }
    } catch {}

    // 🔁 Rezoneamento opcional: troca o vendedor do cadastro (mesmo caminho da migração de
    // carteira da repescagem — regenera agenda e deixa trilha na auditoria do cliente).
    let rezoneado = false;
    if (rezonear && row.entity_type === "customer") {
      const cid = row.customer_id || row.entity_id;
      try {
        const { storage } = await import("./storage");
        const before: any = await storage.getCustomer(cid);
        if (before && before.sellerId !== sellerId) {
          await storage.updateCustomer(cid, { sellerId });
          rezoneado = true;
          try {
            const { logCustomerChanges } = await import("./customerAudit");
            await logCustomerChanges({
              customerId: cid, before, changes: { sellerId },
              actor: { id: u?.id, name: userName(u) }, source: "inbox-replica-sistema",
            });
          } catch {}
        }
      } catch (e: any) { console.warn("[INBOX-ATRIBUIR] rezoneamento falhou:", e?.message); }
    }

    const msg = mkMsg("admin", u, texto, "reply", { paraVendedor: sellerId, rezoneado });
    const nota = rezoneado
      ? mkMsg("admin", u, `Cliente rezoneado para ${sellerName || "o vendedor escolhido"}.`, "rezoneamento", { sellerId })
      : null;
    const novas = nota ? [nota, msg] : [msg];
    const updated = rowsOf(await db.execute(sql`
      UPDATE change_requests
      SET seller_id = ${sellerId}, seller_name = ${sellerName || null}, status = 'pending',
          messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify(novas)}::jsonb
      WHERE id = ${id}
      RETURNING *`));
    res.json({ ok: true, rezoneado, sellerId, sellerName, request: mapRow(updated[0]) });
  }));

  // --------------------------------------------------------------------------
  // POST /api/change-requests/:id/previsao-pagamento — admin registra (ou limpa) a data em que
  //   o cliente prometeu pagar. Na data, o cron das 07:00 lança uma réplica automática no card:
  //   ela vira pendência na Rota do Dia do vendedor (bandeira + trava do Fechar Rota) e, para
  //   vendedor externo, sai também um WhatsApp para o celular dele.
  //   body: { data: "YYYY-MM-DD" | null }
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/:id/previsao-pagamento", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const id = String(req.params.id);
    const raw = String((req.body || {}).data || "").trim();
    const data = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
    if (raw && !data) return res.status(400).json({ error: "Data inválida." });
    const cur = rowsOf(await db.execute(sql`SELECT * FROM change_requests WHERE id = ${id} LIMIT 1`));
    if (cur.length === 0) return res.status(404).json({ error: "Solicitação não encontrada." });

    const d: any = cur[0].details || {};
    if (data) { d.previsaoPagamento = data; delete d.previsaoAvisadaEm; }
    else { delete d.previsaoPagamento; delete d.previsaoAvisadaEm; }
    const texto = data
      ? `Previsão de pagamento registrada para ${data.split("-").reverse().join("/")}. O vendedor será avisado no dia.`
      : "Previsão de pagamento removida.";
    const msg = mkMsg("admin", u, texto, "previsao_pagamento", { previsao: data || null });
    const updated = rowsOf(await db.execute(sql`
      UPDATE change_requests
      SET details = ${JSON.stringify(d)}::jsonb,
          messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb
      WHERE id = ${id}
      RETURNING *`));
    res.json(mapRow(updated[0]));
  }));

  // --------------------------------------------------------------------------
  // POST /api/change-requests/:id/remover-pendencia — admin exclui o card de pendência da
  //   Rota do Dia do vendedor (só a pendência: report, conversa e histórico ficam).
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/:id/remover-pendencia", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const id = String(req.params.id);
    const cur = rowsOf(await db.execute(sql`SELECT id FROM change_requests WHERE id = ${id} LIMIT 1`));
    if (cur.length === 0) return res.status(404).json({ error: "Solicitação não encontrada." });
    const msg = mkMsg("admin", u, "Pendência removida da rota pelo admin.", "pendencia_removida");
    const updated = rowsOf(await db.execute(sql`
      UPDATE change_requests
      SET messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb
      WHERE id = ${id}
      RETURNING *`));
    res.json(mapRow(updated[0]));
  }));

  app.get("/api/change-requests/inbox-pendencias", authenticateUser, safe(async (req, res) => {
    const u = (req as any).currentUser;
    const isGestor = ["admin", "coordinator", "administrative"].includes(String(u?.role || ""));
    let sellerId = String(req.query.sellerId || "").trim();
    if (!isGestor || !sellerId) sellerId = String(u?.id || "");
    if (!sellerId) return res.json({ pendentes: [], respondidasHoje: [] });
    const dateQ = String(req.query.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const { pendentes, respondidasHoje } = await listarPendenciasInbox(sellerId, date);
    res.json({ sellerId, date, pendentes, respondidasHoje });
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
  // POST /api/change-requests/:id/whatsapp — "Envio Whatsapp" do card de REPORT do Inbox.
  //   Monta um recorte do report (cliente, tipo, motivo, observação do vendedor, quem e quando)
  //   e envia pelo WhatsApp da Honest (enviarInterno: cadeia 2630 → 7169 → 1841) SOMENTE para o
  //   número de "DÉBITOS - Inbox de Informações": (62) 99451-1997 — fixo no código.
  //   O envio fica registrado na conversa do card (kind 'whatsapp'),
  //   sem mudar o status do report.
  // --------------------------------------------------------------------------
  app.post("/api/change-requests/:id/whatsapp", authenticateUser, requireRole(["admin"]), safe(async (req, res) => {
    await ensureTables();
    const u = (req as any).currentUser;
    const id = String(req.params.id);
    const cur = rowsOf(await db.execute(sql`SELECT * FROM change_requests WHERE id = ${id} LIMIT 1`));
    if (cur.length === 0) return res.status(404).json({ error: "Solicitação não encontrada." });
    const row = cur[0];

    // 25/set/2026: destino FIXO no código — o recorte vai SOMENTE para o WhatsApp
    // (62) 99451-1997 ("DÉBITOS - Inbox de Informações"). A chave system_settings
    // 'inbox_whatsapp_destino' deixou de ser lida de propósito, para não haver risco de o
    // envio cair em outro número por configuração.
    const destino = "5562994511997";

    const d: any = row.details || {};
    const extra = String((req.body || {}).extra || "").trim().slice(0, 1000);
    const quando = new Date(row.created_at || Date.now()).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    // Bairro/cidade não ficam em change_requests: vêm do cadastro (cliente ou lead), como na listagem.
    let local = "";
    try {
      const tbl = row.entity_type === "lead" ? sql`leads` : sql`customers`;
      const cid = row.customer_id || row.entity_id;
      const c = rowsOf(await db.execute(sql`SELECT city, neighborhood FROM ${tbl} WHERE id = ${cid} LIMIT 1`));
      local = [c[0]?.neighborhood, c[0]?.city].filter(Boolean).join(" · ");
    } catch {}
    const ehReport = (row.kind || "solicitacao") === "report";
    const resumo = ehReport ? "" : summarizeRequest(Array.isArray(row.types) ? row.types : [], d);
    const linhas: string[] = [];
    linhas.push(ehReport
      ? `📋 *Report do Inbox — ${d.reportLabel || "Registro"}*`
      : `📋 *Solicitação do Inbox*`);
    linhas.push(`*Cliente:* ${row.entity_name || row.entity_id}${local ? " (" + local + ")" : ""}`);
    if (d.motivo) linhas.push(`*Motivo:* ${d.motivo}`);
    if (resumo) linhas.push(`*Pedido:* ${resumo}`);
    if (d.texto) linhas.push(`*Observação do vendedor:*\n${String(d.texto).trim()}`);
    else if (d.outro && !resumo.includes(String(d.outro))) linhas.push(`*Observação:*\n${String(d.outro).trim()}`);
    linhas.push(`*Origem:* ${row.seller_name || row.requested_by_name || "—"} · ${quando}`);
    if (extra) linhas.push(`*Obs. do admin:* ${extra}`);
    linhas.push(`_Integra 2.0 — enviado por ${userName(u)}_`);
    const texto = linhas.join("\n");

    const { enviarInterno } = await import("./envio-texto");
    const r = await enviarInterno(destino, texto);
    if (!r?.success) {
      const { explicaFalha } = await import("./envio-texto");
      console.warn(`[INBOX-WHATSAPP] falhou id=${id} destino=${destino}: ${r?.error}`, r?.tentativas);
      return res.status(502).json({ error: "Não foi possível enviar: " + explicaFalha(r?.error || "", r?.via || destino), tentativas: r?.tentativas });
    }
    const msg = mkMsg("admin", u, `Enviado por WhatsApp para +${destino} (via ${r.via || "Honest"}).`, "whatsapp", { destino, via: r.via || null, messageId: r.messageId || null });
    const updated = rowsOf(await db.execute(sql`
      UPDATE change_requests
      SET messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb
      WHERE id = ${id}
      RETURNING *`));
    console.log(`[INBOX-WHATSAPP] id=${id} destino=${destino} via=${r.via} por=${userName(u)}`);
    res.json({ ok: true, destino, via: r.via, request: mapRow(updated[0]) });
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

    // 🔁 Tréplica do vendedor (18/set/2026): quando o VENDEDOR responde um REPORT que o admin já
    // fechou ("lido"), o card VOLTA para as Pendentes do Inbox com a conversa inteira — o admin
    // precisa ver a resposta. Solicitações resolvidas seguem o fluxo de "resend" (reabrir), que
    // respeita a trava de 1 pendente por cadastro.
    const reabrirReport = role === "seller" && (row.kind || "solicitacao") === "report" && row.status !== "pending" && !resend;

    const msg = mkMsg(role, u, text || "Solicitação reenviada para nova análise.", resend ? "resend" : "reply");
    let updated;
    try {
      if (resend || reabrirReport) {
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
    const m = src.match(/^data:([^,]*?);base64,(.*)$/);
    if (!m) return res.status(400).json({ error: "formato de áudio inválido" });
    const mt = m[1];
    // (set/2026) MediaRecorder do Chrome grava "audio/webm;codecs=opus": usa o mime BASE p/ o File.
    const baseMt = (mt.split(";")[0] || "audio/webm").trim();
    const buffer = Buffer.from(m[2], "base64");
    if (!buffer.length) return res.status(400).json({ error: "áudio vazio" });
    const ext = /webm/.test(mt) ? "webm" : /ogg|opus/.test(mt) ? "ogg" : /mpeg|mp3/.test(mt) ? "mp3" : /wav/.test(mt) ? "wav" : /m4a|mp4|aac/.test(mt) ? "m4a" : "webm";
    const mod: any = await import("openai");
    const OpenAI = mod.default || mod.OpenAI || mod;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const fileArg = typeof mod.toFile === "function"
      ? await mod.toFile(buffer, `audio.${ext}`, { type: baseMt })
      : new File([buffer], `audio.${ext}`, { type: baseMt });
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
