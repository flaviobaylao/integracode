import { db } from '../db';
import { salesCards, customers } from '@shared/schema';
import { eq, sql } from 'drizzle-orm';

async function fixSalesCardSellersBatch() {
  try {
    console.log('🔧 Iniciando correção em lote de vendedores nos sales cards...\n');
    
    // Atualizar sales cards com vendedor do cliente em uma única query SQL
    const result = await db.execute(sql`
      UPDATE sales_cards
      SET seller_id = customers.seller_id
      FROM customers
      WHERE sales_cards.customer_id = customers.id
        AND customers.seller_id IS NOT NULL
        AND customers.seller_id != ''
        AND (sales_cards.seller_id IS NULL 
             OR sales_cards.seller_id = ''
             OR sales_cards.seller_id = 'admin-flavio'
             OR sales_cards.seller_id != customers.seller_id)
    `);

    console.log(`\n✅ Correção concluída em lote!`);
    console.log(`   - Sales cards atualizados: ${result.rowCount || 0}`);
    
    // Verificar resultado
    const stats = await db.execute(sql`
      SELECT 
        CASE 
          WHEN sc.seller_id LIKE 'omie-vendor-%' THEN 'Com vendedor Omie'
          WHEN sc.seller_id = 'admin-flavio' THEN 'Admin Flavio'
          ELSE 'Outro'
        END as tipo_vendedor,
        COUNT(*) as total
      FROM sales_cards sc
      GROUP BY tipo_vendedor
      ORDER BY total DESC
    `);

    console.log(`\n📊 Estatísticas finais:`);
    stats.rows.forEach((row: any) => {
      console.log(`   - ${row.tipo_vendedor}: ${row.total} cards`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

fixSalesCardSellersBatch();
