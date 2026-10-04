// server/comodato-pdf.ts
// -----------------------------------------------------------------------------
// CONTRATO DE COMODATO EM PDF — 04/out/2026
//
// Gera o instrumento particular de comodato (freezer/geladeira) a partir dos
// dados do cadastro, no mesmo texto dos contratos físicos que a PURO usa
// (8 cláusulas: objeto, prazo indeterminado, devolução, exclusividade com
// multa, despesas, não remoção, valor do bem, foro Goiânia), com linhas de
// assinatura do comodante, do comodatário e de duas testemunhas com CPF.
//
// Duas entradas:
//   GET  /api/comodatos/:id/contrato.pdf  → contrato já salvo
//   POST /api/comodatos/contrato.pdf      → a partir do formulário (antes de salvar)
// O texto é o mesmo nos dois casos: montarContratoComodatoPdf(dados).
// -----------------------------------------------------------------------------
import { jsPDF } from "jspdf";

export type DadosContrato = {
  codigo?: string | null;
  comodanteRazao?: string | null;
  comodanteCnpj?: string | null;
  signatarioComodante?: string | null;
  comodatarioRazao?: string | null;
  comodatarioCnpj?: string | null;
  apelidoPonto?: string | null;
  signatarioComodatario?: string | null;
  enderecoInstalacao?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
  equipamentoTipo?: string | null;
  marca?: string | null;
  modelo?: string | null;
  numeroSerie?: string | null;
  codigoProduto?: string | null;
  tensao?: string | null;
  volumeLitros?: number | string | null;
  volumeBrutoLitros?: number | string | null;
  valorBem?: number | string | null;
  dataContrato?: string | null; // YYYY-MM-DD
  usado?: boolean;
};

const COMODANTE = {
  razao: "PURO INDUSTRIA E COMERCIO DE PRODUTOS NATURAIS LTDA",
  cnpj: "28.295.493/0001-53",
  endereco: "ROD BELA VISTA DE GOIAS - CRISTIANOPOLIS - KM 08, BELA VISTA DE GOIÁS-GO, ZONA RURAL, CEP: 75.240-000",
};
export const SIGNATARIO_COMODANTE_PADRAO = "Flavio Evangelista Baylão Neto";

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

const v = (x: any) => (x == null ? "" : String(x).trim());
const ou = (x: any, branco: string) => (v(x) ? v(x) : branco);

