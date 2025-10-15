// Script para consultar etapas de faturamento do Omie
const OMIE_APP_KEY = process.env.OMIE_APP_KEY;
const OMIE_APP_SECRET = process.env.OMIE_APP_SECRET;
const BASE_URL = 'https://app.omie.com.br/api/v1';

async function makeRequest(endpoint, call, params = {}) {
  const payload = {
    call,
    app_key: OMIE_APP_KEY,
    app_secret: OMIE_APP_SECRET,
    param: params
  };

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Erro na API Omie:', errorText);
    throw new Error(`Erro HTTP ${response.status}: ${errorText}`);
  }

  return await response.json();
}

async function consultarEtapas() {
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('🔍 CONSULTANDO ETAPAS DE FATURAMENTO NO OMIE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    // 1. Listar etapas disponíveis  
    console.log('📡 Chamando ListarEtapasFaturamento...');
    const etapasResponse = await makeRequest(
      '/produtos/etapafat/',
      'ListarEtapasFaturamento',
      { /* sem parâmetros */ }
    );

    const etapas = etapasResponse.lista_etapas || [];
    console.log(`📋 Total de etapas encontradas: ${etapas.length}\n`);

    // 2. Para cada etapa, contar pedidos
    const results = [];
    for (const etapa of etapas) {
      const codigo = etapa.cCodigo;
      const nome = etapa.cDescricao;
      
      console.log(`🔎 Consultando etapa ${codigo} - ${nome}...`);
      
      try {
        const pedidosResponse = await makeRequest(
          '/produtos/pedido/',
          'ListarPedidos',
          {
            nPagina: 1,
            nRegPorPagina: 1,
            filtrarPorEtapa: codigo
          }
        );

        const total = pedidosResponse.nTotRegistros || 0;
        console.log(`   ✅ ${total} pedidos/notas`);
        
        results.push({ codigo, nome, total });
      } catch (error) {
        console.log(`   ❌ Erro: ${error.message}`);
        results.push({ codigo, nome, total: 0, erro: error.message });
      }
    }

    // 3. Mostrar resumo
    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('📊 RESUMO FINAL:');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    results.forEach(r => {
      const total = String(r.total).padStart(6, ' ');
      console.log(`  ${r.codigo} - ${r.nome.padEnd(30, ' ')}: ${total} notas`);
    });
    
    console.log('\n═══════════════════════════════════════════════════════════════\n\n');

  } catch (error) {
    console.error('❌ Erro fatal:', error);
  }
}

consultarEtapas();
