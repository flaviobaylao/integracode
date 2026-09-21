import { cfopDevolucao, nfMovimentouEstoque } from '../nfe-routes';
const casos: Array<[string|null, string, string]> = [
  ['5409','1.409','DEVOLUCAO DE TRANSFERENCIA'],
  ['6409','2.409','DEVOLUCAO DE TRANSFERENCIA'],
  ['5152','1.152','DEVOLUCAO DE TRANSFERENCIA'],
  ['6152','2.152','DEVOLUCAO DE TRANSFERENCIA'],
  ['5102','1.202','DEVOLUCAO DE VENDA'],
  ['6102','2.202','DEVOLUCAO DE VENDA'],
  ['5101','1.201','DEVOLUCAO DE VENDA'],
  ['6101','2.201','DEVOLUCAO DE VENDA'],
  ['5.102','1.202','DEVOLUCAO DE VENDA'],
  ['5910','1.910','DEVOLUCAO'],
  [null,'1.202','DEVOLUCAO DE VENDA'],
  ['','1.202','DEVOLUCAO DE VENDA'],
  ['1202','1.202','DEVOLUCAO DE VENDA'],
];
let ok=0, fail=0;
for (const [ent, esp, nat] of casos) {
  const r = cfopDevolucao(ent);
  const bom = r.cfop===esp && r.natureza===nat && r.cfopItem===esp.replace('.','');
  console.log(`${bom?'✅':'❌'} ${ent ?? 'null'} -> ${r.cfop} / ${r.cfopItem} / ${r.natureza}${bom?'':`   ESPERADO ${esp} ${nat}`}`);
  bom?ok++:fail++;
}
const guard: Array<[any, boolean]> = [
  [{finNFe:'4', operationType:'entrada'}, false],
  [{finNFe:'1', operationType:'saida'}, true],
  [{fin_nfe:'4', operation_type:'entrada'}, false],
  [{operationType:'entrada'}, false],
  [{}, true],
  [null, false],
];
for (const [inv, esp] of guard) {
  const r = nfMovimentouEstoque(inv);
  const bom = r===esp; bom?ok++:fail++;
  console.log(`${bom?'✅':'❌'} guard ${JSON.stringify(inv)} -> ${r}`);
}
console.log(`\n${ok} ok, ${fail} falhas`);
if (fail) process.exit(1);
