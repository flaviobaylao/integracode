// server/carteira-routes.ts
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — VENDAS  (tela /gestao-carteiras)
//
// Um unico endpoint read-only que devolve tudo que o dashboard precisa:
//   1. serie mensal de faturamento (jan/2025 -> mes corrente)
//   2. curva ABC da carteira (segmentos)
//   3. PJ x PF
//   4. segmento de negocio (customers.segmento_principal)
//   5. lista de clientes com total, media simples e MEDIA PONDERADA por mes
//
// FONTE DO FATURAMENTO POR CLIENTE = `receivables` (titulos emitidos, fora os
// cancelados). Motivo: e a UNICA base que cobre jan/2025 em diante — os titulos
// legados vieram do 1.0 e trazem `customer_document` (o `customer_id` so passou a
// ser gravado em 2026). A regra oficial de faturamento (NF-e de venda,
// server/faturamento-oficial.ts) so tem cobertura a partir de 2026, entao ela
// entra como SEGUNDA LINHA do grafico (comparativo), nunca como base do rateio
// por cliente — assim o numero de cada cliente e a soma da serie fecham entre si.
//
// Chave do cliente = CPF/CNPJ so-digitos; sem documento, cai no nome normalizado
// (mesmo criterio ja usado na positivacao e no extrato do cliente).
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { nfVendaWhere, nfVendaFrom, nfData, VIGENCIA_REGRA_OFICIAL } from "./faturamento-oficial";

const TZ = "America/Sao_Paulo";

