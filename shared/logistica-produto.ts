// ============================================================================
// LOGÍSTICA DO PRODUTO — peso, dimensões, fardo e paletização (set/2026)
// ----------------------------------------------------------------------------
// Fonte única dos cálculos usados pelo cadastro de produto (prévia no form),
// pelo card do catálogo, pela ficha logística em PDF, pela NF-e (<vol>) e
// pelos agentes de IA. Roda igual no navegador e no Node: nada de import de
// banco ou de DOM aqui.
//
// O cadastro guarda só as ENTRADAS (o que se mede na fábrica); tudo o que
// deriva delas — medidas do fardo, pesos totalizados, ocupação do palete —
// é calculado aqui, sempre da mesma forma.
//
// Convenções:
//   • pesos em GRAMAS no cadastro (é assim que a balança da fábrica lê);
//     a NF-e pede QUILOS com 3 casas — ver pesosParaNf().
//   • dimensões em CENTÍMETROS.
//   • "peso bruto da unidade" = garrafa cheia, com tampa e rótulo, como vai
//     para o cliente; "peso da embalagem" = só o plástico da garrafa;
//     "peso líquido" = bruto − embalagem (é o pesoL da NF-e).
//   • fardo = filas × garrafas por fila, garrafas em pé, envolto em filme
//     termoencolhível. O filme entra só no peso bruto do fardo.
//   • palete padrão PBR-1 (1,20 × 1,00 m, base 14,5 cm, ~30 kg).
// ============================================================================

export const PALETE_PADRAO = {
  tipo: 'PBR-1 1,20 × 1,00 m',
  compCm: 120,
  largCm: 100,
  baseCm: 14.5,     // altura do estrado
  pesoKg: 30,       // palete de madeira PBR vazio
  alturaMaxCm: 150, // altura total (estrado incluído) para transporte refrigerado seguro
  pesoMaxKg: 1000,  // carga útil segura do palete no manuseio (empilhadeira/paleteira)
} as const;

export const FARDO_FILME_PADRAO_G = 30; // filme termoencolhível de um fardo

export interface LogisticaEntrada {
  pesoBrutoG?: number | string | null;
  pesoEmbalagemG?: number | string | null;
  diametroCm?: number | string | null;
  alturaCm?: number | string | null;
  fardoFilas?: number | string | null;
  fardoPorFila?: number | string | null;
  fardoFilmeG?: number | string | null;
  paletFardosCamada?: number | string | null;
  paletCamadas?: number | string | null;
  paletTipo?: string | null;
}

export interface Retangulo { x: number; y: number; w: number; h: number; girado: boolean }

export interface ArranjoCamada {
  fardos: number;            // fardos por camada
  posicoes: Retangulo[];     // em cm, já centralizados no palete
  ocupacaoPct: number;       // área dos fardos / área do palete
  descricao: string;         // ex.: "5 × 7 deitados + 1 × 4 em pé"
}

export interface LogisticaCalculada {
  unidade: {
    pesoBrutoG: number;
    pesoEmbalagemG: number;
    pesoLiquidoG: number;
    diametroCm: number;
    alturaCm: number;
  };
  fardo: {
    unidades: number;
    filas: number;
    porFila: number;
    compCm: number;
    largCm: number;
    altCm: number;
    filmeG: number;
    pesoBrutoKg: number;
    pesoLiquidoKg: number;
  };
  palete: {
    tipo: string;
    fardosPorCamada: number;
    camadas: number;
    fardos: number;
    unidades: number;
    alturaCargaCm: number;   // só a mercadoria
    alturaTotalCm: number;   // com o estrado
    pesoCargaKg: number;     // só a mercadoria
    pesoTotalKg: number;     // com o palete
    ocupacaoPct: number;
    arranjo: ArranjoCamada;
    dentroDosLimites: boolean;
    alertas: string[];
  };
}

function num(v: any): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** O cadastro tem o mínimo para calcular alguma coisa? */
export function temDadosLogisticos(p: LogisticaEntrada | null | undefined): boolean {
  if (!p) return false;
  return num(p.pesoBrutoG) > 0 || (num(p.diametroCm) > 0 && num(p.alturaCm) > 0);
}

