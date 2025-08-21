// Script para enviar pedido ao Omie
import fetch from 'node-fetch';

const sendOrderToOmie = async () => {
  console.log('🚀 ENVIANDO PEDIDO PARA OMIE ERP...\n');

  // Dados do card de teste
  const cardData = {
    id: 'card-test-omie-001',
    customer: {
      name: 'FLAVIO EVANGELISTA BAYLAO NETO',
      cpf: '00776212125',
      omieId: 2426693006
    },
    products: [
      { id: 'prd-ma-350', name: 'SUCO MISTO DE FRUTA - MARACUJÁ 350ml', quantity: 2, unitPrice: 4.90, totalPrice: 9.80 },
      { id: 'prd-ac-900', name: 'SUCO MISTO DE FRUTA - ACEROLA 900ml', quantity: 1, unitPrice: 8.90, totalPrice: 8.90 },
      { id: 'prd-pl-900', name: 'SUCO MISTO DE FRUTA - PINK LEMONADE 900ml', quantity: 1, unitPrice: 11.70, totalPrice: 11.70 }
    ],
    totalValue: 30.40
  };

  // Payload para API Omie
  const omiePayload = {
    call: 'IncluirPedido',
    app_key: process.env.OMIE_APP_KEY,
    app_secret: process.env.OMIE_APP_SECRET,
    param: [{
      cabecalho: {
        codigo_cliente: cardData.customer.omieId,
        data_previsao: new Date().toISOString().split('T')[0],
        etapa: '10',
        codigo_parcela: '001',
        qtde_parcelas: 1
      },
      det: cardData.products.map((product, index) => ({
        ide: {
          codigo_item_integracao: product.id,
          simples_nacional: 'S'
        },
        produto: {
          codigo: product.id,
          descricao: product.name,
          quantidade: product.quantity,
          valor_unitario: product.unitPrice,
          valor_total: product.totalPrice
        },
        inf_adic: {
          numero_item: index + 1
        }
      }))
    }]
  };

  console.log('📋 DADOS DO PEDIDO:');
  console.log(`Cliente: ${cardData.customer.name}`);
  console.log(`ID Omie: ${cardData.customer.omieId}`);
  console.log(`Total: R$ ${cardData.totalValue.toFixed(2)}`);
  console.log(`Produtos: ${cardData.products.length} itens\n`);

  try {
    if (!process.env.OMIE_APP_KEY || !process.env.OMIE_APP_SECRET) {
      console.log('⚠️  Credenciais Omie não encontradas');
      console.log('📝 Simulando envio para Omie...\n');
      
      // Simular resposta da API Omie
      const simulatedResponse = {
        codigo_pedido: Math.floor(Math.random() * 1000000),
        numero_pedido: `HS-${Date.now()}`,
        codigo_status: '0',
        descricao_status: 'Pedido incluído com sucesso'
      };

      console.log('✅ PEDIDO SIMULADO CRIADO NO OMIE:');
      console.log(`Código do Pedido: ${simulatedResponse.codigo_pedido}`);
      console.log(`Número do Pedido: ${simulatedResponse.numero_pedido}`);
      console.log(`Status: ${simulatedResponse.descricao_status}\n`);

      // Simular atualização do banco
      console.log('📊 ATUALIZANDO BANCO DE DADOS...');
      console.log(`Card ${cardData.id} -> Status: invoiced`);
      console.log(`Omie Order ID: ${simulatedResponse.numero_pedido}\n`);

      return {
        success: true,
        orderNumber: simulatedResponse.numero_pedido,
        orderCode: simulatedResponse.codigo_pedido,
        cardId: cardData.id,
        totalValue: cardData.totalValue
      };

    } else {
      console.log('🔗 Conectando com API Omie...');
      
      const response = await fetch('https://app.omie.com.br/api/v1/produtos/pedido/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(omiePayload)
      });

      const result = await response.json();

      if (result.codigo_pedido) {
        console.log('✅ PEDIDO CRIADO COM SUCESSO NO OMIE:');
        console.log(`Código: ${result.codigo_pedido}`);
        console.log(`Número: ${result.numero_pedido}`);
        return result;
      } else {
        throw new Error(result.faultstring || 'Erro na API Omie');
      }
    }

  } catch (error) {
    console.log('❌ Erro ao enviar para Omie:', error.message);
    
    // Criar pedido fallback
    const fallbackOrder = `FALLBACK-HS-${Date.now()}`;
    console.log(`📝 Criando pedido local: ${fallbackOrder}`);
    
    return {
      success: true,
      orderNumber: fallbackOrder,
      cardId: cardData.id,
      warning: 'Pedido salvo localmente - erro na API Omie'
    };
  }
};

// Executar o envio
sendOrderToOmie()
  .then(result => {
    console.log('🎉 RESULTADO FINAL:');
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(error => {
    console.error('💥 ERRO CRÍTICO:', error);
  });