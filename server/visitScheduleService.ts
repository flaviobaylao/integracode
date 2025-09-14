import { db } from './db';
import { customers, visitAgenda } from '../shared/schema';
import { eq, and, gte, lte, isNotNull } from 'drizzle-orm';

// Timezone constants for Brazil (São Paulo)
const BRAZIL_TIMEZONE = 'America/Sao_Paulo';

// Helper function to get current date normalized to Brazil timezone
function getBrazilToday(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: BRAZIL_TIMEZONE }));
}

// Helper function to normalize any date to Brazil timezone
function normalizeToBrazilDate(date: Date): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: BRAZIL_TIMEZONE }));
}

// Helper function to get start of day in Brazil timezone
function getStartOfDayBrazil(date: Date): Date {
  const normalized = normalizeToBrazilDate(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

// Função para calcular a próxima data de visita baseada na periodicidade
function getNextVisitDate(lastDate: Date, periodicity: string): Date {
  const nextDate = new Date(lastDate);
  
  switch (periodicity) {
    case 'semanal':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'quinzenal':
      nextDate.setDate(nextDate.getDate() + 14);
      break;
    case 'mensal':
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case 'bimestral':
      nextDate.setMonth(nextDate.getMonth() + 2);
      break;
    default:
      nextDate.setDate(nextDate.getDate() + 7); // Default semanal
  }
  
  return nextDate;
}

// Função para verificar se um cliente tem visitas agendadas futuras
async function hasUpcomingVisits(customerId: string): Promise<boolean> {
  const today = getBrazilToday();
  const upcomingVisits = await db.select()
    .from(visitAgenda)
    .where(
      and(
        eq(visitAgenda.customerId, customerId),
        gte(visitAgenda.scheduledDate, today),
        eq(visitAgenda.visitStatus, 'pending')
      )
    )
    .limit(1);
    
  return upcomingVisits.length > 0;
}

// Função para calcular o dia da semana em português
function getRouteDay(date: Date): string {
  const days = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const brazilDate = normalizeToBrazilDate(date);
  return days[brazilDate.getDay()];
}

// Função para gerar visitas para um cliente específico
async function generateVisitsForCustomer(customer: any): Promise<number> {
  let generatedCount = 0;
  const today = getBrazilToday();
  
  // Verificar se já tem visitas futuras
  if (await hasUpcomingVisits(customer.id)) {
    return 0;
  }
  
  // Calcular a data base para gerar próximas visitas
  let baseDate = customer.serviceStartDate ? normalizeToBrazilDate(new Date(customer.serviceStartDate)) : today;
  
  // Se a data de início é no futuro, usar ela como base
  if (baseDate > today) {
    // Gerar a primeira visita na data de início do fornecimento
    await db.insert(visitAgenda).values({
      customerId: customer.id,
      sellerId: customer.sellerId,
      scheduledDate: baseDate,
      routeDay: getRouteDay(baseDate),
      recurrenceType: customer.visitPeriodicity || 'semanal',
      isVirtual: customer.virtualService || false,
      visitStatus: 'pending',
      customerName: customer.name,
      customerLatitude: customer.latitude || null,
      customerLongitude: customer.longitude || null,
      customerAddress: customer.address || null,
    }).onConflictDoNothing();
    generatedCount++;
    
    // Gerar as próximas 3 visitas baseado na periodicidade
    let nextDate = baseDate;
    for (let i = 0; i < 3; i++) {
      nextDate = getNextVisitDate(nextDate, customer.visitPeriodicity);
      await db.insert(visitAgenda).values({
        customerId: customer.id,
        sellerId: customer.sellerId,
        scheduledDate: nextDate,
        routeDay: getRouteDay(nextDate),
        recurrenceType: customer.visitPeriodicity || 'semanal',
        isVirtual: customer.virtualService || false,
        visitStatus: 'pending',
        customerName: customer.name,
        customerLatitude: customer.latitude || null,
        customerLongitude: customer.longitude || null,
        customerAddress: customer.address || null,
      }).onConflictDoNothing();
      generatedCount++;
    }
  } else {
    // Para clientes que já deveriam ter início do fornecimento, calcular próxima visita
    const daysSinceStart = Math.floor((today.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24));
    let intervalDays = 7; // Default semanal
    
    switch (customer.visitPeriodicity) {
      case 'quinzenal':
        intervalDays = 14;
        break;
      case 'mensal':
        intervalDays = 30;
        break;
      case 'bimestral':
        intervalDays = 60;
        break;
    }
    
    // Calcular quantas visitas já deveriam ter acontecido
    const missedVisits = Math.floor(daysSinceStart / intervalDays);
    
    // Gerar próxima visita baseada no ciclo
    const nextVisitDate = new Date(baseDate);
    nextVisitDate.setDate(nextVisitDate.getDate() + ((missedVisits + 1) * intervalDays));
    
    // Se a próxima visita é hoje ou no futuro, gerar ela e mais algumas
    if (nextVisitDate >= today) {
      await db.insert(visitAgenda).values({
        customerId: customer.id,
        sellerId: customer.sellerId,
        scheduledDate: nextVisitDate,
        routeDay: getRouteDay(nextVisitDate),
        recurrenceType: customer.visitPeriodicity || 'semanal',
        isVirtual: customer.virtualService || false,
        visitStatus: 'pending',
        customerName: customer.name,
        customerLatitude: customer.latitude || null,
        customerLongitude: customer.longitude || null,
        customerAddress: customer.address || null,
      }).onConflictDoNothing();
      generatedCount++;
      
      // Gerar mais 2 visitas futuras
      let subsequentDate = nextVisitDate;
      for (let i = 0; i < 2; i++) {
        subsequentDate = getNextVisitDate(subsequentDate, customer.visitPeriodicity);
        await db.insert(visitAgenda).values({
          customerId: customer.id,
          sellerId: customer.sellerId,
          scheduledDate: subsequentDate,
          routeDay: getRouteDay(subsequentDate),
          recurrenceType: customer.visitPeriodicity || 'semanal',
          isVirtual: customer.virtualService || false,
          visitStatus: 'pending',
          customerName: customer.name,
          customerLatitude: customer.latitude || null,
          customerLongitude: customer.longitude || null,
          customerAddress: customer.address || null,
        }).onConflictDoNothing();
        generatedCount++;
      }
    }
  }
  
  return generatedCount;
}

// Função principal para gerar agenda de visitas
export async function generateVisitAgenda(): Promise<{ processed: number; generated: number }> {
  console.log('🗓️ Iniciando geração automática de agenda de visitas...');
  
  try {
    // Buscar todos os clientes ativos que têm data de início do fornecimento e vendedor associado
    const eligibleCustomers = await db.select()
      .from(customers)
      .where(
        and(
          eq(customers.isActive, true),
          isNotNull(customers.serviceStartDate),
          isNotNull(customers.sellerId)
        )
      );
    
    console.log(`📋 Encontrados ${eligibleCustomers.length} clientes elegíveis para geração de agenda`);
    
    let totalGenerated = 0;
    
    for (const customer of eligibleCustomers) {
      try {
        const generated = await generateVisitsForCustomer(customer);
        totalGenerated += generated;
        
        if (generated > 0) {
          console.log(`✅ Cliente ${customer.name}: ${generated} visitas geradas`);
        }
      } catch (error) {
        console.error(`❌ Erro ao gerar visitas para cliente ${customer.name}:`, error);
      }
    }
    
    console.log(`🎉 Geração concluída: ${totalGenerated} visitas criadas para ${eligibleCustomers.length} clientes`);
    
    return {
      processed: eligibleCustomers.length,
      generated: totalGenerated
    };
    
  } catch (error) {
    console.error('❌ Erro na geração automática de agenda:', error);
    throw error;
  }
}