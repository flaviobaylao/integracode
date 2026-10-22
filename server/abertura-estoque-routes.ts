import type { Express, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { hojeBR } from "@shared/tempo";

// ===========================================================================
// ABERTURA DE ESTOQUE DO DIA (22/out/2026)
//
// Todo dia, ANTES do primeiro faturamento, um dos responsáveis (Flávio, Lanucy,
// Cinthia ou Naiara — mesmos destinos dos Chamados, configuráveis em
// system_settings.chamados_destinos) registra a CONTAGEM FÍSICA do estoque de
// produto acabado do escritório (GYN + SERV).
//
// Para cada produto o sistema calcula a quantidade ESPERADA:
//     esperado = estoque em sistema GYN (em uso + bloqueado)
//              + estoque em sistema SERV (em uso + bloqueado)
//              + itens JÁ FATURADOS que AINDA NÃO ENTRARAM EM ROTA
//                (cards do pipeline das instâncias GYN/SERV nas etapas entre
//                 'faturado' e 'em_rota': faturado, impresso, aguardando_rota,
//                 bsb, aguardando_rota_bsb, outras_cidades — a baixa de estoque
//                 já aconteceu no faturamento, mas a mercadoria ainda está no
//                 depósito até sair em rota)
//
// Regras:
//   - Sem abertura do dia, NENHUM faturamento pelo pipeline acontece: a rota
//     devolve 400 { aberturaEstoqueError: true } (pop-up no Pipeline) e os
//     responsáveis flavio/lanucy/naiara recebem um chamado
//     "NOTIFICACAO - TENTATIVA DE FATURAMENTO SEM ABERTURA DE ESTOQUE DIA"
//     (1 chamado por destino por dia; tentativas seguintes viram mensagem).
//   - Abertura com divergência (físico ≠ esperado) abre um chamado POR PRODUTO
//     "NOTIFICACAO - DIVERGENCIA EM ABERTURA DE ESTOQUE - PRODUTO "X"" para
//     flavio/naiara/lanucy, com a divergência no corpo.
//   - Uma abertura por dia. Refazer (mesmo grupo de usuários) substitui as
//     quantidades e renotifica só os produtos que continuam divergentes.
//
// Tabelas criadas sob demanda (fora do schema drizzle):
//   estoque_abertura_dia   — 1 linha por dia (quem abriu, quando, nº divergências)
//   estoque_abertura_itens — 1 linha por produto da abertura (esperado × físico)
//   estoque_abertura_tentativas — tentativas de faturamento sem abertura (trilha)
// ===========================================================================

const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];
const EPS = 0.0001;
const INSTANCIAS_CONTADAS = ["GYN", "SERV"]; // nome em omie_instances.name (maiúsculo)
// Etapas do pipeline em que o pedido JÁ FOI FATURADO (estoque baixado) mas a
// mercadoria AINDA NÃO SAIU do depósito.
export const ETAPAS_FATURADO_SEM_ROTA = ["faturado", "impresso", "aguardando_rota", "bsb", "aguardando_rota_bsb", "outras_cidades"];
const DESTINOS_ABERTURA = ["flavio", "lanucy", "cinthia", "naiara"]; // quem pode abrir o dia
const DESTINOS_NOTIFICACAO = ["flavio", "lanucy", "naiara"];          // quem é notificado
export const TITULO_SEM_ABERTURA = "NOTIFICACAO - TENTATIVA DE FATURAMENTO SEM ABERTURA DE ESTOQUE DIA";
export const tituloDivergencia = (produto: string) => `NOTIFICACAO - DIVERGENCIA EM ABERTURA DE ESTOQUE - PRODUTO "${produto}"`;
const APP_URL = process.env.APP_URL || "https://integracode-production.up.railway.app";

