import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';

const file = readFileSync('attached_assets/financas_742514362152597_1760053071582.xlsx');
const workbook = XLSX.read(file);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet, { range: 2 });

// Analisar status DIFERENTES encontrados no Excel
const statusMap = new Map();

data.forEach((row: any) => {
  const situacao = row['Situação'] || row['__EMPTY'] || 'Não informado';
  const valorReceber = parseFloat(row['Valor a Receber'] || row['__EMPTY_12'] || 0);
  
  if (valorReceber > 0) {
    if (!statusMap.has(situacao)) {
      statusMap.set(situacao, { count: 0, total: 0 });
    }
    const data = statusMap.get(situacao)!;
    data.count++;
    data.total += valorReceber;
  }
});

console.log('=== TODOS OS STATUS COM VALOR > 0 ===');
for (const [status, dados] of statusMap) {
  console.log(`${status}: ${dados.count} títulos, R$ ${dados.total.toFixed(2)}`);
}

console.log('\n=== ANÁLISE ===');
console.log('No EXCEL, considera débitos vencidos apenas: situação começa com "Atrasado"');
console.log('No CÓDIGO ATUAL, exclui apenas: RECEBIDO, CANCELADO, LIQUIDADO, BAIXADO, PAGO, QUITADO, COMPENSADO, ESTORNADO');
console.log('\n⚠️ PROBLEMA: O código NÃO filtra por situação "Atrasado", apenas por data_vencimento < hoje');
console.log('Isso significa que títulos com "A Vencer", "Pago Parcialmente", etc podem estar sendo incluídos!');
