import { storage } from '../server/storage';
import { evolutionAPIService } from '../server/evolution-api-service';
import { db } from '../server/db';
import { conversations, customers } from '../shared/schema';
import { eq, gt, like } from 'drizzle-orm';

async function importMessagesForRecentConversations() {
  try {
    console.log('📥 Importando mensagens para conversas recentes...');
    
    // Get recent conversations from today with real phone numbers
    const recentConversations = await db.select({
      conversation: conversations,
      customer: customers
    })
    .from(conversations)
    .leftJoin(customers, eq(conversations.customerId, customers.id))
    .where(gt(conversations.createdAt, new Date('2025-10-02')))
    .limit(20);
    
    console.log(`📊 Total de conversas recentes: ${recentConversations.length}`);
    
    let processed = 0;
    let messagesImported = 0;
    let errors = 0;
    
    for (const row of recentConversations) {
      try {
        const { conversation, customer } = row;
        
        if (!customer || !customer.phone.startsWith('556')) {
          console.log(`  ⏭️  Pulando: ${customer?.name || 'sem nome'}`);
          continue;
        }
        
        console.log(`\n👤 [${processed + 1}/${recentConversations.length}] ${customer.name} (${customer.phone})`);
        
        // Fetch message history (limit to 500 messages per conversation)
        const historyResult = await evolutionAPIService.fetchChatHistory('BOTHONEST', customer.phone, 500);
        
        if (historyResult.success && historyResult.messages && historyResult.messages.length > 0) {
          console.log(`  📨 ${historyResult.messages.length} mensagens encontradas`);
          
          let messageCount = 0;
          for (const msg of historyResult.messages) {
            try {
              const messageText = evolutionAPIService.extractMessageText(msg.message);
              const fromMe = msg.key?.fromMe || false;
              
              // Create message
              await storage.createMessage({
                conversationId: conversation.id,
                senderId: conversation.agentId || customer.id,
                senderType: fromMe ? 'agent' : 'customer',
                content: messageText,
                messageType: 'text',
                isRead: true,
              });
              
              messageCount++;
            } catch (msgError) {
              console.error(`    ❌ Erro ao importar mensagem:`, msgError);
            }
          }
          
          console.log(`  ✅ ${messageCount} mensagens importadas`);
          messagesImported += messageCount;
        } else {
          console.log(`  ⚠️  Nenhuma mensagem encontrada`);
        }
        
        processed++;
        
      } catch (convError) {
        console.error(`❌ Erro ao processar conversa:`, convError);
        errors++;
      }
    }
    
    console.log(`\n\n📊 RESUMO DA IMPORTAÇÃO:`);
    console.log(`✅ Conversas processadas: ${processed}`);
    console.log(`📨 Total de mensagens importadas: ${messagesImported}`);
    console.log(`❌ Erros: ${errors}`);
    
  } catch (error) {
    console.error('❌ Erro fatal ao importar mensagens:', error);
    process.exit(1);
  }
}

// Run the import
importMessagesForRecentConversations()
  .then(() => {
    console.log('\n✅ Importação de mensagens concluída!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Erro:', error);
    process.exit(1);
  });
