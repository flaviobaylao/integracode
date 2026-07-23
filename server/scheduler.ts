import { evolutionAPIService } from './evolution-api-service';
import { whatsappService } from './whatsapp-service';
import cron from 'node-cron';
import { getOmieService, getOmieServiceForInstance } from './omieIntegration';
import { isBillingSyncRunning } from './billingSyncState';
import { generateVisitAgenda, syncFutureSalesCards } from './visitScheduleService';
import { storage } from './storage';
import { generateDailyRoute } from './routeOptimizationService';
import { generateAndSaveAllReports } from './ai-reports-service';
import { redistributeTimedOutConversations } from './chat-distribution-service';
import { nowBrazil } from './brazilTimezone';
import { runRadarScan } from './purchase-routes';
import { runPositivacaoAlertaCron } from './positivacao-alert';
import { runDebitosVencidosAlertaCron } from './debitos-vencidos-alert';
import { sweepOpenBoletos } from './bb-boleto-service';
import { db } from './db';
import { sql } from 'drizzle-orm';

console.log('Inicializando agendador de tarefas...');

// Gerar relatórios de IA na inicialização (async, não bloqueia)
(async () => {
  try {
    console.log('📊 [SCHEDULER] Gerando relatórios de IA iniciais...');
    await generateAndSaveAllReports();
    console.log('✅ [SCHEDULER] Relatórios de IA gerados com sucesso!');
  } catch (error: any) {
    console.error('❌ [SCHEDULER] Erro ao gerar relatórios de IA iniciais:', error.message);
  }
})();

