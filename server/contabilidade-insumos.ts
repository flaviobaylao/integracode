// ═══════════════════════════════════════════════════════════════════════════
// CONTÁBIL — INSUMOS DE PRODUÇÃO + RECONSTRUÇÃO SEM SALDO NEGATIVO (set/2026)
//
// Duas coisas, pedidas pelo Flavio depois de ver saldos negativos na tela:
//
// 1) A aba Contábil só mostrava produto acabado (inventory_lots). Aqui entram os
//    INSUMOS (raw_materials / raw_material_movements), com o mesmo razão:
//    saldo inicial, entradas, saídas, saldo final e valorização.
//
// 2) RECONSTRUÇÃO SEM NEGATIVO. Estoque negativo é fisicamente impossível: onde
//    ele aparece, o que falta é movimento de ENTRADA que nunca foi registrado
//    (produção lançada fora do sistema, transferência que não gerou movimento,
//    carga inicial anterior ao início do livro de estoque).
//
//    O algoritmo está em server/reconstrucao-estoque.ts, com os testes em
//    server/__tests__/reconstrucao-estoque.test.mjs. Resumo: o saldo inicial é o
//    menor valor que respeita ao mesmo tempo "fechar no saldo de hoje" e "nunca
//    ficar negativo"; quando os dois não cabem juntos, a diferença é baixa que
//    saiu sem ser lançada e aparece na coluna `baixaNaoRegistrada`.
//
// 3) CONSUMO ESPERADO PELAS RECEITAS. Para conferência: quanto de cada insumo as
//    VENDAS do período consumiriam, segundo a ficha técnica (recipes/recipe_items).
//    Comparar isso com o consumo efetivamente lançado mostra o quanto a baixa de
//    insumo está sendo registrada — sem alterar nada, é só diagnóstico.
// ═══════════════════════════════════════════════════════════════════════════
import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { reconstruirEstoque, type MovimentoRec } from "./reconstrucao-estoque";

const n = (v: any): number => {
  if (v === null || v === undefined || v === "") return 0;
  const x = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : 0;
};

const EPS = 0.0001;

const listaDeIds = (q: any): string[] =>
  String(q || "").split(",").map((s) => s.trim()).filter(Boolean);

const arraySql = (ids: string[]) => sql.raw(`ARRAY[${ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",")}]::varchar[]`);

