import cron from 'node-cron';
import { getOmieService } from './omieIntegration';
import { generateVisitAgenda } from './visitScheduleService';

console.log('Inicializando agendador de tarefas...');

// Sincronização automática de débitos vencidos todos os dias às 07:00h
cron.schedule('0 7 * * *', async () => {
  console.log('Iniciando sincronização automática de débitos vencidos às 07:00h...');
  
  try {
    const omieService = getOmieService();
    if (!omieService) {
      console.error('Serviço Omie não configurado para sincronização automática');
      return;
    }

    const result = await omieService.getOverdueDebts();
    
    console.log(`✅ Sincronização automática concluída:`);
    console.log(`   - ${result.totalClients} clientes com débitos vencidos`);
    console.log(`   - Total: R$ ${result.totalAmount.toFixed(2)}`);
    
  } catch (error) {
    console.error('❌ Erro na sincronização automática de débitos vencidos:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// Geração automática de agenda de visitas todos os dias às 06:00h
cron.schedule('0 6 * * *', async () => {
  console.log('Iniciando geração automática de agenda de visitas às 06:00h...');
  
  try {
    const result = await generateVisitAgenda();
    
    console.log(`✅ Geração de agenda concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.generated} visitas criadas`);
    
  } catch (error) {
    console.error('❌ Erro na geração automática de agenda:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

console.log('✅ Agendador configurado:');
console.log('   - Sincronização de débitos vencidos às 07:00h (UTC-3)');
console.log('   - Geração de agenda de visitas às 06:00h (UTC-3)');