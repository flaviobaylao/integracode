#!/usr/bin/env tsx
import { db } from './db';
import { DatabaseStorage } from './storage';
import { generateDailyRoute } from './routeOptimizationService';

async function main() {
  console.log('🚀 Gerando rotas diárias para hoje...\n');

  const storage = new DatabaseStorage(db as any);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // IDs dos vendedores
  const vendors = [
    { id: 'omie-vendor-4253571816', name: 'Gabriel R.' },
    { id: 'omie-vendor-3882132483', name: 'Gilmar M.' },
    { id: 'omie-vendor-4253571580', name: 'Celso R.' }
  ];

  for (const vendor of vendors) {
    try {
      console.log(`📍 Gerando rota para ${vendor.name} (${vendor.id})...`);
      const result = await generateDailyRoute(storage, vendor.id, today);
      
      console.log('Resultado:', JSON.stringify(result, null, 2));
      
      if (result.routeId) {
        console.log(`✅ Rota gerada com sucesso!`);
        console.log(`   - ID da rota: ${result.routeId}`);
        console.log(`   - Total de visitas: ${result.totalVisits}`);
        console.log(`   - Distância estimada: ${result.totalDistance}km`);
      } else if (result.message) {
        console.log(`⚠️  ${result.message}`);
        if (result.visitsWithoutCoordinates) {
          console.log(`   - Visitas sem coordenadas: ${result.visitsWithoutCoordinates}`);
        }
      } else {
        console.log(`❓ Resultado inesperado`);
      }
    } catch (error) {
      console.error(`❌ Erro ao gerar rota para ${vendor.name}:`, error);
    }
    console.log('');
  }

  console.log('✅ Processo concluído!');
  process.exit(0);
}

main().catch(error => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
