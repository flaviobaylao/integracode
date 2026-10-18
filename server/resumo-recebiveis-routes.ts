// ============================================================================
// RESUMO RECEBÍVEIS COLABORADOR — 18/out/2026
// ---------------------------------------------------------------------------
// Módulo de Vendas (/resumo-recebiveis). Uma planilha por mês com tudo que
// cada colaborador tem a receber: vendedores internos, externos, administrativo
// e motoristas.
//
// Colunas: Fixo Mensal · Meta · Faturamento · Comissão Mês · Bônus · Km · Total
// Linhas por colaborador: nome / % do total dele / R$.
//
// DE ONDE VEM CADA NÚMERO
//   Fixo Mensal ... collab_remuneracao_config (novo). Nada no sistema guardava
//                   salário/ajuda de custo; a configuração é por colaborador e
//                   tem VIGÊNCIA — vale do mês informado em diante. Um aumento
//                   em novembro não reescreve o que já foi apurado em outubro.
//   Meta .......... sales_goals.revenue_goal (seller_id + month + year).
//   Faturamento ... faturamento-oficial.sqlFaturamentoPorVendedor — a mesma
//                   fonte do Dashboard e do painel de comissão. NF-e de venda
//                   autorizada, atribuída a quem implantou o pedido.
//   Comissão ...... regra por colaborador na própria configuração: percentual
//                   fixo (com desconto e proporcionalidade opcionais) ou faixa
//                   por atingimento. A semântica é a mesma de
//                   client/src/lib/comissaoMetas.ts, que até aqui ficava
//                   fixada por primeiro nome no código do front.
//   Bônus ......... TUDO que o colaborador recebe fora de fixo, comissão e km:
//                   a Campanha do mês (campanha-outubro.ts), o challenge_bonus
//                   das metas quando batido, e lançamentos manuais avulsos
//                   (collab_bonus_lancamentos).
//   Km ............ SUM(daily_routes.total_actual_distance) do mês × a tarifa
//                   do colaborador (config_global: km_seller_rates, com
//                   fallback para a tarifa da região em km_payment_config).
//                   Mesma conta da tela Kilometragem Vendedores.
//
// ACESSO
//   Cada colaborador vê SOMENTE a própria linha; admin vê todos. O
//   authenticateUser eleva 'industria' e 'contador' a admin para leitura — aqui
//   isso NÃO vale, senão folha de pagamento vazaria para esses perfis. Por isso
//   o módulo testa req.perfilIndustria / req.perfilContador explicitamente.
//
// Tabelas criadas por CREATE TABLE IF NOT EXISTS no primeiro uso: o build de
// produção não roda db:push (mesma razão de company_documents e seller_documents).
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { sqlFaturamentoPorVendedor } from "./faturamento-oficial";
import { computeCampaign } from "./campanha-outubro";

// Funções que aparecem na planilha.
const PAPEIS = ["vendedor", "telemarketing", "administrative", "motorista"];

// Faixas por atingimento — cópia da tabela usada em
// /api/sales-goals/commission-dashboard (server/routes.ts, COMMISSION_TIERS).
// Confirmado por Flavio em 02/09/2026: quem é "faixa" usa sempre a tabela de
// vendas internas (telemarketing), independente do tipo do cadastro.
const FAIXAS: Record<string, { thresholds: number[]; rates: number[] }> = {
  vendedor_clt: { thresholds: [0, 85, 100, 110, 120], rates: [0.8, 1.5, 2.5, 3.5, 4.5] },
  vendedor_pj: { thresholds: [0, 85, 100, 110, 120], rates: [3.5, 4.5, 6.0, 6.5, 7.5] },
  telemarketing: { thresholds: [0, 90, 100, 110, 120], rates: [1.5, 2.0, 3.0, 3.5, 4.0] },
};
const FAIXA_PADRAO = "telemarketing";

type Cfg = {
  fixoMensal: number;
  comissaoTipo: "nenhum" | "fixo" | "faixa";
  comissaoPct: number;
  comissaoDescontoFixo: number;
  comissaoProporcionalMeta: boolean;
  pagaKm: boolean;
  faixaTipo: string;
  observacao: string;
  vigenciaYm: string | null;
};

