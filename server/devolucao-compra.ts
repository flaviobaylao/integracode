// server/devolucao-compra.ts
// ============================================================================
// DEVOLUÇÃO DE COMPRA AO FORNECEDOR (Flavio, 04/out/2026)
// ----------------------------------------------------------------------------
// Caso que originou: rótulos comprados da ELLOPRINT (ELLOFLEX EMBALAGENS LTDA,
// Marialva/PR) devolvidos pela instância IND.
//
// Até aqui o Integra só sabia devolver VENDA (NF de ENTRADA, 1202/2202, a partir
// de uma NF que nós emitimos). Devolver COMPRA é o caminho inverso:
//   • NF-e de SAÍDA (tpNF=1) emitida pela instância que COMPROU, finNFe=4;
//   • destinatário = o FORNECEDOR (emitente da NF de entrada), lido do XML;
//   • cada item referencia a chave + nItem da NF de entrada (DFeReferenciado);
//   • CFOP pela finalidade da compra: industrialização 5201/6201, comercialização
//     5202/6202, uso e consumo 5556/6556, ativo 5553/6553 (com ST: 5410/6410,
//     5411/6411);
//   • Simples Nacional (IND/GYN/BSB): CSOSN 900 informando base e ICMS da NF de
//     origem, proporcionais (Res. CGSN 140/2018, art. 59) — fornecedor estorna o
//     débito; IPI destacado volta em impostoDevol/vIPIDevol;
//   • pagamento tPag=90 (sem pagamento): o acerto financeiro é feito aqui, no
//     Integra, abatendo as contas a pagar em aberto da compra.
//
// Depois que a SEFAZ AUTORIZA (e só então):
//   • sai do estoque de matéria-prima o que foi devolvido (raw_materials,
//     movimento 'saida'), na unidade do estoque (qtd da NF × fator);
//   • abate as contas a pagar da compra ainda em aberto (da última parcela para
//     a primeira). O que não couber (parcelas já pagas) fica registrado como
//     CRÉDITO COM O FORNECEDOR na devolução — e volta na resposta como aviso.
// Se a NF de devolução for CANCELADA, os dois efeitos são estornados.
//
// Tudo fica registrado em purchase_returns (uma linha por NF de devolução).
// ============================================================================
import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import * as xmlJs from "xml-js";
import { storage } from "./storage";
import { agora } from "@shared/tempo";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
const dig = (v: any) => String(v ?? "").replace(/\D/g, "");
const num = (v: any) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? 0 : n; };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

export const DEVCOMPRA_TAG = (id: string) => `[devcompra:${id}]`;

// ── Finalidade × CFOP ────────────────────────────────────────────────────────
export type FinalidadeCompra = "industrializacao" | "comercializacao" | "uso_consumo" | "ativo";
const FINALIDADES: Record<FinalidadeCompra, { sufixo: string; sufixoSt?: string; natureza: string; rotulo: string }> = {
  industrializacao: { sufixo: "201", sufixoSt: "410", natureza: "DEVOLUCAO DE COMPRA PARA INDUSTRIALIZACAO", rotulo: "Industrialização" },
  comercializacao:  { sufixo: "202", sufixoSt: "411", natureza: "DEVOLUCAO DE COMPRA PARA COMERCIALIZACAO", rotulo: "Comercialização" },
  uso_consumo:      { sufixo: "556", natureza: "DEVOLUCAO DE COMPRA DE MATERIAL DE USO OU CONSUMO", rotulo: "Uso e consumo" },
  ativo:            { sufixo: "553", natureza: "DEVOLUCAO DE COMPRA DE BEM DO ATIVO IMOBILIZADO", rotulo: "Ativo imobilizado" },
};
// CFOPs de SAÍDA do fornecedor que indicam mercadoria com ICMS-ST.
const CFOP_ORIGEM_ST = new Set(["5401", "5402", "5403", "5405", "6401", "6402", "6403", "6404"]);

export function cfopDevolucaoCompra(finalidade: FinalidadeCompra, cfopOrigem: string, interestadual: boolean): { cfop: string; natureza: string } {
  const f = FINALIDADES[finalidade] || FINALIDADES.industrializacao;
  const st = CFOP_ORIGEM_ST.has(dig(cfopOrigem)) && !!f.sufixoSt;
  const cfop = `${interestadual ? "6" : "5"}${st ? f.sufixoSt : f.sufixo}`;
  return { cfop, natureza: st ? `${f.natureza} COM ST` : f.natureza };
}

