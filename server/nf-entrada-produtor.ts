// ============================================================================
// NF-e DE ENTRADA PRÓPRIA — COMPRA DE INSUMOS DE FORNECEDOR SEM NOTA (out/2026)
//
// Pedido do Flavio (04/out/2026): comprar frutas (e outros insumos) de quem NÃO
// emite nota — produtor rural pessoa física, feirante, sitiante. Nesses casos é
// o ADQUIRENTE (a Honest) que emite a NF-e de ENTRADA (tpNF=0), com o fornecedor
// como remetente no grupo <dest>. A nota autorizada vira, sozinha, uma NF de
// compra na aba Compras (purchase_invoices), já classificada como compra de
// estoque, e de lá segue o fluxo de sempre: conta a pagar → "Dar entrada —
// Matéria-Prima" (raw_materials / raw_material_movements).
//
// Peças:
//   • 2 cenários fiscais semeados no boot (operation_type 'compra_produtor'):
//       CFOP 1101 (mesma UF) / 2101 (outra UF) — "COMPRA PARA INDUSTRIALIZACAO",
//       CSOSN 900 (emitente no Simples Nacional), PIS/COFINS CST 98.
//     Editáveis em Notas Fiscais > Cenários fiscais (o contador pode ajustar).
//   • raw_materials.ncm (NCM do insumo, vai no item da nota) — frutas in natura
//     já nascem preenchidas; suppliers.city_code (código IBGE do município do
//     remetente); fiscal_invoices.customer_city_code (vai no cMun do <enderDest>).
//   • nf_entrada_produtor: elo NF-e (fiscal_invoices) ⇄ compra (purchase_invoices)
//     + o mapeamento item → matéria-prima, que pré-preenche a tela de entrada.
//   • system_settings 'nf_entrada_produtor_obs': texto padrão das informações
//     complementares (infCpl) da nota.
//
// Segurança: só emite pelas instâncias da PURO INDÚSTRIA em GO (IND e GYN — CRT 1).
// Nota em HOMOLOGAÇÃO (modo teste) nunca vira compra.
// ============================================================================
import { type Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql, eq } from "drizzle-orm";
import { purchaseInvoices } from "@shared/schema";
import { storage } from "./storage";
import { agora } from "@shared/tempo";
import { isValidFiscalDoc } from "./fiscal-doc";
import { normalizeUf, ufFromCep } from "./cep-uf";

const ROLES = ["admin", "coordinator", "administrative"];
export const OP_COMPRA_PRODUTOR = "compra_produtor";
const INSTANCIAS_PERMITIDAS = ["IND", "GYN"];
const CONTA_PADRAO_CODIGO = "2.01"; // Matéria-prima (frutas/polpas)
const OBS_PADRAO =
  "NF-e de entrada emitida pelo adquirente referente a aquisicao de mercadoria de pessoa nao obrigada a emissao de documento fiscal (produtor rural / pessoa fisica).";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : Array.isArray(r) ? r : []);
const dig = (v: any) => (v == null ? "" : String(v)).replace(/\D/g, "");
const semAcento = (s: string) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
const usuario = (req: any) => req.currentUser?.email || req.currentUser?.id || req.user?.email || null;

// NCM das frutas in natura (TIPI cap. 08). Só preenche matéria-prima que ainda
// não tem NCM e cujo NOME é exatamente a fruta (polpa/concentrado ficam de fora).
const NCM_FRUTA: Record<string, string> = {
  ACEROLA: "08109000", MARACUJA: "08109000", CAJU: "08109000",
  AMORA: "08102000", FRAMBOESA: "08102000",
  MIRTILO: "08104000",
  MORANGO: "08101000",
  LIMAO: "08055000",
  UVA: "08061000",
  ABACAXI: "08043000",
  GOIABA: "08045010",
  MANGA: "08045020",
};

function unidadeNf(u: any): string {
  const s = semAcento(String(u || ""));
  if (!s) return "KG";
  if (s === "KG" || s.startsWith("QUILO")) return "KG";
  if (s === "G" || s.startsWith("GRAMA")) return "G";
  if (s === "L" || s.startsWith("LITRO")) return "L";
  if (s === "ML") return "ML";
  if (s.startsWith("UN")) return "UN";
  if (s.startsWith("CX") || s.startsWith("CAIXA")) return "CX";
  if (s.startsWith("DZ") || s.startsWith("DUZIA")) return "DZ";
  return s.slice(0, 6);
}

