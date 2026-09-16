// ============================================================================
// CIELO — EXTRATO ELETRÔNICO (EDI v15) NA CONCILIAÇÃO BANCÁRIA
//
// Pedido do Flavio (16/set/2026): "as transferências oriundas de repasses da
// Cielo deveriam já vir conciliadas com as contas que deram origem a seus
// faturamentos, já lançadas as despesas financeiras oriundas da dedução das
// taxas da Cielo, como despesas financeiras."
//
// O OFX do BB traz só "CIELO VENDAS CREDITO +R$ 167,05" (data + líquido). Quem
// abre esse valor venda a venda é o Extrato Eletrônico da Cielo:
//   * CIELO04 (pagamento): registro D = unidade de recebimento PAGA (bruto,
//     taxa, líquido, banco/agência/conta, data de pagamento) e registro E =
//     cada transação da UR (NSU, autorização, TID, bruto, taxa, líquido, data
//     da venda, débito/crédito, parcela).
//   * CIELO03 (vendas/previsão): mesmos registros E, com previsão.
//
// Este módulo NÃO cria extrato bancário nem lançamento no Livro da conta. O
// arquivo da Cielo é evidência lateral (tabelas cielo_edi_*). A conciliação
// continua acontecendo na LINHA DO BB:
//   1. importar   -> parser posicional, dedup por sha256 do arquivo e chave da UR;
//   2. casar      -> transação E -> título (balcão por NSU, link/loja por TID,
//                    rota por bruto+data+forma); UR D -> lançamento CIELO do BB
//                    por data + líquido (+ débito/crédito);
//   3. conciliar  -> baixa dos títulos abertos pelo BRUTO, vínculo sem nova
//                    baixa dos que já estavam recebidos (conta CARTOES, com
//                    transferência CARTOES -> BB), conta a pagar "Taxa Cielo"
//                    (fornecedor CIELO S.A., Despesas financeiras › Taxas de
//                    cartão) baixada na hora, tudo vinculado ao MESMO item do
//                    extrato, que sai de Pendente. Fecha: bruto − taxa = líquido.
//
// Roda no fim de toda importação (OFX, BB API, EDI) — a ordem não importa —
// e o "Desfazer" do lançamento devolve a UR para a fila (cieloAoDesfazer).
//
// LAYOUT: posições do manual v15. Dois cuidados: (a) os valores têm 13 dígitos
// com 2 casas implícitas; (b) como o manual público tem pequenas divergências
// de posição entre versões, o parser CALIBRA o deslocamento dos campos de
// valor testando bruto − taxa = líquido (registro D) e líquido ≈ bruto × (1 −
// taxa%) (registro E). O import com {dryRun:true} devolve a prévia sem gravar,
// para conferir com o primeiro arquivo real.
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { authenticateUser, requireRole } from "./authMiddleware";
import { lancarNaConta, estornarLancamento } from "./account-ledger";
import { createHash } from "crypto";

const FIN_ROLES = ["admin", "coordinator", "administrative"];
const CIELO_NOME = "CIELO S.A.";
const CIELO_CNPJ = "01.027.058/0001-91";
const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
const r2 = (n: number) => Number((Number(n) || 0).toFixed(2));
// pg devolve colunas `date` como Date (meia-noite local); normaliza para "AAAA-MM-DD".
const dstr = (v: any): string => {
  if (!v) return "";
  if (v instanceof Date) { const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0"); return `${y}-${m}-${d}`; }
  return String(v).slice(0, 10);
};
const brDate = (v: any): string => { const s = dstr(v); return s ? s.split("-").reverse().join("/") : "?"; };

// Dependências que vivem como closures dentro de registerReconciliation().
export type CieloDeps = {
  settleReceivable: (recId: string, settled: number, method: string, accountId: string | null, paidAtISO: string, by: string, mora?: any) => Promise<any>;
  settlePayable: (payId: string, settled: number, method: string, accountId: string | null, paidAtISO: string, by: string, mora?: any) => Promise<any>;
  ensureSupplier: (name: string, document: string | null, instanceId: string | null, chartAccountId: string | null, category: string | null, by: string) => Promise<{ id: string | null; created: boolean; name: string; document: string | null }>;
  logReconAudit: (row: Record<string, any>) => Promise<void>;
};
let deps: CieloDeps | null = null;

// ---------------------------------------------------------------------------
// SCHEMA (idempotente)
// ---------------------------------------------------------------------------
let _schemaOk = false;
export async function ensureCieloEdiSchema(): Promise<void> {
  if (_schemaOk) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS cielo_ec (
    ec varchar PRIMARY KEY,
    descricao varchar,
    financial_account_id varchar,
    omie_instance_id varchar,
    taxa_debito numeric(6,3),
    taxa_credito numeric(6,3),
    taxa_parcelado numeric(6,3),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS cielo_edi_arquivos (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name varchar,
    opcao varchar NOT NULL,
    ec varchar,
    versao varchar,
    data_processamento date,
    periodo_ini date,
    periodo_fim date,
    sha256 varchar NOT NULL UNIQUE,
    linhas int NOT NULL DEFAULT 0,
    urs int NOT NULL DEFAULT 0,
    transacoes int NOT NULL DEFAULT 0,
    total_bruto numeric(14,2) DEFAULT 0,
    total_taxa numeric(14,2) DEFAULT 0,
    total_liquido numeric(14,2) DEFAULT 0,
    calibracao text,
    imported_by varchar,
    created_at timestamptz DEFAULT now()
  )`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS cielo_edi_ur (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    arquivo_id varchar NOT NULL,
    opcao varchar NOT NULL,
    ec varchar,
    ur_key varchar NOT NULL UNIQUE,
    chave_ur text,
    cnpj varchar,
    bandeira varchar,
    tipo_liquidacao varchar,
    status_pagamento varchar,
    bruto numeric(14,2) NOT NULL DEFAULT 0,
    taxa numeric(14,2) NOT NULL DEFAULT 0,
    liquido numeric(14,2) NOT NULL DEFAULT 0,
    banco varchar,
    agencia varchar,
    conta varchar,
    data_pagamento date,
    financial_account_id varchar,
    bank_statement_item_id text,
    match_status varchar NOT NULL DEFAULT 'pendente',
    match_note text,
    matched_at timestamptz,
    matched_by varchar,
    taxa_payable_id varchar,
    raw text,
    created_at timestamptz DEFAULT now()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_cielo_ur_item ON cielo_edi_ur (bank_statement_item_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_cielo_ur_status ON cielo_edi_ur (match_status)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS cielo_edi_transacoes (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    arquivo_id varchar NOT NULL,
    ur_id varchar,
    opcao varchar NOT NULL,
    tx_key varchar NOT NULL UNIQUE,
    ec varchar,
    chave_ur text,
    bandeira varchar,
    tipo_liquidacao varchar,
    parcela int,
    total_parcelas int,
    cod_autorizacao varchar,
    tipo_lancamento varchar,
    codigo_transacao varchar,
    forma_pagamento varchar,
    bin varchar,
    final_cartao varchar,
    nsu varchar,
    tid varchar,
    taxa_mdr numeric(8,3),
    taxa_venda numeric(8,3),
    valor_total_venda numeric(14,2),
    valor_bruto_parcela numeric(14,2),
    valor_liquido numeric(14,2),
    tipo_transacao varchar,
    data_autorizacao date,
    data_captura date,
    data_lancamento date,
    data_vencimento_original date,
    receivable_id varchar,
    match_via varchar,
    match_note text,
    raw text,
    created_at timestamptz DEFAULT now()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_cielo_tx_ur ON cielo_edi_transacoes (ur_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_cielo_tx_rec ON cielo_edi_transacoes (receivable_id)`));
  _schemaOk = true;
}

// ---------------------------------------------------------------------------
// PARSER — layout posicional v15 (posições 1-based do manual)
// ---------------------------------------------------------------------------
const campo = (line: string, ini: number, len: number) => line.substr(ini - 1, len);
const soDig = (s: string) => String(s || "").replace(/\D/g, "");
const num13 = (s: string): number | null => { const d = soDig(s); return d ? Number(d) / 100 : null; };
const pct = (s: string): number | null => { const d = soDig(s); return d ? Number(d) / 100 : null; }; // "00250" -> 2,50 %
const dataDDMMAAAA = (s: string): string | null => {
  const d = soDig(s); if (d.length !== 8) return null;
  const dd = d.slice(0, 2), mm = d.slice(2, 4), aa = d.slice(4, 8);
  const iso = `${aa}-${mm}-${dd}`; return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) ? iso : null;
};
const dataAAAAMMDD = (s: string): string | null => {
  const d = soDig(s); if (d.length !== 8) return null;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) ? iso : null;
};
const dataAAMMDD = (s: string): string | null => {
  const d = soDig(s); if (d.length !== 6) return null;
  return dataAAAAMMDD("20" + d);
};
const trimTxt = (s: string) => String(s || "").replace(/\s+$/g, "").replace(/^\s+/g, "");

