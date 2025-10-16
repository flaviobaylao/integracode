import { generateVisitAgenda } from '../visitScheduleService';

async function main() {
  console.log('📅 Executando geração de agenda de visitas...\n');
  
  try {
    const result = await generateVisitAgenda();
    
    console.log(`\n✅ Geração de agenda concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.generated} visitas criadas`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

main();
