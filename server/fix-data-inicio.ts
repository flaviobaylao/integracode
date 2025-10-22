import * as XLSX from 'xlsx';
import { storage } from './storage';

async function testNewLogic() {
  console.log('=== TESTANDO NOVA LÓGICA DE DATA INICIO ===\n');
  
  // Mapear dias da semana
  const routeDayToNumber: Record<string, number> = {
    'domingo': 0,
    'segunda': 1,
    'terca': 2,
    'quarta': 3,
    'quinta': 4,
    'sexta': 5,
    'sabado': 6
  };
  
  // Casos de teste
  const testCases = [
    {
      name: 'DATA INICIO cai exatamente no dia da rota',
      dataInicio: new Date(2025, 9, 27), // 27/10/2025 = segunda-feira
      routeDay: 'segunda',
      expected: new Date(2025, 9, 27) // Deve ser 27/10/2025 (mesma data!)
    },
    {
      name: 'DATA INICIO é antes do dia da rota (mesmo semana)',
      dataInicio: new Date(2025, 9, 26), // 26/10/2025 = domingo
      routeDay: 'terca',
      expected: new Date(2025, 9, 28) // Deve ser 28/10/2025 (próxima terça)
    },
    {
      name: 'DATA INICIO é depois do dia da rota (vai para próxima semana)',
      dataInicio: new Date(2025, 9, 29), // 29/10/2025 = quarta
      routeDay: 'segunda',
      expected: new Date(2025, 10, 3) // Deve ser 03/11/2025 (próxima segunda)
    }
  ];
  
  console.log('🧪 Executando casos de teste:\n');
  
  for (const test of testCases) {
    console.log(`Teste: ${test.name}`);
    console.log(`  DATA INICIO: ${test.dataInicio.toLocaleDateString('pt-BR')} (${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'][test.dataInicio.getDay()]})`);
    console.log(`  ROTA: ${test.routeDay}`);
    
    // Aplicar nova lógica
    const targetDayNumber = routeDayToNumber[test.routeDay];
    let nextVisitDate = new Date(test.dataInicio);
    nextVisitDate.setHours(0, 0, 0, 0);
    
    const currentDayNumber = nextVisitDate.getDay();
    let daysUntilTarget = targetDayNumber - currentDayNumber;
    
    // NOVA LÓGICA: só pula se já passou (< 0), não se é igual (= 0)
    if (daysUntilTarget < 0) {
      daysUntilTarget += 7;
    }
    
    nextVisitDate.setDate(nextVisitDate.getDate() + daysUntilTarget);
    
    console.log(`  Resultado: ${nextVisitDate.toLocaleDateString('pt-BR')}`);
    console.log(`  Esperado: ${test.expected.toLocaleDateString('pt-BR')}`);
    
    if (nextVisitDate.getTime() === test.expected.getTime()) {
      console.log(`  ✅ PASSOU!\n`);
    } else {
      console.log(`  ❌ FALHOU!\n`);
    }
  }
  
  // Análise dos cards existentes para ver quantos foram afetados
  console.log('\n=== ANÁLISE DOS CARDS EXISTENTES ===\n');
  
  const workbook = XLSX.readFile('attached_assets/importacao dados integra atualizado 21.10_1761160013498.xlsx');
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(worksheet) as any[];
  
  let affectedCount = 0;
  const affectedCards = [];
  
  for (const row of rows) {
    const cnpjRaw = row['CNPJ/CPF'] || row.CNPJ;
    const dataInicioCol = row['DATA INICIO'] || row['Data Inicio'];
    const routeDayCol = row['ROTA'] || row.Rota;
    
    if (!cnpjRaw || !dataInicioCol || !routeDayCol) continue;
    
    const document = cnpjRaw.toString().replace(/\D/g, '');
    const customer = await storage.getCustomerByDocument(document);
    
    if (!customer) continue;
    
    // Parsear DATA INICIO
    let dataInicio: Date | null = null;
    const dataStr = dataInicioCol.toString().trim();
    
    if (!isNaN(Number(dataStr))) {
      const excelEpoch = new Date(1900, 0, 1);
      const days = parseInt(dataStr) - 2;
      dataInicio = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);
    }
    
    if (!dataInicio) continue;
    
    // Normalizar dia da rota
    const dayStr = routeDayCol.toString().toLowerCase().trim();
    const dayMap: Record<string, string> = {
      'segunda-feira': 'segunda', 'terca-feira': 'terca', 'terça-feira': 'terca',
      'quarta-feira': 'quarta', 'quinta-feira': 'quinta', 'sexta-feira': 'sexta',
      'sabado': 'sabado', 'sábado': 'sabado', 'domingo': 'domingo'
    };
    const routeDay = dayMap[dayStr] || dayStr;
    
    // Verificar se DATA INICIO cai no dia da rota
    const dataInicioDayOfWeek = dataInicio.getDay();
    const targetDayNumber = routeDayToNumber[routeDay];
    
    if (dataInicioDayOfWeek === targetDayNumber) {
      // Este card foi afetado pelo bug!
      const allCards = await storage.getSalesCards();
      const customerCard = allCards.find(c => c.customerId === customer.id);
      
      if (customerCard) {
        const scheduledDate = new Date(customerCard.scheduledDate);
        affectedCount++;
        affectedCards.push({
          customer: customer.fantasyName,
          dataInicio: dataInicio.toLocaleDateString('pt-BR'),
          routeDay,
          currentScheduled: scheduledDate.toLocaleDateString('pt-BR'),
          shouldBe: dataInicio.toLocaleDateString('pt-BR')
        });
      }
    }
  }
  
  console.log(`📊 Cards afetados pelo bug: ${affectedCount}`);
  
  if (affectedCount > 0) {
    console.log('\n📋 Primeiros 10 exemplos de cards afetados:\n');
    affectedCards.slice(0, 10).forEach((card, i) => {
      console.log(`${i + 1}. ${card.customer}`);
      console.log(`   DATA INICIO: ${card.dataInicio} (${card.routeDay})`);
      console.log(`   Agendado: ${card.currentScheduled} (ERRADO - 1 semana a mais)`);
      console.log(`   Deveria ser: ${card.shouldBe}`);
      console.log('');
    });
  }
}

testNewLogic()
  .then(() => {
    console.log('\n✅ Análise concluída');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
