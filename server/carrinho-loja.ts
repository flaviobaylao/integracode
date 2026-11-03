// ============================================================================
// CARRINHOS DA LOJA (loja.bebahonest.com.br) — presença, carrinho abandonado e
// recuperação por WhatsApp — 02/nov/2026
// ----------------------------------------------------------------------------
// Pedido do Flavio: saber quando um cliente está na loja e quando deixou o
// carrinho sem finalizar, avisar a equipe e mandar ao cliente uma mensagem de
// recuperação com o link do carrinho.
//
// Como funciona:
//   • A loja (hotsite/src/utils/carrinho.ts) manda POST /api/public/carrinho/sync
//     a cada mudança do carrinho/etapa e um "estou aqui" a cada 60 s enquanto a
//     aba está visível. Cada navegador tem um sessao_id próprio (localStorage).
//   • Assim que o cliente digita o WhatsApp no checkout, o contato vai junto
//     (é aqui que a visita deixa de ser anônima — antes disso não sabemos quem é).
//   • Pedido concluído → POST /api/public/carrinho/convertido. Rede de segurança:
//     a varredura também procura no order_journal um pedido do mesmo telefone.
//   • Varredura a cada 5 min: carrinho com telefone, itens e sem atividade há
//     `carrinho_abandono_min` (padrão 60) vira ABANDONADO → aviso à equipe por
//     WhatsApp + (se `carrinho_msg_auto` = on, das 8h às 20h) mensagem ao cliente
//     com o link https://loja.bebahonest.com.br/shop?carrinho=<token>, que
//     devolve o carrinho na loja. Uma mensagem por carrinho, nunca duas.
//
// Settings (system_settings):
//   carrinho_abandono_min      minutos sem atividade para considerar abandono (60)
//   carrinho_msg_auto          'on' | 'off' — mensagem automática ao cliente (on)
//   carrinho_aviso_equipe      'on' | 'off' — aviso para a equipe (on)
//   carrinho_aviso_telefones   destinos do aviso (vazio = telefone_gestor_relatorios)
//   carrinho_loja_url          base do link (https://loja.bebahonest.com.br)
//
// Privacidade: nada de CPF/endereço aqui. Só nome/telefone/e-mail que o próprio
// cliente digitou no checkout, itens e valor. Quem pede SAIR não recebe mais.
// ============================================================================
import type { Express } from "express";
import cron from "node-cron";
import { randomBytes } from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole, rateLimitPorIp } from "./authMiddleware";
import { sendUmblerTalkText } from "./chat-routes";

const TZ = "America/Sao_Paulo";
const rows = (r: any) => (r?.rows ?? r ?? []) as any[];
const PAPEIS = ["admin", "coordinator", "administrative", "telemarketing"];
const ETAPAS = ["catalogo", "carrinho", "checkout", "pix", "cartao", "sucesso"];
const ONLINE_SEG = 150; // "na loja agora" = sinal nos últimos 2,5 min