let __ensured: Promise<void> | null = null;
export function ensureNfEntradaProdutor(): Promise<void> {
  if (!__ensured) __ensured = (async () => {
    const stmts = [
      `ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS customer_city_code varchar`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS city_code varchar`,
      `ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS ncm varchar`,
      `CREATE TABLE IF NOT EXISTS nf_entrada_produtor (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        fiscal_invoice_id varchar NOT NULL UNIQUE,
        purchase_invoice_id varchar,
        supplier_id varchar,
        instance_id varchar,
        chart_account_id varchar,
        items jsonb DEFAULT '[]'::jsonb,
        status varchar NOT NULL DEFAULT 'draft',
        last_error text,
        created_by varchar,
        created_at timestamp DEFAULT NOW(),
        updated_at timestamp DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_nf_entrada_produtor_purchase ON nf_entrada_produtor (purchase_invoice_id)`,
    ];
    for (const s of stmts) {
      try { await db.execute(sql.raw(s)); } catch (e: any) { console.warn("[NF-ENTRADA] migração (ignorada):", e?.message); }
    }

    // Cenários fiscais — idempotente por (operation_type, state_scope).
    const cenarios = [
      { name: "Compra de Insumo - Produtor Rural Dentro do Estado", scope: "dentro_estado", cfop: "1101" },
      { name: "Compra de Insumo - Produtor Rural Fora do Estado", scope: "fora_estado", cfop: "2101" },
    ];
    for (const c of cenarios) {
      try {
        const ex = rowsOf(await db.execute(sql`SELECT id FROM fiscal_scenarios WHERE operation_type = ${OP_COMPRA_PRODUTOR} AND state_scope = ${c.scope} LIMIT 1`));
        if (!ex[0]) {
          await db.execute(sql`INSERT INTO fiscal_scenarios
            (id, name, operation_type, state_scope, cfop, nature_of_operation, tax_regime, csosn, cst_pis, aliq_pis, cst_cofins, aliq_cofins, description, is_active, created_at, updated_at)
            VALUES (gen_random_uuid(), ${c.name}, ${OP_COMPRA_PRODUTOR}, ${c.scope}, ${c.cfop}, 'COMPRA PARA INDUSTRIALIZACAO',
              'simples_nacional', '900', '98', 0, '98', 0,
              'NF-e de entrada propria: compra de insumos (frutas etc.) de fornecedor sem nota (produtor rural PF). Emitente Simples Nacional.',
              true, NOW(), NOW())`);
          console.log(`✅ [NF-ENTRADA] Cenário fiscal criado: ${c.name} (CFOP ${c.cfop})`);
        }
      } catch (e: any) { console.warn("[NF-ENTRADA] seed cenário (ignorado):", e?.message); }
    }

    // Texto padrão das informações complementares.
    try {
      await db.execute(sql`INSERT INTO system_settings (key, value, description, updated_by, updated_at)
        VALUES ('nf_entrada_produtor_obs', ${OBS_PADRAO}, 'Informacoes complementares padrao da NF-e de entrada propria (compra de fornecedor sem nota)', 'nf-entrada-produtor', NOW())
        ON CONFLICT (key) DO NOTHING`);
    } catch (e: any) { console.warn("[NF-ENTRADA] seed setting (ignorado):", e?.message); }

    // NCM das frutas in natura já cadastradas como matéria-prima.
    try {
      const mps = rowsOf(await db.execute(sql`SELECT id, name FROM raw_materials WHERE ncm IS NULL OR ncm = ''`));
      for (const m of mps) {
        const ncm = NCM_FRUTA[semAcento(m.name)];
        if (ncm) await db.execute(sql`UPDATE raw_materials SET ncm = ${ncm} WHERE id = ${m.id} AND (ncm IS NULL OR ncm = '')`);
      }
    } catch (e: any) { console.warn("[NF-ENTRADA] seed NCM (ignorado):", e?.message); }
  })();
  return __ensured;
}

async function getSetting(key: string): Promise<string | null> {
  try {
    const r = rowsOf(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`));
    const v = r[0]?.value;
    return v == null ? null : String(v).replace(/^"|"$/g, "");
  } catch { return null; }
}

async function instanciasPermitidas() {
  const { INSTANCE_COMPANY_DATA } = await import("./nfe-routes");
  const insts = rowsOf(await db.execute(sql`SELECT id, name, display_name FROM omie_instances WHERE is_active = true`));
  const out: any[] = [];
  for (const i of insts) {
    if (!INSTANCIAS_PERMITIDAS.includes(i.name)) continue;
    const cd: any = (INSTANCE_COMPANY_DATA as any)[i.name];
    if (!cd || cd.crt !== "1") continue;
    const env = (await getSetting("fiscal_env_" + i.id)) === "producao" ? "producao" : "homologacao";
    out.push({ id: i.id, name: i.name, label: i.display_name || i.name, cnpj: cd.cnpj, uf: cd.uf, city: cd.city, ambiente: env, company: cd });
  }
  // IND (fábrica) primeiro: é onde a fruta chega.
  return out.sort((a, b) => (a.name === "IND" ? -1 : b.name === "IND" ? 1 : 0));
}

async function carregarFornecedor(id: string) {
  const r = rowsOf(await db.execute(sql`SELECT id, name, company_name, cnpj, cpf, state_registration, email, phone,
      address, address_number, address_complement, neighborhood, city, city_code, state, zip_code,
      default_chart_account_id, is_active
    FROM suppliers WHERE id = ${id} LIMIT 1`));
  return r[0] || null;
}

// Confere se o cadastro do fornecedor tem o mínimo que a SEFAZ exige do remetente.
function pendenciasFornecedor(s: any): string[] {
  const p: string[] = [];
  if (!s) return ["fornecedor não encontrado"];
  const doc = dig(s.cpf) || dig(s.cnpj);
  if (!doc) p.push("CPF/CNPJ");
  else if (!isValidFiscalDoc(doc)) p.push("CPF/CNPJ inválido (dígito verificador)");
  if (!normalizeUf(s.state) && !ufFromCep(s.zip_code)) p.push("UF");
  if (!String(s.city || "").trim()) p.push("município");
  if (!String(s.address || "").trim()) p.push("endereço (logradouro)");
  return p;
}

// Campos <dest> da NF-e a partir do cadastro do fornecedor (remetente).
function destDoFornecedor(s: any) {
  const uf = normalizeUf(s.state) || ufFromCep(s.zip_code) || "";
  const doc = dig(s.cpf) || dig(s.cnpj);
  const nro = String(s.address_number || "").trim();
  const endereco = [String(s.address || "").trim(), nro && !/^s\/?n$/i.test(nro) ? nro : "", s.address_complement ? String(s.address_complement).trim() : ""]
    .filter(Boolean).join(", ");
  return {
    customerId: null as any,
    customerName: String(s.company_name || s.name || "").trim(),
    customerCnpjCpf: doc,
    customerIe: dig(s.state_registration) ? String(s.state_registration).trim() : "",
    customerAddress: endereco,
    customerBairro: String(s.neighborhood || "").trim(),
    customerCep: dig(s.zip_code),
    customerCity: String(s.city || "").trim(),
    customerCityCode: dig(s.city_code).length === 7 ? dig(s.city_code) : null,
    customerUf: uf,
    customerPhone: dig(s.phone),
  };
}

async function cenarioPara(issuerUf: string, destUf: string) {
  const scope = (issuerUf || "GO").toUpperCase() === (destUf || "").toUpperCase() ? "dentro_estado" : "fora_estado";
  const r = rowsOf(await db.execute(sql`SELECT * FROM fiscal_scenarios
    WHERE operation_type = ${OP_COMPRA_PRODUTOR} AND state_scope = ${scope} AND is_active IS NOT FALSE
    ORDER BY created_at ASC LIMIT 1`));
  return r[0] || null;
}

// ─── Nota autorizada → NF de compra na aba Compras (idempotente) ─────────────
export async function sincronizarCompraDaNfEntrada(fiscalInvoiceId: string, by: string | null = null): Promise<{ ok: boolean; purchaseId?: string; motivo?: string }> {
  try {
    await ensureNfEntradaProdutor();
    const link = rowsOf(await db.execute(sql`SELECT * FROM nf_entrada_produtor WHERE fiscal_invoice_id = ${fiscalInvoiceId} LIMIT 1`))[0];
    if (!link) return { ok: false, motivo: "nao-e-nf-de-entrada-propria" };
    const inv: any = await storage.getFiscalInvoice(fiscalInvoiceId);
    if (!inv) return { ok: false, motivo: "nf-nao-encontrada" };
    await db.execute(sql`UPDATE nf_entrada_produtor SET status = ${inv.status}, updated_at = NOW() WHERE id = ${link.id}`);
    if (inv.status !== "authorized") return { ok: false, motivo: `nf-${inv.status}` };
    if (String(inv.environment) === "homologacao") return { ok: false, motivo: "homologacao" };
    if (link.purchase_invoice_id) return { ok: true, purchaseId: link.purchase_invoice_id };

    const accessKey = dig(inv.accessKey).slice(0, 44) || null;
    if (accessKey) {
      const [ex] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.accessKey, accessKey));
      if (ex) {
        await db.execute(sql`UPDATE nf_entrada_produtor SET purchase_invoice_id = ${ex.id}, updated_at = NOW() WHERE id = ${link.id}`);
        return { ok: true, purchaseId: ex.id };
      }
    }

    const fItems = await storage.getFiscalInvoiceItems(fiscalInvoiceId);
    const mapa: any[] = Array.isArray(link.items) ? link.items : [];
    const items = fItems.map((it: any, idx: number) => ({
      nItem: String(it.itemNumber || idx + 1),
      cProd: it.productCode || "",
      xProd: it.productName || "",
      NCM: it.ncm || "",
      CFOP: it.cfop || inv.cfop || "",
      uCom: it.unit || "KG",
      qCom: String(it.quantity),
      vUnCom: String(it.unitPrice),
      vProd: String(it.totalPrice),
      // Pré-preenche "Dar entrada — Matéria-Prima" na aba Compras.
      rawMaterialId: mapa[idx]?.rawMaterialId || null,
    }));
    const total = String(inv.totalInvoice || inv.totalProducts || "0");
    const chartAccountId = link.chart_account_id || null;
    const sup = link.supplier_id ? await carregarFornecedor(link.supplier_id) : null;
    const nota = `NF-e de ENTRADA PRÓPRIA nº ${inv.invoiceNumber} emitida pela Honest (fornecedor sem nota${sup?.name ? `: ${sup.name}` : ""}). Gerada automaticamente na autorização.`;

    const [compra] = await db.insert(purchaseInvoices).values({
      accessKey,
      invoiceNumber: String(inv.invoiceNumber || ""),
      series: String(inv.series || "1"),
      issueDate: inv.emissionDate ? new Date(inv.emissionDate) : agora(),
      supplierName: inv.customerName || sup?.name || "(fornecedor)",
      supplierDocument: dig(inv.customerCnpjCpf),
      supplierIe: inv.customerIe || null,
      totalValue: total,
      items,
      taxes: { vBC: "0.00", vICMS: "0.00", vICMSST: "0.00", vPIS: "0.00", vCOFINS: "0.00", vIPI: "0.00", vFrete: "0.00", vSeg: "0.00", vDesc: "0.00", vOutro: "0.00", vNF: total },
      status: chartAccountId ? "classified" : "imported",
      xmlContent: inv.xmlAutorizacao || inv.xmlEnvio || null,
      omieInstanceId: inv.omieInstanceId || link.instance_id || null,
      chartAccountId,
      isStockPurchase: true,
      stockProcessed: false,
      cfop: (fItems[0] as any)?.cfop || inv.cfop || null,
      natureOfOperation: inv.natureOfOperation || null,
      notes: nota,
      detectedAt: agora(),
      importedAt: agora(),
      classifiedAt: chartAccountId ? agora() : null,
      createdBy: by || link.created_by || "nf-entrada-produtor",
    } as any).returning();

    await db.execute(sql`UPDATE nf_entrada_produtor SET purchase_invoice_id = ${compra.id}, status = 'authorized', last_error = NULL, updated_at = NOW() WHERE id = ${link.id}`);
    try {
      await storage.createFiscalInvoiceEvent({
        invoiceId: fiscalInvoiceId, eventType: "compra", status: "success",
        description: `NF de compra criada na aba Compras (id ${compra.id}) para dar entrada no estoque de matéria-prima.`,
      } as any);
    } catch { /* evento é cosmético */ }
    console.log(`🧺 [NF-ENTRADA] NF ${inv.invoiceNumber} autorizada → compra ${compra.id} criada (${items.length} item(ns), R$ ${total}).`);
    return { ok: true, purchaseId: compra.id };
  } catch (e: any) {
    console.error("[NF-ENTRADA] sincronizar compra:", e?.message || e);
    try { await db.execute(sql`UPDATE nf_entrada_produtor SET last_error = ${String(e?.message || e).slice(0, 500)}, updated_at = NOW() WHERE fiscal_invoice_id = ${fiscalInvoiceId}`); } catch {}
    return { ok: false, motivo: e?.message || String(e) };
  }
}