// Job para regenerar relatórios de IA diariamente às 6h (horário de Brasília)
cron.schedule('0 6 * * *', async () => {
  console.log('📊 [SCHEDULER] Iniciando geração automática de relatórios de IA às 06:00h...');
  try {
    await generateAndSaveAllReports();
    console.log('✅ [SCHEDULER] Relatórios de IA atualizados com sucesso!');
  } catch (error: any) {
    console.error('❌ [SCHEDULER] Erro na geração de relatórios de IA:', error.message);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// Radar de Compras (Distribuição DFe da SEFAZ) — traz automaticamente as NF-e
// emitidas CONTRA os CNPJs da Honest, de hora em hora (cadência segura p/ a SEFAZ).
// Alerta diário 07:50 (BRT): lista de clientes ativos NÃO positivados por vendedor (WhatsApp).
cron.schedule('50 7 * * *', async () => {
  await runPositivacaoAlertaCron();
}, { timezone: 'America/Sao_Paulo' });

// Alerta diário 08:30 (BRT), SOMENTE DIAS ÚTEIS: débitos vencidos por carteira (WhatsApp).
// Vendedores recebem só a própria carteira; coordenadores/admins recebem a lista consolidada.
// O guard de dia útil (Seg-Sex + feriados nacionais) fica dentro de runDebitosVencidosAlertaCron.
cron.schedule('30 8 * * *', async () => {
  await runDebitosVencidosAlertaCron();
}, { timezone: 'America/Sao_Paulo' });

// 📅 Retorno de lead atrasado: todo dia 06:10 (BRT), marca como "retorno atrasado" os leads
// agendados cuja data de retorno já passou e o vendedor não deu desfecho — cobrança no dia seguinte.
cron.schedule('10 6 * * *', async () => {
  try {
    const r = await db.execute(sql`
      UPDATE leads SET return_overdue = true, updated_at = NOW()
      WHERE status = 'scheduled'
        AND next_contact_date IS NOT NULL
        AND (next_contact_date AT TIME ZONE 'America/Sao_Paulo')::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND return_overdue = false
      RETURNING id
    `);
    const n = (r.rows || []).length;
    if (n > 0) console.log(`📅 [LEAD-RETORNO-ATRASADO] ${n} lead(s) marcado(s) como retorno atrasado.`);
  } catch (e: any) {
    console.error('[LEAD-RETORNO-ATRASADO] falha no cron:', e?.message);
  }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('17 * * * *', async () => {
  try {
    const out = await runRadarScan('radar-auto');
    if (out && out.found) console.log(`🛰️ [RADAR-COMPRAS] scan automático: ${out.found} nova(s) nota(s) detectada(s)`);
  } catch (error: any) {
    console.error('❌ [RADAR-COMPRAS] erro no scan automático:', error.message);
  }
});

// Pedidos AGENDADOS -> PEDIDO: promove os agendados cuja data já chegou.
// Na virada do dia (00:05 BRT) e de hora em hora (rede de segurança), além de uma execução no boot.
async function _promoteAgendados(origem: string) {
  try {
    const { promoteDueScheduledOrders } = await import('./billing-pipeline-routes');
    const n = await promoteDueScheduledOrders();
    if (n) console.log(`📅 [SCHEDULER:${origem}] ${n} pedido(s) agendado(s) promovido(s) para 'Pedido'.`);
  } catch (error: any) {
    console.error(`❌ [SCHEDULER:${origem}] erro ao promover pedidos agendados:`, error?.message || error);
  }
}
cron.schedule('5 0 * * *', () => { void _promoteAgendados('diario'); }, { timezone: 'America/Sao_Paulo' });
cron.schedule('7 * * * *', () => { void _promoteAgendados('horario'); }, { timezone: 'America/Sao_Paulo' });

// FASE 1c - Varredura horaria de boletos em aberto (dias uteis, 07h-20h BRT).
// Substitui o cron externo via HTTP; da baixa automatica nos boletos pagos.
cron.schedule('35 7-20 * * 1-5', async () => {
  try { await sweepOpenBoletos(300, 120); }
  catch (e: any) { console.error('[BB-BOLETO] sweep erro:', e?.message || e); }
}, { timezone: 'America/Sao_Paulo' });

// FASE 3.2 - Alerta por WhatsApp se a varredura de boletos falhar ou parar (checa 15min
// apos cada varredura; anti-spam de 3h; numeros em system_settings 'debitos_fixos').
cron.schedule('50 7-20 * * 1-5', async () => {
  try {
    const q: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'boleto_check_open_last' LIMIT 1`);
    const raw = (q as any).rows?.[0]?.value || null;
    let problema: string | null = null;
    if (!raw) problema = 'a varredura de boletos nunca rodou';
    else {
      try {
        const j = JSON.parse(String(raw));
        const at = j.at ? new Date(j.at).getTime() : 0;
        const ageMin = (Date.now() - at) / 60000;
        if (ageMin > 90) problema = `ultima varredura ha ${Math.round(ageMin)} min (esperado: a cada 60)`;
        else if (Array.isArray(j.errors) && j.errors.length > 0) problema = `varredura com ${j.errors.length} erro(s): ${JSON.stringify(j.errors).slice(0, 180)}`;
      } catch { problema = 'registro da varredura ilegivel'; }
    }
    if (!problema) return;
    const lastQ: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'boleto_sweep_alerta_last' LIMIT 1`);
    const lastRaw = String((lastQ as any).rows?.[0]?.value || '');
    const lastAt = lastRaw ? new Date(lastRaw.slice(0, 24)).getTime() : 0;
    if (lastAt && Date.now() - lastAt < 3 * 60 * 60 * 1000) return;
    const fq: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'debitos_fixos' LIMIT 1`);
    const fixos = String((fq as any).rows?.[0]?.value || '5562995782812').split(',').map((s: string) => s.trim()).filter(Boolean);
    const msg = `⚠️ INTEGRA 2.0 - ALERTA FINANCEIRO\nA baixa automatica de boletos pode estar com problema.\nDetalhe: ${problema}\nAs baixas por webhook continuam; verifique os logs do Railway.`;
    let enviados = 0;
    for (const numero of fixos) {
      try { const r = await whatsappService.sendMessage(numero, msg); if (r.success) enviados++; } catch {}
    }
    const reg = new Date().toISOString() + ' problema=' + problema.slice(0, 120) + ' enviados=' + enviados;
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('boleto_sweep_alerta_last', ${reg}, 'scheduler') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
    console.log(`⚠️ [BB-BOLETO] alerta de varredura: ${problema} (WhatsApp enviados=${enviados})`);
  } catch (e: any) { console.error('[BB-BOLETO] alerta erro:', e?.message || e); }
}, { timezone: 'America/Sao_Paulo' });
(async () => { await _promoteAgendados('boot'); })();

// Sincronizar usuários como agentes e clientes para agenda na inicialização
(async () => {
  await storage.syncUsersAsAgents();
  
  // Sincronizar clientes ativos para agenda do Chat Center
  console.log(`📞 [STARTUP] Iniciando sincronização de clientes ativos para agenda...`);
  await storage.syncActiveCustomersToPhonebook();
})();

// Job para encerrar conversas inativas a cada 5 minutos
// Envia mensagem de finalização configurável ao cliente
cron.schedule('*/5 * * * *', async () => {
  try {
    const result = await storage.closeInactiveConversations();
    
    if (result.count > 0) {
      // Buscar mensagem de finalização configurada
      const aiSettings = await storage.getChatAiSettings();
      const finalizeMessage = aiSettings?.finalizeMessage || 
        'Atendimento finalizado. Obrigado pelo contato! Caso precise de algo mais, estamos à disposição.';
      
      // Enviar mensagem de finalização para cada conversa fechada
      for (const conv of result.conversations) {
        if (conv.customerPhone) {
          try {
            // Enviar via Evolution API
            await evolutionAPIService.sendText(conv.customerPhone, finalizeMessage);
            console.log(`📩 [AUTO-FINALIZE] Mensagem de finalização enviada para ${conv.customerPhone}`);
            
            // Registrar mensagem no histórico
            await storage.createChatMessage({
              conversationId: conv.id,
              senderId: 'system',
              senderType: 'system',
              content: `[Auto-finalização por inatividade] ${finalizeMessage}`,
              messageType: 'text',
              isRead: true
            });
          } catch (sendErr: any) {
            console.error(`❌ [AUTO-FINALIZE] Erro ao enviar mensagem para ${conv.customerPhone}:`, sendErr.message);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Erro ao encerrar conversas inativas:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// Job para redistribuir conversas sem atendimento a cada 2 minutos
cron.schedule('*/2 * * * *', async () => {
  try {
    const count = await redistributeTimedOutConversations();
    if (count > 0) {
      console.log(`🔄 [REDISTRIBUTION] ${count} conversa(s) redistribuída(s) por timeout`);
    }
  } catch (error) {
    console.error('❌ Erro ao redistribuir conversas:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// Função para sincronização completa (Clientes + Faturamentos + Débitos Vencidos) - Multi-instância
async function syncComplete(horario: string) {
  console.log(`🔄 [${horario}] Iniciando sincronização completa automática (multi-instância)...`);
  
  try {
    const instances = await storage.getOmieInstances();
    const activeInstances = instances.filter((i: any) => i.isActive && i.appKey && i.appSecret);

    if (activeInstances.length === 0) {
      const fallback = getOmieService(storage);
      if (!fallback) {
        console.error(`❌ [${horario}] Nenhuma instância Omie configurada para sincronização automática`);
        return;
      }
      activeInstances.push({ id: fallback.omieInstanceId || 'default', name: 'Default' });
    }

    // Verificar se BSB (env vars) está coberto — adicionar se não estiver
    const envKey = process.env.OMIE_APP_KEY;
    const bsbAlreadyCovered = activeInstances.some((i: any) => i.appKey === envKey);
    const bsbEnvSvc = (!bsbAlreadyCovered) ? getOmieService(storage) : null;

    console.log(`🏢 [${horario}] ${activeInstances.length} instância(s) ativa(s): ${activeInstances.map((i: any) => i.name).join(', ')}`);

    const globalResults = {
      clients: { totalProcessed: 0, imported: 0, updated: 0 },
      billings: { totalProcessed: 0, imported: 0, updated: 0 },
      overdueDebts: { totalClients: 0, totalAmount: 0 },
      errors: [] as string[]
    };

    for (const inst of activeInstances) {
      const label = inst.name || inst.id;
      console.log(`\n🏢 [${horario}] Sincronizando instância: ${label}...`);

      let svc: any;
      try {
        svc = await getOmieServiceForInstance(storage, inst.id);
        if (!svc) {
          console.log(`⚠️ [${horario}] Instância ${label} sem credenciais válidas, pulando...`);
          continue;
        }
      } catch (e: any) {
        globalResults.errors.push(`Erro ao criar serviço para ${label}: ${e.message}`);
        continue;
      }

      // 0. Sincronizar vendedores PRIMEIRO (necessário para resolver seller IDs corretamente)
      try {
        console.log(`👤 [${horario}] [${label}] Sincronizando vendedores...`);
        const vendorResult = await svc.syncVendors();
        console.log(`✅ [${horario}] [${label}] Vendedores: ${vendorResult.totalProcessed || 0} processados, ${vendorResult.imported || 0} novos, ${vendorResult.updated || 0} atualizados`);
      } catch (error: any) {
        const errorMsg = `[${label}] Erro ao sincronizar vendedores: ${error.message}`;
        globalResults.errors.push(errorMsg);
        console.error(`❌ [${horario}] ${errorMsg}`);
      }
    }

    // 0.0 Sincronizar vendedores BSB (env vars) antes do dedup para incluir códigos BSB no merge
    if (bsbEnvSvc) {
      try {
        console.log(`👤 [${horario}] [BSB] Sincronizando vendedores (env vars)...`);
        const vendorResult = await bsbEnvSvc.syncVendors();
        console.log(`✅ [${horario}] [BSB] Vendedores: ${vendorResult.totalProcessed || 0} processados, ${vendorResult.imported || 0} novos`);
      } catch (error: any) {
        globalResults.errors.push(`[BSB] Erro ao sincronizar vendedores: ${error.message}`);
        console.error(`❌ [${horario}] [BSB] Erro ao sincronizar vendedores: ${error.message}`);
      }
    }

    // 0.1 Mesclar códigos de vendedores duplicados entre instâncias (sem desativar)
    try {
      const allUsers = await storage.getUsers();
      const vendorsByName = new Map<string, any[]>();
      
      for (const u of allUsers) {
        if (u.role !== 'vendedor' && u.role !== 'telemarketing') continue;
        if (!u.id?.startsWith('omie-vendor-')) continue;
        const normName = `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
        if (!normName || normName.length < 3) continue;
        if (!vendorsByName.has(normName)) vendorsByName.set(normName, []);
        vendorsByName.get(normName)!.push(u);
      }
      
      let mergedCount = 0;
      for (const [name, dupes] of vendorsByName) {
        if (dupes.length <= 1) continue;
        
        // Apenas logar e mesclar códigos - NÃO desativar registros
        const allCodes: Record<string, string> = {};
        for (const d of dupes) {
          if (d.omieVendorCodes && typeof d.omieVendorCodes === 'object') {
            Object.assign(allCodes, d.omieVendorCodes as Record<string, string>);
          }
        }
        
        if (Object.keys(allCodes).length > 0) {
          for (const d of dupes) {
            const currentCodes = d.omieVendorCodes && typeof d.omieVendorCodes === 'object' 
              ? Object.keys(d.omieVendorCodes).length : 0;
            if (currentCodes < Object.keys(allCodes).length) {
              await storage.updateUser(d.id, { omieVendorCodes: allCodes });
              mergedCount++;
            }
          }
        }
        
        console.log(`📋 [DEDUP] Vendedor duplicado detectado: "${name}" (${dupes.length}x): ${dupes.map((d: any) => d.id).join(', ')}`);
      }
      
      if (mergedCount > 0) {
        console.log(`✅ [${horario}] Códigos mesclados em ${mergedCount} vendedores`);
      }
    } catch (error: any) {
      console.error(`❌ [${horario}] Erro ao mesclar códigos de vendedores:`, error.message);
    }

    for (const inst of activeInstances) {
      const label = inst.name || inst.id;
      let svc: any;
      try {
        svc = await getOmieServiceForInstance(storage, inst.id);
        if (!svc) continue;
      } catch (e: any) {
        continue;
      }

      // 1. Sincronizar clientes ativos
      try {
        console.log(`📋 [${horario}] [${label}] Sincronizando clientes ativos...`);
        const clientResult = await svc.syncAllClients();
        globalResults.clients.totalProcessed += clientResult.totalProcessed || 0;
        globalResults.clients.imported += clientResult.imported || 0;
        globalResults.clients.updated += clientResult.updated || 0;
        console.log(`✅ [${horario}] [${label}] Clientes: ${clientResult.totalProcessed || 0} processados`);
      } catch (error: any) {
        const errorMsg = `[${label}] Erro ao sincronizar clientes: ${error.message}`;
        globalResults.errors.push(errorMsg);
        console.error(`❌ [${horario}] ${errorMsg}`);
      }

      // 2. Sincronizar notas fiscais dos últimos 60 dias
      if (isBillingSyncRunning()) {
        console.log(`⏭️ [${horario}] [${label}] Sincronização manual em andamento — pulando sync automático de pedidos`);
      } else {
        try {
          console.log(`💰 [${horario}] [${label}] Sincronizando pedidos dos últimos 60 dias...`);
          
          await storage.updateSyncStatus('omie_billings', { 
            status: 'in_progress', 
            message: `[${label}] Sincronização automática de pedidos iniciada...`,
            recordsProcessed: 0,
            currentProgress: 0
          });
          
          const billingResult = await svc.syncAllOrders((progress: any) => {
            const syncStatus = svc.getSyncStatus();
            if (syncStatus.cancelled) return;
            storage.updateSyncStatus('omie_billings', { 
              status: 'in_progress', 
              message: `[${label}] ${progress.invoicesProcessed} processados`,
              recordsProcessed: progress.invoicesProcessed,
              totalRecords: progress.invoicesFound,
              currentProgress: progress.totalPages > 0 ? Math.round((progress.currentPage / progress.totalPages) * 100) : 0
            });
          });
          
          globalResults.billings.totalProcessed += billingResult.totalProcessed || 0;
          globalResults.billings.imported += billingResult.imported || 0;
          globalResults.billings.updated += billingResult.updated || 0;
          
          console.log(`✅ [${horario}] [${label}] Notas fiscais: ${billingResult.totalProcessed || 0} processadas`);
        } catch (error: any) {
          const errorMsg = `[${label}] Erro ao sincronizar notas fiscais: ${error.message}`;
          globalResults.errors.push(errorMsg);
          console.error(`❌ [${horario}] ${errorMsg}`);
        }
      }

      // 3. Sincronizar débitos vencidos (com instanceId para não apagar dados de outras instâncias)
      try {
        console.log(`📊 [${horario}] [${label}] Sincronizando débitos vencidos...`);
        const debtResult = await svc.getOverdueDebts();
        await storage.syncOverdueDebts(debtResult.debts, false, svc.omieInstanceId);
        globalResults.overdueDebts.totalClients += debtResult.totalClients || 0;
        globalResults.overdueDebts.totalAmount += debtResult.totalAmount || 0;
        console.log(`✅ [${horario}] [${label}] Débitos: ${debtResult.totalClients} clientes, R$ ${debtResult.totalAmount.toFixed(2)}`);
      } catch (error: any) {
        const errorMsg = `[${label}] Erro ao sincronizar débitos vencidos: ${error.message}`;
        globalResults.errors.push(errorMsg);
        console.error(`❌ [${horario}] ${errorMsg}`);
      }
    }

    // Sincronizar BSB (env vars) — clientes, faturamentos e débitos (vendedores já sincronizados acima)
    if (bsbEnvSvc) {
      const bsbLabel = 'BSB';
      console.log(`\n🏢 [${horario}] Sincronizando instância: ${bsbLabel} (env vars) — clientes/faturamentos/débitos...`);

      try {
        console.log(`📋 [${horario}] [${bsbLabel}] Sincronizando clientes ativos...`);
        const clientResult = await bsbEnvSvc.syncAllClients();
        globalResults.clients.totalProcessed += clientResult.totalProcessed || 0;
        globalResults.clients.imported += clientResult.imported || 0;
        globalResults.clients.updated += clientResult.updated || 0;
        console.log(`✅ [${horario}] [${bsbLabel}] Clientes: ${clientResult.totalProcessed || 0} processados`);
      } catch (error: any) {
        globalResults.errors.push(`[${bsbLabel}] Erro ao sincronizar clientes: ${error.message}`);
        console.error(`❌ [${horario}] [${bsbLabel}] Erro ao sincronizar clientes: ${error.message}`);
      }

      if (isBillingSyncRunning()) {
        console.log(`⏭️ [${horario}] [${bsbLabel}] Sincronização manual em andamento — pulando sync automático de pedidos`);
      } else {
        try {
          console.log(`💰 [${horario}] [${bsbLabel}] Sincronizando pedidos dos últimos 60 dias...`);
          const billingResult = await bsbEnvSvc.syncAllOrders();
          globalResults.billings.totalProcessed += billingResult.totalProcessed || 0;
          globalResults.billings.imported += billingResult.imported || 0;
          globalResults.billings.updated += billingResult.updated || 0;
          console.log(`✅ [${horario}] [${bsbLabel}] Notas fiscais: ${billingResult.totalProcessed || 0} processadas`);
        } catch (error: any) {
          globalResults.errors.push(`[${bsbLabel}] Erro ao sincronizar notas fiscais: ${error.message}`);
          console.error(`❌ [${horario}] [${bsbLabel}] Erro ao sincronizar notas fiscais: ${error.message}`);
        }
      }

      try {
        console.log(`📊 [${horario}] [${bsbLabel}] Sincronizando débitos vencidos...`);
        const debtResult = await bsbEnvSvc.getOverdueDebts();
        await storage.syncOverdueDebts(debtResult.debts, false, bsbEnvSvc.omieInstanceId);
        globalResults.overdueDebts.totalClients += debtResult.totalClients || 0;
        globalResults.overdueDebts.totalAmount += debtResult.totalAmount || 0;
        console.log(`✅ [${horario}] [${bsbLabel}] Débitos: ${debtResult.totalClients} clientes`);
      } catch (error: any) {
        globalResults.errors.push(`[${bsbLabel}] Erro ao sincronizar débitos: ${error.message}`);
        console.error(`❌ [${horario}] [${bsbLabel}] Erro ao sincronizar débitos: ${error.message}`);
      }
    }

    // Atualizar status final
    await storage.updateSyncStatus('omie_billings', { 
      status: globalResults.errors.some(e => e.includes('notas fiscais')) ? 'error' : 'success', 
      message: `${globalResults.billings.imported} importados, ${globalResults.billings.updated} atualizados (${activeInstances.length + (bsbEnvSvc ? 1 : 0)} instâncias)`,
      recordsProcessed: globalResults.billings.totalProcessed,
      currentProgress: 100,
      lastFinishedAt: nowBrazil()
    });

    // Resumo da sincronização
    console.log(`\n✨ [${horario}] Sincronização multi-instância concluída (${activeInstances.length} instâncias):`);
    console.log(`   - Clientes: ${globalResults.clients.totalProcessed} processados (${globalResults.clients.imported} novos, ${globalResults.clients.updated} atualizados)`);
    console.log(`   - Faturamentos: ${globalResults.billings.totalProcessed} processados (${globalResults.billings.imported} novos, ${globalResults.billings.updated} atualizados)`);
    console.log(`   - Débitos: ${globalResults.overdueDebts.totalClients} clientes, Total R$ ${globalResults.overdueDebts.totalAmount.toFixed(2)}`);
    if (globalResults.errors.length > 0) {
      console.log(`   ⚠️ ${globalResults.errors.length} erro(s) encontrado(s)`);
    }
    
  } catch (error) {
    console.error(`❌ [${horario}] Erro crítico na sincronização completa:`, error);
  }
}

// Função para sincronizar débitos vencidos
async function syncOverdueDebts(horario: string) {
  console.log(`🕐 Iniciando sincronização automática de débitos vencidos às ${horario}...`);
  
  try {
    const omieService = getOmieService();
    if (!omieService) {
      console.error('❌ Serviço Omie não configurado para sincronização automática');
      return;
    }

    const result = await omieService.getOverdueDebts();
    
    // Salvar débitos no banco de dados
    const storage = (await import('./storage')).storage;
    await storage.syncOverdueDebts(result.debts);
    
    console.log(`✅ Sincronização automática concluída (${horario}):`);
    console.log(`   - ${result.totalClients} clientes com débitos vencidos`);
    console.log(`   - Total: R$ ${result.totalAmount.toFixed(2)}`);
    console.log(`   - Débitos salvos no banco de dados`);
    
  } catch (error) {
    console.error(`❌ Erro na sincronização automática de débitos vencidos (${horario}):`, error);
  }
}

// Sincronização completa automática de hora em hora a partir das 6h
// Das 06:00 às 23:00 (6h, 7h, 8h, ..., 23h)
// IMPORTANTE: Só executa em produção para evitar race condition dev+prod no mesmo banco
if (process.env.NODE_ENV === 'production' || process.env.REPL_DEPLOYMENT) {
  cron.schedule('0 6-23 * * *', () => {
    const now = nowBrazil();
    const hour = now.getHours();
    const horario = `${hour.toString().padStart(2, '0')}:00h`;
    syncComplete(horario);
  }, {
    timezone: "America/Sao_Paulo"
  });
  console.log('✅ [SCHEDULER] Sincronização Omie horária ativada (ambiente de produção)');
} else {
  console.log('⚠️ [SCHEDULER] Sincronização Omie horária DESATIVADA (ambiente de desenvolvimento)');
}

// ===== LIBERACAO AUTOMATICA DE PEDIDOS BLOQUEADOS POR DEBITO VENCIDO =====
// Re-verifica de hora em hora (15 min apos o sync de debitos) se os clientes dos pedidos
// bloqueados por 'overdue_debt' ainda tem debito vencido. Sem debito -> libera o pedido e
// envia ao pipeline na etapa "pedido". Bloqueios por outros motivos (amostra/troca, boleto
// acima do prazo) seguem exigindo liberacao manual.
async function autoReleaseRegularizedDebtOrders(horario: string) {
  try {
    const { db } = await import('./db');
    const { blockedOrders } = await import('@shared/schema');
    const { eq, and } = await import('drizzle-orm');
    const blocked = await db.select().from(blockedOrders)
      .where(and(eq(blockedOrders.status, 'blocked'), eq(blockedOrders.blockReason, 'overdue_debt')));
    if (blocked.length === 0) { console.log(`✅ [AUTO-RELEASE] (${horario}) Nenhum pedido bloqueado por debito vencido.`); return; }
    console.log(`🔎 [AUTO-RELEASE] (${horario}) ${blocked.length} pedido(s) bloqueado(s) por debito vencido - re-verificando debitos...`);
    const { autoSendToBillingPipeline } = await import('./billing-pipeline-routes');
    // Snapshot dos cards JA presentes no pipeline — usado para confirmar que a liberacao
    // REALMENTE colocou o pedido no faturamento antes de marcar 'released' (evita pedido
    // sumir dos bloqueados sem ser faturado quando o envio ao pipeline falha/no-op).
    let pipelineCardIds = new Set<string>();
    try { pipelineCardIds = new Set((await storage.getBillingPipelineItems()).map((i: any) => i.salesCardId).filter(Boolean)); } catch { /* segue; confirma via retorno do autoSend */ }
    let released = 0, kept = 0, failed = 0;
    for (const order of blocked as any[]) {
      try {
        const customer = order.customerId ? await storage.getCustomer(order.customerId) : null;
        const doc = (customer as any)?.cnpj || (customer as any)?.cpf || '';
        if (!doc) { kept++; continue; }
        const debt = await storage.getOverdueDebtByDocument(doc);
        if (debt) { kept++; continue; }
        // Debito regularizado -> libera: SO marca 'released' se o pedido REALMENTE entrar no
        // pipeline de faturamento. Sem card de venda, ou se o envio falhar/no-op, MANTEM
        // bloqueado e tenta de novo na proxima hora (evita pedido liberado-e-nao-faturado).
        const salesCard = order.salesCardId ? await storage.getSalesCard(order.salesCardId) : null;
        if (!salesCard) {
          kept++;
          console.warn(`⚠️ [AUTO-RELEASE] Pedido ${order.id} sem sales_card (${order.salesCardId || 'null'}) — mantido bloqueado (nao ha o que enviar ao pipeline).`);
          continue;
        }
        let inPipeline = false;
        try {
          const created: any = await autoSendToBillingPipeline(salesCard, 'system-debito-regularizado', { skipDebtCheck: true });
          if (created) { inPipeline = true; pipelineCardIds.add(salesCard.id); }
          else { inPipeline = pipelineCardIds.has(salesCard.id); } // null por DUPLICADO = ja esta no pipeline (ok liberar)
        } catch (e: any) {
          console.warn(`⚠️ [AUTO-RELEASE] autoSend falhou p/ card ${order.salesCardId}:`, e?.message);
          inPipeline = false;
        }
        if (!inPipeline) {
          kept++;
          console.warn(`⚠️ [AUTO-RELEASE] Pedido ${order.id} NAO entrou no pipeline (envio falhou/no-op) — mantido bloqueado p/ retry na proxima hora.`);
          continue;
        }
        await db.update(blockedOrders)
          .set({ status: 'released', releasedAt: nowBrazil(), releasedBy: 'system-auto-debito-regularizado', updatedAt: nowBrazil() })
          .where(eq(blockedOrders.id, order.id));
        released++;
        console.log(`🔓 [AUTO-RELEASE] Pedido ${order.id} (${(customer as any)?.fantasyName || (customer as any)?.name || order.customerId}) liberado - debito regularizado. Enviado a etapa "pedido".`);
      } catch (e: any) { failed++; console.error(`❌ [AUTO-RELEASE] Erro no pedido ${order.id}:`, e?.message); }
    }
    console.log(`✅ [AUTO-RELEASE] (${horario}) Concluido: ${released} liberado(s), ${kept} mantido(s) bloqueado(s), ${failed} erro(s).`);
  } catch (e: any) { console.error(`❌ [AUTO-RELEASE] Erro critico:`, e?.message); }
}

if (process.env.NODE_ENV === 'production' || process.env.REPL_DEPLOYMENT) {
  cron.schedule('15 6-23 * * *', () => {
    const now = nowBrazil();
    const horario = `${now.getHours().toString().padStart(2, '0')}:15h`;
    autoReleaseRegularizedDebtOrders(horario);
  }, {
    timezone: "America/Sao_Paulo"
  });
  console.log('✅ [SCHEDULER] Liberacao automatica de pedidos bloqueados (debito regularizado) ativada - hora em hora as hh:15');
  // Reforco (pedido do Flavio): 2 liberacoes EXTRAS no minuto cheio — 10:00 e 14:00 BRT —
  // alem das horarias hh:15. A rotina e idempotente (so re-checa debito e libera regularizados).
  cron.schedule('0 10,14 * * *', () => {
    const now = nowBrazil();
    const horario = `${now.getHours().toString().padStart(2, '0')}:00h`;
    autoReleaseRegularizedDebtOrders(horario);
  }, {
    timezone: "America/Sao_Paulo"
  });
  console.log('✅ [SCHEDULER] Liberacao automatica EXTRA ativada - 10:00 e 14:00 (alem das hh:15)');
} else {
  console.log('⚠️ [SCHEDULER] Liberacao automatica de bloqueados DESATIVADA (ambiente de desenvolvimento)');
}

// 🎯 Distribuicao da REPESCAGEM: todos os dias as 22:00 (BRT), programando a ROTA DO DIA SEGUINTE.
// 1) gera as rotas de AMANHA p/ os vendedores ativos com coordenadas; 2) roda a distribuicao da
//    repescagem p/ amanha sobre essas rotas (perimetro 2km, teto 3/vendedor, PROPRIO vendedor
//    primeiro; o restante vai ao telemarketing habilitado). Idempotente por dia (force refaz o nao-atendido).
cron.schedule('0 22 * * *', async () => {
  console.log('🎯 [REPESCAGEM-22H] Iniciando distribuicao da repescagem para o dia seguinte...');
  try {
    const { users } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');
    const { runRepescagemDrawForDate, notifyRepescagemWhatsApp } = await import('./repescagem-routes');
    const { generateDailyRoute } = await import('./routeOptimizationService');

    // amanha (BRT)
    const amanha = nowBrazil();
    amanha.setHours(0, 0, 0, 0);
    amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = amanha.toISOString().split('T')[0];

    // 1) Gerar as rotas de AMANHA (programa a "rota do dia seguinte").
    const vendedores = await db.select().from(users).where(eq(users.role, 'vendedor'));
    let rotasGeradas = 0, rotasPuladas = 0, rotasErro = 0;
    for (const v of vendedores) {
      try {
        if (!v.homeLatitude || !v.homeLongitude) { rotasPuladas++; continue; }
        const existe = await storage.getDailyRouteBySellerAndDate(v.id, amanha);
        if (existe) { rotasPuladas++; continue; }
        await generateDailyRoute(storage, v.id, amanha);
        rotasGeradas++;
      } catch (e: any) { rotasErro++; console.error(`[REPESCAGEM-22H] rota amanha ${v.firstName || v.id}:`, e?.message); }
    }
    console.log(`🗺️ [REPESCAGEM-22H] Rotas de amanha (${amanhaStr}): ${rotasGeradas} geradas, ${rotasPuladas} puladas, ${rotasErro} erros`);

    // 2) Rodar a distribuicao/sorteio da repescagem p/ AMANHA sobre as rotas geradas.
    const r = await runRepescagemDrawForDate(amanhaStr, { force: true });
    console.log(`🎯 [REPESCAGEM-22H] Distribuicao ${amanhaStr}: externos=${r?.allocatedExternal} telemarketing=${r?.allocatedTelemarketing} (cand=${r?.candidates}, semCoord=${r?.withoutCoords})`);
    // Fase 2: notifica os vendedores externos por WhatsApp (DESLIGADO por padrao ate flag 'repescagem_whatsapp_enabled'='true').
    const wa = await notifyRepescagemWhatsApp();
    console.log(`📲 [REPESCAGEM-22H] WhatsApp vendedores externos: ${wa?.enabled ? 'ENVIADO' : 'dry-run'} (${wa?.vendors} vendedor(es)).`);
  } catch (e: any) {
    console.error('❌ [REPESCAGEM-22H] falha:', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

// DESATIVADO: Sistema migrado para cards permanentes + order_history
// Geração automática de agenda de visitas REMOVIDA após migração para cards permanentes
// A geração de visitas agora usa visit_schedule_history em vez de sales_cards
/* 
cron.schedule('0 6 * * *', async () => {
  console.log('Iniciando geração automática de agenda de visitas às 06:00h...');
  
  try {
    const result = await generateVisitAgenda();
    
    console.log(`✅ Geração de agenda concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.generated} visitas criadas`);
    
  } catch (error) {
    console.error('❌ Erro na geração automática de agenda:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});
*/

// DESATIVADO: Sistema migrado para cards permanentes + order_history
// Processamento de cards atrasados REMOVIDO - não há mais geração de próximos cards
// Cards são permanentes e pedidos são registrados em order_history
/*
cron.schedule('0 2 * * *', async () => {
  console.log('🕐 [SCHEDULER] Iniciando processamento de cards atrasados...');
  
  try {
    // Buscar todos os cards criticamente atrasados (sem filtro de vendedor)
    const overdueCards = await storage.getCriticallyOverdueCards();
    
    console.log(`📋 [SCHEDULER] Encontrados ${overdueCards.length} cards criticamente atrasados (>3 dias)`);
    
    let processedCount = 0;
    let errorCount = 0;
    
    // Processar cada card: marcar como failed e agendar próximo
    for (const card of overdueCards) {
      try {
        const result = await storage.closeCardAndScheduleNext(
          card.id,
          'failed',
          { noSaleReason: 'Card automaticamente marcado como fracassado após 3 dias sem atendimento' }
        );
        
        console.log(`✅ [SCHEDULER] Card ${card.id} marcado como failed. Próxima visita: ${result.nextCard?.scheduledDate || 'N/A'}`);
        processedCount++;
      } catch (error) {
        console.error(`❌ [SCHEDULER] Erro ao processar card ${card.id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`✨ [SCHEDULER] Processamento concluído: ${processedCount} sucesso, ${errorCount} erros`);
  } catch (error) {
    console.error('❌ [SCHEDULER] Erro ao buscar cards atrasados:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});
*/

// Geração automática de rotas diárias para todos os vendedores às 05:00h
cron.schedule('0 5 * * *', async () => {
  console.log('🗺️ [SCHEDULER] Iniciando geração automática de rotas diárias às 05:00h...');
  
  try {
    const db = (await import('./db')).db;
    const { users } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');
    
    // Buscar todos os vendedores ativos com coordenadas configuradas
    const vendedores = await db.select()
      .from(users)
      .where(eq(users.role, 'vendedor'));
    
    const hoje = nowBrazil();
    hoje.setHours(0, 0, 0, 0);
    
    let routesGenerated = 0;
    let routesSkipped = 0;
    let errors = 0;
    
    for (const vendedor of vendedores) {
      try {
        // Verificar se vendedor tem coordenadas configuradas
        if (!vendedor.homeLatitude || !vendedor.homeLongitude) {
          console.log(`⚠️ [SCHEDULER] Vendedor ${vendedor.firstName} ${vendedor.lastName} sem coordenadas de casa configuradas`);
          routesSkipped++;
          continue;
        }
        
        // Verificar se já existe rota para hoje
        const existingRoute = await storage.getDailyRouteBySellerAndDate(vendedor.id, hoje);
        if (existingRoute) {
          console.log(`ℹ️ [SCHEDULER] Rota já existe para ${vendedor.firstName} ${vendedor.lastName}`);
          routesSkipped++;
          continue;
        }
        
        // Gerar rota
        const result = await generateDailyRoute(storage, vendedor.id, hoje);
        
        if (result.warnings && result.warnings.length > 0) {
          console.log(`⚠️ [SCHEDULER] Rota gerada para ${vendedor.firstName} ${vendedor.lastName} com alertas:`, result.warnings);
        } else {
          console.log(`✅ [SCHEDULER] Rota gerada para ${vendedor.firstName} ${vendedor.lastName}: ${result.totalVisits} visitas`);
        }
        
        routesGenerated++;
      } catch (error) {
        console.error(`❌ [SCHEDULER] Erro ao gerar rota para ${vendedor.firstName} ${vendedor.lastName}:`, error);
        errors++;
      }
    }
    
    console.log(`✨ [SCHEDULER] Geração de rotas concluída: ${routesGenerated} geradas, ${routesSkipped} puladas, ${errors} erros`);
    
  } catch (error) {
    console.error('❌ [SCHEDULER] Erro na geração automática de rotas:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// DESATIVADO: Sistema migrado para cards permanentes + order_history
// Sincronização de agenda futura REMOVIDA - não há mais necessidade de criar/deletar cards recorrentes
// Sistema agora usa cards permanentes (um por cliente) + order_history para pedidos
/*
cron.schedule('0 0 * * *', async () => {
  console.log('🌙 [SCHEDULER] Iniciando sincronização completa de agenda futura à meia-noite...');
  
  try {
    const result = await syncFutureSalesCards(2);
    
    console.log(`✅ [SCHEDULER] Sincronização de agenda concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.created} cards criados`);
    console.log(`   - ${result.deleted} cards deletados`);
    console.log(`   - ${result.errors} erros`);
    
  } catch (error) {
    console.error('❌ [SCHEDULER] Erro na sincronização de agenda futura:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});
*/

// Auto check-out: processar visitas com check-in há mais de 20 minutos sem check-out
// Só faz auto checkout se não houver pedido (status='completed') ou não-venda (status='no_sale') registrado
// Executa a cada 5 minutos das 6h às 23h
cron.schedule('*/5 6-23 * * *', async () => {
  try {
    const { processAutoCheckouts } = await import('./autoCheckoutService');
    const result = await processAutoCheckouts(storage);
    
    if (result.processed > 0 || result.skippedWithOrder > 0 || result.skippedWithNoSale > 0) {
      console.log(`🤖 [AUTO-CHECKOUT] ${result.processed} checkout(s), ${result.skippedWithOrder} com pedido, ${result.skippedWithNoSale} com não-venda, ${result.errors} erro(s)`);
    }
  } catch (error: any) {
    console.error('❌ [AUTO-CHECKOUT] Erro no processamento:', error.message);
  }
}, {
  timezone: "America/Sao_Paulo"
});

/* Polling fallback desativado permanentemente a pedido do usuário para voltar ao webhook puro */
// cron.schedule('*/30 * * * * *', async () => {
//   try {
//     const { evolutionAPIService } = await import('./evolution-api-service');
//     
//     if (!evolutionAPIService.isConfigured()) {
//       return;
//     }
//
//     const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
//     let newMessages = 0;
//     let errors = 0;
//
//     // 1. Buscar todos os chats ativos da Evolution API (para pegar novos contatos também)
//     const chatsResult = await evolutionAPIService.fetchAllChats(instanceName);
//     
//     if (chatsResult.success && chatsResult.chats) {
//       // Filtrar apenas chats individuais (não grupos)
//       const individualChats = chatsResult.chats.filter((chat: any) => {
//         const jid = chat.remoteJid || chat.id || '';
//         return jid.includes('@s.whatsapp.net') && !jid.includes('@g.us');
//       });
//
//       // Sort by updatedAt (most recent first) and take top 10 chats
// Fallback Polling - TEMPORARIAMENTE DESATIVADO
// O endpoint findChats da Evolution API está retornando erro 500 (bug interno)
// O webhook principal está funcionando e é suficiente para receber mensagens
// 
// cron.schedule('*/30 * * * * *', async () => {
//   // Polling code here - disabled due to Evolution API findChats bug
// }, { timezone: "America/Sao_Paulo" });

// Geração automática de próximas 3 visitas para clientes ativos
cron.schedule('0 0 * * *', async () => {
  console.log('📅 [SCHEDULER] Iniciando geração de próximas 3 visitas para clientes ativos às 00:00h...');
  
  try {
    const result = await storage.generateNextVisitsForActiveCustomers();
    console.log(`✅ [SCHEDULER] Geração de visitas concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.generated} visitas geradas`);
    if (result.errors > 0) {
      console.log(`   - ⚠️ ${result.errors} erro(s) encontrado(s)`);
    }
  } catch (error: any) {
    console.error('❌ [SCHEDULER] Erro na geração de visitas:', error.message);
  }
}, {
  timezone: "America/Sao_Paulo"
});

console.log('✅ Agendador configurado:');
console.log('   - Geração de relatórios de IA diariamente às 06:00h (UTC-3)');
console.log('   - Geração de próximas 3 visitas para clientes ativos diariamente às 00:00h (UTC-3)');
console.log('   - Geração de rotas diárias às 05:00h (UTC-3)');
console.log('   - Sincronização completa (Clientes + Faturamentos + Débitos) de hora em hora das 06:00h às 23:00h (UTC-3)');
console.log('   - Auto check-out de visitas (20+ min sem pedido/não-venda) a cada 5 minutos das 06:00h às 23:00h (UTC-3)');
console.log('   - Etapas Omie: sincronização manual via botão "Atualizar Etapas Omie" no Resumo de Rotas');
console.log('   ⚠️  Polling fallback WhatsApp DESATIVADO (Evolution API com bug no findChats)');
console.log('');
console.log('⚠️  Jobs desativados após migração para cards permanentes:');
console.log('   ✗ Sincronização de agenda futura (não necessário com cards permanentes)');
console.log('   ✗ Processamento de cards atrasados (não necessário com cards permanentes)');
console.log('   ✗ Geração de agenda de visitas (substituído por visit_schedule_history)');
