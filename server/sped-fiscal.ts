// ═══════════════════════════════════════════════════════════════════════════
// SPED FISCAL (EFD ICMS/IPI) — gerador do Integra 2.0 (set/2026)
//
// Substitui o gerador antigo (generateSpedFiscal em financial-routes.ts), que
// montava um arquivo que nao passava no validador: 0000 com o UUID da instancia
// no lugar do CNPJ, 0005/0100 em branco, sem 0150 (participantes), sem 0190
// (unidades), sem as notas de ENTRADA, C100 com contagem de campos errada,
// H010 vazio, bloco K com a quantidade VENDIDA no lugar do estoque e os
// totalizadores 9900 chutados.
//
// O layout aqui segue os arquivos reais que a Sefaz aceitou (EFD 019), usados
// como gabarito: PURO GYN 06/2025 e PURO BSB 09/2025.
//
// Blocos gerados:
//   0  cabecalho, contribuinte, contador, participantes, unidades, itens
//   C  notas de SAIDA (fiscal_invoices) e de ENTRADA (purchase_invoices),
//      com C170 por item e C190 por combinacao CST/CFOP/aliquota
//   E  apuracao de ICMS (E100/E110) e de IPI (E500/E510)
//   G  vazio (CIAP) — so abertura e fechamento
//   H  inventario na data final, reconstruido do estoque do Integra
//   K  estoque escriturado (K200) na data final
//   9  totalizadores, contados de verdade a partir das linhas geradas
//
// A INSTANCIA E OBRIGATORIA: cada CNPJ entrega o seu proprio arquivo. Gerar um
// SPED com varias instancias juntas era o que fazia o antigo misturar empresas.
//
// O que o Integra ainda nao tem e sai em branco vem listado em `pendencias`,
// para o contador completar antes de transmitir (ex.: codigo IBGE do municipio
// dos participantes, que o cadastro de clientes nao guarda).
// ═══════════════════════════════════════════════════════════════════════════
import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";

const n = (v: any): number => {
  if (v === null || v === undefined || v === "") return 0;
  const x = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : 0;
};

// SPED usa virgula decimal e NUNCA separador de milhar.
const d2 = (v: any) => n(v).toFixed(2).replace(".", ",");
const d3 = (v: any) => n(v).toFixed(3).replace(".", ",");
const d4 = (v: any) => n(v).toFixed(4).replace(".", ",");
const d5 = (v: any) => n(v).toFixed(5).replace(".", ",");

// ddmmaaaa, sem barras.
const dt = (v: any): string => {
  if (!v) return "";
  const x = new Date(v);
  if (Number.isNaN(x.getTime())) return "";
  const p = (k: number) => String(k).padStart(2, "0");
  return `${p(x.getUTCDate())}${p(x.getUTCMonth() + 1)}${x.getUTCFullYear()}`;
};

// Campos de texto no SPED nao podem conter "|" nem quebra de linha.
const txt = (v: any, max = 255): string =>
  String(v ?? "").replace(/[|\r\n]/g, " ").trim().slice(0, max);

const digitos = (v: any): string => String(v ?? "").replace(/\D/g, "");

export type ResultadoSped = {
  conteudo: string;
  nomeArquivo: string;
  resumo: Record<string, any>;
  pendencias: string[];
};

