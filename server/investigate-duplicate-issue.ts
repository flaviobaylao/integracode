import { storage } from './storage';
import * as XLSX from 'xlsx';

async function investigateDuplicates() {
  console.log('=== INVESTIGANDO PROBLEMA DE DUPLICATAS ===\n');

  // Ler a planilha
  const workbook = XLSX.readFile('attached_assets/importacao dados integra atualizado 21.10_1761160013498.xlsx');
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(worksheet) as any[];

  console.log(`📋 Total de linhas na planilha: ${rows.length}\n`);

  // Pegar os 5 primeiros clientes da planilha e verificar se eles já tinham cards
  console.log('🔍 Verificando primeiros 5 clientes da planilha:\n');

  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i];
    const cnpjRaw = row['CNPJ/CPF'] || row['cnpj/cpf'] || row['CNPJ'] || row['cnpj'];
    
    if (!cnpjRaw) continue;

    const document = cnpjRaw.toString().replace(/\D/g, '');
    
    // Buscar cliente
    const customer = await storage.getCustomerByDocument(document);
    
    if (customer) {
      console.log(`${i + 1}. ${customer.fantasyName || customer.name}`);
      console.log(`   Documento: ${document}`);
      console.log(`   ID: ${customer.id}`);
      
      // Buscar todos os cards desse cliente
      const allCards = await storage.getSalesCards();
      const customerCards = allCards.filter(c => c.customerId === customer.id);
      
      console.log(`   Total de cards: ${customerCards.length}`);
      
      if (customerCards.length > 0) {
        console.log(`   Últimos 3 cards:`);
        customerCards.slice(0, 3).forEach(card => {
          console.log(`     - ${new Date(card.scheduledDate).toLocaleDateString('pt-BR')} | Status: ${card.status} | Criado em: ${card.createdAt ? new Date(card.createdAt).toLocaleString('pt-BR') : 'N/A'}`);
        });
        
        // Verificar se há cards ATIVOS (pending ou telemarketing)
        const ACTIVE_STATUSES = ['pending', 'telemarketing'];
        const activeCards = customerCards.filter(c => ACTIVE_STATUSES.includes(c.status));
        console.log(`   ⚠️ Cards ATIVOS (pending/telemarketing): ${activeCards.length}`);
      }
      
      console.log('');
    } else {
      console.log(`${i + 1}. Cliente não encontrado (documento: ${document})\n`);
    }
  }

  // Verificar quantos clientes tinham cards antes da importação (criados há mais de 3 horas)
  console.log('\n=== CARDS CRIADOS ANTES DA IMPORTAÇÃO (> 3 horas) ===\n');
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const allCards = await storage.getSalesCards();
  const oldCards = allCards.filter(card => 
    card.createdAt && new Date(card.createdAt) < threeHoursAgo
  );
  
  console.log(`📊 Cards criados antes da importação: ${oldCards.length}`);
  
  // Contar quantos clientes únicos tinham cards
  const uniqueCustomers = new Set(oldCards.map(c => c.customerId));
  console.log(`👥 Clientes únicos com cards antigos: ${uniqueCustomers.size}`);
}

investigateDuplicates()
  .then(() => {
    console.log('\n✅ Investigação concluída');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