// ----------------------------------------------------------------------------
// ARRANJO DA CAMADA — quantos fardos cabem numa camada do palete.
// Testa o fardo "deitado" (comprimento ao longo dos 120 cm) e "em pé" como
// orientação principal e completa a tira que sobra com a orientação girada.
// É o que dá 25 fardos/camada no 350 ml (5 × 5) e 39 no 900 ml (5 × 7 + 1 × 4).
// Nunca deixa fardo para fora da borda (sem "overhang").
// ----------------------------------------------------------------------------
export function arranjarCamada(fardoCompCm: number, fardoLargCm: number, palete = PALETE_PADRAO): ArranjoCamada {
  const P = palete.compCm, Q = palete.largCm;
  if (!(fardoCompCm > 0 && fardoLargCm > 0) || fardoCompCm > Math.max(P, Q) || fardoLargCm > Math.max(P, Q)) {
    return { fardos: 0, posicoes: [], ocupacaoPct: 0, descricao: '—' };
  }
  type Cand = { pos: Retangulo[]; descricao: string };
  const cands: Cand[] = [];
  for (const [w, h, girado] of [[fardoCompCm, fardoLargCm, false], [fardoLargCm, fardoCompCm, true]] as [number, number, boolean][]) {
    const cols = Math.floor(P / w), rows = Math.floor(Q / h);
    if (!cols || !rows) continue;
    const base: Retangulo[] = [];
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) base.push({ x: i * w, y: j * h, w, h, girado });
    const nomeBase = `${cols} × ${rows} ${girado ? 'em pé' : 'deitados'}`;
    // tira sobrando no comprimento (à direita), preenchida com o fardo girado
    const sobraX = P - cols * w;
    const cx = Math.floor(sobraX / h), ry = Math.floor(Q / w);
    const tiraX: Retangulo[] = [];
    for (let i = 0; i < cx; i++) for (let j = 0; j < ry; j++) tiraX.push({ x: cols * w + i * h, y: j * w, w: h, h: w, girado: !girado });
    cands.push({ pos: base.concat(tiraX), descricao: tiraX.length ? `${nomeBase} + ${cx} × ${ry} ${girado ? 'deitados' : 'em pé'}` : nomeBase });
    // tira sobrando na largura (em cima)
    const sobraY = Q - rows * h;
    const cx2 = Math.floor(P / h), ry2 = Math.floor(sobraY / w);
    const tiraY: Retangulo[] = [];
    for (let i = 0; i < cx2; i++) for (let j = 0; j < ry2; j++) tiraY.push({ x: i * h, y: rows * h + j * w, w: h, h: w, girado: !girado });
    cands.push({ pos: base.concat(tiraY), descricao: tiraY.length ? `${nomeBase} + ${cx2} × ${ry2} ${girado ? 'deitados' : 'em pé'}` : nomeBase });
  }
  if (!cands.length) return { fardos: 0, posicoes: [], ocupacaoPct: 0, descricao: '—' };
  cands.sort((a, b) => b.pos.length - a.pos.length);
  const melhor = cands[0];
  // centraliza o bloco no palete: carga no centro = palete estável e sem beirada
  const maxX = Math.max(...melhor.pos.map(r => r.x + r.w));
  const maxY = Math.max(...melhor.pos.map(r => r.y + r.h));
  const dx = (P - maxX) / 2, dy = (Q - maxY) / 2;
  const posicoes = melhor.pos.map(r => ({ ...r, x: r1(r.x + dx), y: r1(r.y + dy) }));
  const area = fardoCompCm * fardoLargCm * posicoes.length;
  return {
    fardos: posicoes.length,
    posicoes,
    ocupacaoPct: Math.round((area / (P * Q)) * 1000) / 10,
    descricao: melhor.descricao,
  };
}

/**
 * Sugestão de paletização segura: o máximo de camadas que respeita a altura e
 * o peso do palete padrão. Usada pelo botão "Sugerir" do cadastro e pelo
 * preenchimento inicial dos produtos.
 */
