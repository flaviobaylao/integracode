import cron from 'node-cron';
import { backupAllOrders } from './backup-service';

export function startBackupScheduler() {
  console.log('⏰ Inicializando agendador de backup de pedidos...');

  // Executar backup todo dia às 2 da manhã (horário UTC)
  cron.schedule('0 2 * * *', async () => {
    try {
      console.log('🔄 Executando backup agendado de pedidos...');
      const result = await backupAllOrders();
      console.log(`✅ Backup agendado concluído: ${result.backedUp} pedidos salvos`);
    } catch (error) {
      console.error('❌ Erro ao executar backup agendado:', error);
    }
  });

  // Também executar uma vez na inicialização do servidor
  (async () => {
    try {
      console.log('🔄 Executando backup inicial na inicialização...');
      const result = await backupAllOrders();
      console.log(`✅ Backup inicial concluído: ${result.backedUp} pedidos salvos`);
    } catch (error) {
      console.error('❌ Erro ao executar backup inicial:', error);
    }
  })();

  console.log('✅ Agendador de backup iniciado (diariamente às 2h UTC + backup inicial)');
}
