// ============================================================================
// REGIONALIZAÇÃO DAS ENTREGAS ENTRE VEÍCULOS (19/out/2026 — regra do Flavio)
// ----------------------------------------------------------------------------
// "O sistema deve sempre primar pela regionalização das entregas. Os veículos
//  devem fazer entregas em áreas distintas, evitando sobreposição de
//  entregadores, a não ser que seja inevitável."
//
// Substitui a regra de 28/jul/2026 ("a única regra de divisão é a quantidade de
// paradas, cota = n/v exata"), que forçava vizinhos para veículos diferentes
// quando a cota enchia. Agora:
//   • REGIÃO PRIMEIRO: as entregas são divididas em áreas contíguas, uma por
//     veículo (k-médias geográfico com restrições de elegibilidade);
//   • QUANTIDADE É FAIXA: cada veículo fica entre alvo×(1−tol) e alvo×(1+tol)
//     (tol padrão 25%, env ROUTE_REGIAO_TOLERANCIA). Capacidade cadastrada
//     continua sendo teto duro;
//   • FRONTEIRA: depois da divisão, um ajuste troca/move entregas da borda
//     quando isso reduz a sobreposição (entrega cujo vizinho mais próximo
//     ficou com outro entregador) sem sair da faixa;
//   • pedidos do MESMO cliente (mesmo local) andam sempre juntos.
//
// Restrições duras (BSB × Goiânia, tipo/exclusividade de veículo, capacidade,
// jornada) continuam sendo validadas depois, na camada de reparo do agente.
// ============================================================================
import { calculateDistance } from './routeOptimizationService';
import type { DeliveryOrder, VehicleConfig } from './deliveryRouteService';

export const TOLERANCIA_REGIAO = Math.min(0.9, Math.max(0, Number(process.env.ROUTE_REGIAO_TOLERANCIA ?? 0.25)));

export interface FaixaParadas {
  alvo: Map<number, number>;
  min: Map<number, number>;
  max: Map<number, number>;
}

/** Faixa de paradas por veículo a partir do alvo (cota igualitária ou capacidade). */
export function faixaDeParadas(alvo: Map<number, number>, vehicles: VehicleConfig[], tol = TOLERANCIA_REGIAO): FaixaParadas {
  const min = new Map<number, number>();
  const max = new Map<number, number>();
  vehicles.forEach((v, i) => {
    const a = alvo.get(i) ?? 0;
    const cap = Number(v.capacity) > 0 ? Number(v.capacity) : Infinity;
    max.set(i, Math.min(cap, Math.ceil(a * (1 + tol))));
    min.set(i, Math.max(0, Math.min(Math.floor(a * (1 - tol)), Number.isFinite(cap) ? cap : Infinity)));
  });
  return { alvo, min, max };
}

interface Unidade {
  chave: string;
  pedidos: DeliveryOrder[];
  x: number; // km
  y: number; // km
  lat: number;
  lng: number;
  elegiveis: number[];
}

const MESMO_LOCAL_KM = 0.05;

function montarUnidades(orders: DeliveryOrder[], vehicles: VehicleConfig[], eligibleByVehicle: Map<number, DeliveryOrder[]>): Unidade[] {
  const elegivel = new Map<number, Set<string>>();
  vehicles.forEach((_, i) => elegivel.set(i, new Set((eligibleByVehicle.get(i) || []).map((o) => o.id))));
  const lat0 = orders.length ? orders.reduce((s, o) => s + o.customerLatitude, 0) / orders.length : -16.7;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const unidades: Unidade[] = [];
  for (const o of orders) {
    const u = unidades.find((x) => !!o.customerId && x.pedidos[0].customerId === o.customerId
      && calculateDistance(x.lat, x.lng, o.customerLatitude, o.customerLongitude) < MESMO_LOCAL_KM);
    if (u) { u.pedidos.push(o); continue; }
    unidades.push({
      chave: o.id,
      pedidos: [o],
      x: o.customerLongitude * kx,
      y: o.customerLatitude * 110.57,
      lat: o.customerLatitude,
      lng: o.customerLongitude,
      elegiveis: [],
    });
  }
  for (const u of unidades) {
    u.elegiveis = vehicles.map((_, i) => i).filter((i) => u.pedidos.every((p) => elegivel.get(i)!.has(p.id)));
  }
  return unidades;
}

const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Divide as entregas em regiões contíguas, uma por veículo.
 * Devolve vehicleIdx → pedidos (pedidos sem veículo elegível ficam de fora — a
 * camada de reparo/alertas trata).
 */
