// =============================================================================
// PAINEL DE COMUNICAÇÃO — a lista de clientes ativos com tudo que a Central já
// falou com cada um, e de onde se dispara a próxima mensagem.
// -----------------------------------------------------------------------------
// O painel de atendimento (painel-atendimento-digital.ts) responde "o que
// aconteceu hoje". Este responde a outra pergunta, que é a que decide ação:
// "com QUEM a gente falou, com quem não, e quem está pedindo para ser chamado".
//
// Uma linha por cliente ativo, com:
//   - consumidor ou revendedor, virtual ou presencial, vendedor responsável;
//   - última compra (data e valor) e há quantos dias ela foi;
//   - última interação da Central: quando, qual template, se chegou, se ele
//     respondeu;
//   - débito vencido: quanto, quantos títulos, quantos dias de atraso;
//   - contato e telefone cadastrados.
//
// E daí se dispara: marca os clientes, escolhe o tipo de mensagem, manda. Cada
// tipo cai num caso de uso do 1841 (recompra, cobranca...), o que importa
// porque é o caso de uso que decide QUAL AGENTE atende quem responder — quem
// responde uma cobrança fala com o agente de cobrança, não com o de vendas.
//
// O QUE ESTE MÓDULO NÃO FAZ: mandar mensagem sozinho. Ele só enfileira o que
// uma pessoa marcou e clicou. Todas as travas da fila do 1841 continuam
// valendo por cima (modo off/test/on, teto diário, horário comercial, opt-out,
// antirrepetição) — este painel não é um atalho para furar nenhuma delas.
// =============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { whereDebitoVivoText } from "./divida-viva";
import { diaBR } from "./fuso-coluna";

const PAPEIS = ["admin", "coordinator", "administrative"];

// -----------------------------------------------------------------------------
// OS TIPOS DE MENSAGEM — uma coluna do painel para cada um.
// -----------------------------------------------------------------------------
// `templateLabel` é o rótulo em whatsapp_templates; a variante UTILITY '<rotulo>_u'
// assume sozinha quando a Meta aprova (rotuloEfetivo), então aqui fica sempre o
// rótulo base. `useCase` é o que amarra a resposta ao agente certo.
export type TipoMensagem = {
  id: string;
  nome: string;
  descricao: string;
  /** rótulo do template. Uma LISTA quando existe versão nova esperando a Meta:
   *  a primeira aprovada é a que sai, e a última é o que está no ar hoje. */
  templateLabel: string | string[];
  useCase: string;
  /** só faz sentido para quem tem débito vencido */
  exigeDebito?: boolean;
  /** quando true, o painel não deixa mandar para quem comprou há pouco */
  diasSemCompraMinimo?: number;
};

export const TIPOS: TipoMensagem[] = [
  {
    id: "reativacao", nome: "Reativação", useCase: "recompra",
    templateLabel: ["recompra_reativacao_v2", "recompra_reativacao"],
    descricao: "Cliente que parou de comprar. Pergunta se quer repor os itens de sempre.",
    diasSemCompraMinimo: 30,
  },
  {
    id: "reposicao", nome: "Reposição", useCase: "recompra",
    templateLabel: ["recompra_reposicao_v2", "recompra_reposicao"],
    descricao: "Pelo ciclo dele, o estoque está acabando agora.",
  },
  {
    id: "mix", nome: "Ampliar mix", useCase: "recompra",
    templateLabel: ["recompra_mix_v2", "recompra_mix"],
    descricao: "Compra sempre, mas só 1 ou 2 sabores.",
  },
  {
    id: "pos_primeira", nome: "Pós-primeira compra", templateLabel: "recompra_pos_primeira", useCase: "recompra",
    descricao: "Comprou pela primeira vez há pouco. Momento de garantir a segunda.",
  },
  {
    id: "cobranca", nome: "Cobrança de débito", templateLabel: "cobranca_titulos", useCase: "cobranca",
    descricao: "Lembra dos títulos vencidos, com valor e vencimento, e pede para desconsiderar se já pagou.",
    exigeDebito: true,
  },
];

export const tipoPorId = (id: string) => TIPOS.find(t => t.id === id) || null;

/** Os rótulos de um tipo, do mais novo para o que está no ar hoje. */
export const rotulosDoTipo = (t: TipoMensagem): string[] =>
  Array.isArray(t.templateLabel) ? t.templateLabel : [t.templateLabel];

/**
 * Qual template sai de fato.
 * ---------------------------------------------------------------------------
 * A Meta nao deixa editar o texto de um template aprovado: para mudar a
 * mensagem, cria-se outro. Enquanto o novo esta em revisao, quem esta no ar e
 * o antigo — e e ELE que tem que sair, senao o disparo falha. Por isso o tipo
 * carrega a lista na ordem "mais novo primeiro" e aqui se pega o PRIMEIRO
 * APROVADO. No dia em que a Meta aprova o novo, a troca acontece sozinha, sem
 * deploy: o sincronismo de hora em hora traz o corpo, e este escolhe.
 *
 * Dentro de cada rotulo ainda vale a regra do '_u': a variante UTILITY assume
 * quando existir, porque custa 0,04 em vez de 0,34.
 */