export function registerContabilidadeInsumos(app: Express) {
  const ver = requireRole(["admin", "administrative", "coordinator", "contador"]);

  // ─────────────────────────────────────────────────────────────────────────
  // Razão de INSUMOS
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/api/contabilidade/contabil/insumos", authenticateUser, ver, async (req: any, res) => {
    try {
      const inicio = String(req.query.inicio || "").slice(0, 10);
      const fim = String(req.query.fim || "").slice(0, 10);
      if (!inicio || !fim) return res.status(400).json({ error: "Informe início e fim (AAAA-MM-DD)." });
      const instancias = listaDeIds(req.query.instancias);
      const busca = String(req.query.busca || "").trim().toLowerCase();

      const filtro = instancias.length ? sql`AND m.instance_id = ANY(${arraySql(instancias)})` : sql``;

      // Cadastro + saldo de hoje.
      const rMat: any = await db.execute(sql`
        SELECT m.id, m.name, m.code, m.category, m.unit, m.quantity, m.unit_cost,
               m.instance_id, m.instance_name, COALESCE(m.is_active, true) AS is_active,
               oi.display_name AS instancia
          FROM raw_materials m
          LEFT JOIN omie_instances oi ON oi.id = m.instance_id
         WHERE COALESCE(m.is_active, true) = true ${filtro}
         ORDER BY m.name`);
      const materiais = rMat.rows || rMat;
      if (!materiais.length) {
        return res.json({ periodo: { inicio, fim }, linhas: [], totais: null, avisos: ["Nenhum insumo cadastrado para esta instância."] });
      }

      const ids = materiais.map((m: any) => String(m.id));

      // Movimentos do início do período para cá (precisamos de tudo até hoje
      // para caminhar de volta a partir do saldo atual).
      const rMov: any = await db.execute(sql`
        SELECT raw_material_id, movement_type, quantity, previous_quantity, new_quantity, created_at
          FROM raw_material_movements
         WHERE raw_material_id = ANY(${arraySql(ids)})
           AND created_at >= ${inicio + " 00:00:00"}::timestamp
         ORDER BY created_at ASC`);

      const porMaterial = new Map<string, MovimentoRec[]>();
      for (const mv of (rMov.rows || rMov)) {
        const ant = mv.previous_quantity, nov = mv.new_quantity;
        let delta: number;
        if (ant !== null && ant !== undefined && nov !== null && nov !== undefined) {
          delta = n(nov) - n(ant);
        } else {
          const q = Math.abs(n(mv.quantity));
          delta = String(mv.movement_type) === "saida" ? -q : q;
        }
        const arr = porMaterial.get(mv.raw_material_id) || [];
        arr.push({ t: new Date(mv.created_at).getTime(), delta });
        porMaterial.set(mv.raw_material_id, arr);
      }

      const tIni = new Date(inicio + "T00:00:00.000Z").getTime();
      const tFim = new Date(fim + "T23:59:59.999Z").getTime();

      // Consumo ESPERADO pelas vendas do período, via ficha técnica.
      const consumoEsperado = await consumoPelasVendas(inicio, fim, instancias);

      let linhas = materiais.map((m: any) => {
        const movs = porMaterial.get(String(m.id)) || [];
        const r = reconstruirEstoque(n(m.quantity), movs, tIni, tFim);
        const custo = n(m.unit_cost);
        return {
          insumoId: String(m.id),
          codigo: m.code || null,
          produto: m.name,
          categoria: m.category || null,
          unidade: m.unit || "UN",
          instanciaId: m.instance_id,
          instancia: m.instancia || m.instance_name || "—",
          tipo: "insumo",
          saldoInicial: r.saldoInicial,
          entradas: r.entradas,
          saidas: r.saidas,
          baixaNaoRegistrada: r.baixaNaoRegistrada,
          saldoFinal: r.saldoFinal,
          consumoEsperado: consumoEsperado.get(String(m.id)) || 0,
          custoUnitario: custo > 0 ? custo : null,
          valorFinal: custo > 0 ? r.saldoFinal * custo : null,
        };
      });

      if (busca) {
        linhas = linhas.filter((l: any) =>
          String(l.produto).toLowerCase().includes(busca) ||
          String(l.codigo || "").toLowerCase().includes(busca) ||
          String(l.categoria || "").toLowerCase().includes(busca));
      }
      linhas.sort((a: any, b: any) =>
        String(a.instancia).localeCompare(String(b.instancia)) ||
        String(a.categoria || "").localeCompare(String(b.categoria || "")) ||
        String(a.produto).localeCompare(String(b.produto)));

      const totais = linhas.reduce((t: any, l: any) => {
        t.saldoInicial += l.saldoInicial; t.entradas += l.entradas; t.saidas += l.saidas;
        t.baixaNaoRegistrada += l.baixaNaoRegistrada; t.saldoFinal += l.saldoFinal;
        t.consumoEsperado += l.consumoEsperado; t.valorFinal += l.valorFinal || 0;
        return t;
      }, { saldoInicial: 0, entradas: 0, saidas: 0, baixaNaoRegistrada: 0, saldoFinal: 0, consumoEsperado: 0, valorFinal: 0 });
      totais.itens = linhas.length;

      const avisos: string[] = [];
      const comBaixa = linhas.filter((l: any) => l.baixaNaoRegistrada > EPS).length;
      if (comBaixa) {
        avisos.push(`${comBaixa} insumos têm baixa não registrada: os movimentos lançados não fecham com o saldo de hoje, e a diferença saiu sem ser lançada.`);
      }
      const semCusto = linhas.filter((l: any) => l.custoUnitario === null && l.saldoFinal > EPS).length;
      if (semCusto) avisos.push(`${semCusto} insumos estão sem custo unitário cadastrado e não entram na valorização.`);
      if (totais.consumoEsperado > EPS) {
        const razao = totais.saidas / totais.consumoEsperado;
        if (razao < 0.8) {
          avisos.push(`O consumo lançado é ${Math.round(razao * 100)}% do que as vendas do período consumiriam pela ficha técnica — parte das baixas de insumo não está sendo registrada.`);
        }
      }

      res.json({ periodo: { inicio, fim }, instancias, linhas, totais, avisos });
    } catch (e: any) {
      console.error("[CONTABIL/INSUMOS]", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Quanto de cada insumo as VENDAS do período consumiriam, pela ficha técnica.
//
// Caminho: itens de NF-e de saída → produto (pelo código) → receita ativa do
// produto → itens da receita (quantidade POR UNIDADE produzida) × quantidade
// vendida. É uma estimativa de conferência: assume que o que foi vendido no
// período foi produzido no período.
// ───────────────────────────────────────────────────────────────────────────
async function consumoPelasVendas(inicio: string, fim: string, instancias: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const filtro = instancias.length ? sql`AND fi.omie_instance_id = ANY(${arraySql(instancias)})` : sql``;

    // Quantidade vendida por produto no período (uma linha por produto).
    const rVend: any = await db.execute(sql`
      SELECT p.id AS product_id, SUM(it.quantity::numeric) AS qtd
        FROM fiscal_invoice_items it
        JOIN (SELECT DISTINCT ON (COALESCE(access_key, id)) id, omie_instance_id, emission_date, status
                FROM fiscal_invoices
               ORDER BY COALESCE(access_key, id), created_at DESC) fi ON fi.id = it.invoice_id
        JOIN products p ON p.omie_code = it.product_code
       WHERE fi.emission_date >= ${inicio + " 00:00:00"}::timestamp
         AND fi.emission_date <= ${fim + " 23:59:59"}::timestamp
         AND COALESCE(fi.status, '') NOT IN ('cancelada', 'cancelled', 'denegada', 'rejeitada')
         ${filtro}
       GROUP BY p.id`);
    const vendas = rVend.rows || rVend;
    if (!vendas.length) return out;

    const prodIds = vendas.map((v: any) => String(v.product_id));
    const rRec: any = await db.execute(sql`
      SELECT DISTINCT ON (r.product_id) r.id, r.product_id
        FROM recipes r
       WHERE r.product_id = ANY(${arraySql(prodIds)}) AND COALESCE(r.is_active, true) = true
       ORDER BY r.product_id, r.updated_at DESC NULLS LAST`);
    const receitaDoProduto = new Map<string, string>();
    for (const r of (rRec.rows || rRec)) receitaDoProduto.set(String(r.product_id), String(r.id));
    if (!receitaDoProduto.size) return out;

    const recIds = Array.from(receitaDoProduto.values());
    const rIt: any = await db.execute(sql`
      SELECT recipe_id, raw_material_id, quantity
        FROM recipe_items WHERE recipe_id = ANY(${arraySql(recIds)})`);
    const itensDaReceita = new Map<string, { insumo: string; qtd: number }[]>();
    for (const it of (rIt.rows || rIt)) {
      const arr = itensDaReceita.get(String(it.recipe_id)) || [];
      arr.push({ insumo: String(it.raw_material_id), qtd: n(it.quantity) });
      itensDaReceita.set(String(it.recipe_id), arr);
    }

    for (const v of vendas) {
      const rec = receitaDoProduto.get(String(v.product_id));
      if (!rec) continue;
      const qtdVendida = n(v.qtd);
      for (const it of (itensDaReceita.get(rec) || [])) {
        out.set(it.insumo, (out.get(it.insumo) || 0) + it.qtd * qtdVendida);
      }
    }
  } catch (e: any) {
    console.warn("[CONTABIL/INSUMOS] consumo pelas vendas:", e?.message);
  }
  return out;
}