const CFG_PADRAO: Cfg = {
  fixoMensal: 0,
  comissaoTipo: "nenhum",
  comissaoPct: 0,
  comissaoDescontoFixo: 0,
  comissaoProporcionalMeta: false,
  pagaKm: true,
  faixaTipo: FAIXA_PADRAO,
  observacao: "",
  vigenciaYm: null,
};

// O driver nao aceita array JS como bind de ANY(); literal ARRAY[...]::varchar[]
// e o idioma usado no resto do servidor (ver arraySql em contabilidade-insumos.ts).
const arraySql = (xs: string[]) =>
  sql.raw(`ARRAY[${xs.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(",")}]::varchar[]`);

const n = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const ymValido = (s: any) => /^\d{4}-\d{2}$/.test(String(s || ""));

function limitesDoMes(ym: string) {
  const [a, m] = ym.split("-").map(Number);
  const ini = `${ym}-01`;
  const prox = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
  return { ini, fim: prox, ano: a, mes: m };
}

// Alíquota da faixa correspondente ao atingimento.
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
    // A comissão da META é a referência; o mês é uma fatia dela, na mesma
    // proporção do faturamento sobre a meta. Aplicar o desconto direto no
    // faturamento deixaria o valor zerado quase o mês inteiro.
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
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS collab_bonus_lancamentos (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
        "ym varchar(7) NOT NULL, " +
        "descricao text NOT NULL, " +
        "valor numeric NOT NULL DEFAULT 0, " +
        "created_by varchar, created_at timestamptz DEFAULT now())"
      ));
      for (const ix of [
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_collab_cfg_user_ym ON collab_remuneracao_config (user_id, vigencia_ym)",
        "CREATE INDEX IF NOT EXISTS idx_collab_bonus_ym ON collab_bonus_lancamentos (ym, user_id)",
      ]) await db.execute(sql.raw(ix)).catch(() => {});
      await semearRegrasAtuais();
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// Primeira carga: traz para o banco as regras de comissão que hoje estão
// fixadas por primeiro nome em client/src/lib/comissaoMetas.ts, para o módulo
// não nascer zerado. O FIXO MENSAL fica em 0 de propósito — nenhum salário
// está registrado no sistema e não cabe adivinhar valor de folha.
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
    const primeiro = String(row.primeiro || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "");
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

// Admin de verdade: 'industria' e 'contador' são elevados a admin pelo
// authenticateUser para LEITURA do sistema; folha de pagamento não entra nisso.
function ehAdmin(req: any): boolean {
  return req.currentUser?.role === "admin" && !req.perfilIndustria && !req.perfilContador;
}

