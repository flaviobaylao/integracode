import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { nfVendaWhere, nfVendaFrom, nfData } from "./faturamento-oficial";

// ============================================================================
// CAMPANHA DE OUTUBRO — bonificacao por novos clientes, positivacao e meta.
// Premissas (fixas): R$30 por novo cliente (apto), R$500 por 90% de positivacao
// no mes, R$500 por bater a meta de faturamento (sales_goals.revenue_goal).
// Novo cliente = cliente inedito na base cuja 1a NF-e de VENDA cai no mes da
// campanha, com pedido (1o dia) >= R$300, creditado ao dono da carteira. O
// cadastro vai para o Inbox como "pendente"; o admin aprova/rejeita (vira apto
// ou nao para a campanha). O pedido e o cadastro valem na carteira nos 2 casos.
// Escopo por papel: admin ve tudo; vendedor ve apenas o seu (scopeSellerName).
// ============================================================================

const CAMPAIGN_YM = "2026-10"; // mes vigente da campanha
const PEDIDO_MIN = 300;        // pedido minimo para contar como novo da campanha
const POS_META = 90;           // % de positivacao para o bonus
const BONUS_NOVO = 30;         // R$ por novo cliente apto
const BONUS_POS = 500;         // R$ por 90% de positivacao
const BONUS_META = 500;        // R$ por bater a meta de faturamento

const rawq = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

function todayBrt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function campaignActive(): boolean { return todayBrt().slice(0, 7) === CAMPAIGN_YM; }

// Carteira doc -> vendedor (dono da carteira) — identico ao dashboard-history.
const CARTEIRA_SELLER = "(SELECT DISTINCT ON (doc) doc, seller FROM (SELECT regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') AS doc, NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') AS seller FROM customers c JOIN users u ON (u.omie_vendor_code=c.seller_id OR u.omie_vendor_code=replace(COALESCE(c.seller_id,''),'omie-vendor-','') OR u.id=c.seller_id) WHERE regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') <> '') s ORDER BY doc) cs";

const PURO_EXCL =
  " AND NOT (UPPER(COALESCE(c.name,'')||' '||COALESCE(c.fantasy_name,'')) LIKE '%PURO%' AND UPPER(COALESCE(c.name,'')||' '||COALESCE(c.fantasy_name,'')) LIKE '%PRODUTOS NATURAIS%')" +
  " AND NOT (UPPER(COALESCE(c.name,'')||' '||COALESCE(c.fantasy_name,'')) LIKE '%PURO%' AND UPPER(COALESCE(c.name,'')||' '||COALESCE(c.fantasy_name,'')) LIKE '%CONSULTORIA EMPRESARIAL%')";

