#!/usr/bin/env tsx

/**
 * Script CLI para migrar checkpoints retroativos de sales_cards para route_checkpoints
 * 
 * Uso: npx tsx server/migrate-checkpoints-cli.ts [daysBack]
 * Exemplo: npx tsx server/migrate-checkpoints-cli.ts 1
 */

import { db } from "./db";
import { salesCards, routeCheckpoints, dailyRoutes } from "@shared/schema";
import { and, gte, lte, or, eq, asc } from "drizzle-orm";
import { storage } from "./storage";
import { registerCheckpoint } from "./routeOptimizationService";

async function migrateCheckpoints(daysBack: number = 1) {
  console.log(`\n🔄 Iniciando migração retroativa de checkpoints (últimos ${daysBack} dias)...\n`);
  
  // Buscar todos os sales_cards com check-in ou check-out no range especificado
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - daysBack);
  startDate.setHours(0, 0, 0, 0);

  console.log(`📅 Período: ${startDate.toLocaleString('pt-BR')} até ${today.toLocaleString('pt-BR')}`);

  const salesCardsWithCheckins = await db.select()
    .from(salesCards)
    .where(
      or(
        and(
          gte(salesCards.checkInTime, startDate),
          lte(salesCards.checkInTime, today)
        ),
        and(
          gte(salesCards.checkOutTime, startDate),
          lte(salesCards.checkOutTime, today)
        )
      )
    )
    .orderBy(asc(salesCards.checkInTime));

  console.log(`📊 Encontrados ${salesCardsWithCheckins.length} sales cards com check-in/out no período\n`);

  if (salesCardsWithCheckins.length === 0) {
    console.log('✅ Nenhum check-in/out encontrado para migrar.');
    return {
      success: true,
      checkpointsCreated: 0,
      checkpointsSkipped: 0,
      routesUpdated: [],
      errors: []
    };
  }

  let checkpointsCreated = 0;
  let checkpointsSkipped = 0;
  let errors: string[] = [];
  const routesUpdated = new Set<string>();

  for (const card of salesCardsWithCheckins) {
    try {
      if (!card.sellerId || !card.customerId) {
        const err = `Card ${card.id}: sem sellerId ou customerId`;
        console.log(`⚠️  ${err}`);
        errors.push(err);
        continue;
      }

      // Buscar rota diária do vendedor na data do check-in/check-out
      const checkDate = card.checkInTime || card.checkOutTime;
      if (!checkDate) {
        const err = `Card ${card.id}: sem check-in ou check-out`;
        console.log(`⚠️  ${err}`);
        errors.push(err);
        continue;
      }
      
      const dailyRoute = await storage.getDailyRouteBySellerAndDate(card.sellerId, new Date(checkDate));
      
      if (!dailyRoute) {
        const err = `Card ${card.id}: sem rota diária para vendedor ${card.sellerId} em ${new Date(checkDate).toLocaleDateString('pt-BR')}`;
        console.log(`⚠️  ${err}`);
        errors.push(err);
        continue;
      }

      console.log(`\n📍 Processando card ${card.id.substring(0, 8)}...`);

      // Processar check-in se existir
      if (card.checkInTime && card.checkInLatitude && card.checkInLongitude) {
        // Verificar se já existe checkpoint de check-in
        const existingCheckIn = await db.select()
          .from(routeCheckpoints)
          .where(
            and(
              eq(routeCheckpoints.visitId, card.id),
              eq(routeCheckpoints.checkpointType, 'checkin')
            )
          )
          .limit(1);

        if (existingCheckIn.length > 0) {
          console.log(`   ⏭️  Check-in já registrado (checkpoint ${existingCheckIn[0].id.substring(0, 8)}...)`);
          checkpointsSkipped++;
        } else {
          // Criar checkpoint de check-in retroativo
          await registerCheckpoint(
            storage,
            dailyRoute.id,
            card.id,
            card.customerId,
            card.sellerId,
            'check_in',
            card.checkInLatitude,
            card.checkInLongitude
          );
          console.log(`   ✅ Check-in registrado às ${new Date(card.checkInTime).toLocaleTimeString('pt-BR')}`);
          checkpointsCreated++;
          routesUpdated.add(dailyRoute.id);
        }
      }

      // Processar check-out se existir
      if (card.checkOutTime && card.checkOutLatitude && card.checkOutLongitude) {
        // Verificar se já existe checkpoint de check-out
        const existingCheckOut = await db.select()
          .from(routeCheckpoints)
          .where(
            and(
              eq(routeCheckpoints.visitId, card.id),
              eq(routeCheckpoints.checkpointType, 'checkout')
            )
          )
          .limit(1);

        if (existingCheckOut.length > 0) {
          console.log(`   ⏭️  Check-out já registrado (checkpoint ${existingCheckOut[0].id.substring(0, 8)}...)`);
          checkpointsSkipped++;
        } else {
          // Criar checkpoint de check-out retroativo
          await registerCheckpoint(
            storage,
            dailyRoute.id,
            card.id,
            card.customerId,
            card.sellerId,
            'check_out',
            card.checkOutLatitude,
            card.checkOutLongitude
          );
          console.log(`   ✅ Check-out registrado às ${new Date(card.checkOutTime).toLocaleTimeString('pt-BR')}`);
          checkpointsCreated++;
          routesUpdated.add(dailyRoute.id);
        }
      }

    } catch (error: any) {
      const err = `Card ${card.id}: ${error.message}`;
      console.error(`   ❌ ERRO: ${err}`);
      errors.push(err);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 RESUMO DA MIGRAÇÃO:`);
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Checkpoints criados: ${checkpointsCreated}`);
  console.log(`⏭️  Checkpoints já existentes: ${checkpointsSkipped}`);
  console.log(`🔄 Rotas atualizadas: ${routesUpdated.size}`);
  console.log(`❌ Erros: ${errors.length}`);
  
  if (errors.length > 0) {
    console.log(`\n⚠️  ERROS DETALHADOS:`);
    errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
  }
  
  console.log(`${'='.repeat(60)}\n`);

  return {
    success: true,
    checkpointsCreated,
    checkpointsSkipped,
    routesUpdated: Array.from(routesUpdated),
    errors
  };
}