/** 'YYYY-MM' do mes corrente em horario de Brasilia. */
function mesAtual(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

/** Normaliza 'YYYY-MM' (aceita 'YYYY-MM-DD'); volta `def` se vier lixo. */
function normMes(v: any, def: string): string {
  const m = String(v || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return def;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return def;
  return `${m[1]}-${m[2]}`;
}

/** Lista de meses 'YYYY-MM' de ini ate fim (inclusive). */
function listaMeses(ini: string, fim: string): string[] {
  const out: string[] = [];
  let [y, m] = ini.split("-").map(Number);
  const [fy, fm] = fim.split("-").map(Number);
  let guard = 0;
  while ((y < fy || (y === fy && m <= fm)) && guard++ < 600) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Primeiro dia do mes SEGUINTE a `mes` (limite superior exclusivo do periodo). */
function proximoMes1(mes: string): string {
  let [y, m] = mes.split("-").map(Number);
  m++;
  if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** PJ / PF: o documento manda; sem documento, vale o tipo do cadastro. */
function classificaTipo(doc: string | null, customerType: string | null): "PJ" | "PF" | "Não identificado" {
  const d = String(doc || "").replace(/\D/g, "");
  if (d.length === 14) return "PJ";
  if (d.length === 11) return "PF";
  const t = String(customerType || "").toLowerCase();
  if (t.includes("juridica") || t.includes("jurídica")) return "PJ";
  if (t.includes("fisica") || t.includes("física")) return "PF";
  return "Não identificado";
}

/** "SUPERMERCADO" e "Supermercado" sao o mesmo segmento — normaliza a caixa. */
function normSegmento(s: any): string {
  const raw = String(s || "").trim();
  if (!raw) return "Sem segmento";
  return raw
    .toLocaleLowerCase("pt-BR")
    .split(/(\s|\/|-)/)
    .map((p) => (/^[\s/-]$/.test(p) ? p : p.charAt(0).toLocaleUpperCase("pt-BR") + p.slice(1)))
    .join("");
}

export function registerCarteira(app: Express) {
  // ---------------------------------------------------------------------------
  // GET /api/reports/gestao-carteiras?inicio=2025-01&fim=2026-08
  // ---------------------------------------------------------------------------
  app.get("/api/reports/gestao-carteiras", async (req: Request, res: Response) => {
    try {
      const hoje = mesAtual();
      const inicio = normMes(req.query.inicio, "2025-01");
      const fimBruto = normMes(req.query.fim, hoje);
      const fim = fimBruto > hoje ? hoje : fimBruto;
      const iniDate = `${inicio}-01`;
      const fimDateExcl = proximoMes1(fim);
      const meses = listaMeses(inicio, fim);

      const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

      // CTE comum: titulos validos do periodo, ja com a chave do cliente.
      const CTE_REC = `
        WITH r AS (
          SELECT
            NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'') AS doc,
            NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),'')                        AS nome,
            to_char(issue_date,'YYYY-MM')                                             AS mes,
            COALESCE(NULLIF(amount::text,'')::numeric,0)                              AS v
          FROM receivables
          WHERE issue_date >= '${iniDate}'
            AND issue_date <  '${fimDateExcl}'
            AND deleted_at IS NULL
            AND COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')
            AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
        ),
        rk AS (
          SELECT COALESCE(doc, 'N|' || COALESCE(nome,'?')) AS chave, doc, nome, mes, v FROM r
        )`;

      // 1) Serie mensal (base = titulos emitidos)
      const serieRec = await q(`${CTE_REC}
        SELECT mes,
               COALESCE(SUM(v),0)::float   AS valor,
               COUNT(*)::int               AS titulos,
               COUNT(DISTINCT chave)::int  AS clientes
        FROM rk GROUP BY mes ORDER BY mes`);

      // 2) Serie mensal comparativa — NF-e de VENDA.
      //    Ate 30/06/2026 vale o calculo legado; de 01/07/2026 em diante, a Regra
      //    Oficial (server/faturamento-oficial.ts). Mesmo criterio do dashboard.
      const VF = nfVendaWhere("fi");
      const VFROM = nfVendaFrom("fi");
      const VDATA = nfData("fi");
      const LEGADO = `status='authorized' AND COALESCE(operation_type,'saida') <> 'entrada' AND COALESCE(fin_nfe,'1') <> '4' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%DEVOL%' AND UPPER(COALESCE(nature_of_operation,'')) LIKE '%VENDA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TROCA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TRANSFER%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%REMESSA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%BONIFICA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%AMOSTRA%' AND (import_origin IS NULL OR TRIM(import_origin) = '')`;
      let serieNf: any[] = [];
      try {
        serieNf = await q(`
          SELECT m, COALESCE(SUM(v),0)::float AS valor FROM (
            SELECT to_char(date_trunc('month', COALESCE(emission_date,authorization_date,created_at)),'YYYY-MM') AS m,
                   total_invoice AS v
            FROM fiscal_invoices
            WHERE ${LEGADO}
              AND COALESCE(emission_date,authorization_date,created_at)::date >= '${iniDate}'::date
              AND COALESCE(emission_date,authorization_date,created_at)::date <  LEAST('${fimDateExcl}'::date, '${VIGENCIA_REGRA_OFICIAL}'::date)
            UNION ALL
            SELECT to_char(date_trunc('month', ${VDATA}),'YYYY-MM') AS m, fi.total_invoice AS v
            FROM ${VFROM}
            WHERE ${VF}
              AND ${VDATA}::date >= GREATEST('${iniDate}'::date, '${VIGENCIA_REGRA_OFICIAL}'::date)
              AND ${VDATA}::date <  '${fimDateExcl}'::date
          ) s GROUP BY m ORDER BY m`);
      } catch (e: any) {
        console.warn("[gestao-carteiras] serie NF-e indisponivel:", e?.message || e);
      }

      // 3) Por cliente: total, titulos, meses com compra e o mapa mes -> valor.
      //    O cadastro entra por LEFT JOIN no documento (tipo, vendedor, cidade,
      //    segmento, ativo) — cliente sem cadastro fica com o nome do titulo.
      const clientesRaw = await q(`${CTE_REC},
        per_mes AS (
          SELECT chave, mes, SUM(v) AS vm, COUNT(*) AS n, MAX(doc) AS doc, MAX(nome) AS nome
          FROM rk GROUP BY chave, mes
        ),
        agg AS (
          SELECT chave,
                 MAX(doc)                    AS doc,
                 MAX(nome)                   AS nome,
                 SUM(vm)::float              AS total,
                 SUM(n)::int                 AS titulos,
                 MAX(mes)                    AS ultimo_mes,
                 MIN(mes)                    AS primeiro_mes,
                 COUNT(*)::int               AS meses_com_compra,
                 jsonb_object_agg(mes, vm)   AS por_mes
          FROM per_mes GROUP BY chave
        ),
        cust AS (
          SELECT DISTINCT ON (doc) doc, name, customer_type, seller_id, city, segmento_principal, is_active
          FROM (
            SELECT NULLIF(regexp_replace(COALESCE(NULLIF(cnpj,''),NULLIF(cpf,''),''),'[^0-9]','','g'),'') AS doc,
                   name, customer_type, seller_id, city, segmento_principal, is_active,
                   (CASE WHEN is_active THEN 1 ELSE 0 END) AS sc, updated_at
            FROM customers
            WHERE COALESCE(is_supplier,false) = false
          ) x
          WHERE doc IS NOT NULL AND length(doc) >= 11
          ORDER BY doc, sc DESC, updated_at DESC NULLS LAST
        )
        SELECT a.chave, a.doc, a.nome, a.total, a.titulos, a.ultimo_mes, a.primeiro_mes,
               a.meses_com_compra, a.por_mes,
               c.name AS cad_nome, c.customer_type, c.city, c.segmento_principal, c.is_active,
               COALESCE(vend.nome,'Sem vendedor') AS vendedor
        FROM agg a
        LEFT JOIN cust c ON c.doc = a.doc
        LEFT JOIN LATERAL (
          SELECT NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),'') AS nome
          FROM users u
          WHERE c.seller_id IS NOT NULL AND c.seller_id <> '' AND (
                u.id = c.seller_id
             OR u.omie_vendor_code = c.seller_id
             OR u.omie_vendor_code = REPLACE(c.seller_id,'omie-vendor-','')
          )
          LIMIT 1
        ) vend ON true
        ORDER BY a.total DESC`);

      // ---- pos-processamento em JS: media ponderada, ABC, recortes -----------
      const pesoDoMes = new Map<string, number>();
      meses.forEach((m, i) => pesoDoMes.set(m, i + 1)); // mais recente pesa mais
      const somaPesos = (meses.length * (meses.length + 1)) / 2 || 1;

      const clientes = clientesRaw.map((r: any) => {
        const porMes = (r.por_mes || {}) as Record<string, any>;
        let ponderado = 0;
        for (const [m, v] of Object.entries(porMes)) {
          ponderado += (Number(v) || 0) * (pesoDoMes.get(m) || 0);
        }
        const total = Number(r.total) || 0;
        const doc = r.doc ? String(r.doc) : null;
        return {
          chave: String(r.chave),
          doc,
          nome: String(r.cad_nome || r.nome || "(sem nome)"),
          tipo: classificaTipo(doc, r.customer_type),
          vendedor: String(r.vendedor || "Sem vendedor"),
          cidade: r.city ? String(r.city) : "",
          segmento: normSegmento(r.segmento_principal),
          cadastrado: !!r.cad_nome,
          ativo: r.is_active === true,
          total,
          titulos: Number(r.titulos) || 0,
          mesesComCompra: Number(r.meses_com_compra) || 0,
          primeiraCompra: r.primeiro_mes || null,
          ultimaCompra: r.ultimo_mes || null,
          mediaSimples: meses.length ? total / meses.length : 0,
          mediaPonderada: ponderado / somaPesos,
          porMes: Object.fromEntries(Object.entries(porMes).map(([m, v]) => [m, Number(v) || 0])),
          classe: "C" as "A" | "B" | "C",
        };
      });

      // Curva ABC sobre o faturamento do periodo: A ate 80%, B ate 95%, C o resto.
      const totalGeral = clientes.reduce((s, c) => s + c.total, 0);
      let acum = 0;
      for (const c of clientes) {
        acum += c.total;
        const pct = totalGeral > 0 ? acum / totalGeral : 0;
        c.classe = pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C";
      }

      const somaPor = (chaveDe: (c: any) => string) => {
        const m = new Map<string, { clientes: number; valor: number }>();
        for (const c of clientes) {
          const k = chaveDe(c);
          const a = m.get(k) || { clientes: 0, valor: 0 };
          a.clientes++;
          a.valor += c.total;
          m.set(k, a);
        }
        return m;
      };

      const mapaAbc = somaPor((c) => c.classe);
      const abc = (["A", "B", "C"] as const).map((k) => ({
        classe: k,
        clientes: mapaAbc.get(k)?.clientes || 0,
        valor: mapaAbc.get(k)?.valor || 0,
        pctValor: totalGeral > 0 ? ((mapaAbc.get(k)?.valor || 0) / totalGeral) * 100 : 0,
      }));

      const mapaTipo = somaPor((c) => c.tipo);
      const tipos = ["PJ", "PF", "Não identificado"]
        .map((k) => ({ tipo: k, clientes: mapaTipo.get(k)?.clientes || 0, valor: mapaTipo.get(k)?.valor || 0 }))
        .filter((t) => t.clientes > 0);

      const segmentos = Array.from(somaPor((c) => c.segmento).entries())
        .map(([segmento, a]) => ({ segmento, ...a }))
        .sort((a, b) => b.valor - a.valor);

      const vendedores = Array.from(somaPor((c) => c.vendedor).entries())
        .map(([vendedor, a]) => ({ vendedor, ...a }))
        .sort((a, b) => b.valor - a.valor);

      // Serie final: um ponto por mes do periodo (mes sem titulo entra zerado).
      const recPorMes = new Map(serieRec.map((r: any) => [String(r.mes), r]));
      const nfPorMes = new Map(serieNf.map((r: any) => [String(r.m), Number(r.valor) || 0]));
      const serie = meses.map((m) => {
        const r: any = recPorMes.get(m) || {};
        return {
          mes: m,
          valor: Number(r.valor) || 0,
          titulos: Number(r.titulos) || 0,
          clientes: Number(r.clientes) || 0,
          valorNf: nfPorMes.has(m) ? (nfPorMes.get(m) as number) : null,
        };
      });

      const ultimo = serie[serie.length - 1];
      const penultimo = serie.length > 1 ? serie[serie.length - 2] : null;
      const mesesComNf = serie.filter((s) => s.valorNf !== null && (s.valorNf as number) > 0).length;

      const kpis = {
        faturamento: totalGeral,
        clientes: clientes.length,
        titulos: clientes.reduce((s, c) => s + c.titulos, 0),
        mediaMensal: meses.length ? totalGeral / meses.length : 0,
        ticketMedioCliente: clientes.length ? totalGeral / clientes.length : 0,
        mesAtual: ultimo ? ultimo.valor : 0,
        mesAtualLabel: ultimo ? ultimo.mes : null,
        mesAnterior: penultimo ? penultimo.valor : 0,
        varPct: penultimo && penultimo.valor > 0 && ultimo ? ((ultimo.valor - penultimo.valor) / penultimo.valor) * 100 : null,
        clientesMesAtual: ultimo ? ultimo.clientes : 0,
        semCadastro: clientes.filter((c) => !c.cadastrado).length,
      };

      const LIMITE = 2000;
      res.json({
        ok: true,
        periodo: { inicio, fim, meses, mesesQtd: meses.length },
        fonte: {
          base: "receivables (títulos emitidos, exclui cancelados)",
          comparativo: "NF-e de venda autorizada (regra oficial a partir de " + VIGENCIA_REGRA_OFICIAL + ")",
          mesesComNf,
          mediaPonderada: "peso linear por recência: o mês mais antigo pesa 1 e o mais recente pesa " + meses.length,
        },
        kpis,
        serie,
        abc,
        tipos,
        segmentos,
        vendedores,
        clientesTotal: clientes.length,
        clientesTruncado: clientes.length > LIMITE,
        clientes: clientes.slice(0, LIMITE),
      });
    } catch (e: any) {
      console.error("[gestao-carteiras]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
