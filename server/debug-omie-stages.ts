import { getOmieService } from './omieIntegration';
import { storage } from './storage';

async function debugOmieStages() {
  try {
    console.log('🔍 Verificando códigos de etapa do Omie...\n');
    
    const omieService = getOmieService(storage);
    
    if (!omieService) {
      console.error('❌ Serviço Omie não configurado!');
      process.exit(1);
    }
    
    // Buscar pedidos recentes (últimos 10 dias)
    console.log('📊 Buscando pedidos dos últimos 10 dias...');
    const response = await (omieService as any).listOrders(1, 100);
    const orders = response.pedido_venda_produto || [];
    
    console.log(`✅ Encontrados ${orders.length} pedidos\n`);
    
    // Mapear etapas
    const stageCounts: Record<string, number> = {};
    const stageExamples: Record<string, string[]> = {};
    
    for (const order of orders) {
      const etapa = order.cabecalho?.etapa || 'UNKNOWN';
      const orderNumber = order.cabecalho?.numero_pedido || 'N/A';
      const invoiceNumber = order.faturamento?.cNumNFE || order.informacoes_adicionais?.numero_nf || 'Sem NF';
      
      // Contar
      stageCounts[etapa] = (stageCounts[etapa] || 0) + 1;
      
      // Guardar exemplos
      if (!stageExamples[etapa]) {
        stageExamples[etapa] = [];
      }
      if (stageExamples[etapa].length < 3) {
        stageExamples[etapa].push(`Pedido ${orderNumber}, NF ${invoiceNumber}`);
      }
    }
    
    // Exibir resultados
    console.log('📊 DISTRIBUIÇÃO DE ETAPAS:');
    console.log('='.repeat(60));
    
    const sortedStages = Object.entries(stageCounts)
      .sort((a, b) => b[1] - a[1]);
    
    for (const [etapa, count] of sortedStages) {
      console.log(`\n🔸 Etapa ${etapa}: ${count} pedidos`);
      console.log(`   Exemplos:`);
      for (const example of stageExamples[etapa]) {
        console.log(`   - ${example}`);
      }
    }
    
    // Verificar se existe etapa 80
    console.log('\n' + '='.repeat(60));
    if (stageCounts['80']) {
      console.log(`✅ Etapa 80 (Aguardando Rota) EXISTE: ${stageCounts['80']} pedidos`);
    } else {
      console.log(`⚠️ Etapa 80 (Aguardando Rota) NÃO ENCONTRADA!`);
    }
    
    if (stageCounts['20']) {
      console.log(`📋 Etapa 20 (Em Rota): ${stageCounts['20']} pedidos`);
    }
    
    // Buscar etapas de alguns pedidos específicos da etapa 20
    if (stageCounts['20']) {
      console.log('\n' + '='.repeat(60));
      console.log('🔍 Detalhando alguns pedidos da etapa 20...\n');
      
      let detailCount = 0;
      for (const order of orders) {
        if (order.cabecalho?.etapa === '20' && detailCount < 5) {
          const omieOrderId = order.cabecalho?.codigo_pedido?.toString();
          const orderNumber = order.cabecalho?.numero_pedido;
          const invoiceNumber = order.faturamento?.cNumNFE || order.informacoes_adicionais?.numero_nf;
          
          console.log(`📋 Pedido ${orderNumber} (ID: ${omieOrderId})`);
          console.log(`   NF: ${invoiceNumber || 'Sem NF'}`);
          console.log(`   Etapa do cabeçalho: ${order.cabecalho?.etapa}`);
          
          // Buscar etapas detalhadas via API
          if (omieOrderId) {
            try {
              const stageResult = await (omieService as any).fetchPedidoStage(omieOrderId);
              if (stageResult) {
                console.log(`   Etapa da API: ${stageResult.cEtapa} -> ${stageResult.stageName}`);
                console.log(`   Data: ${stageResult.dDtEtapa} ${stageResult.cHrEtapa}`);
              }
            } catch (error) {
              console.log(`   ⚠️ Erro ao buscar etapa: ${error}`);
            }
          }
          
          console.log('');
          detailCount++;
        }
      }
    }
    
    console.log('✅ Diagnóstico concluído!');
    process.exit(0);
    
  } catch (error: any) {
    console.error('❌ Erro:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

debugOmieStages();