let ensured: Promise<void> | null = null;
export function ensureAberturaEstoqueSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS estoque_abertura_dia (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        data date NOT NULL UNIQUE,
        aberto_por varchar NOT NULL,
        aberto_por_nome varchar,
        observacao text,
        total_itens integer NOT NULL DEFAULT 0,
        divergencias integer NOT NULL DEFAULT 0,
        refeita_em timestamp,
        refeita_por varchar,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS estoque_abertura_itens (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        abertura_id varchar NOT NULL,
        data date NOT NULL,
        product_id varchar NOT NULL,
        product_name varchar,
        qtd_gyn_em_uso numeric(14,4) NOT NULL DEFAULT 0,
        qtd_gyn_bloqueado numeric(14,4) NOT NULL DEFAULT 0,
        qtd_serv_em_uso numeric(14,4) NOT NULL DEFAULT 0,
        qtd_serv_bloqueado numeric(14,4) NOT NULL DEFAULT 0,
        qtd_faturado_sem_rota numeric(14,4) NOT NULL DEFAULT 0,
        qtd_esperada numeric(14,4) NOT NULL DEFAULT 0,
        qtd_fisica numeric(14,4),
        divergencia numeric(14,4),
        pedidos jsonb,
        chamado_ids jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_estoque_abertura_itens_ab ON estoque_abertura_itens (abertura_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_estoque_abertura_itens_data ON estoque_abertura_itens (data, product_id)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS estoque_abertura_tentativas (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        data date NOT NULL,
        user_id varchar,
        user_nome varchar,
        user_email varchar,
        rota varchar,
        pedidos jsonb,
        chamado_ids jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_estoque_abertura_tent_data ON estoque_abertura_tentativas (data)`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

async function getSetting(key: string): Promise<string | null> {
  try { return rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`))[0]?.value ?? null; } catch { return null; }
}

// Kill-switch: system_settings 'abertura_estoque_ativa' = 'off' desliga a exigência (nasce ligada).
async function exigenciaAtiva(): Promise<boolean> {
  return (await getSetting("abertura_estoque_ativa")) !== "off";
}

const nomeDe = (u: any): string => {
  const n = [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();
  return n || u?.email || "Usuário";
};
const fmtQ = (v: any) => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

// ---------- quem pode abrir o dia ----------
// Responsáveis EXTRAS (fora dos destinos de Chamados). Regra do Flavio (22/out): o Robson
// (telemarketing) também registra a abertura. Configurável em
// system_settings 'abertura_estoque_extra' = JSON [{ emails?: [], nomeLike?: [] , userIds?: [] }]
// (substitui o padrão quando presente).
type Extra = { emails?: string[]; nomeLike?: string[]; userIds?: string[] };
const EXTRAS_PADRAO: Extra[] = [{ nomeLike: ["robson"] }];
async function responsaveisExtras(): Promise<Set<string>> {
  let cfg: Extra[] = EXTRAS_PADRAO;
  const raw = await getSetting("abertura_estoque_extra");
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) cfg = p; } catch { /* padrão */ } }
  const ids = new Set<string>();
  if (!cfg.length) return ids;
  const users = rows(await db.execute(sql`SELECT id, lower(coalesce(email,'')) AS email, lower(coalesce(first_name,'')) AS fn FROM users WHERE is_active = true`));
  for (const e of cfg) {
    for (const id of e.userIds || []) ids.add(String(id));
    const emails = (e.emails || []).map((x) => x.toLowerCase());
    for (const u of users) if (emails.includes(u.email)) ids.add(String(u.id));
    for (const pat of e.nomeLike || []) {
      const pre = pat.toLowerCase().replace(/%$/, "");
      for (const u of users) if (u.fn.startsWith(pre) || u.email.startsWith(pre)) ids.add(String(u.id));
    }
  }
  return ids;
}

async function responsaveis(): Promise<{ podeAbrir: Set<string>; destinos: any[] }> {
  const { getDestinos } = await import("./chamados-routes");
  const destinos = await getDestinos();
  const podeAbrir = await responsaveisExtras();
  for (const d of destinos) if (DESTINOS_ABERTURA.includes(d.key)) for (const id of d.userIds) podeAbrir.add(String(id));
  return { podeAbrir, destinos };
}
export async function podeAbrirDia(user: any): Promise<boolean> {
  if (!user?.id) return false;
  const { podeAbrir } = await responsaveis();
  return podeAbrir.has(String(user.id));
}

// ---------- instâncias contadas ----------
async function instanciasContadas(): Promise<Array<{ id: string; name: string }>> {
  const r = rows(await db.execute(sql`SELECT id, upper(trim(name)) AS name FROM omie_instances WHERE is_active = true`));
  return r.filter((i) => INSTANCIAS_CONTADAS.includes(String(i.name))).map((i) => ({ id: String(i.id), name: String(i.name) }));
}

