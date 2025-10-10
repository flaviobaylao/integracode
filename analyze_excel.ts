import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';

const file = readFileSync('attached_assets/financas_742514362152597_1760053071582.xlsx');
const workbook = XLSX.read(file, { cellDates: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];

// Ler com header na linha 2
const data = XLSX.utils.sheet_to_json(sheet, { range: 2 });

console.log('=== ANÁLISE DO EXCEL ===');
console.log(`Total de linhas de dados: ${data.length}`);

// Contar clientes únicos e total
const clientesMap = new Map();
let totalGeral = 0;
let linhasAtrasadas = 0;

data.forEach((row: any) => {
  const situacao = row['Situação'] || row['__EMPTY'] || '';
  const cliente = row['Cliente (Nome Fantasia)'] || row['__EMPTY_3'] || 'Desconhecido';
  const valorReceber = parseFloat(row['Valor a Receber'] || row['__EMPTY_12'] || 0);
  const vencimento = row['Vencimento'] || row['__EMPTY_21'];
  
  // Contar TODOS os títulos com situação que COMEÇA com "Atrasado" e valor > 0
  if (situacao.startsWith('Atrasado') && valorReceber > 0) {
    linhasAtrasadas++;
    
    if (!clientesMap.has(cliente)) {
      clientesMap.set(cliente, { total: 0, titulos: 0, debitos: [] });
    }
    
    const clienteData = clientesMap.get(cliente)!;
    clienteData.total += valorReceber;
    clienteData.titulos++;
    clienteData.debitos.push({
      valor: valorReceber,
      vencimento,
      situacao
    });
    totalGeral += valorReceber;
  }
});

console.log('\n=== RESUMO (TODOS OS ATRASADOS) ===');
console.log(`Linhas atrasadas com valor > 0: ${linhasAtrasadas}`);
console.log(`Total de clientes com débito: ${clientesMap.size}`);
console.log(`Total de débitos: R$ ${totalGeral.toFixed(2)}`);

console.log('\n=== COMPARAÇÃO ===');
console.log(`❌ API Omie retornou: 155 clientes, R$ 40.910,06`);
console.log(`✅ Excel correto mostra: ${clientesMap.size} clientes, R$ ${totalGeral.toFixed(2)}`);
console.log(`📊 Diferença: ${155 - clientesMap.size} clientes a mais, R$ ${(40910.06 - totalGeral).toFixed(2)} a mais`);
