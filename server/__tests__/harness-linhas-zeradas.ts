// Harness da regra "pedido nao aceita item sem quantidade".
// Roda com: npx tsx server/__tests__/harness-linhas-zeradas.ts
import { sanitizeOrderLines, validateOrderLines, findZeroQuantityLines, lineQuantity, assertNoZeroQuantityLines, ZeroQuantityLineError } from '../order-lines';

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean) => { if (cond) { ok++; console.log('  ✓', nome); } else { fail++; console.log('  ✗', nome); } };

// Caso real — NF 104367 (Sacolao Estacao, R$ 262,20): 3 linhas de 350ml zeradas.
const nf104367 = [
  { name: 'SUCO MISTO DE FRUTA - MORANGO COM MARACUJA 350ml', quantity: 0, unitPrice: 5.40, totalPrice: 0 },
  { name: 'SUCO MISTO DE FRUTA - ACEROLA 350ml', quantity: 0, unitPrice: 5.40, totalPrice: 0 },
  { name: 'SUCO MISTO DE FRUTA - FRUTAS VERMELHAS 350ml', quantity: 0, unitPrice: 6.90, totalPrice: 0 },
  { name: 'SUCO MISTO DE FRUTA - FRUTAS VERMELHAS 900ml', quantity: 6, unitPrice: 11.00, totalPrice: 66.00 },
  { name: 'SUCO MISTO DE FRUTA - MARACUJA 900ml', quantity: 6, unitPrice: 10.90, totalPrice: 65.40 },
  { name: 'SUCO MISTO DE FRUTA - MORANGO COM MARACUJA 900ml', quantity: 6, unitPrice: 10.90, totalPrice: 65.40 },
  { name: 'SUCO MISTO DE FRUTA - ACEROLA 900ml', quantity: 6, unitPrice: 10.90, totalPrice: 65.40 },
];
// Caso real — NF 104366 (Engenho dos Paes, R$ 212,40): 1 linha de 900ml zerada.
const nf104366 = [
  { name: 'SUCO MISTO DE FRUTA - ACEROLA 900ml', quantity: 0, unitPrice: 10.90, totalPrice: 0 },
  { name: 'SUCO MISTO DE FRUTA - MORANGO COM MARACUJA 350ml', quantity: 12, unitPrice: 5.40, totalPrice: 64.80 },
  { name: 'SUCO MISTO DE FRUTA - FRUTAS VERMELHAS 350ml', quantity: 12, unitPrice: 6.90, totalPrice: 82.80 },
  { name: 'SUCO MISTO DE FRUTA - ACEROLA 350ml', quantity: 12, unitPrice: 5.40, totalPrice: 64.80 },
];
const soma = (ls: any[]) => +ls.reduce((t, l) => t + Number(l.totalPrice || 0), 0).toFixed(2);

console.log('\n1) Casos reais das NFs de 31/ago');
const s67 = sanitizeOrderLines(nf104367, 'NF104367');
t('104367: 3 linhas descartadas', s67.dropped.length === 3);
t('104367: sobram 4 linhas de 900ml', s67.lines.length === 4);
t('104367: total intacto R$ 262,20', soma(s67.lines) === 262.20);
const s66 = sanitizeOrderLines(nf104366, 'NF104366');
t('104366: 1 linha descartada', s66.dropped.length === 1);
t('104366: total intacto R$ 212,40', soma(s66.lines) === 212.40);

console.log('\n2) Bloqueio na emissao');
t('104367 cru e invalido', validateOrderLines(nf104367).valid === false);
t('mensagem cita os produtos', /MORANGO COM MARACUJA 350ml/.test(validateOrderLines(nf104367).message || ''));
t('104367 saneado e valido', validateOrderLines(s67.lines).valid === true);
let lancou = false;
try { assertNoZeroQuantityLines(nf104366, 'teste'); } catch (e) { lancou = e instanceof ZeroQuantityLineError && (e as any).code === 'ZERO_QTY_LINE'; }
t('assert lanca ZeroQuantityLineError', lancou);
let naoLancou = true;
try { assertNoZeroQuantityLines(s66.lines, 'teste'); } catch { naoLancou = false; }
t('assert passa em pedido saudavel', naoLancou);

console.log('\n3) Formas que a quantidade chega');
t('string "0" e zero', lineQuantity({ quantity: '0' }) === 0);
t('string vazia e zero', lineQuantity({ quantity: '' }) === 0);
t('null e zero', lineQuantity({ quantity: null }) === 0);
t('campo ausente e zero', lineQuantity({ name: 'x' }) === 0);
t('lixo ("abc") e zero', lineQuantity({ quantity: 'abc' }) === 0);
t('negativo tambem barra', findZeroQuantityLines([{ quantity: -3 }]).length === 1);
t('decimal pt-BR "1,5" passa (industria)', lineQuantity({ quantity: '1,5' }) === 1.5);
t('decimal "0,5" passa', findZeroQuantityLines([{ quantity: '0,5' }]).length === 0);
t('string "12" passa', findZeroQuantityLines([{ quantity: '12' }]).length === 0);

console.log('\n4) Nao regride nada');
t('pedido saudavel volta identico', JSON.stringify(sanitizeOrderLines(s66.lines).lines) === JSON.stringify(s66.lines));
t('array vazio segue vazio', sanitizeOrderLines([]).lines.length === 0);
t('null NAO vira array', sanitizeOrderLines(null).lines === null);
t('undefined NAO vira array', sanitizeOrderLines(undefined).lines === undefined);
t('null e valido (pedido sem produtos)', validateOrderLines(null).valid === true);
t('pedido 100% zerado vira array vazio', sanitizeOrderLines([{ quantity: 0 }, { quantity: 0 }]).lines.length === 0);

console.log(`\n=== ${ok} verdes / ${fail} vermelhos ===`);
process.exit(fail === 0 ? 0 : 1);
