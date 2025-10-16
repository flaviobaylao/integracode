import XLSX from 'xlsx';

const workbook = XLSX.readFile('attached_assets/aguardando rota_1760657250629.xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log('Total de notas na planilha:', data.length);
console.log('\n=== PRIMEIRAS 3 NOTAS ===');
console.log(JSON.stringify(data.slice(0, 3), null, 2));

console.log('\n=== COLUNAS DISPONÍVEIS ===');
if (data.length > 0) {
  console.log(Object.keys(data[0]));
}

console.log('\n=== TODAS AS NOTAS (apenas números) ===');
const invoiceNumbers = data.map((row: any) => {
  const nf = row['NF'] || row['Nota'] || row['Numero'] || row['NUMERO'] || row['nNF'] || row['Nº NF'] || row['N° NF'];
  if (typeof nf === 'number') return String(nf).padStart(8, '0');
  return nf;
}).filter(Boolean);

console.log(invoiceNumbers.join(','));
