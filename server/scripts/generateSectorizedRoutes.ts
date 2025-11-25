#!/usr/bin/env tsx
/**
 * Script CLI para gerar rotas setorizadas (regionalizadas) para entregas
 * 
 * Uso: tsx server/scripts/generateSectorizedRoutes.ts [DATA]
 * Exemplo: tsx server/scripts/generateSectorizedRoutes.ts 2025-11-26
 */

import { db } from '../db';
import { DatabaseStorage } from '../storage';
import { generateDailySectorizedRoutes } from '../regionalRouteOptimizationService';

async function main() {
  const args = process.argv.slice(2);
  
  // Parse data (opcional, default = hoje)
  let targetDate = new Date();
  
  if (args.length > 0) {
    targetDate = new Date(args[0]);
    if (isNaN(targetDate.getTime())) {
      console.error(`❌ Data inválida: ${args[0]}`);
      console.error(`Uso: tsx server/scripts/generateSectorizedRoutes.ts [YYYY-MM-DD]`);
      process.exit(1);
    }
  }
  
  targetDate.setHours(0, 0, 0, 0);
  
  console.log(`\n🚀 === GERAÇÃO DE ROTAS SETORIZADAS ===`);
  console.log(`📅 Data alvo: ${targetDate.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`);
  
  const storage = new DatabaseStorage(db as any);
  
  try {
    const routes = await generateDailySectorizedRoutes(storage, targetDate);
    
    console.log(`\n\n📊 === RESUMO DAS ROTAS GERADAS ===\n`);
    
    if (routes.length === 0) {
      console.log(`⚠️  Nenhuma rota gerada (sem entregas ou sem veículos disponíveis)\n`);
      process.exit(0);
    }
    
    let totalDeliveries = 0;
    let totalDistance = 0;
    
    for (const route of routes) {
      totalDeliveries += route.totalDeliveries;
      totalDistance += route.totalDistance;
      
      console.log(`\n🚛 ${route.driverName} (${route.vehicleType})`);
      console.log(`   📦 Entregas: ${route.totalDeliveries}`);
      console.log(`   🛣️  Distância: ${route.totalDistance.toFixed(2)}km`);
      console.log(`   📍 Setor: Cluster #${route.sector.id} (raio ${route.sector.radius.toFixed(2)}km)`);
      console.log(`   🗺️  Ordem de visitas: ${route.optimizedOrder.slice(0, 5).join(', ')}${route.optimizedOrder.length > 5 ? '...' : ''}`);
      
      if (route.warnings.length > 0) {
        console.log(`   ⚠️  Avisos: ${route.warnings.join(', ')}`);
      }
    }
    
    console.log(`\n📊 TOTAIS:`);
    console.log(`   Veículos: ${routes.length}`);
    console.log(`   Entregas: ${totalDeliveries}`);
    console.log(`   Distância: ${totalDistance.toFixed(2)}km`);
    console.log(`   Média por veículo: ${(totalDeliveries / routes.length).toFixed(1)} entregas, ${(totalDistance / routes.length).toFixed(2)}km\n`);
    
    // Salvar rotas no banco (opcional - descomentar quando pronto)
    // console.log(`\n💾 Salvando rotas no banco de dados...`);
    // for (const route of routes) {
    //   await storage.createDeliveryRoute({
    //     routeName: `ROTA-${targetDate.toISOString().split('T')[0]}-${route.driverName}`,
    //     routeDate: targetDate,
    //     vehicleType: route.vehicleType,
    //     driverId: route.driverId,
    //     driverName: route.driverName,
    //     ... (mapear campos necessários)
    //   });
    // }
    // console.log(`✅ ${routes.length} rotas salvas!`);
    
    console.log(`✅ Processo concluído com sucesso!\n`);
    process.exit(0);
  } catch (error: any) {
    console.error(`\n❌ ERRO ao gerar rotas setorizadas:`);
    console.error(error);
    process.exit(1);
  }
}

main();