// ─── NF-e de entrada CANCELADA → compra cancelada (se ainda não entrou estoque) ─
export async function aoCancelarNfEntrada(fiscalInvoiceId: string, motivo: string, by: string | null): Promise<string | null> {
  try {
    const link = rowsOf(await db.execute(sql`SELECT * FROM nf_entrada_produtor WHERE fiscal_invoice_id = ${fiscalInvoiceId} LIMIT 1`))[0];
    if (!link) return null;
    await db.execute(sql`UPDATE nf_entrada_produtor SET status = 'cancelled', updated_at = NOW() WHERE id = ${link.id}`);
    if (!link.purchase_invoice_id) return null;
    const [compra] = await db.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, link.purchase_invoice_id));
    if (!compra) return null;
    const carimbo = `[${agora().toLocaleString("pt-BR")}] NF-e de entrada cancelada na SEFAZ por ${by || "usuário"}${motivo ? ` — ${motivo}` : ""}.`;
    if (compra.stockProcessed || compra.payableId) {
      const aviso = `${carimbo} ATENÇÃO: a compra já tem ${compra.stockProcessed ? "entrada de estoque" : ""}${compra.stockProcessed && compra.payableId ? " e " : ""}${compra.payableId ? "conta a pagar" : ""} — estorne/cancele manualmente antes de cancelar a compra.`;
      await db.update(purchaseInvoices).set({ notes: compra.notes ? `${compra.notes}\n${aviso}` : aviso, updatedAt: agora() }).where(eq(purchaseInvoices.id, compra.id));
      return aviso;
    }
    await db.update(purchaseInvoices).set({ status: "cancelled", notes: compra.notes ? `${compra.notes}\n${carimbo}` : carimbo, updatedAt: agora() }).where(eq(purchaseInvoices.id, compra.id));
    return null;
  } catch (e: any) {
    console.warn("[NF-ENTRADA] cancelamento → compra:", e?.message || e);
    return null;
  }
}

