// ===========================================================================
// RE-15 RELATÓRIO DE PRODUÇÃO — PDF para envio externo (clientes, fiscalização)
// Gerado no navegador (jsPDF + autotable), com logo da Honest, cabeçalho da
// empresa, rodapé "Página x de y" e SEM nenhuma informação de custo.
// Os dados chegam já formatados de Industry.tsx (mesma fonte do relatório
// impresso), para os dois nunca divergirem.
// ===========================================================================
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export const RE15_EMPRESA = {
  razao: 'PURO INDÚSTRIA E COMÉRCIO DE PRODUTOS NATURAIS LTDA',
  cnpj: '28.295.493/0001-53',
  endereco: 'Rod. Bela Vista de Goiás–Cristianópolis, KM 08, Fazenda Gramado, Zona Rural · Bela Vista de Goiás/GO · CEP 75240-000',
  contato: 'Honest Sucos Naturais · (62) 3093-5050 · bebahonest.com.br',
};

export interface Re15Ordem {
  titulo: string;                  // "OP-0001 — Suco de Maracujá 900 ml"
  status: string;
  dados: [string, string][];       // pares rótulo/valor (ordem de exibição)
  analise: [string, string][] | null;
  insumos: { material: string; unidade: string; qtd: string; lote: string }[];
  observacoes?: string;
  // Assinaturas eletrônicas VÁLIDAS da ordem (feitas no Integra)
  assinaturas?: { papel: string; nome: string; funcao?: string; dataHora: string; codigo: string; url: string; qr?: string }[];
}

export interface Re15Dados {
  emitidoEm: string;
  resumo: { rotulo: string; valor: string }[];
  ordens: Re15Ordem[];
  // Linhas de assinatura à caneta no fim (quando alguma ordem não tem assinatura eletrônica)
  assinaturasManuais?: boolean;
}

const VERDE: [number, number, number] = [22, 163, 74];
const CINZA: [number, number, number] = [240, 240, 240];

