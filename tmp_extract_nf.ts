import * as XLSX from 'xlsx';
import fs from 'fs';

const workbook = XLSX.readFile('attached_assets/vendas_e_nf-e_743278026293467_1761522051528.xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log(`📊 Total de linhas: ${data.length}`);
console.log(`📋 Colunas: ${Object.keys(data[0]).join(', ')}`);

// Mostrar primeira linha
console.log(`\n📄 Primeira linha:`);
console.log(JSON.stringify(data[0], null, 2));

// Extrair números de NF
const nfNumbers = data.map((row: any) => {
  const nf = row['Número da NF'] || row['Número'] || row['nNF'] || row['NF'] || 
         row['Nota Fiscal'] || row['número'] || row['numero'] || row['N° NF'] ||
         row['N° da NF'] || row['Nº da NF'] || row['Nº NF'];
  return nf ? nf.toString().trim() : null;
}).filter((nf: any) => nf !== null);

console.log(`\n✅ Total de NFs extraídas: ${nfNumbers.length}`);
console.log(`📋 Primeiras 15 NFs: ${nfNumbers.slice(0, 15).join(', ')}`);
console.log(`📋 Últimas 10 NFs: ${nfNumbers.slice(-10).join(', ')}`);

// Salvar lista
fs.writeFileSync('/tmp/nf_excel.json', JSON.stringify(nfNumbers, null, 2));
console.log('\n✅ Lista salva em /tmp/nf_excel.json');