export function particionarPorRegiao(
  orders: DeliveryOrder[],
  vehicles: VehicleConfig[],
  eligibleByVehicle: Map<number, DeliveryOrder[]>,
  faixa: FaixaParadas,
): Map<number, DeliveryOrder[]> {
  const out = new Map<number, DeliveryOrder[]>();
  vehicles.forEach((_, i) => out.set(i, []));
  const unidades = montarUnidades(orders, vehicles, eligibleByVehicle).filter((u) => u.elegiveis.length > 0);
  if (!unidades.length) return out;
  const ativos = vehicles.map((_, i) => i).filter((i) => (faixa.max.get(i) ?? 0) > 0 && unidades.some((u) => u.elegiveis.includes(i)));
  if (ativos.length === 0) return out;

  // Sementes: ponto mais afastado entre os elegíveis de cada veículo (k-means++ determinístico)
  const cent = new Map<number, { x: number; y: number }>();
  for (const v of ativos) {
    const cand = unidades.filter((u) => u.elegiveis.includes(v));
    let melhor = cand[0];
    let melhorD = -1;
    for (const u of cand) {
      const dmin = cent.size ? Math.min(...Array.from(cent.values()).map((c) => d2(u, c))) : (() => {
        const cx = cand.reduce((s, x) => s + x.x, 0) / cand.length;
        const cy = cand.reduce((s, x) => s + x.y, 0) / cand.length;
        return d2(u, { x: cx, y: cy });
      })();
      if (dmin > melhorD) { melhorD = dmin; melhor = u; }
    }
    cent.set(v, { x: melhor.x, y: melhor.y });
  }

  let rotulo = new Map<string, number>();
  const peso = (u: Unidade) => u.pedidos.length;
  for (let it = 0; it < 40; it++) {
    const carga = new Map<number, number>(ativos.map((v) => [v, 0]));
    const novo = new Map<string, number>();
    // quem tem mais a perder (arrependimento) escolhe primeiro
    const ordem = unidades
      .map((u) => {
        const ds = u.elegiveis.filter((v) => cent.has(v)).map((v) => d2(u, cent.get(v)!)).sort((a, b) => a - b);
        return { u, arrep: ds.length > 1 ? ds[1] - ds[0] : Infinity };
      })
      .sort((a, b) => b.arrep - a.arrep);
    for (const { u } of ordem) {
      const opcoes = u.elegiveis.filter((v) => cent.has(v)).sort((a, b) => d2(u, cent.get(a)!) - d2(u, cent.get(b)!));
      let escolhido = opcoes.find((v) => carga.get(v)! + peso(u) <= (faixa.max.get(v) ?? Infinity));
      if (escolhido == null) escolhido = opcoes[0]; // tudo cheio: o mais próximo (reparo avisa)
      novo.set(u.chave, escolhido);
      carga.set(escolhido, carga.get(escolhido)! + peso(u));
    }
    // mínimo da faixa: puxa da vizinhança quem custa menos
    for (const v of ativos) {
      let guarda = 0;
      while (carga.get(v)! < (faixa.min.get(v) ?? 0) && guarda++ < unidades.length) {
        let melhor: Unidade | null = null;
        let melhorCusto = Infinity;
        for (const u of unidades) {
          const atual = novo.get(u.chave)!;
          if (atual === v || !u.elegiveis.includes(v)) continue;
          if (carga.get(atual)! - peso(u) < (faixa.min.get(atual) ?? 0)) continue;
          const custo = d2(u, cent.get(v)!) - d2(u, cent.get(atual)!);
          if (custo < melhorCusto) { melhorCusto = custo; melhor = u; }
        }
        if (!melhor) break;
        const de = novo.get(melhor.chave)!;
        novo.set(melhor.chave, v);
        carga.set(de, carga.get(de)! - peso(melhor));
        carga.set(v, carga.get(v)! + peso(melhor));
      }
    }
    // novos centros
    let mudou = false;
    for (const v of ativos) {
      const us = unidades.filter((u) => novo.get(u.chave) === v);
      if (!us.length) continue;
      const w = us.reduce((s, u) => s + peso(u), 0);
      const c = { x: us.reduce((s, u) => s + u.x * peso(u), 0) / w, y: us.reduce((s, u) => s + u.y * peso(u), 0) / w };
      const ant = cent.get(v)!;
      if (d2(ant, c) > 0.01) mudou = true;
      cent.set(v, c);
    }
    const estavel = !mudou && unidades.every((u) => rotulo.get(u.chave) === novo.get(u.chave));
    rotulo = novo;
    if (estavel) break;
  }

  for (const u of unidades) out.get(rotulo.get(u.chave)!)!.push(...u.pedidos);
  return melhorarFronteira(out, vehicles, eligibleByVehicle, faixa);
}

