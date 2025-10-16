import { getOmieService } from '../server/omieIntegration';

async function checkOrderStages() {
  const omie = getOmieService();
  
  if (!omie) {
    console.error('Omie não configurado!');
    return;
  }
  
  // Dados do banco:
  // Notas indevidas (antigas) com seus omie_order_id
  const indevidas = [
    { nf: '00023380', orderId: 4275017943 },
    { nf: '00023477', orderId: 4275942436 },
    { nf: '00023490', orderId: 4275979596 },
    { nf: '00023820', orderId: 4277830746 },
    { nf: '00024249', orderId: 4280805909 }
  ];
  
  // Notas faltando com seus omie_order_id
  const faltando = [
    { nf: '00024925', orderId: 4286855268 },
    { nf: '00024926', orderId: 4286855368 },
    { nf: '00025035', orderId: 4287448731 }
  ];
  
  console.log('=== VERIFICANDO ETAPAS DAS NOTAS INDEVIDAS (antigas de setembro) ===\n');
  
  for (const {nf, orderId} of indevidas) {
    try {
      const result = await omie.makeRequest('/produtos/pedidoetapas/', 'ListarEtapasPedido', {
        nPagina: 1,
        nRegPorPagina: 50,
        nCodPed: orderId
      });
      
      if (result.etapasPedido && result.etapasPedido.length > 0) {
        // Ordenar por data/hora
        const etapas = result.etapasPedido.sort((a: any, b: any) => {
          const dateA = new Date(a.dDtEtapa.split('/').reverse().join('-') + ' ' + (a.cHrEtapa || '00:00:00'));
          const dateB = new Date(b.dDtEtapa.split('/').reverse().join('-') + ' ' + (b.cHrEtapa || '00:00:00'));
          return dateB.getTime() - dateA.getTime();
        });
        
        const ultima = etapas[0];
        const mapping: Record<string, string> = {
          '10': 'Aguardando Faturamento',
          '20': 'Em Rota',
          '50': 'Faturado',
          '60': 'Faturado',
          '70': 'Entregue',
          '80': 'Aguardando Rota',
          '90': 'Cancelado'
        };
        
        const etapaReal = mapping[ultima.cEtapa] || ultima.cEtapa;
        const cancelado = ultima.cancelamento?.cCancelado === 'S';
        
        console.log(`\n📋 NF ${nf} (Pedido ${orderId}):`);
        console.log(`  Etapa no banco: Aguardando Rota`);
        console.log(`  Etapa real (Omie): ${etapaReal} (código ${ultima.cEtapa})`);
        console.log(`  Data etapa: ${ultima.dDtEtapa} ${ultima.cHrEtapa}`);
        console.log(`  Cancelado: ${cancelado ? 'SIM' : 'NÃO'}`);
        console.log(`  ❌ INDEVIDA!`);
      }
    } catch (err: any) {
      console.log(`\n❌ NF ${nf}: ERRO - ${err.message}`);
    }
  }
  
  console.log('\n\n=== VERIFICANDO ETAPAS DAS NOTAS FALTANDO ===\n');
  
  for (const {nf, orderId} of faltando) {
    try {
      const result = await omie.makeRequest('/produtos/pedidoetapas/', 'ListarEtapasPedido', {
        nPagina: 1,
        nRegPorPagina: 50,
        nCodPed: orderId
      });
      
      if (result.etapasPedido && result.etapasPedido.length > 0) {
        const etapas = result.etapasPedido.sort((a: any, b: any) => {
          const dateA = new Date(a.dDtEtapa.split('/').reverse().join('-') + ' ' + (a.cHrEtapa || '00:00:00'));
          const dateB = new Date(b.dDtEtapa.split('/').reverse().join('-') + ' ' + (b.cHrEtapa || '00:00:00'));
          return dateB.getTime() - dateA.getTime();
        });
        
        const ultima = etapas[0];
        const mapping: Record<string, string> = {
          '10': 'Aguardando Faturamento',
          '20': 'Em Rota',
          '50': 'Faturado',
          '60': 'Faturado',
          '70': 'Entregue',
          '80': 'Aguardando Rota',
          '90': 'Cancelado'
        };
        
        const etapaReal = mapping[ultima.cEtapa] || ultima.cEtapa;
        const cancelado = ultima.cancelamento?.cCancelado === 'S';
        
        console.log(`\n📋 NF ${nf} (Pedido ${orderId}):`);
        console.log(`  Etapa no banco: ${nf === '00025035' ? 'Faturado' : 'NULL'}`);
        console.log(`  Etapa real (Omie): ${etapaReal} (código ${ultima.cEtapa})`);
        console.log(`  Data etapa: ${ultima.dDtEtapa} ${ultima.cHrEtapa}`);
        console.log(`  Cancelado: ${cancelado ? 'SIM' : 'NÃO'}`);
        if (etapaReal === 'Aguardando Rota') {
          console.log(`  ✅ Deveria estar no sistema!`);
        }
      }
    } catch (err: any) {
      console.log(`\n❌ NF ${nf}: ERRO - ${err.message}`);
    }
  }
}

checkOrderStages().catch(console.error);
