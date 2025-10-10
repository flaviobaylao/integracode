import { storage } from './server/storage.js';
import { getOmieService } from './server/omieIntegration.js';

async function test() {
  console.log('🧪 Testando sincronização de débitos vencidos...\n');
  
  const omieService = getOmieService(storage);
  if (!omieService) {
    console.error('❌ Serviço Omie não configurado');
    return;
  }
  
  const result = await omieService.getOverdueDebts();
  
  console.log('📊 RESULTADO DA SINCRONIZAÇÃO:');
  console.log(`   Clientes com débito: ${result.totalClients}`);
  console.log(`   Total de débitos: R$ ${result.totalAmount.toFixed(2)}`);
  console.log(`   Títulos encontrados: ${result.debts.length}`);
  
  console.log('\n📋 ESPERADO (do Excel):');
  console.log(`   Clientes: 84`);
  console.log(`   Total: R$ 19.783,10`);
  
  const diffClientes = result.totalClients - 84;
  const diffValor = result.totalAmount - 19783.10;
  
  console.log('\n🔍 DIFERENÇA:');
  console.log(`   Clientes: ${diffClientes > 0 ? '+' : ''}${diffClientes}`);
  console.log(`   Valor: R$ ${diffValor > 0 ? '+' : ''}${diffValor.toFixed(2)}`);
  
  if (Math.abs(diffClientes) <= 5 && Math.abs(diffValor) <= 100) {
    console.log('\n✅ SUCESSO! Valores próximos ao esperado!');
  } else {
    console.log('\n⚠️ ATENÇÃO: Ainda há diferença significativa');
    
    // Mostrar alguns exemplos de débitos
    console.log('\n📝 Primeiros 5 clientes:');
    result.debts.slice(0, 5).forEach((debt, i) => {
      console.log(`${i+1}. ${debt.cliente.nome_fantasia}: R$ ${debt.valorTotal.toFixed(2)} (${debt.diasMaximoAtraso} dias)`);
    });
  }
}

test().catch(console.error);
