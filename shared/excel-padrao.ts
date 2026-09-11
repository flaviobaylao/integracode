// shared/excel-padrao.ts
// ============================================================================
// PADRAO UNICO de exportacao para Excel do INTEGRA 2.0 (nucleo compartilhado
// entre o navegador -- client/src/lib/excelExport.ts -- e o servidor --
// server/excel-export.ts).
// Toda saida .xlsx do sistema passa por aqui para sair com a mesma cara:
//   - cabecalho em NEGRITO, centralizado (horizontal + vertical) e com quebra
//     de linha, em linha mais alta;
//   - PRIMEIRA LINHA CONGELADA (o cabecalho acompanha a rolagem);
//   - largura de cada coluna ajustada ao conteudo;
//   - colunas de dinheiro no formato contabil R$ (o "R$" encosta na esquerda
//     da celula e o numero alinha na direita);
//   - CPF/CNPJ, telefone, CEP, nº de titulo/pedido/NF como TEXTO, preservando
//     zeros a esquerda e sem separador de milhar;
//   - inteiros com separador de milhar, decimais com 2 casas;
//   - sem preenchimento de fundo e sem bordas: fica a grade padrao do Excel,
//     igual ao modelo aprovado.
//
// POR QUE TEM CODIGO DE ZIP AQUI: o SheetJS/xlsx-js-style (0.18.5) NAO escreve
// painel congelado -- ele emite <sheetView workbookViewId="0"/> sem <pane>, e
// ignora ws["!freeze"]. Como o .xlsx e um zip e essa biblioteca grava TODAS as
// entradas sem compressao (STORED), da para reescrever o zip injetando o <pane>
// no XML da planilha. Se qualquer coisa fugir do esperado, `congelarCabecalho`
// devolve o arquivo original intacto -- a exportacao nunca quebra por causa do
// congelamento.
// ============================================================================
import * as XLSX from "xlsx-js-style";

export type FormatoColuna = "auto" | "moeda" | "inteiro" | "decimal" | "percentual" | "texto" | "geral";

export type OpcoesExcel = {
  /** Nome da aba. Padrao: "Dados". */
  aba?: string;
  /** Força o formato de colunas especificas, pelo titulo exato do cabecalho. */
  formatos?: Record<string, FormatoColuna>;
  /** Congela a linha do cabecalho. Padrao: true. */
  congelar?: boolean;
  /** Liga o auto-filtro (setinhas no cabecalho). Padrao: false. */
  filtro?: boolean;
  /** Deixa a ultima linha em negrito (linha de "Total"). Padrao: false. */
  negritoUltimaLinha?: boolean;
};

export type AbaExcel = { nome: string; linhas: Record<string, any>[]; opcoes?: OpcoesExcel };

// Formato contabil BRL: "R$" na esquerda, numero na direita, zero como "-".
const FMT_MOEDA = '_-"R$"\\ * #,##0.00_-;\\-"R$"\\ * #,##0.00_-;_-"R$"\\ * "-"??_-;_-@_-';
const FMT_INTEIRO = "#,##0";
const FMT_DECIMAL = "#,##0.00";
const FMT_PERCENTUAL = "#,##0.0";
const FMT_TEXTO = "@";

const LARGURA_MIN = 6;
const LARGURA_MAX = 46;

const semAcento = (s: any) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Identificadores: viram TEXTO para nao perder zero a esquerda nem ganhar
// separador de milhar (CPF/CNPJ, telefone, CEP, nº de titulo/pedido/NF...).
// "titulo" e singular de proposito: "Titulos medidos" e contagem, nao numero.
const RE_TEXTO =
  /cpf|cnpj|\bdocumento\b|\bdoc\b|telefone|celular|whatsapp|\bcep\b|\bcodigo\b|\bchave\b|inscricao|\bie\b|\brg\b|\btitulo\b|\bpedido\b|\bnf\b|\bnfe\b|nota fiscal|matricula|\bagencia\b|codigo de barras|protocolo|\bplaca\b|\bcoordenadas\b/;

