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
import { equivalentesInstancia } from "./resolver-instancia";

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

      // ⚠️ raw_materials.instance_id esta NULL em producao (conferido 18/set): a
      // instancia do insumo vive em raw_materials.instance_name ("IND"). Filtrar so
      // pelo UUID nao achava nada e a aba Contabil mostrava "Nenhum insumo cadastrado
      // para esta instancia" mesmo com 38 insumos cadastrados.
      //
      // Entao o filtro aceita as duas formas: o UUID em instance_id OU o nome/apelido
      // em instance_name. `equivalentes` traz id, name e display_name de cada
      // instancia pedida, entao qualquer uma das convencoes casa.
      const equivalentes: string[] = [];
      for (const i of instancias) {
        const eq = await equivalentesInstancia(i);
        if (eq) equivalentes.push(...eq);
      }
      const filtro = equivalentes.length
        ? sql`AND (m.instance_id = ANY(${arraySql(equivalentes)})
                   OR UPPER(TRIM(COALESCE(m.instance_name, ''))) = ANY(${arraySql(equivalentes.map((e) => e.toUpperCase()))}))`
        : sql``;

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

  // ─────────────────────────────────────────────────────────────────────────
  // ESTOQUE MENSAL ESTIMADO DE INSUMOS (Flavio, 18/set/2026)
  //
  // O livro de movimentos de insumo so comeca em maio, e mesmo depois e esparso:
  // janeiro a abril nao tem NADA lancado. Entao o estoque mes a mes nao pode ser
  // lido do livro — tem de ser estimado. O que temos de confiavel:
  //
  //   • o saldo de HOJE (o Flavio confirmou que os insumos atuais estao certos);
  //   • o CONSUMO de cada mes, deduzido das vendas daquele mes pela ficha tecnica
  //     (recipes/recipe_items) — o mesmo calculo do razao de insumos.
  //
  // Falta a terceira peca, as COMPRAS, que quase nao foram lancadas. Uma equacao,
  // duas incognitas: e preciso uma premissa. A escolhida (pelo Flavio) e COBERTURA
  // CONSTANTE — a empresa mantem, ao longo do ano, a mesma cobertura em meses de
  // producao que o estoque tem hoje:
  //
  //     cobertura = saldo de hoje / consumo medio mensal
  //     alvo de fechamento do mes m = cobertura x consumo do mes seguinte
  //
  // A partir dai a serie e construida PARA FRENTE, com tres travas que a tornam
  // fisicamente possivel — as mesmas garantias da reconstrucao de produto acabado:
  //
  //   1. A abertura de cada mes cobre a producao daquele mes (regra do Flavio).
  //   2. A compra de cada mes nunca e negativa (nao existe compra negativa).
  //   3. A serie fecha EXATAMENTE no saldo de hoje. Se, mesmo com compra zero, o
  //      estoque tivesse de cair mais do que as vendas explicam, a diferenca vai
  //      para `residuo`: saiu sem ser vendido nem lancado (perda, quebra, consumo
  //      nao registrado). Numero declarado, nunca escondido.
  //
  // ⚠️ Isto e ESTIMATIVA, nao o livro. Nada aqui e gravado em raw_material_movements:
  // a rota so calcula e devolve. O dado real continua intacto.
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/api/contabilidade/contabil/insumos-mensal", authenticateUser, ver, async (req: any, res) => {
    try {
      const ano = parseInt(String(req.query.ano || new Date().getFullYear()), 10);
      if (!Number.isFinite(ano) || ano < 2020 || ano > 2100) {
        return res.status(400).json({ error: "Ano invalido." });
      }
      const instancias = listaDeIds(req.query.instancias);
      const hoje = new Date();
      const ateMes = hoje.getFullYear() === ano ? hoje.getMonth() + 1 : 12;

      const equivalentes: string[] = [];
      for (const i of instancias) {
        const eq = await equivalentesInstancia(i);
        if (eq) equivalentes.push(...eq);
      }
      const filtro = equivalentes.length
        ? sql`AND (m.instance_id = ANY(${arraySql(equivalentes)})
                   OR UPPER(TRIM(COALESCE(m.instance_name, ''))) = ANY(${arraySql(equivalentes.map((e) => e.toUpperCase()))}))`
        : sql``;

      const rMat: any = await db.execute(sql`
        SELECT m.id, m.name, m.code, m.category, m.unit, m.quantity, m.unit_cost,
               m.instance_id, m.instance_name, oi.display_name AS instancia
          FROM raw_materials m
          LEFT JOIN omie_instances oi ON oi.id = m.instance_id
         WHERE COALESCE(m.is_active, true) = true ${filtro}
         ORDER BY m.name`);
      const materiais = rMat.rows || rMat;
      if (!materiais.length) {
        return res.json({ ano, meses: [], linhas: [], totais: null, avisos: ["Nenhum insumo cadastrado para esta instancia."] });
      }

      // Consumo de cada mes, pela ficha tecnica das vendas daquele mes.
      // UMA consulta para o ano inteiro, agrupada por mes. A 1a versao chamava
      // consumoPelasVendas() doze vezes em sequencia e a rota passava dos 45s —
      // o navegador desistia antes da resposta.
      const meses: string[] = [];
      for (let k = 1; k <= ateMes; k++) meses.push(`${ano}-${String(k).padStart(2, "0")}`);
      const consumoMes = await consumoPelasVendasPorMes(ano, ateMes, instancias);

      const N = meses.length;
      const linhas = materiais.map((mat: any) => {
        const id = String(mat.id);
        const c = consumoMes.map((mm) => mm.get(id) || 0);
        const saldoHoje = n(mat.quantity);

        const positivos = c.filter((x) => x > EPS);
        const mediaConsumo = positivos.length ? positivos.reduce((a, b) => a + b, 0) / positivos.length : 0;
        const cobertura = mediaConsumo > EPS ? saldoHoje / mediaConsumo : 0;

        // Alvo de fechamento: cobrir o consumo do mes seguinte. O ultimo mes fecha
        // no saldo real de hoje, que e o ancoradouro de toda a serie.
        const alvo = new Array(N).fill(0);
        for (let m = 0; m < N - 1; m++) alvo[m] = cobertura * c[m + 1];
        alvo[N - 1] = saldoHoje;
        // Trava 1: o mes abre com o suficiente para a propria producao. Como a
        // abertura E, por aritmetica, o fechamento do mes anterior, a exigencia recai
        // sobre o mes ANTERIOR — ele fecha com pelo menos o consumo do mes seguinte.
        // Levantar a abertura direto faria estoque surgir do nada; assim a diferenca
        // vira COMPRA no mes anterior, que e o que de fato aconteceu.
        for (let m = 1; m < N; m++) alvo[m - 1] = Math.max(alvo[m - 1], c[m]);

        const abertura = new Array(N).fill(0);
        const fechamento = new Array(N).fill(0);
        const compras = new Array(N).fill(0);
        abertura[0] = Math.max(c[0], cobertura * c[0]);
        for (let m = 0; m < N; m++) {
          compras[m] = Math.max(0, alvo[m] - (abertura[m] - c[m])); // trava 2
          fechamento[m] = abertura[m] - c[m] + compras[m];
          if (m + 1 < N) abertura[m + 1] = fechamento[m];           // encadeamento
        }
        const residuo = Math.max(0, fechamento[N - 1] - saldoHoje); // trava 3
        if (residuo > EPS) fechamento[N - 1] = saldoHoje;

        const custo = n(mat.unit_cost);
        const r2 = (v: number) => Number(v.toFixed(3));
        return {
          insumoId: id,
          codigo: mat.code || null,
          produto: mat.name,
          categoria: mat.category || null,
          unidade: mat.unit || "UN",
          instancia: mat.instancia || mat.instance_name || "—",
          cobertura: Number(cobertura.toFixed(2)),
          // Duas coisas diferentes que a cobertura zero confundia (bug pego em
          // producao, 18/set): "nao entra em receita nenhuma" e "entra, mas o
          // estoque esta zerado hoje". A polpa de maracuja e do segundo tipo —
          // 14 t consumidas no ano, saldo zero — e o aviso a acusava de nao ter
          // ficha tecnica. Agora cada condicao tem seu proprio campo.
          entraEmReceita: mediaConsumo > EPS,
          semEstoqueHoje: saldoHoje <= EPS,
          consumo: c.map(r2),
          abertura: abertura.map(r2),
          compras: compras.map(r2),
          fechamento: fechamento.map(r2),
          residuo: residuo > EPS ? r2(residuo) : 0,
          custoUnitario: custo > 0 ? custo : null,
          valorFechamento: custo > 0 ? fechamento.map((v) => Number((v * custo).toFixed(2))) : null,
          saldoHoje: r2(saldoHoje),
          estimado: true,
        };
      });

      const zeros = () => new Array(N).fill(0);
      const totais = {
        consumo: zeros(), abertura: zeros(), compras: zeros(), fechamento: zeros(), valorFechamento: zeros(),
        itens: linhas.length,
      };
      for (const l of linhas) {
        for (let m = 0; m < N; m++) {
          totais.consumo[m] += l.consumo[m]; totais.abertura[m] += l.abertura[m];
          totais.compras[m] += l.compras[m]; totais.fechamento[m] += l.fechamento[m];
          totais.valorFechamento[m] += l.valorFechamento ? l.valorFechamento[m] : 0;
        }
      }
      for (const k of ["consumo", "abertura", "compras", "fechamento", "valorFechamento"] as const) {
        (totais as any)[k] = (totais as any)[k].map((v: number) => Number(v.toFixed(2)));
      }

      const avisos: string[] = [
        "Estoque mensal ESTIMADO, nao lancado: o livro de movimentos de insumo nao cobre o periodo. Premissa: a empresa mantem ao longo do ano a mesma cobertura (em meses de producao) que o estoque tem hoje. A serie fecha no saldo atual, nunca fica negativa, e cada mes abre com o suficiente para a producao vendida naquele mes.",
      ];
      const comResiduo = linhas.filter((l: any) => l.residuo > EPS).length;
      if (comResiduo) {
        avisos.push(`${comResiduo} insumos tem residuo: mesmo sem nenhuma compra, o estoque teria de cair mais do que as vendas explicam. Essa diferenca saiu sem ser vendida nem lancada (perda, quebra ou consumo nao registrado).`);
      }
      // NAO usar cobertura === 0 aqui: ela tambem zera quando o insumo e consumido
      // normalmente mas esta sem saldo hoje. O teste certo e o consumo do periodo.
      const semReceita = linhas.filter((l: any) => !l.entraEmReceita).length;
      if (semReceita) avisos.push(`${semReceita} insumos nao aparecem em receita de nenhum produto vendido no periodo — para esses nao ha como estimar consumo, e a serie so mostra o saldo de hoje.`);
      const zeradosEmUso = linhas.filter((l: any) => l.entraEmReceita && l.semEstoqueHoje).length;
      if (zeradosEmUso) avisos.push(`${zeradosEmUso} insumos sao consumidos pelas receitas mas estao com saldo ZERO hoje — a serie mensal deles fecha em zero. Confira se e ruptura real ou baixa lancada a mais.`);

      res.json({ ano, meses, linhas, totais, avisos, estimativa: true });
    } catch (e: any) {
      console.error("[CONTABIL/INSUMOS-MENSAL]", e?.message);
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

// ───────────────────────────────────────────────────────────────────────────
// A MESMA CONTA, O ANO INTEIRO, EM UMA CONSULTA SÓ.
//
// `consumoPelasVendas` responde por um período. Chamá-la mês a mês custava doze
// idas ao banco em sequência, cada uma varrendo notas, produtos, receitas e
// itens de receita — a rota mensal estourava os 45s do navegador.
//
// Aqui as vendas do ano saem agrupadas por (mês, produto) numa consulta, e as
// receitas são lidas UMA vez. O resto é multiplicação em memória. O resultado é
// idêntico ao do laço antigo: um Map por mês, na ordem dos meses.
// ───────────────────────────────────────────────────────────────────────────
async function consumoPelasVendasPorMes(
  ano: number,
  ateMes: number,
  instancias: string[],
): Promise<Map<string, number>[]> {
  const out: Map<string, number>[] = Array.from({ length: ateMes }, () => new Map<string, number>());
  try {
    const filtro = instancias.length ? sql`AND fi.omie_instance_id = ANY(${arraySql(instancias)})` : sql``;
    const inicio = `${ano}-01-01 00:00:00`;
    const fim = `${ano}-${String(ateMes).padStart(2, "0")}-${String(new Date(Date.UTC(ano, ateMes, 0)).getUTCDate()).padStart(2, "0")} 23:59:59`;

    // Vendas por MES e por produto. A deduplicacao por chave de acesso e a mesma
    // do calculo por periodo — nota reemitida nao conta duas vezes.
    const rVend: any = await db.execute(sql`
      SELECT EXTRACT(MONTH FROM fi.emission_date)::int AS mes,
             p.id AS product_id,
             SUM(it.quantity::numeric) AS qtd
        FROM fiscal_invoice_items it
        JOIN (SELECT DISTINCT ON (COALESCE(access_key, id)) id, omie_instance_id, emission_date, status
                FROM fiscal_invoices
               ORDER BY COALESCE(access_key, id), created_at DESC) fi ON fi.id = it.invoice_id
        JOIN products p ON p.omie_code = it.product_code
       WHERE fi.emission_date >= ${inicio}::timestamp
         AND fi.emission_date <= ${fim}::timestamp
         AND COALESCE(fi.status, '') NOT IN ('cancelada', 'cancelled', 'denegada', 'rejeitada')
         ${filtro}
       GROUP BY 1, 2`);
    const vendas = rVend.rows || rVend;
    if (!vendas.length) return out;

    const prodIds = Array.from(new Set(vendas.map((v: any) => String(v.product_id))));
    const rRec: any = await db.execute(sql`
      SELECT DISTINCT ON (r.product_id) r.id, r.product_id
        FROM recipes r
       WHERE r.product_id = ANY(${arraySql(prodIds)}) AND COALESCE(r.is_active, true) = true
       ORDER BY r.product_id, r.updated_at DESC NULLS LAST`);
    const receitaDoProduto = new Map<string, string>();
    for (const r of (rRec.rows || rRec)) receitaDoProduto.set(String(r.product_id), String(r.id));
    if (!receitaDoProduto.size) return out;

    const recIds = Array.from(new Set(receitaDoProduto.values()));
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
      const mes = Number(v.mes);
      if (!Number.isFinite(mes) || mes < 1 || mes > ateMes) continue;
      const rec = receitaDoProduto.get(String(v.product_id));
      if (!rec) continue;
      const qtdVendida = n(v.qtd);
      const alvo = out[mes - 1];
      for (const it of (itensDaReceita.get(rec) || [])) {
        alvo.set(it.insumo, (alvo.get(it.insumo) || 0) + it.qtd * qtdVendida);
      }
    }
  } catch (e: any) {
    console.warn("[CONTABIL/INSUMOS] consumo por mes:", e?.message);
  }
  return out;
}
