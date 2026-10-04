// ---------------------------------------------------------------------------
// PROGRAMAÇÃO DE PRODUÇÃO (módulo Indústria › aba Programação) — 04/out/2026
// ---------------------------------------------------------------------------
// Relatório que responde, por produto acabado:
//   • SAÍDAS (venda / troca / amostra / bonificação) por dia, semana e mês,
//     com filtro por instância (GYN = escritório/galpão, BSB, IND)
//   • ESTOQUE NA FÁBRICA (lotes in_use da IND) e ESTOQUE NO ESCRITÓRIO (GYN),
//     mais BSB
//   • LEAD TIME / COBERTURA: média diária de saída, dias de cobertura do
//     estoque, estoque mínimo (ponto de reposição), estoque-alvo, data
//     prevista de ruptura e data-limite para iniciar a produção
//   • PROGRAMAR PRODUÇÃO: sugestão de quantidade (arredondada em fardos) e
//     criação em lote de ordens de produção 'planejada'
//
// Fontes (somente leitura, exceto a criação de OP e os parâmetros):
//   inventory_movements (consume / cancel_reversal, source_type='invoice')
//       → saída real de estoque por instância (IND, GYN, BSB);
//   fiscal_invoices/_items (NF de saída autorizada SEM baixa de lote, qualquer
//       instância/natureza) → saídas que não passaram pelo estoque (histórico da
//       SERV antes do controle, NF fora do pipeline). Regra 04/out: tudo que sai,
//       por qualquer instância e propósito, conta nas saídas e nos estoques. a OPERAÇÃO vem do
//         billing_pipeline (operation_type) via source_id; transferências
//         IND→filial NÃO são demanda (são movimentação interna).
//         created_at é gravado em UTC (now() do banco) → convertido p/ BRT.
//   inventory_lots (in_use + blocked, ativos)      → estoque por instância
//   production_orders (planejada / em_producao)   → produção já programada
//   products (fardo_filas × fardo_por_fila)       → arredondamento em fardos
//   system_settings['programacao_producao']       → parâmetros de lead time
//
// Acesso: prefixo /api/industria exige admin (perfil industria entra como
// admin com req.perfilIndustria = true). Parâmetros só admin de verdade.
// ---------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { ehDiaUtilBR } from "../shared/tempo";
import { nfData } from "./faturamento-oficial";

const CHAVE_PARAMS = "programacao_producao";

export type ParametrosProgramacao = {
  /** Dias entre abrir a OP e o lote estar disponível na IND (produção + quarentena/rotulagem). */
  leadProducaoDias: number;
  /** Dias para o lote sair da IND e chegar à filial (NF de transferência + transporte). */
  leadTransferenciaDias: number;
  /** Estoque de segurança, em dias de venda. */
  segurancaDias: number;
  /** Quantos dias de venda a produção sugerida deve cobrir ALÉM do mínimo. */
  horizonteDias: number;
  /** Janela (dias corridos, contados para trás a partir de hoje) usada para a média de saídas; a média divide pelos DIAS ÚTEIS da janela. */
  janelaMediaDias: number;
  /** Lote mínimo de produção, em unidades (0 = sem mínimo). */
  loteMinimoUnidades: number;
  /** Arredondar a sugestão para múltiplos de fardo. */
  arredondarFardo: boolean;
};

const PADRAO: ParametrosProgramacao = {
  leadProducaoDias: 2,
  leadTransferenciaDias: 1,
  segurancaDias: 7,
  horizonteDias: 14,
  janelaMediaDias: 30,
  loteMinimoUnidades: 0,
  arredondarFardo: true,
};

const nz = (v: any, d: number): number => {
  const n = Number(String(v ?? "").replace(",", "."));
  return isFinite(n) && n >= 0 ? n : d;
};
const isoDate = (v: any): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
const str = (v: any, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s === "" ? null : s;
};
const userOf = (req: any): string =>
  str(req.currentUser?.email || req.currentUser?.id, 120) || "admin-2.0";