let _ensured = false;
export async function ensureCampaignTable(): Promise<void> {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS campaign_new_clients (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_ym varchar NOT NULL,
    doc varchar NOT NULL,
    customer_id varchar,
    customer_name varchar NOT NULL DEFAULT '',
    seller_name varchar NOT NULL DEFAULT '',
    region varchar NOT NULL DEFAULT '',
    order_value numeric NOT NULL DEFAULT 0,
    first_order_date date,
    status varchar NOT NULL DEFAULT 'pendente',
    justification text,
    decided_by varchar,
    decided_at timestamptz,
    created_at timestamptz DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_ym_doc ON campaign_new_clients (campaign_ym, doc)`);
  _ensured = true;
}

// Detecta candidatos a novo cliente do mes e faz upsert como "pendente"
// (mantendo decisoes ja tomadas). Novo = 1a NF-e de venda da base caindo no mes.
export async function detectNovos(ym: string): Promise<number> {
  await ensureCampaignTable();
  const dcol = nfData("fi");
  // 1a compra (data + valor do 1o dia) por documento, em toda a base.
  const firsts = await rawq(
    "SELECT DISTINCT ON (doc) doc, d AS first_d, dayv FROM (" +
    "SELECT regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') AS doc, " + dcol + "::date::text AS d, COALESCE(SUM(fi.total_invoice),0) AS dayv" +
    " FROM " + nfVendaFrom("fi") + " WHERE " + nfVendaWhere("fi") +
    " AND regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') <> '' GROUP BY 1, 2" +
    ") q ORDER BY doc, d"
  );
  const novos = firsts.filter((r) => String(r.first_d).slice(0, 7) === ym && (Number(r.dayv) || 0) >= PEDIDO_MIN);
  if (!novos.length) return 0;
  // Dados do cliente (nome, regiao, id) e vendedor da carteira.
  const custs = await rawq(
    "SELECT c.id, regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') AS doc," +
    " COALESCE(NULLIF(c.fantasy_name,''), c.name, '(sem nome)') AS nome," +
    " COALESCE(NULLIF(c.neighborhood,''), c.city, '') AS regiao" +
    " FROM customers c WHERE regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') <> ''" + PURO_EXCL
  );
  const cust: Record<string, { id: string; nome: string; regiao: string }> = {};
  for (const r of custs) { const d = String(r.doc); if (d && !(d in cust)) cust[d] = { id: String(r.id), nome: String(r.nome || ""), regiao: String(r.regiao || "") }; }
  const carteira = await rawq("SELECT doc, seller FROM " + CARTEIRA_SELLER);
  const docSeller: Record<string, string> = {};
  for (const r of carteira) { const d = String(r.doc); if (d && !(d in docSeller)) docSeller[d] = String(r.seller || ""); }

  let n = 0;
  for (const r of novos) {
    const doc = String(r.doc);
    const c = cust[doc];
    if (!c) continue; // sem cadastro (ou excluido por PURO) — ignora
    const seller = docSeller[doc] || "";
    const val = Math.round((Number(r.dayv) || 0) * 100) / 100;
    const fd = String(r.first_d).slice(0, 10);
    const docE = doc.replace(/'/g, "");
    const nomeE = c.nome.replace(/'/g, "''");
    const regE = c.regiao.replace(/'/g, "''");
    const sellE = seller.replace(/'/g, "''");
    await db.execute(sql.raw(
      "INSERT INTO campaign_new_clients (campaign_ym, doc, customer_id, customer_name, seller_name, region, order_value, first_order_date, status)" +
      " VALUES ('" + ym + "', '" + docE + "', '" + c.id + "', '" + nomeE + "', '" + sellE + "', '" + regE + "', " + val + ", '" + fd + "'::date, 'pendente')" +
      " ON CONFLICT (campaign_ym, doc) DO UPDATE SET customer_name = EXCLUDED.customer_name, seller_name = EXCLUDED.seller_name, region = EXCLUDED.region, order_value = EXCLUDED.order_value, first_order_date = EXCLUDED.first_order_date" +
      " WHERE campaign_new_clients.status = 'pendente'"
    ));
    n++;
  }
  return n;
}

export type CampaignSeller = {
  seller: string; novosAptos: number; emValidacao: number; carteira: number; positivados: number;
  positivacao: number; faturamento: number; meta: number;
  bonusNovos: number; bonusPos: number; bonusMeta: number; bonusTotal: number;
};

export async function computeCampaign(only?: string, ym: string = CAMPAIGN_YM): Promise<{ asOf: string; ym: string; premissas: any; sellers: CampaignSeller[]; totais: any }> {
  await ensureCampaignTable();
  const asOf = todayBrt();
  const ini = ym + "-01";
  const [Y, M] = ym.split("-").map(Number);

  // Carteira ativa (doc -> vendedor) para positivacao.
  const cart = await rawq(
    "SELECT regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') AS doc," +
    " NULLIF(TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))),'') AS seller" +
    " FROM customers c" +
    " LEFT JOIN users u ON (u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(COALESCE(c.seller_id,''),'omie-vendor-','') OR u.id = c.seller_id)" +
    " WHERE c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE)" +
    " AND EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = c.id AND ac.is_active IS TRUE)" +
    " AND regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') <> ''" + PURO_EXCL
  );
  const docSeller: Record<string, string> = {};
  const carteiraCount: Record<string, number> = {};
  for (const r of cart) {
    const doc = String(r.doc); const seller = String(r.seller || "Sem vendedor");
    if (doc && !(doc in docSeller)) { docSeller[doc] = seller; carteiraCount[seller] = (carteiraCount[seller] || 0) + 1; }
  }

  // Faturamento do mes por documento (NF-e de venda).
  const dcol = nfData("fi");
  const fat = await rawq(
    "SELECT regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') AS doc, COALESCE(SUM(fi.total_invoice),0) AS v" +
    " FROM " + nfVendaFrom("fi") + " WHERE " + nfVendaWhere("fi") +
    " AND " + dcol + "::date >= '" + ini + "'::date AND " + dcol + "::date < ('" + ini + "'::date + INTERVAL '1 month')" +
    " AND regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') <> '' GROUP BY 1"
  );
  const faturamento: Record<string, number> = {};
  const positivados: Record<string, number> = {};
  for (const r of fat) {
    const doc = String(r.doc); const seller = docSeller[doc]; if (!seller) continue;
    const v = Number(r.v) || 0; if (v <= 0) continue;
    faturamento[seller] = (faturamento[seller] || 0) + v;
    positivados[seller] = (positivados[seller] || 0) + 1;
  }

  // Metas de faturamento (sales_goals) do mes/ano, por nome do vendedor.
  const metas: Record<string, number> = {};
  try {
    const mrows = await rawq(
      "SELECT NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),'') AS seller, COALESCE(sg.revenue_goal,0) AS meta" +
      " FROM sales_goals sg JOIN users u ON u.id = sg.seller_id" +
      " WHERE sg.month = " + M + " AND sg.year = " + Y + " AND COALESCE(sg.is_active, true) IS TRUE"
    );
    for (const r of mrows) { const s = String(r.seller || ""); if (s) metas[s] = Number(r.meta) || 0; }
  } catch (e) { /* sem metas cadastradas */ }

  // Novos clientes da campanha por vendedor (aptos / em validacao).
  const novosAptos: Record<string, number> = {};
  const emValidacao: Record<string, number> = {};
  const crows = await rawq("SELECT seller_name, status, COUNT(*)::int AS n FROM campaign_new_clients WHERE campaign_ym = '" + ym + "' GROUP BY 1, 2");
  for (const r of crows) {
    const s = String(r.seller_name || ""); if (!s) continue;
    if (String(r.status) === "aprovado") novosAptos[s] = (novosAptos[s] || 0) + (Number(r.n) || 0);
    else if (String(r.status) === "pendente") emValidacao[s] = (emValidacao[s] || 0) + (Number(r.n) || 0);
  }

  // Participam da campanha apenas usuarios ativos com papel vendedor/telemarketing.
  const vendRows = await rawq("SELECT NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS nome FROM users WHERE role::text IN ('vendedor','telemarketing') AND is_active IS TRUE");
  const vendSet = new Set(vendRows.map((r: any) => String(r.nome || "")).filter(Boolean));

  const names = new Set<string>();
  Object.keys(carteiraCount).forEach((s) => names.add(s));
  Object.keys(novosAptos).forEach((s) => names.add(s));
  Object.keys(emValidacao).forEach((s) => names.add(s));

  let sellers: CampaignSeller[] = [];
  for (const seller of names) {
    if (!seller || seller === "Sem vendedor" || !vendSet.has(seller)) continue;
    if (only && seller !== only) continue;
    const cartN = carteiraCount[seller] || 0;
    const pos = positivados[seller] || 0;
    const positivacao = cartN > 0 ? Math.round((pos / cartN) * 1000) / 10 : 0;
    const fatv = Math.round((faturamento[seller] || 0) * 100) / 100;
    const meta = Math.round((metas[seller] || 0) * 100) / 100;
    const aptos = novosAptos[seller] || 0;
    const bonusNovos = aptos * BONUS_NOVO;
    const bonusPos = positivacao >= POS_META ? BONUS_POS : 0;
    const bonusMeta = meta > 0 && fatv >= meta ? BONUS_META : 0;
    sellers.push({
      seller, novosAptos: aptos, emValidacao: emValidacao[seller] || 0, carteira: cartN, positivados: pos,
      positivacao, faturamento: fatv, meta, bonusNovos, bonusPos, bonusMeta, bonusTotal: bonusNovos + bonusPos + bonusMeta,
    });
  }
  sellers.sort((a, b) => b.bonusTotal - a.bonusTotal || b.faturamento - a.faturamento);

  const totais = {
    novosAptos: sellers.reduce((a, s) => a + s.novosAptos, 0),
    emValidacao: sellers.reduce((a, s) => a + s.emValidacao, 0),
    bonusNovos: sellers.reduce((a, s) => a + s.bonusNovos, 0),
    bonusPos: sellers.reduce((a, s) => a + s.bonusPos, 0),
    bonusMeta: sellers.reduce((a, s) => a + s.bonusMeta, 0),
    bonusTotal: sellers.reduce((a, s) => a + s.bonusTotal, 0),
    comPositivacao: sellers.filter((s) => s.positivacao >= POS_META).length,
    comMeta: sellers.filter((s) => s.meta > 0 && s.faturamento >= s.meta).length,
    vendedores: sellers.length,
  };

  return { asOf, ym, premissas: { bonusNovo: BONUS_NOVO, posMeta: POS_META, bonusPos: BONUS_POS, bonusMeta: BONUS_META, pedidoMin: PEDIDO_MIN }, sellers, totais };
}

export async function listNovos(seller: string, ym: string = CAMPAIGN_YM): Promise<any[]> {
  await ensureCampaignTable();
  const s = seller.replace(/'/g, "''");
  const rows = await rawq(
    "SELECT customer_name, region, order_value, first_order_date::text AS first_order_date, status" +
    " FROM campaign_new_clients WHERE campaign_ym = '" + ym + "' AND seller_name = '" + s + "' AND status = 'aprovado'" +
    " ORDER BY first_order_date NULLS LAST, customer_name"
  );
  return rows.map((r) => ({ cliente: r.customer_name, regiao: r.region, pedido: Number(r.order_value) || 0, data: r.first_order_date || "", status: r.status }));
}

export async function inboxPendentes(ym: string = CAMPAIGN_YM): Promise<any[]> {
  await ensureCampaignTable();
  const rows = await rawq(
    "SELECT id, customer_name, seller_name, region, order_value, first_order_date::text AS first_order_date, status, justification" +
    " FROM campaign_new_clients WHERE campaign_ym = '" + ym + "' ORDER BY (status='pendente') DESC, first_order_date DESC NULLS LAST"
  );
  return rows.map((r) => ({ id: String(r.id), cliente: r.customer_name, vendedor: r.seller_name, regiao: r.region, pedido: Number(r.order_value) || 0, data: r.first_order_date || "", status: r.status, justificativa: r.justification || "" }));
}

export async function decidir(id: string, acao: "aprovar" | "rejeitar", justificativa: string, adminName: string): Promise<boolean> {
  await ensureCampaignTable();
  const status = acao === "aprovar" ? "aprovado" : "rejeitado";
  const idE = String(id).replace(/[^a-zA-Z0-9-]/g, "");
  if (!idE) return false;
  const jE = String(justificativa || "").slice(0, 2000).replace(/'/g, "''");
  const aE = String(adminName || "").slice(0, 200).replace(/'/g, "''");
  await db.execute(sql.raw(
    "UPDATE campaign_new_clients SET status = '" + status + "', justification = '" + jE + "', decided_by = '" + aE + "', decided_at = now() WHERE id = '" + idE + "'"
  ));
  return true;
}

// Avisos (replica) para a rota do dia do vendedor: cadastros ja decididos.
export async function rotaAvisos(seller: string, ym: string = CAMPAIGN_YM): Promise<any[]> {
  await ensureCampaignTable();
  const s = seller.replace(/'/g, "''");
  const rows = await rawq(
    "SELECT customer_name, status, justification, decided_at::text AS decided_at" +
    " FROM campaign_new_clients WHERE campaign_ym = '" + ym + "' AND seller_name = '" + s + "' AND status IN ('aprovado','rejeitado')" +
    " ORDER BY decided_at DESC NULLS LAST"
  );
  return rows.map((r) => ({ cliente: r.customer_name, status: r.status, justificativa: r.justification || "", quando: r.decided_at || "" }));
}

// Resolve papel + nome do vendedor logado (admin -> name="", role="admin").
async function resolveUser(req: any): Promise<{ role: string; name: string }> {
  try {
    const s: any = (req && req.session) || {};
    let uid: any = s.userId || (s.user && s.user.claims && s.user.claims.sub) || null;
    let umail: any = s.userEmail || (s.user && s.user.claims && s.user.claims.email) || null;
    let row: any = null;
    const SID = uid ? String(uid).replace(/[^a-zA-Z0-9_-]/g, "") : "";
    if (SID) { const r = await rawq("SELECT COALESCE(role::text,'') AS role, NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS nome, is_active FROM users WHERE id='" + SID + "' LIMIT 1"); row = r[0]; }
    if ((!row) && umail) { const M = String(umail).replace(/[']/g, ""); const r = await rawq("SELECT COALESCE(role::text,'') AS role, NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS nome, is_active FROM users WHERE lower(email)=lower('" + M + "') LIMIT 1"); row = r[0]; }
    if (!row || row.is_active === false) return { role: "", name: "" };
    let role = String(row.role || "");
    const impU = s.impersonateUserId;
    if (impU && role === "admin") { const SID2 = String(impU).replace(/[^a-zA-Z0-9_-]/g, ""); if (SID2) { const r2 = await rawq("SELECT COALESCE(role::text,'') AS role, NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS nome, is_active FROM users WHERE id='" + SID2 + "' LIMIT 1"); if (r2[0] && r2[0].is_active !== false) { role = String(r2[0].role || ""); row = r2[0]; } } }
    const imp = s.impersonateRole;
    if (imp && role === "admin") role = String(imp);
    return { role, name: role === "admin" ? "" : String(row.nome || "") };
  } catch (e) { return { role: "", name: "" }; }
}

export function registerCampanhaRoutes(app: Express): void {
  ensureCampaignTable().catch(() => {});

  // Metricas da campanha (escopo por papel). Detecta novos sob demanda no mes vigente.
  app.get("/api/campanha/outubro", async (req, res) => {
    try {
      const { role, name } = await resolveUser(req);
      if (!role) return res.status(401).json({ error: "unauthorized" });
      if (role !== "admin" && !name) return res.json({ asOf: "", ym: CAMPAIGN_YM, premissas: {}, sellers: [], totais: null, ativo: campaignActive() });
      if (campaignActive()) { try { await detectNovos(CAMPAIGN_YM); } catch (e) {} }
      const r = await computeCampaign(role === "admin" ? undefined : name);
      res.json({ ...r, ativo: campaignActive() });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });

  // Lista de novos clientes aptos de um vendedor (link na contagem de novos).
  app.get("/api/campanha/outubro/novos", async (req, res) => {
    try {
      const { role, name } = await resolveUser(req);
      if (!role) return res.status(401).json({ error: "unauthorized" });
      let seller = String((req.query as any).seller || "");
      if (role !== "admin") seller = name; // vendedor so ve o seu
      if (!seller) return res.json({ sellers: [], rows: [] });
      const rows = await listNovos(seller);
      res.json({ seller, rows });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });

  // Inbox de pendentes (somente admin, so no mes da campanha).
  app.get("/api/campanha/outubro/inbox", async (req, res) => {
    try {
      const { role } = await resolveUser(req);
      if (role !== "admin") return res.status(403).json({ error: "forbidden" });
      if (campaignActive()) { try { await detectNovos(CAMPAIGN_YM); } catch (e) {} }
      const rows = await inboxPendentes();
      res.json({ ativo: campaignActive(), rows });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });

  // Aprovar/rejeitar um cadastro (somente admin).
  app.post("/api/campanha/outubro/decidir", async (req, res) => {
    try {
      const { role, name } = await resolveUser(req);
      if (role !== "admin") return res.status(403).json({ error: "forbidden" });
      const b = (req.body || {}) as any;
      const id = String(b.id || "");
      const acao = String(b.acao || "") === "aprovar" ? "aprovar" : "rejeitar";
      const just = String(b.justificativa || "");
      if (!id) return res.status(400).json({ error: "id obrigatorio" });
      if (acao === "rejeitar" && !just.trim()) return res.status(400).json({ error: "justificativa obrigatoria para rejeitar" });
      await decidir(id, acao as any, just, name || "Admin");
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });

  // Avisos (replica) para a rota do dia do vendedor logado.
  app.get("/api/campanha/outubro/rota-avisos", async (req, res) => {
    try {
      const { role, name } = await resolveUser(req);
      if (!role) return res.status(401).json({ error: "unauthorized" });
      let seller = name;
      if (role === "admin") seller = String((req.query as any).seller || "");
      if (!seller) return res.json({ rows: [] });
      const rows = await rotaAvisos(seller);
      res.json({ rows });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });
}