const so = (s: any) => String(s ?? "").replace(/\D/g, "");
const brl = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function setting(key: string): Promise<string> {
  try { return String(rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`))[0]?.value ?? "").trim(); } catch { return ""; }
}
async function setSetting(key: string, value: string, by: string) {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, ${by})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
}

export async function getConfigCarrinho() {
  const min = Number(await setting("carrinho_abandono_min")) || 60;
  const auto = (await setting("carrinho_msg_auto")) || "on";
  const aviso = (await setting("carrinho_aviso_equipe")) || "on";
  const tels = await setting("carrinho_aviso_telefones");
  const url = (await setting("carrinho_loja_url")) || "https://loja.bebahonest.com.br";
  return {
    abandonoMin: Math.min(Math.max(min, 15), 24 * 60),
    msgAuto: auto === "on",
    avisoEquipe: aviso === "on",
    avisoTelefones: tels,
    lojaUrl: url.replace(/\/+$/, ""),
  };
}

let _schemaOk = false;
export async function ensureCarrinhoLojaSchema() {
  if (_schemaOk) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS hotsite_carrinhos (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
    sessao_id varchar NOT NULL UNIQUE,
    token varchar NOT NULL UNIQUE,
    nome varchar, telefone varchar, email varchar,
    tipo_cliente varchar, tabela varchar,
    itens jsonb NOT NULL DEFAULT '[]'::jsonb,
    qtd_itens integer NOT NULL DEFAULT 0,
    total numeric(12,2) NOT NULL DEFAULT 0,
    etapa varchar NOT NULL DEFAULT 'catalogo',
    status varchar NOT NULL DEFAULT 'aberto',          -- aberto | abandonado | convertido | descartado
    utm jsonb, user_agent varchar,
    visitas integer NOT NULL DEFAULT 1,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    ultima_atividade timestamptz NOT NULL DEFAULT now(),
    contato_em timestamptz,
    abandonado_em timestamptz,
    aviso_equipe_em timestamptz,
    msg_cliente_em timestamptz,
    msg_cliente_status varchar,
    msg_cliente_por varchar,
    recuperado_em timestamptz,
    convertido_em timestamptz,
    pedido_numero varchar,
    observacao text
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_hotsite_carrinhos_status ON hotsite_carrinhos (status, ultima_atividade)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_hotsite_carrinhos_atividade ON hotsite_carrinhos (ultima_atividade DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_hotsite_carrinhos_tel ON hotsite_carrinhos (telefone)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS hotsite_carrinho_optout (
    telefone varchar PRIMARY KEY, criado_em timestamptz NOT NULL DEFAULT now(), origem varchar
  )`);
  _schemaOk = true;
}

// ── Sanitização do que vem da loja (rota pública: nada é confiável) ─────────
type ItemLoja = { id: string; n: string; p: number; q: number };
function limparItens(raw: any): ItemLoja[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 60).map((i: any) => ({
    id: String(i?.id ?? "").slice(0, 80),
    n: String(i?.n ?? i?.name ?? "").slice(0, 120),
    p: Math.max(0, Math.min(Number(i?.p ?? i?.price) || 0, 100000)),
    q: Math.max(0, Math.min(Math.round(Number(i?.q ?? i?.quantity) || 0), 10000)),
  })).filter((i) => i.id && i.q > 0);
}
function limparUtm(raw: any): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 12)) out[String(k).slice(0, 40)] = String(v ?? "").slice(0, 200);
  return Object.keys(out).length ? out : null;
}
const resumoItens = (itens: ItemLoja[], max = 4) => {
  const partes = itens.slice(0, max).map((i) => `${i.q}x ${i.n}`);
  if (itens.length > max) partes.push(`+${itens.length - max} item(ns)`);
  return partes.join(", ");
};
const primeiroNome = (n: any) => {
  const p = String(n || "").trim().split(/\s+/)[0] || "";
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : "";
};
function horaBR(): number {
  return Number(new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
}
function telefoneWhats(t: string): string {
  const d = so(t);
  if (d.length === 10 || d.length === 11) return "55" + d;
  return d;
}

// ── Mensagens ───────────────────────────────────────────────────────────────
export function textoRecuperacao(c: any, lojaUrl: string): string {
  const nome = primeiroNome(c.nome);
  const itens: ItemLoja[] = Array.isArray(c.itens) ? c.itens : [];
  const link = `${lojaUrl}/shop?carrinho=${c.token}`;
  return [
    `Oi${nome ? `, ${nome}` : ""}! Aqui é da Honest 🍊`,
    ``,
    `Vimos que você separou ${resumoItens(itens)} (${brl(c.total)}) na nossa loja e não chegou a finalizar o pedido.`,
    ``,
    `Seu carrinho está guardado. É só tocar no link para concluir:`,
    link,
    ``,
    `Ficou alguma dúvida sobre entrega ou pagamento? Responda esta mensagem que a gente te ajuda.`,
    `(Se não quiser receber este tipo de aviso, responda SAIR.)`,
  ].join("\n");
}

function textoEquipe(cs: any[], msgAuto: boolean): string {
  const linhas = cs.slice(0, 15).map((c) => {
    const itens: ItemLoja[] = Array.isArray(c.itens) ? c.itens : [];
    const env = c.msg_cliente_status === "enviada" ? "✅ msg enviada ao cliente" : c.msg_cliente_status ? `⚠️ msg: ${c.msg_cliente_status}` : msgAuto ? "⏳ msg ao cliente na próxima janela (8h–20h)" : "✋ msg automática desligada";
    return `• ${c.nome || "(sem nome)"} · ${c.telefone || "-"} · ${brl(c.total)} · parou em: ${c.etapa}\n  ${resumoItens(itens, 3)}\n  ${env}`;
  });
  const extra = cs.length > 15 ? `\n…e mais ${cs.length - 15}.` : "";
  return `🛒 *Carrinho abandonado na loja* (${cs.length})\n\n${linhas.join("\n")}${extra}\n\nVer e chamar: Integra › Vendas › Canais › Carrinhos da Loja.`;
}

async function destinosEquipe(cfg: Awaited<ReturnType<typeof getConfigCarrinho>>): Promise<string[]> {
  const base = cfg.avisoTelefones || (await setting("telefone_gestor_relatorios"));
  return Array.from(new Set(String(base || "").split(/[,;\s]+/).map(so).filter((x) => x.length >= 10)));
}

async function emOptOut(telefone: string): Promise<boolean> {
  const d = so(telefone);
  if (!d) return false;
  const tail = d.slice(-8);
  const r = rows(await db.execute(sql`SELECT 1 FROM hotsite_carrinho_optout WHERE right(telefone, 8) = ${tail} LIMIT 1`));
  if (r.length) return true;
  // "SAIR" respondido no WhatsApp já é registrado pelo chat (chat-routes.ts → chat_customers.whatsapp_opt_out).
  const c = rows(await db.execute(sql`SELECT 1 FROM chat_customers
    WHERE whatsapp_opt_out = true AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 8) = ${tail} LIMIT 1`).catch(() => [] as any));
  return c.length > 0;
}

export async function enviarMensagemCliente(id: string, por: string, forcar = false) {
  await ensureCarrinhoLojaSchema();
  const cfg = await getConfigCarrinho();
  const c = rows(await db.execute(sql`SELECT * FROM hotsite_carrinhos WHERE id = ${id} LIMIT 1`))[0];
  if (!c) return { ok: false, motivo: "nao_encontrado" };
  if (!c.telefone) return { ok: false, motivo: "sem_telefone" };
  if (c.status === "convertido") return { ok: false, motivo: "ja_comprou" };
  if (c.msg_cliente_em && !forcar) return { ok: false, motivo: "ja_enviada" };
  if (await emOptOut(c.telefone)) {
    await db.execute(sql`UPDATE hotsite_carrinhos SET msg_cliente_status = 'opt-out' WHERE id = ${id}`);
    return { ok: false, motivo: "cliente_pediu_para_nao_receber" };
  }
  const texto = textoRecuperacao(c, cfg.lojaUrl);
  let r: { success: boolean; error?: string };
  try { r = await sendUmblerTalkText(telefoneWhats(c.telefone), texto); }
  catch (e: any) { r = { success: false, error: String(e?.message || e) }; }
  const status = r.success ? "enviada" : `erro: ${String(r.error || "falha").slice(0, 120)}`;
  await db.execute(sql`UPDATE hotsite_carrinhos SET msg_cliente_em = now(), msg_cliente_status = ${status}, msg_cliente_por = ${por}, atualizado_em = now() WHERE id = ${id}`);
  return { ok: r.success, motivo: r.success ? "enviada" : status };
}

// ── Varredura (cron 5 min) ──────────────────────────────────────────────────
let _rodando = false;
export async function varrerCarrinhos(trigger = "cron") {
  if (_rodando) return { ok: false, motivo: "em_execucao" };
  _rodando = true;
  try {
    await ensureCarrinhoLojaSchema();
    const cfg = await getConfigCarrinho();

    // 1) Rede de segurança: pedido no order_journal com o mesmo telefone depois do carrinho → convertido.
    await db.execute(sql`
      UPDATE hotsite_carrinhos hc SET status = 'convertido', convertido_em = COALESCE(hc.convertido_em, oj.created_at),
             pedido_numero = COALESCE(hc.pedido_numero, oj.order_number), atualizado_em = now(),
             recuperado_em = CASE WHEN hc.msg_cliente_em IS NOT NULL AND oj.created_at >= hc.msg_cliente_em THEN oj.created_at ELSE hc.recuperado_em END
      FROM (
        SELECT DISTINCT ON (right(regexp_replace(customer_phone, '\\D', '', 'g'), 8))
               right(regexp_replace(customer_phone, '\\D', '', 'g'), 8) AS tail, order_number, created_at
        FROM order_journal
        WHERE created_at > now() - interval '3 days' AND customer_phone IS NOT NULL AND order_number IS NOT NULL
        ORDER BY right(regexp_replace(customer_phone, '\\D', '', 'g'), 8), created_at DESC
      ) oj
      WHERE hc.status IN ('aberto', 'abandonado') AND hc.telefone IS NOT NULL
        AND right(hc.telefone, 8) = oj.tail AND oj.created_at >= hc.criado_em - interval '5 minutes'`).catch((e: any) =>
      console.warn("[CARRINHO-LOJA] conversão por telefone:", e?.message || e));

    // 2) Novos abandonos: com telefone, com itens, parados há X min (PIX aguardando pagamento não conta até expirar: 40 min a mais).
    const novos = rows(await db.execute(sql`
      UPDATE hotsite_carrinhos SET status = 'abandonado', abandonado_em = now(), atualizado_em = now()
      WHERE status = 'aberto' AND telefone IS NOT NULL AND qtd_itens > 0
        AND ultima_atividade < now() - make_interval(mins => ${cfg.abandonoMin} + CASE WHEN etapa = 'pix' THEN 40 ELSE 0 END)
      RETURNING *`));

    // 3) Mensagem ao cliente (janela 8h–20h, até 24 h depois do abandono, uma por carrinho).
    let enviadas = 0;
    const h = horaBR();
    if (cfg.msgAuto && h >= 8 && h < 20) {
      const pend = rows(await db.execute(sql`
        SELECT id FROM hotsite_carrinhos
        WHERE status = 'abandonado' AND msg_cliente_em IS NULL AND telefone IS NOT NULL
          AND abandonado_em > now() - interval '24 hours'
        ORDER BY abandonado_em LIMIT 20`));
      for (const p of pend) {
        const r = await enviarMensagemCliente(p.id, "automatico");
        if (r.ok) enviadas++;
      }
    }

    // 4) Aviso à equipe (um WhatsApp por varredura com todos os novos).
    let avisados = 0;
    if (cfg.avisoEquipe && novos.length) {
      const ids = novos.map((n) => n.id);
      const lista = sql.join(ids.map((i) => sql`${i}`), sql`, `);
      const atual = rows(await db.execute(sql`SELECT * FROM hotsite_carrinhos WHERE id IN (${lista})`));
      const destinos = await destinosEquipe(cfg);
      const msg = textoEquipe(atual, cfg.msgAuto);
      for (const to of destinos) {
        try { const r = await sendUmblerTalkText(to, msg); if (r.success) avisados++; } catch { /* segue */ }
      }
      if (avisados) await db.execute(sql`UPDATE hotsite_carrinhos SET aviso_equipe_em = now() WHERE id IN (${lista})`);
    }

    // 5) Faxina: visitas anônimas e sem item somem em 3 dias; o resto fica 90 dias.
    await db.execute(sql`DELETE FROM hotsite_carrinhos WHERE telefone IS NULL AND qtd_itens = 0 AND ultima_atividade < now() - interval '3 days'`).catch(() => {});
    await db.execute(sql`DELETE FROM hotsite_carrinhos WHERE ultima_atividade < now() - interval '90 days'`).catch(() => {});

    if (novos.length || enviadas) console.log(`🛒 [CARRINHO-LOJA] ${trigger}: ${novos.length} abandono(s), ${enviadas} msg(s) ao cliente, aviso equipe ${avisados}.`);
    return { ok: true, abandonos: novos.length, enviadas, avisados };
  } finally { _rodando = false; }
}

// ── Opt-out: chamado pelo webhook do WhatsApp quando o cliente responde SAIR ──
export async function registrarOptOutCarrinho(telefone: string, origem = "whatsapp") {
  const d = so(telefone);
  if (d.length < 10) return;
  await ensureCarrinhoLojaSchema();
  await db.execute(sql`INSERT INTO hotsite_carrinho_optout (telefone, origem) VALUES (${d}, ${origem}) ON CONFLICT (telefone) DO NOTHING`);
}

// ── Rotas ───────────────────────────────────────────────────────────────────
let _agendado = false;
export function registerCarrinhoLojaRoutes(app: Express) {
  ensureCarrinhoLojaSchema().catch((e: any) => console.error("[CARRINHO-LOJA] schema:", e?.message || e));

  // Loja → servidor: estado do carrinho/presença. Idempotente (upsert por sessão).
  app.post("/api/public/carrinho/sync", rateLimitPorIp(90), async (req, res) => {
    try {
      await ensureCarrinhoLojaSchema();
      const b = req.body || {};
      const sessao = String(b.sessaoId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      if (sessao.length < 12) return res.status(400).json({ message: "sessão inválida" });
      const itens = limparItens(b.itens);
      const total = Math.round(itens.reduce((s, i) => s + i.p * i.q, 0) * 100) / 100;
      const qtd = itens.reduce((s, i) => s + i.q, 0);
      const etapa = ETAPAS.includes(String(b.etapa)) ? String(b.etapa) : (itens.length ? "carrinho" : "catalogo");
      const ct = b.contato || {};
      const tel = so(ct.telefone).slice(0, 13);
      const telOk = tel.length >= 10 ? tel : null;
      const nome = String(ct.nome || "").trim().slice(0, 120) || null;
      const email = String(ct.email || "").trim().toLowerCase().slice(0, 120) || null;
      const tipo = String(b.tipoCliente || "").slice(0, 30) || null;
      const tabela = String(b.tabela || "").slice(0, 40) || null;
      const utm = limparUtm(b.utm);
      const ua = String(req.headers["user-agent"] || "").slice(0, 200);
      const soPresenca = b.presenca === true; // batida de 60 s: só atualiza a atividade
      const token = randomBytes(12).toString("base64url");

      const r = rows(await db.execute(sql`
        INSERT INTO hotsite_carrinhos (sessao_id, token, nome, telefone, email, tipo_cliente, tabela, itens, qtd_itens, total, etapa, utm, user_agent, contato_em)
        VALUES (${sessao}, ${token}, ${nome}, ${telOk}, ${email}, ${tipo}, ${tabela}, ${JSON.stringify(itens)}::jsonb, ${qtd}, ${total}, ${etapa},
                ${utm ? JSON.stringify(utm) : null}::jsonb, ${ua}, ${telOk ? sql`now()` : null})
        ON CONFLICT (sessao_id) DO UPDATE SET
          ultima_atividade = now(),
          atualizado_em = now(),
          itens = CASE WHEN ${soPresenca} THEN hotsite_carrinhos.itens ELSE EXCLUDED.itens END,
          qtd_itens = CASE WHEN ${soPresenca} THEN hotsite_carrinhos.qtd_itens ELSE EXCLUDED.qtd_itens END,
          total = CASE WHEN ${soPresenca} THEN hotsite_carrinhos.total ELSE EXCLUDED.total END,
          etapa = CASE WHEN ${soPresenca} THEN hotsite_carrinhos.etapa ELSE EXCLUDED.etapa END,
          nome = COALESCE(EXCLUDED.nome, hotsite_carrinhos.nome),
          telefone = COALESCE(EXCLUDED.telefone, hotsite_carrinhos.telefone),
          email = COALESCE(EXCLUDED.email, hotsite_carrinhos.email),
          contato_em = COALESCE(hotsite_carrinhos.contato_em, EXCLUDED.contato_em),
          tipo_cliente = COALESCE(EXCLUDED.tipo_cliente, hotsite_carrinhos.tipo_cliente),
          tabela = COALESCE(EXCLUDED.tabela, hotsite_carrinhos.tabela),
          utm = COALESCE(hotsite_carrinhos.utm, EXCLUDED.utm),
          -- voltou depois de abandonar: reabre (a mensagem já enviada continua registrada, não repete)
          status = CASE WHEN hotsite_carrinhos.status = 'abandonado' AND NOT ${soPresenca} THEN 'aberto' ELSE hotsite_carrinhos.status END,
          visitas = hotsite_carrinhos.visitas + CASE WHEN hotsite_carrinhos.ultima_atividade < now() - interval '30 minutes' THEN 1 ELSE 0 END
        RETURNING token, status`));
      res.json({ ok: true, token: r[0]?.token || null });
    } catch (e: any) {
      // A loja nunca pode quebrar por causa disto.
      res.status(200).json({ ok: false });
      console.warn("[CARRINHO-LOJA] sync:", e?.message || e);
    }
  });

  app.post("/api/public/carrinho/convertido", rateLimitPorIp(30), async (req, res) => {
    try {
      await ensureCarrinhoLojaSchema();
      const sessao = String(req.body?.sessaoId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      const pedido = String(req.body?.pedidoNumero || "").slice(0, 40) || null;
      if (sessao.length < 12) return res.status(400).json({ message: "sessão inválida" });
      await db.execute(sql`UPDATE hotsite_carrinhos SET status = 'convertido', convertido_em = now(), etapa = 'sucesso',
          pedido_numero = COALESCE(${pedido}, pedido_numero), atualizado_em = now(), ultima_atividade = now(),
          recuperado_em = CASE WHEN msg_cliente_em IS NOT NULL THEN now() ELSE recuperado_em END
        WHERE sessao_id = ${sessao} AND status <> 'convertido'`);
      res.json({ ok: true });
    } catch (e: any) { res.status(200).json({ ok: false }); }
  });

  // Link da mensagem: devolve o carrinho guardado (só itens — nada de dado pessoal).
  app.get("/api/public/carrinho/:token", rateLimitPorIp(30), async (req, res) => {
    try {
      await ensureCarrinhoLojaSchema();
      const t = String(req.params.token || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      const c = rows(await db.execute(sql`SELECT sessao_id, itens, tipo_cliente, tabela, status FROM hotsite_carrinhos WHERE token = ${t} LIMIT 1`))[0];
      if (!c || c.status === "convertido") return res.status(404).json({ message: "Carrinho não encontrado" });
      await db.execute(sql`UPDATE hotsite_carrinhos SET observacao = trim(both ' ' from coalesce(observacao, '') || ' [link aberto ' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || ']') WHERE token = ${t}`).catch(() => {});
      res.json({ sessaoId: c.sessao_id, itens: c.itens || [], tipoCliente: c.tipo_cliente, tabela: c.tabela });
    } catch (e: any) { res.status(500).json({ message: "erro" }); }
  });

  // ── Integra (equipe) ──
  const g1 = authenticateUser, g2 = requireRole(PAPEIS);

  app.get("/api/carrinhos-loja/resumo", g1, g2, async (_req, res) => {
    try {
      await ensureCarrinhoLojaSchema();
      const online = rows(await db.execute(sql`
        SELECT id, nome, telefone, etapa, qtd_itens, total, itens, utm, visitas, criado_em, ultima_atividade
        FROM hotsite_carrinhos
        WHERE ultima_atividade > now() - make_interval(secs => ${ONLINE_SEG}) AND status <> 'convertido'
        ORDER BY ultima_atividade DESC LIMIT 100`));
      const hoje = rows(await db.execute(sql`
        SELECT
          COUNT(*)::int AS visitas,
          COUNT(*) FILTER (WHERE qtd_itens > 0 OR status = 'convertido')::int AS com_carrinho,
          COUNT(*) FILTER (WHERE etapa IN ('checkout','pix','cartao','sucesso') OR status = 'convertido')::int AS checkout,
          COUNT(*) FILTER (WHERE telefone IS NOT NULL)::int AS com_contato,
          COUNT(*) FILTER (WHERE status = 'convertido')::int AS convertidos,
          COUNT(*) FILTER (WHERE status = 'abandonado')::int AS abandonados,
          COUNT(*) FILTER (WHERE recuperado_em IS NOT NULL)::int AS recuperados,
          COALESCE(SUM(total) FILTER (WHERE status = 'abandonado'), 0)::numeric AS valor_abandonado,
          COUNT(*) FILTER (WHERE (utm->>'utm_source') = 'meta' OR utm ? 'fbclid')::int AS vindos_meta
        FROM hotsite_carrinhos
        WHERE ultima_atividade >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`))[0] || {};
      res.json({ online, hoje, config: await getConfigCarrinho() });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/carrinhos-loja", g1, g2, async (req, res) => {
    try {
      await ensureCarrinhoLojaSchema();
      const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90);
      const st = String(req.query.status || "contato");
      const filtro =
        st === "abandonado" ? sql`AND status = 'abandonado'`
        : st === "convertido" ? sql`AND status = 'convertido'`
        : st === "aberto" ? sql`AND status = 'aberto' AND qtd_itens > 0`
        : st === "descartado" ? sql`AND status = 'descartado'`
        : st === "todos" ? sql`AND (qtd_itens > 0 OR telefone IS NOT NULL OR status = 'convertido')`
        : sql`AND telefone IS NOT NULL`;
      const lista = rows(await db.execute(sql`
        SELECT id, nome, telefone, email, tipo_cliente, itens, qtd_itens, total, etapa, status, utm, visitas,
               criado_em, ultima_atividade, contato_em, abandonado_em, aviso_equipe_em, msg_cliente_em, msg_cliente_status,
               msg_cliente_por, recuperado_em, convertido_em, pedido_numero, observacao
        FROM hotsite_carrinhos
        WHERE ultima_atividade > now() - make_interval(days => ${dias}) ${filtro}
        ORDER BY ultima_atividade DESC LIMIT 500`));
      res.json(lista);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/carrinhos-loja/:id/mensagem", g1, g2, async (req: any, res) => {
    try {
      const por = String(req.currentUser?.email || req.currentUser?.firstName || "usuario");
      const r = await enviarMensagemCliente(String(req.params.id), por, !!req.body?.reenviar);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/carrinhos-loja/:id/previa", g1, g2, async (req, res) => {
    try {
      const cfg = await getConfigCarrinho();
      const c = rows(await db.execute(sql`SELECT * FROM hotsite_carrinhos WHERE id = ${String(req.params.id)} LIMIT 1`))[0];
      if (!c) return res.status(404).json({ message: "não encontrado" });
      res.json({ texto: textoRecuperacao(c, cfg.lojaUrl) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/carrinhos-loja/:id/status", g1, g2, async (req: any, res) => {
    try {
      const st = String(req.body?.status || "");
      if (!["descartado", "abandonado", "aberto"].includes(st)) return res.status(400).json({ message: "status inválido" });
      const obs = String(req.body?.observacao || "").slice(0, 500);
      const quem = String(req.currentUser?.email || "usuario");
      await db.execute(sql`UPDATE hotsite_carrinhos SET status = ${st}, atualizado_em = now(),
        observacao = trim(both ' ' from coalesce(observacao, '') || ${obs ? ` [${quem}: ${obs}]` : ""}) WHERE id = ${String(req.params.id)}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/carrinhos-loja/config", g1, requireRole(["admin", "coordinator", "administrative"]), async (req: any, res) => {
    try {
      const b = req.body || {}; const by = String(req.currentUser?.email || "carrinho-loja");
      if (b.abandonoMin !== undefined) await setSetting("carrinho_abandono_min", String(Math.min(Math.max(Number(b.abandonoMin) || 60, 15), 1440)), by);
      if (b.msgAuto !== undefined) await setSetting("carrinho_msg_auto", b.msgAuto ? "on" : "off", by);
      if (b.avisoEquipe !== undefined) await setSetting("carrinho_aviso_equipe", b.avisoEquipe ? "on" : "off", by);
      if (b.avisoTelefones !== undefined) await setSetting("carrinho_aviso_telefones", String(b.avisoTelefones || "").replace(/[^0-9,]/g, ""), by);
      res.json({ ok: true, config: await getConfigCarrinho() });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/carrinhos-loja/varrer", g1, requireRole(["admin", "coordinator", "administrative"]), async (_req, res) => {
    try { res.json(await varrerCarrinhos("manual")); } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  if (_agendado) return; _agendado = true;
  cron.schedule("*/5 * * * *", async () => {
    try { await varrerCarrinhos("cron"); } catch (e: any) { console.error("[CARRINHO-LOJA] cron:", e?.message || e); }
  }, { timezone: TZ });
}