// ---------- cálculo da quantidade esperada por produto ----------
export type LinhaEsperada = {
  productId: string; productName: string;
  gynEmUso: number; gynBloqueado: number; servEmUso: number; servBloqueado: number;
  faturadoSemRota: number; esperado: number;
  pedidos: Array<{ id: string; orderNumber: string | null; customerName: string; stage: string; instancia: string | null; quantidade: number }>;
};

export async function calcularEsperado(): Promise<{ linhas: LinhaEsperada[]; instancias: Array<{ id: string; name: string }>; avisos: string[] }> {
  const inst = await instanciasContadas();
  const avisos: string[] = [];
  for (const n of INSTANCIAS_CONTADAS) if (!inst.find((i) => i.name === n)) avisos.push(`Instância ${n} não encontrada/ativa em omie_instances — não entrou na soma.`);
  const porNome = new Map(inst.map((i) => [i.id, i.name]));
  const mapa = new Map<string, LinhaEsperada>();
  const linha = (pid: string, nome: string) => {
    let l = mapa.get(pid);
    if (!l) { l = { productId: pid, productName: nome, gynEmUso: 0, gynBloqueado: 0, servEmUso: 0, servBloqueado: 0, faturadoSemRota: 0, esperado: 0, pedidos: [] }; mapa.set(pid, l); }
    return l;
  };

  // Produtos ativos do catálogo (produto acabado; insumos vivem em tabelas próprias)
  const prods = rows(await db.execute(sql`SELECT id, name FROM products WHERE is_active = true AND COALESCE(internal_only, false) = false ORDER BY name`));
  for (const p of prods) linha(String(p.id), String(p.name));

  // 1) Estoque em sistema (lotes ativos) nas instâncias contadas
  if (inst.length) {
    const ids = sql.join(inst.map((i) => sql`${i.id}`), sql`, `);
    const lots = rows(await db.execute(sql`
      SELECT il.product_id, il.instance_id, pr.name,
             COALESCE(SUM(CASE WHEN il.stock_type = 'in_use' THEN il.quantity ELSE 0 END), 0)::float8 AS em_uso,
             COALESCE(SUM(CASE WHEN il.stock_type <> 'in_use' THEN il.quantity ELSE 0 END), 0)::float8 AS bloqueado
      FROM inventory_lots il JOIN products pr ON pr.id = il.product_id
      WHERE COALESCE(il.is_active, true) AND il.instance_id IN (${ids})
      GROUP BY il.product_id, il.instance_id, pr.name`));
    for (const r of lots) {
      const l = linha(String(r.product_id), String(r.name));
      const nome = porNome.get(String(r.instance_id));
      if (nome === "GYN") { l.gynEmUso += Number(r.em_uso) || 0; l.gynBloqueado += Number(r.bloqueado) || 0; }
      else if (nome === "SERV") { l.servEmUso += Number(r.em_uso) || 0; l.servBloqueado += Number(r.bloqueado) || 0; }
    }

    // 2) Faturado e ainda não em rota (estoque já baixado, mercadoria no depósito).
    //    Exclui cards cuja NF mais recente foi cancelada/devolvida (estoque estornado).
    const etapas = sql.join(ETAPAS_FATURADO_SEM_ROTA.map((s) => sql`${s}`), sql`, `);
    const cards = rows(await db.execute(sql`
      SELECT bp.id, bp.order_number, bp.customer_name, bp.stage::text AS stage, bp.omie_instance_id, bp.products
      FROM billing_pipeline bp
      WHERE bp.stage::text IN (${etapas})
        AND bp.omie_instance_id IN (${ids})
        AND NOT EXISTS (
          SELECT 1 FROM fiscal_invoices f
          WHERE f.sales_card_id = bp.sales_card_id
            AND lower(coalesce(f.status,'')) IN ('cancelled','canceled','cancelada','returned','devolvida','devolvido')
            AND NOT EXISTS (SELECT 1 FROM fiscal_invoices f2 WHERE f2.sales_card_id = bp.sales_card_id AND f2.created_at > f.created_at
                              AND lower(coalesce(f2.status,'')) NOT IN ('cancelled','canceled','cancelada','returned','devolvida','devolvido')))`));
    for (const c of cards) {
      let prodsCard: any[] = [];
      try { prodsCard = Array.isArray(c.products) ? c.products : JSON.parse(String(c.products || "[]")); } catch { prodsCard = []; }
      for (const p of prodsCard) {
        const pid = String(p?.id || p?.productId || "");
        const q = Number(p?.quantity) || 0;
        if (!pid || q <= 0) continue;
        const l = linha(pid, String(p?.name || pid));
        l.faturadoSemRota += q;
        l.pedidos.push({ id: String(c.id), orderNumber: c.order_number ? String(c.order_number) : null, customerName: String(c.customer_name || ""), stage: String(c.stage), instancia: porNome.get(String(c.omie_instance_id)) || null, quantidade: q });
      }
    }
  }

  const linhas = Array.from(mapa.values()).map((l) => ({ ...l, esperado: l.gynEmUso + l.gynBloqueado + l.servEmUso + l.servBloqueado + l.faturadoSemRota }));
  // Produto sem nada em sistema nem faturado pendente continua na lista (físico pode ter sobra) — ordena por nome.
  linhas.sort((a, b) => a.productName.localeCompare(b.productName, "pt-BR"));
  return { linhas, instancias: inst, avisos };
}

