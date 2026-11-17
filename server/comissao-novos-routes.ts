// ─────────────────────────────────────────────────────────────────────────────
// COMISSÃO DE CLIENTE NOVO — 12% por 6 meses (ata da reunião de 14/11/2026).
//
// Liga/desliga pela tela da Campanha (premissa "comissao_novo", por mês, com o
// carimbo do momento em que o flag foi marcado). Enquanto ela vale, o vendedor
// que CONQUISTA um cliente novo recebe o % de comissão da premissa (12%) sobre
// as vendas desse cliente pelo prazo da premissa (6 meses), em vez dos 8%. Regras:
//  • Cliente novo = 1ª NF-e de venda da base com data dentro do período em que o
//    flag esteve ligado no mês, sem piso. Cliente que já entrou no R$ 30 por novo
//    cliente (campaign_new_clients) no mesmo mês não ganha os 12% também.
//  • Quem conquistou = dono da carteira NA DATA da 1ª compra (respeita delegação).
//  • Vigência = da 1ª compra até 6 meses depois.
//  • Só quem conquistou recebe. Vendedor desligado (usuário inativo) dentro dos
//    6 meses → a condição ENCERRA e o cliente volta aos 8% para quem assumir.
//  • Cada início e cada fim ficam gravados no histórico do cliente
//    (customer_change_history), e Clientes Ativos mostra a marca enquanto vigente.
//
// GET /api/comissao-novos?ym=YYYY-MM   lista + vendas do mês (vendedor vê só os seus)
// GET /api/comissao-novos/marcas        { customerId: { percentual, inicio, fim, vendedor } } vigentes
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { clientesNovosDesde, premissasDoMes, achaPremissa, PRIMEIRO_MES_COMISSAO_NOVO, docValeNaPremissa } from "./campanha-outubro";
import { nfVendaFrom, nfData } from "./faturamento-oficial";
import { percentualComissaoDoMes } from "./resumo-recebiveis-routes";

