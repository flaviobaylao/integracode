import { db } from './db';
import { ordersBackup, salesCards, blockedOrders, type InsertOrdersBackup } from '@shared/schema';

export async function backupAllOrders() {
  console.log('🔄 Iniciando backup automático de pedidos...');
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
        backupDate: new Date(),
      } as InsertOrdersBackup);
      backedUp++;
    }

    // Backup dos blocked_orders
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
        backupDate: new Date(),
      } as InsertOrdersBackup);
      backedUp++;
    }

    console.log(`✅ Backup concluído: ${backedUp} pedidos armazenados`);
    return { success: true, backedUp };
  } catch (error) {
    console.error('❌ Erro ao fazer backup:', error);
    return { success: false, error: String(error) };
  }
}