async function carregarLogo(): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const resp = await fetch('/honest-logo.png', { cache: 'force-cache' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const data: string = await new Promise((ok, err) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = err;
      r.readAsDataURL(blob);
    });
    const dim: { w: number; h: number } = await new Promise((ok) => {
      const img = new Image();
      img.onload = () => ok({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      img.onerror = () => ok({ w: 619, h: 490 });
      img.src = data;
    });
    return { data, ...dim };
  } catch {
    return null;
  }
}

export async function gerarRe15Pdf(dados: Re15Dados, nomeArquivo: string) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 12;
  const logo = await carregarLogo();

  // ---- Cabeçalho (só na 1ª página) --------------------------------------
  let y = M;
  let xTxt = M;
  if (logo) {
    const h = 20;
    const w = (logo.w / logo.h) * h;
    doc.addImage(logo.data, 'PNG', M, y, w, h);
    xTxt = M + w + 5;
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(17, 17, 17);
  doc.text('RE-15 RELATÓRIO DE PRODUÇÃO', xTxt, y + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(60, 60, 60);
  doc.text(`${RE15_EMPRESA.razao} · CNPJ ${RE15_EMPRESA.cnpj}`, xTxt, y + 11);
  doc.text(doc.splitTextToSize(RE15_EMPRESA.endereco, pageW - xTxt - M), xTxt, y + 15);
  doc.text(`${RE15_EMPRESA.contato} · emitido em ${dados.emitidoEm}`, xTxt, y + 19);
  y += 23;
  doc.setDrawColor(...VERDE);
  doc.setLineWidth(0.6);
  doc.line(M, y, pageW - M, y);
  y += 4;

  // ---- Resumo -----------------------------------------------------------
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [dados.resumo.map((r) => r.rotulo)],
    body: [dados.resumo.map((r) => r.valor)],
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 1.6, lineColor: [187, 187, 187], lineWidth: 0.2, textColor: [17, 17, 17] },
    headStyles: { fillColor: CINZA, textColor: [17, 17, 17], fontStyle: 'bold' },
  });
  y = (doc as any).lastAutoTable.finalY + 6;

  // ---- Ficha de cada ordem ---------------------------------------------
  const garantirEspaco = (mm: number) => {
    if (y + mm > pageH - 18) { doc.addPage(); y = M; }
  };
  const kvRows = (pares: [string, string][]) => {
    const rows: any[] = [];
    for (let i = 0; i < pares.length; i += 3) {
      const row: any[] = [];
      for (let j = i; j < i + 3; j++) {
        if (pares[j]) row.push({ content: pares[j][0], styles: { fillColor: [247, 247, 247], fontStyle: 'bold' } }, pares[j][1]);
        else row.push('', '');
      }
      rows.push(row);
    }
    return rows;
  };
  const kvCols = { 0: { cellWidth: 24 }, 2: { cellWidth: 24 }, 4: { cellWidth: 24 } };
  const base = {
    margin: { left: M, right: M },
    theme: 'grid' as const,
    styles: { fontSize: 7.8, cellPadding: 1.4, lineColor: [187, 187, 187] as [number, number, number], lineWidth: 0.2, textColor: [17, 17, 17] as [number, number, number] },
    headStyles: { fillColor: CINZA, textColor: [17, 17, 17] as [number, number, number], fontStyle: 'bold' as const },
  };
  const secao = (txt: string) => {
    garantirEspaco(12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(17, 17, 17);
    doc.text(txt, M, y + 3);
    y += 4.5;
  };

  for (const op of dados.ordens) {
    garantirEspaco(45);
    doc.setFillColor(...VERDE);
    doc.rect(M, y, 1.4, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(17, 17, 17);
    const tituloLinhas = doc.splitTextToSize(`${op.titulo}  [${op.status}]`, pageW - 2 * M - 4);
    doc.text(tituloLinhas, M + 3.5, y + 4.4);
    y += 4.4 * tituloLinhas.length + 3;

    autoTable(doc, { ...base, startY: y, body: kvRows(op.dados), columnStyles: kvCols });
    y = (doc as any).lastAutoTable.finalY + 3;

    secao('Análise do produto acabado');
    if (op.analise && op.analise.length) {
      autoTable(doc, { ...base, startY: y, body: kvRows(op.analise), columnStyles: kvCols });
      y = (doc as any).lastAutoTable.finalY + 3;
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(119, 119, 119);
      doc.text('Sem dados de análise/pasteurização registrados.', M, y + 3);
      y += 6;
    }

    secao('Matéria-prima consumida');
    autoTable(doc, {
      ...base,
      startY: y,
      head: [['Material', 'Un.', 'Qtd', 'Lote MP']],
      body: op.insumos.length
        ? op.insumos.map((i) => [i.material, i.unidade, i.qtd, i.lote || '-'])
        : [[{ content: 'Sem insumos cadastrados', colSpan: 4 }]],
      columnStyles: { 1: { cellWidth: 16 }, 2: { cellWidth: 26, halign: 'right' }, 3: { cellWidth: 40 } },
      didParseCell: (h: any) => { if (h.section === 'head' && h.column.index === 2) h.cell.styles.halign = 'right'; },
    });
    y = (doc as any).lastAutoTable.finalY + 3;

    if (op.observacoes) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(17, 17, 17);
      const linhas = doc.splitTextToSize(`Observações: ${op.observacoes}`, pageW - 2 * M);
      garantirEspaco(linhas.length * 3.6 + 2);
      doc.text(linhas, M, y + 3);
      y += linhas.length * 3.6 + 2;
    }

    if (op.assinaturas) {
      secao('Assinaturas eletrônicas');
      if (!op.assinaturas.length) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(119, 119, 119);
        doc.text('Ordem ainda não assinada eletronicamente.', M, y + 3);
        y += 6;
      } else {
        const boxW = (pageW - 2 * M - 4) / 2;
        const boxH = 26;
        for (let i = 0; i < op.assinaturas.length; i += 2) {
          garantirEspaco(boxH + 2);
          for (let j = 0; j < 2 && i + j < op.assinaturas.length; j++) {
            const a = op.assinaturas[i + j];
            const x = M + j * (boxW + 4);
            doc.setDrawColor(...VERDE);
            doc.setLineWidth(0.4);
            doc.roundedRect(x, y, boxW, boxH, 1.5, 1.5);
            let tx = x + 3;
            if (a.qr) { doc.addImage(a.qr, 'PNG', x + 2.5, y + 2.5, 21, 21); tx = x + 26.5; }
            const tw = boxW - (tx - x) - 2;
            doc.setTextColor(17, 17, 17);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8.2);
            doc.text(doc.splitTextToSize(a.nome, tw)[0], tx, y + 5);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.2);
            const linhas = [
              a.funcao ? doc.splitTextToSize(a.funcao, tw)[0] : null,
              `Responsável — ${a.papel}`,
              `Assinado via Integra em ${a.dataHora}`,
              `Código: ${a.codigo}`,
            ].filter(Boolean) as string[];
            linhas.forEach((l, k) => doc.text(l, tx, y + 8.6 + k * 3.2));
            doc.setFontSize(6);
            doc.setTextColor(90, 90, 90);
            const urlLinhas = (doc.splitTextToSize(a.url, tw) as string[]).slice(0, 2);
            urlLinhas.forEach((l, k) => doc.text(l, tx, y + boxH - 2.2 - (urlLinhas.length - 1 - k) * 2.4));
          }
          y += boxH + 2;
        }
      }
    }
    y += 5;
  }

  // ---- Assinaturas à caneta (só se alguma ordem não tem assinatura eletrônica)
  if (dados.assinaturasManuais !== false) {
  garantirEspaco(26);
  y += 14;
  const col = (pageW - 2 * M - 20) / 3;
  doc.setDrawColor(51, 51, 51);
  doc.setLineWidth(0.3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(17, 17, 17);
  ['Produção', 'Qualidade', 'Data / Hora'].forEach((t, i) => {
    const x = M + i * (col + 10);
    doc.line(x, y, x + col, y);
    doc.text(t, x + col / 2, y + 4, { align: 'center' });
  });
  }

  // ---- Rodapé em todas as páginas --------------------------------------
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.2);
    doc.line(M, pageH - 10, pageW - M, pageH - 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(110, 110, 110);
    doc.text(`RE-15 Relatório de Produção · ${RE15_EMPRESA.razao} · CNPJ ${RE15_EMPRESA.cnpj}`, M, pageH - 6);
    doc.text(`Página ${p} de ${total}`, pageW - M, pageH - 6, { align: 'right' });
  }

  doc.save(nomeArquivo.endsWith('.pdf') ? nomeArquivo : `${nomeArquivo}.pdf`);
}
