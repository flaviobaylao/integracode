import { DatabaseStorage } from '../storage';
import { generateDailyRoute } from '../routeOptimizationService';

async function main() {
  const storage = new DatabaseStorage();
  
  try {
    console.log('🗺️  Gerando rotas para hoje (2025-10-16)...\n');
    
    const today = new Date('2025-10-16');
    today.setHours(0, 0, 0, 0);
    
    // Vendedores com coordenadas de casa e visitas hoje
    const sellers = [
      { id: 'omie-vendor-3882132483', name: 'Gilmar M' },
      { id: 'omie-vendor-4253571580', name: 'Celso R.' },
      { id: 'omie-vendor-4253571816', name: 'Gabriel R.' }
    ];
    
    for (const seller of sellers) {
      console.log(`\n📍 Gerando rota para ${seller.name} (${seller.id})...`);
      
      try {
        const result = await generateDailyRoute(storage, seller.id, today);
        
        if (result.routeId) {
          console.log(`✅ Rota gerada com sucesso!`);
          console.log(`   - ID da rota: ${result.routeId}`);
          console.log(`   - Total de visitas: ${result.totalVisits}`);
          console.log(`   - Distância estimada: ${result.totalEstimatedDistance}m`);
        } else {
          console.log(`⚠️  ${result.message}`);
          if (result.visitsWithoutCoordinates > 0) {
            console.log(`   - Visitas sem coordenadas: ${result.visitsWithoutCoordinates}`);
          }
        }
      } catch (error: any) {
        console.error(`❌ Erro ao gerar rota para ${seller.name}:`, error.message);
      }
    }
    
    console.log('\n✅ Geração de rotas concluída!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

main();
