// client/src/lib/escalaEixo.ts
// Teto e passo do eixo Y, calculados a partir do que esta desenhado.
//
// Por que existe: o eixo do grafico de evolucao era travado em dois tetos fixos
// (600 mil sem recorte, 350 mil com um cliente ou uma rede escolhida). O teto
// fixo resolve uma coisa boa — comparar um mes com o outro sem a escala se mexer
// embaixo — e estraga outra: uma rede que fatura R$ 20 mil no mes desenhada num
// eixo de 350 mil vira uma linha reta colada no zero, como se nao tivesse
// variacao nenhuma. Quanto menor o recorte, pior fica.
//
// A saida e' calcular o teto a partir do pico da serie, mas SEMPRE parando num
// numero redondo: 1, 2, 2,5 ou 5 vezes uma potencia de 10 (…, 1k, 2k, 2,5k, 5k,
// 10k, 20k, 25k, 50k, 100k, …). Duas consequencias que importam:
//   • dentro do mesmo recorte a escala nao se mexe — trocar de mes, passar o
//     mouse, reordenar a tabela nao mudam o eixo; ele so muda quando o RECORTE
//     muda, que e' exatamente quando ele tem que mudar;
//   • o teto continua legivel ("0 a 25 mil, de 5 em 5 mil") em vez do
//     22.847,31 que uma escala automatica crua produziria.
//
// Funcao pura, sem dependencia de React nem de Recharts, justamente para poder
// ser testada sozinha.

/** Degraus permitidos para o passo, dentro de cada potencia de 10. */
const DEGRAUS = [1, 2, 2.5, 5];
/** Mais linhas de grade que isto polui o desenho e os rotulos se encavalam. */
const MAX_LINHAS_PADRAO = 8;
/** Um respiro acima do pico para o ponto mais alto nao encostar no topo. */
const FOLGA_PADRAO = 1.05;

export type EscalaEixo = {
  /** Teto do eixo (dominio [0, max]). Sempre >= pico da serie. */
  max: number;
  /** Distancia entre duas linhas de grade. */
  passo: number;
  /** Os valores de cada linha de grade, de 0 ate max. */
  ticks: number[];
};

export type OpcoesEscala = {
  /** Maximo de divisoes do eixo. Padrao 8. */
  maxLinhas?: number;
  /** Multiplicador de folga acima do pico. Padrao 1,05. */
  folga?: number;
  /** Menor passo aceitavel — em reais, 100 evita eixo de centavos. Padrao 1. */
  passoMinimo?: number;
};

/** Mata o lixo de ponto flutuante (0,30000000000000004 -> 0,3). */
const limpo = (n: number) => Number(n.toPrecision(12));

function montar(max: number, passo: number): EscalaEixo {
  const ticks: number[] = [];
  for (let v = 0; v <= max + passo / 2; v += passo) ticks.push(limpo(v));
  return { max: limpo(max), passo: limpo(passo), ticks };
}

/**
 * Teto redondo para um pico qualquer.
 * escalaEixo(22847) -> { max: 25000, passo: 5000 }  (0, 5k, 10k, 15k, 20k, 25k)
 * escalaEixo(561300) -> { max: 600000, passo: 100000 }
 * escalaEixo(0) -> { max: 500, passo: 100 }  (serie zerada ainda precisa de eixo)
 */
export function escalaEixo(maiorValor: number, opcoes: OpcoesEscala = {}): EscalaEixo {
  const maxLinhas = Math.max(2, Math.floor(opcoes.maxLinhas ?? MAX_LINHAS_PADRAO));
  const folga = opcoes.folga ?? FOLGA_PADRAO;
  const passoMinimo = Math.max(0, opcoes.passoMinimo ?? 1);

  const bruto = Number(maiorValor);
  const pico = Number.isFinite(bruto) ? Math.max(0, bruto) : 0;
  // Serie zerada (cliente sem faturamento no periodo): eixo minimo, para a tela
  // nao desenhar um grafico sem eixo nenhum.
  if (pico <= 0) {
    const p = Math.max(passoMinimo, 100);
    return montar(p * 5, p);
  }

  const alvo = pico * folga;
  // Comeca uma casa decimal abaixo do passo "ideal" (alvo / maxLinhas) e sobe
  // degrau a degrau ate caber na quantidade de linhas permitida. O primeiro que
  // couber e' o menor — e passo menor significa grade mais informativa.
  let expo = Math.floor(Math.log10(alvo / maxLinhas)) - 1;
  for (let volta = 0; volta < 60; volta++) {
    for (const d of DEGRAUS) {
      const passo = limpo(d * Math.pow(10, expo));
      if (passo < passoMinimo || passo <= 0) continue;
      const linhas = Math.ceil(limpo(alvo / passo));
      if (linhas <= maxLinhas) return montar(limpo(linhas * passo), passo);
    }
    expo += 1;
  }
  // Inalcancavel na pratica (o laco cobre 60 potencias de 10); rede de seguranca.
  return montar(alvo, alvo / maxLinhas);
}

/** Maior valor de uma lista, ignorando null/undefined/NaN. */
export function picoDaSerie(valores: Array<number | null | undefined>): number {
  let max = 0;
  for (const v of valores) {
    const n = Number(v);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
