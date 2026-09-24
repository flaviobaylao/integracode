// client/src/lib/tendencia.ts
// Linha de tendencia (regressao linear PONDERADA) de uma serie mensal.
//
// Para que serve: a linha do faturamento sobe e desce todo mes e o olho nao
// separa o ruido do rumo. A reta responde uma pergunta so — "no conjunto do
// periodo, isto esta subindo ou caindo, e quanto por mes?" — e responde com um
// numero (a inclinacao), nao com uma impressao.
//
// POR QUE PONDERADA. Na regressao comum, jan/25 pesa igual a set/26: um pico
// velho segura a reta para cima muito depois de ter acabado. A tela inteira ja
// trabalha com recencia — a "media ponderada/mes" da tabela da peso 1 ao mes
// mais antigo do periodo e peso N ao mais recente — e a reta usa EXATAMENTE a
// mesma regua. Assim o grafico e a tabela falam a mesma lingua: quando a coluna
// de media ponderada cai, a reta do grafico cai junto.
//
// Outras duas decisoes que mudam o resultado:
//
//  • O MES EM CURSO FICA DE FORA. O ultimo mes do grafico costuma estar pela
//    metade; incluir meio mes como se fosse um mes inteiro puxa a reta para
//    baixo e inventa uma queda que nao existe — e, com peso maximo por ser o
//    mais recente, o estrago seria o maior de todos. A reta e' calculada sem
//    ele, mas e' DESENHADA tambem em cima dele, projetada, para o grafico nao
//    terminar com um pedaco vazio.
//  • NADA ABAIXO DE ZERO. Faturamento negativo nao existe; quando a reta
//    projetada cai abaixo de zero ela e' cortada em zero no desenho.
//
// Funcao pura, sem React e sem Recharts, para poder ser testada sozinha.

/** "recencia" = peso 1..n do mais antigo ao mais novo; "iguais" = regressao comum. */
export type PesoTendencia = "recencia" | "iguais";

export type Tendencia = {
  /** Valor da reta em cada ponto da serie (mesmo comprimento da entrada). */
  pontos: number[];
  /** Coeficiente linear (valor da reta no primeiro mes). */
  base: number;
  /** Inclinacao: quanto a reta anda por mes, em reais. */
  porMes: number;
  /** Inclinacao como % da media (ponderada, quando ha peso); null se media <= 0. */
  pctPorMes: number | null;
  /** Quantos meses entraram na conta. */
  meses: number;
  /** true quando o ultimo ponto foi projetado (mes em curso fora da conta). */
  projetouUltimo: boolean;
  /** Qual regua de peso foi usada. */
  pesos: PesoTendencia;
  /** Peso do mes mais recente que entrou na conta (1 quando "iguais"). */
  pesoMaior: number;
};

const MINIMO_DE_MESES = 3;

/**
 * Reta de tendencia de uma serie de valores mensais, na ordem do grafico.
 * Devolve null quando nao ha meses fechados suficientes (minimo 3) — com dois
 * pontos "tendencia" seria so' ligar um ao outro, o que nao informa nada.
 */
export function tendenciaDaSerie(
  valores: Array<number | null | undefined>,
  opcoes: { ignorarUltimo?: boolean; pesos?: PesoTendencia } = {},
): Tendencia | null {
  const pesos: PesoTendencia = opcoes.pesos === "iguais" ? "iguais" : "recencia";
  const serie = valores.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
  const ignorarUltimo = !!opcoes.ignorarUltimo && serie.length > MINIMO_DE_MESES;
  const usados = ignorarUltimo ? serie.slice(0, -1) : serie;
  if (usados.length < MINIMO_DE_MESES) return null;

  const n = usados.length;
  // Peso por recencia: 1 no mes mais antigo, n no mais recente — a mesma regua
  // da media ponderada da tabela de clientes.
  const peso = (i: number) => (pesos === "recencia" ? i + 1 : 1);

  let W = 0, Sx = 0, Sy = 0, Sxy = 0, Sxx = 0;
  for (let i = 0; i < n; i++) {
    const w = peso(i);
    const y = usados[i];
    W += w;
    Sx += w * i;
    Sy += w * y;
    Sxy += w * i * y;
    Sxx += w * i * i;
  }
  const den = W * Sxx - Sx * Sx;
  if (den === 0 || !Number.isFinite(den)) return null;

  const porMes = (W * Sxy - Sx * Sy) / den;
  const base = (Sy - porMes * Sx) / W;
  const media = Sy / W; // media ponderada pelos mesmos pesos

  return {
    pontos: serie.map((_v, i) => Math.max(0, base + porMes * i)),
    base,
    porMes,
    pctPorMes: media > 0 ? (porMes / media) * 100 : null,
    meses: n,
    projetouUltimo: ignorarUltimo,
    pesos,
    pesoMaior: pesos === "recencia" ? n : 1,
  };
}