function brl(n: any): string {
  const num = Number(n);
  if (!isFinite(num)) return "";
  return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// valor por extenso (reais e centavos) — suficiente para valores de equipamento
function extenso(n: number): string {
  const u = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
  const d = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
  const c = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
  const ate999 = (x: number): string => {
    if (x === 0) return "";
    if (x === 100) return "cem";
    const p: string[] = [];
    if (x >= 100) p.push(c[Math.floor(x / 100)]);
    const r = x % 100;
    if (r < 20) { if (r) p.push(u[r]); }
    else { p.push(d[Math.floor(r / 10)]); if (r % 10) p.push(u[r % 10]); }
    return p.join(" e ");
  };
  const inteiro = Math.floor(Math.abs(n));
  const cent = Math.round((Math.abs(n) - inteiro) * 100);
  const partes: string[] = [];
  const mil = Math.floor(inteiro / 1000), resto = inteiro % 1000;
  if (mil) partes.push(mil === 1 ? "mil" : `${ate999(mil)} mil`);
  if (resto) partes.push(ate999(resto));
  let txt = partes.join(resto && resto < 100 ? " e " : " ");
  txt = inteiro === 0 ? "zero reais" : `${txt} ${inteiro === 1 ? "real" : "reais"}`;
  if (cent) txt += ` e ${ate999(cent)} ${cent === 1 ? "centavo" : "centavos"}`;
  return txt;
}

function dataExtenso(iso?: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "_____ de ______________ de 20____";
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} de ${MESES[m - 1]} de ${y}`;
}

// Ajudantes de layout compartilhados pelo contrato e pelo distrato.
function novoDoc() {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const ML = 22, MR = 22, MT = 22, MB = 20;
  const LW = W - ML - MR;
  let y = MT;

  const garantir = (h: number) => {
    if (y + h > H - MB) { doc.addPage(); y = MT; }
  };
  const paragrafo = (texto: string, opts: { bold?: boolean; size?: number; align?: "left" | "center" | "right" | "justify"; gap?: number } = {}) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.size ?? 10.5);
    const linhas: string[] = doc.splitTextToSize(texto, LW);
    const lh = (opts.size ?? 10.5) * 0.47;
    for (const l of linhas) {
      garantir(lh);
      if (opts.align === "center") doc.text(l, W / 2, y, { align: "center" });
      else if (opts.align === "right") doc.text(l, W - MR, y, { align: "right" });
      else if (opts.align === "justify") doc.text(l, ML, y, { align: "justify", maxWidth: LW } as any);
      else doc.text(l, ML, y);
      y += lh;
    }
    y += opts.gap ?? 4;
  };
  // parágrafo com um trecho inicial em negrito (ex.: "CLÁUSULA 1º.") — jsPDF não mistura
  // estilos numa linha, então escreve o rótulo e continua o texto na mesma linha.
  const clausula = (rotulo: string, texto: string) => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    const wRot = doc.getTextWidth(rotulo + " ");
    doc.setFont("helvetica", "normal");
    const primeira: string[] = doc.splitTextToSize(texto, LW - wRot);
    const resto: string[] = primeira.length > 1 ? doc.splitTextToSize(primeira.slice(1).join(" "), LW) : [];
    const lh = 10.5 * 0.47;
    garantir(lh * 2);
    doc.setFont("helvetica", "bold"); doc.text(rotulo, ML, y);
    doc.setFont("helvetica", "normal"); doc.text(primeira[0] || "", ML + wRot, y);
    y += lh;
    for (const l of resto) { garantir(lh); doc.text(l, ML, y); y += lh; }
    y += 5;
  };
  const linhaAssinatura = (titulo: string, sub: string[], nomeSig?: string) => {
    garantir(30);
    y += 10;
    doc.setLineWidth(0.3);
    doc.line(ML, y, ML + LW * 0.78, y);
    y += 4.5;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text(titulo, ML, y); y += 4.5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    for (const s of sub) { doc.text(s, ML, y); y += 4.2; }
    if (v(nomeSig)) { doc.text(`Representante: ${v(nomeSig)}`, ML, y); y += 4.2; }
    y += 2;
  };
  const testemunhas = () => {
    garantir(50);
    y += 6;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    doc.text("TESTEMUNHAS", ML, y); y += 12;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    for (const n of ["1", "2"]) {
      garantir(22);
      doc.line(ML + 6, y, ML + LW * 0.6, y);
      doc.text(n, ML, y);
      y += 4.5;
      doc.text("Nome:", ML + 6, y);
      doc.text("CPF: ____________________", ML + LW * 0.6 - 48, y);
      y += 12;
    }
  };
  const finalizar = (rodape: string): Buffer => {
    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
      doc.setTextColor(120);
      doc.text(`${rodape} · página ${p}/${total}`, W / 2, H - 9, { align: "center" });
      doc.setTextColor(0);
    }
    return Buffer.from(doc.output("arraybuffer"));
  };
  const espaco = (h: number) => { y += h; };
  return { garantir, paragrafo, clausula, linhaAssinatura, testemunhas, finalizar, espaco };
}

function nomesEquip(dados: DadosContrato) {
  const tipo = (v(dados.equipamentoTipo) || "freezer").toLowerCase();
  return {
    tipoTitulo: tipo === "geladeira" ? "GELADEIRA" : tipo === "visa_cooler" ? "VISA COOLER" : "FREEZER",
    artigo: tipo === "geladeira" ? "uma" : "um",
    nomeEquip: tipo === "geladeira" ? "Geladeira" : tipo === "visa_cooler" ? "Visa Cooler" : "Freezer",
    pronome: tipo === "geladeira" ? "a" : "o",
  };
}

function descricaoEquip(dados: DadosContrato): string {
  const specs: string[] = [];
  if (v(dados.marca)) specs.push(`da marca ${v(dados.marca)}`);
  if (v(dados.modelo)) specs.push(`modelo: ${v(dados.modelo)}`);
  if (v(dados.numeroSerie)) specs.push(`número de série: ${v(dados.numeroSerie)}`);
  if (v(dados.codigoProduto)) specs.push(`Cód.: ${v(dados.codigoProduto)}`);
  if (v(dados.tensao)) specs.push(`Tensão: ${v(dados.tensao)}`);
  if (v(dados.volumeLitros)) specs.push(`Volume: ${v(dados.volumeLitros)}Lts`);
  if (v(dados.volumeBrutoLitros)) specs.push(`Volume Bruto: ${v(dados.volumeBrutoLitros)}Lts`);
  return specs.join(", ");
}

function enderecoInstalacao(dados: DadosContrato): string {
  return [v(dados.enderecoInstalacao), [v(dados.cidade), v(dados.uf)].filter(Boolean).join("-"), v(dados.cep) ? `CEP: ${v(dados.cep)}` : ""]
    .filter(Boolean).join(", ");
}

export function montarContratoComodatoPdf(dados: DadosContrato): Buffer {
  const { garantir, paragrafo, clausula, linhaAssinatura, testemunhas, finalizar, espaco } = novoDoc();
  const { tipoTitulo, artigo, nomeEquip, pronome } = nomesEquip(dados);

  // --- cabeçalho ---
  paragrafo(`COMODATO DE BEM DURÁVEL - ${tipoTitulo}`, { bold: true, size: 13, align: "center", gap: 2 });
  if (v(dados.codigo)) paragrafo(`Contrato ${v(dados.codigo)}`, { size: 8.5, align: "center", gap: 6 });
  else espaco(4);

  const comodatarioRazao = ou(dados.comodatarioRazao, "____________________________________________");
  const comodatarioCnpj = ou(dados.comodatarioCnpj, "____.____.____/______-____");
  const endInst = enderecoInstalacao(dados) || "________________________________________________";

  paragrafo(
    `Pelo presente instrumento particular de COMODATO, de um lado, ${ou(dados.comodanteRazao, COMODANTE.razao)}, ` +
    `CNPJ ${ou(dados.comodanteCnpj, COMODANTE.cnpj)}, localizado na ${COMODANTE.endereco}, de ora em diante denominado ` +
    `simplesmente COMODANTE, e, de outro lado o ${comodatarioRazao}, CNPJ: ${comodatarioCnpj}, localizado na ${endInst}, ` +
    `de ora em diante denominado simplesmente de COMODATÁRIO, têm justo e contratado o seguinte:`,
    { align: "justify", gap: 6 },
  );

  // --- cláusula 1: objeto ---
  const specsTxt = descricaoEquip(dados);
  const descr = specsTxt
    ? specsTxt
    : "da marca ____________________, modelo: ______________, número de série: ______________________, Tensão: ______, Volume: ________, Volume Bruto: ________";
  clausula("CLÁUSULA 1º.",
    `O COMODANTE dá em comodato ao COMODATÁRIO ${artigo} ${nomeEquip.toUpperCase()} ${descr}, ${dados.usado ? "usado" : "sem uso"}, ` +
    `para conservação de Sucos Naturais da Marca HONEST que serão fornecidos pelo COMODANTE para revenda pelo COMODATÁRIO ` +
    `em seu estabelecimento situado no Endereço: ${endInst}.`);
  clausula("CLÁUSULA 2º.", "O COMODATO é por prazo indeterminado, cessando, de direito, quando não mais for de interesse de qualquer das partes.");
  clausula("CLÁUSULA 3º.", `O COMODATÁRIO se obriga a devolver ${pronome} ${nomeEquip} em condições de perfeito funcionamento, devendo mantê-l${pronome} como se dono fosse.`);
  clausula("CLÁUSULA 4º.", `Os produtos a serem conservados n${pronome} referid${pronome} ${nomeEquip} somente serão os fornecidos pelo COMODANTE (sucos refrigerados). Sujeito a multa se o COMODATÁRIO utilizar outros produtos que não forem da marca do COMODANTE.`);
  clausula("CLÁUSULA 5º.", `Correrão por conta do COMODATÁRIO todas as despesas d${pronome} ${nomeEquip.toLowerCase()} como: eletricidade, despesas com manutenção de mecânico, limpeza e outras que se fizerem necessárias.`);
  clausula("CLÁUSULA 6º.", `O COMODATÁRIO não poderá removê-l${pronome} para outro local sem a devida autorização, por escrito, do COMODANTE, bem como é vedado o empréstimo ou aluguel a terceiros.`);
  const valorNum = Number(dados.valorBem);
  const valorTxt = isFinite(valorNum) && valorNum > 0
    ? `${brl(valorNum)} (${extenso(valorNum)})`
    : "R$ ______________ (________________________________________)";
  clausula("CLÁUSULA 7º.", `Para efeito deste contrato ${pronome} referid${pronome} ${nomeEquip} tem o valor de ${valorTxt}.`);
  clausula("CLÁUSULA 8º.", "Fica eleito o foro desta cidade Goiânia - Goiás para dirimir qualquer dúvida referente a este contrato.");

  espaco(2);
  paragrafo("Para firmeza e prova de assim haverem contratado, firmam o presente instrumento em duas vias de igual teor, na presença de testemunhas que a tudo assistiram e que de tudo conhecimento tiveram.", { align: "justify", gap: 8 });

  garantir(78); // data + assinaturas das partes juntas na mesma página
  paragrafo(`Goiânia, ${dataExtenso(dados.dataContrato)}.`, { align: "right", gap: 14 });

  // --- assinaturas ---
  linhaAssinatura(
    ou(dados.comodanteRazao, COMODANTE.razao),
    [`CNPJ ${ou(dados.comodanteCnpj, COMODANTE.cnpj)} - COMODANTE`],
    ou(dados.signatarioComodante, SIGNATARIO_COMODANTE_PADRAO),
  );
  linhaAssinatura(
    comodatarioRazao,
    [`CNPJ ${comodatarioCnpj} - COMODATÁRIO`],
    v(dados.signatarioComodatario),
  );

  testemunhas();
  return finalizar(`Contrato de comodato${v(dados.codigo) ? " " + v(dados.codigo) : ""} · ${ou(dados.comodanteRazao, COMODANTE.razao)}`);
}

// -----------------------------------------------------------------------------
// DISTRATO — rescisão amigável do comodato, com devolução do bem e quitação.
// -----------------------------------------------------------------------------
export type DadosDistrato = {
  dataDistrato?: string | null;   // YYYY-MM-DD (data do instrumento)
  dataDevolucao?: string | null;  // YYYY-MM-DD (quando o bem foi/será devolvido)
  condicao?: string | null;       // estado do equipamento na devolução
  motivo?: string | null;
  pendencias?: string | null;     // valores/avarias a cobrar, se houver
};

export function montarDistratoComodatoPdf(dados: DadosContrato, d: DadosDistrato): Buffer {
  const { garantir, paragrafo, clausula, linhaAssinatura, testemunhas, finalizar } = novoDoc();
  const { tipoTitulo, artigo, nomeEquip, pronome } = nomesEquip(dados);
  const comodatarioRazao = ou(dados.comodatarioRazao, "____________________________________________");
  const comodatarioCnpj = ou(dados.comodatarioCnpj, "____.____.____/______-____");
  const endInst = enderecoInstalacao(dados) || "________________________________________________";
  const specsTxt = descricaoEquip(dados);
  const descr = `${artigo} ${nomeEquip.toUpperCase()}${specsTxt ? " " + specsTxt : ""}`;
  const refContrato = `o Contrato de Comodato de Bem Durável${v(dados.codigo) ? " nº " + v(dados.codigo) : ""}` +
    (v(dados.dataContrato) ? `, firmado em ${dataExtenso(dados.dataContrato)}` : "");
  const valorNum = Number(dados.valorBem);
  const valorTxt = isFinite(valorNum) && valorNum > 0 ? `${brl(valorNum)} (${extenso(valorNum)})` : "";
  const condicao = v(d.condicao) || "perfeito estado de conservação e funcionamento";
  const temPend = !!v(d.pendencias);

  paragrafo(`DISTRATO DE COMODATO DE BEM DURÁVEL - ${tipoTitulo}`, { bold: true, size: 13, align: "center", gap: 2 });
  if (v(dados.codigo)) paragrafo(`Referente ao contrato ${v(dados.codigo)}`, { size: 8.5, align: "center", gap: 6 });

  paragrafo(
    `Pelo presente instrumento particular de DISTRATO, de um lado, ${ou(dados.comodanteRazao, COMODANTE.razao)}, ` +
    `CNPJ ${ou(dados.comodanteCnpj, COMODANTE.cnpj)}, localizado na ${COMODANTE.endereco}, de ora em diante denominado ` +
    `simplesmente COMODANTE, e, de outro lado o ${comodatarioRazao}, CNPJ: ${comodatarioCnpj}, localizado na ${endInst}, ` +
    `de ora em diante denominado simplesmente de COMODATÁRIO, têm justo e contratado o seguinte:`,
    { align: "justify", gap: 6 },
  );

  clausula("CLÁUSULA 1º.",
    `As partes resolvem, de comum acordo, DISTRATAR ${refContrato}, pelo qual o COMODANTE cedeu em comodato ao COMODATÁRIO ${descr}, ` +
    `instalad${pronome} no estabelecimento situado no Endereço: ${endInst}, para conservação de Sucos Naturais da Marca HONEST.` +
    (v(d.motivo) ? ` Motivo: ${v(d.motivo)}.` : ""));
  clausula("CLÁUSULA 2º.",
    `O COMODATÁRIO restitui ao COMODANTE ${pronome} referid${pronome} ${nomeEquip}${v(d.dataDevolucao) ? ` em ${dataExtenso(d.dataDevolucao)}` : " nesta data"}, ` +
    `em ${condicao}, autorizando desde já a sua retirada do estabelecimento pelo COMODANTE ou por quem este indicar.`);
  clausula("CLÁUSULA 3º.",
    temPend
      ? `Ficam a cargo do COMODATÁRIO as seguintes pendências, apuradas na devolução: ${v(d.pendencias)}. ` +
        `Enquanto não quitadas, o COMODANTE ressalva o direito de cobrá-las${valorTxt ? `, até o limite do valor do bem fixado no contrato, ${valorTxt}` : ""}.`
      : `Com a restituição d${pronome} ${nomeEquip} nas condições acima, o COMODANTE dá ao COMODATÁRIO plena e geral quitação quanto à obrigação de devolução do bem${valorTxt ? `, avaliado no contrato em ${valorTxt}` : ""}, nada mais tendo a reclamar a esse título.`);
  clausula("CLÁUSULA 4º.",
    `Correm por conta do COMODATÁRIO as despesas de eletricidade, manutenção e limpeza vencidas até a data da devolução, conforme a cláusula 5ª do contrato ora distratado.`);
  clausula("CLÁUSULA 5º.",
    `Com o presente distrato, cessam todas as obrigações decorrentes do contrato de comodato, dando as partes uma à outra plena, rasa e geral quitação${temPend ? ", ressalvadas as pendências da cláusula 3ª" : ""}, para nada mais reclamarem, a qualquer tempo e a qualquer título.`);
  clausula("CLÁUSULA 6º.",
    `O presente distrato não prejudica as relações comerciais de fornecimento de produtos entre as partes, que seguem regidas pelos pedidos e notas fiscais respectivos.`);
  clausula("CLÁUSULA 7º.", "Fica eleito o foro desta cidade Goiânia - Goiás para dirimir qualquer dúvida referente a este distrato.");

  paragrafo("E por estarem assim justas e contratadas, firmam o presente instrumento em duas vias de igual teor, na presença de testemunhas que a tudo assistiram e que de tudo conhecimento tiveram.", { align: "justify", gap: 8 });

  garantir(78);
  paragrafo(`Goiânia, ${dataExtenso(d.dataDistrato)}.`, { align: "right", gap: 14 });
  linhaAssinatura(ou(dados.comodanteRazao, COMODANTE.razao), [`CNPJ ${ou(dados.comodanteCnpj, COMODANTE.cnpj)} - COMODANTE`], ou(dados.signatarioComodante, SIGNATARIO_COMODANTE_PADRAO));
  linhaAssinatura(comodatarioRazao, [`CNPJ ${comodatarioCnpj} - COMODATÁRIO`], v(dados.signatarioComodatario));
  testemunhas();
  return finalizar(`Distrato de comodato${v(dados.codigo) ? " " + v(dados.codigo) : ""} · ${ou(dados.comodanteRazao, COMODANTE.razao)}`);
}

export function dadosDoContrato(row: any): DadosContrato {
  return {
    codigo: row.codigo,
    comodanteRazao: row.comodante_razao,
    comodanteCnpj: row.comodante_cnpj,
    signatarioComodante: row.signatario_comodante,
    comodatarioRazao: row.comodatario_razao,
    comodatarioCnpj: row.comodatario_cnpj,
    apelidoPonto: row.apelido_ponto,
    signatarioComodatario: row.signatario_comodatario,
    enderecoInstalacao: row.endereco_instalacao,
    cidade: row.cidade, uf: row.uf, cep: row.cep,
    equipamentoTipo: row.equipamento_tipo,
    marca: row.marca, modelo: row.modelo, numeroSerie: row.numero_serie, codigoProduto: row.codigo_produto,
    tensao: row.tensao, volumeLitros: row.volume_litros, volumeBrutoLitros: row.volume_bruto_litros,
    valorBem: row.valor_bem, dataContrato: row.data_contrato,
    usado: row.equipamento_usado === true,
  };
}
