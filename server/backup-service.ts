import { db } from './db';
import { ordersBackup, salesCards, blockedOrders, type InsertOrdersBackup } from '@shared/schema';
import { eq, and, gte } from 'drizzle-orm';

export async function backupAllOrders(backupDate?: Date) {
  const date = backupDate || new Date();
  console.log(`🔄 Iniciando backup automático de pedidos para ${date.toISOString()}...`);
  let backedUp = 0;

  try {
    // Backup dos sales_cards
    const allSalesCards = await db.select().from(salesCards);
    for (const card of allSalesCards) {
      await db.insert(ordersBackup).values({
        backupType: 'sales_card',
        sourceId: card.id,
        sourceData: card as any,
        customerId: card.customerId,
        sellerId: card.sellerId,
        status: card.status,
        totalAmount: card.sale_value ? Number(card.sale_value) : undefined,
        backupDate: date,
      } as InsertOrdersBackup);
      backedUp++;
    }

    // Backup dos blocked_orders (IMPORTANTE: Inclui todos os pedidos bloqueados!)
    const allBlockedOrders = await db.select().from(blockedOrders);
    for (const order of allBlockedOrders) {
      await db.insert(ordersBackup).values({
        backupType: 'blocked_order',
        sourceId: order.id,
        sourceData: order as any,
        customerId: order.customerId,
        sellerId: order.sellerId,
        status: order.status,
        totalAmount: order.totalAmount ? Number(order.totalAmount) : undefined,
        backupDate: date,
      } as InsertOrdersBackup);
      backedUp++;
    }

    console.log(`✅ Backup concluído: ${backedUp} pedidos (sales_cards + blocked_orders) armazenados`);
    return { success: true, backedUp, backupDate: date };
  } catch (error) {
    console.error('❌ Erro ao fazer backup:', error);
    throw error;
  }
}

// Função para recuperar backups de um período específico
export async function getBackupsByDateRange(startDate: Date, endDate: Date, backupType?: string) {
  try {
    const whereConditions = [gte(ordersBackup.backupDate, startDate)];
    if (backupType) {
      whereConditions.push(eq(ordersBackup.backupType, backupType));
    }
    
    const backups = await db.select()
      .from(ordersBackup)
      .where(and(...whereConditions))
      .orderBy(ordersBackup.backupDate);
    
    return backups;
  } catch (error) {
    console.error('❌ Erro ao recuperar backups:', error);
    throw error;
  }
}

// Função para recuperar todos os backups de pedidos bloqueados
export async function getBlockedOrdersBackups() {
  try {
    const backups = await db.select()
      .from(ordersBackup)
      .where(eq(ordersBackup.backupType, 'blocked_order'))
      .orderBy(ordersBackup.backupDate);
    
    return backups;
  } catch (error) {
    console.error('❌ Erro ao recuperar backups de pedidos bloqueados:', error);
    throw error;
  }
}