/** Entregas cujo vizinho mais próximo (outro local) ficou com outro veículo. */
export function medirSobreposicao(assignments: Map<number, DeliveryOrder[]>): { separados: number; total: number } {
  const todos: Array<{ o: DeliveryOrder; v: number }> = [];
  for (const [v, lista] of Array.from(assignments.entries())) for (const o of lista) todos.push({ o, v });
  let separados = 0;
  for (const a of todos) {
    let melhor: { o: DeliveryOrder; v: number } | null = null;
    let md = Infinity;
    for (const b of todos) {
      if (a === b) continue;
      const d = calculateDistance(a.o.customerLatitude, a.o.customerLongitude, b.o.customerLatitude, b.o.customerLongitude);
      if (d < MESMO_LOCAL_KM) continue; // mesmo ponto não conta como vizinho
      if (d < md) { md = d; melhor = b; }
    }
    if (melhor && melhor.v !== a.v) separados++;
  }
  return { separados, total: todos.length };
}

/**
 * Ajuste de fronteira: move ou troca entregas da borda entre dois veículos
 * quando isso reduz a sobreposição e/ou deixa as regiões mais compactas, sempre
 * dentro da faixa de paradas e da elegibilidade.
 */
export function melhorarFronteira(
  assignments: Map<number, DeliveryOrder[]>,
  vehicles: VehicleConfig[],
  eligibleByVehicle: Map<number, DeliveryOrder[]>,
  faixa: FaixaParadas,
): Map<number, DeliveryOrder[]> {
  const todos: DeliveryOrder[] = Array.from(assignments.values()).flat();
  if (todos.length < 3) return assignments;
  const unidades = montarUnidades(todos, vehicles, eligibleByVehicle);
  const rot = new Map<string, number>();
  for (const u of unidades) {
    const v = Array.from(assignments.entries()).find(([, l]) => l.some((o) => o.id === u.pedidos[0].id))?.[0];
    if (v != null) rot.set(u.chave, v);
  }
  // vizinhos de cada unidade (até 4 mais próximos, raio 3 km)
  const viz = new Map<string, Unidade[]>();
  for (const u of unidades) {
    viz.set(u.chave, unidades
      .filter((w) => w !== u && d2(u, w) > MESMO_LOCAL_KM && d2(u, w) <= 3)
      .sort((a, b) => d2(u, a) - d2(u, b))
      .slice(0, 4));
  }
  // quem tem u entre seus vizinhos (efeito de mover u sobre os outros)
  const reverso = new Map<string, Unidade[]>();
  for (const u of unidades) for (const w of viz.get(u.chave) || []) {
    const l = reverso.get(w.chave) || [];
    l.push(u);
    reverso.set(w.chave, l);
  }
  const carga = () => {
    const c = new Map<number, number>();
    vehicles.forEach((_, i) => c.set(i, 0));
    for (const u of unidades) c.set(rot.get(u.chave)!, c.get(rot.get(u.chave)!)! + u.pedidos.length);
    return c;
  };
  const centro = (v: number) => {
    const us = unidades.filter((u) => rot.get(u.chave) === v);
    if (!us.length) return null;
    return { x: us.reduce((s, u) => s + u.x, 0) / us.length, y: us.reduce((s, u) => s + u.y, 0) / us.length };
  };
  // custo local de uma unidade num veículo: vizinhos de outro veículo pesam muito; distância ao centro desempata
  const custoLocal = (u: Unidade, v: number, c: { x: number; y: number } | null) => {
    const vs = viz.get(u.chave) || [];
    const fora = vs.reduce((s, w, k) => s + (rot.get(w.chave) !== v ? (k === 0 ? 3 : 1) : 0), 0);
    return fora * 10 + (c ? d2(u, c) : 0);
  };
  const afetados = (...us: Unidade[]) => {
    const set = new Map<string, Unidade>();
    for (const u of us) { set.set(u.chave, u); for (const w of reverso.get(u.chave) || []) set.set(w.chave, w); }
    return Array.from(set.values());
  };
  const custoConjunto = (us: Unidade[], centros: Map<number, { x: number; y: number } | null>) =>
    us.reduce((s, x) => s + custoLocal(x, rot.get(x.chave)!, centros.get(rot.get(x.chave)!) || null), 0);

  for (let passada = 0; passada < 20; passada++) {
    let melhorou = false;
    const cg = carga();
    const centros = new Map<number, { x: number; y: number } | null>();
    vehicles.forEach((_, i) => centros.set(i, centro(i)));
    // 1) mover
    for (const u of unidades) {
      const de = rot.get(u.chave)!;
      const conj = afetados(u);
      const atual = custoConjunto(conj, centros);
      for (const para of u.elegiveis) {
        if (para === de) continue;
        if (cg.get(de)! - u.pedidos.length < (faixa.min.get(de) ?? 0)) continue;
        if (cg.get(para)! + u.pedidos.length > (faixa.max.get(para) ?? Infinity)) continue;
        rot.set(u.chave, para);
        const novo = custoConjunto(conj, centros);
        if (novo + 0.5 < atual) {
          cg.set(de, cg.get(de)! - u.pedidos.length);
          cg.set(para, cg.get(para)! + u.pedidos.length);
          melhorou = true;
          break;
        }
        rot.set(u.chave, de);
      }
    }
    // 2) trocar pares vizinhos de veículos diferentes (mantém as quantidades)
    for (const u of unidades) {
      for (const w of viz.get(u.chave) || []) {
        const vu = rot.get(u.chave)!, vw = rot.get(w.chave)!;
        if (vu === vw || !u.elegiveis.includes(vw) || !w.elegiveis.includes(vu)) continue;
        const dif = w.pedidos.length - u.pedidos.length;
        if (cg.get(vu)! + dif > (faixa.max.get(vu) ?? Infinity) || cg.get(vu)! + dif < (faixa.min.get(vu) ?? 0)) continue;
        if (cg.get(vw)! - dif > (faixa.max.get(vw) ?? Infinity) || cg.get(vw)! - dif < (faixa.min.get(vw) ?? 0)) continue;
        const conj = afetados(u, w);
        const antes = custoConjunto(conj, centros);
        rot.set(u.chave, vw); rot.set(w.chave, vu);
        const depois = custoConjunto(conj, centros);
        if (depois + 0.5 < antes) { cg.set(vu, cg.get(vu)! + dif); cg.set(vw, cg.get(vw)! - dif); melhorou = true; }
        else { rot.set(u.chave, vu); rot.set(w.chave, vw); }
      }
    }
    if (!melhorou) break;
  }

  const out = new Map<number, DeliveryOrder[]>();
  vehicles.forEach((_, i) => out.set(i, []));
  for (const u of unidades) out.get(rot.get(u.chave)!)!.push(...u.pedidos);
  return out;
}