export async function escolherTemplate(tipo: TipoMensagem): Promise<{ label: string; categoria: string } | null> {
  const { rotuloEfetivo } = await import("./mkt-recompra");
  const t: any = await db.execute(sql`
    SELECT label, umbler_id, COALESCE(is_active, true) AS ativo FROM whatsapp_templates`);
  const vivo = new Map<string, any>((t.rows || [])
    .filter((r: any) => r.umbler_id && r.ativo !== false)
    .map((r: any) => [String(r.label), r]));
  for (const base of rotulosDoTipo(tipo)) {
    const u = base + "_u";
    if (vivo.has(base) || vivo.has(u)) return await rotuloEfetivo(base);
  }
  return null;
}

// -----------------------------------------------------------------------------
// O template de cobrança
// -----------------------------------------------------------------------------
// Precisa de aprovação da Meta, e a categoria certa é UTILITY: ele acompanha
// algo PENDENTE de uma transação que já existe (um título em aberto), não
// oferece nada para vender. O pedido de desconsiderar caso já tenha pago não é
// educação: é o que impede a mensagem de virar cobrança indevida quando a
// baixa do pagamento ainda não entrou no sistema.
//
// Variáveis: {{1}} contato, {{2}} "1 título"/"N títulos", {{3}} vencimento mais
// antigo, {{4}} total em aberto. Não começa nem termina com variável, que é o
// que o Umbler recusa.
export const CORPO_COBRANCA =
  "Oi, {{1}}! Aqui é da Honest Sucos. Consta {{2}} em aberto no seu cadastro, " +
  "o mais antigo com vencimento em {{3}}, somando R$ {{4}}. " +
  "Se o pagamento já tiver sido feito, é só desconsiderar esta mensagem. " +
  "Quer que eu mande a 2ª via para conferir?";

/** Cria a linha do template de cobrança no cadastro, sem umbler_id — ele entra
 *  quando a Meta aprovar. Sem umbler_id o disparo não sai, que é o certo. */
