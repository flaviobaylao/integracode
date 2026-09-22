// client/src/lib/tendencia.ts
// Linha de tendencia (regressao linear simples) de uma serie mensal.
//
// Para que serve: a linha do faturamento sobe e desce todo mes e o olho nao
// separa o ruido do rumo. A reta de minimos quadrados responde uma pergunta so
// — "no conjunto do periodo, isto esta subindo ou caindo, e quanto por mes?" —
// e responde com um numero (a inclinacao), nao com uma impressao.
//
// Duas decisoes que mudam o resultado:
//
//  • O MES EM CURSO FICA DE FORA. O ultimo mes do grafico costuma estar pela
//    metade; incluir meio mes como se fosse um mes inteiro puxa a reta para
//    baixo e inventa uma queda que nao existe. A reta e' calculada sem ele —
//    mas e' DESENHADA tambem em cima dele, projetada, para o grafico nao ficar
//    com um pedaco vazio no fim.
//  • NADA ABAIXO DE ZERO. Faturamento negativo nao existe; quando a reta
//    projetada cai abaixo de zero ela e' cortada em zero no desenho.
//
// Funcao pura, sem React e sem Recharts, para poder ser testada sozinha.

export type Tendencia = {
  /** Valor da reta em cada ponto da serie (mesmo comprimento da entrada). */
  pontos: number[];
  /** Coeficiente linear (valor da reta no primeiro mes). */
  base: number;
  /** Inclinacao: quanto a reta anda por mes, em reais. */
  porMes: number;
  /** Inclinacao como % da media dos meses usados; null se a media for <= 0. */
  pctPorMes: number | null;
  /** Quantos meses entraram na conta. */
  meses: number;
  /** true quando o ultimo ponto foi projetado (mes em curso fora da conta). */
  projetouUltimo: boolean;
};

const MINIMO_DE_MESES = 3;

/**
 * Reta de tendencia de uma serie de valores mensais, na ordem do grafico.
 * Devolve null quando nao ha meses fechados suficientes (minimo 3) — com dois
 * pontos "tendencia" seria so' ligar um ao outro, o que nao informa nada.
 */
export function tendenciaDaSerie(
  valores: Array<number | null | undefined>,
  opcoes: { ignorarUltimo?: boolean } = {},
): Tendencia | null {
  const serie = valores.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
  const ignorarUltimo = !!opcoes.ignorarUltimo && serie.length > MINIMO_DE_MESES;
  const usados = ignorarUltimo ? serie.slice(0, -1) : serie;
  if (usados.length < MINIMO_DE_MESES) return null;

  const n = usados.length;
  const somaX = (n * (n - 1)) / 2;
  const somaY = usados.reduce((s, v) => s + v, 0);
  const somaXY = usados.reduce((s, v, i) => s + i * v, 0);
  const somaXX = usados.reduce((s, _v, i) => s + i * i, 0);
  const den = n * somaXX - somaX * somaX;
  if (den === 0) return null;

  const porMes = (n * somaXY - somaX * somaY) / den;
  const base = (somaY - porMes * somaX) / n;
  const media = somaY / n;

  return {
    pontos: serie.map((_v, i) => Math.max(0, base + porMes * i)),
    base,
    porMes,
    pctPorMes: media > 0 ? (porMes / media) * 100 : null,
    meses: n,
    projetouUltimo: ignorarUltimo,
  };
}
