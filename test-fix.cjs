const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'attached_assets', 'importacao dados integra atualizado 23.10 atualizado final_1761319094784.xlsx');

console.log('🧪 TESTANDO CORREÇÃO DE ESPAÇOS\n');

const workbook = XLSX.read(require('fs').readFileSync(filePath));
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet);

console.log(`📊 Total de linhas: ${data.length}\n`);

let successCount = 0;
let failCount = 0;

// Testar as primeiras 10 linhas com a lógica CORRIGIDA
for (let i = 0; i < Math.min(10, data.length); i++) {
  const row = data[i];
  
  // CÓDIGO CORRIGIDO - aceita espaços
  const latitudeCol = row['LATITUDE'] || row['Latitude'] || row['latitude'] ||
                      row[' LATITUDE '] || row[' Latitude '] || row[' latitude '] ||
                      row['LATITUDE '] || row[' LATITUDE'] || row['Latitude '] || row[' Latitude'];
  const longitudeCol = row['LONGITUDE'] || row['Longitude'] || row['longitude'] ||
                       row[' LONGITUDE '] || row[' Longitude '] || row[' longitude '] ||
                       row['LONGITUDE '] || row[' LONGITUDE'] || row['Longitude '] || row[' Longitude'];
  
  const hasLat = latitudeCol !== undefined && latitudeCol !== '' && latitudeCol !== null;
  const hasLon = longitudeCol !== undefined && longitudeCol !== '' && longitudeCol !== null;
  
  if (hasLat && hasLon) {
    successCount++;
    console.log(`✅ Linha ${i + 2}: LAT=${latitudeCol}, LON=${longitudeCol}`);
  } else {
    failCount++;
    console.log(`❌ Linha ${i + 2}: LAT=${hasLat ? 'OK' : 'FALTANDO'}, LON=${hasLon ? 'OK' : 'FALTANDO'}`);
  }
}

console.log(`\n📊 RESULTADO DO TESTE (primeiras 10 linhas):`);
console.log(`   ✅ Com coordenadas: ${successCount}/10`);
console.log(`   ❌ Sem coordenadas: ${failCount}/10`);

// Estatísticas gerais
let totalWithBoth = 0;
data.forEach(row => {
  const latitudeCol = row['LATITUDE'] || row['Latitude'] || row['latitude'] ||
                      row[' LATITUDE '] || row[' Latitude '] || row[' latitude '] ||
                      row['LATITUDE '] || row[' LATITUDE'] || row['Latitude '] || row[' Latitude'];
  const longitudeCol = row['LONGITUDE'] || row['Longitude'] || row['longitude'] ||
                       row[' LONGITUDE '] || row[' Longitude '] || row[' longitude '] ||
                       row['LONGITUDE '] || row[' LONGITUDE'] || row['Longitude '] || row[' Longitude'];
  
  const hasLat = latitudeCol !== undefined && latitudeCol !== '' && latitudeCol !== null;
  const hasLon = longitudeCol !== undefined && longitudeCol !== '' && longitudeCol !== null;
  
  if (hasLat && hasLon) totalWithBoth++;
});

console.log(`\n📊 ESTATÍSTICAS GERAIS (APÓS CORREÇÃO):`);
console.log(`   Total: ${data.length} linhas`);
console.log(`   Com ambas coordenadas: ${totalWithBoth} (${((totalWithBoth/data.length)*100).toFixed(1)}%)`);
console.log(`   Sem coordenadas: ${data.length - totalWithBoth} (${(((data.length - totalWithBoth)/data.length)*100).toFixed(1)}%)`);
