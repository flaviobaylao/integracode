import { db } from './db';
import { dailyRoutes, routeCheckpoints, visitAgenda, users } from '../shared/schema';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';

interface DailyMetrics {
  date: string;
  sellerId: string;
  sellerName: string;
  totalVisits: number;
  completedVisits: number;
  completionRate: number; // Percentual
  estimatedDistance: number; // em metros
  actualDistance: number; // em metros
}

interface SellerMonthlyMetrics {
  sellerId: string;
  sellerName: string;
  totalWorkDays: number;
  avgCompletionRate: number; // Média mensal do percentual de visitas
  totalEstimatedDistance: number;
  totalActualDistance: number;
  avgDailyDistance: number;
}

interface AdminDashboardMetrics {
  sellers: SellerMonthlyMetrics[];
  totals: {
    totalDistance: number;
    avgCompletionRate: number;
    totalWorkDays: number;
  };
}

// Calcular métricas diárias de um vendedor
export async function getDailyMetrics(sellerId: string, date: Date): Promise<DailyMetrics | null> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  // Buscar rota do dia
  const [route] = await db.select()
    .from(dailyRoutes)
    .where(
      and(
        eq(dailyRoutes.sellerId, sellerId),
        gte(dailyRoutes.routeDate, startOfDay),
        lte(dailyRoutes.routeDate, endOfDay)
      )
    )
    .limit(1);

  if (!route) {
    return null;
  }

  // Buscar dados do vendedor
  const [seller] = await db.select({
    firstName: users.firstName,
    lastName: users.lastName
  })
    .from(users)
    .where(eq(users.id, sellerId))
    .limit(1);

  const totalVisits = route.totalVisits || 0;
  const completedVisits = route.completedVisits || 0;
  const completionRate = totalVisits > 0 ? (completedVisits / totalVisits) * 100 : 0;

  return {
    date: date.toISOString().split('T')[0],
    sellerId,
    sellerName: `${seller?.firstName || ''} ${seller?.lastName || ''}`.trim(),
    totalVisits,
    completedVisits,
    completionRate: Math.round(completionRate * 100) / 100,
    estimatedDistance: parseFloat(route.totalEstimatedDistance || '0'),
    actualDistance: parseFloat(route.totalActualDistance || '0')
  };
}

// Calcular métricas mensais de um vendedor
export async function getMonthlyMetrics(sellerId: string, year: number, month: number): Promise<SellerMonthlyMetrics | null> {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  // Buscar todas as rotas do mês
  const routes = await db.select()
    .from(dailyRoutes)
    .where(
      and(
        eq(dailyRoutes.sellerId, sellerId),
        gte(dailyRoutes.routeDate, startDate),
        lte(dailyRoutes.routeDate, endDate)
      )
    );

  if (routes.length === 0) {
    return null;
  }

  // Buscar dados do vendedor
  const [seller] = await db.select({
    firstName: users.firstName,
    lastName: users.lastName
  })
    .from(users)
    .where(eq(users.id, sellerId))
    .limit(1);

  let totalVisits = 0;
  let totalCompleted = 0;
  let totalEstimatedDistance = 0;
  let totalActualDistance = 0;

  routes.forEach(route => {
    totalVisits += route.totalVisits || 0;
    totalCompleted += route.completedVisits || 0;
    totalEstimatedDistance += parseFloat(route.totalEstimatedDistance || '0');
    totalActualDistance += parseFloat(route.totalActualDistance || '0');
  });

  const avgCompletionRate = totalVisits > 0 ? (totalCompleted / totalVisits) * 100 : 0;
  const avgDailyDistance = routes.length > 0 ? totalActualDistance / routes.length : 0;

  return {
    sellerId,
    sellerName: `${seller?.firstName || ''} ${seller?.lastName || ''}`.trim(),
    totalWorkDays: routes.length,
    avgCompletionRate: Math.round(avgCompletionRate * 100) / 100,
    totalEstimatedDistance,
    totalActualDistance,
    avgDailyDistance: Math.round(avgDailyDistance * 100) / 100
  };
}

// Calcular métricas de todos os vendedores para o dashboard administrativo
export async function getAdminDashboardMetrics(year: number, month: number): Promise<AdminDashboardMetrics> {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  // Buscar todos os vendedores
  const allSellers = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName
  })
    .from(users)
    .where(eq(users.role, 'vendedor'));

  const sellerMetrics: SellerMonthlyMetrics[] = [];
  let totalDistance = 0;
  let totalCompletionRates = 0;
  let totalWorkDays = 0;
  let sellersWithData = 0;

  for (const seller of allSellers) {
    const metrics = await getMonthlyMetrics(seller.id, year, month);
    
    if (metrics) {
      sellerMetrics.push(metrics);
      totalDistance += metrics.totalActualDistance;
      totalCompletionRates += metrics.avgCompletionRate;
      totalWorkDays += metrics.totalWorkDays;
      sellersWithData++;
    }
  }

  const avgCompletionRate = sellersWithData > 0 
    ? Math.round((totalCompletionRates / sellersWithData) * 100) / 100 
    : 0;

  return {
    sellers: sellerMetrics,
    totals: {
      totalDistance: Math.round(totalDistance * 100) / 100,
      avgCompletionRate,
      totalWorkDays
    }
  };
}

// Buscar últimas rotas de um vendedor
export async function getRecentRoutes(sellerId: string, limit: number = 7): Promise<DailyMetrics[]> {
  const routes = await db.select()
    .from(dailyRoutes)
    .where(eq(dailyRoutes.sellerId, sellerId))
    .orderBy(desc(dailyRoutes.routeDate))
    .limit(limit);

  // Buscar dados do vendedor
  const [seller] = await db.select({
    firstName: users.firstName,
    lastName: users.lastName
  })
    .from(users)
    .where(eq(users.id, sellerId))
    .limit(1);

  const sellerName = `${seller?.firstName || ''} ${seller?.lastName || ''}`.trim();

  return routes.map(route => {
    const totalVisits = route.totalVisits || 0;
    const completedVisits = route.completedVisits || 0;
    const completionRate = totalVisits > 0 ? (completedVisits / totalVisits) * 100 : 0;

    return {
      date: route.routeDate.toISOString().split('T')[0],
      sellerId,
      sellerName,
      totalVisits,
      completedVisits,
      completionRate: Math.round(completionRate * 100) / 100,
      estimatedDistance: parseFloat(route.totalEstimatedDistance || '0'),
      actualDistance: parseFloat(route.totalActualDistance || '0')
    };
  });
}
