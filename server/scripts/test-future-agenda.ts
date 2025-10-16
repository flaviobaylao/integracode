import { ensureFutureAgendaCoverage } from '../visitScheduleService';

async function testFutureAgenda() {
  try {
    console.log('🧪 Testando ensureFutureAgendaCoverage com 2 meses...\n');
    
    const result = await ensureFutureAgendaCoverage(2);
    
    console.log('\n✅ Teste concluído com sucesso!');
    console.log('Resultado:', result);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro no teste:', error);
    process.exit(1);
  }
}

testFutureAgenda();
