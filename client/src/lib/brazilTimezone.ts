// client/src/lib/brazilTimezone.ts
// -----------------------------------------------------------------------------
// Camada de fuso do FRONTEND. Delega tudo para shared/tempo.ts, que e a regra unica
// do sistema (servidor e cliente). Leia o cabecalho de shared/tempo.ts antes de mexer.
//
// O QUE MUDOU (Fase 4 da correcao de fuso):
//   `nowBrazil()` FOI REMOVIDA. Ela devolvia
//       new Date(new Date().toLocaleString('en-US', { timeZone: BRAZIL_TZ }))
//   — um Date cujos getters LOCAIS mostram a hora de Brasilia, mas cujo INSTANTE esta
//   deslocado de (fuso do navegador − (−3)). Usar os getters funcionava; usar o instante
//   (.toISOString(), .getTime(), comparar com outro Date) dava erro — sempre, quando o
//   outro lado era UTC, e em qualquer navegador fora do horario de Brasilia.
//
//   No lugar dela:
//     hojeBR()            -> 'YYYY-MM-DD' de hoje no Brasil (para enviar ao backend)
//     agora()             -> instante real, em UTC (para medir tempo decorrido)
//     dataCalendario(dia) -> Date de meia-noite UTC (para campos de data pura)
//     componentesBR()     -> { ano, mes, dia, hora, ... } do relogio de Brasilia
//
// PARA EXIBIR:
//   INSTANTE (createdAt, checkInTime, sentAt...)              -> formatDateBR / formatDateTimeBR
//   DATA DE CALENDARIO (dueDate, scheduledDate, routeDate...) -> formatCalendarioBR
//   Usar o formatador errado desloca o dia. Na duvida, veja o tipo no shared/schema.ts.
// -----------------------------------------------------------------------------

import {
  BR_TZ,
  agora,
  hojeBR,
  diaBR,
  diaCalendario,
  dataCalendario,
  instanteBR,
  componentesBR,
  fmtDataBR,
  fmtDataHoraBR,
  fmtCalendarioBR,
} from '@shared/tempo';

export const BRAZIL_TZ = BR_TZ;

// Reexporta a regra unica, para quem quiser importar direto daqui.
export { agora, hojeBR, diaBR, diaCalendario, dataCalendario, instanteBR, componentesBR };

/** Hoje no Brasil, 'YYYY-MM-DD'. Independe do fuso do navegador. */
export function getBrazilDateISO(): string {
  return hojeBR();
}

/** INSTANTE -> 'dd/mm/aaaa' no fuso do Brasil. */
export function formatDateBR(date: string | Date): string {
  return fmtDataBR(date);
}

/** INSTANTE -> 'dd/mm/aaaa hh:mm:ss' no fuso do Brasil. */
export function formatDateTimeBR(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('pt-BR', { timeZone: BR_TZ });
}

/** INSTANTE -> 'hh:mm' no fuso do Brasil. */
export function formatTimeBR(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('pt-BR', { timeZone: BR_TZ, hour: '2-digit', minute: '2-digit' });
}

/** INSTANTE -> 'dd/mm/aaaa hh:mm' no fuso do Brasil. */
export function formatDateLongBR(date: string | Date): string {
  return fmtDataHoraBR(date);
}

/** DATA DE CALENDARIO -> 'dd/mm/aaaa'. SEM conversao de fuso: e o dia que esta gravado.
 *  Use em vencimento, data da rota, data agendada, emissao, competencia. */
export function formatCalendarioBR(date: string | Date | null | undefined): string {
  return fmtCalendarioBR(date);
}

export function getBrazilMonth(): number {
  return componentesBR().mes;
}

export function getBrazilYear(): number {
  return componentesBR().ano;
}

export function getBrazilDay(): number {
  return componentesBR().dia;
}

export function getBrazilDayOfWeek(): number {
  return new Date(`${hojeBR()}T12:00:00Z`).getUTCDay();
}
