import { db } from './server/db';
import { salesCards, customers } from './shared/schema';
import { gte, eq } from 'drizzle-orm';

async function diagnoseCards() {
  console.log('🔍 DIAGNÓSTICO DE CARDS - Sistema Integra\n');
  console.log('=' .repeat(80));
  
  try {
    // Buscar todos os cards futuros com seus clientes
    const allCards = await db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .where(gte(salesCards.scheduledDate, new Date()))
      .orderBy(salesCards.scheduledDate);

    console.log(`\n📋 Total de cards futuros: ${allCards.length}\n`);

    const inconsistencies: any[] = [];
    const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

    for (const row of allCards) {
      const card = row.sales_cards;
      const customer = row.customers;

      if (!customer || !customer.weekdays) continue;

      let customerWeekdays: string[] = [];
      try {
        customerWeekdays = typeof customer.weekdays === 'string' 
          ? JSON.parse(customer.weekdays) 
          : customer.weekdays || [];
      } catch (e) {
        continue;
      }

      if (customerWeekdays.length === 0) continue;

      // Verificar se o dia do card está alinhado
      const scheduledDate = new Date(card.scheduledDate);
      const scheduledDayOfWeek = scheduledDate.getDay();
      const scheduledDayName = weekdayNames[scheduledDayOfWeek];

      if (!customerWeekdays.includes(scheduledDayName)) {
        inconsistencies.push({
          cliente: customer.fantasyName || customer.name || 'SEM NOME',
          dataAgendada: scheduledDate.toLocaleDateString('pt-BR'),
          diaAgendado: scheduledDayName,
          diasCorretos: customerWeekdays.join(', '),
          cardId: card.id,
          status: card.status
        });
      }
    }

    if (inconsistencies.length === 0) {
      console.log('✅ PERFEITO! Nenhuma inconsistência encontrada!\n');
      console.log('   Todos os cards estão agendados nos dias corretos.\n');
    } else {
      console.log(`⚠️  ATENÇÃO: ${inconsistencies.length} INCONSISTÊNCIAS DETECTADAS\n`);
      console.log('=' .repeat(80));
      
      console.log('\nCards com datas incompatíveis:\n');
      
      inconsistencies.slice(0, 20).forEach((item, index) => {
        console.log(`${index + 1}. ${item.cliente}`);
        console.log(`   📅 Agendado para: ${item.dataAgendada} (${item.diaAgendado})`);
        console.log(`   ✅ Deveria ser: ${item.diasCorretos}`);
        console.log(`   🆔 Card ID: ${item.cardId}`);
        console.log(`   📊 Status: ${item.status}`);
        console.log('');
      });

      if (inconsistencies.length > 20) {
        console.log(`   ... e mais ${inconsistencies.length - 20} cards com problemas\n`);
      }

      console.log('=' .repeat(80));
      console.log('\n📝 COMO CORRIGIR:\n');
      console.log('Opção 1 - Correção Automática via API:');
      console.log('   POST /api/admin/validate-cards');
      console.log('   Body: { "autoFix": true }\n');
      console.log('Opção 2 - Re-sincronizar Agenda:');
      console.log('   POST /api/admin/sync-agenda\n');
      console.log('Opção 3 - Re-importar planilha:');
      console.log('   Vá em Gestão de Clientes → Importar Sales Cards\n');
    }

    // Estatísticas gerais
    console.log('\n📊 ESTATÍSTICAS GERAIS\n');
    console.log('=' .repeat(80));
    
    const cardsByDay: Record<string, number> = {};
    allCards.forEach(row => {
      const card = row.sales_cards;
      const scheduledDate = new Date(card.scheduledDate);
      const dayName = weekdayNames[scheduledDate.getDay()];
      cardsByDay[dayName] = (cardsByDay[dayName] || 0) + 1;
    });

    console.log('\nDistribuição de cards por dia da semana:');
    Object.entries(cardsByDay)
      .sort((a, b) => weekdayNames.indexOf(a[0]) - weekdayNames.indexOf(b[0]))
      .forEach(([day, count]) => {
        console.log(`  ${day}: ${count} cards`);
      });

    console.log('\n✅ Diagnóstico concluído!\n');

    process.exit(inconsistencies.length > 0 ? 1 : 0);

  } catch (error) {
    console.error('\n❌ Erro durante diagnóstico:', error);
    process.exit(1);
  }
}

diagnoseCards();