/**
 * Divisão regional final: testa a divisão igualitária (±0%), ±10% e a
 * tolerância configurada, e fica com a MAIS EQUILIBRADA cuja sobreposição não
 * passa da melhor + 1 entrega. Ou seja: só desequilibra a quantidade quando
 * isso realmente separa melhor as regiões.
 */
export function dividirPorRegiao(
  orders: DeliveryOrder[],
  vehicles: VehicleConfig[],
  eligibleByVehicle: Map<number, DeliveryOrder[]>,
  alvo: Map<number, number>,
): { assignments: Map<number, DeliveryOrder[]>; faixa: FaixaParadas; tolerancia: number; sobreposicao: { separados: number; total: number } } {
  const tols = Array.from(new Set([0, 0.1, TOLERANCIA_REGIAO])).sort((a, b) => a - b);
  const cands = tols.map((tol) => {
    const faixa = faixaDeParadas(alvo, vehicles, tol);
    const assignments = particionarPorRegiao(orders, vehicles, eligibleByVehicle, faixa);
    return { assignments, faixa, tolerancia: tol, sobreposicao: medirSobreposicao(assignments) };
  });
  const melhor = Math.min(...cands.map((c) => c.sobreposicao.separados));
  const escolhido = cands.find((c) => c.sobreposicao.separados <= melhor + 1) || cands[0];
  // A faixa que vale daqui em diante (reparo da IA, fronteira) é a da tolerância máxima.
  return { ...escolhido, faixa: faixaDeParadas(alvo, vehicles, Math.max(escolhido.tolerancia, TOLERANCIA_REGIAO)) };
}
