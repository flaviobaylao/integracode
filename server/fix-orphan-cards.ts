import { db } from './db';
import { users, salesCards } from '@shared/schema';
import { eq, inArray, notInArray } from 'drizzle-orm';
import bcrypt from 'bcrypt';

async function fixOrphanCards() {
  console.log('=== CORRIGINDO CARDS ÓRFÃOS ===\n');

  // 1. Verificar se existe vendedor "desconhecido"
  const [unknownVendor] = await db
    .select()
    .from(users)
    .where(eq(users.id, 'unknown-vendor'));

  if (!unknownVendor) {
    console.log('🔧 Criando vendedor "Desconhecido"...');
    
    // Usar senha aleatória impossível de adivinhar (conta não deve fazer login)
    const randomPassword = Math.random().toString(36).slice(-16) + Math.random().toString(36).slice(-16);
    const hashedPassword = await bcrypt.hash(randomPassword, 10);
    
    await db.insert(users).values({
      id: 'unknown-vendor',
      email: 'vendedor.desconhecido@sistema.local',
      password: hashedPassword,
      firstName: 'Vendedor',
      lastName: 'Desconhecido',
      role: 'vendedor',
      isActive: false // Inativo para login, mas permite aparecer em queries
    });
    
    console.log('✅ Vendedor "Desconhecido" criado!\n');
  } else {
    console.log('✅ Vendedor "Desconhecido" já existe\n');
  }

  // 2. Buscar todos os IDs de vendedores válidos
  const validUsers = await db.select({ id: users.id }).from(users);
  const validUserIds = validUsers.map(u => u.id);

  console.log(`👥 Total de vendedores válidos: ${validUserIds.length}\n`);

  // 3. Buscar todos os cards
  const allCards = await db
    .select({
      id: salesCards.id,
      sellerId: salesCards.sellerId,
      customerId: salesCards.customerId
    })
    .from(salesCards);

  console.log(`📊 Total de cards no banco: ${allCards.length}`);

  // 4. Identificar cards órfãos (com sellerId inválido)
  const orphanCards = allCards.filter(card => !validUserIds.includes(card.sellerId));

  console.log(`⚠️  Cards órfãos encontrados: ${orphanCards.length}\n`);

  if (orphanCards.length === 0) {
    console.log('✅ Nenhum card órfão encontrado!');
    return;
  }

  // Mostrar detalhes dos sellerIds inválidos
  const invalidSellerIds = [...new Set(orphanCards.map(c => c.sellerId))];
  console.log('❌ SellerIds inválidos encontrados:');
  invalidSellerIds.forEach(sellerId => {
    const count = orphanCards.filter(c => c.sellerId === sellerId).length;
    console.log(`   "${sellerId}": ${count} cards`);
  });

  // 5. Atualizar cards órfãos para o vendedor desconhecido
  console.log('\n🔧 Atualizando cards órfãos...');
  
  const orphanCardIds = orphanCards.map(c => c.id);
  
  await db
    .update(salesCards)
    .set({ sellerId: 'unknown-vendor' })
    .where(inArray(salesCards.id, orphanCardIds));

  console.log(`✅ ${orphanCards.length} cards atualizados para vendedor "Desconhecido"!\n`);

  // 6. Verificar resultado
  const updatedCards = await db
    .select({
      id: salesCards.id,
      sellerId: salesCards.sellerId
    })
    .from(salesCards)
    .where(inArray(salesCards.id, orphanCardIds));

  const stillOrphan = updatedCards.filter(c => c.sellerId !== 'unknown-vendor');

  if (stillOrphan.length === 0) {
    console.log('✅ Todos os cards foram corrigidos com sucesso!');
  } else {
    console.log(`⚠️  ${stillOrphan.length} cards ainda estão órfãos`);
  }

  // 7. Estatísticas finais
  console.log('\n=== ESTATÍSTICAS FINAIS ===');
  const finalCards = await db.select().from(salesCards);
  const cardsByUnknown = finalCards.filter(c => c.sellerId === 'unknown-vendor');
  
  console.log(`📊 Total de cards: ${finalCards.length}`);
  console.log(`👤 Cards do vendedor "Desconhecido": ${cardsByUnknown.length}`);
}

fixOrphanCards()
  .then(() => {
    console.log('\n✅ Correção concluída');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
