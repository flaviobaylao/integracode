// server/excel-export.ts
// Exportacoes .xlsx geradas no servidor. Usa exatamente o mesmo padrao visual
// das exportacoes do navegador (@shared/excel-padrao): cabecalho em negrito,
// centralizado, com quebra e CONGELADO; larguras ajustadas; dinheiro em R$
// contabil; CPF/CNPJ e numeros de documento como texto.
import type { Response } from "express";
import { bytesDoWorkbook, workbookDeAbas, workbookDeLinhas } from "@shared/excel-padrao";
import type { AbaExcel, OpcoesExcel } from "@shared/excel-padrao";

const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const comExtensao = (nome: string) => (/\.xlsx$/i.test(nome) ? nome : nome + ".xlsx");

/** Bytes do .xlsx de uma aba, no padrao. */
export function planilhaPadrao(linhas: Record<string, any>[], opcoes?: OpcoesExcel): Buffer {
  return Buffer.from(bytesDoWorkbook(workbookDeLinhas(linhas, opcoes), opcoes?.congelar !== false));
}

/** Bytes do .xlsx de varias abas, no padrao. */
export function planilhaPadraoAbas(abas: AbaExcel[]): Buffer {
  return Buffer.from(bytesDoWorkbook(workbookDeAbas(abas), abas.every((a) => a.opcoes?.congelar !== false)));
}

/** Responde o download ja com os cabecalhos HTTP certos. */
export function enviarPlanilha(res: Response, buffer: Buffer, nomeArquivo: string) {
  res.setHeader("Content-Type", MIME);
  res.setHeader("Content-Disposition", `attachment; filename=${comExtensao(nomeArquivo)}`);
  res.send(buffer);
}
