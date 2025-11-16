import { readFileSync } from 'fs';
import { storage } from '../server/storage';
import { evolutionAPIService } from '../server/evolution-api-service';

async function importAllChats() {
  try {
    console.log('📥 Importando histórico de conversas do WhatsApp...');
    
    // Read the chats JSON file
    const chatsData = JSON.parse(readFileSync('/tmp/all_chats.json', 'utf8'));
    const chats = Array.isArray(chatsData) ? chatsData : [];
    
    console.log(`📊 Total de conversas encontradas: ${chats.length}`);
    
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const chat of chats) {
      try {
        const remoteJid = chat.remoteJid;
        
        // Skip group chats (contain @g.us) and broadcast (@broadcast)
        if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || remoteJid.includes('@lid')) {
          skipped++;
          continue;
        }
        
        // Extract phone number
        const phone = evolutionAPIService.extractPhoneNumber(remoteJid);
        const name = chat.pushName || phone;
        
        console.log(`\n👤 Processando: ${name} (${phone})`);
        
        // Find or create customer
        let customer = await storage.getCustomerByPhone(phone);
        
        if (!customer) {
          customer = await storage.createCustomer({
            name: name,
            phone: phone,
          });
          console.log(`  ✅ Cliente criado: ${customer.name}`);
        } else {
          console.log(`  ℹ️  Cliente já existe: ${customer.name}`);
        }
        
        // Check if there's an active conversation
        let conversation = await storage.getActiveConversationByCustomer(customer.id);
        
        if (!conversation) {
          // Check for last resolved conversation to reopen
          const lastConversation = await storage.getLastConversationByCustomer(customer.id);
          
          if (lastConversation && lastConversation.status === 'resolved') {
            // Reopen conversation
            conversation = await storage.updateConversationStatus(lastConversation.id, 'new');
            console.log(`  ♻️  Conversa reaberta: ${conversation?.id}`);
          } else {
            // Create new conversation
            conversation = await storage.createConversation({
              customerId: customer.id,
              status: 'new',
              priority: 'normal',
            });
            console.log(`  ✅ Conversa criada: ${conversation.id}`);
          }
        } else {
          console.log(`  ℹ️  Conversa ativa já existe: ${conversation.id}`);
        }
        
        // Fetch chat history for this contact
        console.log(`  📥 Buscando histórico de mensagens...`);
        const historyResult = await evolutionAPIService.fetchChatHistory('BOTHONEST', phone);
        
        if (historyResult.success && historyResult.messages && historyResult.messages.length > 0) {
          console.log(`  📨 ${historyResult.messages.length} mensagens encontradas`);
          
          // Import messages
          let messageCount = 0;
          for (const msg of historyResult.messages) {
            try {
              const messageText = evolutionAPIService.extractMessageText(msg.message);
              const fromMe = msg.key?.fromMe || false;
              
              // Create message
              await storage.createMessage({
                conversationId: conversation!.id,
                senderId: conversation!.agentId || customer.id,
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
        } else {
          console.log(`  ⚠️  Nenhuma mensagem encontrada no histórico`);
        }
        
        imported++;
        
      } catch (chatError) {
        console.error(`❌ Erro ao processar chat:`, chatError);
        errors++;
      }
    }
    
    console.log(`\n\n📊 RESUMO DA IMPORTAÇÃO:`);
    console.log(`✅ Conversas importadas: ${imported}`);
    console.log(`⏭️  Conversas ignoradas (grupos/broadcast): ${skipped}`);
    console.log(`❌ Erros: ${errors}`);
    console.log(`📝 Total processado: ${chats.length}`);
    
  } catch (error) {
    console.error('❌ Erro fatal ao importar conversas:', error);
    process.exit(1);
  }
}

// Run the import
importAllChats()
  .then(() => {
    console.log('\n✅ Importação concluída!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Erro:', error);
    process.exit(1);
  });
