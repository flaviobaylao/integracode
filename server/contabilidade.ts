// ═══════════════════════════════════════════════════════════════════════════
// CONTABILIDADE (set/2026) — relatórios gravados no Integra para o contador.
// Cada relatório é um ARQUIVO congelado (snapshot): gerado uma vez, guardado em
// contabilidade_relatorios e baixado quantas vezes precisar.
// Primeiro relatório: "Números de NF a inutilizar" (planilha por empresa).
// ═══════════════════════════════════════════════════════════════════════════
import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { reconstruirEstoque, type MovimentoRec } from "./reconstrucao-estoque";
import XLSX from "xlsx";

type AbaExcel = { nome: string; linhas: Record<string, any>[]; opcoes?: any };
// xlsx em ESM: o pacote é CJS, então o import default é o objeto com utils/write.
function planilhaAbas(abas: AbaExcel[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const a of abas) {
    const ws = XLSX.utils.json_to_sheet(a.linhas);
    const cols = Object.keys(a.linhas[0] || {});
    ws["!cols"] = cols.map((c) => ({ wch: Math.min(60, Math.max(c.length, ...a.linhas.map((l) => String(l[c] ?? "").length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, a.nome.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
import { levantarLacunas } from "./nfe-inutilizacao";

let _ok = false;
async function ensure() {
  if (_ok) return;
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS contabilidade_relatorios (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo varchar NOT NULL,
      categoria varchar NOT NULL DEFAULT 'fiscal',
      descricao text,
      nome_arquivo varchar NOT NULL,
      mime varchar NOT NULL,
      conteudo_base64 text NOT NULL,
      tamanho integer NOT NULL DEFAULT 0,
      resumo jsonb,
      created_by varchar,
      created_at timestamp NOT NULL DEFAULT now()
    )`));
  _ok = true;
}

const fmtCnpj = (c: string) => String(c || "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const dataBR = (s: string | null) => (s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");
function prazoLegal(dataDepois: string | null) {
  if (!dataDepois) return { prazo: "", vencido: "" };
  const d = new Date(dataDepois);
  const lim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 10, 23, 59));
  return { prazo: lim.toLocaleDateString("pt-BR", { timeZone: "UTC" }), vencido: Date.now() > lim.getTime() ? "Sim" : "Não" };
}

export async function gerarRelatorioLacunasNF(quem: string | null) {
  await ensure();
  const lev = await levantarLacunas({ desde: "2006-01-01" });
  const hist: any = await db.execute(sql`
    SELECT cnpj, uf, modelo, serie, ano, numero_inicial, numero_final, ambiente, status, c_stat, x_motivo, protocolo, created_at
    FROM fiscal_inutilizacoes WHERE ambiente = 'producao' ORDER BY created_at`);
  const histRows: any[] = hist.rows || hist;

  const resumo = lev.grupos.map((g: any) => ({
    "Empresa": g.nome,
    "CNPJ": fmtCnpj(g.cnpj),
    "UF": g.uf,
    "Modelo": g.modelo,
    "Série": g.serie,
    "Notas emitidas (Integra)": g.notas || 0,
    "Primeiro nº": g.primeiro || "",
    "Último nº": g.ultimo || "",
    "Faixas a inutilizar": g.totalFaixas,
    "Números a inutilizar": g.totalNumeros,
    "Faixas de 2026": g.faixas.filter((f: any) => f.ano === 2026).length,
    "Faixas fora do prazo": g.faixas.filter((f: any) => prazoLegal(f.dataDepois).vencido === "Sim").length,
  }));

  const abas: AbaExcel[] = [{ nome: "Resumo", linhas: resumo }];
  for (const g of lev.grupos as any[]) {
    if (!g.totalFaixas) continue;
    const sigla = String(g.nome).split(" ")[0];
    abas.push({
      nome: `${sigla} mod${g.modelo} s${g.serie}`.slice(0, 31),
      linhas: g.faixas.map((f: any) => {
        const p = prazoLegal(f.dataDepois);
        return {
          "CNPJ": fmtCnpj(g.cnpj),
          "Modelo": g.modelo,
          "Série": g.serie,
          "Nº inicial": f.ini,
          "Nº final": f.fim,
          "Quantidade": f.qtd,
          "Ano do pedido": f.ano,
          "Nota anterior (data)": dataBR(f.dataAntes),
          "Nota seguinte (data)": dataBR(f.dataDepois),
          "Prazo legal": p.prazo,
          "Fora do prazo": p.vencido,
          "Situação no Integra": (f.statusIntegra || []).join(", "),
        };
      }),
      opcoes: { formatos: { "CNPJ": "texto" as any } },
    });
  }
  abas.push({
    nome: "Pedidos enviados",
    linhas: histRows.length ? histRows.map((h) => ({
      "Data": new Date(h.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      "CNPJ": fmtCnpj(h.cnpj), "UF": h.uf, "Modelo": h.modelo, "Série": h.serie, "Ano": h.ano,
      "Nº inicial": h.numero_inicial, "Nº final": h.numero_final, "Situação": h.status,
      "cStat": h.c_stat || "", "Retorno SEFAZ": h.x_motivo || "", "Protocolo": h.protocolo || "",
    })) : [{ "Data": "Nenhum pedido em produção até a geração deste relatório" }],
  });
  abas.push({
    nome: "Notas",
    linhas: [
      { "Observação": "Base legal: Ajuste SINIEF 07/05, cláusula 14ª — inutilizar até o 10º dia do mês seguinte à quebra da sequência." },
      { "Observação": "Fonte: chaves de acesso das NF-e/NFC-e de produção autorizadas, canceladas ou denegadas registradas no Integra 2.0." },
      { "Observação": "Faixas anteriores à entrada do Integra 2.0 (abr/2026) podem conter notas emitidas pelo Omie/1.0 não importadas; a SEFAZ recusa a faixa se houver número já usado." },
      { "Observação": "Números reservados por notas dos últimos 15 dias ainda sem desfecho (rascunho/pendente/rejeitada) ficam de fora." },
      { "Observação": `Gerado em ${new Date(lev.geradoEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.` },
    ],
  });

  const buf = planilhaAbas(abas);
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const nome = `NF_a_inutilizar_por_empresa_${hoje}.xlsx`;
  const totais = { faixas: resumo.reduce((a, r) => a + r["Faixas a inutilizar"], 0), numeros: resumo.reduce((a, r) => a + r["Números a inutilizar"], 0) };
  const ins: any = await db.execute(sql`
    INSERT INTO contabilidade_relatorios (titulo, categoria, descricao, nome_arquivo, mime, conteudo_base64, tamanho, resumo, created_by)
    VALUES (${"Números de NF a inutilizar — por empresa"}, 'fiscal',
            ${`${totais.faixas} faixas / ${totais.numeros} números em ${resumo.length} empresa-modelo-série`},
            ${nome}, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ${buf.toString("base64")}, ${buf.length}, ${JSON.stringify({ totais, resumo })}::jsonb, ${quem})
    RETURNING id, titulo, nome_arquivo, tamanho, created_at`);
  return (ins.rows || ins)[0];
}

export function registerContabilidadeRoutes(app: Express) {
  const ver = requireRole(["admin", "administrative", "coordinator"]);

  app.get("/api/contabilidade/relatorios", authenticateUser, ver, async (_req, res) => {
    try {
      await ensure();
      const r: any = await db.execute(sql`
        SELECT id, titulo, categoria, descricao, nome_arquivo, tamanho, resumo->'totais' totais, created_by, created_at
        FROM contabilidade_relatorios ORDER BY created_at DESC LIMIT 200`);
      res.json(r.rows || r);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get("/api/contabilidade/relatorios/:id/arquivo", authenticateUser, ver, async (req, res) => {
    try {
      await ensure();
      const r: any = await db.execute(sql`SELECT nome_arquivo, mime, conteudo_base64 FROM contabilidade_relatorios WHERE id = ${req.params.id}`);
      const row = (r.rows || r)[0];
      if (!row) return res.status(404).json({ error: "não encontrado" });
      res.setHeader("Content-Type", row.mime);
      res.setHeader("Content-Disposition", `attachment; filename=${row.nome_arquivo}`);
      res.send(Buffer.from(row.conteudo_base64, "base64"));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/contabilidade/relatorios/nf-a-inutilizar", authenticateUser, requireRole(["admin", "administrative"]), async (req: any, res) => {
    try {
      const quem = req.currentUser?.email || req.currentUser?.id || req.user?.email || null;
      res.json(await gerarRelatorioLacunasNF(quem));
    } catch (e: any) {
      console.error("[CONTABILIDADE] relatório NF a inutilizar:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ABA FISCAL + ABA CONTÁBIL (set/2026)
//
// Fiscal   = notas EMITIDAS (fiscal_invoices) e RECEBIDAS (purchase_invoices) numa
//            lista só, com os tributos de cada nota e os anexos (XML/DANFE) por linha.
// Contábil = razão de estoque por período e por instância (saldo inicial, entradas,
//            saídas, ajustes, saldo final e valorização pelo CMV do lote).
//
// Ambas são SOMENTE LEITURA: nada aqui grava. Servem para conferência e para o envio
// ao contador — as telas de operação (Faturamento NF-e, Compras, Estoque) seguem donas
// do dado.
// ═══════════════════════════════════════════════════════════════════════════

const num = (v: any): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const listaDeIds = (q: any): string[] =>
  String(q || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function registerContabilidadeFiscal(app: Express) {
  const ver = requireRole(["admin", "administrative", "coordinator", "contador"]);

  // ─────────────────────────────────────────────────────────────────────────
  // Instâncias (filtro compartilhado pelas duas abas)
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/api/contabilidade/instancias", authenticateUser, ver, async (_req, res) => {
    try {
      const r: any = await db.execute(sql`
        SELECT id, name, display_name, cnpj, is_active
        FROM omie_instances ORDER BY name`);
      res.json((r.rows || r).map((i: any) => ({
        id: i.id, nome: i.name, apelido: i.display_name, cnpj: i.cnpj, ativa: i.is_active,
      })));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FISCAL — notas emitidas + recebidas, com tributos
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/api/contabilidade/fiscal/notas", authenticateUser, ver, async (req: any, res) => {
    try {
      const inicio = String(req.query.inicio || "").slice(0, 10) || "2026-01-01";
      const fim = String(req.query.fim || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const insts = listaDeIds(req.query.instancias);
      const tipo = String(req.query.tipo || "todas"); // todas | saida | entrada
      const busca = String(req.query.busca || "").trim();

      const linhas: any[] = [];

      // SAÍDAS — uma linha por nota, tributos somados dos itens (base ICMS e ST não
      // existem no cabeçalho de fiscal_invoices; vêm do somatório dos itens).
      if (tipo !== "entrada") {
        const r: any = await db.execute(sql`
          SELECT fi.id, fi.invoice_number, fi.series, fi.access_key, fi.status,
                 fi.emission_date, fi.cfop, fi.nature_of_operation, fi.operation_type,
                 fi.customer_name, fi.customer_cnpj_cpf, fi.customer_uf,
                 fi.issuer_name, fi.issuer_cnpj, fi.omie_instance_id,
                 fi.total_products, fi.total_discount, fi.total_freight,
                 fi.total_icms, fi.total_pis, fi.total_cofins, fi.total_ipi, fi.total_invoice,
                 (fi.xml_autorizacao IS NOT NULL OR fi.xml_retorno IS NOT NULL OR fi.xml_envio IS NOT NULL) AS tem_xml,
                 oi.name AS instancia,
                 it.base_icms, it.itens
          FROM (SELECT DISTINCT ON (COALESCE(access_key, id)) *
                  FROM fiscal_invoices
                 ORDER BY COALESCE(access_key, id), created_at DESC) fi
          LEFT JOIN omie_instances oi ON oi.id = fi.omie_instance_id
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(base_icms), 0) AS base_icms, COUNT(*) AS itens
              FROM fiscal_invoice_items WHERE invoice_id = fi.id
          ) it ON true
          WHERE fi.emission_date >= ${inicio + " 00:00:00"}::timestamp
            AND fi.emission_date <= ${fim + " 23:59:59"}::timestamp
          ORDER BY fi.emission_date DESC
          LIMIT 5000`);
        for (const n of (r.rows || r)) {
          linhas.push({
            id: n.id, tipo: "saida",
            modelo: String(n.operation_type || "") === "entrada" ? "NF-e entrada" : "NF-e",
            numero: n.invoice_number, serie: n.series, chave: n.access_key,
            emissao: n.emission_date, situacao: n.status,
            instanciaId: n.omie_instance_id, instancia: n.instancia || "—",
            emitente: n.issuer_name, emitenteCnpj: n.issuer_cnpj,
            participante: n.customer_name, documento: n.customer_cnpj_cpf, uf: n.customer_uf,
            cfop: n.cfop, natureza: n.nature_of_operation, itens: Number(n.itens || 0),
            produtos: num(n.total_products), desconto: num(n.total_discount), frete: num(n.total_freight),
            baseIcms: num(n.base_icms), icms: num(n.total_icms), icmsSt: 0,
            ipi: num(n.total_ipi), pis: num(n.total_pis), cofins: num(n.total_cofins),
            total: num(n.total_invoice),
            temXml: !!n.tem_xml, temDanfe: true,
          });
        }
      }

      // ENTRADAS — purchase_invoices. Os tributos já vêm do XML no jsonb `taxes`
      // (vBC, vICMS, vICMSST, vIPI, vPIS, vCOFINS, vFrete, vDesc), então NÃO é preciso
      // criar coluna nova nem fazer backfill.
      if (tipo !== "saida") {
        const r: any = await db.execute(sql`
          SELECT p.id, p.invoice_number, p.series, p.access_key, p.status, p.issue_date,
                 p.supplier_name, p.supplier_document, p.cfop, p.nature_of_operation,
                 p.total_value, p.taxes, p.omie_instance_id, p.xml_content IS NOT NULL AS tem_xml,
                 oi.name AS instancia
          FROM purchase_invoices p
          LEFT JOIN omie_instances oi ON oi.id = p.omie_instance_id
          WHERE p.issue_date >= ${inicio + " 00:00:00"}::timestamp
            AND p.issue_date <= ${fim + " 23:59:59"}::timestamp
          ORDER BY p.issue_date DESC
          LIMIT 5000`);
        for (const n of (r.rows || r)) {
          const t = (typeof n.taxes === "string" ? JSON.parse(n.taxes || "{}") : n.taxes) || {};
          linhas.push({
            id: n.id, tipo: "entrada", modelo: "NF entrada",
            numero: n.invoice_number, serie: n.series, chave: n.access_key,
            emissao: n.issue_date, situacao: n.status,
            instanciaId: n.omie_instance_id, instancia: n.instancia || "—",
            emitente: n.supplier_name, emitenteCnpj: n.supplier_document,
            participante: n.supplier_name, documento: n.supplier_document, uf: null,
            cfop: n.cfop, natureza: n.nature_of_operation, itens: null,
            produtos: num(t.vNF) - num(t.vFrete) + num(t.vDesc) || num(n.total_value),
            desconto: num(t.vDesc), frete: num(t.vFrete),
            baseIcms: num(t.vBC), icms: num(t.vICMS), icmsSt: num(t.vICMSST),
            ipi: num(t.vIPI), pis: num(t.vPIS), cofins: num(t.vCOFINS),
            total: num(n.total_value),
            temXml: !!n.tem_xml, temDanfe: !!n.tem_xml,
          });
        }
      }

      // Filtros que valem para os dois lados (aplicados aqui para não duplicar SQL).
      let view = linhas;
      if (insts.length) view = view.filter((l) => insts.includes(String(l.instanciaId)));
      if (busca) {
        const b = busca.toLowerCase();
        const soDigitos = busca.replace(/\D/g, "");
        view = view.filter((l) =>
          String(l.participante || "").toLowerCase().includes(b) ||
          String(l.numero || "").includes(busca) ||
          (soDigitos.length >= 3 && String(l.documento || "").replace(/\D/g, "").includes(soDigitos)) ||
          (soDigitos.length >= 6 && String(l.chave || "").includes(soDigitos)));
      }
      const situacao = String(req.query.situacao || "").trim();
      if (situacao) view = view.filter((l) => String(l.situacao || "") === situacao);

      view.sort((a, b) => String(b.emissao || "").localeCompare(String(a.emissao || "")));

      const soma = (f: string) => Math.round(view.reduce((s, l: any) => s + num(l[f]), 0) * 100) / 100;
      res.json({
        periodo: { inicio, fim },
        total: view.length,
        totais: {
          saidas: view.filter((l) => l.tipo === "saida").length,
          entradas: view.filter((l) => l.tipo === "entrada").length,
          produtos: soma("produtos"), baseIcms: soma("baseIcms"), icms: soma("icms"),
          icmsSt: soma("icmsSt"), ipi: soma("ipi"), pis: soma("pis"), cofins: soma("cofins"),
          nota: soma("total"),
        },
        linhas: view.slice(0, 3000),
      });
    } catch (e: any) {
      console.error("[CONTABILIDADE/FISCAL] notas:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Itens da nota (painel lateral): base/alíquota/valor de cada tributo por item.
  app.get("/api/contabilidade/fiscal/nota/:id/itens", authenticateUser, ver, async (req: any, res) => {
    try {
      const tipo = String(req.query.tipo || "saida");
      if (tipo === "entrada") {
        const r: any = await db.execute(sql`SELECT items FROM purchase_invoices WHERE id = ${req.params.id}`);
        const row = (r.rows || r)[0];
        const its = (typeof row?.items === "string" ? JSON.parse(row.items || "[]") : row?.items) || [];
        return res.json(its.map((i: any, k: number) => ({
          item: k + 1, produto: i.xProd, codigo: i.cProd, ncm: i.NCM, cfop: i.CFOP,
          unidade: i.uCom, quantidade: num(i.qCom), unitario: num(i.vUnCom), total: num(i.vProd),
        })));
      }
      const r: any = await db.execute(sql`
        SELECT item_number, product_name, product_code, ncm, cest, cfop, unit, quantity,
               unit_price, total_price, discount, csosn, cst_icms, base_icms, aliq_icms, valor_icms,
               cst_pis, base_pis, aliq_pis, valor_pis, cst_cofins, base_cofins, aliq_cofins, valor_cofins,
               cst_ipi, base_ipi, aliq_ipi, valor_ipi, lot_number
          FROM fiscal_invoice_items WHERE invoice_id = ${req.params.id} ORDER BY item_number`);
      res.json((r.rows || r).map((i: any) => ({
        item: i.item_number, produto: i.product_name, codigo: i.product_code, ncm: i.ncm,
        cest: i.cest, cfop: i.cfop, unidade: i.unit, lote: i.lot_number,
        quantidade: num(i.quantity), unitario: num(i.unit_price), total: num(i.total_price),
        desconto: num(i.discount), csosn: i.csosn,
        icms: { cst: i.cst_icms, base: num(i.base_icms), aliq: num(i.aliq_icms), valor: num(i.valor_icms) },
        pis: { cst: i.cst_pis, base: num(i.base_pis), aliq: num(i.aliq_pis), valor: num(i.valor_pis) },
        cofins: { cst: i.cst_cofins, base: num(i.base_cofins), aliq: num(i.aliq_cofins), valor: num(i.valor_cofins) },
        ipi: { cst: i.cst_ipi, base: num(i.base_ipi), aliq: num(i.aliq_ipi), valor: num(i.valor_ipi) },
      })));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // DANFE em PDF da nota de SAÍDA. O gerador já existe no servidor (montarDanfePdf,
  // usado no envio por e-mail/WhatsApp); aqui ele vira link por linha da listagem.
  app.get("/api/contabilidade/fiscal/nota/:id/danfe", authenticateUser, ver, async (req: any, res) => {
    try {
      const { storage } = await import("./storage");
      const inv: any = await storage.getFiscalInvoice(req.params.id);
      if (!inv) return res.status(404).json({ error: "Nota não encontrada" });
      const items = await storage.getFiscalInvoiceItems(req.params.id);
      const { montarDanfePdf } = await import("./doc-builders");
      const arq = montarDanfePdf({ ...inv, items });
      res.setHeader("Content-Type", arq.mime);
      res.setHeader("Content-Disposition", `attachment; filename="${arq.filename}"`);
      res.send(arq.content);
    } catch (e: any) {
      console.error("[CONTABILIDADE/FISCAL] danfe:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // XML da nota (saída = xml autorizado; entrada = xml importado).
  app.get("/api/contabilidade/fiscal/nota/:id/xml", authenticateUser, ver, async (req: any, res) => {
    try {
      const tipo = String(req.query.tipo || "saida");
      const r: any = tipo === "entrada"
        ? await db.execute(sql`SELECT xml_content AS xml, access_key, invoice_number FROM purchase_invoices WHERE id = ${req.params.id}`)
        : await db.execute(sql`SELECT COALESCE(xml_autorizacao, xml_retorno, xml_envio) AS xml, access_key, invoice_number FROM fiscal_invoices WHERE id = ${req.params.id}`);
      const row = (r.rows || r)[0];
      if (!row?.xml) return res.status(404).json({ error: "XML não disponível" });
      const base = String(row.access_key || `NF_${row.invoice_number || req.params.id}`).replace(/[^A-Za-z0-9_.-]/g, "");
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.xml"`);
      res.send(row.xml);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTABIL — razao de estoque por periodo e por instancia (somente leitura).
//
// Como o saldo inicial e reconstruido: nao existe foto historica do estoque.
// O que existe e (a) o saldo ATUAL de cada lote em inventory_lots.quantity e
// (b) todo o historico de movimentos em inventory_movements. Entao:
//     saldo_final   = saldo_atual  - (movimentos depois de <fim>)
//     saldo_inicial = saldo_final  - (movimentos dentro do periodo)
// O delta de cada movimento vem de new_quantity - previous_quantity quando os
// dois existem (e o valor real gravado na epoca); quando nao existem, cai no
// sinal por tipo: consume/transfer saem, replenish entra, adjust/cancel_reversal
// usam o proprio sinal de quantity.
//
// Valorizacao: unit_cost do lote (CMV congelado na ordem de producao). Lote sem
// custo conhecido entra como quantidade sem valor e e contado em semCusto.
// ═══════════════════════════════════════════════════════════════════════════
export function registerContabilidadeContabil(app: Express) {
  const ver = requireRole(["admin", "administrative", "coordinator", "contador"]);

  app.get("/api/contabilidade/contabil/razao-estoque", authenticateUser, ver, async (req: any, res) => {
    try {
      const inicio = String(req.query.inicio || "").slice(0, 10);
      const fim = String(req.query.fim || "").slice(0, 10);
      if (!inicio || !fim) return res.status(400).json({ error: "Informe inicio e fim (AAAA-MM-DD)." });
      const instancias = listaDeIds(req.query.instancias);
      const busca = String(req.query.busca || "").trim().toLowerCase();

      const filtroInst = instancias.length
        ? sql`AND l.instance_id = ANY(${sql.raw(`ARRAY[${instancias.map((i) => `'${i}'`).join(",")}]::varchar[]`)})`
        : sql``;

      // Saldo atual + custo por (produto, instancia, tipo de estoque)
      const atual: any = await db.execute(sql`
        SELECT l.product_id, l.instance_id, l.stock_type,
               SUM(l.quantity::numeric)                                        AS qtd_atual,
               SUM(CASE WHEN l.unit_cost IS NULL THEN 0
                        ELSE l.quantity::numeric * l.unit_cost::numeric END)   AS valor_atual,
               SUM(CASE WHEN l.unit_cost IS NULL THEN l.quantity::numeric ELSE 0 END) AS qtd_sem_custo,
               -- CMV = CUSTO MEDIO PONDERADO (decisao do Flavio, 17/set/2026):
               -- soma(qtd x custo do lote) / soma(qtd dos lotes COM custo).
               -- Lotes sem unit_cost ficam de fora da media e sao reportados em qtdSemCusto.
               CASE WHEN SUM(CASE WHEN l.unit_cost IS NULL THEN 0 ELSE l.quantity::numeric END) > 0
                    THEN SUM(CASE WHEN l.unit_cost IS NULL THEN 0
                                  ELSE l.quantity::numeric * l.unit_cost::numeric END)
                       / SUM(CASE WHEN l.unit_cost IS NULL THEN 0 ELSE l.quantity::numeric END)
                    ELSE NULL END                                               AS custo_unit
          FROM inventory_lots l
         WHERE l.is_active = true ${filtroInst}
         GROUP BY l.product_id, l.instance_id, l.stock_type`);

      // Movimentos do periodo e posteriores
      const filtroInstM = instancias.length
        ? sql`AND m.instance_id = ANY(${sql.raw(`ARRAY[${instancias.map((i) => `'${i}'`).join(",")}]::varchar[]`)})`
        : sql``;
      const movs: any = await db.execute(sql`
        SELECT m.product_id, m.instance_id, l.stock_type, m.movement_type,
               m.quantity::numeric AS q, m.previous_quantity::numeric AS ant,
               m.new_quantity::numeric AS nov, m.created_at
          FROM inventory_movements m
          LEFT JOIN inventory_lots l ON l.id = m.lot_id
         WHERE m.created_at >= ${inicio}::date ${filtroInstM}
         ORDER BY m.created_at ASC`);

      const delta = (m: any): number => {
        if (m.ant !== null && m.ant !== undefined && m.nov !== null && m.nov !== undefined) {
          return num(m.nov) - num(m.ant);
        }
        const q = Math.abs(num(m.q));
        if (m.movement_type === "consume" || m.movement_type === "transfer") return -q;
        if (m.movement_type === "replenish") return q;
        return num(m.q);
      };

      const chave = (p: string, i: string, t: string) => `${p}|${i}|${t || ""}`;
      type Linha = {
        produtoId: string; instanciaId: string; tipoEstoque: string;
        saldoInicial: number; entradas: number; saidas: number; ajustes: number;
        saldoFinal: number; custoUnitario: number | null; valorFinal: number | null;
        qtdSemCusto: number; movimentos: number; baixaNaoRegistrada: number;
      };
      const mapa = new Map<string, Linha>();
      const pega = (p: string, i: string, t: string): Linha => {
        const k = chave(p, i, t);
        let l = mapa.get(k);
        if (!l) {
          l = { produtoId: p, instanciaId: i, tipoEstoque: t || "in_use", saldoInicial: 0,
                entradas: 0, saidas: 0, ajustes: 0, saldoFinal: 0, custoUnitario: null,
                valorFinal: null, qtdSemCusto: 0, movimentos: 0, baixaNaoRegistrada: 0 };
          mapa.set(k, l);
        }
        return l;
      };

      for (const a of (atual.rows || atual)) {
        const l = pega(a.product_id, a.instance_id, a.stock_type);
        l.saldoFinal = num(a.qtd_atual);
        l.custoUnitario = a.custo_unit === null || a.custo_unit === undefined ? null : num(a.custo_unit);
        l.qtdSemCusto = num(a.qtd_sem_custo);
      }

      const limiteFim = new Date(fim + "T23:59:59.999Z").getTime();
      const limiteIni = new Date(inicio + "T00:00:00.000Z").getTime();
      // RECONSTRUCAO SEM SALDO NEGATIVO (Flavio, 17/set/2026).
      //
      // A conta antiga era saldoInicial = saldoFinal - (entradas - saidas + ajustes),
      // e produzia saldo NEGATIVO quando o livro de movimentos estava incompleto —
      // um numero fisicamente impossivel na tela. O algoritmo novo esta em
      // server/reconstrucao-estoque.ts (com testes em __tests__): o saldo inicial
      // e o menor valor que respeita ao mesmo tempo "fechar no saldo de hoje" e
      // "nunca ficar negativo", e quando os dois nao cabem juntos a diferenca vira
      // `baixaNaoRegistrada` — estoque que saiu sem ter sido lancado.
      const porChave = new Map<string, MovimentoRec[]>();
      for (const m of (movs.rows || movs)) {
        const k = chave(m.product_id, m.instance_id, m.stock_type);
        const arr = porChave.get(k) || [];
        arr.push({
          t: new Date(m.created_at).getTime(),
          delta: delta(m),
          ajuste: m.movement_type === "adjust" || m.movement_type === "cancel_reversal",
        });
        porChave.set(k, arr);
      }

      for (const l of Array.from(mapa.values())) {
        const movsDaChave = porChave.get(chave(l.produtoId, l.instanciaId, l.tipoEstoque)) || [];
        const r = reconstruirEstoque(l.saldoFinal /* saldo de HOJE */, movsDaChave, limiteIni, limiteFim);
        l.saldoInicial = r.saldoInicial;
        l.saldoFinal = r.saldoFinal;
        l.entradas = r.entradas;
        l.saidas = r.saidas;
        l.ajustes = r.ajustes;
        l.movimentos = r.movimentos;
        l.baixaNaoRegistrada = r.baixaNaoRegistrada;
      }

      const linhas: any[] = [];
      for (const l of Array.from(mapa.values())) {
        l.valorFinal = l.custoUnitario === null ? null : l.saldoFinal * l.custoUnitario;
        linhas.push(l);
      }

      // Inventario MENSAL (Flavio, 17/set/2026): alem do periodo cheio, devolve o saldo
      // no ULTIMO DIA de cada mes do intervalo. Mesmo metodo: parte do saldo atual e
      // desfaz, mes a mes, os movimentos posteriores aquele fechamento.
      const mensal: any[] = [];
      if (String(req.query.mensal || "") === "1") {
        const fins: string[] = [];
        let cur = new Date(inicio + "T00:00:00Z");
        const ate = new Date(fim + "T00:00:00Z");
        while (cur <= ate) {
          const ultimo = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
          fins.push((ultimo > ate ? ate : ultimo).toISOString().slice(0, 10));
          cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
        }
        // saldo atual por chave (antes de qualquer desconto de movimento)
        const saldoAtual = new Map<string, number>();
        for (const a of (atual.rows || atual)) saldoAtual.set(chave(a.product_id, a.instance_id, a.stock_type), num(a.qtd_atual));
        const movsArr = (movs.rows || movs) as any[];
        for (const f of fins) {
          const lim = new Date(f + "T23:59:59.999Z").getTime();
          const snap = new Map(saldoAtual);
          for (const m of movsArr) {
            if (new Date(m.created_at).getTime() <= lim) continue;
            const k = chave(m.product_id, m.instance_id, m.stock_type);
            // Mesma trava do razao: saldo negativo e impossivel, entao segura em zero.
            snap.set(k, Math.max(0, (snap.get(k) || 0) - delta(m)));
          }
          mensal.push({ fechamento: f, saldos: Array.from(snap.entries()).map(([k, q]) => {
            const [produtoId, instanciaId, tipoEstoque] = k.split("|");
            return { produtoId, instanciaId, tipoEstoque, saldo: q };
          }).filter((x) => Math.abs(x.saldo) > 0.0001) });
        }
      }

      // Nomes de produto e instancia
      const prods = Array.from(new Set(linhas.map((l) => l.produtoId))).filter(Boolean);
      const nomes = new Map<string, any>();
      if (prods.length) {
        const r: any = await db.execute(sql`
          SELECT id, name, omie_code, ncm FROM products
           WHERE id = ANY(${sql.raw(`ARRAY[${prods.map((p) => `'${p}'`).join(",")}]::varchar[]`)})`);
        for (const p of (r.rows || r)) nomes.set(p.id, p);
      }
      const inst: any = await db.execute(sql`SELECT id, name, display_name FROM omie_instances`);
      const instNome = new Map<string, string>();
      for (const i of (inst.rows || inst)) instNome.set(i.id, i.display_name || i.name);

      let saida = linhas.map((l) => ({
        ...l,
        produto: nomes.get(l.produtoId)?.name || "(produto removido)",
        codigo: nomes.get(l.produtoId)?.omie_code || null,
        ncm: nomes.get(l.produtoId)?.ncm || null,
        instancia: instNome.get(l.instanciaId) || l.instanciaId,
      }));

      if (busca) {
        saida = saida.filter((l) =>
          String(l.produto).toLowerCase().includes(busca) ||
          String(l.codigo || "").toLowerCase().includes(busca));
      }
      saida.sort((a, b) => String(a.instancia).localeCompare(String(b.instancia)) ||
                           String(a.produto).localeCompare(String(b.produto)));

      const totais = saida.reduce((t, l) => {
        t.saldoInicial += l.saldoInicial; t.entradas += l.entradas; t.saidas += l.saidas;
        t.ajustes += l.ajustes; t.saldoFinal += l.saldoFinal;
        t.valorFinal += l.valorFinal || 0; t.qtdSemCusto += l.qtdSemCusto;
        t.baixaNaoRegistrada += l.baixaNaoRegistrada;
        return t;
      }, { saldoInicial: 0, entradas: 0, saidas: 0, ajustes: 0, saldoFinal: 0, valorFinal: 0, qtdSemCusto: 0, baixaNaoRegistrada: 0 });

      res.json({
        periodo: { inicio, fim },
        instancias,
        linhas: saida,
        totais: { ...totais, itens: saida.length },
        criterioValorizacao: "custo medio ponderado por produto/instancia (lotes com custo)",
        mensal,
        avisoReconstrucao: totais.baixaNaoRegistrada > 0.0001
          ? `${Math.round(totais.baixaNaoRegistrada)} unidades sairam sem serem lancadas: os movimentos registrados nao fecham com o saldo de hoje. O saldo inicial foi reconstruido para nunca ficar negativo, e essa diferenca esta na coluna "Baixa nao registrada".`
          : null,
        aviso: totais.qtdSemCusto > 0
          ? `${Math.round(totais.qtdSemCusto)} unidades estao sem custo conhecido (lote sem unit_cost) e nao entram na valorizacao.`
          : null,
      });
    } catch (e: any) {
      console.error("[CONTABIL] razao-estoque:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