export function sugerirPaletizacao(fardoCompCm: number, fardoLargCm: number, fardoAltCm: number, fardoPesoBrutoKg: number, palete = PALETE_PADRAO) {
  const arranjo = arranjarCamada(fardoCompCm, fardoLargCm, palete);
  if (!arranjo.fardos || !(fardoAltCm > 0)) return { fardosPorCamada: arranjo.fardos, camadas: 0, arranjo };
  const porAltura = Math.floor((palete.alturaMaxCm - palete.baseCm) / fardoAltCm);
  const porPeso = fardoPesoBrutoKg > 0 ? Math.floor(palete.pesoMaxKg / (arranjo.fardos * fardoPesoBrutoKg)) : porAltura;
  const camadas = Math.max(0, Math.min(porAltura, porPeso));
  return { fardosPorCamada: arranjo.fardos, camadas, arranjo };
}

/** Tudo o que deriva do cadastro. Devolve null quando não há o mínimo (peso ou medidas). */
export function calcularLogistica(p: LogisticaEntrada | null | undefined, palete = PALETE_PADRAO): LogisticaCalculada | null {
  if (!temDadosLogisticos(p)) return null;
  const q = p as LogisticaEntrada;
  const pesoBrutoG = num(q.pesoBrutoG);
  const pesoEmbalagemG = num(q.pesoEmbalagemG);
  const pesoLiquidoG = Math.max(0, pesoBrutoG - pesoEmbalagemG);
  const diametroCm = num(q.diametroCm);
  const alturaCm = num(q.alturaCm);
  const filas = Math.max(0, Math.floor(num(q.fardoFilas)));
  const porFila = Math.max(0, Math.floor(num(q.fardoPorFila)));
  const unidades = filas * porFila;
  const filmeG = q.fardoFilmeG === null || q.fardoFilmeG === undefined || q.fardoFilmeG === '' ? FARDO_FILME_PADRAO_G : num(q.fardoFilmeG);
  const fardoCompCm = r1(porFila * diametroCm);
  const fardoLargCm = r1(filas * diametroCm);
  const fardoAltCm = alturaCm;
  const fardoPesoBrutoKg = r3((unidades * pesoBrutoG + (unidades ? filmeG : 0)) / 1000);
  const fardoPesoLiquidoKg = r3((unidades * pesoLiquidoG) / 1000);

  const arranjo = arranjarCamada(fardoCompCm, fardoLargCm, palete);
  const fardosPorCamadaInformado = Math.floor(num(q.paletFardosCamada));
  const fardosPorCamada = fardosPorCamadaInformado > 0 ? fardosPorCamadaInformado : arranjo.fardos;
  const camadas = Math.max(0, Math.floor(num(q.paletCamadas)));
  const fardos = fardosPorCamada * camadas;
  const alturaCargaCm = r1(camadas * fardoAltCm);
  const alturaTotalCm = r1(alturaCargaCm + palete.baseCm);
  const pesoCargaKg = r1(fardos * fardoPesoBrutoKg);
  const pesoTotalKg = r1(pesoCargaKg + palete.pesoKg);
  const alertas: string[] = [];
  if (fardosPorCamadaInformado > 0 && arranjo.fardos > 0 && fardosPorCamadaInformado > arranjo.fardos) {
    alertas.push(`${fardosPorCamadaInformado} fardos/camada não cabem sem beirada: o máximo sem overhang é ${arranjo.fardos}.`);
  }
  if (alturaTotalCm > palete.alturaMaxCm) alertas.push(`Altura total ${alturaTotalCm} cm acima do limite de ${palete.alturaMaxCm} cm.`);
  if (pesoTotalKg - palete.pesoKg > palete.pesoMaxKg) alertas.push(`Carga de ${pesoCargaKg} kg acima do limite de ${palete.pesoMaxKg} kg por palete.`);

  return {
    unidade: { pesoBrutoG, pesoEmbalagemG, pesoLiquidoG, diametroCm, alturaCm },
    fardo: {
      unidades, filas, porFila,
      compCm: fardoCompCm, largCm: fardoLargCm, altCm: fardoAltCm,
      filmeG, pesoBrutoKg: fardoPesoBrutoKg, pesoLiquidoKg: fardoPesoLiquidoKg,
    },
    palete: {
      tipo: q.paletTipo || palete.tipo,
      fardosPorCamada, camadas, fardos,
      unidades: fardos * unidades,
      alturaCargaCm, alturaTotalCm, pesoCargaKg, pesoTotalKg,
      ocupacaoPct: fardosPorCamada === arranjo.fardos
        ? arranjo.ocupacaoPct
        : Math.round(((fardosPorCamada * fardoCompCm * fardoLargCm) / (palete.compCm * palete.largCm)) * 1000) / 10,
      arranjo,
      dentroDosLimites: alertas.length === 0,
      alertas,
    },
  };
}

