// ============================================================================
// RESUMO RECEBÍVEIS COLABORADOR — 18/out/2026 · revisado 25/out/2026
// ---------------------------------------------------------------------------
// Módulo de Vendas (/resumo-recebiveis). Uma planilha por mês com tudo que
// cada colaborador tem a receber: vendedores internos, externos, administrativo
// e motoristas.
//
// Colunas fixas: Fixo Mensal · Ajuda de Custo · Meta · Faturamento · Comissão Mês · Km · Total
// Colunas dinâmicas: uma por CAMPANHA VIGENTE no mês + Bônus (avulso).
// Uma linha de valores por colaborador.
//
// GESTOR (25/out/2026)
//   Cada colaborador tem flags na configuração dizendo QUAIS rubricas entram
//   para ele. O que é flagado é BUSCADO no módulo que já calcula aquilo:
//     Meta ......... sales_goals
//     Faturamento .. faturamento-oficial (mesma fonte do Dashboard)
//     Comissão ..... regra do próprio colaborador aplicada ao faturamento
//     Km ........... daily_routes x tarifa de config_global
//     Campanhas .... campanha-outubro.computeCampaign
//   Fixo Mensal e Ajuda de Custo continuam sendo valores de cadastro: nenhum
//   módulo do sistema calcula folha. Bônus é o único campo que, quando
//   flagado, abre para o admin informar o valor por usuário e por mês.
//
// CAMPANHAS COMO COLUNA
//   resumo_campanhas é o cadastro do que vira coluna. Origem 'campanha' puxa
//   o bônus apurado pelo módulo da campanha; origem 'manual' abre célula para
//   o admin lançar por colaborador. A coluna só aparece nos meses dentro da
//   vigência (ym_inicio..ym_fim).
//
// ACESSO
//   Cada colaborador vê SOMENTE a própria linha; admin vê todos. O
//   authenticateUser eleva 'industria' e 'contador' a admin para leitura — aqui
//   isso NÃO vale, senão folha de pagamento vazaria para esses perfis.
//
// Tabelas criadas por CREATE TABLE / ALTER TABLE IF NOT EXISTS no primeiro uso:
// o build de produção não roda db:push.
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { sqlFaturamentoPorVendedor } from "./faturamento-oficial";
import { computeCampaign } from "./campanha-outubro";

const PAPEIS = ["vendedor", "telemarketing", "administrative", "motorista"];

// Faixas por atingimento — mesma tabela de /api/sales-goals/commission-dashboard.
const FAIXAS: Record<string, { thresholds: number[]; rates: number[] }> = {
  vendedor_clt: { thresholds: [0, 85, 100, 110, 120], rates: [0.8, 1.5, 2.5, 3.5, 4.5] },
  vendedor_pj: { thresholds: [0, 85, 100, 110, 120], rates: [3.5, 4.5, 6.0, 6.5, 7.5] },
  telemarketing: { thresholds: [0, 90, 100, 110, 120], rates: [1.5, 2.0, 3.0, 3.5, 4.0] },
};
const FAIXA_PADRAO = "telemarketing";

// O driver não aceita array JS como bind de ANY(); literal ARRAY[...]::varchar[]
// é o idioma usado no resto do servidor (ver arraySql em contabilidade-insumos.ts).
const arraySql = (xs: string[]) =>
  sql.raw(`ARRAY[${xs.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(",")}]::varchar[]`);

const n = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const ymValido = (s: any) => /^\d{4}-\d{2}$/.test(String(s || ""));

function limitesDoMes(ym: string) {
  const [a, m] = ym.split("-").map(Number);
  const prox = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
  return { ini: `${ym}-01`, fim: prox, ano: a, mes: m };
}

type Cfg = {
  incluirNoResumo: boolean;
  fixoMensal: number;
  ajudaCusto: number;
  comissaoTipo: "nenhum" | "fixo" | "faixa";
  comissaoPct: number;
  comissaoDescontoFixo: number;
  comissaoProporcionalMeta: boolean;
  faixaTipo: string;
  usaFixo: boolean;
  usaAjudaCusto: boolean;
  usaMeta: boolean;
  usaFaturamento: boolean;
  usaComissao: boolean;
  usaKm: boolean;
  usaCampanhas: boolean;
  usaBonus: boolean;
  observacao: string;
  vigenciaYm: string | null;
};

const CFG_PADRAO: Cfg = {
  incluirNoResumo: true,
  fixoMensal: 0,
  ajudaCusto: 0,
  comissaoTipo: "nenhum",
  comissaoPct: 0,
  comissaoDescontoFixo: 0,
  comissaoProporcionalMeta: false,
  faixaTipo: FAIXA_PADRAO,
  usaFixo: true,
  usaAjudaCusto: false,
  usaMeta: true,
  usaFaturamento: true,
  usaComissao: true,
  usaKm: true,
  usaCampanhas: true,
  usaBonus: false,
  observacao: "",
  vigenciaYm: null,
};

