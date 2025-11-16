import { storage } from '../server/storage';
import { evolutionAPIService } from '../server/evolution-api-service';
import { db } from '../server/db';
import { conversations, customers } from '../shared/schema';
import { eq } from 'drizzle-orm';

async function importMessagesForConversations() {
  try {
    console.log('📥 Importando mensagens para conversas existentes...');
    
    // Get conversations from database directly
    const allConversations = await db.select().from(conversations).limit(50);
    console.log(`📊 Total de conversas a processar: ${allConversations.length}`);
    
    const conversationsToProcess = allConversations;
    console.log(`🎯 Processando ${conversationsToProcess.length} conversas`);
    
    let processed = 0;
    let messagesImported = 0;
    let errors = 0;
    
    for (const conversation of conversationsToProcess) {
      try {
        // Get customer info
        const customer = await storage.getCustomer(conversation.customerId);
        if (!customer) {
          console.log(`⚠️  Cliente não encontrado para conversa ${conversation.id}`);
          continue;
        }
        
        console.log(`\n👤 [${processed + 1}/${conversationsToProcess.length}] ${customer.name} (${customer.phone})`);
        
        // Fetch message history (limit to 1000 messages per conversation)
        const historyResult = await evolutionAPIService.fetchChatHistory('BOTHONEST', customer.phone, 1000);
        
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
                isRead: true, // Mark historical messages as read
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
importMessagesForConversations()
  .then(() => {
    console.log('\n✅ Importação de mensagens concluída!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Erro:', error);
    process.exit(1);
  });
