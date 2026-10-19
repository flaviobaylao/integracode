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
  /** horário PREFERENCIAL (suave): penalidade pequena por minuto fora, nunca espera */
  preferencial?: JanelaMin[];
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
/**
 * Peso dos QUILÔMETROS no custo (minutos equivalentes por km) — 19/out/2026.
 * Antes o custo só somava deslocamento + espera: com horários apertados o tempo
 * ganho ao agrupar virava espera no cliente seguinte e o sequenciador via
 * "empate", deixando a rota ir e voltar entre bairros (ex.: voltar ao mesmo
 * supermercado 20 min depois). Com km no custo, de dois roteiros que cumprem os
 * mesmos horários vence o que roda menos.
 */
export const PESO_KM = Number(process.env.ROUTE_PESO_KM || 3);
/**
 * Peso do horário PREFERENCIAL (min equivalentes por minuto fora) — 19/out/2026.
 * Só DESEMPATE: 1 h fora do preferencial "custa" 0,3 min ≈ 0,1 km. A geografia
 * sempre manda; o preferencial só escolhe entre roteiros praticamente iguais.
 * 19/out (2ª revisão): com 0,1 (1 h ≈ 2 km) a soma dos preferenciais de ~20
 * paradas ainda puxava a rota de volta a bairros já visitados — Delícias de Paris
 * ficou em 21º, ao lado da Arena Ensino Médio (5º); VIRSON 43,7 km → 33,5 km.
 */
export const PESO_PREF = Number(process.env.ROUTE_PESO_PREF || 0.005);

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
  let prefDesvio = 0;
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
    if (p.preferencial && p.preferencial.length && servico > 0) {
      const dentro = p.preferencial.some((j) => inicio >= j.ini && inicio < j.fim);
      if (!dentro) prefDesvio += Math.min(...p.preferencial.map((j) => (inicio < j.ini ? j.ini - inicio : inicio - j.fim)));
    }

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
  const custo = fora * 1e7 + atrasoTot * 1e4 + inversoes * 2e3 + horaExtra * 50 + viagemEspera + distTotal * PESO_KM + prefDesvio * PESO_PREF;
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

/**
 * Busca local iterada (19/out/2026). A busca local só aceita UM movimento que
 * melhore; quando há vários clientes de janela curta (8h–10h), puxar um vizinho
 * para junto do outro empurra alguém para fora da janela e o movimento é
 * recusado — a rota fica presa (ex.: IGM ao lado da Bella Milão, mas 25º da
 * fila). Aqui a melhor rota é "chacoalhada" (blocos de 1–3 paradas mudam de
 * lugar) e a busca local roda de novo; fica a melhor. Semente fixa = mesmo
 * resultado para os mesmos pedidos. Limite de tempo por veículo.
 */
function perturbarEMelhorar(
  inicial: { seq: ParadaSeq[]; custo: number },
  base: { lat: number; lng: number },
  partida: number,
  fimJornada: number,
  dist: Dist,
): { seq: ParadaSeq[]; custo: number } {
  const n = inicial.seq.length;
  if (n < 6) return inicial;
  let semente = 1234567;
  const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
  const iteracoes = n > 60 ? 8 : n > 40 ? 20 : 40;
  const limite = Date.now() + (n > 60 ? 1500 : 800);
  let melhor = inicial;
  for (let it = 0; it < iteracoes && Date.now() < limite; it++) {
    const cand = melhor.seq.slice();
    const movimentos = 2 + Math.floor(rnd() * 3);
    for (let m = 0; m < movimentos; m++) {
      const tam = 1 + Math.floor(rnd() * 3);
      const i = Math.floor(rnd() * (cand.length - tam + 1));
      const bloco = cand.splice(i, tam);
      const j = Math.floor(rnd() * (cand.length + 1));
      cand.splice(j, 0, ...bloco);
    }
    const r = buscaLocal(cand, base, partida, fimJornada, dist);
    if (r.custo < melhor.custo - 1e-6) melhor = r;
  }
  return melhor;
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
  // Pedidos do MESMO cliente no mesmo local viram UMA visita (sequenciada como
  // uma parada só e expandida no fim) — nunca mais "volta ao mesmo cliente".
  const { grupos, extras } = agruparMesmoCliente(ordemGeografica, dist);
  const temJanela = grupos.some((p) => p.janelas.length > 0);

  let melhorSeq = grupos.slice();
  if (temJanela || grupos.length !== ordemGeografica.length) {
    const a = buscaLocal(grupos, base, inicioJornada, fimJornada, dist);
    const b = buscaLocal(ordemPorFechamento(grupos, base, dist), base, inicioJornada, fimJornada, dist);
    let melhor = b.custo < a.custo ? b : a;
    melhor = perturbarEMelhorar(melhor, base, inicioJornada, fimJornada, dist);
    melhorSeq = melhor.seq;
  }

  let res = avaliar(melhorSeq, base, inicioJornada, fimJornada, dist, true).res!;

  // Se o motorista esperaria na PRIMEIRA parada, ele sai da base mais tarde —
  // desde que isso não faça nenhuma outra parada perder o horário.
  const esperaPrimeira = res.horarios[0]?.espera || 0;
  if (esperaPrimeira > 0.5) {
    const adiada = avaliar(melhorSeq, base, inicioJornada + esperaPrimeira, fimJornada, dist, true).res!;
    if (adiada.foraDaJanela <= res.foraDaJanela) res = adiada;
  }
  return expandirGrupos(res, extras);
}

