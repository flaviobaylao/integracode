const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'attached_assets', 'importacao dados integra atualizado 23.10 atualizado final_1761319094784.xlsx');

console.log('📊 Analisando planilha importada...\n');

const workbook = XLSX.read(require('fs').readFileSync(filePath));
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log(`Total de linhas: ${data.length}\n`);

// Analisar as primeiras 10 linhas
console.log('🔍 Análise das primeiras 10 linhas:\n');

for (let i = 0; i < Math.min(10, data.length); i++) {
  const row = data[i];
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`📄 LINHA ${i + 2} (Excel)`);
  console.log(`═══════════════════════════════════════════`);
  
  // Mostrar TODAS as colunas
  console.log('\n📋 Colunas disponíveis:');
  Object.keys(row).forEach(col => {
    console.log(`  - "${col}"`);
  });
  
  // Tentar encontrar CNPJ/CPF
  const cnpjCpf = row['CNPJ/CPF'] || row['CNPJ'] || row['CPF'] || row['cnpj/cpf'] || row['cnpj'] || row['cpf'];
  console.log(`\n👤 Cliente: ${cnpjCpf || 'NÃO ENCONTRADO'}`);
  
  // Tentar encontrar LATITUDE
  const latKeys = ['LATITUDE', 'Latitude', 'latitude', 'LAT', 'Lat', 'lat'];
  let latValue = null;
  let latKey = null;
  for (const key of latKeys) {
    if (row[key] !== undefined) {
      latValue = row[key];
      latKey = key;
      break;
    }
  }
  
  console.log(`\n📍 LATITUDE:`);
  if (latKey) {
    console.log(`  ✅ Encontrada na coluna: "${latKey}"`);
    console.log(`  📝 Valor bruto: "${latValue}"`);
    console.log(`  🔢 Tipo: ${typeof latValue}`);
    console.log(`  ✓ É vazio? ${latValue === '' || latValue === null || latValue === undefined ? 'SIM' : 'NÃO'}`);
  } else {
    console.log(`  ❌ COLUNA NÃO ENCONTRADA!`);
    console.log(`  💡 Colunas procuradas: ${latKeys.join(', ')}`);
  }
  
  // Tentar encontrar LONGITUDE
  const lonKeys = ['LONGITUDE', 'Longitude', 'longitude', 'LON', 'Lon', 'lon', 'LONG', 'Long', 'long'];
  let lonValue = null;
  let lonKey = null;
  for (const key of lonKeys) {
    if (row[key] !== undefined) {
      lonValue = row[key];
      lonKey = key;
      break;
    }
  }
  
  console.log(`\n📍 LONGITUDE:`);
  if (lonKey) {
    console.log(`  ✅ Encontrada na coluna: "${lonKey}"`);
    console.log(`  📝 Valor bruto: "${lonValue}"`);
    console.log(`  🔢 Tipo: ${typeof lonValue}`);
    console.log(`  ✓ É vazio? ${lonValue === '' || lonValue === null || lonValue === undefined ? 'SIM' : 'NÃO'}`);
  } else {
    console.log(`  ❌ COLUNA NÃO ENCONTRADA!`);
    console.log(`  💡 Colunas procuradas: ${lonKeys.join(', ')}`);
  }
}

// Estatísticas gerais
console.log('\n\n📊 ESTATÍSTICAS GERAIS:');
console.log('═══════════════════════════════════════════\n');

let countWithLat = 0;
let countWithLon = 0;
let countWithBoth = 0;
let countWithNeither = 0;

data.forEach(row => {
  const hasLat = row['LATITUDE'] !== undefined && row['LATITUDE'] !== '' && row['LATITUDE'] !== null;
  const hasLon = row['LONGITUDE'] !== undefined && row['LONGITUDE'] !== '' && row['LONGITUDE'] !== null;
  
  if (hasLat) countWithLat++;
  if (hasLon) countWithLon++;
  if (hasLat && hasLon) countWithBoth++;
  if (!hasLat && !hasLon) countWithNeither++;
});

console.log(`Total de linhas: ${data.length}`);
console.log(`Linhas com LATITUDE preenchida: ${countWithLat} (${((countWithLat/data.length)*100).toFixed(1)}%)`);
console.log(`Linhas com LONGITUDE preenchida: ${countWithLon} (${((countWithLon/data.length)*100).toFixed(1)}%)`);
console.log(`Linhas com AMBAS coordenadas: ${countWithBoth} (${((countWithBoth/data.length)*100).toFixed(1)}%)`);
console.log(`Linhas SEM coordenadas: ${countWithNeither} (${((countWithNeither/data.length)*100).toFixed(1)}%)`);
