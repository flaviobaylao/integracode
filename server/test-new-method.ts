import { storage } from './storage';

async function testNewMethod() {
  console.log('=== TESTANDO NOVO MÉTODO getCustomerByDocument ===\n');

  // Testar com alguns CPFs da lista
  const testDocuments = [
    '72797495187',  // ACQUA BISTRO
    '01500976113',  // ADRIANO AUGUSTO
    '42019076861',  // ALEXSANDRA CRISTINA
    '00058238000178' // Um CNPJ para testar também
  ];

  for (const doc of testDocuments) {
    console.log(`\n🔍 Buscando documento: ${doc}`);
    
    // Método ANTIGO (só CNPJ)
    const oldMethod = await storage.getCustomerByCnpj(doc);
    console.log(`   Método antigo (getCustomerByCnpj): ${oldMethod ? `✅ ENCONTRADO - ${oldMethod.fantasyName}` : '❌ NÃO ENCONTRADO'}`);
    
    // Método NOVO (CNPJ ou CPF)
    const newMethod = await storage.getCustomerByDocument(doc);
    console.log(`   Método novo (getCustomerByDocument): ${newMethod ? `✅ ENCONTRADO - ${newMethod.fantasyName}` : '❌ NÃO ENCONTRADO'}`);
    
    if (newMethod) {
      console.log(`   → CPF: ${newMethod.cpf || 'N/A'}`);
      console.log(`   → CNPJ: ${newMethod.cnpj || 'N/A'}`);
      console.log(`   → Código Omie: ${newMethod.omieClientCode || 'N/A'}`);
    }
  }
}

testNewMethod()
  .then(() => {
    console.log('\n✅ Teste concluído');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro no teste:', err);
    process.exit(1);
  });