let _pronto = false;
/** Idempotente e barato depois da primeira vez; pode ser chamada em toda leitura. */
export async function ensureComunicacaoSchema(forcar = false) {
  if (_pronto && !forcar) return;
  _pronto = true;
  // `use_case` é um ENUM do Postgres. Um valor que não está no tipo não é um
  // aviso: o INSERT do disparo estoura, e o envio inteiro morre. 'cobranca'
  // nunca tinha sido usado por nenhum disparo, então nunca entrou no tipo —
  // mesma armadilha que já pegou 'recompra' e 'entrega' antes.
  for (const v of TIPOS.map(t => t.useCase)) {
    try { await db.execute(sql.raw(`ALTER TYPE dispatch_use_case ADD VALUE IF NOT EXISTS '${v}'`)); } catch {}
  }
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_disp_fone_criado
      ON official_dispatches (customer_phone, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_disp_cliente_criado
      ON official_dispatches (customer_id, created_at DESC)`);
  } catch {}
  // NÃO tenta pré-cadastrar o template de cobrança. `whatsapp_templates.umbler_id`
  // é NOT NULL em produção, e de propósito: é ele que o disparo usa para achar o
  // template aprovado na Meta. Uma linha sem umbler_id não é "pendente", é uma
  // linha que nunca funcionaria — e as duas tentativas de criá-la aqui (INSERT
  // direto e salvarTemplate) falharam pelo mesmo motivo. O template nasce do
  // lado do Umbler; aqui o painel só sabe DIZER que ele falta e qual é o texto.
}

// -----------------------------------------------------------------------------
// A LISTA
// -----------------------------------------------------------------------------
export type FiltrosComunicacao = {
  vendedor?: string;
  tipoCliente?: "consumidor" | "revendedor" | "";
  atendimento?: "virtual" | "presencial" | "";
  diasSemCompraMin?: number;
  diasSemCompraMax?: number;
  debito?: "com" | "sem" | "";
  respondeu?: "sim" | "nao" | "";
  contatada?: "sim" | "nunca" | "";
  /** inclui clientes inativos que ainda devem — eles somem da lista de ativos, mas a dívida não some */
  incluirInativos?: boolean;
  cidade?: string;
  busca?: string;
  limite?: number;
};

const FONE8 = (col: string) => sql.raw(`right(regexp_replace(COALESCE(${col},''), '\\D', '', 'g'), 8)`);

export async function listarClientes(f: FiltrosComunicacao = {}) {
  const limite = Math.min(Math.max(Number(f.limite) || 3000, 1), 8000);
  // Metade das tabelas deste projeto guarda `timestamp` naive em UTC e a outra
  // metade timestamptz. Confiar na memória sobre qual é qual já jogou disparo
  // da noite para o dia seguinte no painel de atendimento — aqui o tipo vem do
  // catálogo do Postgres.
  const diaCompra = sql.raw(await diaBR("sales_cards", "completed_date", "cp.quando"));
  const diaDisparo = sql.raw(await diaBR("official_dispatches", "created_at", "d.quando"));
  // Cliente inativo que ainda deve some da lista de ativos, mas a dívida dele
  // não some do mundo — e ele é justamente quem mais precisa ser cobrado. Com
  // `incluirInativos`, entram os inativos QUE DEVEM, e só eles: trazer a base
  // inativa inteira encheria a tela de quem não interessa.
  const condAtivo = f.incluirInativos
    ? `(c.is_active = true OR EXISTS (SELECT 1 FROM receivables rr
         WHERE rr.customer_id = c.id AND ${whereDebitoVivoText("rr")}))`
    : "c.is_active = true";

  const linhas: any = await db.execute(sql`
    WITH base AS (
      SELECT c.id,
             COALESCE(NULLIF(c.fantasy_name, ''), NULLIF(c.company_name, ''), c.name) AS nome,
             NULLIF(c.contact, '') AS contato,
             c.phone,
             c.city AS cidade,
             c.seller_id,
             COALESCE(c.is_consumer_client, false) AS consumidor,
             COALESCE(c.virtual_service, false)    AS virtual,
             COALESCE(c.is_active, false) AS ativo,
             ${FONE8("c.phone")} AS fone8
        FROM customers c
       WHERE ${sql.raw(condAtivo)}
         AND COALESCE(c.is_lead, false)       = false
         AND COALESCE(c.is_supplier, false)   = false
         AND COALESCE(c.is_colaborador, false) = false
    ),
    -- Última compra: mesma regra do contexto do cliente, para os dois painéis
    -- nunca divergirem sobre o que conta como compra.
    compra AS (
      SELECT DISTINCT ON (sc.customer_id)
             sc.customer_id AS cid,
             COALESCE(sc.completed_date, sc.updated_at, sc.created_at) AS quando,
             sc.sale_value AS valor
        FROM sales_cards sc
       WHERE COALESCE(sc.operation_type, 'venda') = 'venda'
         AND COALESCE(sc.status, '') NOT IN ('cancelled', 'telemarketing')
         AND (sc.completed_date IS NOT NULL OR COALESCE(sc.status, '') IN ('blocked', 'completed', 'invoiced'))
       ORDER BY sc.customer_id, COALESCE(sc.completed_date, sc.updated_at, sc.created_at) DESC
    ),
    -- Débito vencido pela regra única da dívida viva (divida-viva.ts). Não
    -- reescrever essa regra aqui é o que impede o painel de cobrar o que a
    -- gestão de débito não considera devido.
    debito AS (
      SELECT r.customer_id AS cid,
             sum(r.amount - COALESCE(r.amount_paid, 0))::numeric AS total,
             count(*)::int AS titulos,
             min(r.due_date) AS vencimento_antigo,
             max(((now() AT TIME ZONE 'America/Sao_Paulo')::date - (r.due_date)::date))::int AS dias_atraso
        FROM receivables r
       WHERE ${sql.raw(whereDebitoVivoText("r"))}
       GROUP BY 1
      HAVING sum(r.amount - COALESCE(r.amount_paid, 0)) > 0
    ),
    -- Última mensagem que a Central mandou, por telefone (o disparo nem sempre
    -- carrega customer_id, mas sempre carrega telefone).
    disp AS (
      SELECT DISTINCT ON (${FONE8("d.customer_phone")})
             ${FONE8("d.customer_phone")} AS fone8,
             d.created_at   AS quando,
             d.template_label,
             d.use_case::text AS use_case,
             d.status::text   AS status,
             d.delivered_at, d.read_at, d.campaign
        FROM official_dispatches d
       WHERE COALESCE(d.customer_phone, '') <> ''
       ORDER BY ${FONE8("d.customer_phone")}, d.created_at DESC
    ),
    -- Última vez que o cliente ESCREVEU. chat_messages.created_at é timestamp
    -- sem fuso guardando UTC; sem o AT TIME ZONE a comparação com o disparo
    -- (timestamptz) erra por 3 horas e inventa resposta que não houve.
    entrada AS (
      SELECT ${FONE8("cc.customer_phone")} AS fone8,
             max(m.created_at AT TIME ZONE 'UTC') AS ultima
        FROM chat_messages m
        JOIN chat_conversations cc ON cc.id = m.conversation_id
       WHERE m.sender_type = 'customer'
       GROUP BY 1
    ),
    -- Quantas mensagens a Central já mandou para esse cliente, na vida.
    total_disp AS (
      SELECT ${FONE8("d.customer_phone")} AS fone8, count(*)::int AS n
        FROM official_dispatches d
       WHERE COALESCE(d.customer_phone, '') <> ''
       GROUP BY 1
    )
    SELECT b.id, b.nome, b.contato, b.phone AS telefone, b.cidade,
           b.consumidor, b.virtual, b.ativo, b.seller_id,
           NULLIF(trim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS vendedor,
           ${diaCompra} AS ultima_compra,
           cp.valor AS ultima_compra_valor,
           CASE WHEN cp.quando IS NULL THEN NULL
                ELSE ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ${diaCompra}) END AS dias_sem_compra,
           COALESCE(db.total, 0)      AS debito_total,
           COALESCE(db.titulos, 0)    AS debito_titulos,
           db.vencimento_antigo::date AS debito_vencimento,
           COALESCE(db.dias_atraso, 0) AS debito_dias_atraso,
           ${diaDisparo} AS ultima_interacao,
           d.template_label AS ultimo_template,
           d.use_case       AS ultimo_tipo,
           d.status         AS ultimo_status,
           (d.delivered_at IS NOT NULL OR d.status IN ('entregue', 'lida', 'resposta')) AS recebida,
           COALESCE(d.status = 'resposta', false)
             OR (e.ultima IS NOT NULL AND d.quando IS NOT NULL AND e.ultima >= d.quando) AS respondeu,
           COALESCE(td.n, 0) AS total_mensagens
      FROM base b
      LEFT JOIN users u       ON u.id = b.seller_id
      LEFT JOIN compra cp     ON cp.cid = b.id
      LEFT JOIN debito db     ON db.cid = b.id
      LEFT JOIN disp d        ON d.fone8 = b.fone8 AND b.fone8 <> ''
      LEFT JOIN entrada e     ON e.fone8 = b.fone8 AND b.fone8 <> ''
      LEFT JOIN total_disp td ON td.fone8 = b.fone8 AND b.fone8 <> ''
     ORDER BY b.nome
     LIMIT ${limite}
  `);

  // Os filtros são aplicados aqui, e não no SQL, de propósito: a consulta
  // acima já é a base de TODAS as telas e dos totais, e filtrar em memória
  // deixa os contadores ("quantos sobrariam se...") baratos. São milhares de
  // linhas, não milhões.
  let itens = (linhas.rows || []).map((r: any) => ({
    id: String(r.id),
    nome: String(r.nome || "(sem nome)"),
    contato: r.contato || null,
    telefone: r.telefone || null,
    cidade: r.cidade || null,
    tipo: r.consumidor ? "consumidor" : "revendedor",
    atendimento: r.virtual ? "virtual" : "presencial",
    ativo: r.ativo === true,
    vendedorId: r.seller_id || null,
    vendedor: r.vendedor || null,
    ultimaCompra: r.ultima_compra || null,
    ultimaCompraValor: r.ultima_compra_valor == null ? null : Number(r.ultima_compra_valor),
    diasSemCompra: r.dias_sem_compra == null ? null : Number(r.dias_sem_compra),
    debitoTotal: Number(r.debito_total || 0),
    debitoTitulos: Number(r.debito_titulos || 0),
    debitoVencimento: r.debito_vencimento || null,
    debitoDiasAtraso: Number(r.debito_dias_atraso || 0),
    ultimaInteracao: r.ultima_interacao || null,
    ultimoTemplate: r.ultimo_template || null,
    ultimoTipo: r.ultimo_tipo || null,
    ultimoStatus: r.ultimo_status || null,
    recebida: r.recebida === true,
    respondeu: r.respondeu === true,
    totalMensagens: Number(r.total_mensagens || 0),
  }));

  const antes = itens.length;
  const b = String(f.busca || "").trim().toLowerCase();
  if (b) itens = itens.filter((i: any) =>
    i.nome.toLowerCase().includes(b) ||
    String(i.contato || "").toLowerCase().includes(b) ||
    String(i.telefone || "").replace(/\D/g, "").includes(b.replace(/\D/g, "") || "\u0000"));
  if (f.vendedor) itens = itens.filter((i: any) => i.vendedorId === f.vendedor);
  if (f.tipoCliente) itens = itens.filter((i: any) => i.tipo === f.tipoCliente);
  if (f.atendimento) itens = itens.filter((i: any) => i.atendimento === f.atendimento);
  if (f.cidade) itens = itens.filter((i: any) => String(i.cidade || "").toLowerCase() === String(f.cidade).toLowerCase());
  if (f.debito === "com") itens = itens.filter((i: any) => i.debitoTotal > 0);
  if (f.debito === "sem") itens = itens.filter((i: any) => i.debitoTotal <= 0);
  if (f.respondeu === "sim") itens = itens.filter((i: any) => i.respondeu);
  if (f.respondeu === "nao") itens = itens.filter((i: any) => i.ultimaInteracao && !i.respondeu);
  if (f.contatada === "sim") itens = itens.filter((i: any) => i.totalMensagens > 0);
  if (f.contatada === "nunca") itens = itens.filter((i: any) => i.totalMensagens === 0);
  if (f.diasSemCompraMin != null && f.diasSemCompraMin !== ("" as any))
    itens = itens.filter((i: any) => i.diasSemCompra != null && i.diasSemCompra >= Number(f.diasSemCompraMin));
  if (f.diasSemCompraMax != null && f.diasSemCompraMax !== ("" as any))
    itens = itens.filter((i: any) => i.diasSemCompra != null && i.diasSemCompra <= Number(f.diasSemCompraMax));

  const soma = (fn: (i: any) => number) => itens.reduce((a: number, i: any) => a + fn(i), 0);

  // O TOTAL da dívida viva no sistema, sem recorte de lista nem de filtro. Sem
  // ele o painel mostra um número de débito que não bate com a Gestão de Débito
  // nem com Contas a Receber, e quem olha conclui que um dos dois está errado —
  // quando na verdade são recortes diferentes da mesma dívida.
  const g: any = await db.execute(sql`
    SELECT COALESCE(sum(r.amount - COALESCE(r.amount_paid, 0)), 0)::numeric AS total,
           count(DISTINCT r.customer_id)::int AS clientes
      FROM receivables r WHERE ${sql.raw(whereDebitoVivoText("r"))}`);
  const geral = Number(g.rows?.[0]?.total || 0);
  const debitoDaLista = Number(soma((i: any) => i.debitoTotal).toFixed(2));

  return {
    itens,
    resumo: {
      debitoVivoGeral: Number(geral.toFixed(2)),
      clientesComDebitoGeral: Number(g.rows?.[0]?.clientes || 0),
      debitoForaDaLista: Number((geral - debitoDaLista).toFixed(2)),
      clientes: itens.length,
      deUmTotalDe: antes,
      comDebito: itens.filter((i: any) => i.debitoTotal > 0).length,
      debitoTotal: debitoDaLista,
      nuncaContatados: itens.filter((i: any) => i.totalMensagens === 0).length,
      responderam: itens.filter((i: any) => i.respondeu).length,
      semRespostaNoUltimo: itens.filter((i: any) => i.ultimaInteracao && !i.respondeu).length,
      consumidores: itens.filter((i: any) => i.tipo === "consumidor").length,
      revendedores: itens.filter((i: any) => i.tipo === "revendedor").length,
    },
  };
}

/** Vendedores e cidades que aparecem na base, para montar os seletores. */
export async function opcoesDeFiltro() {
  const v: any = await db.execute(sql`
    SELECT u.id, NULLIF(trim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS nome,
           count(c.id)::int AS clientes
      FROM users u JOIN customers c ON c.seller_id = u.id AND c.is_active = true
     GROUP BY 1, 2 HAVING count(c.id) > 0 ORDER BY 2`);
  const ci: any = await db.execute(sql`
    SELECT c.city AS cidade, count(*)::int AS clientes FROM customers c
     WHERE c.is_active = true AND COALESCE(c.city,'') <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 60`);
  return {
    vendedores: (v.rows || []).map((r: any) => ({ id: String(r.id), nome: r.nome || "(sem nome)", clientes: Number(r.clientes) })),
    cidades: (ci.rows || []).map((r: any) => ({ cidade: String(r.cidade), clientes: Number(r.clientes) })),
  };
}

/** Todo o histórico de comunicação de um cliente: o que saiu e o que ele respondeu. */
export async function historicoDoCliente(customerId: string) {
  const c: any = await db.execute(sql`
    SELECT id, COALESCE(NULLIF(fantasy_name,''), name) AS nome, phone, contact
      FROM customers WHERE id = ${customerId} LIMIT 1`);
  const cli = c.rows?.[0];
  if (!cli) return { cliente: null, linha: [] as any[] };
  const fone8 = String(cli.phone || "").replace(/\D/g, "").slice(-8);

  const d: any = await db.execute(sql`
    SELECT created_at, template_label, use_case::text AS use_case, status::text AS status,
           category, estimated_cost, delivered_at, read_at, error, campaign, mode
      FROM official_dispatches
     WHERE ${FONE8("customer_phone")} = ${fone8} AND ${fone8} <> ''
     ORDER BY created_at DESC LIMIT 200`);

  const m: any = await db.execute(sql`
    SELECT m.created_at AT TIME ZONE 'UTC' AS quando, m.sender_type, m.sender_id, m.content
      FROM chat_messages m JOIN chat_conversations cc ON cc.id = m.conversation_id
     WHERE ${FONE8("cc.customer_phone")} = ${fone8} AND ${fone8} <> ''
     ORDER BY m.created_at DESC LIMIT 200`);

  const linha = [
    ...(d.rows || []).map((r: any) => ({
      quando: r.created_at, especie: "disparo",
      titulo: r.template_label, tipo: r.use_case, status: r.status,
      recebida: !!r.delivered_at || ["entregue", "lida", "resposta"].includes(String(r.status)),
      lida: !!r.read_at, custo: Number(r.estimated_cost || 0),
      erro: r.error || null, modo: r.mode || null, texto: null,
    })),
    ...(m.rows || []).map((r: any) => ({
      // Mesma classificação do painel de atendimento digital. Sem o ramo
      // 'sistema', todo aviso automático (pedido criado, saiu para entrega)
      // aparecia como se um atendente tivesse digitado.
      quando: r.quando,
      especie: r.sender_type === "customer" ? "cliente"
        : String(r.sender_id || "").startsWith("agent:") ? "ia"
        : String(r.sender_id || "") === "system" ? "sistema" : "humano",
      titulo: null, tipo: String(r.sender_id || "").startsWith("agent:") ? String(r.sender_id).slice(6) : null,
      status: null, recebida: null, lida: null, custo: 0, erro: null, modo: null,
      texto: String(r.content || "").slice(0, 400),
    })),
  ].sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime());

  return { cliente: { id: String(cli.id), nome: cli.nome, telefone: cli.phone, contato: cli.contact }, linha };
}

// -----------------------------------------------------------------------------
// O ENVIO
// -----------------------------------------------------------------------------
/** Quantas variáveis {{n}} o corpo aprovado do template tem. */
export function quantasVariaveis(corpo: string | null | undefined): number {
  const m = String(corpo || "").match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  let maior = 0;
  for (const v of m) { const n = parseInt(v.replace(/\D/g, ""), 10); if (n > maior) maior = n; }
  return maior;
}

/**
 * Monta os parâmetros do template para um cliente.
 * ---------------------------------------------------------------------------
 * A quantidade de variáveis vem do CORPO APROVADO, não de uma lista fixa aqui.
 * É o que deixa trocar o texto do template no Umbler — de uma variável para
 * duas, por exemplo — sem precisar de deploy: o código preenche até onde o
 * texto pede. Se o texto pedir mais do que este painel sabe preencher, o envio
 * para AQUELE cliente é recusado com o motivo, em vez de sair uma mensagem com
 * buraco no meio.
 *
 * Ordem das variáveis, por família de mensagem:
 *   recompra  → 1 nome, 2 o que ele mais compra, 3 dias desde a última compra
 *   cobranca  → 1 contato, 2 quantidade de títulos, 3 vencimento mais antigo, 4 total
 */
async function paramsDoCliente(tipo: TipoMensagem, cli: any, vars = 1): Promise<string[] | { erro: string }> {
  const primeiro = String(cli.contato || cli.nome || "").trim().split(/\s+/)[0] || "tudo bem";
  if (tipo.id !== "cobranca") {
    const p = [primeiro];
    if (vars >= 2) {
      const prod = String(cli.produto_principal || "").trim();
      if (!prod) return { erro: "sem histórico de produto para personalizar a mensagem" };
      p.push(prod);
    }
    if (vars >= 3) {
      const dias = Number(cli.dias_sem_compra || 0);
      if (!dias) return { erro: "sem data de última compra" };
      p.push(String(dias));
    }
    if (vars > 3) return { erro: `o template pede ${vars} variáveis e o painel sabe preencher 3` };
    return p;
  }

  const r: any = await db.execute(sql`
    SELECT count(*)::int AS titulos,
           sum(r.amount - COALESCE(r.amount_paid, 0))::numeric AS total,
           min(r.due_date)::date AS antigo
      FROM receivables r
     WHERE r.customer_id = ${cli.id} AND ${sql.raw(whereDebitoVivoText("r"))}`);
  const d = r.rows?.[0];
  const titulos = Number(d?.titulos || 0);
  const total = Number(d?.total || 0);
  if (!titulos || total <= 0) return { erro: "sem débito vencido no momento do envio" };
  const dataBR = d.antigo ? new Date(d.antigo + "T12:00:00").toLocaleDateString("pt-BR") : "";
  return [
    primeiro,
    titulos === 1 ? "1 título" : `${titulos} títulos`,
    dataBR,
    total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ];
}

export async function enviarPorTipo(tipoId: string, clienteIds: string[], quem: string) {
  const tipo = tipoPorId(tipoId);
  if (!tipo) return { erro: `tipo de mensagem desconhecido: ${tipoId}` };
  const ids = Array.from(new Set((clienteIds || []).map(String).filter(Boolean)));
  if (!ids.length) return { erro: "nenhum cliente selecionado" };

  const efetivo = await escolherTemplate(tipo);
  if (!efetivo) return { erro: `nenhum template aprovado para "${tipo.nome}"` };
  const { enqueueOfficialDispatch } = await import("./official-dispatch");
  const diaCompraEnvio = sql.raw(await diaBR("sales_cards", "completed_date",
    "COALESCE(sc.completed_date, sc.updated_at, sc.created_at)"));

  // O corpo APROVADO manda na quantidade de variáveis (ver paramsDoCliente).
  const tpl: any = await db.execute(sql`SELECT corpo FROM whatsapp_templates WHERE label = ${efetivo.label} LIMIT 1`);
  const vars = Math.max(1, quantasVariaveis(tpl.rows?.[0]?.corpo));

  // Produto principal e dias sem comprar vêm junto: se o template pedir, já
  // estão aqui; uma consulta por lote, não uma por cliente.
  const c: any = await db.execute(sql`
    SELECT c.id, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome, NULLIF(c.contact,'') AS contato, c.phone,
           pp.produto AS produto_principal,
           ((now() AT TIME ZONE 'America/Sao_Paulo')::date - uc.dia) AS dias_sem_compra
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT p->>'name' AS produto
          FROM sales_cards sc,
               LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sc.products) = 'array' THEN sc.products ELSE '[]'::jsonb END) p
         WHERE sc.customer_id = c.id AND COALESCE(sc.operation_type,'venda') = 'venda'
           AND COALESCE(sc.status,'') NOT IN ('cancelled','telemarketing')
           AND COALESCE(p->>'name','') <> ''
         GROUP BY p->>'name'
         ORDER BY count(*) DESC, max(sc.created_at) DESC
         LIMIT 1) pp ON true
      LEFT JOIN LATERAL (
        SELECT ${diaCompraEnvio} AS dia
          FROM sales_cards sc
         WHERE sc.customer_id = c.id AND COALESCE(sc.operation_type,'venda') = 'venda'
           AND COALESCE(sc.status,'') NOT IN ('cancelled','telemarketing')
         ORDER BY COALESCE(sc.completed_date, sc.updated_at, sc.created_at) DESC
         LIMIT 1) uc ON true
     WHERE c.id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`);

  const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const resultados: { id: string; nome: string; resultado: string }[] = [];

  for (const cli of (c.rows || [])) {
    if (!String(cli.phone || "").replace(/\D/g, "")) {
      resultados.push({ id: String(cli.id), nome: String(cli.nome), resultado: "sem telefone" });
      continue;
    }
    const p = await paramsDoCliente(tipo, cli, vars);
    if ((p as any).erro) {
      resultados.push({ id: String(cli.id), nome: String(cli.nome), resultado: (p as any).erro });
      continue;
    }
    const r = await enqueueOfficialDispatch({
      customerId: String(cli.id),
      customerPhone: String(cli.phone),
      templateLabel: efetivo.label,
      params: p as string[],
      useCase: tipo.useCase,
      category: efetivo.categoria,
      // Uma mensagem de cada tipo por cliente por dia. A trava é a mesma que
      // protege as réguas; o painel não tem passe livre.
      campaign: `painel:${tipo.id}:${dia}`,
    });
    resultados.push({ id: String(cli.id), nome: String(cli.nome), resultado: r });
  }

  const conta = (v: string) => resultados.filter(r => r.resultado.startsWith(v)).length;
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by, updated_at)
      VALUES ('comunicacao_ultimo_envio',
              ${JSON.stringify({ tipo: tipo.id, quando: new Date().toISOString(), quem, total: resultados.length })},
              ${quem || "painel-comunicacao"}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  } catch {}

  return {
    tipo: tipo.id, template: efetivo.label, categoria: efetivo.categoria,
    enfileirados: conta("enfileirado"),
    duplicados: conta("duplicado"),
    desligado: conta("desligado"),
    optout: conta("optout"),
    invalidos: conta("invalido"),
    outros: resultados.filter(r => !/^(enfileirado|duplicado|desligado|optout|invalido)/.test(r.resultado)).length,
    resultados,
  };
}

/** Diz se cada tipo está pronto para sair: template cadastrado, aprovado e ligado. */
export async function prontidaoDosTipos() {
  const t: any = await db.execute(sql`
    SELECT label, upper(COALESCE(categoria,'')) AS categoria, umbler_id, COALESCE(is_active, true) AS ativo, corpo
      FROM whatsapp_templates`);
  const porLabel = new Map<string, any>((t.rows || []).map((r: any) => [String(r.label), r]));

  // O template pode estar perfeito e o envio ainda assim não sair, porque o
  // CASO DE USO está desligado na fila do 1841 — e aí o clique devolve
  // "desligado" sem nenhuma explicação na tela. A chave é 'oficial_<caso>'.
  const chaves = Array.from(new Set(TIPOS.map(tp => "oficial_" + tp.useCase)));
  const s: any = await db.execute(sql`SELECT key, value FROM system_settings
    WHERE key IN (${sql.join(chaves.map(k => sql`${k}`), sql`, `)})`);
  const ligado = new Map<string, string>((s.rows || [])
    .map((r: any) => [String(r.key), String(r.value ?? "").replace(/^"|"$/g, "")]));
  const { modeFor } = await import("./official-dispatch");
  const modos = new Map<string, string>();
  for (const uc of Array.from(new Set(TIPOS.map(tp => tp.useCase)))) {
    try { modos.set(uc, await modeFor(uc)); } catch { modos.set(uc, "?"); }
  }

  return TIPOS.map(tp => {
    // Mesma escolha do envio: o primeiro rótulo APROVADO da lista, e dentro
    // dele a variante '_u' quando ela existe. Sem isso a tela mostraria o
    // texto novo enquanto o disparo ainda manda o antigo.
    const rotulos = rotulosDoTipo(tp);
    let usado: any = null;
    for (const base of rotulos) {
      const b = porLabel.get(base), u = porLabel.get(base + "_u");
      const vivo = (x: any) => x && x.umbler_id && x.ativo !== false;
      const escolhido = (vivo(u) && String(u.categoria) === "UTILITY") ? u : (vivo(b) ? b : (vivo(u) ? u : null));
      if (escolhido) { usado = escolhido; break; }
    }
    if (!usado) usado = porLabel.get(rotulos[rotulos.length - 1]) || null;
    const esperando = rotulos.length > 1 && usado && String(usado.label).replace(/_u$/, "") !== rotulos[0]
      ? rotulos[0] : null;
    const casoLigado = ligado.get("oficial_" + tp.useCase) === "on";
    const modo = modos.get(tp.useCase) || "?";
    return {
      ...tp,
      templateUsado: usado ? String(usado.label) : rotulos[rotulos.length - 1],
      esperandoAprovacao: esperando,
      categoria: usado ? String(usado.categoria || "?") : "?",
      cadastrado: !!usado,
      aprovado: !!(usado && usado.umbler_id),
      ativo: !usado ? false : usado.ativo !== false,
      casoLigado, modo,
      custoUnitario: (usado && String(usado.categoria) === "UTILITY") ? 0.04 : 0.34,
      // Quando o template não existe, o painel entrega o texto pronto: sem isso
      // a pendência vira "some coisa falta" e ninguém sabe o que digitar onde.
      corpoSugerido: !usado && tp.id === "cobranca" ? CORPO_COBRANCA : null,
      // O texto que VAI SAIR. Sem isso, a única forma de descobrir que uma
      // mensagem está fraca é depois que ela chegou no cliente.
      corpoAtual: usado ? (usado.corpo || null) : null,
      variaveis: usado ? quantasVariaveis(usado.corpo) : 0,
      pendencia: !usado ? `template "${rotulos[rotulos.length - 1]}" não cadastrado — crie no Umbler como UTILITY e sincronize`
        : !usado.umbler_id ? "aguardando aprovação da Meta (sem umbler_id)"
        : usado.ativo === false ? "template desligado no cadastro"
        : !casoLigado ? `caso de uso "${tp.useCase}" desligado na fila do 1841 (oficial_${tp.useCase})`
        : modo === "off" ? `fila do 1841 em modo off para "${tp.useCase}"`
        : null,
    };
  });
}

// -----------------------------------------------------------------------------
// ROTAS
// -----------------------------------------------------------------------------
export function registerPainelComunicacaoRoutes(app: Express) {

  app.get("/api/gestao/comunicacao", authenticateUser, requireRole(PAPEIS), async (req: any, res: any) => {
    try {
      // DDL no boot já derrubou healthcheck do Railway neste projeto, então o
      // acerto de schema é preguiçoso: roda na primeira leitura do painel.
      await ensureComunicacaoSchema().catch(() => {});
      const q = req.query || {};
      const r = await listarClientes({
        vendedor: q.vendedor || "",
        tipoCliente: q.tipoCliente || "",
        atendimento: q.atendimento || "",
        diasSemCompraMin: q.diasSemCompraMin === "" || q.diasSemCompraMin == null ? undefined : Number(q.diasSemCompraMin),
        diasSemCompraMax: q.diasSemCompraMax === "" || q.diasSemCompraMax == null ? undefined : Number(q.diasSemCompraMax),
        debito: q.debito || "",
        respondeu: q.respondeu || "",
        contatada: q.contatada || "",
        incluirInativos: String(q.incluirInativos || "") === "1",
        cidade: q.cidade || "",
        busca: q.busca || "",
        limite: q.limite ? Number(q.limite) : undefined,
      });
      const [opcoes, tipos] = await Promise.all([opcoesDeFiltro(), prontidaoDosTipos()]);
      res.json({ ...r, opcoes, tipos });
    } catch (e: any) {
      console.error("[PAINEL-COMUNICACAO]", e?.message || e);
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  app.get("/api/gestao/comunicacao/cliente/:id", authenticateUser, requireRole(PAPEIS), async (req: any, res: any) => {
    try { res.json(await historicoDoCliente(String(req.params.id))); }
    catch (e: any) { res.status(500).json({ message: String(e?.message || e) }); }
  });

  // O envio é sempre um POST com a lista explícita de clientes: nunca "manda
  // para todo mundo que o filtro pegou", porque um filtro mal montado não pode
  // virar mil mensagens.
  app.post("/api/gestao/comunicacao/enviar", authenticateUser, requireRole(["admin", "coordinator"]), async (req: any, res: any) => {
    try {
      const { tipo, clientes } = req.body || {};
      const quem = req.user?.email || req.user?.id || "painel";
      const r = await enviarPorTipo(String(tipo || ""), Array.isArray(clientes) ? clientes : [], String(quem));
      if ((r as any).erro) return res.status(400).json(r);
      res.json(r);
    } catch (e: any) {
      console.error("[PAINEL-COMUNICACAO/ENVIAR]", e?.message || e);
      res.status(500).json({ message: String(e?.message || e) });
    }
  });
}
