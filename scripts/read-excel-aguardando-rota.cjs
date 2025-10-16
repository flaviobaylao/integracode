const XLSX = require('xlsx');

const workbook = XLSX.readFile('attached_assets/aguardando rota_1760657250629.xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];

// Ler sem header primeiro
const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

// A linha 2 (índice 2) tem os headers reais
const headers = rawData[2];

// Dados começam na linha 3 (índice 3)
const dataRows = rawData.slice(3);

// Mapear para objetos usando os headers
const data = dataRows.map(row => {
  const obj = {};
  headers.forEach((header, i) => {
    obj[header] = row[i];
  });
  return obj;
}).filter(row => row['Nota Fiscal']); // Filtrar linhas vazias

console.log('=== TOTAL DE NOTAS NA PLANILHA ===', data.length);

console.log('\n=== PRIMEIRAS 3 NOTAS ===');
console.log(JSON.stringify(data.slice(0, 3), null, 2));

// Extrair números das notas
const invoiceNumbers = data
  .map(row => row['Nota Fiscal'])
  .filter(Boolean)
  .map(nf => {
    if (typeof nf === 'number') return String(nf).padStart(8, '0');
    return String(nf).padStart(8, '0');
  });

console.log('\n=== TODAS AS NOTAS FISCAIS ===');
console.log(invoiceNumbers.join(','));

// Verificar se há notas canceladas ou com etapas diferentes
console.log('\n=== ANÁLISE DE ETAPAS ===');
const etapas = {};
data.forEach(row => {
  const etapa = row['Etapa'];
  etapas[etapa] = (etapas[etapa] || 0) + 1;
});
console.log(etapas);