// ----------------------------------------------------------------------------
// NF-e — totalização dos pesos e volumes da nota.
// Cada item entra com a quantidade vendida (em UNIDADES) e o cadastro do
// produto. Volumes = fardos (arredondados para cima por produto: 13 garrafas
// de 350 ml = 2 fardos). pesoL = líquido, pesoB = bruto, em kg com 3 casas.
// Item sem cadastro logístico não entra na conta — e a função avisa quais.
// ----------------------------------------------------------------------------
export interface ItemPesagem { quantidade: number | string; produto: LogisticaEntrada | null | undefined; nome?: string }

export function pesosParaNf(itens: ItemPesagem[]) {
  let pesoLiquidoKg = 0, pesoBrutoKg = 0, volumes = 0, unidadesPesadas = 0;
  const semCadastro: string[] = [];
  for (const it of itens) {
    const qtd = num(it.quantidade);
    if (!(qtd > 0)) continue;
    const calc = calcularLogistica(it.produto);
    if (!calc || !(calc.unidade.pesoBrutoG > 0)) { semCadastro.push(it.nome || '?'); continue; }
    unidadesPesadas += qtd;
    pesoLiquidoKg += (qtd * calc.unidade.pesoLiquidoG) / 1000;
    const porFardo = calc.fardo.unidades;
    if (porFardo > 0) {
      const fardos = Math.ceil(qtd / porFardo);
      volumes += fardos;
      pesoBrutoKg += (qtd * calc.unidade.pesoBrutoG + fardos * calc.fardo.filmeG) / 1000;
    } else {
      volumes += qtd;
      pesoBrutoKg += (qtd * calc.unidade.pesoBrutoG) / 1000;
    }
  }
  return {
    volumes,
    especie: 'FARDO',
    pesoLiquidoKg: r3(pesoLiquidoKg),
    pesoBrutoKg: r3(pesoBrutoKg),
    unidadesPesadas,
    semCadastro,
    completo: semCadastro.length === 0 && unidadesPesadas > 0,
  };
}

/** Linha curta para cards, listas e prompts de IA. */
export function resumoLogistico(p: LogisticaEntrada | null | undefined): string {
  const c = calcularLogistica(p);
  if (!c) return '';
  const partes: string[] = [];
  if (c.unidade.pesoBrutoG > 0) partes.push(`${c.unidade.pesoBrutoG} g (líq. ${c.unidade.pesoLiquidoG} g)`);
  if (c.unidade.diametroCm > 0 && c.unidade.alturaCm > 0) partes.push(`Ø ${c.unidade.diametroCm} × ${c.unidade.alturaCm} cm`);
  if (c.fardo.unidades > 0) partes.push(`fardo ${c.fardo.unidades} un (${c.fardo.filas} × ${c.fardo.porFila}) ${c.fardo.compCm} × ${c.fardo.largCm} × ${c.fardo.altCm} cm, ${c.fardo.pesoBrutoKg} kg`);
  if (c.palete.fardos > 0) partes.push(`palete ${c.palete.fardosPorCamada} × ${c.palete.camadas} camadas = ${c.palete.fardos} fardos / ${c.palete.unidades} un, ${c.palete.alturaTotalCm} cm, ${c.palete.pesoTotalKg} kg`);
  return partes.join(' · ');
}
