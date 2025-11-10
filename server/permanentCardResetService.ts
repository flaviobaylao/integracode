import { calculateNextVisitDate } from "@shared/visitSchedule";
import type { Customer, OrderHistory } from "@shared/schema";

/**
 * Serviço para resetar cards permanentes após conclusão
 * 
 * Este serviço é executado automaticamente quando um card permanente
 * tem seu status alterado para 'completed', 'no_sale' ou 'failed'.
 * 
 * Responsabilidades:
 * 1. Limpar dados temporários da visita (produtos, valores, notas)
 * 2. Resetar status para 'pending'
 * 3. Recalcular nextVisitDate baseado na periodicidade do cliente
 * 4. Atualizar lastVisitDate com a data da visita concluída
 */

export interface ResetPermanentCardData {
  // Campos que devem ser limpos (set to null)
  products: null;
  saleValue: null;
  noSaleReason: null;
  notes: null;
  completedDate: null;
  attendanceStartDate: null;
  
  // Campos de check-in/check-out (limpar, pois ficam no order_history)
  checkInTime: null;
  checkOutTime: null;
  checkInLatitude: null;
  checkInLongitude: null;
  checkOutLatitude: null;
  checkOutLongitude: null;
  distanceToCustomer: null;
  checkOutDistanceToCustomer: null;
  checkInPhotoUrl: null;
  
  // Campos de delivery (resetar)
  deliveryStatus: 'pending';
  deliveryScheduledDate: null;
  deliveryCompletedDate: null;
  deliveryFailureReason: null;
  deliveryNotes: null;
  deliveryDriverId: null;
  trackingCode: null;
  
  // Campos de telemarketing (limpar)
  telemarketingAssignedTo: null;
  telemarketingDate: null;
  telemarketingNotes: null;
  
  // CRÍTICO: Campos do Omie/invoice (limpar para evitar duplicação)
  omieOrderId: null;
  omieOrderNumber: null;
  omieSyncStatus: null;
  omieSentAt: null;
  omieErrorMessage: null;
  invoiceNumber: null;
  
  // Status volta para pending
  status: 'pending';
  
  // Atualizar datas de visita
  lastVisitDate: Date;
  nextVisitDate: Date;
  daysOverdue: number;
  
  updatedAt: Date;
}

/**
 * Calcula os dados para resetar um card permanente
 * 
 * @param customer - Cliente associado ao card
 * @param latestHistory - Última entrada do order_history criada nesta conclusão
 * @returns Objeto com campos para resetar o card
 */
export function calculatePermanentCardReset(
  customer: Customer,
  latestHistory: OrderHistory
): ResetPermanentCardData {
  // Parse weekdays se vier como string JSON do banco
  let weekdays: string[] = [];
  if (customer.weekdays) {
    if (typeof customer.weekdays === 'string') {
      try {
        weekdays = JSON.parse(customer.weekdays);
      } catch {
        weekdays = [];
      }
    } else {
      weekdays = customer.weekdays as string[];
    }
  }
  
  // Calcular próxima visita baseada na periodicidade do cliente
  const scheduleResult = calculateNextVisitDate({
    weekdays: weekdays,
    periodicity: customer.visitPeriodicity || 'semanal',
    lastCompletedDate: latestHistory.orderDate,
    referenceDate: new Date()
  });
  
  // lastVisitDate é a data da visita que acabou de ser concluída
  const lastVisitDate = latestHistory.orderDate;
  
  // Calcular dias de atraso (deve ser 0 após reset)
  const daysOverdue = 0;
  
  return {
    // Limpar dados temporários da visita
    products: null,
    saleValue: null,
    noSaleReason: null,
    notes: null,
    completedDate: null,
    attendanceStartDate: null,
    
    // Limpar check-in/check-out (dados ficam em order_history)
    checkInTime: null,
    checkOutTime: null,
    checkInLatitude: null,
    checkInLongitude: null,
    checkOutLatitude: null,
    checkOutLongitude: null,
    distanceToCustomer: null,
    checkOutDistanceToCustomer: null,
    checkInPhotoUrl: null,
    
    // Resetar delivery
    deliveryStatus: 'pending' as const,
    deliveryScheduledDate: null,
    deliveryCompletedDate: null,
    deliveryFailureReason: null,
    deliveryNotes: null,
    deliveryDriverId: null,
    trackingCode: null,
    
    // Limpar telemarketing
    telemarketingAssignedTo: null,
    telemarketingDate: null,
    telemarketingNotes: null,
    
    // CRÍTICO: Limpar Omie/invoice para evitar duplicação
    omieOrderId: null,
    omieOrderNumber: null,
    omieSyncStatus: null,
    omieSentAt: null,
    omieErrorMessage: null,
    invoiceNumber: null,
    
    // Resetar status
    status: 'pending' as const,
    
    // Atualizar datas de visita
    lastVisitDate,
    nextVisitDate: scheduleResult.nextDate,
    daysOverdue,
    
    updatedAt: new Date()
  };
}
