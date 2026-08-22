// server/carteira-routes.ts
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — VENDAS  (tela /gestao-carteiras)
//
// Um unico endpoint read-only que devolve tudo que o dashboard precisa:
//   1. serie mensal de faturamento (jan/2025 -> mes corrente)
//   2. classe do cliente (A+/A-/.../D-)
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
import { authenticateUser } from "./authMiddleware";

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

/** Quantos meses separam 'YYYY-MM' de 'YYYY-MM' (b - a). */
function distanciaMeses(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
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

/** Faixas de ticket medio. Contiguas e sem buraco: todo cliente cai em uma. */
export const FAIXAS_TICKET: Array<{ chave: string; label: string; min: number; max: number | null }> = [
  { chave: "f1", label: "Até R$ 299,99", min: 0, max: 299.99 },
  { chave: "f2", label: "R$ 300,00 a R$ 500,00", min: 300, max: 500 },
  { chave: "f3", label: "R$ 501,00 a R$ 799,00", min: 500.01, max: 799 },
  { chave: "f4", label: "R$ 800,00 a R$ 1.500,00", min: 799.01, max: 1500 },
  { chave: "f5", label: "R$ 1.501,00 a R$ 5.000,00", min: 1500.01, max: 5000 },
  { chave: "f6", label: "Acima de R$ 5.000,00", min: 5000.01, max: null },
];

// ── CLASSE DO CLIENTE (A+ / A- / B+ ... / D-) ─────────────────────────────────
// A LETRA e o nivel de faturamento: o ticket medio do cliente (o que ele fatura
// por mes QUANDO compra) nas mesmas faixas do quadro de ticket medio, agrupadas
// de 6 para 4:
//   A = acima de R$ 1.501/mes   (faixas f5+f6)
//   B = R$ 800,00 a R$ 1.500,00 (faixa  f4)
//   C = R$ 300,00 a R$ 799,00   (faixas f2+f3)
//   D = ate R$ 299,99           (faixa  f1)
// O SINAL e a positivacao de pagamento, medida em duas pernas:
//   + = pagou pelo menos 80% dos titulos do periodo em ate 3 dias do vencimento
//       E nao tem nada vencido em aberto hoje;
//   - = qualquer outro caso (nao chega aos 80% ou esta devendo hoje).
// Os 3 dias de folga existem porque boleto que vence em fim de semana ou feriado
// so compensa no dia util seguinte — atraso de 1 ou 2 dias raramente e o cliente.
export const CLASSE_LETRAS = ["A", "B", "C", "D"] as const;
export type ClasseLetra = (typeof CLASSE_LETRAS)[number];
export const CLASSE_LABEL: Record<ClasseLetra, string> = {
  A: "Acima de R$ 1.501,00/mês",
  B: "R$ 800,00 a R$ 1.500,00/mês",
  C: "R$ 300,00 a R$ 799,00/mês",
  D: "Até R$ 299,99/mês",
};
/** Tolerancia, em dias corridos apos o vencimento, que ainda conta como pago em dia. */
export const CLASSE_DIAS_TOLERANCIA = 3;
/** Fatia minima de titulos pagos dentro da tolerancia para o cliente ganhar o "+". */
export const CLASSE_PONTUALIDADE_MIN = 0.8;

export function letraDoTicket(ticket: number): ClasseLetra {
  const t = Number(ticket) || 0;
  if (t > 1500) return "A";
  if (t > 799) return "B";
  if (t >= 300) return "C";
  return "D";
}

/**
 * @param pontualidade fatia (0..1) de titulos pagos dentro da tolerancia, ou
 *        `null` quando NENHUM titulo do cliente tem data de baixa registrada
 *        (titulo antigo importado do Omie guarda o valor pago, mas nao a data);
 *        nesse caso o cliente e julgado so pelo debito de hoje.
 * @param debito valor vencido em aberto HOJE.
 */
export function sinalDePagamento(pontualidade: number | null, debito: number): "+" | "-" {
  if ((Number(debito) || 0) > 0) return "-";
  if (pontualidade === null) return "+";
  return pontualidade >= CLASSE_PONTUALIDADE_MIN ? "+" : "-";
}

/** As 8 classes na ordem em que aparecem na tela: A+, A-, B+, B-, C+, C-, D+, D-. */
export const CLASSES_ORDEM: string[] = CLASSE_LETRAS.flatMap((l) => [`${l}+`, `${l}-`]);

export function registerCarteira(app: Express) {
  // ---------------------------------------------------------------------------
  // GET /api/reports/gestao-carteiras?inicio=2025-01&fim=2026-08
  // ---------------------------------------------------------------------------
  app.get("/api/reports/gestao-carteiras", authenticateUser, async (req: Request, res: Response) => {
    try {
      const hoje = mesAtual();
      const inicio = normMes(req.query.inicio, "2025-01");
      const fimBruto = normMes(req.query.fim, hoje);
      const fim = fimBruto > hoje ? hoje : fimBruto;
      const iniDate = `${inicio}-01`;
      const fimDateExcl = proximoMes1(fim);
      const meses = listaMeses(inicio, fim);

      const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

      // ── ESCOPO DE QUEM ESTA OLHANDO ─────────────────────────────────────────
      // Vendedor e telemarketing enxergam SO a propria carteira. O corte e feito
      // aqui no servidor (nao na tela): quem chamar o endpoint na mao tambem so
      // recebe os clientes dele. Os demais papeis continuam vendo tudo.
      const usuario: any = (req as any).currentUser || (req as any).user || null;
      const papel = String(usuario?.role || "");
      const restrito = ["vendedor", "telemarketing"].includes(papel);
      const limpaId = (x: any) => String(x || "").replace(/[^A-Za-z0-9_-]/g, "");
      const idsCarteira: string[] = [];
      if (restrito) {
        const add = (x: any) => { const v = limpaId(x); if (v && !idsCarteira.includes(v)) idsCarteira.push(v); };
        add(usuario?.id);
        const codigos: any[] = [];
        if (usuario?.omieVendorCode) codigos.push(usuario.omieVendorCode);
        const mapaCodigos = usuario?.omieVendorCodes;
        if (mapaCodigos && typeof mapaCodigos === "object") {
          for (const v of Object.values(mapaCodigos)) if (v) codigos.push(v);
        }
        for (const c of codigos) { add(c); add(`omie-vendor-${limpaId(c)}`); }
        // Vendedor sem nenhum vinculo nao pode cair no "sem filtro" — fica vazio.
        if (!idsCarteira.length) idsCarteira.push("__sem_carteira__");
      }
      const nomeUsuario = [usuario?.firstName, usuario?.lastName].filter(Boolean).join(" ").trim() || usuario?.email || "";

      // CTE com os documentos da carteira do usuario (so quando ha restricao).
      const CTE_CARTEIRA = restrito
        ? `minha_carteira AS (
             SELECT DISTINCT NULLIF(regexp_replace(COALESCE(NULLIF(cnpj,''),NULLIF(cpf,''),''),'[^0-9]','','g'),'') AS doc
             FROM customers
             WHERE COALESCE(is_supplier,false) = false
               AND seller_id IN (${idsCarteira.map((i) => `'${i}'`).join(",")})
           ),
        `
        : "";
      const FILTRO_CARTEIRA = restrito
        ? ` WHERE doc IN (SELECT doc FROM minha_carteira WHERE doc IS NOT NULL)`
        : "";

      // ── O QUE NAO E FATURAMENTO DE VENDA ────────────────────────────────────
      // Mesma regua do dashboard geral (server/faturamento-oficial.ts): so entra
      // VENDA. Ficam de fora, cada um com seu balde (devolvidos em `excluidos`):
      // (a) GRUPO — titulo no CNPJ de uma das 4 empresas do grupo (transferencia
      //     entre empresas, o "cliente" e a propria casa) ou de parceiro que nao
      //     e cliente de venda (BARUC, transporte/armazenagem);
      // (b) CATEGORIA — aporte de socio, emprestimo, adiantamento, devolucao,
      //     troca, amostra, bonificacao, brinde, doacao, remessa, transferencia;
      //     e tambem a categoria que e SO codigo de plano de contas ("1.01.02"),
      //     porque medido em ago/2026 98% desse balde era aporte de socio via PIX;
      // (c) NF INVALIDA — titulo amarrado a uma NF-e que NAO e venda: cancelada,
      //     rejeitada, rascunho, entrada, homologacao, devolucao, troca, amostra,
      //     bonificacao, remessa ou transferencia (criterio = nfVendaWhere, o
      //     mesmo do faturamento oficial);
      // (d) LIXEIRA — pedido do pipeline mandado para a lixeira nunca entra em
      //     relatorio (regra 5 de faturamento-oficial.ts).
      // As 4 empresas do grupo + parceiros que NAO sao cliente de venda (BARUC =
      // transporte/armazenagem). Casa por CNPJ e, como rede de seguranca para o
      // titulo que vier sem documento, tambem pelo nome como palavra inteira
      // (PURO / BARUC) — "PANIFICADORA PURA DELICIA" e os 44 clientes com "BAR"
      // no nome nao sao atingidos.
      const CNPJS_GRUPO = ["28295493000153", "28295493000234", "28295493000315", "52921727000105"];
      const CNPJS_NAO_CLIENTE = ["14877972000173"]; // BARUC BRASILIA TRANSPORTE E ARMAZENAGEM
      const DOCS_FORA = [...CNPJS_GRUPO, ...CNPJS_NAO_CLIENTE];
      const C_GRUPO = `(COALESCE(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'') IN (${DOCS_FORA.map((c) => `'${c}'`).join(",")})
                        OR UPPER(COALESCE(customer_name,'')) ~ '(^|[^A-Z])(PURO|BARUC)([^A-Z]|$)')`;
      const C_CATEGORIA = `(UPPER(COALESCE(category,'')) ~ '(APORTE|SOCIO|SÓCIO|EMPREST|ADIANT|DEVOLU|TROCA|AMOSTRA|BONIFICA|BRINDE|DOACAO|DOAÇÃO|REMESSA|TRANSFER)'
                            OR TRIM(COALESCE(category,'')) ~ '^[0-9]+([.-][0-9]+)*$')`;
      const C_NF_INVALIDA = `(receivables.fiscal_invoice_id IS NOT NULL AND NOT EXISTS (
                                SELECT 1 FROM fiscal_invoices fx
                                WHERE fx.id = receivables.fiscal_invoice_id AND ${nfVendaWhere("fx")}))`;
      const C_LIXEIRA = `EXISTS (SELECT 1 FROM billing_pipeline bpx
                                 WHERE bpx.id = receivables.billing_pipeline_id AND bpx.stage = 'lixeira')`;
      const FILTRO_VENDA = `
            AND NOT (${C_GRUPO})
            AND NOT ${C_CATEGORIA}
            AND NOT ${C_NF_INVALIDA}
            AND NOT ${C_LIXEIRA}`;

      // CTE comum: titulos validos do periodo, ja com a chave do cliente.
      const CTE_REC = `
        WITH ${CTE_CARTEIRA}r AS (
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
            ${FILTRO_VENDA}
        ),
        rk AS (
          SELECT COALESCE(doc, 'N|' || COALESCE(nome,'?')) AS chave, doc, nome, mes, v FROM r${FILTRO_CARTEIRA}
        )`;

      // 1) Serie mensal (base = titulos emitidos)
      const serieRec = await q(`${CTE_REC}
        SELECT mes,
               COALESCE(SUM(v),0)::float   AS valor,
               COUNT(*)::int               AS titulos,
               COUNT(DISTINCT chave)::int  AS clientes
        FROM rk GROUP BY mes ORDER BY mes`);

      // 1b) O que ficou de fora, balde a balde (vira nota de rodape + tooltip).
      //     Os baldes se sobrepoem (um titulo pode cair em mais de um), por isso
      //     o total sai de uma contagem propria e nao da soma das partes.
      const JANELA_FORA = `
        FROM receivables
        WHERE issue_date >= '${iniDate}'
          AND issue_date <  '${fimDateExcl}'
          AND deleted_at IS NULL
          AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0`;
      const VAL = `COALESCE(NULLIF(amount::text,'')::numeric,0)`;
      const NAO_CANCELADO = `COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')`;
      const foraRows = restrito ? [] : await q(`
        SELECT
          COUNT(*) FILTER (WHERE ${NAO_CANCELADO} AND NOT (TRUE ${FILTRO_VENDA}))::int          AS titulos,
          COALESCE(SUM(${VAL}) FILTER (WHERE ${NAO_CANCELADO} AND NOT (TRUE ${FILTRO_VENDA})),0)::float AS valor,
          COUNT(*) FILTER (WHERE NOT (${NAO_CANCELADO}))::int                                   AS n_cancelado,
          COALESCE(SUM(${VAL}) FILTER (WHERE NOT (${NAO_CANCELADO})),0)::float                  AS v_cancelado,
          COUNT(*) FILTER (WHERE ${NAO_CANCELADO} AND ${C_GRUPO})::int                          AS n_grupo,
          COALESCE(SUM(${VAL}) FILTER (WHERE ${NAO_CANCELADO} AND ${C_GRUPO}),0)::float         AS v_grupo,
          COUNT(*) FILTER (WHERE ${NAO_CANCELADO} AND ${C_CATEGORIA})::int                      AS n_categoria,
          COALESCE(SUM(${VAL}) FILTER (WHERE ${NAO_CANCELADO} AND ${C_CATEGORIA}),0)::float     AS v_categoria,
          COUNT(*) FILTER (WHERE ${NAO_CANCELADO} AND ${C_NF_INVALIDA})::int                    AS n_nf,
          COALESCE(SUM(${VAL}) FILTER (WHERE ${NAO_CANCELADO} AND ${C_NF_INVALIDA}),0)::float   AS v_nf,
          COUNT(*) FILTER (WHERE ${NAO_CANCELADO} AND ${C_LIXEIRA})::int                        AS n_lixeira,
          COALESCE(SUM(${VAL}) FILTER (WHERE ${NAO_CANCELADO} AND ${C_LIXEIRA}),0)::float       AS v_lixeira
        ${JANELA_FORA}`);

      // 2) Serie mensal comparativa — NF-e de VENDA.
      //    Ate 30/06/2026 vale o calculo legado; de 01/07/2026 em diante, a Regra
      //    Oficial (server/faturamento-oficial.ts). Mesmo criterio do dashboard.
      const VF = nfVendaWhere("fi");
      const VFROM = nfVendaFrom("fi");
      const VDATA = nfData("fi");
      const LEGADO = `status='authorized' AND COALESCE(operation_type,'saida') <> 'entrada' AND COALESCE(fin_nfe,'1') <> '4' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%DEVOL%' AND UPPER(COALESCE(nature_of_operation,'')) LIKE '%VENDA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TROCA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TRANSFER%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%REMESSA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%BONIFICA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%AMOSTRA%' AND (import_origin IS NULL OR TRIM(import_origin) = '')`;
      // A linha de NF-e e um comparativo da empresa inteira; num recorte de uma
      // carteira so ela confundiria (notas de outros vendedores). Fica de fora.
      let serieNf: any[] = [];
      try {
        if (restrito) throw new Error("escopo restrito: sem linha de NF-e");
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

      // 2b) DEBITO DA CARTEIRA — estoque de hoje, nao do periodo. Mesma regra da
      //     aba Contas a Receber e do alerta diario (server/debitos-vencidos-alert.ts):
      //     status 'vencida' OU 'a_vencer' com vencimento ja passado no fuso Brasil,
      //     valor em aberto = amount - amount_paid. Passa pelo mesmo FILTRO_VENDA:
      //     aporte de socio vencido nao e debito de cliente.
      const VENCIDO = `(COALESCE(status::text,'') = 'vencida'
                        OR (COALESCE(status::text,'') = 'a_vencer'
                            AND due_date::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date))`;
      const debitoRows = await q(`
        SELECT COALESCE(
                 NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),''),
                 'N|' || COALESCE(NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),''),'?')
               ) AS chave,
               COALESCE(SUM(COALESCE(NULLIF(amount::text,'')::numeric,0) - COALESCE(NULLIF(amount_paid::text,'')::numeric,0)),0)::float AS debito,
               COALESCE(MAX((now() AT TIME ZONE 'America/Sao_Paulo')::date - due_date::date),0)::int AS dias_vencido
        FROM receivables
        WHERE deleted_at IS NULL
          AND ${VENCIDO}
          AND (COALESCE(NULLIF(amount::text,'')::numeric,0) - COALESCE(NULLIF(amount_paid::text,'')::numeric,0)) > 0
          ${FILTRO_VENDA}
        GROUP BY 1`);
      const debitoPorChave = new Map<string, number>(
        debitoRows.map((r: any) => [String(r.chave), Number(r.debito) || 0]),
      );
      const diasVencidoPorChave = new Map<string, number>(
        debitoRows.map((r: any) => [String(r.chave), Number(r.dias_vencido) || 0]),
      );
      const debitoTotal = debitoRows.reduce((s2: number, r: any) => s2 + (Number(r.debito) || 0), 0);

      // 2c) PONTUALIDADE — a perna de historico da NOTA (o sinal + / -).
      //     Para cada titulo do periodo procuramos a data em que ele foi baixado:
      //     primeiro `paid_date` no proprio titulo, senao a ultima baixa lancada
      //     em receivable_payments. Titulo sem nenhuma das duas nao entra na conta
      //     (importacao antiga do Omie trouxe o valor pago, mas nao a data) — o
      //     cliente que so tem titulos assim fica com pontualidade `null` e e
      //     julgado apenas pelo debito de hoje.
      // Guarda contra data de baixa impossivel: medido em 17/ago/2026, 470 das 6.442
      // baixas do periodo (7,3%) tinham data ANTES da emissao do titulo (321) ou no
      // FUTURO (149) — dia e mes trocados na entrada. Uma baixa fora do intervalo
      // [emissao, hoje] e descartada: o titulo passa a contar como "sem data", que ja
      // e um caso previsto, em vez de gerar um atraso inventado.
      const HOJE_BR = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
      const pontRows = await q(`
        WITH pg AS (
          SELECT COALESCE(
                   NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),''),
                   'N|' || COALESCE(NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),''),'?')
                 ) AS chave,
                 due_date::date AS venc,
                 issue_date AS emissao,
                 COALESCE(status::text,'') AS st,
                 COALESCE(
                   CASE WHEN paid_date::date BETWEEN issue_date::date AND ${HOJE_BR}
                        THEN paid_date::date END,
                   (SELECT MAX(p.paid_at)::date FROM receivable_payments p
                     WHERE p.receivable_id = receivables.id AND p.deleted_at IS NULL
                       AND p.paid_at::date >= receivables.issue_date::date
                       AND p.paid_at::date <= ${HOJE_BR})
                 ) AS pago
          FROM receivables
          WHERE issue_date >= '${iniDate}'
            AND issue_date <  '${fimDateExcl}'
            AND deleted_at IS NULL
            AND due_date IS NOT NULL
            AND COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')
            AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
            ${FILTRO_VENDA}
        ), agg AS (
          SELECT chave,
                 COUNT(1) FILTER (WHERE pago IS NOT NULL)::int AS medidos,
                 COUNT(1) FILTER (WHERE pago IS NOT NULL AND pago - venc <= ${CLASSE_DIAS_TOLERANCIA})::int AS pontuais,
                 COALESCE(MAX(GREATEST(pago - venc, 0)) FILTER (WHERE pago IS NOT NULL), 0)::int AS pior_atraso,
                 COALESCE(AVG(GREATEST(pago - venc, 0)) FILTER (WHERE pago IS NOT NULL), 0)::float AS atraso_medio
          FROM pg GROUP BY 1
        ), ult AS (
          SELECT DISTINCT ON (chave) chave, venc, pago, st
          FROM pg ORDER BY chave, emissao DESC NULLS LAST, venc DESC
        )
        SELECT a.chave, a.medidos, a.pontuais, a.pior_atraso, a.atraso_medio,
               u.venc AS ult_venc,
               CASE
                 WHEN u.pago IS NOT NULL THEN GREATEST(u.pago - u.venc, 0)
                 WHEN u.st IN ('a_vencer','vencida')
                   THEN GREATEST((now() AT TIME ZONE 'America/Sao_Paulo')::date - u.venc, 0)
                 ELSE NULL
               END::int AS ult_atraso,
               CASE
                 WHEN u.pago IS NOT NULL AND u.pago <= u.venc THEN 'pago_em_dia'
                 WHEN u.pago IS NOT NULL                      THEN 'pago_atrasado'
                 WHEN u.st IN ('a_vencer','vencida')
                      AND u.venc < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'vencido'
                 WHEN u.st IN ('a_vencer','vencida')          THEN 'a_vencer'
                 ELSE 'sem_data'
               END AS ult_situacao
        FROM agg a LEFT JOIN ult u ON u.chave = a.chave`);
      type Pont = {
        medidos: number; pontuais: number; pior: number; medio: number;
        // Ultimo titulo emitido para o cliente no periodo: quanto ele atrasou (ou
        // esta atrasando, se ainda estiver vencido em aberto) e em que estado esta.
        ultAtraso: number | null; ultSituacao: string; ultVenc: string | null;
      };
      const pontPorChave = new Map<string, Pont>(
        pontRows.map((r: any) => [
          String(r.chave),
          {
            medidos: Number(r.medidos) || 0,
            pontuais: Number(r.pontuais) || 0,
            pior: Number(r.pior_atraso) || 0,
            medio: Number(r.atraso_medio) || 0,
            ultAtraso: r.ult_atraso === null || r.ult_atraso === undefined ? null : Number(r.ult_atraso),
            ultSituacao: String(r.ult_situacao || "sem_data"),
            ultVenc: r.ult_venc ? String(r.ult_venc).slice(0, 10) : null,
          },
        ]),
      );

      // 2c) DATA DE CONQUISTA — a evidencia mais antiga de que o cliente existe.
      //     `customers.created_at` sozinho engana: a base do 2.0 nasceu de importacoes
      //     (774 cadastros em 19/06/2026, 395 em 14/10/2025...), entao para quem veio
      //     do 1.0 essa data e a da importacao, nao a da conquista. Por isso pegamos
      //     tambem o PRIMEIRO titulo de todos os tempos (sem recorte de periodo) e
      //     ficamos com a data menor entre as duas.
      const primeiraVendaRows = await q(`
        SELECT COALESCE(
                 NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),''),
                 'N|' || COALESCE(NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),''),'?')
               ) AS chave,
               MIN(issue_date)::date::text AS primeira
        FROM receivables
        WHERE deleted_at IS NULL
          AND issue_date IS NOT NULL
          AND COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')
          AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
          ${FILTRO_VENDA}
        GROUP BY 1`);
      const primeiraVendaPorChave = new Map<string, string>(
        primeiraVendaRows.map((r: any) => [String(r.chave), String(r.primeira || "")]),
      );

      // 2d) IDAS E VINDAS — inativacoes e reativacoes registradas na auditoria
      //     (`customer_change_history`, campo isActive). O historico so existe a
      //     partir de quando a auditoria entrou; antes disso sobra o
      //     `inactivated_at` do cadastro, que guarda SO a inativacao vigente
      //     (a reativacao limpa o campo).
      let eventosPorCliente = new Map<string, Array<{ data: string; tipo: string }>>();
      try {
        const evRows = await q(`
          SELECT customer_id,
                 created_at::date::text AS data,
                 CASE WHEN lower(COALESCE(new_value,'')) IN ('sim','true','t','1') THEN 'reativado' ELSE 'inativado' END AS tipo
          FROM customer_change_history
          WHERE field = 'isActive'
          ORDER BY customer_id, created_at`);
        for (const r of evRows as any[]) {
          const k = String(r.customer_id);
          if (!eventosPorCliente.has(k)) eventosPorCliente.set(k, []);
          eventosPorCliente.get(k)!.push({ data: String(r.data), tipo: String(r.tipo) });
        }
      } catch (e: any) {
        console.warn("[gestao-carteiras] historico de ativacao indisponivel:", e?.message || e);
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
          SELECT DISTINCT ON (doc) doc, id, name, customer_type, seller_id, city, segmento_principal, is_active,
                 created_at, inactivated_at
          FROM (
            SELECT NULLIF(regexp_replace(COALESCE(NULLIF(cnpj,''),NULLIF(cpf,''),''),'[^0-9]','','g'),'') AS doc,
                   id, name, customer_type, seller_id, city, segmento_principal, is_active,
                   created_at, inactivated_at,
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
               c.id AS cad_id, c.created_at AS cad_criado, c.inactivated_at AS cad_inativado,
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
        const mesesComCompra = Number(r.meses_com_compra) || 0;
        // SITUACAO (baldes exclusivos, nesta ordem):
        //  inativo = cadastro inativado — a empresa ja disse que ele saiu;
        //  perdido = cadastro ativo, comprava com regularidade (3+ meses com
        //            compra) e esta ha 3 meses ou mais sem comprar — churn
        //            silencioso, o balde que da para reagir;
        //  ativo   = o resto.
        const mesesSemComprar = r.ultimo_mes ? distanciaMeses(String(r.ultimo_mes), hoje) : 999;
        // CLASSE: letra pelo ticket medio, sinal pela pontualidade + debito de hoje.
        const chaveCli = String(r.chave);
        const pg = pontPorChave.get(chaveCli);
        const pontualidade = pg && pg.medidos > 0 ? pg.pontuais / pg.medidos : null;
        const debitoCli = debitoPorChave.get(chaveCli) || 0;
        const ticketCli = mesesComCompra > 0 ? total / mesesComCompra : 0;
        const cadastroInativo = r.cad_nome ? r.is_active !== true : false;
        const situacao: "ativo" | "inativo" | "perdido" = cadastroInativo
          ? "inativo"
          : mesesComCompra >= 3 && mesesSemComprar >= 3
            ? "perdido"
            : "ativo";

        // ── DATA DE CONQUISTA + IDAS E VINDAS ────────────────────────────────
        // Conquista = a evidencia mais antiga: o cadastro no sistema ou o
        // primeiro titulo dele, o que vier primeiro.
        const cadastroEm = r.cad_criado ? String(r.cad_criado).slice(0, 10) : null;
        const primeiraVenda = primeiraVendaPorChave.get(chaveCli) || null;
        const conquista = [cadastroEm, primeiraVenda].filter(Boolean).sort()[0] || null;
        // Linha do tempo: o que a auditoria registrou + a inativacao vigente do
        // cadastro (que a auditoria pode nao ter, se e anterior a ela).
        const eventos: Array<{ data: string; tipo: string }> = [
          ...(r.cad_id ? eventosPorCliente.get(String(r.cad_id)) || [] : []),
        ];
        const inativadoEm = r.cad_inativado ? String(r.cad_inativado).slice(0, 10) : null;
        if (inativadoEm && !eventos.some((e) => e.tipo === "inativado" && e.data === inativadoEm)) {
          eventos.push({ data: inativadoEm, tipo: "inativado" });
        }
        eventos.sort((x, y) => x.data.localeCompare(y.data));

        return {
          chave: String(r.chave),
          doc,
          nome: String(r.cad_nome || r.nome || "(sem nome)"),
          tipo: classificaTipo(doc, r.customer_type),
          vendedor: String(r.vendedor || "Sem vendedor"),
          cidade: r.city ? String(r.city) : "",
          // Mesmo segmento exibido no filtro de Clientes Ativos: valor bruto de
          // segmento_principal (sem normalizar a caixa) e "(Sem segmento)" quando vazio.
          segmento: String(r.segmento_principal ?? "").trim() || "(Sem segmento)",
          cadastrado: !!r.cad_nome,
          ativo: r.is_active === true,
          total,
          titulos: Number(r.titulos) || 0,
          mesesComCompra: Number(r.meses_com_compra) || 0,
          primeiraCompra: r.primeiro_mes || null,
          ultimaCompra: r.ultimo_mes || null,
          mediaSimples: meses.length ? total / meses.length : 0,
          mediaPonderada: ponderado / somaPesos,
          // Ritmo do cliente QUANDO ele compra (nao dilui pelos meses parados) —
          // e a base do "quanto deixaria de entrar se ele parar".
          conquista,
          cadastroEm,
          primeiraVenda,
          eventos,
          potencialMes: ticketCli,
          debito: debitoCli,
          // Dias vencidos do titulo em aberto mais antigo (0 = nao deve nada hoje).
          diasVencido: diasVencidoPorChave.get(chaveCli) || 0,
          // Positivacao de pagamento: `null` = nenhum titulo com data de baixa.
          pontualidade,
          titulosMedidos: pg?.medidos || 0,
          piorAtraso: pg?.pior || 0,
          atrasoMedio: pg?.medio || 0,
          // Ultimo titulo do cliente: e o retrato mais recente do comportamento dele.
          atrasoUltimo: pg?.ultAtraso ?? null,
          situacaoUltimo: pg?.ultSituacao || "sem_data",
          vencimentoUltimo: pg?.ultVenc || null,
          classe: `${letraDoTicket(ticketCli)}${sinalDePagamento(pontualidade, debitoCli)}`,
          situacao,
          mesesSemComprar,
          porMes: Object.fromEntries(Object.entries(porMes).map(([m, v]) => [m, Number(v) || 0])),
        };
      });

      const totalGeral = clientes.reduce((s, c) => s + c.total, 0);

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

      const mapaTipo = somaPor((c) => c.tipo);
      const tipos = ["PJ", "PF", "Não identificado"]
        .map((k) => ({ tipo: k, clientes: mapaTipo.get(k)?.clientes || 0, valor: mapaTipo.get(k)?.valor || 0 }))
        .filter((t) => t.clientes > 0);

      // QUANTIDADE DE CLIENTES POR TICKET MEDIO — substituiu a pizza "PJ x PF".
      // Ticket medio do cliente = `potencialMes` (total ÷ meses em que ele comprou),
      // ou seja, o ritmo dele QUANDO compra — nao dilui pelos meses parados.
      // O faturamento da faixa e a soma da media mensal (`mediaSimples`) dos clientes
      // dela, entao a soma das faixas fecha com o faturamento medio/mes do periodo.
      const faixasTicket = FAIXAS_TICKET.map((f) => {
        const dentro = clientes.filter((c) => c.potencialMes >= f.min && (f.max === null || c.potencialMes <= f.max));
        const fatMes = dentro.reduce((s, c) => s + c.mediaSimples, 0);
        return {
          chave: f.chave,
          label: f.label,
          min: f.min,
          max: f.max,
          clientes: dentro.length,
          pj: dentro.filter((c) => c.tipo === "PJ").length,
          pf: dentro.filter((c) => c.tipo === "PF").length,
          valor: dentro.reduce((s, c) => s + c.total, 0),
          faturamentoMes: fatMes,
        };
      });

      // CLASSE A+/A-/B+/.../D- — cruza o quadro de ticket medio com o debito da
      // carteira. Uma linha por classe, na ordem A+, A-, B+, B-, C+, C-, D+, D-.
      // `faturamentoMes` usa a mesma base do quadro de ticket (media mensal do
      // cliente no periodo), entao a soma das classes fecha com o total de la.
      const classes = CLASSES_ORDEM.map((n) => {
        const dentro = clientes.filter((c) => c.classe === n);
        return {
          classe: n,
          letra: n[0],
          sinal: n[1],
          label: CLASSE_LABEL[n[0] as ClasseLetra],
          clientes: dentro.length,
          pj: dentro.filter((c) => c.tipo === "PJ").length,
          pf: dentro.filter((c) => c.tipo === "PF").length,
          valor: dentro.reduce((s, c) => s + c.total, 0),
          faturamentoMes: dentro.reduce((s, c) => s + c.mediaSimples, 0),
          debito: dentro.reduce((s, c) => s + c.debito, 0),
          comDebito: dentro.filter((c) => c.debito > 0).length,
          semMedicao: dentro.filter((c) => c.pontualidade === null).length,
        };
      });
      const classeRegra = {
        toleranciaDias: CLASSE_DIAS_TOLERANCIA,
        pontualidadeMin: CLASSE_PONTUALIDADE_MIN,
        letras: CLASSE_LETRAS.map((l) => ({ letra: l, label: CLASSE_LABEL[l] })),
        semMedicao: clientes.filter((c) => c.pontualidade === null).length,
      };

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
        excluidos: {
          titulos: Number(foraRows?.[0]?.titulos) || 0,
          valor: Number(foraRows?.[0]?.valor) || 0,
          motivo: "títulos que não são venda a cliente",
          detalhe: [
            { motivo: "NF-e cancelada, devolução, troca, amostra, bonificação, remessa ou transferência", titulos: Number(foraRows?.[0]?.n_nf) || 0, valor: Number(foraRows?.[0]?.v_nf) || 0 },
            { motivo: "categoria de não-venda (aporte de sócio, empréstimo, adiantamento, devolução, troca, amostra, bonificação) e lançamento contábil sem descrição", titulos: Number(foraRows?.[0]?.n_categoria) || 0, valor: Number(foraRows?.[0]?.v_categoria) || 0 },
            { motivo: "empresas do grupo e parceiros que não são cliente de venda (PURO, BARUC)", titulos: Number(foraRows?.[0]?.n_grupo) || 0, valor: Number(foraRows?.[0]?.v_grupo) || 0 },
            { motivo: "pedido mandado para a lixeira do pipeline", titulos: Number(foraRows?.[0]?.n_lixeira) || 0, valor: Number(foraRows?.[0]?.v_lixeira) || 0 },
          ].filter((x) => x.titulos > 0),
          cancelados: { titulos: Number(foraRows?.[0]?.n_cancelado) || 0, valor: Number(foraRows?.[0]?.v_cancelado) || 0 },
        },
        fonte: {
          base: "receivables (títulos emitidos, exclui cancelados)",
          comparativo: "NF-e de venda autorizada (regra oficial a partir de " + VIGENCIA_REGRA_OFICIAL + ")",
          mesesComNf,
          mediaPonderada: "peso linear por recência: o mês mais antigo pesa 1 e o mais recente pesa " + meses.length,
        },
        kpis,
        serie,
        tipos,
        faixasTicket,
        classes,
        classeRegra,
        segmentos,
        vendedores,
        debitoTotal: restrito ? clientes.reduce((s2, c) => s2 + (c.debito || 0), 0) : debitoTotal,
        escopo: { restrito, papel, vendedor: nomeUsuario },
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
