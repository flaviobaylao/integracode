// server/degustacoes-routes.ts
// -----------------------------------------------------------------------------
// PROMOÇÃO DE DEGUSTAÇÕES (tela /degustacoes, grupo Clientes) — 19/nov/2026
//
// Processo ponta a ponta de uma degustação num cliente, pedido pelo Flavio:
//
//  1. SOLICITAÇÃO — qualquer usuário (vendedor só para a própria carteira) abre a
//     degustação: cliente, data, hora, local, quem executa (Honest ou empresa
//     terceirizada — nome/contato/telefone), materiais necessários e observações.
//  2. CHAMADO AUTOMÁTICO — ao abrir, nasce um chamado para a Lanucy (destino
//     'lanucy' dos Chamados) com tudo descrito, para ela tomar conhecimento,
//     contratar a empresa ou organizar a logística. Edição/cancelamento viram
//     mensagens no mesmo chamado.
//  3. AGENDA — o compromisso (dia, hora, local) entra na Minha Agenda de Flávio,
//     Cinthia, Lanucy e do vendedor responsável pelo cliente, com hora marcada,
//     para acompanhamento. Editar a data/hora/local atualiza as quatro agendas.
//  4. AMOSTRAS — dentro da degustação, "Criar amostras" abre o MESMO formulário de
//     venda (SaleModal) num card próprio, já como operação AMOSTRA. Ao finalizar,
//     o pedido cai no Pipeline em BLOQUEADOS (regra geral de amostra) e o motivo do
//     bloqueio leva as informações da degustação (marcador [DEGUSTAÇÃO DG-xxxx]).
//     Liberado, segue o fluxo normal de faturamento/rota.
//  5. ENCERRAMENTO — a Lanucy responde e FINALIZA o chamado com as fotos; o hook
//     em chamados-routes (aoFinalizarChamado) conclui a degustação e as fotos do
//     chamado passam a aparecer na própria degustação.
//
// Tabela própria criada sob demanda (fora do drizzle), como chamados/agenda.
// -----------------------------------------------------------------------------
import type { Express, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { storage } from "./storage";

const APP_URL = process.env.APP_URL || "https://integracode-production.up.railway.app";
const GESTAO = ["admin", "coordinator", "administrative"];
const AGENDA_KEYS = ["flavio", "cinthia", "lanucy"]; // + vendedor do cliente
const CHAMADO_DESTINO = "lanucy";
const COR_AGENDA = "#16a34a";
const MARCADOR = (n: number) => `[DEGUSTAÇÃO ${numeroFmt(n)}]`;

export const MATERIAIS_PADRAO = [
  "Mesa / balcão", "Toalha de mesa", "Copos descartáveis (50 ml)", "Guardanapos", "Caixa térmica / gelo",
  "Bandeja", "Banner / wind banner", "Display de produto", "Folder / tabela de preços", "Avental / uniforme Honest",
  "Lixeira / saco de lixo", "Extensão elétrica",
];

const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];
const numeroFmt = (n: number) => "DG-" + String(n || 0).padStart(4, "0");
const nomeDe = (u: any) => [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.email || "Usuário";
const dataBR = (d: any) => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d || ""); };
const isoDia = (d: any) => { const m = String(d instanceof Date ? d.toISOString() : d || "").match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
const hhmm = (v: any) => { const m = String(v || "").match(/^(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null; };

let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS degustacoes_numero_seq START 1`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS degustacoes (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        numero integer NOT NULL UNIQUE DEFAULT nextval('degustacoes_numero_seq'),
        customer_id varchar NOT NULL,
        seller_id varchar,
        status varchar NOT NULL DEFAULT 'aberta',
        data date NOT NULL,
        hora_inicio varchar NOT NULL,
        hora_fim varchar,
        local text,
        executor_tipo varchar NOT NULL DEFAULT 'honest',
        empresa_nome varchar,
        empresa_contato varchar,
        empresa_telefone varchar,
        responsavel_execucao varchar,
        materiais jsonb NOT NULL DEFAULT '[]'::jsonb,
        materiais_outros text,
        publico_estimado integer,
        observacoes text,
        sales_card_id varchar,
        chamado_id varchar,
        agenda_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        criado_por varchar,
        criado_por_nome varchar,
        concluida_em timestamp,
        cancelada_em timestamp,
        motivo_cancelamento text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_degustacoes_data ON degustacoes (data)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_degustacoes_card ON degustacoes (sales_card_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_degustacoes_chamado ON degustacoes (chamado_id)`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

// ---------- quem é quem ----------
async function usuariosAgenda(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  try {
    const { getDestinos } = await import("./chamados-routes");
    for (const d of await getDestinos()) out[d.key] = d.userIds;
  } catch (e: any) { console.warn("[degustacoes] destinos:", e?.message || e); }
  return out;
}
async function veTudo(u: any): Promise<boolean> {
  if (GESTAO.includes(String(u?.role || ""))) return true;
  const m = await usuariosAgenda();
  return AGENDA_KEYS.some((k) => (m[k] || []).includes(String(u?.id)));
}

// ---------- texto padrão (chamado, agenda, bloqueio) ----------
function linhasDetalhe(d: any): string[] {
  const exec = d.executor_tipo === "terceirizada"
    ? `Empresa terceirizada: ${d.empresa_nome || "(a definir)"}${d.empresa_contato ? ` — contato ${d.empresa_contato}` : ""}${d.empresa_telefone ? ` — ${d.empresa_telefone}` : ""}`
    : `Própria Honest${d.responsavel_execucao ? ` — responsável: ${d.responsavel_execucao}` : ""}`;
  const mats = [...(Array.isArray(d.materiais) ? d.materiais : []), ...(d.materiais_outros ? [d.materiais_outros] : [])];
  return [
    `Cliente: ${d.cliente_nome || d.customer_id}`,
    `Data: ${dataBR(d.data)} — ${d.hora_inicio}${d.hora_fim ? ` às ${d.hora_fim}` : ""}`,
    `Local: ${d.local || "(endereço do cliente)"}`,
    `Execução: ${exec}`,
    d.publico_estimado ? `Público estimado: ${d.publico_estimado} pessoas` : "",
    `Materiais: ${mats.length ? mats.join("; ") : "(nenhum informado)"}`,
    d.observacoes ? `Observações: ${d.observacoes}` : "",
    d.vendedor_nome ? `Vendedor responsável: ${d.vendedor_nome}` : "",
  ].filter(Boolean);
}

async function carregar(id: string): Promise<any | null> {
  await ensureTable();
  const r = rows(await db.execute(sql`
    SELECT d.*, coalesce(nullif(c.fantasy_name,''), c.name) AS cliente_nome, c.name AS cliente_razao, c.address AS cliente_endereco,
           c.city AS cliente_cidade, c.neighborhood AS cliente_bairro, c.seller_id AS cliente_seller_id,
           trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS vendedor_nome,
           sc.status AS card_status, sc.sale_value AS card_valor, sc.products AS card_produtos,
           (SELECT bo.status FROM blocked_orders bo WHERE bo.sales_card_id = d.sales_card_id ORDER BY bo.blocked_at DESC LIMIT 1) AS bloqueio_status,
           (SELECT bp.stage FROM billing_pipeline bp WHERE bp.sales_card_id = d.sales_card_id ORDER BY bp.created_at DESC LIMIT 1) AS pipeline_etapa,
           ch.numero AS chamado_numero, ch.status AS chamado_status
      FROM degustacoes d
      LEFT JOIN customers c ON c.id = d.customer_id
      LEFT JOIN users u ON u.id = d.seller_id
      LEFT JOIN sales_cards sc ON sc.id = d.sales_card_id
      LEFT JOIN chamados ch ON ch.id = d.chamado_id
     WHERE d.id = ${id}`));
  return r[0] || null;
}

function situacaoAmostra(d: any): { codigo: string; label: string } {
  if (!d.sales_card_id) return { codigo: "sem_amostra", label: "Amostra não criada" };
  if (d.pipeline_etapa) return { codigo: "pipeline", label: `No pipeline: ${d.pipeline_etapa}` };
  if (d.bloqueio_status === "blocked") return { codigo: "bloqueada", label: "Em Bloqueados — aguardando liberação" };
  if (d.bloqueio_status === "released") return { codigo: "liberada", label: "Liberada" };
  if (d.bloqueio_status) return { codigo: String(d.bloqueio_status), label: `Bloqueio: ${d.bloqueio_status}` };
  if (d.card_status === "cancelled") return { codigo: "cancelada", label: "Amostra cancelada" };
  if (d.card_status === "draft") return { codigo: "rascunho", label: "Amostra em rascunho (não finalizada)" };
  return { codigo: String(d.card_status || "rascunho"), label: "Amostra em preenchimento" };
}

function saida(d: any) {
  return {
    id: d.id, numero: d.numero, codigo: numeroFmt(d.numero), status: d.status,
    customerId: d.customer_id, clienteNome: d.cliente_nome, clienteRazao: d.cliente_razao,
    clienteEndereco: [d.cliente_endereco, d.cliente_bairro, d.cliente_cidade].filter(Boolean).join(" — "),
    sellerId: d.seller_id, vendedorNome: d.vendedor_nome || null,
    data: isoDia(d.data), horaInicio: d.hora_inicio, horaFim: d.hora_fim, local: d.local,
    executorTipo: d.executor_tipo, empresaNome: d.empresa_nome, empresaContato: d.empresa_contato, empresaTelefone: d.empresa_telefone,
    responsavelExecucao: d.responsavel_execucao, materiais: d.materiais || [], materiaisOutros: d.materiais_outros,
    publicoEstimado: d.publico_estimado, observacoes: d.observacoes,
    salesCardId: d.sales_card_id, amostra: situacaoAmostra(d), amostraValor: d.card_valor ? Number(d.card_valor) : null,
    amostraProdutos: Array.isArray(d.card_produtos) ? d.card_produtos : [],
    chamadoId: d.chamado_id, chamadoCodigo: d.chamado_numero ? "CH-" + String(d.chamado_numero).padStart(4, "0") : null, chamadoStatus: d.chamado_status || null,
    criadoPor: d.criado_por, criadoPorNome: d.criado_por_nome, concluidaEm: d.concluida_em, canceladaEm: d.cancelada_em,
    motivoCancelamento: d.motivo_cancelamento, createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

// ---------- agenda (Minha Agenda de Flávio, Cinthia, Lanucy e vendedor) ----------
function janela(d: any): { inicio: string; fim: string } {
  const dia = isoDia(d.data)!;
  const ini = hhmm(d.hora_inicio) || "09:00";
  let fim = hhmm(d.hora_fim);
  if (!fim || fim <= ini) { const [h, m] = ini.split(":").map(Number); fim = `${String(Math.min(h + 2, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`; }
  return { inicio: `${dia} ${ini}:00`, fim: `${dia} ${fim}:00` };
}
async function sincronizarAgenda(d: any): Promise<string[]> {
  const m = await usuariosAgenda();
  const alvos = new Set<string>();
  for (const k of AGENDA_KEYS) for (const id of m[k] || []) alvos.add(String(id));
  if (d.seller_id) alvos.add(String(d.seller_id));
  const { inicio, fim } = janela(d);
  const titulo = `🍹 Degustação ${numeroFmt(d.numero)} — ${d.cliente_nome || "cliente"}`.slice(0, 200);
  const descricao = [...linhasDetalhe(d), "", `Acompanhar no Integra: ${APP_URL}/degustacoes?id=${d.id}`].join("\n");
  const local = (d.local || [d.cliente_endereco, d.cliente_cidade].filter(Boolean).join(" — ") || "").slice(0, 250);
  const antigos: string[] = Array.isArray(d.agenda_ids) ? d.agenda_ids.map(String) : [];
  // linhas atuais (id + dono) para atualizar no lugar
  const atuais = antigos.length
    ? rows(await db.execute(sql`SELECT id, user_id FROM personal_agenda_items WHERE id IN (${sql.join(antigos.map((x) => sql`${x}`), sql`, `)})`))
    : [];
  const ids: string[] = [];
  for (const uid of Array.from(alvos)) {
    const ex = atuais.find((a) => String(a.user_id) === uid);
    if (ex) {
      await db.execute(sql`UPDATE personal_agenda_items SET title = ${titulo}, description = ${descricao}, start_at = ${inicio}::timestamp,
        end_at = ${fim}::timestamp, all_day = false, location = ${local}, color = ${COR_AGENDA}, fixed_time = true,
        status = ${d.status === "concluida" ? "done" : "pending"}, updated_at = now() WHERE id = ${String(ex.id)}`);
      ids.push(String(ex.id));
    } else {
      const r = rows(await db.execute(sql`INSERT INTO personal_agenda_items
          (id, user_id, kind, title, description, start_at, end_at, all_day, location, priority, status, color, fixed_time, created_at, updated_at)
        VALUES (gen_random_uuid()::text, ${uid}, 'event', ${titulo}, ${descricao}, ${inicio}::timestamp, ${fim}::timestamp, false,
          ${local}, 'high', 'pending', ${COR_AGENDA}, true, now(), now()) RETURNING id`));
      ids.push(String(r[0].id));
    }
  }
  // quem saiu da lista (ex.: troca de vendedor) perde o compromisso
  const sobras = atuais.filter((a) => !ids.includes(String(a.id))).map((a) => String(a.id));
  if (sobras.length) await db.execute(sql`DELETE FROM personal_agenda_items WHERE id IN (${sql.join(sobras.map((x) => sql`${x}`), sql`, `)})`);
  await db.execute(sql`UPDATE degustacoes SET agenda_ids = ${JSON.stringify(ids)}::jsonb WHERE id = ${d.id}`);
  return ids;
}
async function removerAgenda(d: any) {
  const ids: string[] = Array.isArray(d.agenda_ids) ? d.agenda_ids.map(String) : [];
  if (ids.length) await db.execute(sql`DELETE FROM personal_agenda_items WHERE id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`);
  await db.execute(sql`UPDATE degustacoes SET agenda_ids = '[]'::jsonb WHERE id = ${d.id}`);
}

// ---------- mensagens no chamado vinculado ----------
async function mensagemNoChamado(chamadoId: string | null, autor: { id: string; nome: string }, texto: string) {
  if (!chamadoId) return;
  try {
    await db.execute(sql`INSERT INTO chamado_mensagens (chamado_id, autor_id, autor_nome, tipo, de_key, para_key, texto)
      VALUES (${chamadoId}, ${autor.id}, ${autor.nome}, 'publica', 'autor', ${CHAMADO_DESTINO}, ${texto})`);
    await db.execute(sql`UPDATE chamados SET updated_at = now() WHERE id = ${chamadoId}`);
    // destinatário volta a ver como não lido
    await db.execute(sql`DELETE FROM chamado_leituras WHERE chamado_id = ${chamadoId} AND user_id <> ${autor.id}`);
  } catch (e: any) { console.warn("[degustacoes] mensagem no chamado:", e?.message || e); }
}

// ---------- texto do bloqueio da amostra ----------
async function textoBloqueio(d: any): Promise<string> {
  return `\n\n${MARCADOR(d.numero)} Amostra para PROMOÇÃO DE DEGUSTAÇÃO\n${linhasDetalhe(d).join("\n")}\n${APP_URL}/degustacoes?id=${d.id}`;
}

/** Hook: chamado depois que a amostra de uma degustação entra em blocked_orders
 *  (finalize-sale ou insertBlockedOrderIdempotent). Acrescenta os dados da degustação
 *  ao motivo do bloqueio (idempotente pelo marcador) e avisa no chamado. */
export async function aoAmostraBloqueada(salesCardId: string): Promise<void> {
  try {
    if (!salesCardId) return;
    await ensureTable();
    const ref = rows(await db.execute(sql`SELECT d.id FROM degustacoes d
      WHERE d.sales_card_id = ${salesCardId}
         OR d.sales_card_id = (SELECT parent_card_id FROM sales_cards WHERE id = ${salesCardId})
      LIMIT 1`))[0];
    if (!ref) return;
    const d = await carregar(String(ref.id));
    if (!d) return;
    const extra = await textoBloqueio(d);
    const marc = MARCADOR(d.numero);
    const bo = rows(await db.execute(sql`SELECT id, block_details FROM blocked_orders WHERE sales_card_id = ${salesCardId} AND status = 'blocked'`));
    let novo = false;
    for (const b of bo) {
      if (String(b.block_details || "").includes(marc)) continue;
      await db.execute(sql`UPDATE blocked_orders SET block_details = coalesce(block_details,'') || ${extra} WHERE id = ${String(b.id)}`);
      novo = true;
    }
    if (novo) {
      const valor = d.card_valor ? ` — R$ ${Number(d.card_valor).toFixed(2).replace(".", ",")}` : "";
      await mensagemNoChamado(d.chamado_id, { id: "sistema", nome: "Integra (sistema)" },
        `📦 Amostra da degustação lançada${valor}. O pedido está em BLOQUEADOS no Pipeline aguardando liberação (com as observações desta degustação).`);
    }
  } catch (e: any) { console.warn("[degustacoes] aoAmostraBloqueada:", e?.message || e); }
}

/** Hook: chamado finalizado (Responder e finalizar) → degustação concluída. */
export async function aoFinalizarChamado(chamadoId: string): Promise<void> {
  try {
    await ensureTable();
    const r = rows(await db.execute(sql`UPDATE degustacoes SET status = 'concluida', concluida_em = now(), updated_at = now()
      WHERE chamado_id = ${chamadoId} AND status = 'aberta' RETURNING id`));
    for (const x of r) {
      const d = await carregar(String(x.id));
      if (d) await sincronizarAgenda(d).catch(() => {});
    }
  } catch (e: any) { console.warn("[degustacoes] aoFinalizarChamado:", e?.message || e); }
}

/** Reabertura do chamado → degustação volta a "aberta". */
export async function aoReabrirChamado(chamadoId: string): Promise<void> {
  try {
    await ensureTable();
    await db.execute(sql`UPDATE degustacoes SET status = 'aberta', concluida_em = NULL, updated_at = now()
      WHERE chamado_id = ${chamadoId} AND status = 'concluida'`);
  } catch (e: any) { console.warn("[degustacoes] aoReabrirChamado:", e?.message || e); }
}

// ---------- validação do corpo ----------
function lerCorpo(b: any, parcial: boolean) {
  const out: Record<string, any> = {};
  const tem = (k: string) => Object.prototype.hasOwnProperty.call(b || {}, k);
  if (!parcial || tem("data")) {
    const dia = isoDia(b?.data);
    if (!dia) throw new Error("Informe a data da degustação");
    out.data = dia;
  }
  if (!parcial || tem("horaInicio")) {
    const h = hhmm(b?.horaInicio);
    if (!h) throw new Error("Informe a hora de início");
    out.hora_inicio = h;
  }
  if (!parcial || tem("horaFim")) out.hora_fim = hhmm(b?.horaFim);
  if (!parcial || tem("local")) out.local = String(b?.local || "").trim().slice(0, 500) || null;
  if (!parcial || tem("executorTipo")) out.executor_tipo = b?.executorTipo === "terceirizada" ? "terceirizada" : "honest";
  for (const [k, col, max] of [["empresaNome", "empresa_nome", 200], ["empresaContato", "empresa_contato", 200], ["empresaTelefone", "empresa_telefone", 40],
    ["responsavelExecucao", "responsavel_execucao", 200], ["materiaisOutros", "materiais_outros", 1000], ["observacoes", "observacoes", 4000]] as const) {
    if (!parcial || tem(k)) out[col] = String(b?.[k] ?? "").trim().slice(0, max) || null;
  }
  if (!parcial || tem("materiais")) out.materiais = Array.isArray(b?.materiais) ? b.materiais.map((x: any) => String(x).slice(0, 120)).filter(Boolean).slice(0, 40) : [];
  if (!parcial || tem("publicoEstimado")) { const n = parseInt(String(b?.publicoEstimado ?? ""), 10); out.publico_estimado = Number.isFinite(n) && n > 0 ? n : null; }
  const tipo = out.executor_tipo ?? (parcial ? undefined : "honest");
  if (tipo === "terceirizada" && (!parcial || tem("empresaNome")) && !out.empresa_nome) throw new Error("Informe a empresa que vai executar a degustação");
  return out;
}

async function podeVer(u: any, d: any): Promise<boolean> {
  if (await veTudo(u)) return true;
  const uid = String(u?.id || "");
  return [d.criado_por, d.seller_id, d.cliente_seller_id].map((x) => String(x || "")).includes(uid);
}

// ===========================================================================
export function registerDegustacoes(app: Express) {
  ensureTable().catch((e) => console.error("[degustacoes] ensureTable:", e?.message || e));

  app.get("/api/degustacoes/materiais", authenticateUser, (_req, res) => res.json({ materiais: MATERIAIS_PADRAO }));

  // Busca de clientes (vendedor/telemarketing: só a própria carteira)
  app.get("/api/degustacoes/clientes", authenticateUser, async (req: any, res: Response) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json({ clientes: [] });
      const tudo = await veTudo(req.currentUser) || ["coordinator", "administrative"].includes(String(req.currentUser?.role));
      const like = `%${q}%`;
      const dig = q.replace(/\D/g, "");
      const r = rows(await db.execute(sql`
        SELECT c.id, coalesce(nullif(c.fantasy_name,''), c.name) AS nome, c.name AS razao, c.cnpj, c.cpf, c.address, c.neighborhood, c.city, c.seller_id,
               trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS vendedor
          FROM customers c LEFT JOIN users u ON u.id = c.seller_id
         WHERE (c.name ILIKE ${like} OR c.fantasy_name ILIKE ${like} OR c.company_name ILIKE ${like}
                OR (${dig.length >= 4} AND (regexp_replace(coalesce(c.cnpj,''),'\\D','','g') LIKE ${"%" + dig + "%"} OR regexp_replace(coalesce(c.cpf,''),'\\D','','g') LIKE ${"%" + dig + "%"})))
           AND (${tudo} OR c.seller_id = ${String(req.currentUser?.id || "")})
         ORDER BY coalesce(nullif(c.fantasy_name,''), c.name) LIMIT 25`));
      res.json({ clientes: r.map((c) => ({ id: c.id, nome: c.nome, razao: c.razao, documento: c.cnpj || c.cpf || "", endereco: [c.address, c.neighborhood, c.city].filter(Boolean).join(" — "), sellerId: c.seller_id, vendedor: c.vendedor || "" })) });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Lista
  app.get("/api/degustacoes", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureTable();
      const u = req.currentUser;
      const tudo = await veTudo(u);
      const uid = String(u?.id || "");
      const status = String(req.query.status || "");
      const r = rows(await db.execute(sql`
        SELECT d.id FROM degustacoes d LEFT JOIN customers c ON c.id = d.customer_id
         WHERE (${status} = '' OR d.status = ${status})
           AND (${tudo} OR d.criado_por = ${uid} OR d.seller_id = ${uid} OR c.seller_id = ${uid})
         ORDER BY d.data DESC, d.hora_inicio DESC LIMIT 500`));
      const lista: any[] = [];
      for (const x of r) { const d = await carregar(String(x.id)); if (d) lista.push(saida(d)); }
      const resumo = rows(await db.execute(sql`SELECT d.status, count(*)::int AS n FROM degustacoes d LEFT JOIN customers c ON c.id = d.customer_id
        WHERE (${tudo} OR d.criado_por = ${uid} OR d.seller_id = ${uid} OR c.seller_id = ${uid}) GROUP BY d.status`));
      res.json({ degustacoes: lista, resumo, veTudo: tudo });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Detalhe + andamento do chamado (mensagens públicas) + fotos
  app.get("/api/degustacoes/:id", authenticateUser, async (req: any, res: Response) => {
    try {
      const d = await carregar(String(req.params.id));
      if (!d || !(await podeVer(req.currentUser, d))) return res.status(404).json({ message: "Degustação não encontrada" });
      let mensagens: any[] = [];
      let fotos: any[] = [];
      if (d.chamado_id) {
        const msgs = rows(await db.execute(sql`SELECT id, tipo, autor_nome, texto, created_at FROM chamado_mensagens
          WHERE chamado_id = ${d.chamado_id} AND tipo <> 'interna' ORDER BY created_at`));
        const anexos = rows(await db.execute(sql`SELECT a.id, a.mensagem_id, a.nome, a.mime, a.tamanho, a.created_at FROM chamado_anexos a
          LEFT JOIN chamado_mensagens m ON m.id = a.mensagem_id
          WHERE a.chamado_id = ${d.chamado_id} AND coalesce(m.tipo,'publica') <> 'interna' ORDER BY a.created_at`));
        mensagens = msgs.map((m) => ({ id: m.id, tipo: m.tipo, autorNome: m.autor_nome, texto: m.texto, createdAt: m.created_at,
          anexos: anexos.filter((a) => String(a.mensagem_id || "") === String(m.id)).map((a) => ({ id: a.id, nome: a.nome, mime: a.mime })) }));
        fotos = anexos.map((a) => ({ id: a.id, nome: a.nome, mime: a.mime, tamanho: a.tamanho, createdAt: a.created_at, url: `/api/degustacoes/${d.id}/anexos/${a.id}` }));
      }
      res.json({ degustacao: saida(d), mensagens, fotos });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Foto/arquivo do chamado vinculado (quem vê a degustação vê as fotos)
  app.get("/api/degustacoes/:id/anexos/:anexoId", authenticateUser, async (req: any, res: Response) => {
    try {
      const d = await carregar(String(req.params.id));
      if (!d || !d.chamado_id || !(await podeVer(req.currentUser, d))) return res.status(404).json({ message: "Não encontrado" });
      const a = rows(await db.execute(sql`SELECT a.nome, a.mime, a.dados, m.tipo FROM chamado_anexos a LEFT JOIN chamado_mensagens m ON m.id = a.mensagem_id
        WHERE a.id = ${String(req.params.anexoId)} AND a.chamado_id = ${d.chamado_id}`))[0];
      if (!a || a.tipo === "interna") return res.status(404).json({ message: "Não encontrado" });
      res.setHeader("Content-Type", String(a.mime || "application/octet-stream"));
      res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(String(a.nome || "arquivo"))}`);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(Buffer.isBuffer(a.dados) ? a.dados : Buffer.from(a.dados));
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Abrir degustação → chamado para a Lanucy + agendas
  app.post("/api/degustacoes", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureTable();
      const u = req.currentUser;
      if (String(u?.role) === "motorista") return res.status(403).json({ message: "Sem acesso" });
      const customerId = String(req.body?.customerId || "");
      const cli = rows(await db.execute(sql`SELECT id, seller_id, address, neighborhood, city FROM customers WHERE id = ${customerId}`))[0];
      if (!cli) return res.status(400).json({ message: "Escolha o cliente" });
      if (!(await veTudo(u)) && !["coordinator", "administrative"].includes(String(u?.role)) && String(cli.seller_id) !== String(u?.id))
        return res.status(403).json({ message: "Você só pode abrir degustação para clientes da sua carteira" });
      const c = lerCorpo(req.body, false);
      if (!c.local) c.local = [cli.address, cli.neighborhood, cli.city].filter(Boolean).join(" — ") || null;
      const ins = rows(await db.execute(sql`INSERT INTO degustacoes
          (customer_id, seller_id, data, hora_inicio, hora_fim, local, executor_tipo, empresa_nome, empresa_contato, empresa_telefone,
           responsavel_execucao, materiais, materiais_outros, publico_estimado, observacoes, criado_por, criado_por_nome)
        VALUES (${customerId}, ${cli.seller_id || null}, ${c.data}::date, ${c.hora_inicio}, ${c.hora_fim}, ${c.local}, ${c.executor_tipo},
          ${c.empresa_nome}, ${c.empresa_contato}, ${c.empresa_telefone}, ${c.responsavel_execucao}, ${JSON.stringify(c.materiais)}::jsonb,
          ${c.materiais_outros}, ${c.publico_estimado}, ${c.observacoes}, ${String(u.id)}, ${nomeDe(u)}) RETURNING id`));
      const id = String(ins[0].id);
      let d = await carregar(id);

      // Chamado automático para a Lanucy
      try {
        const { abrirChamadoSistema } = await import("./chamados-routes");
        const acao = d.executor_tipo === "terceirizada"
          ? `➡ Contratar a empresa ${d.empresa_nome} e alinhar a execução.`
          : "➡ Organizar a logística da equipe Honest para a execução.";
        const descricao = [
          `PROMOÇÃO DE DEGUSTAÇÃO ${numeroFmt(d.numero)} aberta por ${nomeDe(u)}.`, "",
          ...linhasDetalhe(d), "",
          acao,
          "➡ Providenciar os materiais listados e as amostras (lançadas pela própria degustação; caem em Bloqueados para liberação).",
          "➡ Ao final, RESPONDER E FINALIZAR este chamado anexando as FOTOS da degustação — a degustação é concluída automaticamente.", "",
          `Degustação no Integra: ${APP_URL}/degustacoes?id=${id}`,
        ].join("\n");
        const ids = await abrirChamadoSistema({
          destinoKeys: [CHAMADO_DESTINO],
          assunto: `PROMOÇÃO DE DEGUSTAÇÃO ${numeroFmt(d.numero)} — ${d.cliente_nome || "cliente"} — ${dataBR(d.data)} ${d.hora_inicio}`,
          descricao, prioridade: "Normal",
          autor: { id: String(u.id), nome: nomeDe(u), role: String(u.role || "") },
        });
        if (ids[0]) await db.execute(sql`UPDATE degustacoes SET chamado_id = ${ids[0]} WHERE id = ${id}`);
      } catch (e: any) { console.error("[degustacoes] chamado:", e?.message || e); }

      d = await carregar(id);
      try { await sincronizarAgenda(d); } catch (e: any) { console.error("[degustacoes] agenda:", e?.message || e); }
      d = await carregar(id);
      res.status(201).json({ degustacao: saida(d) });
    } catch (e: any) { res.status(400).json({ message: e?.message || String(e) }); }
  });

  // Editar
  app.patch("/api/degustacoes/:id", authenticateUser, async (req: any, res: Response) => {
    try {
      const u = req.currentUser;
      const antes = await carregar(String(req.params.id));
      if (!antes || !(await podeVer(u, antes))) return res.status(404).json({ message: "Degustação não encontrada" });
      if (antes.status === "cancelada") return res.status(400).json({ message: "Degustação cancelada não pode ser editada" });
      const c = lerCorpo(req.body, true);
      if (c.executor_tipo === "terceirizada" && !(c.empresa_nome ?? antes.empresa_nome)) return res.status(400).json({ message: "Informe a empresa que vai executar a degustação" });
      const sets = Object.entries(c).map(([k, v]) =>
        k === "materiais" ? sql`materiais = ${JSON.stringify(v)}::jsonb` : k === "data" ? sql`data = ${v}::date` : sql`${sql.raw(k)} = ${v as any}`);
      if (!sets.length) return res.json({ degustacao: saida(antes) });
      await db.execute(sql`UPDATE degustacoes SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE id = ${antes.id}`);
      const d = await carregar(antes.id);
      try { await sincronizarAgenda(d); } catch (e: any) { console.error("[degustacoes] agenda:", e?.message || e); }
      // bloqueio ainda aberto da amostra: reescreve o bloco da degustação
      if (d.sales_card_id) {
        const marc = MARCADOR(d.numero);
        const bo = rows(await db.execute(sql`SELECT id, block_details FROM blocked_orders WHERE sales_card_id = ${d.sales_card_id} AND status = 'blocked'`));
        for (const b of bo) {
          const base = String(b.block_details || "");
          const i = base.indexOf("\n\n" + marc);
          await db.execute(sql`UPDATE blocked_orders SET block_details = ${(i >= 0 ? base.slice(0, i) : base) + (await textoBloqueio(d))} WHERE id = ${String(b.id)}`);
        }
      }
      await mensagemNoChamado(d.chamado_id, { id: String(u.id), nome: nomeDe(u) },
        `✏️ Degustação atualizada por ${nomeDe(u)}:\n${linhasDetalhe(d).join("\n")}`);
      res.json({ degustacao: saida(d) });
    } catch (e: any) { res.status(400).json({ message: e?.message || String(e) }); }
  });

  // Criar (ou retomar) o card de AMOSTRA no mesmo formato do card de vendas
  app.post("/api/degustacoes/:id/amostra", authenticateUser, async (req: any, res: Response) => {
    try {
      const u = req.currentUser;
      const d = await carregar(String(req.params.id));
      if (!d || !(await podeVer(u, d))) return res.status(404).json({ message: "Degustação não encontrada" });
      if (d.status === "cancelada") return res.status(400).json({ message: "Degustação cancelada" });
      if (d.sales_card_id && d.card_status && d.card_status !== "cancelled") {
        if (d.card_status === "draft" || d.card_status === "pending") return res.json({ salesCardId: d.sales_card_id, existente: true });
        return res.status(400).json({ message: "A amostra desta degustação já foi lançada.", salesCardId: d.sales_card_id });
      }
      const role = String(u?.role || "");
      const sellerId = ["vendedor", "telemarketing"].includes(role) ? String(u.id) : String(d.seller_id || d.cliente_seller_id || u.id);
      const hoje = new Date();
      const dias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
      const notes = `${MARCADOR(d.numero)} Amostra para PROMOÇÃO DE DEGUSTAÇÃO em ${dataBR(d.data)} ${d.hora_inicio}.${d.observacoes ? `\nObs.: ${d.observacoes}` : ""}`;
      const card = await storage.createSalesCard({
        customerId: d.customer_id, sellerId, status: "draft", scheduledDate: hoje,
        routeDay: dias[hoje.getDay()], recurrenceType: "semanal", isRecurring: false, isPermanent: false,
        operationType: "amostra", paymentMethod: "a_vista", products: [], notes, source: "degustacao",
      } as any);
      await db.execute(sql`UPDATE degustacoes SET sales_card_id = ${String(card.id)}, updated_at = now() WHERE id = ${d.id}`);
      await mensagemNoChamado(d.chamado_id, { id: String(u.id), nome: nomeDe(u) }, `🧃 ${nomeDe(u)} iniciou o lançamento das amostras da degustação.`);
      res.status(201).json({ salesCardId: String(card.id), existente: false });
    } catch (e: any) { res.status(400).json({ message: e?.message || String(e) }); }
  });

  // Cancelar
  app.post("/api/degustacoes/:id/cancelar", authenticateUser, async (req: any, res: Response) => {
    try {
      const u = req.currentUser;
      const d = await carregar(String(req.params.id));
      if (!d || !(await podeVer(u, d))) return res.status(404).json({ message: "Degustação não encontrada" });
      if (d.status !== "aberta") return res.status(400).json({ message: "Só degustação em aberto pode ser cancelada" });
      const motivo = String(req.body?.motivo || "").trim().slice(0, 1000);
      if (motivo.length < 3) return res.status(400).json({ message: "Informe o motivo do cancelamento" });
      await db.execute(sql`UPDATE degustacoes SET status = 'cancelada', cancelada_em = now(), motivo_cancelamento = ${motivo}, updated_at = now() WHERE id = ${d.id}`);
      await removerAgenda(d);
      // amostra ainda não finalizada some junto; a já lançada fica em Bloqueados para decisão humana
      if (d.sales_card_id && ["draft", "pending"].includes(String(d.card_status))) {
        await db.execute(sql`UPDATE sales_cards SET status = 'cancelled', updated_at = now() WHERE id = ${d.sales_card_id}`);
      }
      const aviso = d.bloqueio_status === "blocked" ? "\n⚠ A amostra já lançada continua em BLOQUEADOS — recusar por lá se não for usada." : "";
      if (d.chamado_id) {
        await mensagemNoChamado(d.chamado_id, { id: String(u.id), nome: nomeDe(u) }, `❌ Degustação CANCELADA por ${nomeDe(u)}. Motivo: ${motivo}${aviso}`);
        await db.execute(sql`UPDATE chamados SET status = 'cancelado', cancelado_em = now(), updated_at = now() WHERE id = ${d.chamado_id} AND status NOT IN ('solucionado','cancelado')`);
      }
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ message: e?.message || String(e) }); }
  });
}