/**
 * Junta pedidos do mesmo cliente (mesmo customerId, a menos de 50 m) numa parada
 * representante. O tempo de entrega é o do primeiro pedido (os demais
 * descarregam junto — mesma regra de antes para pedidos consecutivos).
 */
function agruparMesmoCliente(ps: ParadaSeq[], dist: Dist): { grupos: ParadaSeq[]; extras: Map<string, ParadaSeq[]> } {
  const grupos: ParadaSeq[] = [];
  const extras = new Map<string, ParadaSeq[]>();
  for (const p of ps) {
    const g = p.customerId
      ? grupos.find((x) => x.customerId === p.customerId && dist(x.lat, x.lng, p.lat, p.lng) < MESMO_LOCAL_KM)
      : undefined;
    if (!g) { grupos.push({ ...p }); continue; }
    if (p.urgente) g.urgente = true;
    const l = extras.get(g.id) || [];
    l.push(p);
    extras.set(g.id, l);
  }
  return { grupos, extras };
}

/** Recoloca os pedidos agrupados logo depois do representante (descarregam junto). */
function expandirGrupos(res: ResultadoSequencia, extras: Map<string, ParadaSeq[]>): ResultadoSequencia {
  if (!extras.size) return res;
  const horarios: HorarioParada[] = [];
  for (const h of res.horarios) {
    horarios.push(h);
    for (const m of extras.get(h.id) || []) {
      horarios.push({
        id: m.id, chegada: h.saida, inicio: h.saida, saida: h.saida, espera: 0,
        atraso: h.atraso, foraDaJanela: h.foraDaJanela, distanciaAnterior: 0, servico: 0,
      });
    }
  }
  return { ...res, horarios, ordem: horarios.map((h) => h.id) };
}

/**
 * Horários de uma ordem JÁ DEFINIDA (rota salva que o operador ajustou à mão):
 * não reordena nada — só recalcula chegada, espera, tempo de entrega e saída
 * com as mesmas regras do planejamento. Se o motorista esperaria na primeira
 * parada, a saída da base é adiada (sem fazer outra parada perder o horário).
 */
export function horariosNaOrdem(
  seq: ParadaSeq[],
  base: { lat: number; lng: number },
  inicioJornada: number,
  fimJornada: number,
  dist: Dist,
): ResultadoSequencia {
  if (seq.length === 0) {
    return { ordem: [], horarios: [], partida: inicioJornada, fim: inicioJornada, distanciaTotal: 0, foraDaJanela: 0, horaExtra: 0 };
  }
  let res = avaliar(seq, base, inicioJornada, fimJornada, dist, true).res!;
  const esperaPrimeira = res.horarios[0]?.espera || 0;
  if (esperaPrimeira > 0.5) {
    const adiada = avaliar(seq, base, inicioJornada + esperaPrimeira, fimJornada, dist, true).res!;
    if (adiada.foraDaJanela <= res.foraDaJanela) res = adiada;
  }
  return res;
}