function aliquotaDaFaixa(tipo: string, atingimentoPct: number): number {
  const f = FAIXAS[tipo] || FAIXAS[FAIXA_PADRAO];
  let rate = f.rates[0];
  for (let i = 0; i < f.thresholds.length; i++) {
    if (atingimentoPct >= f.thresholds[i]) rate = f.rates[i];
  }
  return rate;
}

// Comissão do mês sobre o faturamento realizado. Mesma semântica da coluna
// "Comissão Conquistada" de comissaoMetas.ts, inclusive o piso zero.
function calcularComissao(cfg: Cfg, faturamento: number, meta: number): number {
  if (cfg.comissaoTipo === "nenhum") return 0;
  const atingimento = meta > 0 ? (faturamento / meta) * 100 : 0;
  if (cfg.comissaoTipo === "faixa") {
    return (faturamento * aliquotaDaFaixa(cfg.faixaTipo, atingimento)) / 100;
  }
  if (cfg.comissaoProporcionalMeta) {
    if (meta <= 0) return 0;
    const alvo = Math.max(0, (meta * cfg.comissaoPct) / 100 - cfg.comissaoDescontoFixo);
    return alvo * (faturamento / meta);
  }
  return Math.max(0, (faturamento * cfg.comissaoPct) / 100 - cfg.comissaoDescontoFixo);
}