// ── Cenários fiscais (seed idempotente por operation_type + cfop) ────────────
const CENARIOS_SEED: Array<{ name: string; scope: string; cfop: string; natureza: string; descricao: string }> = [
  { name: "Devolução de Compra p/ Industrialização Dentro do Estado", scope: "interna", cfop: "5201", natureza: FINALIDADES.industrializacao.natureza, descricao: "Devolução ao fornecedor de insumo/embalagem comprado para industrialização (entrada 1101/1102 de produção) — ex.: rótulos, garrafas, tampas." },
  { name: "Devolução de Compra p/ Industrialização Fora do Estado", scope: "interestadual", cfop: "6201", natureza: FINALIDADES.industrializacao.natureza, descricao: "Devolução interestadual ao fornecedor de insumo/embalagem comprado para industrialização (entrada 2101) — ex.: rótulos ELLOPRINT (PR)." },
  { name: "Devolução de Compra p/ Comercialização Dentro do Estado", scope: "interna", cfop: "5202", natureza: FINALIDADES.comercializacao.natureza, descricao: "Devolução ao fornecedor de mercadoria comprada para revenda (entrada 1102)." },
  { name: "Devolução de Compra p/ Comercialização Fora do Estado", scope: "interestadual", cfop: "6202", natureza: FINALIDADES.comercializacao.natureza, descricao: "Devolução interestadual ao fornecedor de mercadoria comprada para revenda (entrada 2102)." },
  { name: "Devolução de Compra de Uso e Consumo Dentro do Estado", scope: "interna", cfop: "5556", natureza: FINALIDADES.uso_consumo.natureza, descricao: "Devolução ao fornecedor de material de uso e consumo (entrada 1556)." },
  { name: "Devolução de Compra de Uso e Consumo Fora do Estado", scope: "interestadual", cfop: "6556", natureza: FINALIDADES.uso_consumo.natureza, descricao: "Devolução interestadual ao fornecedor de material de uso e consumo (entrada 2556)." },
];