export type EdiHeader = { ec: string; dataProcessamento: string | null; periodoIni: string | null; periodoFim: string | null; opcao: string; versao: string };
export type EdiUR = {
  linha: number; ec: string; cnpj: string; bandeira: string; tipoLiquidacao: string; statusPagamento: string;
  bruto: number; taxa: number; liquido: number; banco: string; agencia: string; conta: string; chaveUr: string; dataPagamento: string | null; raw: string;
};
export type EdiTx = {
  linha: number; ec: string; bandeira: string; tipoLiquidacao: string; parcela: number | null; totalParcelas: number | null;
  codAutorizacao: string; tipoLancamento: string; chaveUr: string; codigoTransacao: string; formaPagamento: string; bin: string; finalCartao: string;
  nsu: string; tid: string; taxaMdr: number | null; taxaVenda: number | null; valorTotalVenda: number | null; valorBrutoParcela: number | null; valorLiquido: number | null;
  tipoTransacao: string; dataAutorizacao: string | null; dataCaptura: string | null; dataLancamento: string | null; dataVencimentoOriginal: string | null; raw: string;
};
export type EdiPix = { linha: number; ec: string; tipo: string; dataTransacao: string | null; idPix: string; nsu: string; dataPagamento: string | null; bruto: number; taxa: number; liquido: number; status: string; raw: string };
export type EdiParse = {
  header: EdiHeader | null; urs: EdiUR[]; txs: EdiTx[]; pix: EdiPix[]; trailer: { registros: number | null; liquido: number | null; bruto: number | null } | null;
  linhas: number; ignoradas: Record<string, number>; calibracao: { D: number; E: number }; avisos: string[];
};

// Calibração do deslocamento dos campos de valor (ver cabeçalho do arquivo).
function parseD(line: string, off: number): EdiUR {
  return {
    linha: 0,
    ec: soDig(campo(line, 2, 10)),
    cnpj: soDig(campo(line, 12, 14)),
    bandeira: soDig(campo(line, 54, 3)),
    tipoLiquidacao: soDig(campo(line, 57, 3)),
    statusPagamento: soDig(campo(line, 70, 2)),
    bruto: num13(campo(line, 72 + off, 13)) ?? 0,
    taxa: num13(campo(line, 87 + off, 13)) ?? 0,
    liquido: num13(campo(line, 101 + off, 13)) ?? 0,
    banco: soDig(campo(line, 114 + off, 4)),
    agencia: trimTxt(campo(line, 118 + off, 5)),
    conta: trimTxt(campo(line, 123 + off, 20)),
    chaveUr: trimTxt(campo(line, 152 + off, 100)),
    dataPagamento: dataDDMMAAAA(campo(line, 268 + off, 8)),
    raw: line,
  };
}
function parseE(line: string, off: number): EdiTx {
  const p = Number(soDig(campo(line, 18, 2))) || null, tp = Number(soDig(campo(line, 20, 2))) || null;
  return {
    linha: 0,
    ec: soDig(campo(line, 2, 10)),
    bandeira: soDig(campo(line, 12, 3)),
    tipoLiquidacao: soDig(campo(line, 15, 3)),
    parcela: p, totalParcelas: tp,
    codAutorizacao: trimTxt(campo(line, 22, 6)),
    tipoLancamento: soDig(campo(line, 28, 2)),
    chaveUr: trimTxt(campo(line, 30, 100)),
    codigoTransacao: trimTxt(campo(line, 130, 22)),
    formaPagamento: soDig(campo(line, 156, 3)),
    bin: soDig(campo(line, 166, 6)),
    finalCartao: soDig(campo(line, 172, 4)),
    nsu: soDig(campo(line, 176, 6)),
    tid: trimTxt(campo(line, 192, 20)),
    taxaMdr: pct(campo(line, 232, 5)),
    taxaVenda: pct(campo(line, 242, 5)),
    valorTotalVenda: num13(campo(line, 247 + off, 13)),
    valorBrutoParcela: num13(campo(line, 262 + off, 13)),
    valorLiquido: num13(campo(line, 276 + off, 13)),
    tipoTransacao: soDig(campo(line, 554, 3)),
    dataAutorizacao: dataDDMMAAAA(campo(line, 566, 8)),
    dataCaptura: dataDDMMAAAA(campo(line, 574, 8)),
    dataLancamento: dataDDMMAAAA(campo(line, 582, 8)),
    dataVencimentoOriginal: dataDDMMAAAA(campo(line, 630, 8)),
    raw: line,
  };
}
function parse8(line: string): EdiPix {
  return {
    linha: 0, ec: soDig(campo(line, 2, 10)), tipo: soDig(campo(line, 12, 2)), dataTransacao: dataAAMMDD(campo(line, 14, 6)),
    idPix: trimTxt(campo(line, 26, 36)), nsu: soDig(campo(line, 62, 6)), dataPagamento: dataAAMMDD(campo(line, 68, 6)),
    bruto: num13(campo(line, 75, 13)) ?? 0, taxa: num13(campo(line, 89, 13)) ?? 0, liquido: num13(campo(line, 103, 13)) ?? 0,
    status: soDig(campo(line, 223, 2)), raw: line,
  };
}
const fechaD = (u: EdiUR) => u.bruto > 0 && Math.abs(r2(u.bruto - u.taxa) - r2(u.liquido)) <= 0.011;
const fechaE = (t: EdiTx) => {
  if (!(Number(t.valorBrutoParcela) > 0) || t.valorLiquido == null) return false;
  if (t.taxaVenda == null) return Number(t.valorLiquido) <= Number(t.valorBrutoParcela) + 0.011;
  const esperado = r2(Number(t.valorBrutoParcela) * (1 - Number(t.taxaVenda) / 100));
  return Math.abs(esperado - Number(t.valorLiquido)) <= 0.03;
};
// Um deslocamento de 1 posição num campo de 13 dígitos zerado à esquerda só
// multiplica/divide por 10 — bruto − taxa = líquido continua fechando. Por isso
// a calibração usa também o que NÃO escala: a data de pagamento (D), a soma das
// URs contra o trailer, e a soma das parcelas (E) contra o bruto da própria UR.
const OFFSETS = [0, 1, -1, 2, -2];
const parseTrailer = (line: string) => ({ registros: Number(soDig(campo(line, 2, 11))) || null, liquido: num13(campo(line, 14, 17)), bruto: num13(campo(line, 43, 17)) });
function calibrarD(dLines: string[], trailer: { liquido: number | null; bruto: number | null } | null): number {
  if (!dLines.length) return 0;
  let melhor = 0, melhorPts = -1;
  for (const off of OFFSETS) {
    let pts = 0, somaLiq = 0, somaBruto = 0;
    for (const l of dLines) { try { const u = parseD(l, off); if (fechaD(u)) pts += 1; if (u.dataPagamento) pts += 2; somaLiq += u.liquido; somaBruto += u.bruto; } catch {} }
    if (trailer?.liquido != null && Math.abs(r2(somaLiq) - trailer.liquido) <= 0.05) pts += 5 * dLines.length;
    if (trailer?.bruto != null && Math.abs(r2(somaBruto) - trailer.bruto) <= 0.05) pts += 5 * dLines.length;
    if (pts > melhorPts) { melhorPts = pts; melhor = off; }
  }
  return melhor;
}
function calibrarE(eLines: string[], urs: EdiUR[], trailer: { liquido: number | null; bruto: number | null } | null): number {
  if (!eLines.length) return 0;
  const brutoPorChave = new Map<string, number>();
  for (const u of urs) if (u.chaveUr) brutoPorChave.set(u.chaveUr, r2((brutoPorChave.get(u.chaveUr) || 0) + u.bruto));
  let melhor = 0, melhorPts = -1;
  for (const off of OFFSETS) {
    let pts = 0, somaBruto = 0, somaLiq = 0;
    const porChave = new Map<string, number>();
    for (const l of eLines) {
      try {
        const t = parseE(l, off);
        if (fechaE(t)) pts += 1;
        somaBruto += Number(t.valorBrutoParcela || 0); somaLiq += Number(t.valorLiquido || 0);
        if (t.chaveUr) porChave.set(t.chaveUr, r2((porChave.get(t.chaveUr) || 0) + Number(t.valorBrutoParcela || 0)));
      } catch {}
    }
    if (brutoPorChave.size) {
      for (const [k, v] of Array.from(brutoPorChave.entries())) if (porChave.has(k) && Math.abs((porChave.get(k) || 0) - v) <= 0.02) pts += 5;
    } else if (trailer) {
      if (trailer.bruto != null && Math.abs(r2(somaBruto) - trailer.bruto) <= 0.05) pts += 5 * eLines.length;
      if (trailer.liquido != null && Math.abs(r2(somaLiq) - trailer.liquido) <= 0.05) pts += 5 * eLines.length;
    }
    if (pts > melhorPts) { melhorPts = pts; melhor = off; }
  }
  return melhor;
}

