// Teste manual da integração com Omie - Envio de Pedido
// Simula o envio de um card de venda para o Omie ERP

const testOmieOrderSubmission = async () => {
  console.log('=== TESTE DE ENVIO DE PEDIDO PARA OMIE ERP ===\n');

  // Dados do card de teste que criamos
  const testSalesCard = {
    id: 'card-test-omie-001',
    customer: {
      name: 'FLAVIO EVANGELISTA BAYLAO NETO',
      cpf: '00776212125',
      phone: '(00) 00000-0000',
      address: 'RUA T, 38 - APARTAMENTO 502 912, nº 00'
    },
    products: [
      {
        id: 'prd-ma-350',
        name: 'SUCO MISTO DE FRUTA - MARACUJÁ 350ml',
        quantity: 2,
        unitPrice: 4.90,
        totalPrice: 9.80
      },
      {
        id: 'prd-ac-900',
        name: 'SUCO MISTO DE FRUTA - ACEROLA 900ml',
        quantity: 1,
        unitPrice: 8.90,
        totalPrice: 8.90
      },
      {
        id: 'prd-pl-900',
        name: 'SUCO MISTO DE FRUTA - PINK LEMONADE 900ml',
        quantity: 1,
        unitPrice: 11.70,
        totalPrice: 11.70
      }
    ],
    totalValue: 30.40,
    status: 'completed',
    sellerId: 'admin-flavio'
  };

  console.log('📦 DADOS DO PEDIDO:');
  console.log(`Cliente: ${testSalesCard.customer.name}`);
  console.log(`CPF: ${testSalesCard.customer.cpf}`);
  console.log(`Telefone: ${testSalesCard.customer.phone}`);
  console.log(`Endereço: ${testSalesCard.customer.address}`);
  console.log('\n🥤 PRODUTOS:');
  
  testSalesCard.products.forEach((product, index) => {
    console.log(`${index + 1}. ${product.name}`);
    console.log(`   Quantidade: ${product.quantity}`);
    console.log(`   Preço unitário: R$ ${product.unitPrice.toFixed(2)}`);
    console.log(`   Total: R$ ${product.totalPrice.toFixed(2)}\n`);
  });

  console.log(`💰 TOTAL DO PEDIDO: R$ ${testSalesCard.totalValue.toFixed(2)}\n`);

  // Simular o payload que seria enviado para o Omie
  const omiePayload = {
    call: 'IncluirPedido',
    app_key: process.env.OMIE_APP_KEY,
    app_secret: process.env.OMIE_APP_SECRET,
    param: [{
      cabecalho: {
        codigo_cliente: 2426693006, // ID do cliente no Omie (Flavio)
        data_previsao: new Date().toISOString().split('T')[0],
        etapa: '10', // Pedido
        codigo_parcela: '001',
        qtde_parcelas: 1
      },
      det: testSalesCard.products.map((product, index) => ({
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

  console.log('🔄 PAYLOAD PARA OMIE:');
  console.log('Call: IncluirPedido');
  console.log('Cliente Omie ID: 2426693006 (FLAVIO EVANGELISTA BAYLAO NETO)');
  console.log(`Produtos: ${testSalesCard.products.length} itens`);
  console.log(`Valor Total: R$ ${testSalesCard.totalValue.toFixed(2)}\n`);

  console.log('✅ SIMULAÇÃO CONCLUÍDA!');
  console.log('📝 Este card está pronto para ser enviado ao Omie ERP');
  console.log('🎯 Endpoint: /api/sales-cards/card-test-omie-001/invoice');
  console.log('📋 Status atual: completed (pronto para faturamento)');

  return {
    success: true,
    cardId: testSalesCard.id,
    customerName: testSalesCard.customer.name,
    totalValue: testSalesCard.totalValue,
    productsCount: testSalesCard.products.length,
    omieCustomerId: 2426693006
  };
};

// Executar o teste
if (require.main === module) {
  testOmieOrderSubmission()
    .then(result => {
      console.log('\n🎉 RESULTADO DO TESTE:', result);
    })
    .catch(error => {
      console.error('\n❌ ERRO NO TESTE:', error);
    });
}

module.exports = { testOmieOrderSubmission };