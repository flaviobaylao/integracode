import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';

const file = readFileSync('attached_assets/financas_742514362152597_1760053071582.xlsx');
const workbook = XLSX.read(file, { cellDates: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet, { range: 2 });

const hoje = new Date();
const diasAtrasoArray: number[] = [];

data.forEach((row: any) => {
  const situacao = row['Situação'] || row['__EMPTY'] || '';
  const valorReceber = parseFloat(row['Valor a Receber'] || row['__EMPTY_12'] || 0);
  const vencimento = row['Vencimento'] || row['__EMPTY_21'];
  
  if (situacao.startsWith('Atrasado') && valorReceber > 0 && vencimento) {
    // Vencimento pode ser um número Excel (dias desde 1900) ou string
    let dataVenc: Date;
    if (typeof vencimento === 'number') {
      // Converter número Excel para data
      dataVenc = new Date((vencimento - 25569) * 86400 * 1000);
    } else {
      dataVenc = new Date(vencimento);
    }
    
    const diffTime = hoje.getTime() - dataVenc.getTime();
    const diasAtraso = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    diasAtrasoArray.push(diasAtraso);
  }
});

diasAtrasoArray.sort((a, b) => a - b);

console.log('=== ANÁLISE DE DIAS DE ATRASO ===');
console.log(`Total de títulos atrasados: ${diasAtrasoArray.length}`);
console.log(`Menor dias de atraso: ${diasAtrasoArray[0]} dias`);
console.log(`Maior dias de atraso: ${diasAtrasoArray[diasAtrasoArray.length - 1]} dias`);
console.log(`Média: ${Math.round(diasAtrasoArray.reduce((a, b) => a + b, 0) / diasAtrasoArray.length)} dias`);

// Distribuição
const dist = { 
  ate7: 0, 
  ate15: 0, 
  ate30: 0, 
  ate60: 0, 
  ate90: 0, 
  mais90: 0 
};

diasAtrasoArray.forEach(d => {
  if (d <= 7) dist.ate7++;
  else if (d <= 15) dist.ate15++;
  else if (d <= 30) dist.ate30++;
  else if (d <= 60) dist.ate60++;
  else if (d <= 90) dist.ate90++;
  else dist.mais90++;
});

console.log('\n=== DISTRIBUIÇÃO ===');
console.log(`Até 7 dias: ${dist.ate7}`);
console.log(`8-15 dias: ${dist.ate15}`);
console.log(`16-30 dias: ${dist.ate30}`);
console.log(`31-60 dias: ${dist.ate60}`);
console.log(`61-90 dias: ${dist.ate90}`);
console.log(`Mais de 90 dias: ${dist.mais90}`);