function normalizar(p: any): ParametrosProgramacao {
  const o = p && typeof p === "object" ? p : {};
  return {
    leadProducaoDias: nz(o.leadProducaoDias, PADRAO.leadProducaoDias),
    leadTransferenciaDias: nz(o.leadTransferenciaDias, PADRAO.leadTransferenciaDias),
    segurancaDias: nz(o.segurancaDias, PADRAO.segurancaDias),
    horizonteDias: nz(o.horizonteDias, PADRAO.horizonteDias),
    janelaMediaDias: Math.max(7, Math.min(365, nz(o.janelaMediaDias, PADRAO.janelaMediaDias))),
    loteMinimoUnidades: nz(o.loteMinimoUnidades, PADRAO.loteMinimoUnidades),
    arredondarFardo: o.arredondarFardo == null ? PADRAO.arredondarFardo : !!o.arredondarFardo,
  };
}

export async function lerParametrosProgramacao(): Promise<ParametrosProgramacao> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${CHAVE_PARAMS} LIMIT 1`);
    const row = (r.rows || [])[0];
    if (!row) return { ...PADRAO };
    return normalizar(JSON.parse(String(row.value || "{}")));
  } catch (e: any) {
    console.warn("[programacao-producao] parametros:", e?.message);
    return { ...PADRAO };
  }
}

async function gravarParametros(p: ParametrosProgramacao, quem: string): Promise<void> {
  const valor = JSON.stringify(p);
  await db.execute(sql`
    INSERT INTO system_settings (key, value, description, updated_by, updated_at)
    VALUES (${CHAVE_PARAMS}, ${valor}, 'Lead time e cobertura da Programação de Produção (Indústria)', ${quem}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`);
}

// --- helpers de data (sempre em BRT, por string YYYY-MM-DD) --------------
const hojeBRT = (): string =>
  new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const somarDias = (ymd: string, dias: number): string => {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(dias));
  return d.toISOString().slice(0, 10);
};

/** Dias úteis (seg–sex, sem feriado nacional) entre duas datas, inclusive. */
const diasUteisNaJanela = (de: string, ate: string): number => {
  let n = 0; let cur = de; let guarda = 0;
  while (cur <= ate && guarda++ < 400) { if (ehDiaUtilBR(cur)) n++; cur = somarDias(cur, 1); }
  return n;
};
/** Soma N dias úteis a uma data (N pode ser negativo). N = 0 devolve a própria data. */
const somarDiasUteis = (ymd: string, n: number): string => {
  let cur = ymd; let falta = Math.abs(Math.round(n)); const passo = n < 0 ? -1 : 1; let guarda = 0;
  while (falta > 0 && guarda++ < 2000) { cur = somarDias(cur, passo); if (ehDiaUtilBR(cur)) falta--; }
  return cur;
};

// Sabor/tamanho a partir do nome (mesma regra do dashboard Produção & Faturamento).
const norm = (s: any) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const parseNome = (n: any) => {
  const m = String(n || "").match(/(900|350)\s*ml/i);
  const tam = m ? m[1] : null;
  const sabor = norm(n).replace(/^SUCO MISTO DE FRUTA\s*-\s*/, "").replace(/^SUCO\s*-?\s*/, "").replace(/\s*\d+\s*ML.*$/, "").trim();
  return { sabor, tam };
};

const TIPOS = ["venda", "troca", "amostra", "bonificacao", "outros"] as const;
type Tipo = (typeof TIPOS)[number];
const tipoDe = (op: any, temNf: boolean, nfNatureza = ""): Tipo => {
  let s = String(op || "").toLowerCase();
  // Sem card no pipeline (emissão/cancelamento direto da NF): classifica pela natureza da nota.
  if (!s && temNf) {
    const nat = String(nfNatureza || "").toUpperCase();
    s = nat.includes("TROCA") ? "troca" : nat.includes("AMOSTRA") ? "amostra" : nat.includes("BONIFIC") ? "bonificacao" : "venda";
  }
  if (s === "venda") return "venda";
  if (s === "troca") return "troca";
  if (s === "amostra") return "amostra";
  if (s === "bonificacao" || s === "bonificação") return "bonificacao";
  // Sem card no pipeline mas com NF (emissão direta) → tratamos como venda.
  if (!s && temNf) return "venda";
  return s ? "outros" : "venda";
};

export function registerProgramacaoProducaoRoutes(app: Express) {
  // ---- parâmetros ---------------------------------------------------------
  app.get("/api/industria/programacao/parametros", async (_req: any, res) => {
    try {
      res.json({ parametros: await lerParametrosProgramacao(), padrao: PADRAO });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.put("/api/industria/programacao/parametros", async (req: any, res) => {
    try {
      // Perfil industria (Naiara) pode VER e PROGRAMAR; os parâmetros de
      // lead time são decisão do admin.
      if (req.perfilIndustria) return res.status(403).json({ error: "Somente administradores alteram os parâmetros" });
      const p = normalizar(req.body || {});
      await gravarParametros(p, userOf(req));
      res.json({ ok: true, parametros: p });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ---- relatório principal ---------------------------------------------
  // GET /api/industria/programacao?instancias=GYN,BSB&de=YYYY-MM-DD&ate=YYYY-MM-DD&janela=28
  //   instancias → instâncias cujas SAÍDAS contam como demanda (padrão: todas com estoque)
  //   de/ate     → período das séries (padrão: últimos 90 dias até hoje)
  //   janela     → dias corridos da média de saída (padrão: parâmetro salvo)
  app.get("/api/industria/programacao", async (req: any, res) => {
    try {
      const params = await lerParametrosProgramacao();
      const hoje = hojeBRT();
      const ate = isoDate(req.query.ate) || hoje;
      const de = isoDate(req.query.de) || somarDias(ate, -89);
      const janela = Math.max(7, Math.min(365, nz(req.query.janela, params.janelaMediaDias)));
      const inicioJanela = somarDias(hoje, -(janela - 1));
      // Média de saída por DIA ÚTIL (Flavio 04/out): total da janela ÷ dias úteis da janela.
      const diasUteisJanela = Math.max(1, diasUteisNaJanela(inicioJanela, hoje));
      const inicioConsulta = inicioJanela < de ? inicioJanela : de;

      const instR: any = await db.execute(sql`SELECT id, name, display_name FROM omie_instances WHERE COALESCE(is_active, true) ORDER BY name`);
      const instancias = (instR.rows || []).map((r: any) => ({ id: String(r.id), name: String(r.name || "").toUpperCase(), displayName: r.display_name || r.name }));
      const nomePorId: Record<string, string> = {};
      for (const i of instancias) nomePorId[i.id] = i.name;
      // Todas as instâncias contam como demanda e estoque, inclusive a SERV
      // (Flavio 04/out: SERV se comporta igual às demais; abastecida por NF de
      // venda da GYN a CMV).
      const todasComEstoque: string[] = instancias.map((i: any) => String(i.name));
      const selecionadas: string[] = String(req.query.instancias || "")
        .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
        .filter((n) => todasComEstoque.includes(n));
      const instDemanda = new Set<string>(selecionadas.length ? selecionadas : todasComEstoque);

      // 1) SAÍDAS por produto × instância × dia × tipo (consume − estornos).
      //    quantity é positiva no caminho do pipeline e negativa no /emit → ABS.
      const movR: any = await db.execute(sql`
        SELECT m.product_id, m.instance_id,
               (m.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
               LOWER(COALESCE(bp.operation_type, '')) AS operacao,
               (fi.id IS NOT NULL) AS tem_nf,
               UPPER(COALESCE(fi.nature_of_operation, '')) AS nf_natureza,
               SUM(CASE WHEN m.movement_type = 'consume' THEN ABS(m.quantity) ELSE -ABS(m.quantity) END) AS qtd
        FROM inventory_movements m
        LEFT JOIN billing_pipeline bp ON bp.id::text = m.source_id::text
        LEFT JOIN fiscal_invoices fi ON fi.id::text = m.source_id::text
        WHERE m.movement_type IN ('consume', 'cancel_reversal')
          AND m.source_type = 'invoice'
          AND m.created_at >= (${inicioConsulta}::date::timestamp + INTERVAL '3 hours')
          AND LOWER(COALESCE(bp.operation_type, '')) <> 'transferencia'
          -- estorno/cancelamento de NF de TRANSFERÊNCIA (source = fiscal_invoices, sem card) também não é demanda
          AND NOT (fi.id IS NOT NULL AND (UPPER(COALESCE(fi.nature_of_operation, '')) LIKE '%TRANSFER%' OR fi.cfop IN ('5152', '6152', '5409', '6409')))
        GROUP BY 1, 2, 3, 4, 5, 6`);

      // 1b) SAÍDAS POR NF SEM MOVIMENTO DE ESTOQUE (qualquer instância, qualquer
      //     natureza de saída — venda, troca, amostra, bonificação...). Regra do
      //     Flavio 04/out: tudo que sai, por qualquer instância e propósito, conta.
      //     Cobre o histórico da SERV antes do controle de estoque dela e qualquer
      //     NF emitida fora do pipeline. Só entra NF autorizada de produção, saída,
      //     não devolução, não transferência/remessa, deduplicada por nº, e que NÃO
      //     tenha baixa de lote (nem pela NF, nem pelo card do mesmo pedido).
      const nfSemMovR: any = await db.execute(sql.raw(`
        SELECT it.product_id,
               COALESCE(fi.omie_instance_id, oi_emit.id) AS instance_id,
               ${nfData('fi')}::date::text AS dia,
               '' AS operacao, true AS tem_nf, UPPER(COALESCE(fi.nature_of_operation, '')) AS nf_natureza,
               SUM(it.quantity) AS qtd
        FROM (
          SELECT DISTINCT ON (COALESCE(issuer_cnpj,''), COALESCE(series,''), COALESCE(invoice_number::text, 'id:' || id::text)) *
          FROM fiscal_invoices
          WHERE status = 'authorized' AND environment = 'producao'
            AND COALESCE(operation_type, 'saida') <> 'entrada' AND COALESCE(fin_nfe, '1') <> '4'
          ORDER BY COALESCE(issuer_cnpj,''), COALESCE(series,''), COALESCE(invoice_number::text, 'id:' || id::text), created_at DESC
        ) fi
        JOIN fiscal_invoice_items it ON it.invoice_id = fi.id
        -- NF sem instância gravada (muito comum nos cards sem filial): a instância é a do CNPJ emitente
        LEFT JOIN omie_instances oi_emit ON regexp_replace(COALESCE(oi_emit.cnpj, ''), '\\D', '', 'g') = regexp_replace(COALESCE(fi.issuer_cnpj, ''), '\\D', '', 'g')
        WHERE it.product_id IS NOT NULL
          AND COALESCE(fi.cfop, '') NOT LIKE '1%' AND COALESCE(fi.cfop, '') NOT LIKE '2%' AND COALESCE(fi.cfop, '') NOT LIKE '3%'
          AND UPPER(COALESCE(fi.nature_of_operation, '')) NOT LIKE '%TRANSFER%'
          AND UPPER(COALESCE(fi.nature_of_operation, '')) NOT LIKE '%DEVOL%'
          AND UPPER(COALESCE(fi.nature_of_operation, '')) NOT LIKE '%REMESSA%'
          AND UPPER(COALESCE(fi.nature_of_operation, '')) NOT LIKE '%SUCATA%'
          AND COALESCE(fi.cfop, '') NOT IN ('5152', '6152', '5409', '6409')
          AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.source_type = 'invoice' AND m.source_id::text = fi.id::text)
          AND NOT EXISTS (SELECT 1 FROM inventory_movements m JOIN billing_pipeline bp ON bp.id::text = m.source_id::text
                          WHERE m.source_type = 'invoice' AND fi.sales_card_id IS NOT NULL AND bp.sales_card_id = fi.sales_card_id)
          AND ${nfData('fi')}::date >= '${inicioConsulta}'
        GROUP BY 1, 2, 3, 4, 5, 6`));
      const movServR = nfSemMovR; // nome mantido: entra no mesmo laço das movimentações

      // 2) ESTOQUE por produto × instância. Conta EM USO + BLOQUEADO: desde
      //    04/out a NF de transferência entra na filial como 'blocked' e é
      //    promovida a 'in_use' por FIFO na baixa — é estoque físico igual.
      const lotR: any = await db.execute(sql`
        SELECT product_id, instance_id, COUNT(*) AS lotes,
               SUM(quantity) AS qtd,
               SUM(CASE WHEN stock_type = 'blocked' THEN quantity ELSE 0 END) AS bloqueado,
               SUM(COALESCE(total_cost, 0)) AS custo
        FROM inventory_lots
        WHERE stock_type IN ('in_use', 'blocked') AND COALESCE(is_active, true)
        GROUP BY 1, 2`);

      // 3) OPs abertas (já programadas).
      const opR: any = await db.execute(sql`
        SELECT id, order_number, product_id, product_name, quantity, status, production_date, start_date, created_at
        FROM production_orders
        WHERE status IN ('planejada', 'em_producao')
        ORDER BY production_date NULLS LAST, order_number`);

      // 4) Produtos (ativos, não uso interno) + fardo.
      const prodR: any = await db.execute(sql`
        SELECT id, name, omie_code, COALESCE(is_active, true) AS is_active, COALESCE(internal_only, false) AS internal_only,
               fardo_filas, fardo_por_fila
        FROM products`);

      type Agg = { venda: number; troca: number; amostra: number; bonificacao: number; outros: number };
      const zero = (): Agg => ({ venda: 0, troca: 0, amostra: 0, bonificacao: 0, outros: 0 });

      // Séries brutas para o cliente pivotar (dia/semana/mês) — só do período pedido.
      const saidasSerie: { productId: string; instancia: string; dia: string; tipo: Tipo; qtd: number }[] = [];
      // Acúmulos por produto para a janela da média (só instâncias selecionadas).
      const janelaPorProduto: Record<string, Agg & { diasComSaida: Set<string>; porSemana: Record<string, number> }> = {};
      const totalPorInstancia: Record<string, Agg> = {};

      for (const r of [...(movR.rows || []), ...(movServR.rows || [])]) {
        const q = Number(r.qtd) || 0; if (!q) continue;
        const inst = nomePorId[String(r.instance_id)] || "?";
        const tipo = tipoDe(r.operacao, !!r.tem_nf, r.nf_natureza);
        const dia = String(r.dia);
        const pid = String(r.product_id);
        if (dia >= de && dia <= ate) {
          saidasSerie.push({ productId: pid, instancia: inst, dia, tipo, qtd: Math.round(q * 1000) / 1000 });
        }
        if (!instDemanda.has(inst)) continue;
        if (dia >= inicioJanela && dia <= hoje) {
          const a = (janelaPorProduto[pid] = janelaPorProduto[pid] || { ...zero(), diasComSaida: new Set(), porSemana: {} });
          a[tipo] += q; a.diasComSaida.add(dia);
          // semana ISO-ish: segunda-feira como início
          const d = new Date(dia + "T12:00:00Z"); const dow = (d.getUTCDay() + 6) % 7;
          const seg = somarDias(dia, -dow);
          a.porSemana[seg] = (a.porSemana[seg] || 0) + q;
        }
        if (dia >= de && dia <= ate) {
          const t = (totalPorInstancia[inst] = totalPorInstancia[inst] || zero());
          t[tipo] += q;
        }
      }

      const estoquePorProduto: Record<string, Record<string, { qtd: number; bloqueado: number; lotes: number; custo: number }>> = {};
      for (const r of (lotR.rows || [])) {
        const inst = nomePorId[String(r.instance_id)] || "?";
        const pid = String(r.product_id);
        (estoquePorProduto[pid] = estoquePorProduto[pid] || {})[inst] = {
          qtd: Number(r.qtd) || 0, bloqueado: Number(r.bloqueado) || 0, lotes: Number(r.lotes) || 0, custo: Number(r.custo) || 0,
        };
      }

      const opsPorProduto: Record<string, any[]> = {};
      for (const o of (opR.rows || [])) {
        const pid = String(o.product_id || "");
        (opsPorProduto[pid] = opsPorProduto[pid] || []).push({
          id: o.id, orderNumber: o.order_number, status: o.status, quantidade: Number(o.quantity) || 0,
          productionDate: o.production_date ? String(o.production_date).slice(0, 10) : null,
        });
      }

      const leadTotal = params.leadProducaoDias + params.leadTransferenciaDias;
      const diasMinimo = leadTotal + params.segurancaDias;
      const diasAlvo = diasMinimo + params.horizonteDias;

      const produtos: any[] = [];
      for (const p of (prodR.rows || [])) {
        const pid = String(p.id);
        const est = estoquePorProduto[pid] || {};
        const jan = janelaPorProduto[pid];
        const ops = opsPorProduto[pid] || [];
        const temMovimento = saidasSerie.some((s) => s.productId === pid);
        const estTotalTodas = Object.values(est).reduce((s, e) => s + e.qtd, 0);
        if (p.internal_only) continue;
        if (!p.is_active && !estTotalTodas && !temMovimento && !ops.length) continue;
        if (!jan && !estTotalTodas && !temMovimento && !ops.length) continue;

        const { sabor, tam } = parseNome(p.name);
        const fardoUn = Math.max(0, (Number(p.fardo_filas) || 0) * (Number(p.fardo_por_fila) || 0));

        const porInstancia: Record<string, number> = {};
        const bloqueadoPorInstancia: Record<string, number> = {};
        for (const i of todasComEstoque) {
          porInstancia[i] = Math.round((est[i]?.qtd || 0) * 1000) / 1000;
          bloqueadoPorInstancia[i] = Math.round((est[i]?.bloqueado || 0) * 1000) / 1000;
        }
        const fabrica = porInstancia["IND"] || 0;
        const escritorio = porInstancia["GYN"] || 0;
        // Cobertura: fábrica + instâncias selecionadas (a fábrica abastece todas).
        let estoqueCobertura = fabrica;
        instDemanda.forEach((i) => { if (i !== "IND") estoqueCobertura += porInstancia[i] || 0; });
        const estoqueTotal = Object.values(porInstancia).reduce((s, v) => s + v, 0);

        const totalJanela = jan ? jan.venda + jan.troca + jan.amostra + jan.bonificacao + jan.outros : 0;
        const mediaDia = totalJanela / diasUteisJanela; // por dia útil
        const semanas = jan ? Object.values(jan.porSemana) : [];
        const picoSemana = semanas.length ? Math.max(...semanas) : 0;

        const programado = ops.reduce((s, o) => s + o.quantidade, 0);
        const coberturaDias = mediaDia > 0 ? estoqueCobertura / mediaDia : null;
        const coberturaComProgramado = mediaDia > 0 ? (estoqueCobertura + programado) / mediaDia : null;
        const estoqueMinimo = Math.ceil(mediaDia * diasMinimo);
        const estoqueAlvo = Math.ceil(mediaDia * diasAlvo);
        let sugestao = Math.max(0, estoqueAlvo - estoqueCobertura - programado);
        if (sugestao > 0 && params.loteMinimoUnidades > 0) sugestao = Math.max(sugestao, params.loteMinimoUnidades);
        if (sugestao > 0 && params.arredondarFardo && fardoUn > 0) sugestao = Math.ceil(sugestao / fardoUn) * fardoUn;
        sugestao = Math.round(sugestao);
        // Cobertura, lead e segurança são em DIAS ÚTEIS → datas pulam fim de semana e feriado.
        const dataRuptura = coberturaDias == null ? null : somarDiasUteis(hoje, Math.floor(coberturaDias));
        // Para o lote chegar antes da ruptura descontando a segurança:
        const dataLimiteProducao = dataRuptura ? somarDiasUteis(dataRuptura, -diasMinimo) : null;
        let status: "ruptura" | "critico" | "atencao" | "ok" | "sem_giro";
        if (mediaDia <= 0) status = "sem_giro";
        else if (estoqueCobertura <= 0) status = "ruptura";
        else if ((coberturaComProgramado ?? 0) < leadTotal) status = "critico";
        else if ((coberturaComProgramado ?? 0) < diasMinimo) status = "atencao";
        else status = "ok";

        produtos.push({
          productId: pid, nome: p.name, codigo: p.omie_code || null, sabor, tam, ativo: !!p.is_active, fardoUnidades: fardoUn,
          estoque: {
            fabrica, escritorio, porInstancia, bloqueadoPorInstancia, total: Math.round(estoqueTotal * 1000) / 1000,
            cobertura: Math.round(estoqueCobertura * 1000) / 1000,
            lotesFabrica: est["IND"]?.lotes || 0, custoFabrica: Math.round((est["IND"]?.custo || 0) * 100) / 100,
          },
          saidas: {
            janelaDias: janela, diasUteisJanela,
            total: Math.round(totalJanela), venda: Math.round(jan?.venda || 0), troca: Math.round(jan?.troca || 0),
            amostra: Math.round(jan?.amostra || 0), bonificacao: Math.round(jan?.bonificacao || 0), outros: Math.round(jan?.outros || 0),
            mediaDia: Math.round(mediaDia * 100) / 100, mediaSemana: Math.round(mediaDia * 5 * 10) / 10, mediaMes: Math.round(mediaDia * 22),
            picoSemana: Math.round(picoSemana), diasComSaida: jan ? jan.diasComSaida.size : 0,
          },
          programado: { aberto: Math.round(programado), ops },
          calculo: {
            leadTotal, diasMinimo, diasAlvo,
            coberturaDias: coberturaDias == null ? null : Math.round(coberturaDias * 10) / 10,
            coberturaComProgramado: coberturaComProgramado == null ? null : Math.round(coberturaComProgramado * 10) / 10,
            estoqueMinimo, estoqueAlvo, sugestaoProduzir: sugestao,
            sugestaoFardos: fardoUn > 0 ? Math.ceil(sugestao / fardoUn) : null,
            dataRuptura, dataLimiteProducao, status,
          },
        });
      }
      const ordem = { ruptura: 0, critico: 1, atencao: 2, ok: 3, sem_giro: 4 } as const;
      produtos.sort((a, b) => (ordem[a.calculo.status as keyof typeof ordem] - ordem[b.calculo.status as keyof typeof ordem])
        || (a.calculo.coberturaDias ?? 9e9) - (b.calculo.coberturaDias ?? 9e9) || String(a.nome).localeCompare(String(b.nome)));

      const totais = {
        estoqueFabrica: Math.round(produtos.reduce((s, p) => s + p.estoque.fabrica, 0)),
        estoqueEscritorio: Math.round(produtos.reduce((s, p) => s + p.estoque.escritorio, 0)),
        estoquePorInstancia: Object.fromEntries(todasComEstoque.map((i: string) => [i, Math.round(produtos.reduce((s, p) => s + (p.estoque.porInstancia[i] || 0), 0))])),
        saidasJanela: Math.round(produtos.reduce((s, p) => s + p.saidas.total, 0)),
        mediaDia: Math.round(produtos.reduce((s, p) => s + p.saidas.mediaDia, 0) * 10) / 10,
        sugestaoProduzir: Math.round(produtos.reduce((s, p) => s + p.calculo.sugestaoProduzir, 0)),
        programado: Math.round(produtos.reduce((s, p) => s + p.programado.aberto, 0)),
        porStatus: produtos.reduce((acc: Record<string, number>, p) => { acc[p.calculo.status] = (acc[p.calculo.status] || 0) + 1; return acc; }, {}),
        saidasPorInstancia: Object.fromEntries(Object.entries(totalPorInstancia).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([t, q]) => [t, Math.round(q)]))])),
      };

      res.json({
        geradoEm: new Date().toISOString(), hoje,
        periodo: { de, ate }, janelaMediaDias: janela, diasUteisJanela, inicioJanela,
        instancias: instancias.filter((i: any) => todasComEstoque.includes(i.name)),
        instanciasDemanda: Array.from(instDemanda),
        parametros: params,
        produtos, totais, saidas: saidasSerie,
      });
    } catch (e: any) {
      console.error("[programacao-producao]", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ---- programar produção (cria OPs 'planejada' em lote) ----------------
  // body: { itens: [{ product_id, quantity, production_date?, notes? }] }
  app.post("/api/industria/programacao/programar", async (req: any, res) => {
    try {
      const itens: any[] = Array.isArray(req.body?.itens) ? req.body.itens : [];
      if (!itens.length) return res.status(400).json({ error: "Nenhum item para programar" });
      const by = userOf(req);
      const indR: any = await db.execute(sql`SELECT id FROM omie_instances WHERE UPPER(name) = 'IND' LIMIT 1`);
      const indId = (indR.rows || [])[0]?.id ? String((indR.rows || [])[0].id) : null;

      const criadas: any[] = [];
      const erros: any[] = [];
      for (const it of itens) {
        const pid = str(it?.product_id, 60);
        const qty = Math.round(nz(it?.quantity, 0));
        if (!pid || qty <= 0) { erros.push({ item: it, erro: "produto ou quantidade inválidos" }); continue; }
        const pr: any = await db.execute(sql`SELECT id, name FROM products WHERE id = ${pid} LIMIT 1`);
        const prod = (pr.rows || [])[0];
        if (!prod) { erros.push({ item: it, erro: "produto não encontrado" }); continue; }
        // Numeração sequencial OP-00000 (mesma regra do módulo).
        const last: any = await db.execute(sql`SELECT order_number FROM production_orders WHERE order_number LIKE 'OP-%' ORDER BY order_number DESC LIMIT 1`);
        const n = (parseInt(String((last.rows || [])[0]?.order_number || "OP-00000").replace(/\D/g, ""), 10) || 0) + 1;
        const orderNumber = "OP-" + String(n).padStart(5, "0");
        const dataProd = isoDate(it?.production_date) || hojeBRT();
        const notes = str(it?.notes, 1000) || `Programação de produção (${hojeBRT()})`;
        const ins: any = await db.execute(sql`
          INSERT INTO production_orders (id, order_number, product_id, product_name, quantity, instance_id, instance_name, status, start_date, end_date, notes, created_by, created_at, updated_at, production_date)
          VALUES (gen_random_uuid()::varchar, ${orderNumber}, ${pid}, ${prod.name}, ${qty}, ${indId}, 'IND', 'planejada', NULL, NULL, ${notes}, ${by}, now(), now(), ${dataProd})
          RETURNING id, order_number, product_name, quantity, production_date`);
        criadas.push((ins.rows || [])[0]);
      }
      console.log("🏭 [PROGRAMACAO] OPs planejadas:", criadas.map((c) => c.order_number).join(", "), "por", by);
      res.json({ ok: true, criadas, erros });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
}