let schemaReady: Promise<void> | null = null;
export function ensureResumoRecebiveisSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS collab_remuneracao_config (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
        "vigencia_ym varchar(7) NOT NULL, " +
        "fixo_mensal numeric NOT NULL DEFAULT 0, " +
        "comissao_tipo varchar NOT NULL DEFAULT 'nenhum', " +
        "comissao_pct numeric NOT NULL DEFAULT 0, " +
        "comissao_desconto_fixo numeric NOT NULL DEFAULT 0, " +
        "comissao_proporcional_meta boolean NOT NULL DEFAULT false, " +
        "faixa_tipo varchar NOT NULL DEFAULT 'telemarketing', " +
        "paga_km boolean NOT NULL DEFAULT true, " +
        "observacao text, " +
        "created_by varchar, created_at timestamptz DEFAULT now())"
      ));
      // Flags do gestor (25/out/2026). ADD COLUMN IF NOT EXISTS para não quebrar
      // as linhas que já existem em produção.
      for (const col of [
        "incluir_no_resumo boolean NOT NULL DEFAULT true",
        "ajuda_custo numeric NOT NULL DEFAULT 0",
        "usa_fixo boolean NOT NULL DEFAULT true",
        "usa_ajuda_custo boolean NOT NULL DEFAULT false",
        "usa_meta boolean NOT NULL DEFAULT true",
        "usa_faturamento boolean NOT NULL DEFAULT true",
        "usa_comissao boolean NOT NULL DEFAULT true",
        "usa_km boolean NOT NULL DEFAULT true",
        "usa_campanhas boolean NOT NULL DEFAULT true",
        "usa_bonus boolean NOT NULL DEFAULT false",
      ]) {
        await db.execute(sql.raw(
          `ALTER TABLE collab_remuneracao_config ADD COLUMN IF NOT EXISTS ${col}`
        )).catch(() => {});
      }
      // paga_km virou usa_km; preserva a escolha antiga na primeira subida.
      await db.execute(sql.raw(
        "UPDATE collab_remuneracao_config SET usa_km = paga_km WHERE paga_km = false AND usa_km = true"
      )).catch(() => {});

      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS collab_bonus_lancamentos (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
        "ym varchar(7) NOT NULL, " +
        "descricao text NOT NULL, " +
        "valor numeric NOT NULL DEFAULT 0, " +
        "created_by varchar, created_at timestamptz DEFAULT now())"
      ));

      // Cadastro do que vira COLUNA de campanha.
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS resumo_campanhas (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "nome varchar NOT NULL, " +
        "origem varchar NOT NULL DEFAULT 'manual', " +
        "ym_inicio varchar(7) NOT NULL, " +
        "ym_fim varchar(7), " +
        "ativa boolean NOT NULL DEFAULT true, " +
        "ordem integer NOT NULL DEFAULT 0, " +
        "observacao text, " +
        "created_by varchar, created_at timestamptz DEFAULT now())"
      ));

      // Valor por colaborador/mês nas campanhas de origem 'manual'.
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS resumo_campanha_valores (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "campanha_id varchar NOT NULL REFERENCES resumo_campanhas(id) ON DELETE CASCADE, " +
        "user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
        "ym varchar(7) NOT NULL, " +
        "valor numeric NOT NULL DEFAULT 0, " +
        "observacao text, " +
        "created_by varchar, created_at timestamptz DEFAULT now())"
      ));

      // Quem participa do resumo. Fora da tabela de vigência de propósito: isto
      // não é remuneração que muda com o tempo, é "esta conta é uma pessoa que
      // recebe". Contas de sistema (HOTSITE, INSTAGRAM, Honest Admin...) e
      // cadastros de teste ficam de fora de uma vez.
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS resumo_participantes (" +
        "user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, " +
        "incluir boolean NOT NULL DEFAULT true, " +
        "updated_by varchar, updated_at timestamptz DEFAULT now())"
      ));

      for (const ix of [
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_collab_cfg_user_ym ON collab_remuneracao_config (user_id, vigencia_ym)",
        "CREATE INDEX IF NOT EXISTS idx_collab_bonus_ym ON collab_bonus_lancamentos (ym, user_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_camp_valor ON resumo_campanha_valores (campanha_id, user_id, ym)",
        "CREATE INDEX IF NOT EXISTS idx_camp_valor_ym ON resumo_campanha_valores (ym)",
      ]) await db.execute(sql.raw(ix)).catch(() => {});

      await semearRegrasAtuais();
      await semearCampanhaOutubro();
      await semearNaoParticipantes();
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// Primeira carga das regras de comissão que estavam fixadas por primeiro nome
// em client/src/lib/comissaoMetas.ts. O FIXO MENSAL fica em 0 de propósito —
// nenhum salário está registrado no sistema e não cabe adivinhar folha.
async function semearRegrasAtuais(): Promise<void> {
  const ja: any = await db.execute(sql`SELECT COUNT(1)::int AS n FROM collab_remuneracao_config`);
  if (Number(ja.rows?.[0]?.n || 0) > 0) return;

  const regras: Array<{ nomes: string[]; cfg: Partial<Cfg> }> = [
    { nomes: ["gilmar"], cfg: { comissaoTipo: "fixo", comissaoPct: 7 } },
    { nomes: ["carlos", "jhonatan", "jonatan", "jhonathan"], cfg: { comissaoTipo: "fixo", comissaoPct: 8 } },
    { nomes: ["radilton", "cleber"], cfg: { comissaoTipo: "fixo", comissaoPct: 4.5 } },
    { nomes: ["robson", "natalia", "maria"], cfg: { comissaoTipo: "faixa" } },
    { nomes: ["leticia"], cfg: { comissaoTipo: "fixo", comissaoPct: 4, comissaoDescontoFixo: 1400, comissaoProporcionalMeta: true } },
  ];

  const u: any = await db.execute(sql`
    SELECT id, LOWER(SPLIT_PART(TRIM(COALESCE(first_name, '')), ' ', 1)) AS primeiro
    FROM users WHERE is_active = true AND role::text = ANY(${arraySql(PAPEIS)})`);

  for (const row of u.rows || []) {
    const primeiro = String(row.primeiro || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
    const achou = regras.find((r) => r.nomes.includes(primeiro));
    if (!achou) continue;
    const c = { ...CFG_PADRAO, ...achou.cfg };
    await db.execute(sql`
      INSERT INTO collab_remuneracao_config
        (user_id, vigencia_ym, fixo_mensal, comissao_tipo, comissao_pct,
         comissao_desconto_fixo, comissao_proporcional_meta, faixa_tipo, paga_km, observacao, created_by)
      VALUES (${row.id}, '2026-01', 0, ${c.comissaoTipo}, ${c.comissaoPct},
              ${c.comissaoDescontoFixo}, ${c.comissaoProporcionalMeta}, ${c.faixaTipo}, true,
              'Importado da regra que estava fixada no código em 18/10/2026. Fixo mensal a preencher.', 'sistema')
      ON CONFLICT (user_id, vigencia_ym) DO NOTHING`).catch(() => {});
  }
  console.log("[RESUMO-RECEB] regras de comissão semeadas a partir do código");
}

// A Campanha de Outubro já existe como módulo; vira a primeira coluna de
// campanha, puxando o bônus que ela mesma apura.
async function semearCampanhaOutubro(): Promise<void> {
  const ja: any = await db.execute(sql`SELECT COUNT(1)::int AS n FROM resumo_campanhas`);
  if (Number(ja.rows?.[0]?.n || 0) > 0) return;
  await db.execute(sql`
    INSERT INTO resumo_campanhas (nome, origem, ym_inicio, ym_fim, ativa, ordem, observacao, created_by)
    VALUES ('Campanha de Outubro', 'campanha', '2026-10', '2026-10', true, 1,
            'Puxa o bônus apurado pelo módulo Campanha (clientes novos, positivação e meta).', 'sistema')`
  ).catch(() => {});
}

// Contas que não são pessoas (sistema, canais) e cadastros de teste, apontadas
// pelo Flavio em 25/10/2026. Roda uma única vez; depois é tudo pela tela, na aba
// Participantes — inclusive para trazer alguém de volta.
const FORA_DO_RESUMO = [
  "fabio h.",
  "honest admin",
  "honest colaboradores",
  "honest fornecedores",
  "hotsite",
  "instagram",
  "baruc entregador",
  "motorista teste",
];

// Pessoas que participam do resumo mesmo não tendo papel de vendas — a marcação
// explícita vale mais que o papel. Apontadas pelo Flavio em 25/10/2026.
const DENTRO_DO_RESUMO = ["lanucy machado", "cinthia marques"];

async function semearNaoParticipantes(): Promise<void> {
  const ja: any = await db.execute(sql`SELECT COUNT(1)::int AS n FROM resumo_participantes`);
  if (Number(ja.rows?.[0]?.n || 0) > 0) return;
  const nome = sql.raw(
    "LOWER(TRIM(COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)))"
  );
  const fora: any = await db.execute(sql`
    INSERT INTO resumo_participantes (user_id, incluir, updated_by)
    SELECT u.id, false, 'sistema' FROM users u
    WHERE ${nome} = ANY(${arraySql(FORA_DO_RESUMO)})
    ON CONFLICT (user_id) DO NOTHING`);
  const dentro: any = await db.execute(sql`
    INSERT INTO resumo_participantes (user_id, incluir, updated_by)
    SELECT u.id, true, 'sistema' FROM users u
    WHERE ${nome} = ANY(${arraySql(DENTRO_DO_RESUMO)})
    ON CONFLICT (user_id) DO NOTHING`);
  console.log(`[RESUMO-RECEB] ${fora.rowCount ?? 0} contas fora e ${dentro.rowCount ?? 0} dentro do resumo`);
}

// Admin de verdade: 'industria' e 'contador' são elevados a admin pelo
// authenticateUser para LEITURA do sistema; folha de pagamento não entra nisso.
function ehAdmin(req: any): boolean {
  return req.currentUser?.role === "admin" && !req.perfilIndustria && !req.perfilContador;
}

// Campanhas que valem no mês informado.
async function campanhasDoMes(ym: string): Promise<any[]> {
  const r: any = await db.execute(sql`
    SELECT id, nome, origem, ym_inicio, ym_fim, ordem, observacao
    FROM resumo_campanhas
    WHERE ativa = true AND ym_inicio <= ${ym} AND (ym_fim IS NULL OR ym_fim >= ${ym})
    ORDER BY ordem, nome`);
  return r.rows || [];
}

export function registerResumoRecebiveisRoutes(app: Express) {
  // -------------------------------------------------------------------------
  // A planilha do mês.
  // -------------------------------------------------------------------------
  app.get("/api/resumo-recebiveis", authenticateUser, async (req: any, res) => {
    try {
      await ensureResumoRecebiveisSchema();
      const ym = ymValido(req.query?.ym) ? String(req.query.ym) : new Date().toISOString().slice(0, 7);
      const { ini, fim, ano, mes } = limitesDoMes(ym);
      const admin = ehAdmin(req);
      const eu = req.currentUser;

      // 1. Quem entra na planilha — só usuários ATIVOS, e só os marcados para
      //    aparecer no resumo (a flag exclui contas de sistema).
      const colabs: any = admin
        ? await db.execute(sql`
            SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.seller_type
            FROM users u
            LEFT JOIN resumo_participantes p ON p.user_id = u.id
            WHERE u.is_active = true
              AND (
                (u.role::text = ANY(${arraySql(PAPEIS)}) AND COALESCE(p.incluir, true) = true)
                OR p.incluir = true
              )
            ORDER BY u.role, u.first_name, u.last_name`)
        : await db.execute(sql`
            SELECT id, first_name, last_name, email, role, seller_type
            FROM users WHERE id = ${eu.id} AND is_active = true`);

      const linhas = (colabs.rows || []) as any[];
      const campanhas = await campanhasDoMes(ym);
      if (!linhas.length) {
        return res.json({ ym, admin, campanhas, colaboradores: [], totais: null });
      }
      const ids = linhas.map((r) => String(r.id));

      // 2. Faturamento — mesma fonte do Dashboard
      const fatMap: Record<string, number> = {};
      try {
        const f: any = await db.execute(sql.raw(sqlFaturamentoPorVendedor(ini, fim)));
        for (const r of f.rows || []) fatMap[String(r.vendedor_id)] = n(r.faturamento);
      } catch (e: any) {
        console.error("[RESUMO-RECEB] faturamento:", e?.message || e);
      }

      // 3. Metas do mês
      const metaMap: Record<string, number> = {};
      const mt: any = await db.execute(sql`
        SELECT seller_id, revenue_goal FROM sales_goals
        WHERE month = ${mes} AND year = ${ano} AND is_active = true
          AND seller_id = ANY(${arraySql(ids)})`);
      for (const r of mt.rows || []) metaMap[String(r.seller_id)] = n(r.revenue_goal);

      // 4. Km do mês + tarifas
      const kmMap: Record<string, number> = {};
      const km: any = await db.execute(sql`
        SELECT seller_id, SUM(COALESCE(total_actual_distance::numeric, 0)) AS km
        FROM daily_routes
        WHERE seller_id = ANY(${arraySql(ids)})
          AND route_date >= ${ini}::date AND route_date < ${fim}::date
        GROUP BY seller_id`);
      for (const r of km.rows || []) kmMap[String(r.seller_id)] = n(r.km);

      const cfgGlobal = async (chave: string) => {
        try {
          const r: any = await db.execute(sql`SELECT valor FROM config_global WHERE chave = ${chave} LIMIT 1`);
          const v = r?.rows?.[0]?.valor;
          return v ? JSON.parse(String(v)) : null;
        } catch { return null; }
      };
      const kmCfg = (await cfgGlobal("km_payment_config")) || {};
      const kmRates = (await cfgGlobal("km_seller_rates")) || {};
      const kmRegioes = (await cfgGlobal("km_seller_regions")) || {};
      const rateGO = n(kmCfg.ratePerKmGO ?? kmCfg.ratePerKm);
      const rateDF = n(kmCfg.ratePerKmDF ?? kmCfg.ratePerKm);
      const ratePSN = n(kmCfg.ratePerKmPSN);
      const tarifaDe = (id: string) => {
        if (Object.prototype.hasOwnProperty.call(kmRates, id)) {
          const v = Number(kmRates[id]);
          if (Number.isFinite(v) && v >= 0) return v;
        }
        const rg = String(kmRegioes[id] || "GO").toUpperCase();
        return rg === "DF" ? rateDF : rg === "PSN" ? ratePSN : rateGO;
      };

      // 5. Campanhas: as de origem 'campanha' puxam do módulo; as 'manual'
      //    leem os valores lançados pelo admin.
      const precisaModulo = campanhas.some((c) => c.origem === "campanha");
      const campModulo: Record<string, number> = {};
      if (precisaModulo) {
        try {
          const camp = await computeCampaign(undefined, ym);
          for (const c of camp.sellers || []) {
            campModulo[String(c.seller || "").trim().toLowerCase()] = n(c.bonusTotal);
          }
        } catch (e: any) {
          console.error("[RESUMO-RECEB] campanha:", e?.message || e);
        }
      }
      const valorManual: Record<string, number> = {}; // `${campanhaId}|${userId}`
      if (campanhas.length) {
        const cv: any = await db.execute(sql`
          SELECT campanha_id, user_id, valor FROM resumo_campanha_valores
          WHERE ym = ${ym} AND user_id = ANY(${arraySql(ids)})`);
        for (const r of cv.rows || []) {
          valorManual[`${r.campanha_id}|${r.user_id}`] = n(r.valor);
        }
      }

      // 6. Bônus avulso
      const lancMap: Record<string, Array<{ id: string; descricao: string; valor: number }>> = {};
      const lc: any = await db.execute(sql`
        SELECT id, user_id, descricao, valor FROM collab_bonus_lancamentos
        WHERE ym = ${ym} AND user_id = ANY(${arraySql(ids)}) ORDER BY created_at`);
      for (const r of lc.rows || []) {
        const k = String(r.user_id);
        (lancMap[k] = lancMap[k] || []).push({ id: r.id, descricao: r.descricao, valor: n(r.valor) });
      }

      // 7. Configuração vigente: a linha mais recente com vigência <= ym
      const cfgMap: Record<string, Cfg> = {};
      const cf: any = await db.execute(sql`
        SELECT DISTINCT ON (user_id) user_id, vigencia_ym, fixo_mensal, ajuda_custo, comissao_tipo,
               comissao_pct, comissao_desconto_fixo, comissao_proporcional_meta,
               faixa_tipo, incluir_no_resumo, usa_fixo, usa_ajuda_custo, usa_meta, usa_faturamento,
               usa_comissao, usa_km, usa_campanhas, usa_bonus, observacao
        FROM collab_remuneracao_config
        WHERE user_id = ANY(${arraySql(ids)}) AND vigencia_ym <= ${ym}
        ORDER BY user_id, vigencia_ym DESC`);
      for (const r of cf.rows || []) {
        cfgMap[String(r.user_id)] = {
          incluirNoResumo: r.incluir_no_resumo !== false,
          fixoMensal: n(r.fixo_mensal),
          ajudaCusto: n(r.ajuda_custo),
          comissaoTipo: (r.comissao_tipo || "nenhum") as Cfg["comissaoTipo"],
          comissaoPct: n(r.comissao_pct),
          comissaoDescontoFixo: n(r.comissao_desconto_fixo),
          comissaoProporcionalMeta: r.comissao_proporcional_meta === true,
          faixaTipo: r.faixa_tipo || FAIXA_PADRAO,
          usaFixo: r.usa_fixo !== false,
          usaAjudaCusto: r.usa_ajuda_custo === true,
          usaMeta: r.usa_meta !== false,
          usaFaturamento: r.usa_faturamento !== false,
          usaComissao: r.usa_comissao !== false,
          usaKm: r.usa_km !== false,
          usaCampanhas: r.usa_campanhas !== false,
          usaBonus: r.usa_bonus === true,
          observacao: r.observacao || "",
          vigenciaYm: r.vigencia_ym || null,
        };
      }

      // 8. Monta cada colaborador. Rubrica não flagada vem null -> a tela mostra
      //    "—" e ela não entra no total. Nunca um zero que pareça apurado.
      const colaboradores = linhas.map((u) => {
        const id = String(u.id);
        const nome = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || id;
        const cfg = cfgMap[id] || { ...CFG_PADRAO };

        const meta = cfg.usaMeta ? (metaMap[id] || 0) : null;
        const faturamento = cfg.usaFaturamento ? (fatMap[id] || 0) : null;
        const fixo = cfg.usaFixo ? cfg.fixoMensal : null;
        const ajudaCusto = cfg.usaAjudaCusto ? cfg.ajudaCusto : null;
        const comissao = cfg.usaComissao
          ? calcularComissao(cfg, fatMap[id] || 0, metaMap[id] || 0)
          : null;

        const kmRodado = kmMap[id] || 0;
        const tarifa = tarifaDe(id);
        const kmValor = cfg.usaKm ? kmRodado * tarifa : null;

        const porCampanha: Record<string, number | null> = {};
        for (const c of campanhas) {
          if (!cfg.usaCampanhas) { porCampanha[c.id] = null; continue; }
          porCampanha[c.id] = c.origem === "campanha"
            ? (campModulo[nome.toLowerCase()] || 0)
            : (valorManual[`${c.id}|${id}`] ?? 0);
        }

        const lancamentos = cfg.usaBonus ? (lancMap[id] || []) : [];
        const bonus = cfg.usaBonus ? lancamentos.reduce((s, l) => s + l.valor, 0) : null;

        const total =
          (fixo || 0) + (ajudaCusto || 0) + (comissao || 0) + (kmValor || 0) + (bonus || 0) +
          campanhas.reduce((s, c) => s + (porCampanha[c.id] || 0), 0);

        return {
          id, nome, role: u.role, sellerType: u.seller_type || null,
          config: cfg,
          fixoMensal: fixo, ajudaCusto, meta, faturamento,
          atingimentoPct: metaMap[id] > 0 ? ((fatMap[id] || 0) / metaMap[id]) * 100 : 0,
          comissao,
          campanhas: porCampanha,
          bonus, lancamentos,
          kmRodado, kmTarifa: tarifa, kmRegiao: String(kmRegioes[id] || "GO").toUpperCase(),
          kmTarifaPropria: Object.prototype.hasOwnProperty.call(kmRates, id),
          kmValor,
          totalMes: total,
        };
      });

      const soma = (f: (c: any) => number) => colaboradores.reduce((s, c) => s + f(c), 0);
      const totais = {
        fixoMensal: soma((c) => c.fixoMensal || 0),
        ajudaCusto: soma((c) => c.ajudaCusto || 0),
        meta: soma((c) => c.meta || 0),
        faturamento: soma((c) => c.faturamento || 0),
        comissao: soma((c) => c.comissao || 0),
        bonus: soma((c) => c.bonus || 0),
        kmRodado: soma((c) => c.kmRodado || 0),
        kmValor: soma((c) => c.kmValor || 0),
        totalMes: soma((c) => c.totalMes || 0),
        campanhas: Object.fromEntries(
          campanhas.map((c) => [c.id, soma((x) => x.campanhas?.[c.id] || 0)])
        ),
      };

      res.json({ ym, admin, campanhas, colaboradores, totais });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] planilha:", e?.message || e);
      res.status(500).json({ message: "Falha ao montar o resumo de recebíveis" });
    }
  });

  // -------------------------------------------------------------------------
  // Gestor: configuração de remuneração + flags (somente admin).
  // -------------------------------------------------------------------------
  app.get("/api/resumo-recebiveis/config", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const r: any = await db.execute(sql`
        SELECT c.id, c.user_id, c.vigencia_ym, c.fixo_mensal, c.ajuda_custo, c.comissao_tipo, c.comissao_pct,
               c.comissao_desconto_fixo, c.comissao_proporcional_meta, c.faixa_tipo,
               c.incluir_no_resumo, c.usa_fixo, c.usa_ajuda_custo, c.usa_meta, c.usa_faturamento, c.usa_comissao,
               c.usa_km, c.usa_campanhas, c.usa_bonus, c.observacao, c.created_at,
               COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS nome,
               u.role
        FROM collab_remuneracao_config c
        JOIN users u ON u.id = c.user_id
        WHERE u.is_active = true
        ORDER BY nome, c.vigencia_ym DESC`);
      // O seletor só oferece quem participa do resumo.
      const colabs: any = await db.execute(sql`
        SELECT u.id, COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS nome,
               u.role, u.seller_type
        FROM users u
        LEFT JOIN resumo_participantes p ON p.user_id = u.id
        WHERE u.is_active = true
          AND ((u.role::text = ANY(${arraySql(PAPEIS)}) AND COALESCE(p.incluir, true) = true) OR p.incluir = true)
        ORDER BY u.role, u.first_name, u.last_name`);
      // Lista completa para a aba Participantes, com o estado de cada um.
      const todos: any = await db.execute(sql`
        SELECT u.id, COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS nome,
               u.role::text AS role, u.email,
               (u.role::text = ANY(${arraySql(PAPEIS)})) AS papel_de_vendas,
               COALESCE(p.incluir, u.role::text = ANY(${arraySql(PAPEIS)})) AS incluir
        FROM users u
        LEFT JOIN resumo_participantes p ON p.user_id = u.id
        WHERE u.is_active = true
        ORDER BY u.role, u.first_name, u.last_name`);
      res.json({ configs: r.rows || [], colaboradores: colabs.rows || [], participantes: todos.rows || [] });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] config listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar as configurações" });
    }
  });

  app.post("/api/resumo-recebiveis/config", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const b = req.body || {};
      if (!b.userId) return res.status(400).json({ message: "Informe o colaborador" });
      if (!ymValido(b.vigenciaYm)) return res.status(400).json({ message: "Vigência inválida (use AAAA-MM)" });
      const tipo = ["nenhum", "fixo", "faixa"].includes(String(b.comissaoTipo)) ? String(b.comissaoTipo) : "nenhum";
      const faixa = FAIXAS[String(b.faixaTipo)] ? String(b.faixaTipo) : FAIXA_PADRAO;
      const bool = (v: any, padrao: boolean) => (typeof v === "boolean" ? v : padrao);

      const r: any = await db.execute(sql`
        INSERT INTO collab_remuneracao_config
          (user_id, vigencia_ym, fixo_mensal, ajuda_custo, comissao_tipo, comissao_pct,
           comissao_desconto_fixo, comissao_proporcional_meta, faixa_tipo, paga_km,
           incluir_no_resumo, usa_fixo, usa_ajuda_custo, usa_meta, usa_faturamento, usa_comissao,
           usa_km, usa_campanhas, usa_bonus, observacao, created_by)
        VALUES (${b.userId}, ${b.vigenciaYm}, ${n(b.fixoMensal)}, ${n(b.ajudaCusto)}, ${tipo}, ${n(b.comissaoPct)},
                ${n(b.comissaoDescontoFixo)}, ${b.comissaoProporcionalMeta === true}, ${faixa},
                ${bool(b.usaKm, true)},
                ${bool(b.incluirNoResumo, true)}, ${bool(b.usaFixo, true)}, ${b.usaAjudaCusto === true}, ${bool(b.usaMeta, true)},
                ${bool(b.usaFaturamento, true)}, ${bool(b.usaComissao, true)}, ${bool(b.usaKm, true)},
                ${bool(b.usaCampanhas, true)}, ${b.usaBonus === true},
                ${String(b.observacao || "").slice(0, 500) || null}, ${req.currentUser?.id || null})
        ON CONFLICT (user_id, vigencia_ym) DO UPDATE SET
          fixo_mensal = EXCLUDED.fixo_mensal,
          ajuda_custo = EXCLUDED.ajuda_custo,
          comissao_tipo = EXCLUDED.comissao_tipo,
          comissao_pct = EXCLUDED.comissao_pct,
          comissao_desconto_fixo = EXCLUDED.comissao_desconto_fixo,
          comissao_proporcional_meta = EXCLUDED.comissao_proporcional_meta,
          faixa_tipo = EXCLUDED.faixa_tipo,
          paga_km = EXCLUDED.paga_km,
          incluir_no_resumo = EXCLUDED.incluir_no_resumo,
          usa_fixo = EXCLUDED.usa_fixo,
          usa_ajuda_custo = EXCLUDED.usa_ajuda_custo,
          usa_meta = EXCLUDED.usa_meta,
          usa_faturamento = EXCLUDED.usa_faturamento,
          usa_comissao = EXCLUDED.usa_comissao,
          usa_km = EXCLUDED.usa_km,
          usa_campanhas = EXCLUDED.usa_campanhas,
          usa_bonus = EXCLUDED.usa_bonus,
          observacao = EXCLUDED.observacao
        RETURNING id`);
      res.json({ message: "Configuração salva", id: r.rows?.[0]?.id });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] config salvar:", e?.message || e);
      res.status(500).json({ message: "Falha ao salvar a configuração" });
    }
  });

  app.delete("/api/resumo-recebiveis/config/:id", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      await db.execute(sql`DELETE FROM collab_remuneracao_config WHERE id = ${req.params.id}`);
      res.json({ message: "Vigência removida" });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] config remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover a vigência" });
    }
  });

  // -------------------------------------------------------------------------
  // Participação no resumo: tira/traz um colaborador da planilha (somente admin).
  // -------------------------------------------------------------------------
  app.post("/api/resumo-recebiveis/participacao", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const b = req.body || {};
      if (!b.userId) return res.status(400).json({ message: "Informe o colaborador" });
      await db.execute(sql`
        INSERT INTO resumo_participantes (user_id, incluir, updated_by, updated_at)
        VALUES (${b.userId}, ${b.incluir !== false}, ${req.currentUser?.id || null}, now())
        ON CONFLICT (user_id) DO UPDATE SET
          incluir = EXCLUDED.incluir, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      res.json({ message: b.incluir !== false ? "Colaborador incluído no resumo" : "Colaborador retirado do resumo" });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] participacao:", e?.message || e);
      res.status(500).json({ message: "Falha ao alterar a participação" });
    }
  });

  // -------------------------------------------------------------------------
  // Cadastro de campanhas que viram coluna (somente admin).
  // -------------------------------------------------------------------------
  app.get("/api/resumo-recebiveis/campanhas", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const r: any = await db.execute(sql`
        SELECT id, nome, origem, ym_inicio, ym_fim, ativa, ordem, observacao, created_at
        FROM resumo_campanhas ORDER BY ativa DESC, ordem, nome`);
      res.json({ campanhas: r.rows || [] });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] campanhas listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar as campanhas" });
    }
  });

  app.post("/api/resumo-recebiveis/campanhas", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const b = req.body || {};
      const nome = String(b.nome || "").trim().slice(0, 120);
      if (!nome) return res.status(400).json({ message: "Dê um nome à campanha" });
      if (!ymValido(b.ymInicio)) return res.status(400).json({ message: "Informe o mês de início (AAAA-MM)" });
      if (b.ymFim && !ymValido(b.ymFim)) return res.status(400).json({ message: "Mês final inválido" });
      const origem = b.origem === "campanha" ? "campanha" : "manual";

      if (b.id) {
        await db.execute(sql`
          UPDATE resumo_campanhas SET nome = ${nome}, origem = ${origem},
            ym_inicio = ${b.ymInicio}, ym_fim = ${b.ymFim || null},
            ativa = ${b.ativa !== false}, ordem = ${Math.trunc(n(b.ordem))},
            observacao = ${String(b.observacao || "").slice(0, 500) || null}
          WHERE id = ${b.id}`);
        return res.json({ message: "Campanha atualizada", id: b.id });
      }
      const r: any = await db.execute(sql`
        INSERT INTO resumo_campanhas (nome, origem, ym_inicio, ym_fim, ativa, ordem, observacao, created_by)
        VALUES (${nome}, ${origem}, ${b.ymInicio}, ${b.ymFim || null}, ${b.ativa !== false},
                ${Math.trunc(n(b.ordem))}, ${String(b.observacao || "").slice(0, 500) || null},
                ${req.currentUser?.id || null})
        RETURNING id`);
      res.json({ message: "Campanha criada", id: r.rows?.[0]?.id });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] campanha salvar:", e?.message || e);
      res.status(500).json({ message: "Falha ao salvar a campanha" });
    }
  });

  app.delete("/api/resumo-recebiveis/campanhas/:id", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      await db.execute(sql`DELETE FROM resumo_campanhas WHERE id = ${req.params.id}`);
      res.json({ message: "Campanha removida" });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] campanha remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover a campanha" });
    }
  });

  // Valor de campanha 'manual' por colaborador/mês.
  app.post("/api/resumo-recebiveis/campanhas/:id/valor", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const b = req.body || {};
      if (!b.userId || !ymValido(b.ym)) return res.status(400).json({ message: "Colaborador e mês são obrigatórios" });
      await db.execute(sql`
        INSERT INTO resumo_campanha_valores (campanha_id, user_id, ym, valor, observacao, created_by)
        VALUES (${req.params.id}, ${b.userId}, ${b.ym}, ${n(b.valor)},
                ${String(b.observacao || "").slice(0, 300) || null}, ${req.currentUser?.id || null})
        ON CONFLICT (campanha_id, user_id, ym) DO UPDATE SET
          valor = EXCLUDED.valor, observacao = EXCLUDED.observacao`);
      res.json({ message: "Valor lançado" });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] campanha valor:", e?.message || e);
      res.status(500).json({ message: "Falha ao lançar o valor" });
    }
  });

  // -------------------------------------------------------------------------
  // Bônus avulso — só para quem está flagado com "Bônus manual".
  // -------------------------------------------------------------------------
  app.post("/api/resumo-recebiveis/bonus", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const b = req.body || {};
      if (!b.userId || !ymValido(b.ym)) return res.status(400).json({ message: "Colaborador e mês são obrigatórios" });
      const descricao = String(b.descricao || "").trim().slice(0, 300);
      if (!descricao) return res.status(400).json({ message: "Descreva o bônus" });

      const cf: any = await db.execute(sql`
        SELECT usa_bonus FROM collab_remuneracao_config
        WHERE user_id = ${b.userId} AND vigencia_ym <= ${b.ym}
        ORDER BY vigencia_ym DESC LIMIT 1`);
      if (cf.rows?.[0]?.usa_bonus !== true) {
        return res.status(400).json({ message: "Ative 'Bônus manual' para este colaborador na Configuração" });
      }

      const r: any = await db.execute(sql`
        INSERT INTO collab_bonus_lancamentos (user_id, ym, descricao, valor, created_by)
        VALUES (${b.userId}, ${b.ym}, ${descricao}, ${n(b.valor)}, ${req.currentUser?.id || null})
        RETURNING id`);
      res.json({ message: "Bônus lançado", id: r.rows?.[0]?.id });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] bonus criar:", e?.message || e);
      res.status(500).json({ message: "Falha ao lançar o bônus" });
    }
  });

  app.delete("/api/resumo-recebiveis/bonus/:id", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      await db.execute(sql`DELETE FROM collab_bonus_lancamentos WHERE id = ${req.params.id}`);
      res.json({ message: "Lançamento removido" });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] bonus remover:", e?.message || e);
      res.status(500).json({ message: "Falha ao remover o lançamento" });
    }
  });
}