// ---------- abertura do dia ----------
export async function aberturaDoDia(data = hojeBR()): Promise<any | null> {
  await ensureAberturaEstoqueSchema();
  const a = rows(await db.execute(sql`SELECT * FROM estoque_abertura_dia WHERE data = ${data}::date LIMIT 1`))[0];
  return a || null;
}

// Usado pelas rotas de faturamento. Devolve ok=true quando pode faturar.
// Quando NÃO pode: registra a tentativa, notifica os responsáveis por chamado
// (1 por destino por dia; repetição vira mensagem) e devolve a mensagem do pop-up.
export async function exigirAberturaDoDia(user: any, ctx: { rota: string; pedidos?: Array<{ id: string; orderNumber?: string | null; customerName?: string | null }> }): Promise<{ ok: true } | { ok: false; status: number; body: any }> {
  try {
    if (!(await exigenciaAtiva())) return { ok: true };
    const hoje = hojeBR();
    const ab = await aberturaDoDia(hoje);
    if (ab) return { ok: true };

    const quem = nomeDe(user);
    const email = String(user?.email || "");
    const dataFmt = hoje.split("-").reverse().join("/");
    const pedidosTxt = (ctx.pedidos || []).slice(0, 15).map((p) => `• ${p.orderNumber ? `Pedido ${p.orderNumber} — ` : ""}${p.customerName || p.id}`).join("\n");
    const descricao = [
      `O usuário ${quem}${email ? ` (${email})` : ""} tentou FATURAR em ${dataFmt} antes da Abertura de Estoque do Dia.`,
      `O faturamento foi BLOQUEADO pelo sistema.`,
      pedidosTxt ? `\nPedido(s) envolvido(s):\n${pedidosTxt}${(ctx.pedidos || []).length > 15 ? `\n… e mais ${(ctx.pedidos || []).length - 15}` : ""}` : "",
      `\nOrigem: ${ctx.rota}`,
      `\nPara liberar os faturamentos, um responsável (Flávio, Lanucy, Cinthia ou Naiara) precisa registrar a contagem física em ${APP_URL}/abertura-estoque.`,
    ].filter(Boolean).join("\n");

    let chamadoIds: string[] = [];
    try {
      const { abrirChamadoSistema } = await import("./chamados-routes");
      chamadoIds = await abrirChamadoSistema({
        destinoKeys: DESTINOS_NOTIFICACAO, assunto: TITULO_SEM_ABERTURA, descricao, prioridade: "Urgente",
        autor: user?.id ? { id: String(user.id), nome: quem, role: String(user.role || "") } : null, dedupeHoje: true,
      });
    } catch (e: any) { console.error("[abertura-estoque] falha ao abrir chamado:", e?.message || e); }
    try {
      await db.execute(sql`INSERT INTO estoque_abertura_tentativas (data, user_id, user_nome, user_email, rota, pedidos, chamado_ids)
        VALUES (${hoje}::date, ${user?.id ? String(user.id) : null}, ${quem}, ${email || null}, ${ctx.rota}, ${JSON.stringify(ctx.pedidos || [])}::jsonb, ${JSON.stringify(chamadoIds)}::jsonb)`);
    } catch (e: any) { console.warn("[abertura-estoque] trilha da tentativa:", e?.message || e); }

    const pode = await podeAbrirDia(user).catch(() => false);
    return {
      ok: false, status: 400,
      body: {
        message: "Faturamento bloqueado: a Abertura de Estoque do Dia ainda não foi feita",
        aberturaEstoqueError: true,
        data: hoje,
        podeAbrir: pode,
        details: `Nenhum faturamento pode começar em ${dataFmt} enquanto a contagem física do estoque (GYN + SERV) não for registrada na tela Abertura de Estoque do Dia.\n\n` +
          (pode ? "Você tem permissão para fazer a abertura: acesse Produtos & Estoque › Abertura de Estoque do Dia, informe as quantidades físicas e volte a faturar."
                : "Peça a um responsável (Flávio, Lanucy, Cinthia ou Naiara) para registrar a abertura. Eles já foram notificados por chamado desta tentativa."),
      },
    };
  } catch (e: any) {
    // Falha interna da conferência não pode derrubar o faturamento: loga e deixa passar.
    console.error("[abertura-estoque] exigirAberturaDoDia falhou (liberando):", e?.message || e);
    return { ok: true };
  }
}