async function recalculateRouteMetrics() {
  console.log(`\n🔄 Recalculando métricas das rotas de hoje...\n`);

  // Buscar rotas de hoje
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const routes = await db.select()
    .from(dailyRoutes)
    .where(
      and(
        gte(dailyRoutes.routeDate, today),
        lte(dailyRoutes.routeDate, tomorrow)
      )
    );

  console.log(`📊 Encontradas ${routes.length} rotas para recalcular\n`);

  let routesUpdated = 0;

  for (const route of routes) {
    console.log(`\n📍 Rota ${route.id.substring(0, 8)}... (vendedor: ${route.sellerId})`);

    // Buscar todos os checkpoints desta rota
    const checkpoints = await db.select()
      .from(routeCheckpoints)
      .where(eq(routeCheckpoints.dailyRouteId, route.id))
      .orderBy(asc(routeCheckpoints.sequenceNumber));

    console.log(`   📍 ${checkpoints.length} checkpoints encontrados`);

    if (checkpoints.length === 0) {
      console.log(`   ⏭️  Sem checkpoints, pulando...`);
      continue;
    }

    // Calcular distância total (garantir conversão para número)
    const totalActualDistance = checkpoints.reduce((sum, cp) => {
      const distance = typeof cp.distanceFromPrevious === 'string' 
        ? parseFloat(cp.distanceFromPrevious) 
        : (cp.distanceFromPrevious || 0);
      return sum + distance;
    }, 0);

    // Contar visitas completadas (número de check-outs)
    const completedVisits = checkpoints.filter(cp => cp.checkpointType === 'checkout').length;

    // Atualizar rota (converter para string com precisão decimal)
    await db.update(dailyRoutes)
      .set({
        totalActualDistance: totalActualDistance.toFixed(2),
        completedVisits
      })
      .where(eq(dailyRoutes.id, route.id));

    console.log(`   ✅ Distância total: ${(totalActualDistance / 1000).toFixed(2)} km`);
    console.log(`   ✅ Visitas completadas: ${completedVisits}/${route.totalVisits}`);

    routesUpdated++;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 RESUMO DO RECÁLCULO:`);
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Rotas recalculadas: ${routesUpdated}/${routes.length}`);
  console.log(`${'='.repeat(60)}\n`);

  return {
    success: true,
    routesUpdated,
    totalRoutes: routes.length
  };
}

// CLI execution
async function main() {
  const daysBackArg = process.argv[2];
  const daysBack = daysBackArg ? parseInt(daysBackArg, 10) : 1;

  if (isNaN(daysBack) || daysBack < 1 || daysBack > 90) {
    console.error('❌ ERRO: daysBack deve ser um número entre 1 e 90');
    console.log('\n📖 Uso: npx tsx server/migrate-checkpoints-cli.ts [daysBack]');
    console.log('   Exemplo: npx tsx server/migrate-checkpoints-cli.ts 1');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('🔧 MIGRAÇÃO RETROATIVA DE CHECKPOINTS');
  console.log('='.repeat(60));

  try {
    // 1. Migrar checkpoints
    const migrateResult = await migrateCheckpoints(daysBack);
    
    // 2. Recalcular métricas
    const recalcResult = await recalculateRouteMetrics();

    console.log('\n✅ MIGRAÇÃO COMPLETA!\n');
    
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERRO FATAL:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
