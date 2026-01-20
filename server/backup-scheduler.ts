import cron from 'node-cron';
import { backupAllOrders } from './backup-service';
import { db } from './db';
import { sql } from 'drizzle-orm';

const BACKUP_ENABLED = false;
const RETENTION_DAYS = 7;

async function cleanOldBackups() {
  try {
    const result = await db.execute(sql`
      DELETE FROM orders_backup 
      WHERE backup_date < NOW() - INTERVAL '${sql.raw(String(RETENTION_DAYS))} days'
    `);
    console.log(`🧹 Limpeza de backups antigos: registros com mais de ${RETENTION_DAYS} dias removidos`);
  } catch (error) {
    console.error('❌ Erro ao limpar backups antigos:', error);
  }
}

export function startBackupScheduler() {
  if (!BACKUP_ENABLED) {
    console.log('⚠️  Agendador de backup DESATIVADO temporariamente (para liberar espaço no banco)');
    console.log('💡 Para reativar, altere BACKUP_ENABLED para true em server/backup-scheduler.ts');
    return;
  }

  console.log('⏰ Inicializando agendador de backup de pedidos...');

  cron.schedule('0 2 * * *', async () => {
    try {
      await cleanOldBackups();
      console.log('🔄 Executando backup agendado de pedidos...');
      const result = await backupAllOrders();
      console.log(`✅ Backup agendado concluído: ${result.backedUp} pedidos salvos`);
    } catch (error) {
      console.error('❌ Erro ao executar backup agendado:', error);
    }
  }, {
    timezone: "America/Sao_Paulo"
  });

  (async () => {
    try {
      await cleanOldBackups();
      console.log('🔄 Executando backup inicial na inicialização...');
      const result = await backupAllOrders();
      console.log(`✅ Backup inicial concluído: ${result.backedUp} pedidos salvos`);
    } catch (error) {
      console.error('❌ Erro ao executar backup inicial:', error);
    }
  })();

  console.log('✅ Agendador de backup iniciado (diariamente às 2h Brasília + backup inicial)');
  console.log(`📅 Retenção: backups com mais de ${RETENTION_DAYS} dias são removidos automaticamente`);
}
