// Verifica as tres travas do estoque mensal estimado de insumos
// (ver o cabecalho da rota em server/contabilidade-insumos.ts).
// Rodar: node server/__tests__/insumos-mensal.test.mjs
const EPS = 0.0001;

// Mesmo laco da rota, isolado para teste.
function estimar(c, saldoHoje) {
  const N = c.length;
  const positivos = c.filter((x) => x > EPS);
  const mediaConsumo = positivos.length ? positivos.reduce((a, b) => a + b, 0) / positivos.length : 0;
  const cobertura = mediaConsumo > EPS ? saldoHoje / mediaConsumo : 0;

  const alvo = new Array(N).fill(0);
  for (let m = 0; m < N - 1; m++) alvo[m] = cobertura * c[m + 1];
  alvo[N - 1] = saldoHoje;
  // O mes tem de ABRIR com o suficiente para a propria producao. Como a abertura e,
  // por aritmetica, o fechamento do mes anterior, isso e uma exigencia sobre o mes
  // ANTERIOR: ele fecha com pelo menos o consumo do mes seguinte. Levantar a abertura
  // direto faria estoque surgir do nada; aqui a diferenca vira compra no mes anterior.
  for (let m = 1; m < N; m++) alvo[m - 1] = Math.max(alvo[m - 1], c[m]);

  const abertura = new Array(N).fill(0);
  const fechamento = new Array(N).fill(0);
  const compras = new Array(N).fill(0);
  abertura[0] = Math.max(c[0], cobertura * c[0]);
  for (let m = 0; m < N; m++) {
    compras[m] = Math.max(0, alvo[m] - (abertura[m] - c[m]));
    fechamento[m] = abertura[m] - c[m] + compras[m];
    if (m + 1 < N) abertura[m + 1] = fechamento[m];
  }
  const residuo = Math.max(0, fechamento[N - 1] - saldoHoje);
  if (residuo > EPS) fechamento[N - 1] = saldoHoje;
  return { cobertura, abertura, fechamento, compras, residuo };
}

// Casos reais colhidos da producao em 18/set/2026, mais os extremos.
const casos = [
  { nome: "CONCENTRADO DE MACA (cobertura 0,4)", c: [3792.919,4372.861,3842.753,454.977,2084.311,2038.14,1961.722,2301.12,2598.373], f: 1027.9 },
  { nome: "CONCENTRADO DE PERA (cobertura 1,8)", c: [1317.97,1643.174,1450.06,178.082,722.99,722.468,664.814,812.764,897.102], f: 1704.3 },
  { nome: "insumo de alto giro (cobertura 0,26)", c: [53436,65961,54962,5705,35300,32250,29547,37618,48511], f: 10483 },
  { nome: "sem consumo, com saldo",              c: [0,0,0,0,0,0,0,0,0], f: 800 },
  { nome: "sem consumo, sem saldo",              c: [0,0,0,0,0,0,0,0,0], f: 0 },
  { nome: "consumo so no ultimo mes",            c: [0,0,0,0,0,0,0,0,500], f: 120 },
  { nome: "consumo so no primeiro mes",          c: [900,0,0,0,0,0,0,0,0], f: 50 },
  { nome: "saldo zero com consumo alto",         c: [100,200,300,400,500,600,700,800,900], f: 0 },
];

let falhas = 0;
const checa = (nome, c, f, r) => {
  const N = c.length;
  // (1) abertura cobre a producao do mes
  const g1 = r.abertura.every((v, m) => v >= c[m] - EPS);
  // (2) compra nunca negativa
  const g2 = r.compras.every((v) => v >= -EPS);
  // (3) fecha no saldo de hoje
  const g3 = Math.abs(r.fechamento[N - 1] - f) < 0.01;
  // (4) nada negativo
  const g4 = r.abertura.every((v) => v >= -EPS) && r.fechamento.every((v) => v >= -EPS);
  // (5) coerencia: fecha = abre - consumo + compra, mes a mes (menos o residuo no fim)
  let g5 = true;
  for (let m = 0; m < N; m++) {
    const esperado = r.abertura[m] - c[m] + r.compras[m] - (m === N - 1 ? r.residuo : 0);
    if (Math.abs(esperado - r.fechamento[m]) > 0.01) g5 = false;
  }
  // (6) encadeamento: abertura do mes seguinte = fechamento do mes
  let g6 = true;
  for (let m = 0; m + 1 < N; m++) if (Math.abs(r.abertura[m + 1] - r.fechamento[m]) > 0.01) g6 = false;

  const ok = g1 && g2 && g3 && g4 && g5 && g6;
  if (!ok) falhas++;
  console.log(`${ok ? "OK   " : "FALHA"} ${nome.padEnd(38)} cobertura=${r.cobertura.toFixed(2)}  fim=${r.fechamento[N-1].toFixed(1)}  residuo=${r.residuo.toFixed(1)}` +
    (ok ? "" : `  [abre>=prod=${g1} compra>=0=${g2} fecha-em-hoje=${g3} nao-negativo=${g4} coerencia=${g5} encadeia=${g6}]`));
};

for (const cs of casos) checa(cs.nome, cs.c, cs.f, estimar(cs.c, cs.f));

// Teste de propriedade: series aleatorias nunca podem violar as travas.
let aleatorios = 0;
for (let i = 0; i < 20000; i++) {
  const N = 1 + Math.floor(Math.random() * 12);
  const c = Array.from({ length: N }, () => (Math.random() < 0.25 ? 0 : Math.round(Math.random() * 5000)));
  const f = Math.random() < 0.15 ? 0 : Math.round(Math.random() * 3000);
  const r = estimar(c, f);
  const okA = r.abertura.every((v, m) => v >= c[m] - EPS);
  const okC = r.compras.every((v) => v >= -EPS);
  const okF = Math.abs(r.fechamento[N - 1] - f) < 0.01;
  const okN = r.abertura.every((v) => v >= -EPS) && r.fechamento.every((v) => v >= -EPS);
  let okE = true;
  for (let m = 0; m + 1 < N; m++) if (Math.abs(r.abertura[m + 1] - r.fechamento[m]) > 0.01) okE = false;
  let okCo = true;
  for (let m = 0; m < N; m++) {
    const esperado = r.abertura[m] - c[m] + r.compras[m] - (m === N - 1 ? r.residuo : 0);
    if (Math.abs(esperado - r.fechamento[m]) > 0.01) okCo = false;
  }
  if (!(okA && okC && okF && okN && okE && okCo)) aleatorios++;
}
console.log(aleatorios ? `\n${aleatorios} FALHAS em 20000 series aleatorias` : "\n20000 series aleatorias: todas as travas valem.");
if (falhas || aleatorios) process.exit(1);
console.log("TODOS OS TESTES PASSARAM");
