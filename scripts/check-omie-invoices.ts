import { getOmieService } from '../server/omieIntegration';

async function checkInvoices() {
  const omie = getOmieService();
  
  if (!omie) {
    console.error('Omie não configurado!');
    return;
  }
  
  // Notas indevidas (antigas)
  const indevidas = ['00023380', '00023477', '00023490', '00023820', '00024249'];
  
  // Notas faltando  
  const faltando = ['00024925', '00024926', '00025035'];
  
  console.log('=== VERIFICANDO NOTAS INDEVIDAS (antigas de setembro) ===\n');
  
  for (const nf of indevidas) {
    try {
      const result = await omie.makeRequest('/produtos/nfconsultar/', 'ConsultarNF', {
        nNF: nf,
        cSerie: '001'
      });
      
      console.log(`\n📋 NF ${nf}:`);
      console.log(`  Status: ${result.cabecalho?.nfProdServStatus?.cStat || 'N/A'}`);
      console.log(`  Etapa: ${result.cabecalho?.etapa || result.cabecalho?.nfProdServStatus?.cEtapa || 'N/A'}`);
      console.log(`  Cancelada: ${result.cabecalho?.nfProdServStatus?.cCancelado || 'N'}`);
      console.log(`  Data emissão: ${result.ide?.dEmi || 'N/A'}`);
    } catch (err: any) {
      console.log(`\n❌ NF ${nf}: ERRO - ${err.message}`);
    }
  }
  
  console.log('\n\n=== VERIFICANDO NOTAS FALTANDO (deveriam estar Aguardando Rota) ===\n');
  
  for (const nf of faltando) {
    try {
      const result = await omie.makeRequest('/produtos/nfconsultar/', 'ConsultarNF', {
        nNF: nf,
        cSerie: '001'
      });
      
      console.log(`\n📋 NF ${nf}:`);
      console.log(`  Status: ${result.cabecalho?.nfProdServStatus?.cStat || 'N/A'}`);
      console.log(`  Etapa: ${result.cabecalho?.etapa || result.cabecalho?.nfProdServStatus?.cEtapa || 'N/A'}`);
      console.log(`  Cancelada: ${result.cabecalho?.nfProdServStatus?.cCancelado || 'N'}`);
      console.log(`  Data emissão: ${result.ide?.dEmi || 'N/A'}`);
    } catch (err: any) {
      console.log(`\n❌ NF ${nf}: ERRO - ${err.message}`);
    }
  }
}

checkInvoices().catch(console.error);