export async function gerarSpedFiscal(opcoes: {
  instanciaId: string;
  inicio: string;
  fim: string;
}): Promise<ResultadoSped> {
  const { instanciaId, inicio, fim } = opcoes;
  const pendencias: string[] = [];
  const L: string[] = [];

  // ─── Instancia (emitente) ────────────────────────────────────────────────
  const rInst: any = await db.execute(sql`
    SELECT id, name, display_name, cnpj FROM omie_instances WHERE id = ${instanciaId}`);
  const inst = (rInst.rows || rInst)[0];
  if (!inst) throw new Error("Instância não encontrada.");

  // omie_instances so guarda nome e CNPJ. O resto do cadastro do emitente
  // (IE, UF, municipio, endereco) e lido da ultima NF-e emitida pela propria
  // instancia — e o mesmo dado que ja foi para a Sefaz, entao bate.
  const rEmit: any = await db.execute(sql`
    SELECT issuer_name, issuer_cnpj, issuer_ie, issuer_address, issuer_uf,
           issuer_city_code, issuer_city, issuer_phone
      FROM fiscal_invoices
     WHERE omie_instance_id = ${instanciaId} AND issuer_cnpj IS NOT NULL
     ORDER BY emission_date DESC LIMIT 1`);
  const emit = (rEmit.rows || rEmit)[0] || {};

  const cnpjEmit = digitos(emit.issuer_cnpj || inst.cnpj);
  if (!cnpjEmit) pendencias.push("CNPJ do emitente não encontrado na instância nem nas notas emitidas.");
  if (!emit.issuer_ie) pendencias.push("Inscrição Estadual do emitente em branco no registro 0000.");
  if (!emit.issuer_city_code) pendencias.push("Código IBGE do município do emitente em branco no registro 0000.");

  // ─── Notas de SAIDA ──────────────────────────────────────────────────────
  const rSaidas: any = await db.execute(sql`
    SELECT DISTINCT ON (COALESCE(fi.access_key, fi.id))
           fi.id, fi.invoice_number, fi.series, fi.access_key, fi.status,
           fi.emission_date, fi.cfop, fi.total_products, fi.total_discount,
           fi.total_freight, fi.total_icms, fi.total_ipi, fi.total_pis,
           fi.total_cofins, fi.total_invoice,
           fi.customer_name, fi.customer_cnpj_cpf, fi.customer_ie,
           fi.customer_address, fi.customer_bairro, fi.customer_city, fi.customer_uf
      FROM fiscal_invoices fi
     WHERE fi.omie_instance_id = ${instanciaId}
       AND fi.emission_date >= ${inicio + " 00:00:00"}::timestamp
       AND fi.emission_date <= ${fim + " 23:59:59"}::timestamp
       AND COALESCE(fi.status, '') NOT IN ('cancelada', 'cancelled', 'denegada', 'rejeitada')
     ORDER BY COALESCE(fi.access_key, fi.id), fi.created_at DESC`);
  const saidas = (rSaidas.rows || rSaidas).sort((a: any, b: any) =>
    String(a.emission_date).localeCompare(String(b.emission_date)));

  // Itens de todas as saidas, de uma vez so.
  const itensPorNota = new Map<string, any[]>();
  if (saidas.length) {
    const ids = saidas.map((s: any) => `'${s.id}'`).join(",");
    const rIt: any = await db.execute(sql`
      SELECT invoice_id, item_number, product_code, product_name, ncm, cfop, unit,
             quantity, unit_price, total_price, discount,
             cst_icms, csosn, base_icms, aliq_icms, valor_icms,
             cst_pis, base_pis, aliq_pis, valor_pis,
             cst_cofins, base_cofins, aliq_cofins, valor_cofins,
             cst_ipi, base_ipi, aliq_ipi, valor_ipi
        FROM fiscal_invoice_items
       WHERE invoice_id = ANY(${sql.raw(`ARRAY[${ids}]::varchar[]`)})
       ORDER BY invoice_id, item_number`);
    for (const i of (rIt.rows || rIt)) {
      const arr = itensPorNota.get(i.invoice_id) || [];
      arr.push(i);
      itensPorNota.set(i.invoice_id, arr);
    }
  }

  // ─── Notas de ENTRADA ────────────────────────────────────────────────────
  // O gerador antigo simplesmente ignorava as entradas. Sem elas o arquivo nao
  // fecha o credito de ICMS e o inventario nao tem de onde sair.
  const rEntradas: any = await db.execute(sql`
    SELECT id, invoice_number, series, access_key, issue_date, cfop,
           supplier_name, supplier_document, total_value, taxes, items
      FROM purchase_invoices
     WHERE omie_instance_id = ${instanciaId}
       AND issue_date >= ${inicio + " 00:00:00"}::timestamp
       AND issue_date <= ${fim + " 23:59:59"}::timestamp
     ORDER BY issue_date`);
  const entradas = rEntradas.rows || rEntradas;

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO 0
  // ═══════════════════════════════════════════════════════════════════════
  L.push(`|0000|019|0|${dt(inicio)}|${dt(fim)}|${txt(emit.issuer_name || inst.display_name, 100)}|${cnpjEmit}||${txt(emit.issuer_uf, 2)}|${digitos(emit.issuer_ie)}|${digitos(emit.issuer_city_code)}|||A|0|`);
  L.push(`|0001|0|`);
  L.push(`|0005|${txt(inst.display_name, 60)}|||||||||`);

  // 0100 — contador responsavel (BEST WAY ACCOUNTING, cadastrado no Integra).
  const rCont: any = await db.execute(sql`
    SELECT first_name, last_name, email, phone
      FROM users WHERE role = 'contador' AND is_active = true ORDER BY created_at LIMIT 1`);
  const cont = (rCont.rows || rCont)[0];
  if (cont) {
    L.push(`|0100|${txt(`${cont.first_name || ""} ${cont.last_name || ""}`, 100)}|||||||||||${txt(cont.email, 60)}||`);
    pendencias.push("Registro 0100: CPF e número do CRC do contador não estão cadastrados no Integra.");
  } else {
    L.push(`|0100|||||||||||||||`);
    pendencias.push("Registro 0100 em branco: nenhum usuário com perfil Contador está cadastrado.");
  }

  // 0150 — participantes (clientes das saidas + fornecedores das entradas).
  type Part = { cod: string; nome: string; cnpj: string; cpf: string; ie: string; uf: string; end: string; bairro: string };
  const parts = new Map<string, Part>();
  const codPart = (doc: any, nome: any) => digitos(doc) || `SD${txt(nome, 20).replace(/\W/g, "").toUpperCase()}`;

  for (const s of saidas) {
    const doc = digitos(s.customer_cnpj_cpf);
    const cod = codPart(s.customer_cnpj_cpf, s.customer_name);
    if (!parts.has(cod)) {
      parts.set(cod, {
        cod, nome: txt(s.customer_name, 100),
        cnpj: doc.length === 14 ? doc : "", cpf: doc.length === 11 ? doc : "",
        ie: digitos(s.customer_ie), uf: txt(s.customer_uf, 2),
        end: txt(s.customer_address, 60), bairro: txt(s.customer_bairro, 60),
      });
    }
  }
  for (const e of entradas) {
    const doc = digitos(e.supplier_document);
    const cod = codPart(e.supplier_document, e.supplier_name);
    if (!parts.has(cod)) {
      parts.set(cod, {
        cod, nome: txt(e.supplier_name, 100),
        cnpj: doc.length === 14 ? doc : "", cpf: doc.length === 11 ? doc : "",
        ie: "", uf: "", end: "", bairro: "",
      });
    }
  }
  for (const p of Array.from(parts.values())) {
    // COD_MUN fica vazio: o cadastro de clientes do Integra guarda a cidade por
    // nome, nao o codigo IBGE. Vai na lista de pendencias abaixo.
    L.push(`|0150|${p.cod}|${p.nome}|1058|${p.cnpj}|${p.cpf}|${p.ie}|||${p.end}|||${p.bairro}|`);
  }
  if (parts.size) pendencias.push(`Registro 0150: ${parts.size} participantes sem código IBGE do município (o cadastro guarda só o nome da cidade).`);

  // 0190 — unidades de medida usadas pelos itens.
  const unidades = new Set<string>();
  for (const arr of Array.from(itensPorNota.values())) {
    for (const i of arr) unidades.add(txt(i.unit || "UN", 6).toUpperCase());
  }
  if (!unidades.size) unidades.add("UN");
  for (const u of Array.from(unidades)) L.push(`|0190|${u}|${u}|`);

  // 0200 — itens (um por codigo de produto que apareceu no periodo).
  const itensCad = new Map<string, any>();
  for (const arr of Array.from(itensPorNota.values())) {
    for (const i of arr) {
      const c = txt(i.product_code, 60);
      if (c && !itensCad.has(c)) itensCad.set(c, i);
    }
  }
  for (const [c, i] of Array.from(itensCad.entries())) {
    // TIPO_ITEM 00 = mercadoria para revenda / produto acabado da industria.
    L.push(`|0200|${c}|${txt(i.product_name, 120)}|||${txt(i.unit || "UN", 6).toUpperCase()}|00|${digitos(i.ncm)}||||${d2(i.aliq_icms)}||`);
  }

  const fim0 = L.length + 1; // +1 pelo proprio 0990
  L.push(`|0990|${fim0}|`);

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO C — documentos fiscais modelo 55 (NF-e)
  // ═══════════════════════════════════════════════════════════════════════
  const inicioC = L.length;
  L.push(`|C001|0|`);

  // Analitico C190 acumulado por nota: chave CST|CFOP|ALIQ.
  const somaC190 = (chave: string, acc: Map<string, any>, campos: any) => {
    const a = acc.get(chave) || { vlOpr: 0, vlBc: 0, vlIcms: 0, vlBcSt: 0, vlIcmsSt: 0, vlRedBc: 0, vlIpi: 0 };
    a.vlOpr += campos.vlOpr; a.vlBc += campos.vlBc; a.vlIcms += campos.vlIcms;
    a.vlIpi += campos.vlIpi;
    acc.set(chave, a);
  };

  let totIcmsSaida = 0, totIpiSaida = 0, totIcmsEntrada = 0, totIpiEntrada = 0;

  // ── SAIDAS ──
  for (const s of saidas) {
    const itens = itensPorNota.get(s.id) || [];
    const cod = codPart(s.customer_cnpj_cpf, s.customer_name);
    // IND_OPER 1 = saida; IND_EMIT 0 = emissao propria.
    L.push(
      `|C100|1|0|${cod}|55|00|${String(s.series || "1").padStart(3, "0")}|${String(s.invoice_number || "").padStart(9, "0")}|` +
      `${txt(s.access_key, 44)}|${dt(s.emission_date)}|${dt(s.emission_date)}|${d2(s.total_invoice)}|0|` +
      `${d2(s.total_discount)}|0,00|${d2(s.total_products)}|9|${d2(s.total_freight)}|0,00|0,00|` +
      `${d2(itens.reduce((a: number, i: any) => a + n(i.base_icms), 0))}|${d2(s.total_icms)}|0,00|0,00|` +
      `${d2(s.total_ipi)}|${d2(s.total_pis)}|${d2(s.total_cofins)}|0,00|0,00|`
    );

    const acc = new Map<string, any>();
    for (const i of itens) {
      const cst = txt(i.cst_icms || i.csosn || "041", 3).padStart(3, "0");
      const cfop = digitos(i.cfop || s.cfop).padStart(4, "0");
      L.push(
        `|C170|${i.item_number}|${txt(i.product_code, 60)}|${txt(i.product_name, 120)}|${d5(i.quantity)}|` +
        `${txt(i.unit || "UN", 6).toUpperCase()}|${d2(i.total_price)}|${d2(i.discount)}|0|${cst}|${cfop}||` +
        `${d2(i.base_icms)}|${d2(i.aliq_icms)}|${d2(i.valor_icms)}|0,00|0,00|0,00|0|` +
        `${txt(i.cst_ipi || "99", 2)}||${d2(i.base_ipi)}|${d2(i.aliq_ipi)}|${d2(i.valor_ipi)}|` +
        `${txt(i.cst_pis || "98", 2)}|${d2(i.base_pis)}|${d4(i.aliq_pis)}|0,000|0,0000|${d2(i.valor_pis)}|` +
        `${txt(i.cst_cofins || "98", 2)}|${d2(i.base_cofins)}|${d4(i.aliq_cofins)}|0,000|0,0000|${d2(i.valor_cofins)}||0,00|`
      );
      somaC190(`${cst}|${cfop}|${d2(i.aliq_icms)}`, acc, {
        vlOpr: n(i.total_price), vlBc: n(i.base_icms), vlIcms: n(i.valor_icms), vlIpi: n(i.valor_ipi),
      });
      totIcmsSaida += n(i.valor_icms);
      totIpiSaida += n(i.valor_ipi);
    }
    for (const [k, a] of Array.from(acc.entries())) {
      const [cst, cfop, aliq] = k.split("|");
      L.push(`|C190|${cst}|${cfop}|${aliq}|${d2(a.vlOpr)}|${d2(a.vlBc)}|${d2(a.vlIcms)}|0,00|0,00|0,00|${d2(a.vlIpi)}||`);
    }
  }

  // ── ENTRADAS ──
  // Os tributos vem do jsonb `taxes` (parser do XML em purchase-routes.ts) e os
  // itens do jsonb `items`, com os nomes de campo do proprio XML da NF-e.
  for (const e of entradas) {
    const t = (typeof e.taxes === "string" ? JSON.parse(e.taxes || "{}") : e.taxes) || {};
    const its = (typeof e.items === "string" ? JSON.parse(e.items || "[]") : e.items) || [];
    const cod = codPart(e.supplier_document, e.supplier_name);
    // IND_OPER 0 = entrada; IND_EMIT 1 = emissao de terceiros.
    L.push(
      `|C100|0|1|${cod}|55|00|${String(e.series || "1").padStart(3, "0")}|${String(e.invoice_number || "").padStart(9, "0")}|` +
      `${txt(e.access_key, 44)}|${dt(e.issue_date)}|${dt(e.issue_date)}|${d2(e.total_value)}|0|` +
      `${d2(t.vDesc)}|0,00|${d2(n(t.vNF) - n(t.vFrete) + n(t.vDesc) || n(e.total_value))}|9|${d2(t.vFrete)}|${d2(t.vSeg)}|${d2(t.vOutro)}|` +
      `${d2(t.vBC)}|${d2(t.vICMS)}|0,00|${d2(t.vICMSST)}|${d2(t.vIPI)}|${d2(t.vPIS)}|${d2(t.vCOFINS)}|0,00|0,00|`
    );

    const acc = new Map<string, any>();
    its.forEach((i: any, k: number) => {
      const cst = txt(i.CST || i.CSOSN || "000", 3).padStart(3, "0");
      const cfop = digitos(i.CFOP || e.cfop).padStart(4, "0");
      L.push(
        `|C170|${k + 1}|${txt(i.cProd, 60)}|${txt(i.xProd, 120)}|${d5(i.qCom)}|${txt(i.uCom || "UN", 6).toUpperCase()}|` +
        `${d2(i.vProd)}|${d2(i.vDesc)}|0|${cst}|${cfop}||${d2(i.vBC)}|${d2(i.pICMS)}|${d2(i.vICMS)}|0,00|0,00|0,00|0|` +
        `99||0,00|0,00|0,00|98|0,00|0,0000|0,000|0,0000|0,00|98|0,00|0,0000|0,000|0,0000|0,00||0,00|`
      );
      somaC190(`${cst}|${cfop}|${d2(i.pICMS)}`, acc, {
        vlOpr: n(i.vProd), vlBc: n(i.vBC), vlIcms: n(i.vICMS), vlIpi: 0,
      });
      totIcmsEntrada += n(i.vICMS);
    });
    if (!its.length) {
      // Nota sem itens no jsonb: C190 unico com os totais do cabecalho, para o
      // arquivo nao ficar com C100 orfao.
      const cfop = digitos(e.cfop).padStart(4, "0");
      L.push(`|C190|000|${cfop}|0,00|${d2(e.total_value)}|${d2(t.vBC)}|${d2(t.vICMS)}|0,00|${d2(t.vICMSST)}|0,00|${d2(t.vIPI)}||`);
      pendencias.push(`Nota de entrada ${e.invoice_number}: sem itens detalhados, o C190 saiu pelo total do cabeçalho.`);
    }
    for (const [k, a] of Array.from(acc.entries())) {
      const [cst, cfop, aliq] = k.split("|");
      L.push(`|C190|${cst}|${cfop}|${aliq}|${d2(a.vlOpr)}|${d2(a.vlBc)}|${d2(a.vlIcms)}|0,00|0,00|0,00|${d2(a.vlIpi)}||`);
    }
    totIpiEntrada += n(t.vIPI);
  }

  L.push(`|C990|${L.length - inicioC + 1}|`);

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO E — apuracao de ICMS e IPI
  // ═══════════════════════════════════════════════════════════════════════
  const inicioE = L.length;
  const saldoIcms = Math.max(0, totIcmsSaida - totIcmsEntrada);
  const saldoIpi = Math.max(0, totIpiSaida - totIpiEntrada);
  L.push(`|E001|0|`);
  L.push(`|E100|${dt(inicio)}|${dt(fim)}|`);
  L.push(
    `|E110|${d2(totIcmsSaida)}|0,00|0,00|${d2(totIcmsEntrada)}|0,00|0,00|0,00|0,00|0,00|` +
    `${d2(saldoIcms)}|0,00|0,00|0,00|${d2(saldoIcms)}|`
  );
  L.push(`|E500|0|${dt(inicio)}|${dt(fim)}|`);
  L.push(`|E510|||${d2(totIpiEntrada)}|0,00|${d2(totIpiSaida)}|${d2(saldoIpi)}|`);
  L.push(`|E990|${L.length - inicioE + 1}|`);
  pendencias.push("Bloco E: a apuração saiu pela soma dos documentos do período. Ajustes, estornos e saldo credor anterior (E111/E116) precisam ser conferidos pelo contador.");

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO G — CIAP (sem movimento)
  // ═══════════════════════════════════════════════════════════════════════
  L.push(`|G001|1|`);
  L.push(`|G990|2|`);

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO H — inventario na data final
  //
  // Reconstruido igual a aba Contábil: parte do saldo ATUAL dos lotes e desfaz
  // os movimentos posteriores a data final. O valor unitario e o custo medio
  // ponderado dos lotes que tem custo (decisao do Flavio, 17/set/2026).
  // ═══════════════════════════════════════════════════════════════════════
  const inicioH = L.length;
  const inv = await inventarioNaData(instanciaId, fim);
  L.push(`|H001|0|`);
  const totalInv = inv.reduce((a, i) => a + i.valor, 0);
  L.push(`|H005|${dt(fim)}|${d2(totalInv)}|01|`);
  for (const i of inv) {
    // IND_PROP 0 = mercadoria de propriedade do informante, em seu poder.
    L.push(`|H010|${txt(i.codigo, 60)}|${txt(i.unidade || "UN", 6).toUpperCase()}|${d3(i.quantidade)}|${d5(i.custoUnitario)}|${d2(i.valor)}|0|||||`);
  }
  L.push(`|H990|${L.length - inicioH + 1}|`);
  const semCusto = inv.filter((i) => i.custoUnitario === 0 && i.quantidade > 0).length;
  if (semCusto) pendencias.push(`Bloco H: ${semCusto} itens entraram no inventário com valor zero por não haver custo no lote.`);
  if (!inv.length) pendencias.push("Bloco H: o Integra não tem saldo de estoque para esta instância na data final.");

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO K — estoque escriturado
  // ═══════════════════════════════════════════════════════════════════════
  const inicioK = L.length;
  L.push(`|K001|0|`);
  L.push(`|K100|${dt(inicio)}|${dt(fim)}|`);
  for (const i of inv) {
    // IND_EST 0 = posse e propriedade do informante.
    L.push(`|K200|${dt(fim)}|${txt(i.codigo, 60)}|${d3(i.quantidade)}|0||`);
  }
  L.push(`|K990|${L.length - inicioK + 1}|`);
  pendencias.push("Bloco K: saiu só o estoque escriturado (K200). K230/K235 (ordens de produção e consumo) ficam para a próxima etapa.");

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO 1 — sem movimento
  // ═══════════════════════════════════════════════════════════════════════
  L.push(`|1001|1|`);
  L.push(`|1990|2|`);

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCO 9 — totalizadores CONTADOS (o gerador antigo chutava "1" em tudo)
  // ═══════════════════════════════════════════════════════════════════════
  const conta = new Map<string, number>();
  for (const l of L) {
    const reg = l.split("|")[1];
    conta.set(reg, (conta.get(reg) || 0) + 1);
  }
  // O proprio bloco 9 tambem entra na contagem: 9001 + um 9900 por registro
  // (inclusive 9900, 9990 e 9999) + 9990 + 9999.
  const regs = Array.from(conta.keys()).sort();
  const qtd9900 = regs.length + 3; // + 9900 + 9990 + 9999
  const linhas9 = 1 /*9001*/ + qtd9900 + 1 /*9990*/ + 1 /*9999*/;

  L.push(`|9001|0|`);
  for (const r of regs) L.push(`|9900|${r}|${conta.get(r)}|`);
  L.push(`|9900|9900|${qtd9900}|`);
  L.push(`|9900|9990|1|`);
  L.push(`|9900|9999|1|`);
  // 9990 conta o bloco 9 INTEIRO, inclusive ele proprio e o 9999 — confirmado
  // no arquivo de referencia (46 linhas 9900 + 9001 + 9990 + 9999 = 49).
  L.push(`|9990|${linhas9}|`);
  L.push(`|9999|${L.length + 1}|`);

  const periodo = inicio.slice(0, 7).replace("-", "");
  return {
    conteudo: L.join("\r\n") + "\r\n",
    nomeArquivo: `SPED_EFD_${cnpjEmit || "SEM_CNPJ"}_${periodo}.txt`,
    resumo: {
      instancia: inst.display_name,
      cnpj: cnpjEmit,
      periodo: { inicio, fim },
      notasSaida: saidas.length,
      notasEntrada: entradas.length,
      participantes: parts.size,
      itensCadastrados: itensCad.size,
      itensInventario: inv.length,
      valorInventario: Math.round(totalInv * 100) / 100,
      icmsSaidas: Math.round(totIcmsSaida * 100) / 100,
      icmsEntradas: Math.round(totIcmsEntrada * 100) / 100,
      icmsAPagar: Math.round(saldoIcms * 100) / 100,
      totalLinhas: L.length,
    },
    pendencias,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Inventario numa data: mesmo metodo da aba Contábil.
// ───────────────────────────────────────────────────────────────────────────
async function inventarioNaData(instanciaId: string, data: string) {
  const atual: any = await db.execute(sql`
    SELECT l.product_id,
           SUM(l.quantity::numeric) AS qtd,
           CASE WHEN SUM(CASE WHEN l.unit_cost IS NULL THEN 0 ELSE l.quantity::numeric END) > 0
                THEN SUM(CASE WHEN l.unit_cost IS NULL THEN 0
                              ELSE l.quantity::numeric * l.unit_cost::numeric END)
                   / SUM(CASE WHEN l.unit_cost IS NULL THEN 0 ELSE l.quantity::numeric END)
                ELSE 0 END AS custo
      FROM inventory_lots l
     WHERE l.is_active = true AND l.instance_id = ${instanciaId}
     GROUP BY l.product_id`);

  const movs: any = await db.execute(sql`
    SELECT m.product_id, m.movement_type, m.quantity::numeric AS q,
           m.previous_quantity::numeric AS ant, m.new_quantity::numeric AS nov
      FROM inventory_movements m
     WHERE m.instance_id = ${instanciaId}
       AND m.created_at > ${data + " 23:59:59"}::timestamp`);

  const saldo = new Map<string, number>();
  const custo = new Map<string, number>();
  for (const a of (atual.rows || atual)) {
    saldo.set(a.product_id, n(a.qtd));
    custo.set(a.product_id, n(a.custo));
  }
  for (const m of (movs.rows || movs)) {
    let delta: number;
    if (m.ant !== null && m.ant !== undefined && m.nov !== null && m.nov !== undefined) {
      delta = n(m.nov) - n(m.ant);
    } else {
      const q = Math.abs(n(m.q));
      delta = m.movement_type === "consume" || m.movement_type === "transfer" ? -q
            : m.movement_type === "replenish" ? q : n(m.q);
    }
    saldo.set(m.product_id, (saldo.get(m.product_id) || 0) - delta);
  }

  const ids = Array.from(saldo.keys()).filter(Boolean);
  const nomes = new Map<string, any>();
  if (ids.length) {
    const r: any = await db.execute(sql`
      SELECT id, name, omie_code FROM products
       WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::varchar[]`)})`);
    for (const p of (r.rows || r)) nomes.set(p.id, p);
  }

  return Array.from(saldo.entries())
    .filter(([, q]) => Math.abs(q) > 0.0001)
    .map(([id, q]) => {
      const c = custo.get(id) || 0;
      return {
        codigo: nomes.get(id)?.omie_code || id,
        nome: nomes.get(id)?.name || "",
        unidade: "UN",
        quantidade: q,
        custoUnitario: c,
        valor: q * c,
      };
    })
    .sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)));
}

// ───────────────────────────────────────────────────────────────────────────
// Rotas — ficam na aba Fiscal, ao lado da listagem de notas.
// ───────────────────────────────────────────────────────────────────────────
export function registerSpedFiscal(app: Express) {
  const ver = requireRole(["admin", "administrative", "coordinator", "contador"]);

  // Prévia: mesmo arquivo, devolvido como JSON com resumo e pendências.
  app.get("/api/contabilidade/fiscal/sped", authenticateUser, ver, async (req: any, res) => {
    try {
      const instanciaId = String(req.query.instancia || "");
      const inicio = String(req.query.inicio || "").slice(0, 10);
      const fim = String(req.query.fim || "").slice(0, 10);
      if (!instanciaId) return res.status(400).json({ error: "Escolha a instância: cada CNPJ entrega o seu próprio SPED." });
      if (!inicio || !fim) return res.status(400).json({ error: "Informe início e fim (AAAA-MM-DD)." });

      const r = await gerarSpedFiscal({ instanciaId, inicio, fim });
      if (String(req.query.download || "") === "1") {
        res.setHeader("Content-Type", "text/plain; charset=iso-8859-1");
        res.setHeader("Content-Disposition", `attachment; filename="${r.nomeArquivo}"`);
        return res.send(Buffer.from(r.conteudo, "latin1"));
      }
      res.json({
        nomeArquivo: r.nomeArquivo,
        resumo: r.resumo,
        pendencias: r.pendencias,
        previa: r.conteudo.split("\r\n").slice(0, 60),
      });
    } catch (e: any) {
      console.error("[SPED] gerar:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
