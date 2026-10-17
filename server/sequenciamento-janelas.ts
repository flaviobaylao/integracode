// ============================================================================
// SEQUENCIAMENTO DAS PARADAS COM JANELAS DE RECEBIMENTO
// ----------------------------------------------------------------------------
// Recebe as paradas de UM veículo (já distribuídas) e devolve a ordem de visita
// e os horários de cada entrega, respeitando:
//   • horário de recebimento cadastrado por cliente (seg-sex / sábado);
//   • tempo de deslocamento (mesma régua do resto do sistema: distância
//     Haversine a 40 km/h);
//   • tempo de entrega MEDIDO do cliente (cronômetro do entregador) ou 5 min
//     estimados quando ainda não há medição;
//   • a jornada do veículo (início/fim informados na tela);
//   • pedidos marcados como PRIORIDADE vêm antes dos demais (regra antiga),
//     a menos que isso faça alguém perder o horário de recebimento.
//
// Chegou antes de o cliente abrir → espera. Chegou depois de fechar → a parada
// é marcada "fora do horário" e vira alerta na tela (nunca some da rota).
//
// Algoritmo: duas sequências iniciais (a geográfica, vinda do 2-opt, e uma por
// horário de fechamento) + busca local (reposicionar parada, trocar duas,
// inverter trecho) minimizando, nesta ordem: paradas fora do horário, minutos
// de atraso, prioridade invertida, hora extra da jornada, tempo total.
// ============================================================================

import type { JanelaMin } from '../shared/janelas-entrega';

export const TEMPO_ENTREGA_PADRAO_MIN = 5;
export const VELOCIDADE_MEDIA_KMH = 40;

export interface ParadaSeq {
  id: string;
  customerId?: string | null;
  lat: number;
  lng: number;
  /** minutos de atendimento no cliente */
  servico: number;
  janelas: JanelaMin[];
  urgente?: boolean;
}

export interface HorarioParada {
  id: string;
  /** chegada física ao cliente (minuto do dia) */
  chegada: number;
  /** início da entrega (após eventual espera pela abertura) */
  inicio: number;
  /** saída do cliente */
  saida: number;
  espera: number;
  /** minutos de atraso em relação ao fim da janela (0 = dentro) */
  atraso: number;
  foraDaJanela: boolean;
  distanciaAnterior: number; // km
  servico: number;
}

export interface ResultadoSequencia {
  ordem: string[];
  horarios: HorarioParada[];
  partida: number; // minuto do dia em que o veículo sai da base
  fim: number; // saída da última parada
  distanciaTotal: number;
  foraDaJanela: number;
  horaExtra: number;
}

type Dist = (lat1: number, lng1: number, lat2: number, lng2: number) => number;

const MESMO_LOCAL_KM = 0.05;

function avaliar(
  seq: ParadaSeq[],
  base: { lat: number; lng: number },
  partida: number,
  fimJornada: number,
  dist: Dist,
  detalhar: boolean,
): { custo: number; res?: ResultadoSequencia } {
  let t = partida;
  let prevLat = base.lat;
  let prevLng = base.lng;
  let prevCliente: string | null | undefined = undefined;
  let distTotal = 0;
  let fora = 0;
  let atrasoTot = 0;
  let viagemEspera = 0;
  let inversoes = 0;
  let regularVisto = false;
  const horarios: HorarioParada[] = [];

  for (const p of seq) {
    const d = dist(prevLat, prevLng, p.lat, p.lng);
    const viagem = (d / VELOCIDADE_MEDIA_KMH) * 60;
    const chegada = t + viagem;
    // Duas entregas no mesmo cliente, em sequência, são uma parada física só:
    // o tempo medido de atendimento é contado uma vez.
    const mesmoLocal = !!p.customerId && p.customerId === prevCliente && d < MESMO_LOCAL_KM;
    const servico = mesmoLocal ? 0 : p.servico;

    let inicio = chegada;
    let atraso = 0;
    if (p.janelas.length) {
      const aberta = p.janelas.find((j) => chegada < j.fim);
      if (aberta) inicio = Math.max(chegada, aberta.ini);
      else atraso = chegada - p.janelas[p.janelas.length - 1].fim + 1;
    }
    const espera = inicio - chegada;
    const saida = inicio + servico;

    if (atraso > 0) { fora++; atrasoTot += atraso; }
    if (p.urgente) { if (regularVisto) inversoes++; } else regularVisto = true;
    distTotal += d;
    viagemEspera += viagem + espera;

    if (detalhar) {
      horarios.push({ id: p.id, chegada, inicio, saida, espera, atraso, foraDaJanela: atraso > 0, distanciaAnterior: d, servico });
    }
    t = saida;
    prevLat = p.lat;
    prevLng = p.lng;
    prevCliente = p.customerId;
  }

  const horaExtra = Math.max(0, t - fimJornada);
  const custo = fora * 1e7 + atrasoTot * 1e4 + inversoes * 2e3 + horaExtra * 50 + viagemEspera;
  if (!detalhar) return { custo };
  return {
    custo,
    res: {
      ordem: seq.map((p) => p.id),
      horarios,
      partida,
      fim: t,
      distanciaTotal: distTotal,
      foraDaJanela: fora,
      horaExtra,
    },
  };
}

