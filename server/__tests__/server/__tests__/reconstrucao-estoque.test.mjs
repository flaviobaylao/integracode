// Verifica as tres garantias do cabecalho de server/reconstrucao-estoque.ts.
// Rodar: node server/__tests__/reconstrucao-estoque.test.mjs
const EPS = 1e-6;

function reconstruirEstoque(saldoHoje, movs, inicio, fim) {
  const lista = movs.slice().sort((a, b) => a.t - b.t);
  let acc = 0, minPrefix = 0, prefixNoFim = 0;
  for (const m of lista) {
    acc += m.delta;
    if (acc < minPrefix) minPrefix = acc;
    if (m.t <= fim) prefixNoFim = acc;
  }
  const prefixTotal = acc;
  const bNaive = saldoHoje - prefixTotal;
  const bMin = Math.max(0, -minPrefix);
  const B = Math.max(bNaive, bMin);
  const baixaNaoRegistrada = Math.max(0, B - bNaive);
  let entradas = 0, saidas = 0, ajustes = 0, movimentos = 0;
  for (const m of lista) {
    if (m.t < inicio || m.t > fim) continue;
    movimentos++;
    if (m.ajuste) ajustes += m.delta;
    else if (m.delta >= 0) entradas += m.delta; else saidas += -m.delta;
  }
  return { saldoInicial: Math.max(0, B), saldoFinal: Math.max(0, B + prefixNoFim),
           entradas, saidas, ajustes, movimentos,
           baixaNaoRegistrada: baixaNaoRegistrada > EPS ? baixaNaoRegistrada : 0 };
}

const casos = [
  { nome: "serie saudavel",                 hoje: 100,  movs: [{t:5,delta:80},{t:8,delta:-30}] },
  { nome: "so saidas lancadas",             hoje: 50,   movs: [{t:3,delta:-200},{t:6,delta:-100}] },
  { nome: "caso real da tela (GYN FV-350)", hoje: 1247, movs: [{t:2,delta:-444},{t:4,delta:3256},{t:9,delta:-1298}] },
  { nome: "movimento depois do fim",        hoje: 10,   movs: [{t:5,delta:-500},{t:50,delta:490}] },
  { nome: "sem movimento nenhum",           hoje: 77,   movs: [] },
  { nome: "entradas alem do saldo de hoje", hoje: 0,    movs: [{t:1,delta:500}] },
];

const INI = 0, FIM = 20;
let falhas = 0;

for (const c of casos) {
  const r = reconstruirEstoque(c.hoje, c.movs, INI, FIM);

  // (1) nada negativo
  const g1 = r.saldoInicial >= -EPS && r.saldoFinal >= -EPS;

  // (2) replay para frente nunca passa abaixo de zero
  let b = r.saldoInicial, minSerie = b;
  for (const m of c.movs.slice().sort((a,x)=>a.t-x.t)) { b += m.delta; minSerie = Math.min(minSerie, b); }
  const g2 = minSerie >= -1e-4;

  // (3) fecha no saldo de hoje, descontada a baixa nao registrada
  const g3 = Math.abs((b - r.baixaNaoRegistrada) - c.hoje) < 1e-4;

  const ok = g1 && g2 && g3;
  if (!ok) falhas++;
  console.log(
    `${ok ? "OK   " : "FALHA"} ${c.nome.padEnd(32)} ` +
    `inicial=${r.saldoInicial}  final=${r.saldoFinal}  baixaNaoRegistrada=${r.baixaNaoRegistrada}` +
    (ok ? "" : `   [nada-negativo=${g1} replay>=0=${g2} fecha-em-hoje=${g3} minSerie=${minSerie} replayFim=${b}]`)
  );
}

// Teste de propriedade: series aleatorias nunca podem violar as garantias.
let aleatorios = 0;
for (let i = 0; i < 20000; i++) {
  const n = 1 + Math.floor(Math.random() * 8);
  const movs = Array.from({ length: n }, () => ({
    t: Math.floor(Math.random() * 40),
    delta: Math.round((Math.random() * 2000 - 1000)),
  }));
  const hoje = Math.round(Math.random() * 1000);
  const r = reconstruirEstoque(hoje, movs, INI, FIM);
  let b = r.saldoInicial, minSerie = b;
  for (const m of movs.slice().sort((a,x)=>a.t-x.t)) { b += m.delta; minSerie = Math.min(minSerie, b); }
  if (r.saldoInicial < -1e-4 || r.saldoFinal < -1e-4 || minSerie < -1e-4 ||
      Math.abs((b - r.baixaNaoRegistrada) - hoje) > 1e-4) { aleatorios++; }
}
console.log(aleatorios ? `\n${aleatorios} FALHAS em 20000 series aleatorias` : "\n20000 series aleatorias: todas as garantias valem.");
if (falhas || aleatorios) process.exit(1);
console.log(falhas ? "" : "TODOS OS TESTES PASSARAM");