// Contadores e medidas que NAO sao dinheiro, mesmo tendo palavra de dinheiro
// no meio do titulo. Ancorado no comeco do titulo para nao derrubar casos como
// "Media 3 meses" (que e faturamento medio).
const RE_NAO_MOEDA =
  /^(#|n[ºo°]|qtd|quantidade|numero|dias|meses|semanas|itens|pecas|unidades|total de)\b|\bqtd\b|quantidade de|\(dias\)|\(un\)|\(kg\)/;

const RE_MOEDA =
  /(^|[^a-z])r\$|\bvalor|faturamento|\bfatur|receita|\bmedia\b|\bmedias\b|media\s|ticket|\bpreco|\bcusto|\bsaldo|\bdebito|\bdivida|\bpago\b|pagamento|cobranca|\blucro|\bmargem|potencial|montante|\baporte|\bcmv\b|comissao|desconto|\bfrete|mensalidade|limite de credito|\bmulta\b|\bjuros\b|\bbruto\b|\bliquido\b/;

const RE_PERCENTUAL = /%|percentual|pontualidade|aderencia|conversao|\btaxa\b/;

const ehNumero = (v: any) => typeof v === "number" && Number.isFinite(v);
const vazio = (v: any) => v === null || v === undefined || v === "";

/** Decide o formato de uma coluna a partir do titulo e dos valores presentes. */
function detectarFormato(titulo: string, valores: any[]): FormatoColuna {
  const h = semAcento(titulo);
  const numericos = valores.filter(ehNumero);
  const temTexto = valores.some((v) => typeof v === "string" && v !== "");

  if (RE_PERCENTUAL.test(h) && numericos.length > 0) return "percentual";
  if (RE_TEXTO.test(h)) return "texto";
  if (numericos.length === 0) return "geral";
  if (RE_MOEDA.test(h) && !RE_NAO_MOEDA.test(h)) return "moeda";
  if (temTexto) return "geral";
  return numericos.every((n) => Number.isInteger(n)) ? "inteiro" : "decimal";
}

function numFmtDe(f: FormatoColuna): string | null {
  if (f === "moeda") return FMT_MOEDA;
  if (f === "inteiro") return FMT_INTEIRO;
  if (f === "decimal") return FMT_DECIMAL;
  if (f === "percentual") return FMT_PERCENTUAL;
  if (f === "texto") return FMT_TEXTO;
  return null;
}

/** Quanto a celula ocupa na tela depois de formatada (em caracteres). */
function larguraDoValor(v: any, f: FormatoColuna): number {
  if (vazio(v)) return 0;
  if (ehNumero(v)) {
    const casas = f === "inteiro" ? 0 : f === "percentual" ? 1 : 2;
    const txt = Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
    // No formato contabil o "R$" e os recuos das pontas ocupam ~4 caracteres.
    return txt.length + (v < 0 ? 1 : 0) + (f === "moeda" ? 4 : 0);
  }
  return String(v).length;
}

/** Maior palavra do titulo: abaixo disso a quebra de linha corta a palavra. */
function maiorPalavra(titulo: string): number {
  return String(titulo || "")
    .split(/\s+/)
    .reduce((m, p) => Math.max(m, p.length), 0);
}

/** Colunas na ordem de aparicao, considerando todas as linhas. */
function colunasDe(linhas: Record<string, any>[]): string[] {
  const cols: string[] = [];
  const vistas = new Set<string>();
  for (const l of linhas) {
    for (const k of Object.keys(l || {})) {
      if (!vistas.has(k)) { vistas.add(k); cols.push(k); }
    }
  }
  return cols;
}

/** Monta a planilha ja no padrao visual do INTEGRA. */
export function montarPlanilha(linhas: Record<string, any>[], opcoes?: OpcoesExcel) {
  const dados = Array.isArray(linhas) ? linhas : [];
  const cols = colunasDe(dados);
  const formatos: FormatoColuna[] = cols.map((c) => {
    const forcado = opcoes?.formatos?.[c];
    if (forcado && forcado !== "auto") return forcado;
    return detectarFormato(c, dados.map((l) => (l || {})[c]));
  });

  // Colunas de identificador saem como texto puro -- string, nunca numero.
  const linhasSaida = dados.map((l) => {
    const saida: Record<string, any> = {};
    cols.forEach((c, i) => {
      const v = (l || {})[c];
      saida[c] = formatos[i] === "texto" && !vazio(v) ? String(v) : v;
    });
    return saida;
  });

  const ws = XLSX.utils.json_to_sheet(linhasSaida, { header: cols });
  const ref = XLSX.utils.decode_range(ws["!ref"] || "A1");
  const ultimaLinha = Math.max(ref.e.r, 0);

  const estiloCabecalho = {
    font: { bold: true },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
  } as any;

  const larguras: number[] = [];
  cols.forEach((titulo, c) => {
    const numFmt = numFmtDe(formatos[c]);
    // Cabecalho
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = estiloCabecalho;
    // Corpo
    let maiorDado = 0;
    for (let r = 1; r <= ultimaLinha; r++) {
      const cel = ws[XLSX.utils.encode_cell({ r, c })];
      const bruto = (dados[r - 1] || {})[titulo];
      maiorDado = Math.max(maiorDado, larguraDoValor(cel ? cel.v : bruto, formatos[c]));
      if (!cel) continue;
      cel.s = { alignment: { vertical: "center" }, ...(numFmt ? { numFmt } : {}) } as any;
      if (numFmt) cel.z = numFmt;
    }
    larguras[c] = Math.min(
      LARGURA_MAX,
      Math.max(LARGURA_MIN, maiorPalavra(titulo) + 2, Math.min(maiorDado + 2, LARGURA_MAX)),
    );
  });

  if (opcoes?.negritoUltimaLinha && ultimaLinha >= 1) {
    for (let c = 0; c < cols.length; c++) {
      const cel = ws[XLSX.utils.encode_cell({ r: ultimaLinha, c })];
      if (cel) cel.s = { ...(cel.s || {}), font: { ...((cel.s || {}).font || {}), bold: true } };
    }
  }

  ws["!cols"] = larguras.map((wch) => ({ wch }));

  // Altura do cabecalho: cresce ate 3 linhas conforme o titulo quebra.
  const linhasCabecalho = cols.reduce((m, titulo, c) => {
    const porLinha = Math.max(1, larguras[c] - 1);
    return Math.max(m, Math.min(3, Math.ceil(String(titulo || "").length / porLinha)));
  }, 1);
  ws["!rows"] = [{ hpt: Math.max(30, 14 * linhasCabecalho + 8) }];

  if (opcoes?.filtro && cols.length > 0) ws["!autofilter"] = { ref: ws["!ref"] as string };

  return ws;
}

// ── Congelamento do cabecalho (reescrita do zip) ─────────────────────────────

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PANE =
  '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
  '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';

/** Injeta <pane state="frozen"> no XML da planilha. */
function comPainelCongelado(xml: string): string {
  if (xml.indexOf("<pane ") >= 0) return xml;
  const auto = xml.replace(/<sheetView([^>]*?)\/>/, (_m, attrs) => `<sheetView${attrs}>${PANE}</sheetView>`);
  if (auto !== xml) return auto;
  return xml.replace(/<sheetView([^>]*?)>/, (_m, attrs) => `<sheetView${attrs}>${PANE}`);
}

type EntradaZip = { nome: Uint8Array; metodo: number; crc: number; hora: number; data: number; bytes: Uint8Array };

/**
 * Reescreve o .xlsx com a primeira linha congelada. Devolve o arquivo original
 * se o zip nao for do formato esperado (entradas comprimidas, EOCD ausente...).
 */
export function congelarCabecalho(origem: Uint8Array): Uint8Array {
  try {
    const dv = new DataView(origem.buffer, origem.byteOffset, origem.byteLength);
    const u16 = (p: number) => dv.getUint16(p, true);
    const u32 = (p: number) => dv.getUint32(p, true);

    // Fim do diretorio central (EOCD), procurado de tras para frente.
    let eocd = -1;
    for (let p = origem.length - 22; p >= 0 && p >= origem.length - 22 - 0xffff; p--) {
      if (u32(p) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) return origem;

    const total = u16(eocd + 10);
    let p = u32(eocd + 16);
    const entradas: EntradaZip[] = [];

    for (let i = 0; i < total; i++) {
      if (u32(p) !== 0x02014b50) return origem;
      const metodo = u16(p + 10);
      if (metodo !== 0) return origem; // so reescrevemos zip sem compressao
      const hora = u16(p + 12);
      const data = u16(p + 14);
      const crc = u32(p + 16);
      const tamanho = u32(p + 20);
      const nLen = u16(p + 28);
      const eLen = u16(p + 30);
      const cLen = u16(p + 32);
      const offLocal = u32(p + 42);
      const nome = origem.subarray(p + 46, p + 46 + nLen);
      if (u32(offLocal) !== 0x04034b50) return origem;
      const inicio = offLocal + 30 + u16(offLocal + 26) + u16(offLocal + 28);
      entradas.push({ nome, metodo, crc, hora, data, bytes: origem.subarray(inicio, inicio + tamanho) });
      p += 46 + nLen + eLen + cLen;
    }

    const dec = new TextDecoder();
    const enc = new TextEncoder();
    let mexeu = false;
    for (const e of entradas) {
      const nome = dec.decode(e.nome);
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(nome)) continue;
      const xml = dec.decode(e.bytes);
      const novo = comPainelCongelado(xml);
      if (novo === xml) continue;
      e.bytes = enc.encode(novo);
      e.crc = crc32(e.bytes);
      mexeu = true;
    }
    if (!mexeu) return origem;

    // Remonta o zip inteiro (tudo STORED), recalculando os deslocamentos.
    let tamanhoTotal = 22;
    for (const e of entradas) tamanhoTotal += 30 + e.nome.length + e.bytes.length + 46 + e.nome.length;
    const saida = new Uint8Array(tamanhoTotal);
    const sv = new DataView(saida.buffer);
    const p16 = (pos: number, v: number) => sv.setUint16(pos, v, true);
    const p32 = (pos: number, v: number) => sv.setUint32(pos, v, true);

    let off = 0;
    const offsets: number[] = [];
    for (const e of entradas) {
      offsets.push(off);
      p32(off, 0x04034b50); p16(off + 4, 20); p16(off + 6, 0); p16(off + 8, 0);
      p16(off + 10, e.hora); p16(off + 12, e.data);
      p32(off + 14, e.crc); p32(off + 18, e.bytes.length); p32(off + 22, e.bytes.length);
      p16(off + 26, e.nome.length); p16(off + 28, 0);
      saida.set(e.nome, off + 30);
      saida.set(e.bytes, off + 30 + e.nome.length);
      off += 30 + e.nome.length + e.bytes.length;
    }

    const inicioCd = off;
    entradas.forEach((e, i) => {
      p32(off, 0x02014b50); p16(off + 4, 20); p16(off + 6, 20); p16(off + 8, 0); p16(off + 10, 0);
      p16(off + 12, e.hora); p16(off + 14, e.data);
      p32(off + 16, e.crc); p32(off + 20, e.bytes.length); p32(off + 24, e.bytes.length);
      p16(off + 28, e.nome.length); p16(off + 30, 0); p16(off + 32, 0);
      p16(off + 34, 0); p16(off + 36, 0); p32(off + 38, 0);
      p32(off + 42, offsets[i]);
      saida.set(e.nome, off + 46);
      off += 46 + e.nome.length;
    });

    p32(off, 0x06054b50); p16(off + 4, 0); p16(off + 6, 0);
    p16(off + 8, entradas.length); p16(off + 10, entradas.length);
    p32(off + 12, off - inicioCd); p32(off + 16, inicioCd); p16(off + 20, 0);

    return saida;
  } catch {
    return origem;
  }
}

/** Gera os bytes finais do .xlsx (ja com o cabecalho congelado). */
export function bytesDoWorkbook(wb: any, congelar = true): Uint8Array {
  const bruto = new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
  return congelar ? congelarCabecalho(bruto) : bruto;
}

/** Workbook de uma aba so, no padrao. */
export function workbookDeLinhas(linhas: Record<string, any>[], opcoes?: OpcoesExcel) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, montarPlanilha(linhas, opcoes), (opcoes?.aba || "Dados").slice(0, 31));
  return wb;
}

/** Workbook de varias abas, todas no padrao. */
export function workbookDeAbas(abas: AbaExcel[]) {
  const wb = XLSX.utils.book_new();
  abas.forEach((aba, i) => {
    XLSX.utils.book_append_sheet(wb, montarPlanilha(aba.linhas, aba.opcoes), (aba.nome || `Aba ${i + 1}`).slice(0, 31));
  });
  return wb;
}