// ---------- rotas ----------
export function registerAberturaEstoque(app: Express) {
  // Leve, para o menu: este usuário pode registrar a abertura? (libera o item para
  // responsáveis fora dos perfis de gestão, ex. telemarketing)
  app.get("/api/abertura-estoque/acesso", authenticateUser, async (req: any, res: Response) => {
    try { res.json({ podeAbrir: await podeAbrirDia(req.currentUser) }); } catch { res.json({ podeAbrir: false }); }
  });

  // Estado do dia + linhas esperadas (para montar a tela). Qualquer usuário autenticado
  // pode VER (o pipeline precisa saber se está aberto); só responsáveis podem gravar.
  app.get("/api/abertura-estoque/hoje", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureAberturaEstoqueSchema();
      const hoje = hojeBR();
      const ab = await aberturaDoDia(hoje);
      const podeAbrir = await podeAbrirDia(req.currentUser);
      const ativa = await exigenciaAtiva();
      let itens: any[] = [];
      if (ab) {
        itens = rows(await db.execute(sql`SELECT * FROM estoque_abertura_itens WHERE abertura_id = ${String(ab.id)} ORDER BY product_name`));
      }
      const calc = req.query.calcular === "0" && ab ? null : await calcularEsperado();
      const tentativas = rows(await db.execute(sql`SELECT user_nome, user_email, rota, created_at FROM estoque_abertura_tentativas WHERE data = ${hoje}::date ORDER BY created_at DESC LIMIT 50`));
      res.json({
        data: hoje, ativa, podeAbrir, aberta: !!ab,
        abertura: ab ? { id: ab.id, abertoPor: ab.aberto_por_nome, em: ab.created_at, observacao: ab.observacao, totalItens: ab.total_itens, divergencias: ab.divergencias, refeitaEm: ab.refeita_em, refeitaPor: ab.refeita_por } : null,
        itens: itens.map((i) => ({
          productId: i.product_id, productName: i.product_name,
          gynEmUso: Number(i.qtd_gyn_em_uso), gynBloqueado: Number(i.qtd_gyn_bloqueado), servEmUso: Number(i.qtd_serv_em_uso), servBloqueado: Number(i.qtd_serv_bloqueado),
          faturadoSemRota: Number(i.qtd_faturado_sem_rota), esperado: Number(i.qtd_esperada), fisico: i.qtd_fisica === null ? null : Number(i.qtd_fisica), divergencia: i.divergencia === null ? null : Number(i.divergencia),
          pedidos: i.pedidos || [], chamadoIds: i.chamado_ids || [],
        })),
        esperadoAgora: calc ? calc.linhas : null,
        instancias: calc ? calc.instancias : [],
        avisos: calc ? calc.avisos : [],
        tentativas,
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Histórico (últimos N dias)
  app.get("/api/abertura-estoque/historico", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureAberturaEstoqueSchema();
      const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
      const lista = rows(await db.execute(sql`SELECT * FROM estoque_abertura_dia WHERE data >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - ${dias}::int ORDER BY data DESC`));
      res.json(lista.map((a) => ({ id: a.id, data: String(a.data).slice(0, 10), abertoPor: a.aberto_por_nome, em: a.created_at, totalItens: a.total_itens, divergencias: a.divergencias, observacao: a.observacao, refeitaEm: a.refeita_em, refeitaPor: a.refeita_por })));
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.get("/api/abertura-estoque/:id/itens", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureAberturaEstoqueSchema();
      const itens = rows(await db.execute(sql`SELECT * FROM estoque_abertura_itens WHERE abertura_id = ${String(req.params.id)} ORDER BY product_name`));
      res.json(itens.map((i) => ({
        productId: i.product_id, productName: i.product_name,
        gynEmUso: Number(i.qtd_gyn_em_uso), gynBloqueado: Number(i.qtd_gyn_bloqueado), servEmUso: Number(i.qtd_serv_em_uso), servBloqueado: Number(i.qtd_serv_bloqueado),
        faturadoSemRota: Number(i.qtd_faturado_sem_rota), esperado: Number(i.qtd_esperada), fisico: i.qtd_fisica === null ? null : Number(i.qtd_fisica), divergencia: i.divergencia === null ? null : Number(i.divergencia),
        pedidos: i.pedidos || [], chamadoIds: i.chamado_ids || [],
      })));
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Registrar a abertura do dia. body: { itens: [{ productId, fisico }], observacao?, refazer? }
  // O esperado é RECALCULADO no servidor no momento da gravação (não confia no cliente).
  app.post("/api/abertura-estoque", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureAberturaEstoqueSchema();
      const u = req.currentUser;
      if (!(await podeAbrirDia(u))) return res.status(403).json({ message: "Só Flávio, Lanucy, Cinthia ou Naiara podem registrar a Abertura de Estoque do Dia" });
      const hoje = hojeBR();
      const existente = await aberturaDoDia(hoje);
      const refazer = !!req.body?.refazer;
      if (existente && !refazer) return res.status(409).json({ message: `A abertura de ${hoje.split("-").reverse().join("/")} já foi registrada por ${existente.aberto_por_nome || "outro usuário"}. Use "Refazer abertura" para substituir.`, jaAberta: true });

      const informados = new Map<string, number>();
      for (const it of (Array.isArray(req.body?.itens) ? req.body.itens : [])) {
        const pid = String(it?.productId || "");
        const v = it?.fisico === "" || it?.fisico === null || it?.fisico === undefined ? NaN : Number(String(it.fisico).replace(",", "."));
        if (pid && Number.isFinite(v) && v >= 0) informados.set(pid, v);
      }
      const { linhas } = await calcularEsperado();
      const faltando = linhas.filter((l) => !informados.has(l.productId));
      if (faltando.length) return res.status(400).json({ message: `Informe a quantidade física de todos os produtos (${faltando.length} sem preenchimento: ${faltando.slice(0, 5).map((l) => l.productName).join(", ")}${faltando.length > 5 ? "…" : ""})`, faltando: faltando.map((l) => l.productId) });

      const quem = nomeDe(u);
      const observacao = String(req.body?.observacao || "").trim() || null;
      let aberturaId: string;
      if (existente) {
        aberturaId = String(existente.id);
        await db.execute(sql`DELETE FROM estoque_abertura_itens WHERE abertura_id = ${aberturaId}`);
        await db.execute(sql`UPDATE estoque_abertura_dia SET refeita_em = now(), refeita_por = ${quem}, observacao = COALESCE(${observacao}, observacao), updated_at = now() WHERE id = ${aberturaId}`);
      } else {
        const ins = rows(await db.execute(sql`INSERT INTO estoque_abertura_dia (data, aberto_por, aberto_por_nome, observacao) VALUES (${hoje}::date, ${String(u.id)}, ${quem}, ${observacao}) RETURNING id`));
        aberturaId = String(ins[0].id);
      }

      const divergentes: Array<LinhaEsperada & { fisico: number; divergencia: number }> = [];
      for (const l of linhas) {
        const fisico = informados.get(l.productId)!;
        const div = fisico - l.esperado;
        const r = rows(await db.execute(sql`INSERT INTO estoque_abertura_itens
          (abertura_id, data, product_id, product_name, qtd_gyn_em_uso, qtd_gyn_bloqueado, qtd_serv_em_uso, qtd_serv_bloqueado, qtd_faturado_sem_rota, qtd_esperada, qtd_fisica, divergencia, pedidos)
          VALUES (${aberturaId}, ${hoje}::date, ${l.productId}, ${l.productName}, ${l.gynEmUso}, ${l.gynBloqueado}, ${l.servEmUso}, ${l.servBloqueado}, ${l.faturadoSemRota}, ${l.esperado}, ${fisico}, ${div}, ${JSON.stringify(l.pedidos)}::jsonb)
          RETURNING id`));
        if (Math.abs(div) > EPS) divergentes.push({ ...l, fisico, divergencia: div, ...( { _itemId: String(r[0].id) } as any) });
      }
      await db.execute(sql`UPDATE estoque_abertura_dia SET total_itens = ${linhas.length}, divergencias = ${divergentes.length}, updated_at = now() WHERE id = ${aberturaId}`);

      // Notificação por produto divergente (chamado para flavio/naiara/lanucy)
      const dataFmt = hoje.split("-").reverse().join("/");
      let notificados = 0;
      if (divergentes.length) {
        try {
          const { abrirChamadoSistema } = await import("./chamados-routes");
          for (const d of divergentes) {
            const sinal = d.divergencia > 0 ? "SOBRA" : "FALTA";
            const pedidosTxt = d.pedidos.slice(0, 20).map((p) => `   • ${p.orderNumber ? `Pedido ${p.orderNumber} — ` : ""}${p.customerName} (${p.stage}${p.instancia ? `, ${p.instancia}` : ""}): ${fmtQ(p.quantidade)}`).join("\n");
            const descricao = [
              `DIVERGÊNCIA na Abertura de Estoque de ${dataFmt}${existente ? " (abertura REFEITA)" : ""} — produto "${d.productName}".`,
              ``,
              `Contagem física informada por ${quem}: ${fmtQ(d.fisico)}`,
              `Quantidade esperada pelo sistema:        ${fmtQ(d.esperado)}`,
              `Divergência: ${d.divergencia > 0 ? "+" : ""}${fmtQ(d.divergencia)} (${sinal} de ${fmtQ(Math.abs(d.divergencia))} un.)`,
              ``,
              `Composição do esperado:`,
              `   Estoque em sistema GYN:  ${fmtQ(d.gynEmUso + d.gynBloqueado)} (em uso ${fmtQ(d.gynEmUso)} + bloqueado ${fmtQ(d.gynBloqueado)})`,
              `   Estoque em sistema SERV: ${fmtQ(d.servEmUso + d.servBloqueado)} (em uso ${fmtQ(d.servEmUso)} + bloqueado ${fmtQ(d.servBloqueado)})`,
              `   Faturado e ainda não em rota: ${fmtQ(d.faturadoSemRota)}${d.pedidos.length ? `\n${pedidosTxt}${d.pedidos.length > 20 ? `\n   … e mais ${d.pedidos.length - 20} pedido(s)` : ""}` : ""}`,
              observacao ? `\nObservação de quem abriu: ${observacao}` : "",
              `\nVer a abertura: ${APP_URL}/abertura-estoque`,
            ].filter((x) => x !== "").join("\n");
            const ids = await abrirChamadoSistema({
              destinoKeys: DESTINOS_NOTIFICACAO, assunto: tituloDivergencia(d.productName), descricao, prioridade: "Urgente",
              autor: { id: String(u.id), nome: quem, role: String(u.role || "") },
            });
            notificados += ids.length;
            await db.execute(sql`UPDATE estoque_abertura_itens SET chamado_ids = ${JSON.stringify(ids)}::jsonb WHERE id = ${(d as any)._itemId}`);
          }
        } catch (e: any) { console.error("[abertura-estoque] notificação de divergência:", e?.message || e); }
      }

      // Pipeline pode usar cache de status de estoque; invalida por segurança.
      try { const m: any = await import("./billing-pipeline-routes"); m.invalidarStockStatus?.(); } catch { /* opcional */ }

      res.json({
        ok: true, id: aberturaId, data: hoje, refeita: !!existente, totalItens: linhas.length,
        divergencias: divergentes.map((d) => ({ productId: d.productId, productName: d.productName, esperado: d.esperado, fisico: d.fisico, divergencia: d.divergencia })),
        chamadosAbertos: notificados,
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
}
