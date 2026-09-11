// client/src/lib/excelExport.ts
// Saida .xlsx no navegador. Toda a formatacao (cabecalho negrito/congelado,
// larguras, R$ contabil, CPF/CNPJ como texto...) mora em @shared/excel-padrao,
// compartilhada com as exportacoes geradas pelo servidor.
import { bytesDoWorkbook, workbookDeAbas, workbookDeLinhas } from "@shared/excel-padrao";
import type { AbaExcel, OpcoesExcel } from "@shared/excel-padrao";

export { montarPlanilha, congelarCabecalho, bytesDoWorkbook } from "@shared/excel-padrao";
export type { AbaExcel, OpcoesExcel, FormatoColuna } from "@shared/excel-padrao";

const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const comExtensao = (nome: string) => (/\.xlsx$/i.test(nome) ? nome : nome + ".xlsx");

function baixar(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: MIME }));
  const a = document.createElement("a");
  a.href = url;
  a.download = comExtensao(filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Exporta uma unica aba no padrao do INTEGRA. */
export function exportToExcel(linhas: Record<string, any>[], filename: string, opcoes?: OpcoesExcel) {
  try {
    baixar(bytesDoWorkbook(workbookDeLinhas(linhas, opcoes), opcoes?.congelar !== false), filename);
  } catch (e) {
    console.error("exportToExcel:", e);
    alert("Falha ao exportar para Excel.");
  }
}

/** Exporta varias abas, todas no mesmo padrao. */
export function exportSheetsToExcel(abas: AbaExcel[], filename: string) {
  try {
    const congelar = abas.every((a) => a.opcoes?.congelar !== false);
    baixar(bytesDoWorkbook(workbookDeAbas(abas), congelar), filename);
  } catch (e) {
    console.error("exportSheetsToExcel:", e);
    alert("Falha ao exportar para Excel.");
  }
}
