import cron from 'node-cron';
import { getOmieService } from './omieIntegration';

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

console.log('✅ Agendador configurado: Sincronização de débitos vencidos às 07:00h (UTC-3)');