import * as XLSX from 'xlsx';

const workbook = XLSX.readFile('attached_assets/importacao dados integra atualizado 21.10_1761160013498.xlsx');
const worksheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(worksheet) as any[];

const datasInicio = new Set<string>();

rows.forEach(row => {
  const dataInicio = row['DATA INICIO'] || row['Data Inicio'] || row['data inicio'];
  
  if (dataInicio) {
    // Se for número (serial Excel), converter
    if (typeof dataInicio === 'number') {
      const excelEpoch = new Date(1900, 0, 1);
      const days = dataInicio - 2;
      const date = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);
      datasInicio.add(date.toLocaleDateString('pt-BR'));
    } else {
      datasInicio.add(dataInicio.toString());
    }
  }
});

console.log('=== DATAS DE INICIO ÚNICAS NA PLANILHA ===\n');
console.log('📊 Total de datas diferentes:', datasInicio.size);
console.log('\n📅 Datas encontradas:\n');

const sortedDatas = Array.from(datasInicio).sort((a, b) => {
  const [dA, mA, yA] = a.split('/').map(Number);
  const [dB, mB, yB] = b.split('/').map(Number);
  const dateA = new Date(yA, mA - 1, dA);
  const dateB = new Date(yB, mB - 1, dB);
  return dateA.getTime() - dateB.getTime();
});

sortedDatas.forEach(data => {
  const [day, month, year] = data.split('/').map(Number);
  const d = new Date(year, month - 1, day);
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  console.log(`  ${data} (${dias[d.getDay()]})`);
});

console.log(`\n💡 ${datasInicio.size > 2 ? 'ATENÇÃO: Há mais de 2 datas de início diferentes!' : 'Confirmado: Apenas 2 datas de início.'}`);

process.exit(0);