export async function garantirEstruturaDevolucaoCompra(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS purchase_returns (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        purchase_invoice_id varchar NOT NULL,
        fiscal_invoice_id varchar,
        omie_instance_id varchar,
        finalidade varchar NOT NULL DEFAULT 'industrializacao',
        cfop varchar,
        motivo text,
        itens jsonb NOT NULL DEFAULT '[]'::jsonb,
        valor_total numeric(12,2) NOT NULL DEFAULT 0,
        baixar_estoque boolean NOT NULL DEFAULT true,
        abater_financeiro boolean NOT NULL DEFAULT true,
        estoque_aplicado jsonb,
        financeiro_aplicado jsonb,
        credito_fornecedor numeric(12,2) NOT NULL DEFAULT 0,
        status varchar NOT NULL DEFAULT 'rascunho',
        created_by varchar,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_purchase_returns_purchase ON purchase_returns (purchase_invoice_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_purchase_returns_fiscal ON purchase_returns (fiscal_invoice_id)`);
    for (const c of CENARIOS_SEED) {
      const ja = rowsOf(await db.execute(sql`SELECT id FROM fiscal_scenarios WHERE operation_type = 'devolucao_compra' AND cfop = ${c.cfop} LIMIT 1`));
      if (ja.length) continue;
      await db.execute(sql`
        INSERT INTO fiscal_scenarios (id, name, operation_type, state_scope, cfop, nature_of_operation, tax_regime,
          csosn, cst_icms, cst_ipi, cst_pis, aliq_pis, cst_cofins, aliq_cofins, description, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${c.name}, 'devolucao_compra', ${c.scope}, ${c.cfop}, ${c.natureza}, 'simples_nacional',
          '900', NULL, NULL, '49', 0, '49', 0, ${c.descricao}, true, now(), now())`);
      console.log(`✅ [DEV-COMPRA] cenário fiscal criado: ${c.cfop} ${c.name}`);
    }
  } catch (e: any) {
    console.warn("⚠️ [DEV-COMPRA] estrutura não garantida:", e?.message);
  }
}

// ── Leitura do XML da NF de entrada ──────────────────────────────────────────
const t = (o: any): string => {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (o._text !== undefined) return String(o._text);
  if (o._cdata !== undefined) return String(o._cdata);
  return "";
};
function primeiroFilho(o: any): any {
  if (!o || typeof o !== "object") return null;
  const k = Object.keys(o).find((x) => !x.startsWith("_"));
  return k ? o[k] : null;
}

export interface ItemOrigem {
  nItem: number; cProd: string; xProd: string; NCM: string; CEST: string; CFOP: string; uCom: string;
  qCom: number; vUnCom: number; vProd: number; vDesc: number; vFrete: number; vSeg: number; vOutro: number;
  orig: string; vBCICMS: number; pICMS: number; vICMS: number; pIPI: number; vIPI: number;
}
export interface NotaOrigem {
  chave: string; nNF: string; serie: string; dhEmi: string;
  fornecedor: { cnpj: string; nome: string; ie: string; xLgr: string; nro: string; xCpl: string; xBairro: string; cMun: string; xMun: string; uf: string; cep: string; fone: string };
  destCnpj: string;
  itens: ItemOrigem[];
}

export function lerNotaOrigem(xml: string): NotaOrigem {
  const limpo = xml.replace(/<\/?[\w]+:/g, (m) => (m.charAt(1) === "/" ? "</" : "<")).replace(/\sxmlns[^=]*="[^"]*"/g, "");
  const root: any = xmlJs.xml2js(limpo, { compact: true, ignoreComment: true });
  const proc = root.nfeProc || root.NFe;
  const nfe = proc?.NFe || proc;
  const inf = nfe?.infNFe;
  if (!inf) throw new Error("XML da NF de entrada inválido (sem infNFe).");
  const ide = inf.ide || {}, emit = inf.emit || {}, ender = emit.enderEmit || {}, dest = inf.dest || {};
  const dets = Array.isArray(inf.det) ? inf.det : inf.det ? [inf.det] : [];
  const itens: ItemOrigem[] = dets.map((d: any, i: number) => {
    const p = d.prod || {};
    const icms = primeiroFilho(d.imposto?.ICMS) || {};
    const ipiTrib = d.imposto?.IPI?.IPITrib || {};
    return {
      nItem: parseInt(t(d._attributes?.nItem) || String(i + 1), 10),
      cProd: t(p.cProd), xProd: t(p.xProd), NCM: t(p.NCM), CEST: t(p.CEST), CFOP: t(p.CFOP), uCom: t(p.uCom),
      qCom: num(t(p.qCom)), vUnCom: num(t(p.vUnCom)), vProd: num(t(p.vProd)), vDesc: num(t(p.vDesc)),
      vFrete: num(t(p.vFrete)), vSeg: num(t(p.vSeg)), vOutro: num(t(p.vOutro)),
      orig: t(icms.orig) || "0", vBCICMS: num(t(icms.vBC)), pICMS: num(t(icms.pICMS)), vICMS: num(t(icms.vICMS)),
      pIPI: num(t(ipiTrib.pIPI)), vIPI: num(t(ipiTrib.vIPI)),
    };
  });
  return {
    chave: (t(inf._attributes?.Id) || "").replace(/^NFe/, ""),
    nNF: t(ide.nNF), serie: t(ide.serie), dhEmi: t(ide.dhEmi),
    fornecedor: {
      cnpj: dig(t(emit.CNPJ) || t(emit.CPF)), nome: t(emit.xNome), ie: t(emit.IE),
      xLgr: t(ender.xLgr), nro: t(ender.nro), xCpl: t(ender.xCpl), xBairro: t(ender.xBairro),
      cMun: t(ender.cMun), xMun: t(ender.xMun), uf: t(ender.UF), cep: dig(t(ender.CEP)), fone: dig(t(ender.fone)),
    },
    destCnpj: dig(t(dest.CNPJ) || t(dest.CPF)),
    itens,
  };
}

// Quanto de cada item (nItem) da NF de entrada já foi devolvido (ou está em
// devolução ainda não descartada/cancelada/rejeitada).
async function jaDevolvidoPorItem(purchaseId: string): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  const rs = rowsOf(await db.execute(sql`
    SELECT pr.itens FROM purchase_returns pr
      LEFT JOIN fiscal_invoices fi ON fi.id = pr.fiscal_invoice_id
     WHERE pr.purchase_invoice_id = ${purchaseId}
       AND pr.status NOT IN ('descartada', 'cancelada')
       AND COALESCE(fi.status, 'draft') <> 'cancelled'`));
  for (const r of rs) for (const it of (r.itens || [])) m.set(Number(it.nItem), (m.get(Number(it.nItem)) || 0) + num(it.quantidade));
  return m;
}

// Sugestão de matéria-prima para o item: casa sabor + tamanho no nome.
function sugerirMateriaPrima(xProd: string, materias: any[]): string | null {
  const norm = (s: string) => String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9 ]/g, " ");
  const alvo = norm(xProd);
  const tokensAlvo = new Set(alvo.split(/\s+/).filter((x) => x.length >= 3 || /^\d+$/.test(x)));
  let melhor: { id: string; score: number } | null = null;
  for (const m of materias) {
    const toks = norm(m.name).split(/\s+/).filter((x) => x.length >= 3 || /^\d+$/.test(x));
    if (!toks.length) continue;
    const tam = toks.find((x) => /^(200|350|900)(ML)?$/.test(x))?.replace("ML", "");
    if (tam && !alvo.includes(tam)) continue;
    const hit = toks.filter((x) => tokensAlvo.has(x) || alvo.includes(x)).length;
    const score = hit / toks.length;
    if (score >= 0.6 && (!melhor || score > melhor.score)) melhor = { id: m.id, score };
  }
  return melhor?.id || null;
}

async function carregarCompra(id: string) {
  const r = rowsOf(await db.execute(sql`SELECT * FROM purchase_invoices WHERE id = ${id} LIMIT 1`))[0];
  if (!r) throw Object.assign(new Error("NF de compra não encontrada"), { status: 404 });
  if (!r.xml_content) throw Object.assign(new Error("Esta NF de compra ainda não tem o XML completo. Baixe o XML (SEFAZ) ou importe o arquivo antes de devolver."), { status: 409 });
  if (!r.omie_instance_id) throw Object.assign(new Error("A NF de compra não está vinculada a uma empresa (instância)."), { status: 409 });
  return r;
}

// ── Pós-autorização: estoque + financeiro (idempotente) ──────────────────────
export async function aplicarEfeitosDevolucaoCompra(fiscalInvoiceId: string, by: string | null): Promise<{ aplicado: boolean; avisos: string[]; credito: number } | null> {
  const pr = rowsOf(await db.execute(sql`SELECT * FROM purchase_returns WHERE fiscal_invoice_id = ${fiscalInvoiceId} LIMIT 1`))[0];
  if (!pr) return null;
  const fi = rowsOf(await db.execute(sql`SELECT status, invoice_number FROM fiscal_invoices WHERE id = ${fiscalInvoiceId}`))[0];
  if (!fi || fi.status !== "authorized") return { aplicado: false, avisos: ["NF de devolução ainda não autorizada — estoque e financeiro aguardam a autorização."], credito: 0 };
  if (pr.status === "autorizada") return { aplicado: false, avisos: [], credito: num(pr.credito_fornecedor) };

  const compra = rowsOf(await db.execute(sql`SELECT * FROM purchase_invoices WHERE id = ${pr.purchase_invoice_id}`))[0] || {};
  const tag = DEVCOMPRA_TAG(pr.id);
  const avisos: string[] = [];
  const resultado = await db.transaction(async (tx) => {
    // trava a linha — duas chamadas simultâneas não aplicam duas vezes
    const lock = rowsOf(await tx.execute(sql`SELECT status FROM purchase_returns WHERE id = ${pr.id} FOR UPDATE`))[0];
    if (lock?.status === "autorizada") return { estoque: pr.estoque_aplicado, fin: pr.financeiro_aplicado, credito: num(pr.credito_fornecedor), jaFeito: true };

    // 1) Estoque de matéria-prima
    const estoque: any[] = [];
    if (pr.baixar_estoque) {
      for (const it of (pr.itens || [])) {
        if (!it.rawMaterialId) continue;
        const qtd = r4(num(it.quantidade) * (num(it.fator) || 1));
        if (!(qtd > 0)) continue;
        const cur = rowsOf(await tx.execute(sql`SELECT quantity, unit_cost, name FROM raw_materials WHERE id = ${it.rawMaterialId} FOR UPDATE`))[0];
        if (!cur) { avisos.push(`Matéria-prima ${it.rawMaterialId} não encontrada — item ${it.nItem} sem baixa.`); continue; }
        const prev = num(cur.quantity), next = r4(prev - qtd);
        await tx.execute(sql`UPDATE raw_materials SET quantity = ${next}, updated_at = now() WHERE id = ${it.rawMaterialId}`);
        await tx.execute(sql`
          INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, notes, created_by, created_at, unit_cost)
          VALUES (gen_random_uuid(), ${it.rawMaterialId}, 'saida', ${qtd}, ${prev}, ${next},
            ${`Devolução ao fornecedor — NF-e ${fi.invoice_number} (ref. NF ${compra.invoice_number || "?"} ${compra.supplier_name || ""}) ${tag}`},
            ${by || "devolucao-compra"}, now(), ${cur.unit_cost})`);
        estoque.push({ rawMaterialId: it.rawMaterialId, nome: cur.name, quantidade: qtd, anterior: prev, novo: next });
        if (next < 0) avisos.push(`Saldo de ${cur.name} ficou negativo (${next}).`);
      }
    }

    // 2) Financeiro: abate contas a pagar em aberto da compra
    const fin: any[] = [];
    let restante = r2(num(pr.valor_total));
    if (pr.abater_financeiro && restante > 0) {
      const docF = dig(compra.supplier_document);
      const nf = String(compra.invoice_number || "").trim();
      const abertas = rowsOf(await tx.execute(sql`
        SELECT id, amount, amount_paid, original_amount, notes, title_number, due_date, status::text AS status FROM payables
         WHERE deleted_at IS NULL AND status IN ('a_vencer', 'vencida')
           AND (id = ${compra.payable_id || ""}
                OR (${nf} <> '' AND regexp_replace(COALESCE(supplier_document,''), '\\D', '', 'g') = ${docF}
                    AND (title_number = ${"NF-" + nf} OR title_number LIKE ${"NF-" + nf + " (%"})))
         ORDER BY due_date DESC NULLS LAST FOR UPDATE`));
      for (const p of abertas) {
        if (restante <= 0) break;
        const saldo = r2(num(p.amount) - num(p.amount_paid));
        if (saldo <= 0) continue;
        const abate = r2(Math.min(saldo, restante));
        const novoValor = r2(num(p.amount) - abate);
        const quitou = novoValor <= num(p.amount_paid) + 0.001;
        const nota = `Abatido R$ ${abate.toFixed(2)} pela devolução NF-e ${fi.invoice_number} ${tag}`;
        await tx.execute(sql`
          UPDATE payables SET
            original_amount = COALESCE(original_amount, amount),
            amount = ${novoValor},
            status = ${quitou ? (num(p.amount_paid) > 0 ? "paga" : "cancelada") : p.status},
            paid_date = ${quitou && num(p.amount_paid) > 0 ? sql`COALESCE(paid_date, now())` : sql`paid_date`},
            notes = CASE WHEN COALESCE(notes,'') = '' THEN ${nota} ELSE notes || ' | ' || ${nota} END,
            updated_by = ${by || "devolucao-compra"}, updated_at = now()
          WHERE id = ${p.id}`);
        fin.push({ payableId: p.id, titulo: p.title_number, valorAnterior: num(p.amount), abatido: abate, novoValor, statusAnterior: p.status, quitou });
        restante = r2(restante - abate);
      }
    }
    const credito = pr.abater_financeiro ? Math.max(0, restante) : 0;
    if (credito > 0) avisos.push(`R$ ${credito.toFixed(2)} não couberam em contas a pagar em aberto (já pagas ou inexistentes): ficam como CRÉDITO com ${compra.supplier_name || "o fornecedor"} — combine abatimento na próxima compra ou ressarcimento.`);

    await tx.execute(sql`
      UPDATE purchase_returns SET status = 'autorizada',
        estoque_aplicado = ${JSON.stringify(estoque)}::jsonb,
        financeiro_aplicado = ${JSON.stringify(fin)}::jsonb,
        credito_fornecedor = ${credito}, updated_at = now()
      WHERE id = ${pr.id}`);
    const carimbo = `[${agora().toLocaleString("pt-BR")}] Devolução NF-e ${fi.invoice_number} autorizada (R$ ${num(pr.valor_total).toFixed(2)}; ${estoque.length} item(ns) baixado(s) do estoque; ${fin.length} conta(s) a pagar abatida(s)${credito > 0 ? `; crédito com fornecedor R$ ${credito.toFixed(2)}` : ""})`;
    await tx.execute(sql`UPDATE purchase_invoices SET notes = CASE WHEN COALESCE(notes,'') = '' THEN ${carimbo} ELSE notes || E'\n' || ${carimbo} END, updated_at = now() WHERE id = ${pr.purchase_invoice_id}`);
    return { estoque, fin, credito, jaFeito: false };
  });
  console.log(`📦 [DEV-COMPRA] ${pr.id} efeitos aplicados: estoque=${(resultado.estoque || []).length} fin=${(resultado.fin || []).length} credito=${resultado.credito}`);
  return { aplicado: !resultado.jaFeito, avisos, credito: resultado.credito };
}

// ── Cancelamento da NF de devolução: estorna estoque e financeiro ────────────
export async function estornarEfeitosDevolucaoCompra(fiscalInvoiceId: string, by: string | null): Promise<string[] | null> {
  const pr = rowsOf(await db.execute(sql`SELECT * FROM purchase_returns WHERE fiscal_invoice_id = ${fiscalInvoiceId} LIMIT 1`))[0];
  if (!pr) return null;
  if (pr.status !== "autorizada") {
    await db.execute(sql`UPDATE purchase_returns SET status = 'cancelada', updated_at = now() WHERE id = ${pr.id}`);
    return [];
  }
  const avisos: string[] = [];
  const tag = DEVCOMPRA_TAG(pr.id);
  await db.transaction(async (tx) => {
    for (const e of (pr.estoque_aplicado || [])) {
      const cur = rowsOf(await tx.execute(sql`SELECT quantity, unit_cost FROM raw_materials WHERE id = ${e.rawMaterialId} FOR UPDATE`))[0];
      if (!cur) continue;
      const prev = num(cur.quantity), next = r4(prev + num(e.quantidade));
      await tx.execute(sql`UPDATE raw_materials SET quantity = ${next}, updated_at = now() WHERE id = ${e.rawMaterialId}`);
      await tx.execute(sql`
        INSERT INTO raw_material_movements (id, raw_material_id, movement_type, quantity, previous_quantity, new_quantity, notes, created_by, created_at, unit_cost)
        VALUES (gen_random_uuid(), ${e.rawMaterialId}, 'ajuste', ${num(e.quantidade)}, ${prev}, ${next},
          ${`Estorno da devolução ao fornecedor (NF-e cancelada) ${tag}`}, ${by || "devolucao-compra"}, now(), ${cur.unit_cost})`);
    }
    for (const f of (pr.financeiro_aplicado || [])) {
      const p = rowsOf(await tx.execute(sql`SELECT amount, amount_paid, status FROM payables WHERE id = ${f.payableId} FOR UPDATE`))[0];
      if (!p) continue;
      const novo = r2(num(p.amount) + num(f.abatido));
      // Só desfaz o status que a PRÓPRIA devolução mudou (quitou → cancelada/paga).
      const status = f.quitou && ["cancelada", "paga"].includes(String(p.status)) ? (f.statusAnterior || "a_vencer") : p.status;
      await tx.execute(sql`
        UPDATE payables SET amount = ${novo}, status = ${status},
          notes = COALESCE(notes,'') || ${` | Abatimento estornado (NF-e de devolução cancelada) ${tag}`},
          updated_by = ${by || "devolucao-compra"}, updated_at = now()
        WHERE id = ${f.payableId}`);
    }
    await tx.execute(sql`UPDATE purchase_returns SET status = 'cancelada', updated_at = now() WHERE id = ${pr.id}`);
  });
  // Conta que voltou a_vencer mas já venceu: o job de vencidas acerta; aqui só avisa.
  return avisos;
}

// ── Rotas ────────────────────────────────────────────────────────────────────
export function registerDevolucaoCompraRoutes(app: Express) {
  garantirEstruturaDevolucaoCompra().catch(() => {});
  const ROLES = ["admin", "coordinator", "administrative"];

  // Prévia: itens da NF de entrada com saldo devolvível, fornecedor, CFOP sugerido
  app.get("/api/purchases/:id/devolucao", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    try {
      const compra = await carregarCompra(req.params.id);
      const nota = lerNotaOrigem(compra.xml_content);
      const { INSTANCE_COMPANY_DATA } = await import("./nfe-routes");
      const inst = rowsOf(await db.execute(sql`SELECT id, name FROM omie_instances WHERE id = ${compra.omie_instance_id}`))[0];
      const emp: any = inst ? (INSTANCE_COMPANY_DATA as any)[inst.name] : null;
      const interestadual = !!emp && !!nota.fornecedor.uf && emp.uf !== nota.fornecedor.uf;
      const ja = await jaDevolvidoPorItem(compra.id);
      const materias = rowsOf(await db.execute(sql`SELECT id, name, unit, quantity, category, supplier FROM raw_materials WHERE COALESCE(is_active, true) AND (instance_id = ${compra.omie_instance_id} OR instance_id IS NULL) ORDER BY name`));
      // finalidade sugerida: compra marcada como estoque = industrialização
      const finalidade: FinalidadeCompra = compra.is_stock_purchase === false ? "uso_consumo" : "industrializacao";
      const devolucoes = rowsOf(await db.execute(sql`
        SELECT pr.id, pr.status, pr.valor_total, pr.cfop, pr.motivo, pr.credito_fornecedor, pr.created_at,
               fi.id AS fiscal_invoice_id, fi.invoice_number, fi.status AS nf_status, fi.access_key
          FROM purchase_returns pr LEFT JOIN fiscal_invoices fi ON fi.id = pr.fiscal_invoice_id
         WHERE pr.purchase_invoice_id = ${compra.id} ORDER BY pr.created_at DESC`));
      res.json({
        compra: { id: compra.id, numero: compra.invoice_number, chave: compra.access_key || nota.chave, emissao: nota.dhEmi, total: num(compra.total_value), fornecedor: compra.supplier_name },
        emitente: inst ? { instancia: inst.name, nome: emp?.name, uf: emp?.uf } : null,
        fornecedor: nota.fornecedor,
        interestadual,
        finalidadeSugerida: finalidade,
        finalidades: Object.entries(FINALIDADES).map(([k, v]) => ({ valor: k, rotulo: v.rotulo, cfop: cfopDevolucaoCompra(k as FinalidadeCompra, "", interestadual).cfop })),
        itens: nota.itens.map((it) => {
          const devolvido = ja.get(it.nItem) || 0;
          return {
            ...it,
            devolvido,
            saldo: r4(Math.max(0, it.qCom - devolvido)),
            cfopDevolucao: cfopDevolucaoCompra(finalidade, it.CFOP, interestadual).cfop,
            rawMaterialSugerido: sugerirMateriaPrima(it.xProd, materias),
          };
        }),
        materias,
        devolucoes,
      });
    } catch (e: any) {
      res.status(e?.status || 500).json({ error: e?.message || String(e) });
    }
  });

  // Emite a NF-e de devolução
  app.post("/api/purchases/:id/devolucao", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    const by = req.currentUser?.email || req.user?.email || req.currentUser?.id || null;
    try {
      const compra = await carregarCompra(req.params.id);
      if (compra.status === "cancelled") return res.status(409).json({ error: "NF de compra cancelada no Integra — não dá para devolver." });
      const nota = lerNotaOrigem(compra.xml_content);
      const chave = dig(compra.access_key || nota.chave);
      if (chave.length !== 44) return res.status(409).json({ error: "A NF de compra não tem chave de acesso válida (a devolução precisa referenciá-la)." });

      const finalidade = (String(req.body?.finalidade || "industrializacao") as FinalidadeCompra);
      if (!FINALIDADES[finalidade]) return res.status(400).json({ error: "Finalidade inválida." });
      const motivo = String(req.body?.motivo || "").trim();
      if (motivo.length < 5) return res.status(400).json({ error: "Informe o motivo da devolução (mín. 5 caracteres)." });
      const baixarEstoque = req.body?.baixarEstoque !== false;
      const abaterFinanceiro = req.body?.abaterFinanceiro !== false;
      const pedidos: any[] = Array.isArray(req.body?.itens) ? req.body.itens : [];
      const ja = await jaDevolvidoPorItem(compra.id);

      const { INSTANCE_COMPANY_DATA } = await import("./nfe-routes");
      const inst = rowsOf(await db.execute(sql`SELECT id, name FROM omie_instances WHERE id = ${compra.omie_instance_id}`))[0];
      const emp: any = inst ? (INSTANCE_COMPANY_DATA as any)[inst.name] : null;
      if (!emp) return res.status(409).json({ error: "Empresa emitente (instância da compra) sem dados fiscais cadastrados." });
      if (nota.destCnpj && dig(emp.cnpj) !== nota.destCnpj) {
        return res.status(409).json({ error: `A NF de compra foi emitida para o CNPJ ${nota.destCnpj}, mas está na instância ${inst.name} (${dig(emp.cnpj)}). A devolução tem de sair do CNPJ que comprou — corrija a instância da NF.` });
      }
      const f = nota.fornecedor;
      if (!f.uf || !f.cnpj) return res.status(409).json({ error: "XML da NF de compra sem UF/CNPJ do fornecedor." });
      const interestadual = emp.uf !== f.uf;

      // Monta os itens devolvidos (proporcionais ao item de origem)
      const linhas: any[] = [];
      for (const p of pedidos) {
        const nItem = Number(p?.nItem);
        const q = r4(num(p?.quantidade));
        if (!(q > 0)) continue;
        const o = nota.itens.find((x) => x.nItem === nItem);
        if (!o) return res.status(400).json({ error: `Item ${nItem} não existe na NF de compra.` });
        const saldo = r4(o.qCom - (ja.get(nItem) || 0));
        if (q > saldo + 0.00001) return res.status(400).json({ error: `Item ${nItem} (${o.xProd}): devolvendo ${q} mas o saldo devolvível é ${saldo} ${o.uCom}.` });
        const integral = Math.abs(q - o.qCom) < 0.00001;
        const prop = o.qCom > 0 ? q / o.qCom : 0;
        const vProd = integral ? o.vProd : r2(o.vUnCom * q);
        const { cfop } = cfopDevolucaoCompra(finalidade, o.CFOP, interestadual);
        linhas.push({
          nItem, quantidade: q, origem: o, cfop, vProd,
          vDesc: r2(o.vDesc * prop), vFrete: r2(o.vFrete * prop), vSeg: r2(o.vSeg * prop), vOutro: r2(o.vOutro * prop),
          vBC: r2(o.vBCICMS * prop), pICMS: o.pICMS, vICMS: r2(o.vICMS * prop),
          pDevol: r2(prop * 100), vIPIDevol: r2(o.vIPI * prop),
          rawMaterialId: p?.rawMaterialId || null, fator: num(p?.fator) || 1,
        });
      }
      if (!linhas.length) return res.status(400).json({ error: "Informe a quantidade de pelo menos um item." });

      const tot = linhas.reduce((a, l) => ({
        vProd: a.vProd + l.vProd, vDesc: a.vDesc + l.vDesc, vFrete: a.vFrete + l.vFrete, vSeg: a.vSeg + l.vSeg,
        vOutro: a.vOutro + l.vOutro, vIPIDevol: a.vIPIDevol + l.vIPIDevol, vBC: a.vBC + l.vBC, vICMS: a.vICMS + l.vICMS,
      }), { vProd: 0, vDesc: 0, vFrete: 0, vSeg: 0, vOutro: 0, vIPIDevol: 0, vBC: 0, vICMS: 0 });
      Object.keys(tot).forEach((k) => ((tot as any)[k] = r2((tot as any)[k])));
      const vNF = r2(tot.vProd - tot.vDesc + tot.vFrete + tot.vSeg + tot.vOutro + tot.vIPIDevol);

      // Cenário fiscal (CFOP do 1º item; todos os itens da mesma finalidade/UF)
      const cfopNota = linhas[0].cfop;
      const cen = rowsOf(await db.execute(sql`SELECT * FROM fiscal_scenarios WHERE operation_type = 'devolucao_compra' AND cfop = ${cfopNota} AND COALESCE(is_active, true) LIMIT 1`))[0] || null;
      const natureza = cen?.nature_of_operation || cfopDevolucaoCompra(finalidade, linhas[0].origem.CFOP, interestadual).natureza;
      const csosn = cen?.csosn || "900";
      const cstPis = cen?.cst_pis || "49";
      const cstCofins = cen?.cst_cofins || "49";

      // Ambiente por instância (mesma regra do faturamento)
      const envRow = rowsOf(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${"fiscal_env_" + inst.id} LIMIT 1`))[0];
      const environment = String(envRow?.value || "homologacao") === "producao" ? "producao" : "homologacao";

      const dataOrigem = nota.dhEmi ? new Date(nota.dhEmi).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
      const notes = [
        `Devolucao ${tot.vProd < num(compra.total_value) - 0.01 ? "parcial" : "total"} ref. NF-e ${nota.nNF}${dataOrigem ? " de " + dataOrigem : ""}, chave ${chave}.`,
        tot.vICMS > 0 ? `BC ICMS R$ ${tot.vBC.toFixed(2)}, ICMS R$ ${tot.vICMS.toFixed(2)} (destacados na NF de origem).` : "",
        tot.vIPIDevol > 0 ? `IPI devolvido R$ ${tot.vIPIDevol.toFixed(2)}.` : "",
        `Motivo: ${motivo}`,
      ].filter(Boolean).join(" ").slice(0, 300);

      const issuerCnpj = dig(emp.cnpj);
      const fiscal = await storage.createFiscalInvoiceAtomic({
        series: "1",
        operationType: "devolucao_compra",
        fiscalScenarioId: cen?.id || null,
        issuerName: emp.name, issuerCnpj, issuerIe: emp.ie, issuerAddress: emp.address,
        issuerUf: emp.uf, issuerCityCode: emp.cityCode, issuerCity: emp.city, issuerPhone: emp.phone,
        customerId: null,
        customerName: f.nome,
        customerCnpjCpf: f.cnpj,
        customerIe: f.ie || "",
        customerAddress: f.xLgr,
        customerAddressNumber: f.nro || "S/N",
        customerBairro: f.xBairro,
        customerCep: f.cep,
        customerCity: f.xMun,
        customerCityCode: f.cMun,
        customerUf: f.uf,
        customerPhone: f.fone,
        natureOfOperation: natureza,
        cfop: cfopNota,
        totalProducts: tot.vProd.toFixed(2),
        totalDiscount: tot.vDesc.toFixed(2),
        totalFreight: tot.vFrete.toFixed(2),
        totalInsurance: tot.vSeg.toFixed(2),
        totalOtherExpenses: tot.vOutro.toFixed(2),
        totalIcms: tot.vICMS.toFixed(2),
        totalIpi: "0",
        totalIpiDevol: tot.vIPIDevol.toFixed(2),
        totalInvoice: vNF.toFixed(2),
        paymentMethod: "sem_pagamento",
        notes,
        environment,
        omieInstanceId: inst.id,
        referencedAccessKey: chave,
        finNFe: "4",
        createdBy: by,
        status: "draft",
      } as any, "1", issuerCnpj);

      for (const l of linhas) {
        const o: ItemOrigem = l.origem;
        await storage.createFiscalInvoiceItem({
          invoiceId: fiscal.id,
          itemNumber: l.nItem, // = nItem da NF de ENTRADA (vai no DFeReferenciado)
          productId: null,
          productCode: o.cProd,
          productName: o.xProd,
          ncm: o.NCM,
          cest: o.CEST || null,
          cfop: l.cfop,
          unit: o.uCom || "UN",
          quantity: String(l.quantidade),
          unitPrice: String(o.vUnCom),
          totalPrice: l.vProd.toFixed(2),
          discount: l.vDesc.toFixed(2),
          csosn,
          cstIcms: null,
          baseIcms: l.vBC.toFixed(2),
          aliqIcms: l.pICMS.toFixed(2),
          valorIcms: l.vICMS.toFixed(2),
          cstPis, cstCofins,
          ipiDevolPercent: l.vIPIDevol > 0 ? l.pDevol.toFixed(2) : null,
          ipiDevolValor: l.vIPIDevol > 0 ? l.vIPIDevol.toFixed(2) : null,
          valorFrete: l.vFrete > 0 ? l.vFrete.toFixed(2) : null,
          valorSeguro: l.vSeg > 0 ? l.vSeg.toFixed(2) : null,
          valorOutras: l.vOutro > 0 ? l.vOutro.toFixed(2) : null,
        } as any);
      }

      const itensGravados = linhas.map((l) => ({
        nItem: l.nItem, xProd: l.origem.xProd, uCom: l.origem.uCom, quantidade: l.quantidade, valor: l.vProd,
        ipiDevol: l.vIPIDevol, rawMaterialId: l.rawMaterialId, fator: l.fator,
      }));
      const prRow = rowsOf(await db.execute(sql`
        INSERT INTO purchase_returns (id, purchase_invoice_id, fiscal_invoice_id, omie_instance_id, finalidade, cfop, motivo, itens,
          valor_total, baixar_estoque, abater_financeiro, status, created_by)
        VALUES (gen_random_uuid(), ${compra.id}, ${fiscal.id}, ${inst.id}, ${finalidade}, ${cfopNota}, ${motivo}, ${JSON.stringify(itensGravados)}::jsonb,
          ${vNF}, ${baixarEstoque}, ${abaterFinanceiro}, 'rascunho', ${by})
        RETURNING id`))[0];

      await storage.createFiscalInvoiceEvent({
        invoiceId: fiscal.id, eventType: "created", status: "success",
        description: `NF-e de devolução de compra ao fornecedor ${f.nome} (ref. NF ${nota.nNF}, chave ${chave}). Motivo: ${motivo}`,
        createdBy: by,
      } as any);

      if (req.body?.somenteRascunho === true) {
        return res.json({ success: true, rascunho: true, fiscalInvoiceId: fiscal.id, invoiceNumber: fiscal.invoiceNumber, purchaseReturnId: prRow?.id, valor: vNF });
      }

      const { sefazService } = await import("./sefaz-service");
      const r: any = await sefazService.emitNfe(fiscal.id);
      if (!r?.success) {
        await db.execute(sql`UPDATE purchase_returns SET updated_at = now() WHERE id = ${prRow?.id}`);
        return res.status(422).json({
          success: false, fiscalInvoiceId: fiscal.id, invoiceNumber: fiscal.invoiceNumber, purchaseReturnId: prRow?.id,
          error: `SEFAZ não autorizou a NF-e de devolução nº ${fiscal.invoiceNumber}: ${r?.errorMessage || "erro"}. A nota ficou em Notas Fiscais para corrigir e retransmitir — estoque e financeiro só mexem depois da autorização.`,
        });
      }
      const efeitos = await aplicarEfeitosDevolucaoCompra(fiscal.id, by);
      res.json({
        success: true, fiscalInvoiceId: fiscal.id, invoiceNumber: fiscal.invoiceNumber, accessKey: r.accessKey,
        protocolNumber: r.protocolNumber, purchaseReturnId: prRow?.id, valor: vNF,
        avisos: efeitos?.avisos || [], creditoFornecedor: efeitos?.credito || 0,
      });
    } catch (e: any) {
      console.error("❌ [DEV-COMPRA] erro:", e?.message);
      res.status(e?.status || 500).json({ error: e?.message || String(e) });
    }
  });

  // Descarta uma devolução que não foi autorizada (libera o saldo dos itens)
  app.post("/api/purchase-returns/:id/descartar", authenticateUser, requireRole(ROLES), async (req: any, res) => {
    try {
      const pr = rowsOf(await db.execute(sql`
        SELECT pr.id, pr.status, fi.status AS nf_status FROM purchase_returns pr
          LEFT JOIN fiscal_invoices fi ON fi.id = pr.fiscal_invoice_id WHERE pr.id = ${req.params.id}`))[0];
      if (!pr) return res.status(404).json({ error: "Devolução não encontrada" });
      if (pr.status === "autorizada" || pr.nf_status === "authorized") return res.status(409).json({ error: "NF-e já autorizada — para desfazer, cancele a NF-e (até 24 h) em Notas Fiscais." });
      await db.execute(sql`UPDATE purchase_returns SET status = 'descartada', updated_at = now() WHERE id = ${pr.id}`);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
