import { omieRequest } from './server/omieIntegration';

async function testFields() {
  console.log('🔍 Buscando todos os campos disponíveis em um título...\n');
  
  const response = await omieRequest('/financas/contareceber/', 'ListarContasReceber', {
    pagina: 1,
    registros_por_pagina: 1,
    apenas_importado_api: 'N'
  });

  if (response && response.conta_receber_cadastro && response.conta_receber_cadastro.length > 0) {
    const titulo = response.conta_receber_cadastro[0];
    console.log('📋 Campos disponíveis no título:');
    console.log(JSON.stringify(titulo, null, 2));
  } else {
    console.log('❌ Nenhum título encontrado');
  }
}

testFields().catch(console.error);
