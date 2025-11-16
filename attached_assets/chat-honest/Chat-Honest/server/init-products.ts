import { storage } from "./storage";

// Produtos baseados na tabela de preços fornecida
const initialProducts = [
  {
    name: "SUCO MISTO DE FRUTA - MARACUJA 900ml",
    description: "Suco misto natural de maracujá",
    price: "9,90",
    size: "900ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - ACEROLA 350ml",
    description: "Suco misto natural de acerola",
    price: "4,90",
    size: "350ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - ACEROLA 900ml",
    description: "Suco misto natural de acerola",
    price: "9,90",
    size: "900ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - FRUTAS VERMELHAS 350ml",
    description: "Suco misto natural de frutas vermelhas",
    price: "6,90",
    size: "350ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - FRUTAS VERMELHAS 900ml",
    description: "Suco misto natural de frutas vermelhas",
    price: "9,90",
    size: "900ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - LIMONADA 350ML",
    description: "Suco misto natural limonada",
    price: "4,40",
    size: "350ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - LIMONADA 900ML",
    description: "Suco misto natural limonada",
    price: "8,90",
    size: "900ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - MARACUJA 350ml",
    description: "Suco misto natural de maracujá",
    price: "4,90",
    size: "350ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - MORANGO COM LIMAO 350ml",
    description: "Suco misto natural de morango com limão",
    price: "4,90",
    size: "350ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - MORANGO COM LIMÃO 900ml",
    description: "Suco misto natural de morango com limão",
    price: "9,90",
    size: "900ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - MORANGO COM MARACUJA 350ml",
    description: "Suco misto natural de morango com maracujá",
    price: "4,90",
    size: "350ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - MORANGO COM MARACUJA 900ml",
    description: "Suco misto natural de morango com maracujá",
    price: "9,90",
    size: "900ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - PINK LEMONADE 350ml",
    description: "Suco misto natural pink lemonade",
    price: "6,30",
    size: "350ml",
    category: "suco"
  },
  {
    name: "SUCO MISTO DE FRUTA - PINK LEMONADE 900ml",
    description: "Suco misto natural pink lemonade",
    price: "11,70",
    size: "900ml",
    category: "suco"
  }
];

export async function initializeProducts() {
  try {
    // Verificar se já existem produtos
    const existingProducts = await storage.getAllProducts();
    
    if (existingProducts.length === 0) {
      console.log("📦 Inicializando produtos...");
      
      for (const product of initialProducts) {
        await storage.createProduct(product);
      }
      
      console.log(`✅ ${initialProducts.length} produtos criados com sucesso!`);
    } else {
      console.log(`📦 ${existingProducts.length} produtos já existem no banco de dados`);
    }
  } catch (error) {
    console.error("❌ Erro ao inicializar produtos:", error);
  }
}

// Função para criar mensagem de múltipla escolha pré-formatada
export async function initializeQuickMessages(adminUserId: string) {
  try {
    const existingMessages = await storage.getAllQuickMessages();
    
    if (existingMessages.length === 0) {
      console.log("💬 Inicializando mensagens rápidas...");
      
      // Obter todos os produtos ativos para criar o cardápio
      const products = await storage.getActiveProducts();
      
      // Criar cardápio formatado para WhatsApp
      let menuText = "🧃 *CARDÁPIO DE SUCOS NATURAIS* 🧃\n\n";
      menuText += "*Para fazer seu pedido, responda com:*\n";
      menuText += "Produto + Quantidade\n\n";
      menuText += "📋 *PRODUTOS DISPONÍVEIS:*\n\n";
      
      // Agrupar por sabor para melhor organização
      const groupedProducts: { [key: string]: any[] } = {};
      
      products.forEach(product => {
        const flavor = product.name.split(' - ')[1]?.split(' ')[0] || 'OUTROS';
        if (!groupedProducts[flavor]) {
          groupedProducts[flavor] = [];
        }
        groupedProducts[flavor].push(product);
      });
      
      // Gerar cardápio organizado por sabor
      Object.keys(groupedProducts).sort().forEach(flavor => {
        menuText += `🍃 *${flavor}*\n`;
        groupedProducts[flavor].forEach(product => {
          menuText += `• ${product.name.replace('SUCO MISTO DE FRUTA - ', '')} - R$ ${product.price}\n`;
        });
        menuText += "\n";
      });
      
      menuText += "💡 *Exemplo de pedido:*\n";
      menuText += "ACEROLA 350ml - 2 unidades\n";
      menuText += "MARACUJA 900ml - 1 unidade\n\n";
      menuText += "📞 *Em caso de dúvidas, fale conosco!*";
      
      const quickMessages = [
        {
          title: "Cardápio Completo",
          content: menuText,
          messageType: "product_menu" as const,
          createdBy: adminUserId,
          isActive: true
        },
        {
          title: "Saudação Inicial",
          content: "Olá! 👋 Bem-vindo(a) à nossa loja de sucos naturais! 🧃\n\nEstamos aqui para atendê-lo(a) com os melhores produtos.\n\nGostaria de ver nosso cardápio?",
          messageType: "text" as const,
          createdBy: adminUserId,
          isActive: true
        },
        {
          title: "Confirmação de Pedido",
          content: "✅ *Pedido Recebido!*\n\nVamos confirmar seu pedido:\n\n📋 *RESUMO:*\n[PRODUTOS_AQUI]\n\n💰 *Total: R$ [VALOR_TOTAL]*\n\nConfirma este pedido? Responda *SIM* para continuar.",
          messageType: "order_form" as const,
          createdBy: adminUserId,
          isActive: true
        },
        {
          title: "Informações de Entrega",
          content: "🚚 *Informações para Entrega*\n\nPrecisamos de algumas informações:\n\n📍 *Endereço completo:*\n🏠 Rua, número, bairro\n\n📱 *Telefone de contato:*\n\n⏰ *Horário preferido:*\n\nNosso prazo de entrega é de 30-45 minutos.",
          messageType: "text" as const,
          createdBy: adminUserId,
          isActive: true
        },
        {
          title: "Agradecimento Final",
          content: "🎉 *Obrigado pelo seu pedido!*\n\nSeu pedido foi confirmado e já está sendo preparado! 👩‍🍳\n\n📦 *Status:* Em preparação\n⏰ *Tempo estimado:* 30-45 minutos\n\nEm breve entraremos em contato para confirmar a entrega!\n\n🧃 Aguarde nossos deliciosos sucos naturais! 😋",
          messageType: "text" as const,
          createdBy: adminUserId,
          isActive: true
        }
      ];
      
      for (const message of quickMessages) {
        await storage.createQuickMessage(message);
      }
      
      console.log(`✅ ${quickMessages.length} mensagens rápidas criadas com sucesso!`);
    } else {
      console.log(`💬 ${existingMessages.length} mensagens rápidas já existem no banco de dados`);
    }
  } catch (error) {
    console.error("❌ Erro ao inicializar mensagens rápidas:", error);
  }
}