export function parseCieloEdi(text: string): EdiParse {
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  const out: EdiParse = { header: null, urs: [], txs: [], pix: [], trailer: null, linhas: lines.length, ignoradas: {}, calibracao: { D: 0, E: 0 }, avisos: [] };
  const dLines = lines.filter((l) => l[0] === "D"), eLines = lines.filter((l) => l[0] === "E");
  const tLine = lines.find((l) => l[0] === "9");
  const trailerPrev = tLine ? parseTrailer(tLine) : null;
  out.calibracao.D = calibrarD(dLines, trailerPrev);
  out.calibracao.E = calibrarE(eLines, dLines.map((l) => parseD(l, out.calibracao.D)), trailerPrev);
  lines.forEach((line, idx) => {
    const t = line[0];
    if (t === "0") {
      out.header = {
        ec: soDig(campo(line, 2, 10)), dataProcessamento: dataAAAAMMDD(campo(line, 12, 8)), periodoIni: dataAAAAMMDD(campo(line, 20, 8)),
        periodoFim: dataAAAAMMDD(campo(line, 28, 8)), opcao: soDig(campo(line, 48, 2)), versao: soDig(campo(line, 71, 3)),
      };
    } else if (t === "D") { const u = parseD(line, out.calibracao.D); u.linha = idx + 1; out.urs.push(u); }
    else if (t === "E") { const e = parseE(line, out.calibracao.E); e.linha = idx + 1; out.txs.push(e); }
    else if (t === "8") { const p = parse8(line); p.linha = idx + 1; out.pix.push(p); }
    else if (t === "9") { out.trailer = parseTrailer(line); }
    else { out.ignoradas[t || "?"] = (out.ignoradas[t || "?"] || 0) + 1; }
  });
  if (!out.header) out.avisos.push("Sem registro de header (tipo 0): o arquivo não parece ser um Extrato Eletrônico Cielo.");
  const dRuins = out.urs.filter((u) => !fechaD(u)).length;
  if (dRuins) out.avisos.push(`${dRuins} UR(s) em que bruto − taxa ≠ líquido (layout a conferir).`);
  const eRuins = out.txs.filter((t) => !fechaE(t)).length;
  if (eRuins) out.avisos.push(`${eRuins} transação(ões) em que líquido ≠ bruto × (1 − taxa) (layout a conferir).`);
  if (out.calibracao.D || out.calibracao.E) out.avisos.push(`Deslocamento aplicado aos campos de valor: D=${out.calibracao.D} E=${out.calibracao.E}.`);
  return out;
}

const urKey = (h: EdiHeader | null, u: EdiUR) =>
  createHash("sha1").update([h?.opcao || "", u.ec, u.chaveUr || `${u.bandeira}|${u.tipoLiquidacao}|${u.cnpj}`, u.dataPagamento || "", u.bruto.toFixed(2), u.liquido.toFixed(2), u.banco, u.conta].join("|")).digest("hex");
const txKey = (h: EdiHeader | null, t: EdiTx) =>
  createHash("sha1").update([h?.opcao || "", t.ec, t.codigoTransacao, t.nsu, t.codAutorizacao, t.dataAutorizacao || "", String(t.parcela || 1), (t.valorBrutoParcela ?? 0).toFixed(2), t.tipoLancamento].join("|")).digest("hex");
const tipoLiqNome = (c: string) => (c === "001" ? "débito" : c === "002" ? "crédito" : c === "004" ? "parcelado" : c || "—");
const metodoPorTipo = (c: string) => (c === "001" ? "cartao_debito" : (c === "002" || c === "004") ? "cartao_credito" : "cartao");

// ---------------------------------------------------------------------------
// CONTA FINANCEIRA DO EC (mapa) + conta CARTOES
// ---------------------------------------------------------------------------
async function contaDoEc(ec: string, u?: EdiUR): Promise<{ accountId: string | null; instanceId: string | null; via: string }> {
  const m = rowsOf(await db.execute(sql`SELECT financial_account_id, omie_instance_id FROM cielo_ec WHERE ec = ${ec} LIMIT 1`))[0];
  if (m?.financial_account_id) return { accountId: m.financial_account_id, instanceId: m.omie_instance_id || null, via: "mapa_ec" };
  // Sem mapa: tenta pela agência/conta de destino da UR.
  if (u?.conta) {
    const ag = soDig(u.agencia).replace(/^0+/, ""), ct = soDig(u.conta).replace(/^0+/, "");
    if (ct) {
      const rows = rowsOf(await db.execute(sql`
        SELECT id, omie_instance_id, agency, account_number FROM financial_accounts WHERE is_active IS NOT FALSE`));
      const hit = rows.find((a: any) => soDig(a.account_number).replace(/^0+/, "") === ct && (!ag || soDig(a.agency).replace(/^0+/, "").startsWith(ag.slice(0, 4))))
        || rows.find((a: any) => soDig(a.account_number).replace(/^0+/, "").slice(0, -1) === ct.slice(0, -1) && ct.length > 3);
      if (hit) {
        // Aprende: grava o mapa para as próximas importações.
        try { await db.execute(sql`INSERT INTO cielo_ec (ec, descricao, financial_account_id, omie_instance_id) VALUES (${ec}, ${"EC " + ec + " (mapeado pela conta de destino)"}, ${hit.id}, ${hit.omie_instance_id || null}) ON CONFLICT (ec) DO UPDATE SET financial_account_id = COALESCE(cielo_ec.financial_account_id, EXCLUDED.financial_account_id), omie_instance_id = COALESCE(cielo_ec.omie_instance_id, EXCLUDED.omie_instance_id), updated_at = now()`); } catch {}
        return { accountId: hit.id, instanceId: hit.omie_instance_id || null, via: "agencia_conta" };
      }
    }
  }
  try { await db.execute(sql`INSERT INTO cielo_ec (ec, descricao) VALUES (${ec}, ${"EC " + ec + " (sem conta — mapear)"}) ON CONFLICT (ec) DO NOTHING`); } catch {}
  return { accountId: null, instanceId: null, via: "nenhuma" };
}
async function contaCartoes(): Promise<string | null> {
  const r = rowsOf(await db.execute(sql`SELECT id FROM financial_accounts WHERE upper(name) = 'CARTOES' OR upper(name) LIKE 'CART%' ORDER BY (upper(name) = 'CARTOES') DESC LIMIT 1`))[0];
  return r?.id || null;
}