const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
const esc = (v: any) => String(v ?? "").replace(/'/g, "''");
const PERCENTUAL = 12;
const PERCENTUAL_BASE = 8;
const MESES = 6;

function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const dataBR = (d: string) => String(d || "").slice(0, 10).split("-").reverse().join("/");

let _ok = false;
async function ensureTable() {
  if (_ok) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS comissao_cliente_novo (
    customer_id varchar PRIMARY KEY,
    doc varchar,
    customer_name varchar,
    seller_user_id varchar NOT NULL,
    seller_name varchar,
    percentual numeric NOT NULL DEFAULT 12,
    percentual_base numeric NOT NULL DEFAULT 8,
    inicio date NOT NULL,
    fim date NOT NULL,
    primeiro_pedido numeric,
    status varchar NOT NULL DEFAULT 'vigente',
    motivo_encerramento text,
    encerrado_em timestamptz,
    created_at timestamptz DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS customer_change_history (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar NOT NULL, field varchar NOT NULL,
    label varchar NOT NULL, old_value text, new_value text, changed_by_user_id varchar, changed_by_name varchar,
    source varchar, created_at timestamptz DEFAULT now())`);
  _ok = true;
}

async function historico(customerId: string, antes: string | null, depois: string) {
  await db.execute(sql`
    INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_name, source)
    VALUES (${customerId}, 'comissaoClienteNovo', 'Comissão de cliente novo', ${antes}, ${depois}, 'Sistema (campanha)', 'campanha')`);
}

// Períodos (por dia, inclusive) em que a premissa "comissao_novo" esteve ligada.
// Ligada sem carimbo = o mês todo; ligada com carimbo = do dia em que ligou ao fim
// do mês; desligada depois de ter valido = do dia em que ligou ao dia em que desligou.
type JanelaComissao = { ini: string; fim: string; pct: number; meses: number; valePj?: boolean; valePf?: boolean; pedidoMin: number };
async function janelasComissao(): Promise<JanelaComissao[]> {
  const out: JanelaComissao[] = [];
  const hoje = hojeBR();
  let ym = PRIMEIRO_MES_COMISSAO_NOVO;
  while (ym <= hoje.slice(0, 7)) {
    const p = achaPremissa(await premissasDoMes(ym), "comissao_novo");
    const inicioMes = ym + "-01";
    const fimMes = (await q(`SELECT ((DATE '${inicioMes}' + INTERVAL '1 month') - INTERVAL '1 day')::date::text AS f`))[0].f;
    if (p) {
      const ligou = p.ativadaEm ? p.ativadaEm.slice(0, 10) : null;
      const pct = Number(p.valor) || PERCENTUAL, meses = Number(p.gatilho) || MESES;
      // PJ/PF do mês (16/nov/2026): só o tipo marcado conquista os 12%.
      // Pedido mínimo da 1ª compra (17/nov/2026, Flavio: "acima de R$ 300").
      const tipo = { valePj: p.valePj, valePf: p.valePf, pedidoMin: Number(p.pedidoMin) || 0 };
      if (p.ativa) out.push({ ini: ligou && ligou > inicioMes ? ligou : inicioMes, fim: fimMes, pct, meses, ...tipo });
      else if (ligou && p.desativadaEm) out.push({ ini: ligou > inicioMes ? ligou : inicioMes, fim: p.desativadaEm.slice(0, 10), pct, meses, ...tipo });
    }
    const [a, m] = ym.split("-").map(Number);
    ym = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
  }
  return out;
}

let _ultimaSync = 0;
let _syncRodando: Promise<void> | null = null;
export async function sincronizarComissaoNovos(forcar = false): Promise<void> {
  if (_syncRodando) return _syncRodando;
  if (!forcar && Date.now() - _ultimaSync < 10 * 60 * 1000) return;
  _syncRodando = (async () => {
    try {
      await ensureTable();
      // 1) janelas em que o flag esteve ligado, mês a mês, desde novembro/2026
      const janelas = await janelasComissao();
      if (janelas.length) {
        const desde = janelas.map((j) => j.ini).sort()[0];
        const novos = await clientesNovosDesde(desde);
        const ja = new Set((await q(`SELECT customer_id FROM comissao_cliente_novo`)).map((r) => String(r.customer_id)));
        // Quem já entrou no R$ 30 por novo cliente não ganha os 12% também.
        const r30 = new Set((await q(`SELECT campaign_ym || '|' || doc AS k FROM campaign_new_clients WHERE status IN ('aprovado','pendente')`)).map((r) => String(r.k)));
        for (const n of novos) {
          if (ja.has(n.customerId)) continue;
          const jan = janelas.find((j) => n.primeiraCompra >= j.ini && n.primeiraCompra <= j.fim);
          if (!jan) continue;
          if (!docValeNaPremissa(jan, n.doc)) continue; // tipo de cliente (PJ/PF) fora da regra do mês
          // 1ª compra (total do cliente no dia) abaixo do mínimo não entra. Vale daqui
          // para frente: quem já está na tabela continua (decisão do Flavio, 17/11/2026).
          if (jan.pedidoMin > 0 && (Number(n.valor) || 0) < jan.pedidoMin) continue;
          if (r30.has(n.primeiraCompra.slice(0, 7) + "|" + n.doc)) continue;
          const fim = (await q(`SELECT (DATE '${esc(n.primeiraCompra)}' + INTERVAL '${Math.round(jan.meses)} months')::date::text AS f`))[0].f;
          await q(`INSERT INTO comissao_cliente_novo (customer_id, doc, customer_name, seller_user_id, seller_name, percentual, percentual_base, inicio, fim, primeiro_pedido)
                   VALUES ('${esc(n.customerId)}', '${esc(n.doc)}', '${esc(n.nome)}', '${esc(n.sellerUid)}', '${esc(n.seller)}',
                           ${jan.pct}, ${PERCENTUAL_BASE}, '${esc(n.primeiraCompra)}', '${esc(fim)}', ${Number(n.valor) || 0})
                   ON CONFLICT (customer_id) DO NOTHING`);
          await historico(n.customerId, `${PERCENTUAL_BASE}%`,
            `${jan.pct}% para ${n.seller} (cliente novo conquistado em ${dataBR(n.primeiraCompra)}) até ${dataBR(fim)}`);
        }
      }
      // 2) vendedor desligado dentro do prazo → encerra; volta aos 8%
      const desligados = await q(`
        SELECT c.customer_id, c.seller_name FROM comissao_cliente_novo c
        JOIN users u ON u.id = c.seller_user_id
        WHERE c.status = 'vigente' AND u.is_active = false`);
      for (const r of desligados) {
        await q(`UPDATE comissao_cliente_novo SET status = 'encerrado', encerrado_em = now(),
                 motivo_encerramento = 'Vendedor desligado' WHERE customer_id = '${esc(r.customer_id)}'`);
        await historico(String(r.customer_id), `${PERCENTUAL}% para ${r.seller_name}`,
          `${PERCENTUAL_BASE}% — comissão de cliente novo encerrada: vendedor desligado`);
      }
      // 3) prazo de 6 meses vencido → expira; volta aos 8%
      const vencidos = await q(`SELECT customer_id, seller_name, fim::text AS fim FROM comissao_cliente_novo
                                WHERE status = 'vigente' AND fim < DATE '${hojeBR()}'`);
      for (const r of vencidos) {
        await q(`UPDATE comissao_cliente_novo SET status = 'expirado', encerrado_em = now(),
                 motivo_encerramento = 'Prazo de 6 meses encerrado' WHERE customer_id = '${esc(r.customer_id)}'`);
        await historico(String(r.customer_id), `${PERCENTUAL}% para ${r.seller_name}`,
          `${PERCENTUAL_BASE}% — fim dos 6 meses de comissão de cliente novo (${dataBR(r.fim)})`);
      }
      _ultimaSync = Date.now();
    } catch (e: any) {
      console.error("[comissao-novos] sync:", e?.message || e);
    } finally {
      _syncRodando = null;
    }
  })();
  return _syncRodando;
}

/**
 * Vendas de cada cliente com a comissão de cliente novo DENTRO do mês, só no período
 * em que a condição vale: da 1ª compra (início) até o fim dos 6 meses (exclusive) —
 * e, se encerrou antes (vendedor desligado), até o dia do encerramento.
 * Faturamento oficial (NF-e de venda autorizada, deduplicada). Usado pela tela da
 * Campanha e pela coluna "Comissão cliente novo" do Resumo Recebíveis.
 */
export async function vendasClienteNovoDoMes(ym: string): Promise<Array<{
  customerId: string; doc: string; cliente: string; sellerUserId: string; vendedor: string;
  percentual: number; inicio: string; fim: string; status: string; motivo: string | null;
  primeiroPedido: number; vendas: number;
}>> {
  await ensureTable();
  const ini = `${ym}-01`;
  const d = nfData("fi");
  const rows = await q(`
    SELECT c.customer_id, c.doc, c.customer_name, c.seller_user_id, c.seller_name, c.percentual,
           c.inicio::text AS inicio, c.fim::text AS fim, c.status, c.motivo_encerramento, c.primeiro_pedido,
           COALESCE(v.vendas, 0) AS vendas
    FROM comissao_cliente_novo c
    LEFT JOIN LATERAL (
      SELECT SUM(fi.total_invoice) AS vendas
      FROM ${nfVendaFrom("fi")}
      WHERE regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') = c.doc
        AND ${d}::date >= GREATEST(DATE '${ini}', c.inicio)
        AND ${d}::date < LEAST((DATE '${ini}' + INTERVAL '1 month')::date, c.fim,
                               COALESCE((c.encerrado_em AT TIME ZONE 'America/Sao_Paulo')::date + 1, c.fim))
    ) v ON true
    WHERE c.inicio < (DATE '${ini}' + INTERVAL '1 month') AND c.fim > DATE '${ini}'
    ORDER BY c.inicio DESC, c.customer_name`);
  return rows.map((r) => ({
    customerId: String(r.customer_id), doc: String(r.doc || ""), cliente: String(r.customer_name || ""),
    sellerUserId: String(r.seller_user_id || ""), vendedor: String(r.seller_name || ""),
    percentual: Number(r.percentual) || PERCENTUAL, inicio: r.inicio, fim: r.fim, status: String(r.status || ""),
    motivo: r.motivo_encerramento || null, primeiroPedido: Number(r.primeiro_pedido || 0),
    vendas: Math.round(Number(r.vendas || 0) * 100) / 100,
  }));
}

export function registerComissaoNovos(app: Express) {
  app.get("/api/comissao-novos/marcas", authenticateUser, async (_req: Request, res: Response) => {
    try {
      await ensureTable();
      sincronizarComissaoNovos().catch(() => {}); // não segura a tela de clientes
      const rows = await q(`SELECT customer_id, percentual, inicio::text AS inicio, fim::text AS fim, seller_name
                            FROM comissao_cliente_novo WHERE status = 'vigente'`);
      const out: Record<string, any> = {};
      for (const r of rows) out[r.customer_id] = { percentual: Number(r.percentual), inicio: r.inicio, fim: r.fim, vendedor: r.seller_name };
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/api/comissao-novos", authenticateUser, async (req: Request, res: Response) => {
    try {
      await sincronizarComissaoNovos(String(req.query.forcar || "") === "1");
      const usuario: any = (req as any).currentUser || (req as any).user || null;
      const restrito = ["vendedor", "telemarketing"].includes(String(usuario?.role || ""));
      let ym = String(req.query.ym || hojeBR().slice(0, 7)).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) ym = hojeBR().slice(0, 7);
      let linhas = await vendasClienteNovoDoMes(ym);
      if (restrito) linhas = linhas.filter((l) => l.sellerUserId === String(usuario?.id || ""));
      // "12% para todos" (Flavio, 17/11/2026): sobre as vendas do cliente novo o vendedor
      // recebe 12% NO TOTAL. A diferença paga é 12% menos a taxa normal DELE no mês
      // (Gilmar 8% -> +4; Radilton 4,5% -> +7,5), pela mesma regra do Resumo Recebíveis.
      const [a, m] = ym.split("-").map(Number);
      const taxas: Record<string, number> = {};
      for (const uid of Array.from(new Set(linhas.map((l) => l.sellerUserId)))) {
        const t = await percentualComissaoDoMes(uid, a, m);
        taxas[uid] = t ? t.pct : PERCENTUAL_BASE;
      }
      const clientes = linhas.map((l) => {
        const base = Math.min(taxas[l.sellerUserId] ?? PERCENTUAL_BASE, l.percentual);
        return {
          customerId: l.customerId, cliente: l.cliente, vendedorId: l.sellerUserId, vendedor: l.vendedor,
          inicio: l.inicio, fim: l.fim, status: l.status, motivo: l.motivo,
          primeiroPedido: l.primeiroPedido, vendasMes: l.vendas, percentual: l.percentual, percentualBase: base,
          comissao: Math.round(l.vendas * l.percentual) / 100,
          adicional: Math.round(l.vendas * (l.percentual - base)) / 100,
        };
      });
      res.json({
        ok: true, ym, percentual: PERCENTUAL, percentualBase: PERCENTUAL_BASE, meses: MESES,
        clientes,
        totais: {
          clientes: clientes.length,
          vendas: Math.round(clientes.reduce((s, c) => s + c.vendasMes, 0) * 100) / 100,
          comissao: Math.round(clientes.reduce((s, c) => s + c.comissao, 0) * 100) / 100,
          adicional: Math.round(clientes.reduce((s, c) => s + c.adicional, 0) * 100) / 100,
        },
      });
    } catch (e: any) {
      console.error("[comissao-novos]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