function buscaLocal(
  inicial: ParadaSeq[],
  base: { lat: number; lng: number },
  partida: number,
  fimJornada: number,
  dist: Dist,
): { seq: ParadaSeq[]; custo: number } {
  let seq = inicial.slice();
  let melhor = avaliar(seq, base, partida, fimJornada, dist, false).custo;
  const n = seq.length;
  if (n < 2) return { seq, custo: melhor };
  const maxPassadas = n > 60 ? 6 : 40;

  for (let passada = 0; passada < maxPassadas; passada++) {
    let melhorou = false;

    // 1) Reposicionar uma parada (or-opt de 1 elemento)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cand = seq.slice();
        const [x] = cand.splice(i, 1);
        cand.splice(j, 0, x);
        const c = avaliar(cand, base, partida, fimJornada, dist, false).custo;
        if (c < melhor - 1e-6) { seq = cand; melhor = c; melhorou = true; }
      }
    }

    // 2) Inverter trecho (2-opt)
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = seq.slice(0, i).concat(seq.slice(i, k + 1).reverse(), seq.slice(k + 1));
        const c = avaliar(cand, base, partida, fimJornada, dist, false).custo;
        if (c < melhor - 1e-6) { seq = cand; melhor = c; melhorou = true; }
      }
    }

    // 3) Trocar duas paradas de lugar
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = seq.slice();
        const tmp = cand[i]; cand[i] = cand[k]; cand[k] = tmp;
        const c = avaliar(cand, base, partida, fimJornada, dist, false).custo;
        if (c < melhor - 1e-6) { seq = cand; melhor = c; melhorou = true; }
      }
    }

    if (!melhorou) break;
  }
  return { seq, custo: melhor };
}

/** Ordem inicial alternativa: prioridade, depois quem fecha mais cedo, vizinho mais próximo no empate. */
function ordemPorFechamento(paradas: ParadaSeq[], base: { lat: number; lng: number }, dist: Dist): ParadaSeq[] {
  const fechamento = (p: ParadaSeq) => (p.janelas.length ? p.janelas[0].fim : 24 * 60 + 1);
  const restantes = paradas.slice();
  const out: ParadaSeq[] = [];
  let lat = base.lat;
  let lng = base.lng;
  while (restantes.length) {
    restantes.sort((a, b) => {
      if (!!a.urgente !== !!b.urgente) return a.urgente ? -1 : 1;
      const fa = fechamento(a);
      const fb = fechamento(b);
      if (fa !== fb) return fa - fb;
      return dist(lat, lng, a.lat, a.lng) - dist(lat, lng, b.lat, b.lng);
    });
    const p = restantes.shift()!;
    out.push(p);
    lat = p.lat;
    lng = p.lng;
  }
  return out;
}

/**
 * Sequencia as paradas de um veículo.
 * @param ordemGeografica paradas já na ordem do 2-opt geográfico (ponto de partida)
 * @param inicioJornada minuto do dia em que o veículo pode sair (ex.: 480 = 08:00)
 * @param fimJornada minuto do dia em que a jornada termina
 */
export function sequenciarComJanelas(
  ordemGeografica: ParadaSeq[],
  base: { lat: number; lng: number },
  inicioJornada: number,
  fimJornada: number,
  dist: Dist,
): ResultadoSequencia {
  if (ordemGeografica.length === 0) {
    return { ordem: [], horarios: [], partida: inicioJornada, fim: inicioJornada, distanciaTotal: 0, foraDaJanela: 0, horaExtra: 0 };
  }
  const temJanela = ordemGeografica.some((p) => p.janelas.length > 0);

  let melhorSeq = ordemGeografica.slice();
  if (temJanela) {
    const a = buscaLocal(ordemGeografica, base, inicioJornada, fimJornada, dist);
    const b = buscaLocal(ordemPorFechamento(ordemGeografica, base, dist), base, inicioJornada, fimJornada, dist);
    melhorSeq = (b.custo < a.custo ? b : a).seq;
  }

  let res = avaliar(melhorSeq, base, inicioJornada, fimJornada, dist, true).res!;

  // Se o motorista esperaria na PRIMEIRA parada, ele sai da base mais tarde —
  // desde que isso não faça nenhuma outra parada perder o horário.
  const esperaPrimeira = res.horarios[0]?.espera || 0;
  if (esperaPrimeira > 0.5) {
    const adiada = avaliar(melhorSeq, base, inicioJornada + esperaPrimeira, fimJornada, dist, true).res!;
    if (adiada.foraDaJanela <= res.foraDaJanela) res = adiada;
  }
  return res;
}