// Categoria DRE "Taxas de cartão" (filha do grupo de despesas financeiras).
async function ensureTaxaCartaoChartAccount(): Promise<string | null> {
  try {
    const ex = rowsOf(await db.execute(sql`
      SELECT id FROM chart_of_accounts WHERE code LIKE '%.%' AND (lower(name) LIKE '%taxa%cart%' OR lower(name) LIKE '%cielo%') LIMIT 1`))[0];
    if (ex) return ex.id;
    let parent = rowsOf(await db.execute(sql`
      SELECT id, code, dre_group, type FROM chart_of_accounts WHERE code NOT LIKE '%.%' AND dre_group = 'despesas_financeiras' ORDER BY code LIMIT 1`))[0];
    if (!parent) parent = rowsOf(await db.execute(sql`SELECT id, code, dre_group, type FROM chart_of_accounts WHERE code = '9' LIMIT 1`))[0];
    if (!parent) return null;
    let prox = 1;
    try {
      const mx = rowsOf(await db.execute(sql`
        SELECT COALESCE(MAX(NULLIF(regexp_replace(split_part(code, '.', 2), '[^0-9]', '', 'g'), '')::int), 0) AS n
        FROM chart_of_accounts WHERE code LIKE ${String(parent.code) + ".%"}`))[0];
      prox = Number(mx?.n || 0) + 1;
    } catch {}
    const novoCode = String(parent.code) + "." + String(prox).padStart(2, "0");
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO chart_of_accounts (id, code, name, type, dre_group, parent_id, is_active)
      VALUES (gen_random_uuid(), ${novoCode}, ${"Taxas de cartão"}, ${String(parent.type || "despesa")}::chart_of_account_type, ${parent.dre_group}, ${parent.id}, true)
      RETURNING id`))[0];
    return ins?.id || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// IMPORTAÇÃO
// ---------------------------------------------------------------------------
export async function importarCieloEdi(text: string, fileName: string, by: string, dryRun: boolean) {
  await ensureCieloEdiSchema();
  const parsed = parseCieloEdi(text);
  if (!parsed.header) throw new Error(parsed.avisos[0] || "arquivo inválido");
  const h = parsed.header;
  const opcao = h.opcao || (parsed.urs.length ? "04" : "03");
  const sha = createHash("sha256").update(text).digest("hex");
  const totalBruto = r2(parsed.urs.reduce((a, u) => a + u.bruto, 0));
  const totalTaxa = r2(parsed.urs.reduce((a, u) => a + u.taxa, 0));
  const totalLiq = r2(parsed.urs.reduce((a, u) => a + u.liquido, 0));
  const previa = {
    header: h, opcao, linhas: parsed.linhas, urs: parsed.urs.length, transacoes: parsed.txs.length, pix: parsed.pix.length,
    totalBruto, totalTaxa, totalLiquido: totalLiq, trailer: parsed.trailer, calibracao: parsed.calibracao, avisos: parsed.avisos, ignoradas: parsed.ignoradas,
    amostraUrs: parsed.urs.slice(0, 5).map(({ raw, ...u }) => u), amostraTx: parsed.txs.slice(0, 5).map(({ raw, ...t }) => t),
  };
  if (dryRun) return { ok: true, dryRun: true, ...previa };

  const ja = rowsOf(await db.execute(sql`SELECT id, file_name, created_at FROM cielo_edi_arquivos WHERE sha256 = ${sha} LIMIT 1`))[0];
  if (ja) return { ok: true, jaImportado: true, arquivoId: ja.id, fileName: ja.file_name, importadoEm: ja.created_at, ...previa };

  const arq = rowsOf(await db.execute(sql`
    INSERT INTO cielo_edi_arquivos (file_name, opcao, ec, versao, data_processamento, periodo_ini, periodo_fim, sha256, linhas, urs, transacoes, total_bruto, total_taxa, total_liquido, calibracao, imported_by)
    VALUES (${fileName || null}, ${opcao}, ${h.ec || null}, ${h.versao || null}, ${h.dataProcessamento}, ${h.periodoIni}, ${h.periodoFim}, ${sha}, ${parsed.linhas}, ${parsed.urs.length}, ${parsed.txs.length}, ${totalBruto}, ${totalTaxa}, ${totalLiq}, ${JSON.stringify(parsed.calibracao)}, ${by})
    RETURNING id`))[0];
  const arquivoId = arq.id;

  // URs (só no 04 há pagamento efetivo; no 03 gravamos também, como previsão).
  let ursNovas = 0, ursRepetidas = 0;
  const urIdPorChave = new Map<string, string>();
  for (const u of parsed.urs) {
    const key = urKey(h, u);
    const conta = await contaDoEc(u.ec || h.ec, u);
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO cielo_edi_ur (arquivo_id, opcao, ec, ur_key, chave_ur, cnpj, bandeira, tipo_liquidacao, status_pagamento, bruto, taxa, liquido, banco, agencia, conta, data_pagamento, financial_account_id, match_status, raw)
      VALUES (${arquivoId}, ${opcao}, ${u.ec || h.ec}, ${key}, ${u.chaveUr || null}, ${u.cnpj || null}, ${u.bandeira || null}, ${u.tipoLiquidacao || null}, ${u.statusPagamento || null},
              ${u.bruto.toFixed(2)}, ${u.taxa.toFixed(2)}, ${u.liquido.toFixed(2)}, ${u.banco || null}, ${u.agencia || null}, ${u.conta || null}, ${u.dataPagamento}, ${conta.accountId}, ${opcao === "04" ? "pendente" : "previsao"}, ${u.raw})
      ON CONFLICT (ur_key) DO NOTHING RETURNING id`))[0];
    if (ins?.id) { ursNovas++; if (u.chaveUr) urIdPorChave.set(u.chaveUr, ins.id); }
    else {
      ursRepetidas++;
      const ex = rowsOf(await db.execute(sql`SELECT id FROM cielo_edi_ur WHERE ur_key = ${key} LIMIT 1`))[0];
      if (ex?.id && u.chaveUr) urIdPorChave.set(u.chaveUr, ex.id);
    }
  }
  // Transações
  let txNovas = 0, txRepetidas = 0;
  for (const t of parsed.txs) {
    const key = txKey(h, t);
    const urId = (t.chaveUr && urIdPorChave.get(t.chaveUr)) || null;
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO cielo_edi_transacoes (arquivo_id, ur_id, opcao, tx_key, ec, chave_ur, bandeira, tipo_liquidacao, parcela, total_parcelas, cod_autorizacao, tipo_lancamento, codigo_transacao, forma_pagamento, bin, final_cartao, nsu, tid, taxa_mdr, taxa_venda, valor_total_venda, valor_bruto_parcela, valor_liquido, tipo_transacao, data_autorizacao, data_captura, data_lancamento, data_vencimento_original, raw)
      VALUES (${arquivoId}, ${urId}, ${opcao}, ${key}, ${t.ec || h.ec}, ${t.chaveUr || null}, ${t.bandeira || null}, ${t.tipoLiquidacao || null}, ${t.parcela}, ${t.totalParcelas}, ${t.codAutorizacao || null}, ${t.tipoLancamento || null}, ${t.codigoTransacao || null}, ${t.formaPagamento || null}, ${t.bin || null}, ${t.finalCartao || null}, ${t.nsu || null}, ${t.tid || null},
              ${t.taxaMdr}, ${t.taxaVenda}, ${t.valorTotalVenda}, ${t.valorBrutoParcela}, ${t.valorLiquido}, ${t.tipoTransacao || null}, ${t.dataAutorizacao}, ${t.dataCaptura}, ${t.dataLancamento}, ${t.dataVencimentoOriginal}, ${t.raw})
      ON CONFLICT (tx_key) DO UPDATE SET ur_id = COALESCE(cielo_edi_transacoes.ur_id, EXCLUDED.ur_id)
      RETURNING (xmax = 0) AS novo`))[0];
    if (ins?.novo) txNovas++; else txRepetidas++;
  }
  // UR sem transação por chave (arquivo sem chave_ur preenchida): liga por EC + data + tipo quando a soma fecha.
  await ligarTransacoesOrfas(arquivoId);

  const casamento = await casarTudo(by, false);
  return { ok: true, arquivoId, fileName, ...previa, ursNovas, ursRepetidas, txNovas, txRepetidas, casamento };
}

async function ligarTransacoesOrfas(arquivoId: string) {
  const urs = rowsOf(await db.execute(sql`SELECT id, ec, tipo_liquidacao, bruto, data_pagamento, chave_ur FROM cielo_edi_ur WHERE arquivo_id = ${arquivoId}`));
  for (const u of urs) {
    const n = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM cielo_edi_transacoes WHERE ur_id = ${u.id}`))[0]?.n || 0;
    if (n > 0) continue;
    const cand = rowsOf(await db.execute(sql`
      SELECT id, valor_bruto_parcela FROM cielo_edi_transacoes
      WHERE arquivo_id = ${arquivoId} AND ur_id IS NULL AND ec = ${u.ec} AND tipo_liquidacao = ${u.tipo_liquidacao}
        AND (${u.chave_ur}::text IS NULL OR chave_ur IS NULL OR chave_ur = ${u.chave_ur})`));
    const soma = r2(cand.reduce((a: number, c: any) => a + Number(c.valor_bruto_parcela || 0), 0));
    if (cand.length && Math.abs(soma - Number(u.bruto)) <= 0.011) {
      for (const c of cand) await db.execute(sql`UPDATE cielo_edi_transacoes SET ur_id = ${u.id} WHERE id = ${c.id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CASAMENTO 1: transação E -> título (receivable)
// ---------------------------------------------------------------------------
async function casarTransacoes(): Promise<{ analisadas: number; casadas: number; porVia: Record<string, number>; ambiguas: number; semTitulo: number }> {
  const out = { analisadas: 0, casadas: 0, porVia: {} as Record<string, number>, ambiguas: 0, semTitulo: 0 };
  const txs = rowsOf(await db.execute(sql`
    SELECT * FROM cielo_edi_transacoes WHERE receivable_id IS NULL AND COALESCE(tipo_lancamento, '') NOT IN ('99')
    ORDER BY data_autorizacao NULLS LAST, id LIMIT 2000`));
  for (const t of txs) {
    out.analisadas++;
    const bruto = Number(t.valor_total_venda || t.valor_bruto_parcela || 0);
    if (!(bruto > 0)) { out.semTitulo++; continue; }
    const dAut = t.data_autorizacao ? dstr(t.data_autorizacao) : null;
    let recId: string | null = null, via = "", note = "";
    // 1) Balcão / maquininha integrada (app Integra): NSU, código Cielo ou autorização gravados no pedido.
    if (t.nsu || t.cod_autorizacao) {
      const l = rowsOf(await db.execute(sql`
        SELECT lp.receivable_id, lp.id FROM lio_pedidos lp
        WHERE lp.receivable_id IS NOT NULL AND abs(COALESCE(lp.amount, 0)::numeric - ${bruto}) <= 0.011
          AND ( (${t.nsu}::text IS NOT NULL AND ${t.nsu}::text <> '' AND (regexp_replace(COALESCE(lp.nsu,''), '^0+', '') = regexp_replace(${t.nsu}::text, '^0+', '') OR regexp_replace(COALESCE(lp.cielo_code,''), '^0+', '') = regexp_replace(${t.nsu}::text, '^0+', '')))
             OR (${t.cod_autorizacao}::text IS NOT NULL AND ${t.cod_autorizacao}::text <> '' AND upper(COALESCE(lp.authorization_code,'')) = upper(${t.cod_autorizacao}::text)) )
          AND (${dAut}::date IS NULL OR lp.paid_at IS NULL OR abs(lp.paid_at::date - ${dAut}::date) <= 3)
        LIMIT 2`));
      if (l.length === 1) { recId = l[0].receivable_id; via = "balcao_nsu"; }
      else if (l.length > 1) note = "ambíguo: mais de um pedido de balcão com o mesmo NSU/valor";
    }
    // 2) Link de pagamento (Cielo e-commerce): TID / payment_id.
    if (!recId && t.tid) {
      const pl = rowsOf(await db.execute(sql`
        SELECT receivable_id, sales_card_id FROM payment_links
        WHERE status = 'paid' AND (tid = ${t.tid} OR payment_id = ${t.tid} OR merchant_order_id = ${t.codigo_transacao}) LIMIT 2`)).filter(Boolean);
      if (pl.length === 1) {
        recId = pl[0].receivable_id || (pl[0].sales_card_id ? await recDoSalesCard(pl[0].sales_card_id) : null);
        if (recId) via = "link_tid";
      }
    }
    // 3) Loja (hotsite) — cartão: payment_id / TID no payload.
    if (!recId && (t.tid || t.codigo_transacao)) {
      const tidLike = t.tid ? "%" + String(t.tid) + "%" : null;
      const hp = rowsOf(await db.execute(sql`
        SELECT order_id FROM hotsite_card_payments
        WHERE status = 'paid' AND abs(amount::numeric - ${bruto}) <= 0.011
          AND (payment_id = ${t.tid} OR merchant_order_id = ${t.codigo_transacao} OR (${tidLike}::text IS NOT NULL AND COALESCE(payload,'') LIKE ${tidLike}))
        LIMIT 2`));
      if (hp.length === 1 && hp[0].order_id) { recId = await recDoSalesCard(hp[0].order_id); if (recId) via = "loja_tid"; }
    }
    // 4) Rota / qualquer título em cartão: valor bruto + data da venda + forma.
    if (!recId && !note) {
      const cand = rowsOf(await db.execute(sql`
        SELECT r.id, r.title_number, r.status FROM receivables r
        WHERE r.deleted_at IS NULL
          AND abs(r.amount::numeric - ${bruto}) <= 0.011
          AND r.payment_method IN ('cartao', 'cartao_credito', 'cartao_debito')
          AND (${dAut}::date IS NULL OR (r.issue_date::date BETWEEN ${dAut}::date - 7 AND ${dAut}::date + 2)
               OR EXISTS (SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = r.id AND rp.paid_at::date BETWEEN ${dAut}::date - 2 AND ${dAut}::date + 2))
          AND NOT EXISTS (SELECT 1 FROM cielo_edi_transacoes x WHERE x.receivable_id = r.id AND COALESCE(x.parcela, 1) = COALESCE(${t.parcela}, 1) AND x.id <> ${t.id})
        ORDER BY r.issue_date DESC LIMIT 3`));
      if (cand.length === 1) { recId = cand[0].id; via = "valor_data"; }
      else if (cand.length > 1) note = `ambíguo: ${cand.length} títulos em cartão de ${bruto.toFixed(2)} perto de ${dAut || "?"}`;
      else note = "sem título em cartão com este valor/data";
    }
    if (recId) {
      await db.execute(sql`UPDATE cielo_edi_transacoes SET receivable_id = ${recId}, match_via = ${via}, match_note = null WHERE id = ${t.id}`);
      out.casadas++; out.porVia[via] = (out.porVia[via] || 0) + 1;
    } else {
      await db.execute(sql`UPDATE cielo_edi_transacoes SET match_note = ${note || "sem título"} WHERE id = ${t.id}`);
      if (note.startsWith("ambíguo")) out.ambiguas++; else out.semTitulo++;
    }
  }
  return out;
}
async function recDoSalesCard(salesCardId: string): Promise<string | null> {
  const r = rowsOf(await db.execute(sql`
    SELECT r.id FROM receivables r JOIN billing_pipeline bp ON bp.id = r.billing_pipeline_id
    WHERE bp.sales_card_id = ${salesCardId} AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1`))[0];
  return r?.id || null;
}

// ---------------------------------------------------------------------------
// CASAMENTO 2: UR (D) -> lançamento CIELO do BB
// ---------------------------------------------------------------------------
async function casarURs(): Promise<{ analisadas: number; sugeridas: number; semExtrato: number; ambiguas: number }> {
  const out = { analisadas: 0, sugeridas: 0, semExtrato: 0, ambiguas: 0 };
  const urs = rowsOf(await db.execute(sql`
    SELECT * FROM cielo_edi_ur WHERE opcao = '04' AND match_status IN ('pendente', 'sem_extrato', 'sugerido') AND liquido > 0
    ORDER BY data_pagamento LIMIT 1000`));
  for (const u of urs) {
    out.analisadas++;
    if (u.match_status === "sugerido" && u.bank_statement_item_id) {
      // já sugerido: confirma que o item continua pendente; senão volta a procurar.
      const it = rowsOf(await db.execute(sql`SELECT reconciliation_status FROM bank_statement_items WHERE id = ${u.bank_statement_item_id}`))[0];
      if (it && (it.reconciliation_status == null || it.reconciliation_status === "pending")) { out.sugeridas++; continue; }
    }
    const liq = Number(u.liquido);
    const dPag = u.data_pagamento ? dstr(u.data_pagamento) : null;
    const cand = rowsOf(await db.execute(sql`
      SELECT i.id, i.transaction_date, i.amount, i.description, s.financial_account_id
      FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
      WHERE (i.reconciliation_status IS NULL OR i.reconciliation_status = 'pending') AND i.mirror_of IS NULL
        AND i.type = 'C' AND abs(i.amount::numeric - ${liq}) <= 0.011
        AND i.description ~* 'cielo'
        AND (${u.financial_account_id}::text IS NULL OR s.financial_account_id = ${u.financial_account_id})
        AND (${dPag}::date IS NULL OR i.transaction_date::date BETWEEN ${dPag}::date - 1 AND ${dPag}::date + 2)
        AND NOT EXISTS (SELECT 1 FROM cielo_edi_ur x WHERE x.bank_statement_item_id = i.id AND x.id <> ${u.id} AND x.match_status IN ('sugerido','conciliado'))
      ORDER BY abs(i.transaction_date::date - COALESCE(${dPag}::date, i.transaction_date::date)), i.id LIMIT 5`));
    let esc = cand;
    if (esc.length > 1) {
      const quer = u.tipo_liquidacao === "001" ? /d.bito/i : /cr.dito/i;
      const f = esc.filter((c: any) => quer.test(String(c.description || ""))); if (f.length) esc = f;
    }
    if (esc.length > 1) {
      const f = esc.filter((c: any) => dstr(c.transaction_date) === dPag); if (f.length) esc = f;
    }
    if (esc.length === 1) {
      await db.execute(sql`UPDATE cielo_edi_ur SET bank_statement_item_id = ${esc[0].id}, financial_account_id = COALESCE(financial_account_id, ${esc[0].financial_account_id}), match_status = 'sugerido', match_note = null WHERE id = ${u.id}`);
      out.sugeridas++;
    } else if (esc.length === 0) {
      await db.execute(sql`UPDATE cielo_edi_ur SET bank_statement_item_id = null, match_status = 'sem_extrato', match_note = ${"nenhum crédito CIELO pendente de " + liq.toFixed(2) + " em " + brDate(u.data_pagamento) + " (importe o OFX/BB API do dia)"} WHERE id = ${u.id}`);
      out.semExtrato++;
    } else {
      await db.execute(sql`UPDATE cielo_edi_ur SET bank_statement_item_id = null, match_status = 'pendente', match_note = ${"ambíguo: " + esc.length + " créditos CIELO do mesmo valor"} WHERE id = ${u.id}`);
      out.ambiguas++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CONCILIAÇÃO: UR sugerida + todas as transações com título -> fecha a linha do BB
// ---------------------------------------------------------------------------
export async function conciliarURs(by: string, dryRun: boolean, urIds?: string[]): Promise<any> {
  if (!deps) throw new Error("cielo-edi sem dependências (registerCieloEdi não chamado)");
  await ensureCieloEdiSchema();
  const out: any = { candidatas: 0, conciliadas: 0, puladas: [] as any[], erros: [] as string[], plano: [] as any[] };
  const urs = rowsOf(await db.execute(sql`
    SELECT * FROM cielo_edi_ur WHERE opcao = '04' AND match_status = 'sugerido' AND bank_statement_item_id IS NOT NULL
      ${urIds && urIds.length ? sql`AND id IN (${sql.join(urIds.map((i) => sql`${i}`), sql`, `)})` : sql``}
    ORDER BY data_pagamento LIMIT 300`));
  const cartoesId = await contaCartoes();
  for (const u of urs) {
    out.candidatas++;
    try {
      const item = rowsOf(await db.execute(sql`
        SELECT i.*, s.financial_account_id AS s_account, s.omie_instance_id AS s_instance, s.id AS s_id
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id WHERE i.id = ${u.bank_statement_item_id}`))[0];
      if (!item) { out.puladas.push({ ur: u.id, motivo: "lançamento do extrato não existe mais" }); continue; }
      if (item.reconciliation_status === "reconciled") { out.puladas.push({ ur: u.id, motivo: "lançamento já conciliado por outro caminho" }); continue; }
      if (Math.abs(Number(item.amount) - Number(u.liquido)) > 0.011) { out.puladas.push({ ur: u.id, motivo: "valor do extrato difere do líquido da UR" }); continue; }
      const txs = rowsOf(await db.execute(sql`SELECT * FROM cielo_edi_transacoes WHERE ur_id = ${u.id} ORDER BY data_autorizacao, id`));
      if (!txs.length) { await nota(u.id, "UR sem transações (registro E) no arquivo"); out.puladas.push({ ur: u.id, motivo: "sem transações" }); continue; }
      const semTit = txs.filter((t: any) => !t.receivable_id);
      if (semTit.length) {
        const m = `${semTit.length} de ${txs.length} venda(s) sem título: ` + semTit.slice(0, 3).map((t: any) => `${(Number(t.valor_bruto_parcela || 0)).toFixed(2)} ${brDate(t.data_autorizacao)} (${t.match_note || "?"})`).join("; ");
        await nota(u.id, m); out.puladas.push({ ur: u.id, motivo: m }); continue;
      }
      const somaBruto = r2(txs.reduce((a: number, t: any) => a + Number(t.valor_bruto_parcela || 0), 0));
      if (Math.abs(somaBruto - Number(u.bruto)) > 0.02) {
        const m = `soma das vendas (${somaBruto.toFixed(2)}) ≠ bruto da UR (${Number(u.bruto).toFixed(2)})`;
        await nota(u.id, m); out.puladas.push({ ur: u.id, motivo: m }); continue;
      }
      const taxa = r2(Number(u.taxa));
      const liquido = r2(Number(u.liquido));
      if (Math.abs(r2(somaBruto - taxa) - liquido) > 0.02) {
        const m = `bruto − taxa (${r2(somaBruto - taxa).toFixed(2)}) ≠ líquido (${liquido.toFixed(2)})`;
        await nota(u.id, m); out.puladas.push({ ur: u.id, motivo: m }); continue;
      }
      // Agrupa por título (parcelas/várias transações do mesmo título somam).
      const porRec = new Map<string, { valor: number; txs: any[] }>();
      for (const t of txs) { const g = porRec.get(t.receivable_id) || { valor: 0, txs: [] }; g.valor = r2(g.valor + Number(t.valor_bruto_parcela || 0)); g.txs.push(t); porRec.set(t.receivable_id, g); }
      const metodo = metodoPorTipo(String(u.tipo_liquidacao || ""));
      const paidAtISO = new Date((dstr(u.data_pagamento) || dstr(item.transaction_date)) + "T12:00:00-03:00").toISOString();
      const accountId = item.s_account || u.financial_account_id || null;
      const plano: any[] = [];
      let transferirDeCartoes = 0;
      for (const [recId, g] of Array.from(porRec.entries())) {
        const rec: any = await storage.getReceivable(recId);
        if (!rec) throw new Error("título " + recId + " não encontrado");
        const aberto = r2(Number(rec.amount || 0) - Number(rec.amountPaid || 0));
        const quitado = aberto <= 0.005 || rec.status === "recebida";
        const emCartoes = quitado && cartoesId && rec.financialAccountId === cartoesId;
        if (emCartoes) transferirDeCartoes = r2(transferirDeCartoes + g.valor);
        plano.push({ recId, titulo: rec.titleNumber, nome: rec.customerName, valor: g.valor, modo: quitado ? "vincular" : "baixar", emCartoes: !!emCartoes, txs: g.txs.length });
      }
      out.plano.push({ ur: u.id, data: u.data_pagamento, tipo: tipoLiqNome(String(u.tipo_liquidacao || "")), bruto: somaBruto, taxa, liquido, item: item.id, titulos: plano, transferirDeCartoes });
      if (dryRun) continue;

      // ---- EXECUÇÃO ---------------------------------------------------------
      const feitos: any[] = [];
      let firstRecv: string | null = null;
      for (const p of plano) {
        if (p.modo === "baixar") {
          const r = await deps.settleReceivable(p.recId, p.valor, metodo, accountId, paidAtISO, by, { principal: p.valor, interest: 0, discount: 0 });
          feitos.push({ id: p.recId, kind: "receivable", ...r });
        } else feitos.push({ id: p.recId, kind: "receivable", via: "vinculo_sem_baixa", emCartoes: p.emCartoes });
        await db.execute(sql`
          INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
          VALUES (gen_random_uuid(), ${item.id}, ${p.recId}, ${null}, ${p.valor.toFixed(2)}, ${p.modo === "baixar" ? "cielo_auto" : "cielo_vinculo"}, ${p.modo === "baixar" ? p.valor.toFixed(2) : "0.00"}, ${"0.00"}, ${"0.00"}, ${by}, now())`);
        if (!firstRecv) firstRecv = p.recId;
      }
      // Taxa Cielo -> conta a pagar já baixada, vinculada ao mesmo lançamento.
      let payId: string | null = null;
      if (taxa > 0.004) {
        const chartId = await ensureTaxaCartaoChartAccount();
        const sup = await deps.ensureSupplier(CIELO_NOME, CIELO_CNPJ, item.s_instance || null, chartId, "Taxas de cartão", by);
        const dt = new Date(paidAtISO);
        const pay: any = await storage.createPayable({
          supplierName: sup.name || CIELO_NOME, supplierDocument: sup.document || CIELO_CNPJ,
          amount: taxa.toFixed(2), issueDate: dt as any, dueDate: dt as any,
          description: `Taxa Cielo — repasse ${tipoLiqNome(String(u.tipo_liquidacao || ""))} ${brDate(u.data_pagamento)} · ${txs.length} venda(s) · bruto R$ ${somaBruto.toFixed(2)}`.slice(0, 300),
          chartAccountId: chartId, omieInstanceId: item.s_instance || null, financialAccountId: accountId,
          status: "a_vencer", source: "manual", createdBy: by,
          notes: `Despesa financeira gerada pela conciliação do Extrato Eletrônico Cielo (UR ${u.id})`,
        } as any);
        payId = pay.id;
        await deps.settlePayable(pay.id, taxa, "transferencia", accountId, paidAtISO, by);
        await db.execute(sql`
          INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
          VALUES (gen_random_uuid(), ${item.id}, ${null}, ${pay.id}, ${taxa.toFixed(2)}, ${"cielo_taxa"}, ${taxa.toFixed(2)}, ${"0.00"}, ${"0.00"}, ${by}, now())`);
      }
      // Movimentos de conta (idempotentes por UR): BB +líquido; CARTOES −bruto dos títulos que já estavam lá.
      if (accountId) {
        await lancarNaConta({ accountId, tipo: "credito", valor: liquido, descricao: `Repasse Cielo ${tipoLiqNome(String(u.tipo_liquidacao || ""))} · ${txs.length} venda(s)`, sourceType: "cielo_repasse", sourceId: u.id, reference: u.id, omieInstanceId: item.s_instance || null, createdBy: by, idempotente: true });
      }
      if (transferirDeCartoes > 0 && cartoesId) {
        await lancarNaConta({ accountId: cartoesId, tipo: "debito", valor: transferirDeCartoes, descricao: `Transferência para o banco — repasse Cielo ${brDate(u.data_pagamento)}`, sourceType: "cielo_repasse_transf", sourceId: u.id, reference: u.id, omieInstanceId: item.s_instance || null, createdBy: by, idempotente: true });
      }
      const note = `Repasse Cielo conciliado automaticamente (Extrato Eletrônico) · ${txs.length} venda(s) · bruto R$ ${somaBruto.toFixed(2)} · taxa R$ ${taxa.toFixed(2)}`;
      await db.execute(sql`
        UPDATE bank_statement_items
        SET reconciliation_status = 'reconciled', matched_receivable_id = ${firstRecv}, matched_payable_id = ${payId},
            matched_at = now(), matched_by = ${by}, match_confidence = 100, notes = ${note}
        WHERE id = ${item.id}`);
      await db.execute(sql`UPDATE cielo_edi_ur SET match_status = 'conciliado', match_note = null, matched_at = now(), matched_by = ${by}, taxa_payable_id = ${payId} WHERE id = ${u.id}`);
      await deps.logReconAudit({ action: "reconcile", itemId: item.id, statementId: item.s_id || null, accountId, instanceId: item.s_instance || null, amount: Number(item.amount).toFixed(2), itemType: item.type || null, transactionDate: item.transaction_date || null, description: item.description || "", titles: plano, counterpart: { type: "cielo", name: CIELO_NOME, document: CIELO_CNPJ }, by, details: { kind: "cielo_edi", urId: u.id, bruto: somaBruto, taxa, liquido, transferirDeCartoes, taxaPayableId: payId, feitos } });
      out.conciliadas++;
    } catch (e: any) {
      const m = String(e?.message || e).slice(0, 200);
      out.erros.push(`UR ${u.id}: ${m}`);
      try { await nota(u.id, "erro: " + m); } catch {}
    }
  }
  return out;
}
const nota = (urId: string, m: string) => db.execute(sql`UPDATE cielo_edi_ur SET match_note = ${m.slice(0, 400)} WHERE id = ${urId}`);

// Roda os três passos. Chamado no fim de toda importação (OFX / BB API / EDI).
export async function casarTudo(by: string, dryRun: boolean): Promise<any> {
  await ensureCieloEdiSchema();
  const tx = await casarTransacoes();
  const ur = await casarURs();
  const conc = await conciliarURs(by, dryRun);
  return { transacoes: tx, urs: ur, conciliacao: { candidatas: conc.candidatas, conciliadas: conc.conciliadas, puladas: conc.puladas.length, erros: conc.erros } };
}
export async function cieloAposImportacao(by: string): Promise<any> {
  try { return await casarTudo(by, false); } catch (e: any) { console.warn("[cielo-edi] pós-importação falhou:", e?.message || e); return null; }
}

// "Desfazer" no lançamento do BB: estorna os movimentos de conta desta UR e a
// devolve para a fila (os títulos e a taxa já foram revertidos pelo undo geral).
export async function cieloAoDesfazer(itemId: string, by: string): Promise<void> {
  try {
    await ensureCieloEdiSchema();
    const urs = rowsOf(await db.execute(sql`SELECT id FROM cielo_edi_ur WHERE bank_statement_item_id = ${itemId} AND match_status = 'conciliado'`));
    for (const u of urs) {
      try { await estornarLancamento({ sourceType: "cielo_repasse", reference: u.id, motivo: "desfazer conciliação Cielo", por: by }); } catch {}
      try { await estornarLancamento({ sourceType: "cielo_repasse_transf", reference: u.id, motivo: "desfazer conciliação Cielo", por: by }); } catch {}
      await db.execute(sql`UPDATE cielo_edi_ur SET match_status = 'pendente', bank_statement_item_id = null, matched_at = null, matched_by = ${by}, taxa_payable_id = null, match_note = ${"conciliação desfeita por " + by} WHERE id = ${u.id}`);
    }
  } catch (e: any) { console.warn("[cielo-edi] aoDesfazer:", e?.message || e); }
}

// ---------------------------------------------------------------------------
// ROTAS
// ---------------------------------------------------------------------------
export function registerCieloEdi(app: Express, d: CieloDeps) {
  deps = d;
  const base = "/api/reconciliation/cielo-edi";

  // Importar (text = conteúdo do arquivo; dryRun = só prévia)
  app.post(base + "/import", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const text = String(req.body?.text || req.body?.ediText || "");
      if (!text.trim()) return res.status(400).json({ error: "text obrigatório (conteúdo do arquivo CIELO03/CIELO04)" });
      const by = String(req.body?.by || "conciliacao-2.0");
      const r = await importarCieloEdi(text, String(req.body?.fileName || ""), by, req.body?.dryRun === true);
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.get(base + "/arquivos", authenticateUser, requireRole(FIN_ROLES), async (_req, res) => {
    try {
      await ensureCieloEdiSchema();
      const rows = rowsOf(await db.execute(sql`
        SELECT a.*,
          (SELECT count(*)::int FROM cielo_edi_ur u WHERE u.arquivo_id = a.id AND u.match_status = 'conciliado') AS urs_conciliadas,
          (SELECT count(*)::int FROM cielo_edi_ur u WHERE u.arquivo_id = a.id AND u.match_status = 'sugerido') AS urs_sugeridas,
          (SELECT count(*)::int FROM cielo_edi_ur u WHERE u.arquivo_id = a.id AND u.match_status IN ('pendente','sem_extrato')) AS urs_pendentes,
          (SELECT count(*)::int FROM cielo_edi_transacoes t WHERE t.arquivo_id = a.id AND t.receivable_id IS NOT NULL) AS tx_casadas,
          m.descricao AS ec_descricao, fa.name AS account_name
        FROM cielo_edi_arquivos a LEFT JOIN cielo_ec m ON m.ec = a.ec LEFT JOIN financial_accounts fa ON fa.id = m.financial_account_id
        ORDER BY a.created_at DESC LIMIT 200`));
      res.json({ arquivos: rows });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // URs (todas ou de um arquivo) com suas transações e o título de cada uma.
  app.get(base + "/urs", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureCieloEdiSchema();
      const arquivoId = (req.query.arquivoId as string) || null;
      const status = (req.query.status as string) || null;
      const urs = rowsOf(await db.execute(sql`
        SELECT u.*, i.reconciliation_status AS item_status, i.transaction_date AS item_date, i.amount AS item_amount, i.description AS item_desc,
               fa.name AS account_name, a.file_name
        FROM cielo_edi_ur u
        LEFT JOIN bank_statement_items i ON i.id = u.bank_statement_item_id
        LEFT JOIN financial_accounts fa ON fa.id = u.financial_account_id
        LEFT JOIN cielo_edi_arquivos a ON a.id = u.arquivo_id
        WHERE (${arquivoId}::text IS NULL OR u.arquivo_id = ${arquivoId})
          AND (${status}::text IS NULL OR u.match_status = ${status})
        ORDER BY u.data_pagamento DESC NULLS LAST, u.created_at DESC LIMIT 500`));
      const ids = urs.map((u: any) => u.id);
      let txs: any[] = [];
      if (ids.length) {
        txs = rowsOf(await db.execute(sql`
          SELECT t.*, r.title_number, r.customer_name, r.status AS rec_status, r.amount AS rec_amount, r.payment_method AS rec_method, r.financial_account_id AS rec_account
          FROM cielo_edi_transacoes t LEFT JOIN receivables r ON r.id = t.receivable_id
          WHERE t.ur_id IN (${sql.join(ids.map((i: string) => sql`${i}`), sql`, `)})
          ORDER BY t.data_autorizacao, t.id`));
      }
      const porUr: Record<string, any[]> = {};
      for (const t of txs) { const { raw, ...rest } = t; (porUr[t.ur_id] ||= []).push(rest); }
      res.json({ urs: urs.map(({ raw, ...u }: any) => ({ ...u, tipo: tipoLiqNome(String(u.tipo_liquidacao || "")), transacoes: porUr[u.id] || [] })) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Mapa {bank_statement_item_id: resumo} das URs sugeridas/conciliadas — a tela
  // usa para mostrar "Repasse Cielo · N vendas · taxa" na coluna Título/Sugestão.
  app.get(base + "/sugestoes", authenticateUser, requireRole(FIN_ROLES), async (_req, res) => {
    try {
      await ensureCieloEdiSchema();
      const urs = rowsOf(await db.execute(sql`
        SELECT u.id, u.bank_statement_item_id, u.tipo_liquidacao, u.bruto, u.taxa, u.liquido, u.match_status, u.match_note, u.data_pagamento,
               (SELECT count(*)::int FROM cielo_edi_transacoes t WHERE t.ur_id = u.id) AS vendas,
               (SELECT count(*)::int FROM cielo_edi_transacoes t WHERE t.ur_id = u.id AND t.receivable_id IS NOT NULL) AS vendas_com_titulo,
               (SELECT string_agg(DISTINCT COALESCE(r.title_number, '?'), ', ') FROM cielo_edi_transacoes t JOIN receivables r ON r.id = t.receivable_id WHERE t.ur_id = u.id) AS titulos
        FROM cielo_edi_ur u WHERE u.bank_statement_item_id IS NOT NULL AND u.match_status IN ('sugerido', 'conciliado')`));
      const map: Record<string, any> = {};
      for (const u of urs) map[u.bank_statement_item_id] = { urId: u.id, tipo: tipoLiqNome(String(u.tipo_liquidacao || "")), bruto: u.bruto, taxa: u.taxa, liquido: u.liquido, status: u.match_status, nota: u.match_note, vendas: u.vendas, vendasComTitulo: u.vendas_com_titulo, titulos: u.titulos };
      res.json({ porItem: map });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Rodar o casamento/conciliação (dryRun por padrão, como os outros botões).
  app.post(base + "/conciliar", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = String(req.body?.by || "conciliacao-2.0");
      const urIds: string[] | undefined = Array.isArray(req.body?.urIds) ? req.body.urIds.map(String) : undefined;
      await ensureCieloEdiSchema();
      const tx = await casarTransacoes();
      const ur = await casarURs();
      const conc = await conciliarURs(by, dryRun, urIds);
      res.json({ dryRun, transacoes: tx, urs: ur, ...conc });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Vincular manualmente uma transação a um título (caso ambíguo) / desvincular.
  app.post(base + "/transacoes/:id/vincular", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureCieloEdiSchema();
      const recId = req.body?.receivableId ? String(req.body.receivableId) : null;
      if (recId) {
        const rec: any = await storage.getReceivable(recId);
        if (!rec) return res.status(404).json({ error: "título não encontrado" });
      }
      await db.execute(sql`UPDATE cielo_edi_transacoes SET receivable_id = ${recId}, match_via = ${recId ? "manual" : null}, match_note = ${recId ? null : "desvinculado manualmente"} WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Ignorar / reabrir uma UR (ex.: ajuste que não corresponde a venda).
  app.post(base + "/urs/:id/status", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureCieloEdiSchema();
      const st = String(req.body?.status || "");
      if (!["ignorado", "pendente"].includes(st)) return res.status(400).json({ error: "status deve ser ignorado ou pendente" });
      const u = rowsOf(await db.execute(sql`SELECT match_status FROM cielo_edi_ur WHERE id = ${req.params.id}`))[0];
      if (!u) return res.status(404).json({ error: "UR não encontrada" });
      if (u.match_status === "conciliado") return res.status(409).json({ error: "UR conciliada: desfaça pelo lançamento do extrato" });
      await db.execute(sql`UPDATE cielo_edi_ur SET match_status = ${st}, bank_statement_item_id = ${st === "pendente" ? null : sql`bank_statement_item_id`}, match_note = ${String(req.body?.motivo || "").slice(0, 300) || null}, matched_by = ${String(req.body?.by || "")} WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Remover um arquivo importado (recusa se alguma UR dele já foi conciliada).
  app.post(base + "/arquivos/:id/delete", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureCieloEdiSchema();
      const n = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM cielo_edi_ur WHERE arquivo_id = ${req.params.id} AND match_status = 'conciliado'`))[0]?.n || 0;
      if (n > 0) return res.status(409).json({ error: `${n} UR(s) deste arquivo já conciliada(s): desfaça no extrato antes de remover` });
      await db.execute(sql`DELETE FROM cielo_edi_transacoes WHERE arquivo_id = ${req.params.id}`);
      await db.execute(sql`DELETE FROM cielo_edi_ur WHERE arquivo_id = ${req.params.id}`);
      await db.execute(sql`DELETE FROM cielo_edi_arquivos WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Mapa EC -> conta financeira / instância / taxas contratadas.
  app.get("/api/reconciliation/cielo-ec", authenticateUser, requireRole(FIN_ROLES), async (_req, res) => {
    try {
      await ensureCieloEdiSchema();
      const rows = rowsOf(await db.execute(sql`
        SELECT m.*, fa.name AS account_name FROM cielo_ec m LEFT JOIN financial_accounts fa ON fa.id = m.financial_account_id ORDER BY m.ec`));
      res.json({ ecs: rows });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });
  app.post("/api/reconciliation/cielo-ec", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureCieloEdiSchema();
      const ec = soDig(String(req.body?.ec || ""));
      if (!ec) return res.status(400).json({ error: "ec obrigatório" });
      const accountId = req.body?.financialAccountId ? String(req.body.financialAccountId) : null;
      let instanceId = req.body?.omieInstanceId ? String(req.body.omieInstanceId) : null;
      if (accountId && !instanceId) {
        const fa = rowsOf(await db.execute(sql`SELECT omie_instance_id FROM financial_accounts WHERE id = ${accountId}`))[0];
        instanceId = fa?.omie_instance_id || null;
      }
      const numOrNull = (v: any) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
      await db.execute(sql`
        INSERT INTO cielo_ec (ec, descricao, financial_account_id, omie_instance_id, taxa_debito, taxa_credito, taxa_parcelado, updated_at)
        VALUES (${ec}, ${String(req.body?.descricao || "").slice(0, 120) || null}, ${accountId}, ${instanceId}, ${numOrNull(req.body?.taxaDebito)}, ${numOrNull(req.body?.taxaCredito)}, ${numOrNull(req.body?.taxaParcelado)}, now())
        ON CONFLICT (ec) DO UPDATE SET descricao = COALESCE(EXCLUDED.descricao, cielo_ec.descricao), financial_account_id = EXCLUDED.financial_account_id, omie_instance_id = EXCLUDED.omie_instance_id,
          taxa_debito = EXCLUDED.taxa_debito, taxa_credito = EXCLUDED.taxa_credito, taxa_parcelado = EXCLUDED.taxa_parcelado, updated_at = now()`);
      // Propaga a conta para URs ainda não conciliadas deste EC.
      if (accountId) await db.execute(sql`UPDATE cielo_edi_ur SET financial_account_id = ${accountId} WHERE ec = ${ec} AND match_status <> 'conciliado'`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });
}
