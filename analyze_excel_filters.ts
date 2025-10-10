import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';

const file = readFileSync('attached_assets/financas_742514362152597_1760053071582.xlsx');
const workbook = XLSX.read(file, { cellDates: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet, { range: 2 });

// Verificar campos que podem estar sendo filtrados
const filiais = new Set();
const categorias = new Set();
const tiposDoc = new Set();
const contasCorrentes = new Set();

data.forEach((row: any) => {
  const situacao = row['Situação'] || row['__EMPTY'] || '';
  if (situacao.startsWith('Atrasado')) {
    // Campos que podem ter filtro
    const filial = row['FILIAL GYN - Finanças - Contas a Receber'] || 'N/A';
    const categoria = row['Categoria'] || row['__EMPTY_13'] || 'N/A';
    const tipoDoc = row['Tipo de Documento'] || row['__EMPTY_19'] || 'N/A';
    const contaCorrente = row['Conta Corrente'] || row['__EMPTY_17'] || 'N/A';
    
    filiais.add(filial);
    categorias.add(categoria);
    tiposDoc.add(tipoDoc);
    contasCorrentes.add(contaCorrente);
  }
});

console.log('=== ANÁLISE DE POSSÍVEIS FILTROS NO EXCEL ===\n');

console.log('FILIAIS encontradas nos débitos atrasados:');
filiais.forEach(f => console.log(`  - ${f}`));

console.log('\nCATEGORIAS encontradas:');
categorias.forEach(c => console.log(`  - ${c}`));

console.log('\nTIPOS DE DOCUMENTO:');
tiposDoc.forEach(t => console.log(`  - ${t}`));

console.log('\nCONTAS CORRENTES:');
contasCorrentes.forEach(cc => console.log(`  - ${cc}`));

console.log('\n💡 Insight: Se houver apenas um valor em algum campo, pode ser filtro ativo!');