async function emitirESincronizar(fiscalInvoiceId: string, by: string | null) {
  const { sefazService } = await import("./sefaz-service");
  const result: any = await sefazService.emitNfe(fiscalInvoiceId);
  const inv: any = await storage.getFiscalInvoice(fiscalInvoiceId);
  let compra: any = null;
  if (result?.success) {
    compra = await sincronizarCompraDaNfEntrada(fiscalInvoiceId, by);
  } else {
    try {
      await db.execute(sql`UPDATE nf_entrada_produtor SET status = ${inv?.status || "rejected"},
        last_error = ${String(result?.errorMessage || "Falha na emissão").slice(0, 500)}, updated_at = NOW()
        WHERE fiscal_invoice_id = ${fiscalInvoiceId}`);
    } catch {}
  }
  return { result, invoice: inv, compra };
}

export function registerNfEntradaProdutorRoutes(app: Express) {
  ensureNfEntradaProdutor();

  // Tudo o que a tela precisa para montar a nota.
  app.get("/api/nf-entrada-produtor/contexto", authenticateUser, requireRole(ROLES), async (_req: any, res) => {
    try {
      await ensureNfEntradaProdutor();
      const instancias = (await instanciasPermitidas()).map(({ company, ...i }) => i);
      const cenarios = rowsOf(await db.execute(sql`SELECT id, name, state_scope, cfop, nature_of_operation, csosn, cst_pis, cst_cofins, is_active
        FROM fiscal_scenarios WHERE operation_type = ${OP_COMPRA_PRODUTOR} ORDER BY state_scope`));
      const materias = rowsOf(await db.execute(sql`SELECT id, name, code, category, unit, unit_cost, ncm, quantity
        FROM raw_materials WHERE is_active IS NOT FALSE ORDER BY name`));
      const conta = rowsOf(await db.execute(sql`SELECT id, code, name FROM chart_of_accounts WHERE code = ${CONTA_PADRAO_CODIGO} LIMIT 1`))[0] || null;
      const observacao = (await getSetting("nf_entrada_produtor_obs")) || OBS_PADRAO;
      res.json({ instancias, cenarios, materias, contaPadrao: conta, observacao });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Fornecedores com o cadastro COMPLETO (endereço) — o /api/suppliers não traz.
  app.get("/api/nf-entrada-produtor/fornecedores", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    try {
      await ensureNfEntradaProdutor();
      const search = String(req.query.search || "").trim();
      const like = `%${search}%`;
      const d = dig(search);
      const r = rowsOf(await db.execute(sql`SELECT id, name, company_name, cnpj, cpf, state_registration, email, phone,
          address, address_number, address_complement, neighborhood, city, city_code, state, zip_code, default_chart_account_id
        FROM suppliers
        WHERE is_active IS NOT FALSE
          AND (${search} = '' OR name ILIKE ${like} OR company_name ILIKE ${like}
               OR (${d} <> '' AND (regexp_replace(COALESCE(cpf,''),'\\D','','g') LIKE ${"%" + d + "%"}
                                OR regexp_replace(COALESCE(cnpj,''),'\\D','','g') LIKE ${"%" + d + "%"})))
        ORDER BY name LIMIT 50`));
      res.json(r.map((s: any) => ({ ...s, pendencias: pendenciasFornecedor(s) })));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Cria ou atualiza o cadastro do produtor/fornecedor com endereço fiscal.
  app.post("/api/nf-entrada-produtor/fornecedores", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    try {
      await ensureNfEntradaProdutor();
      const b = req.body || {};
      const name = String(b.name || "").trim();
      if (!name) return res.status(400).json({ error: "Nome do fornecedor obrigatório" });
      const doc = dig(b.document || b.cpf || b.cnpj);
      if (!doc || !isValidFiscalDoc(doc)) return res.status(400).json({ error: "CPF/CNPJ inválido — confira os dígitos." });
      const cpf = doc.length === 11 ? doc : null;
      const cnpj = doc.length === 14 ? doc : null;
      const uf = normalizeUf(b.state) || ufFromCep(b.zipCode);
      if (!uf) return res.status(400).json({ error: "Informe a UF (ou um CEP válido)." });
      const v = {
        companyName: String(b.companyName || "").trim() || null,
        ie: String(b.stateRegistration || "").trim() || null,
        email: String(b.email || "").trim() || null,
        phone: dig(b.phone) || null,
        address: String(b.address || "").trim() || null,
        number: String(b.addressNumber || "").trim() || null,
        compl: String(b.addressComplement || "").trim() || null,
        bairro: String(b.neighborhood || "").trim() || null,
        city: String(b.city || "").trim() || null,
        cityCode: dig(b.cityCode).length === 7 ? dig(b.cityCode) : null,
        cep: dig(b.zipCode) || null,
      };

      let id: string | null = b.id ? String(b.id) : null;
      if (!id) {
        const ex = rowsOf(await db.execute(sql`SELECT id FROM suppliers
          WHERE regexp_replace(COALESCE(cpf,''),'\\D','','g') = ${doc} OR regexp_replace(COALESCE(cnpj,''),'\\D','','g') = ${doc} LIMIT 1`));
        id = ex[0]?.id || null;
      }
      if (id) {
        await db.execute(sql`UPDATE suppliers SET
            name = ${name}, company_name = ${v.companyName}, cpf = ${cpf}, cnpj = ${cnpj},
            state_registration = ${v.ie}, email = COALESCE(${v.email}, email), phone = COALESCE(${v.phone}, phone),
            address = ${v.address}, address_number = ${v.number}, address_complement = ${v.compl},
            neighborhood = ${v.bairro}, city = ${v.city}, city_code = ${v.cityCode}, state = ${uf}, zip_code = ${v.cep},
            is_active = true, updated_at = NOW()
          WHERE id = ${id}`);
      } else {
        const r = rowsOf(await db.execute(sql`INSERT INTO suppliers (id, name, company_name, cnpj, cpf, state_registration, email, phone,
            address, address_number, address_complement, neighborhood, city, city_code, state, zip_code,
            default_category, notes, is_active, created_at, updated_at)
          VALUES (gen_random_uuid(), ${name}, ${v.companyName}, ${cnpj}, ${cpf}, ${v.ie}, ${v.email}, ${v.phone},
            ${v.address}, ${v.number}, ${v.compl}, ${v.bairro}, ${v.city}, ${v.cityCode}, ${uf}, ${v.cep},
            'Produtor rural / fornecedor sem nota', 'Cadastrado pela NF-e de entrada propria', true, NOW(), NOW())
          RETURNING id`));
        id = r[0].id;
      }
      const s = await carregarFornecedor(id!);
      res.json({ ...s, pendencias: pendenciasFornecedor(s) });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Últimas notas de entrada próprias (com o elo para a compra).
  app.get("/api/nf-entrada-produtor", authenticateUser, requireRole(ROLES), async (_req: any, res) => {
    try {
      await ensureNfEntradaProdutor();
      const r = rowsOf(await db.execute(sql`SELECT l.id AS link_id, l.fiscal_invoice_id, l.purchase_invoice_id, l.last_error, l.status AS link_status,
          f.invoice_number, f.series, f.status, f.environment, f.access_key, f.customer_name, f.customer_cnpj_cpf,
          f.total_invoice, f.cfop, f.emission_date, f.authorization_date, f.created_at, f.omie_instance_id,
          p.status AS purchase_status, p.stock_processed, p.payable_id
        FROM nf_entrada_produtor l
        JOIN fiscal_invoices f ON f.id = l.fiscal_invoice_id
        LEFT JOIN purchase_invoices p ON p.id = l.purchase_invoice_id
        ORDER BY f.created_at DESC LIMIT 100`));
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Cria a NF-e de entrada e (por padrão) transmite na hora.
  app.post("/api/nf-entrada-produtor", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    try {
      await ensureNfEntradaProdutor();
      const b = req.body || {};
      const by = usuario(req);

      const insts = await instanciasPermitidas();
      const inst = insts.find((i) => i.id === b.instanceId) || insts[0];
      if (!inst) return res.status(400).json({ error: "Nenhuma instância emitente habilitada (IND/GYN)." });
      const cd = inst.company;

      const sup = b.supplierId ? await carregarFornecedor(String(b.supplierId)) : null;
      const pend = pendenciasFornecedor(sup);
      if (pend.length) return res.status(400).json({ error: `Cadastro do fornecedor incompleto: ${pend.join(", ")}.` });
      const dest = destDoFornecedor(sup);
      if (dest.customerCnpjCpf === dig(cd.cnpj)) return res.status(400).json({ error: "O fornecedor não pode ser a própria empresa emitente." });

      const cen = await cenarioPara(cd.uf, dest.customerUf);
      if (!cen) return res.status(400).json({ error: "Cenário fiscal de compra de produtor não encontrado/ativo (Notas Fiscais > Cenários)." });
      const cfop = String(cen.cfop || "").replace(/\D/g, "");

      const brutos: any[] = Array.isArray(b.items) ? b.items : [];
      if (!brutos.length) return res.status(400).json({ error: "Inclua ao menos um item." });
      const mpIds = brutos.map((x) => String(x.rawMaterialId || "")).filter(Boolean);
      const mps = mpIds.length ? rowsOf(await db.execute(sql`SELECT id, name, code, unit, ncm FROM raw_materials WHERE id IN (${sql.join(mpIds.map((i) => sql`${i}`), sql`, `)})`)) : [];
      const itens: any[] = [];
      const erros: string[] = [];
      brutos.forEach((x, i) => {
        const mp = mps.find((m: any) => m.id === x.rawMaterialId);
        const nome = String(x.description || mp?.name || "").trim();
        const qtd = Math.round(Number(String(x.quantity).replace(",", ".")) * 10000) / 10000;
        const pu = Math.round(Number(String(x.unitPrice).replace(",", ".")) * 10000) / 10000;
        const ncm = dig(x.ncm || mp?.ncm);
        if (!mp) erros.push(`item ${i + 1}: escolha a matéria-prima`);
        if (!nome) erros.push(`item ${i + 1}: descrição`);
        if (!(qtd > 0)) erros.push(`item ${i + 1}: quantidade`);
        if (!(pu > 0)) erros.push(`item ${i + 1}: preço unitário`);
        if (ncm.length !== 8) erros.push(`item ${i + 1}: NCM com 8 dígitos`);
        const total = Math.round(qtd * pu * 100) / 100;
        itens.push({
          rawMaterialId: mp?.id || null, ncm, nome: nome.toUpperCase().slice(0, 120),
          codigo: String(mp?.code || "").trim() || `MP-${String(mp?.id || i + 1).slice(0, 8).toUpperCase()}`,
          unidade: unidadeNf(x.unit || mp?.unit), qtd, pu, total,
        });
      });
      if (erros.length) return res.status(400).json({ error: `Itens: ${erros.join("; ")}.` });

      const totalNota = Math.round(itens.reduce((s, it) => s + it.total, 0) * 100) / 100;
      const pagamentos = ["dinheiro", "pix", "transferencia", "a_prazo"];
      const paymentMethod = pagamentos.includes(String(b.paymentMethod)) ? String(b.paymentMethod) : "dinheiro";
      const ambiente = b.homologacao ? "homologacao" : inst.ambiente;

      const obs = (await getSetting("nf_entrada_produtor_obs")) || OBS_PADRAO;
      const remetente = `Remetente: ${dest.customerName} - ${dest.customerCnpjCpf.length === 11 ? "CPF" : "CNPJ"} ${dest.customerCnpjCpf}${dest.customerIe ? ` - IE ${dest.customerIe}` : ""}.`;
      const notes = [obs, remetente, String(b.notes || "").trim()].filter(Boolean).join(" ");

      // Conta do plano (DRE) que a compra vai usar: escolhida > padrão do fornecedor > 2.01.
      let chartAccountId: string | null = b.chartAccountId ? String(b.chartAccountId) : (sup.default_chart_account_id || null);
      if (!chartAccountId) {
        const c = rowsOf(await db.execute(sql`SELECT id FROM chart_of_accounts WHERE code = ${CONTA_PADRAO_CODIGO} LIMIT 1`))[0];
        chartAccountId = c?.id || null;
      }

      const invoice = await storage.createFiscalInvoiceAtomic({
        series: "1",
        status: "draft",
        operationType: "entrada",
        finNFe: "1",
        fiscalScenarioId: cen.id,
        omieInstanceId: inst.id,
        issuerName: cd.name, issuerCnpj: cd.cnpj, issuerIe: cd.ie, issuerAddress: cd.address,
        issuerUf: cd.uf, issuerCityCode: cd.cityCode, issuerCity: cd.city, issuerPhone: cd.phone,
        ...dest,
        natureOfOperation: cen.nature_of_operation || "COMPRA PARA INDUSTRIALIZACAO",
        cfop,
        totalProducts: totalNota.toFixed(2),
        totalDiscount: "0",
        totalInvoice: totalNota.toFixed(2),
        paymentMethod,
        notes,
        environment: ambiente,
        createdBy: req.currentUser?.id || null,
      } as any, "1", cd.cnpj);

      for (let i = 0; i < itens.length; i++) {
        const it = itens[i];
        await storage.createFiscalInvoiceItem({
          invoiceId: invoice.id, itemNumber: i + 1,
          productId: null, productCode: it.codigo, productName: it.nome,
          ncm: it.ncm, cfop, unit: it.unidade,
          quantity: it.qtd.toFixed(4), unitPrice: it.pu.toFixed(4), totalPrice: it.total.toFixed(2), discount: "0",
          csosn: cen.csosn || "900",
          cstPis: cen.cst_pis || "98", cstCofins: cen.cst_cofins || "98",
        } as any);
      }

      await db.execute(sql`INSERT INTO nf_entrada_produtor (id, fiscal_invoice_id, supplier_id, instance_id, chart_account_id, items, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${invoice.id}, ${sup.id}, ${inst.id}, ${chartAccountId},
          ${JSON.stringify(itens.map((it) => ({ rawMaterialId: it.rawMaterialId, ncm: it.ncm, unidade: it.unidade, qtd: it.qtd, pu: it.pu })))}::jsonb,
          'draft', ${by}, NOW(), NOW())`);

      // Guarda o NCM na matéria-prima para a próxima nota já vir preenchida.
      for (const it of itens) {
        if (it.rawMaterialId && it.ncm) {
          try { await db.execute(sql`UPDATE raw_materials SET ncm = ${it.ncm} WHERE id = ${it.rawMaterialId} AND (ncm IS NULL OR ncm = '')`); } catch {}
        }
      }

      await storage.createFiscalInvoiceEvent({
        invoiceId: invoice.id, eventType: "criacao", status: "success",
        description: `NF-e de ENTRADA própria #${invoice.invoiceNumber} criada (${ambiente}) — compra de ${dest.customerName}, CFOP ${cfop}, R$ ${totalNota.toFixed(2)}.`,
        createdBy: req.currentUser?.id || null,
      } as any);

      if (b.emitir === false) return res.status(201).json({ invoice, emitida: false });
      const out = await emitirESincronizar(invoice.id, by);
      res.status(out.result?.success ? 201 : 400).json({
        invoice: out.invoice, emitida: !!out.result?.success, sefaz: out.result,
        compra: out.compra, homologacao: ambiente === "homologacao",
      });
    } catch (e: any) {
      console.error("[NF-ENTRADA] criar:", e?.message || e);
      res.status(500).json({ error: e.message });
    }
  });

  // Retransmite (rascunho/rejeitada), relendo o cadastro do fornecedor antes.
  app.post("/api/nf-entrada-produtor/:fiscalId/emitir", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    try {
      await ensureNfEntradaProdutor();
      const link = rowsOf(await db.execute(sql`SELECT * FROM nf_entrada_produtor WHERE fiscal_invoice_id = ${req.params.fiscalId} LIMIT 1`))[0];
      if (!link) return res.status(404).json({ error: "NF de entrada própria não encontrada" });
      const inv: any = await storage.getFiscalInvoice(req.params.fiscalId);
      if (!inv) return res.status(404).json({ error: "NF-e não encontrada" });
      if (inv.status === "authorized") {
        const compra = await sincronizarCompraDaNfEntrada(inv.id, usuario(req));
        return res.json({ invoice: inv, emitida: true, compra });
      }
      if (inv.status !== "draft" && inv.status !== "rejected") return res.status(400).json({ error: `NF-e com status '${inv.status}' não pode ser transmitida` });
      if (link.supplier_id) {
        const sup = await carregarFornecedor(link.supplier_id);
        const pend = pendenciasFornecedor(sup);
        if (pend.length) return res.status(400).json({ error: `Cadastro do fornecedor incompleto: ${pend.join(", ")}.` });
        await storage.updateFiscalInvoice(inv.id, destDoFornecedor(sup) as any);
      }
      const out = await emitirESincronizar(inv.id, usuario(req));
      res.status(out.result?.success ? 200 : 400).json({ invoice: out.invoice, emitida: !!out.result?.success, sefaz: out.result, compra: out.compra });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Recria a compra de uma nota já autorizada (se algo falhou no caminho).
  app.post("/api/nf-entrada-produtor/:fiscalId/sincronizar", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    const out = await sincronizarCompraDaNfEntrada(req.params.fiscalId, usuario(req));
    res.status(out.ok ? 200 : 400).json(out);
  });

  // Descarta rascunho/rejeitada (nunca autorizada).
  app.delete("/api/nf-entrada-produtor/:fiscalId", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    try {
      const link = rowsOf(await db.execute(sql`SELECT id FROM nf_entrada_produtor WHERE fiscal_invoice_id = ${req.params.fiscalId} LIMIT 1`))[0];
      if (!link) return res.status(404).json({ error: "NF de entrada própria não encontrada" });
      const inv: any = await storage.getFiscalInvoice(req.params.fiscalId);
      if (inv && inv.status !== "draft" && inv.status !== "rejected") {
        return res.status(400).json({ error: "Só rascunho ou rejeitada pode ser descartada. Nota autorizada se cancela em Notas Fiscais." });
      }
      if (inv) await storage.deleteFiscalInvoice(inv.id);
      await db.execute(sql`DELETE FROM nf_entrada_produtor WHERE id = ${link.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
}