export function registerResumoRecebiveisRoutes(app: Express) {
  // -------------------------------------------------------------------------
  // A planilha do mês.
  // -------------------------------------------------------------------------
  app.get("/api/resumo-recebiveis", authenticateUser, async (req: any, res) => {
    try {
      await ensureResumoRecebiveisSchema();
      const ym = ymValido(req.query?.ym)
        ? String(req.query.ym)
        : new Date().toISOString().slice(0, 7);
      const { ini, fim, ano, mes } = limitesDoMes(ym);
      const admin = ehAdmin(req);
      const eu = req.currentUser;

      // 1. Quem entra na planilha
      const colabs: any = admin
        ? await db.execute(sql`
            SELECT id, first_name, last_name, email, role, seller_type
            FROM users WHERE is_active = true AND role::text = ANY(${arraySql(PAPEIS)})
            ORDER BY role, first_name, last_name`)
        : await db.execute(sql`
            SELECT id, first_name, last_name, email, role, seller_type
            FROM users WHERE id = ${eu.id}`);

      const linhas = (colabs.rows || []) as any[];
      if (!linhas.length) return res.json({ ym, admin, colaboradores: [], totais: null });
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
      const metaMap: Record<string, { meta: number; desafio: number; bonusDesafio: number }> = {};
      const mt: any = await db.execute(sql`
        SELECT seller_id, revenue_goal, challenge_goal, challenge_bonus
        FROM sales_goals
        WHERE month = ${mes} AND year = ${ano} AND is_active = true
          AND seller_id = ANY(${arraySql(ids)})`);
      for (const r of mt.rows || []) {
        metaMap[String(r.seller_id)] = {
          meta: n(r.revenue_goal),
          desafio: n(r.challenge_goal),
          bonusDesafio: n(r.challenge_bonus),
        };
      }

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

      // 5. Bônus — campanha do mês + challenge_bonus + lançamentos manuais
      const campMap: Record<string, number> = {};
      try {
        const camp = await computeCampaign(undefined, ym);
        for (const c of camp.sellers || []) {
          campMap[String(c.seller || "").trim().toLowerCase()] = n(c.bonusTotal);
        }
      } catch (e: any) {
        console.error("[RESUMO-RECEB] campanha:", e?.message || e);
      }

      const lancMap: Record<string, Array<{ id: string; descricao: string; valor: number }>> = {};
      const lc: any = await db.execute(sql`
        SELECT id, user_id, descricao, valor FROM collab_bonus_lancamentos
        WHERE ym = ${ym} AND user_id = ANY(${arraySql(ids)}) ORDER BY created_at`);
      for (const r of lc.rows || []) {
        const k = String(r.user_id);
        (lancMap[k] = lancMap[k] || []).push({ id: r.id, descricao: r.descricao, valor: n(r.valor) });
      }

      // 6. Configuração vigente: a linha mais recente com vigência <= ym
      const cfgMap: Record<string, Cfg> = {};
      const cf: any = await db.execute(sql`
        SELECT DISTINCT ON (user_id) user_id, vigencia_ym, fixo_mensal, comissao_tipo,
               comissao_pct, comissao_desconto_fixo, comissao_proporcional_meta,
               faixa_tipo, paga_km, observacao
        FROM collab_remuneracao_config
        WHERE user_id = ANY(${arraySql(ids)}) AND vigencia_ym <= ${ym}
        ORDER BY user_id, vigencia_ym DESC`);
      for (const r of cf.rows || []) {
        cfgMap[String(r.user_id)] = {
          fixoMensal: n(r.fixo_mensal),
          comissaoTipo: (r.comissao_tipo || "nenhum") as Cfg["comissaoTipo"],
          comissaoPct: n(r.comissao_pct),
          comissaoDescontoFixo: n(r.comissao_desconto_fixo),
          comissaoProporcionalMeta: r.comissao_proporcional_meta === true,
          pagaKm: r.paga_km !== false,
          faixaTipo: r.faixa_tipo || FAIXA_PADRAO,
          observacao: r.observacao || "",
          vigenciaYm: r.vigencia_ym || null,
        };
      }

      // 7. Monta cada colaborador
      const colaboradores = linhas.map((u) => {
        const id = String(u.id);
        const nome = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || id;
        const cfg = cfgMap[id] || { ...CFG_PADRAO };
        const meta = metaMap[id]?.meta || 0;
        const faturamento = fatMap[id] || 0;

        const fixo = cfg.fixoMensal;
        const comissao = calcularComissao(cfg, faturamento, meta);

        const bonusCampanha = campMap[nome.toLowerCase()] || 0;
        const bateuDesafio = metaMap[id]?.desafio > 0 && faturamento >= metaMap[id].desafio;
        const bonusDesafio = bateuDesafio ? metaMap[id].bonusDesafio : 0;
        const lancamentos = lancMap[id] || [];
        const bonusManual = lancamentos.reduce((s, l) => s + l.valor, 0);
        const bonus = bonusCampanha + bonusDesafio + bonusManual;

        const kmRodado = kmMap[id] || 0;
        const tarifa = tarifaDe(id);
        const kmValor = cfg.pagaKm ? kmRodado * tarifa : 0;

        const total = fixo + comissao + bonus + kmValor;
        const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);

        return {
          id, nome,
          role: u.role,
          sellerType: u.seller_type || null,
          config: cfg,
          fixoMensal: fixo,
          meta,
          faturamento,
          atingimentoPct: meta > 0 ? (faturamento / meta) * 100 : 0,
          comissao,
          bonus,
          bonusDetalhe: { campanha: bonusCampanha, desafio: bonusDesafio, manual: bonusManual, lancamentos },
          kmRodado, kmTarifa: tarifa, kmValor,
          totalMes: total,
          // "% Total do Mês": fatia de cada rubrica na remuneração dele.
          percentuais: {
            fixoMensal: pct(fixo),
            comissao: pct(comissao),
            bonus: pct(bonus),
            km: pct(kmValor),
            totalMes: total > 0 ? 100 : 0,
          },
        };
      });

      const soma = (f: (c: any) => number) => colaboradores.reduce((s, c) => s + f(c), 0);
      const totais = {
        fixoMensal: soma((c) => c.fixoMensal),
        meta: soma((c) => c.meta),
        faturamento: soma((c) => c.faturamento),
        comissao: soma((c) => c.comissao),
        bonus: soma((c) => c.bonus),
        kmRodado: soma((c) => c.kmRodado),
        kmValor: soma((c) => c.kmValor),
        totalMes: soma((c) => c.totalMes),
      };

      res.json({ ym, admin, colaboradores, totais });
    } catch (e: any) {
      console.error("[RESUMO-RECEB] planilha:", e?.message || e);
      res.status(500).json({ message: "Falha ao montar o resumo de recebíveis" });
    }
  });

  // -------------------------------------------------------------------------
  // Configuração de remuneração (somente admin).
  // -------------------------------------------------------------------------
  app.get("/api/resumo-recebiveis/config", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const r: any = await db.execute(sql`
        SELECT c.id, c.user_id, c.vigencia_ym, c.fixo_mensal, c.comissao_tipo, c.comissao_pct,
               c.comissao_desconto_fixo, c.comissao_proporcional_meta, c.faixa_tipo, c.paga_km,
               c.observacao, c.created_at,
               COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS nome,
               u.role
        FROM collab_remuneracao_config c
        JOIN users u ON u.id = c.user_id
        ORDER BY nome, c.vigencia_ym DESC`);
      const colabs: any = await db.execute(sql`
        SELECT id, COALESCE(NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ''), email) AS nome, role, seller_type
        FROM users WHERE is_active = true AND role::text = ANY(${arraySql(PAPEIS)})
        ORDER BY role, first_name, last_name`);
      res.json({ configs: r.rows || [], colaboradores: colabs.rows || [] });
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

      const r: any = await db.execute(sql`
        INSERT INTO collab_remuneracao_config
          (user_id, vigencia_ym, fixo_mensal, comissao_tipo, comissao_pct,
           comissao_desconto_fixo, comissao_proporcional_meta, faixa_tipo, paga_km, observacao, created_by)
        VALUES (${b.userId}, ${b.vigenciaYm}, ${n(b.fixoMensal)}, ${tipo}, ${n(b.comissaoPct)},
                ${n(b.comissaoDescontoFixo)}, ${b.comissaoProporcionalMeta === true}, ${faixa},
                ${b.pagaKm !== false}, ${String(b.observacao || "").slice(0, 500) || null}, ${req.currentUser?.id || null})
        ON CONFLICT (user_id, vigencia_ym) DO UPDATE SET
          fixo_mensal = EXCLUDED.fixo_mensal,
          comissao_tipo = EXCLUDED.comissao_tipo,
          comissao_pct = EXCLUDED.comissao_pct,
          comissao_desconto_fixo = EXCLUDED.comissao_desconto_fixo,
          comissao_proporcional_meta = EXCLUDED.comissao_proporcional_meta,
          faixa_tipo = EXCLUDED.faixa_tipo,
          paga_km = EXCLUDED.paga_km,
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
  // Lançamentos avulsos de bônus (somente admin).
  // -------------------------------------------------------------------------
  app.post("/api/resumo-recebiveis/bonus", authenticateUser, async (req: any, res) => {
    try {
      if (!ehAdmin(req)) return res.status(403).json({ message: "Access denied" });
      await ensureResumoRecebiveisSchema();
      const b = req.body || {};
      if (!b.userId || !ymValido(b.ym)) return res.status(400).json({ message: "Colaborador e mês são obrigatórios" });
      const descricao = String(b.descricao || "").trim().slice(0, 300);
      if (!descricao) return res.status(400).json({ message: "Descreva o bônus" });
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
