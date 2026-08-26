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
// Hora oficial do Brasil — regra unica em shared/tempo.ts.
import { agora, hojeBR, dataCalendario, componentesBR } from '@shared/tempo';
import { runRadarScan } from './purchase-routes';
import { runPositivacaoAlertaCron } from './positivacao-alert';
import { runDebitosVencidosAlertaCron } from './debitos-vencidos-alert';
import { runRotaNaoVisitadosCron } from './rota-nao-visitados-alert';
import { sweepOpenBoletos } from './bb-boleto-service';
import { runGarantirCobranca } from './charge-guarantee-routes';
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

// 🎯 CENTRAL DE MARKETING (buraco 3): reenvio da fila do Conversions API.
// A cada 10 min tenta os eventos 'pendente' e 'erro' (ate 5 tentativas cada).
// Sem credencial da Meta ou com mkt_capi_mode != 'on', a funcao sai na hora sem
// fazer nada — este cron e inerte ate alguem ligar o CAPI de proposito.
cron.schedule('*/10 * * * *', async () => {
  try {
    const { enviarPendentes } = await import('./mkt-ctwa');
    const r = await enviarPendentes(50);
    if (r.enviados || r.erros) console.log('🎯 [CAPI-CRON]', r);
  } catch (e: any) {
    console.error('❌ [CAPI-CRON]', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

// Alerta fim de dia 18:30 (BRT), SOMENTE DIAS ÚTEIS (Seg–Sex): clientes da rota de HOJE
// (presenciais/virtuais) que NÃO foram visitados, por vendedor. Externo -> próprio WhatsApp;
// interno (telemarketing) -> Cinthia. Kill-switch: system_settings 'rota_nao_visitados_ativo'='on'.
cron.schedule('30 18 * * 1-5', async () => {
  await runRotaNaoVisitadosCron();
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
        AND (next_contact_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
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
}, { timezone: 'America/Sao_Paulo' });

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

// GARANTIA "NENHUM PEDIDO DESAPARECE": rede de seguranca abrangente (superset do reconcile-pending).
// Varre pedidos com venda real de QUALQUER origem (hotsite, instagram, vendedores) - inclusive
// status='completed' orfaos - que ainda nao chegaram ao pipeline NEM a Bloqueados, e os roteia.
// Roda a cada 30 min (defasada 15 min do reconcile-pending). Idempotente (dedup no autoSend).
cron.schedule('15,45 * * * *', async () => {
  try {
    const { sweepUnbilledOrdersToPipeline } = await import('./billing-pipeline-routes');
    const r = await sweepUnbilledOrdersToPipeline({ apply: true, days: 30, pendingAgeMinutes: 30 });
    if ((r.routed + r.toBlocked) > 0) console.log(`[SCHEDULER] sweep-orphans: ${r.routed} roteado(s) + ${r.toBlocked} p/ bloqueados (de ${r.scanned} varrido[s]).`);
  } catch (error: any) {
    console.error('[SCHEDULER] erro no sweep-orphans:', error?.message || error);
  }
}, { timezone: 'America/Sao_Paulo' });

// 🚨 DETECTOR "PEDIDO SUMIU" (28/jul/2026) — 3a camada da garantia de que nenhum pedido
// desaparece. As duas primeiras (blindagem dos DELETEs + order_journal) impedem a perda;
// esta AVISA se ainda assim acontecer. Compara o diario imutavel (order_journal) com
// sales_cards/billing_pipeline e dispara WhatsApp. Roda de hora em hora, aos :25.
// Config: system_settings 'pedido_sumido_alerta_ativo' (on|off) e 'pedido_sumido_alerta_fones'.
// Nao recria nada sozinho — recuperacao e 1 clique: POST /api/admin/orders/journal/audit {apply:true}.
cron.schedule('25 * * * *', async () => {
  try {
    const { runPedidoSumidoAlertaCron } = await import('./order-journal');
    const r = await runPedidoSumidoAlertaCron();
    if (r.problemas > 0) console.warn(`[SCHEDULER] pedido-sumido: ${r.problemas} problema(s), alerta enviado=${r.enviado}${r.motivo ? ' (' + r.motivo + ')' : ''}`);
  } catch (error: any) {
    console.error('[SCHEDULER] erro no detector de pedido sumido:', error?.message || error);
  }
}, { timezone: 'America/Sao_Paulo' });

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
    // ⚠️ Dono unico da despedida: com a regra "Finalizar conversas inativas" da IA ligada
    // (ia-finalizar.ts), ela ja fecha a conversa E manda a mensagem — respeitando o prazo
    // proprio de 60 min da conversa em andamento com atendente. Este job antigo fazia a
    // mesma coisa com outro texto e o cliente recebia a despedida duas vezes (POLIBELT,
    // 13:22 e 13:32). Enquanto a regra estiver ligada, ele sai de cena.
    let regraIaLigada = false;
    try {
      const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'ia_regra_finalizar_on' LIMIT 1`);
      regraIaLigada = String(r.rows?.[0]?.value ?? '').replace(/^"|"$/g, '').trim() === 'on';
    } catch { /* sem config: mantem o comportamento antigo */ }
    if (regraIaLigada) return;

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
      lastFinishedAt: agora()
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

// ===== SINCRONIZAÇÃO HORÁRIA COM O OMIE — DESLIGADA (26/ago/2026) =====
//
// POR QUE FOI DESLIGADA: o Omie foi descontinuado. O INTEGRA passou a ser a
// fonte de verdade. Este cron rodava de hora em hora, das 06:00 às 23:00, e
// continuava tentando falar com uma API que não existe mais — 18 tentativas
// por dia gravando erro no log e escondendo problema de verdade no meio do
// ruído.
//
// POR QUE NÃO BASTAVA "não ter credencial": a variável OMIE_APP_KEY já tinha
// sido removida, mas `syncComplete` não depende dela — ele varre as empresas
// do grupo (tabela omie_instances) e usa o appKey/appSecret gravado em cada
// uma. Como essas empresas continuam ATIVAS por serem os CNPJs reais da
// Honest, o cron seguia encontrando credencial e tentando sincronizar.
//
// ⚠️ NÃO "conserte" isto reativando o cron nem desativando as empresas do
// grupo: `omie_instances` é o cadastro das empresas da Honest (cada uma com
// seu CNPJ), não uma configuração do Omie. Desativá-las quebraria produtos,
// títulos e tabelas de preço, que são segmentados por empresa.
//
// A função syncComplete e as rotas manuais foram mantidas de propósito: se um
// dia for preciso reimportar histórico pontualmente, o código está aqui. O que
// sai é a execução AUTOMÁTICA.
//
// if (process.env.NODE_ENV === 'production' || process.env.REPL_DEPLOYMENT) {
//   cron.schedule('0 6-23 * * *', () => {
//     const horario = `${String(componentesBR().hora).padStart(2, '0')}:00h`;
//     syncComplete(horario);
//   }, { timezone: "America/Sao_Paulo" });
// }
console.log('⛔ [SCHEDULER] Sincronização Omie horária DESLIGADA (Omie descontinuado — 26/ago/2026)');

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
          .set({ status: 'released', releasedAt: agora(), releasedBy: 'system-auto-debito-regularizado', updatedAt: agora() })
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
    const horario = `${String(componentesBR().hora).padStart(2, '0')}:15h`;
    autoReleaseRegularizedDebtOrders(horario);
  }, {
    timezone: "America/Sao_Paulo"
  });
  console.log('✅ [SCHEDULER] Liberacao automatica de pedidos bloqueados (debito regularizado) ativada - hora em hora as hh:15');
  // Reforco (pedido do Flavio): 2 liberacoes EXTRAS no minuto cheio — 10:00 e 14:00 BRT —
  // alem das horarias hh:15. A rotina e idempotente (so re-checa debito e libera regularizados).
  cron.schedule('0 10,14 * * *', () => {
    const horario = `${String(componentesBR().hora).padStart(2, '0')}:00h`;
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
    // Amanha no Brasil, como DATA DE CALENDARIO. Antes saia de nowBrazil() + toISOString(),
    // que so acertava por causa do deslocamento de -3h. Ver shared/tempo.ts.
    const amanha = dataCalendario(hojeBR());
    amanha.setUTCDate(amanha.getUTCDate() + 1);
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
    
    const hoje = dataCalendario(hojeBR());
    
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

// Limpeza mensal automatica: remove da lista de Clientes Ativos os registros
// "nao encontrado" (match_status unmatched) - deixa a lista so com clientes
// vinculados ao cadastro. Roda no dia 1 de cada mes as 04:00 (BRT). Idempotente.
cron.schedule('0 4 1 * *', async () => {
  try {
    const r: any = await db.execute(sql`
      UPDATE active_customers
      SET is_active = false, deactivated_at = now(), updated_at = now()
      WHERE is_active = true AND match_status = 'unmatched'
      RETURNING id`);
    const n = (r.rows ? r.rows.length : (Array.isArray(r) ? r.length : (r.rowCount ?? 0)));
    console.log(`[UNMATCHED-CLEANUP] Limpeza mensal: ${n} registros(s) nao encontrado removido(s) da lista de ativos.`);
  } catch (e: any) {
    console.error('[UNMATCHED-CLEANUP] falha na limpeza mensal:', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

// Cielo Link & Checkout (matriz): rede de seguranca contra webhook perdido.
// Roda de hora em hora; e no-op quando CIELO_LINK_ENABLED nao esta ligado.
cron.schedule('35 * * * *', async () => {
  try {
    const { reconcileCieloLinks } = await import('./payment-link');
    await reconcileCieloLinks(48);
  } catch (e: any) {
    console.error('[CIELO-LINK] cron de reconciliacao falhou:', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

console.log('✅ Agendador configurado:');
console.log('   - Geração de relatórios de IA diariamente às 06:00h (UTC-3)');
console.log('   - Geração de próximas 3 visitas para clientes ativos diariamente às 00:00h (UTC-3)');
console.log('   - Geração de rotas diárias às 05:00h (UTC-3)');
console.log('   - Limpeza mensal de registros nao encontrado na lista de ativos (dia 1, 04:00 UTC-3)');
console.log('   - Sincronização completa (Clientes + Faturamentos + Débitos) de hora em hora das 06:00h às 23:00h (UTC-3)');
console.log('   - Auto check-out de visitas (20+ min sem pedido/não-venda) a cada 5 minutos das 06:00h às 23:00h (UTC-3)');
console.log('   - Saúde da cobrança (somente leitura) às 07:20 em dias úteis (UTC-3)');
console.log('   - Garantir cobrança (emite o que faltou) de hora em hora das 08:40 às 19:40 em dias úteis (UTC-3)');
console.log('   - Etapas Omie: sincronização manual via botão "Atualizar Etapas Omie" no Resumo de Rotas');
console.log('   ⚠️  Polling fallback WhatsApp DESATIVADO (Evolution API com bug no findChats)');
console.log('');
// ---------------------------------------------------------------------------
// SAUDE DA COBRANCA (07:20, dias uteis) — SOMENTE LEITURA.
// Mede as tres falhas que voltam sozinhas se ninguem olhar: titulo de venda sem
// nenhuma cobranca, boleto liquidado no BB com titulo ainda em aberto (a
// varredura horaria NAO pega esse caso: ela so olha boleto que ainda esta
// aberto) e titulo com duas cobrancas vivas ao mesmo tempo.
// Grava o resultado em system_settings ('saude_cobranca_last') para dar serie
// historica, e loga em WARN quando ha algo. NAO emite cobranca, NAO da baixa e
// NAO cancela nada — a decisao continua humana.
// ---------------------------------------------------------------------------
cron.schedule('20 7 * * 1-5', async () => {
  try {
    const um = async (q: any) => { const r: any = await db.execute(q); return ((r.rows || r) as any[])[0] || {}; };
    const semCobranca = await um(sql`
      SELECT count(*)::int AS n, COALESCE(sum(r.amount::numeric - COALESCE(r.amount_paid, 0)::numeric), 0)::float AS valor
      FROM receivables r
      WHERE r.deleted_at IS NULL AND r.billing_pipeline_id IS NOT NULL
        AND r.status IN ('a_vencer', 'vencida')
        AND (r.amount::numeric - COALESCE(r.amount_paid, 0)::numeric) > 0.005
        AND COALESCE(r.import_origin, '') <> 'omie_historico'
        AND NOT EXISTS (SELECT 1 FROM boleto_charges b WHERE b.receivable_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM boleto_charge_receivables jr WHERE jr.receivable_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM pix_charges pc WHERE pc.receivable_id = r.id)`);
    const pagoSemBaixa = await um(sql`
      SELECT count(*)::int AS n, COALESCE(sum(r.amount::numeric - COALESCE(r.amount_paid, 0)::numeric), 0)::float AS valor
      FROM boleto_charges b JOIN receivables r ON r.id = b.receivable_id
      WHERE lower(COALESCE(b.status, '')) IN ('liquidado', 'pago', 'recebido')
        AND r.deleted_at IS NULL AND r.status IN ('a_vencer', 'vencida')
        AND (r.amount::numeric - COALESCE(r.amount_paid, 0)::numeric) > 0.005`);
    const duplicada = await um(sql`
      SELECT count(*)::int AS n FROM (
        SELECT rid FROM (
          SELECT receivable_id AS rid FROM boleto_charges
           WHERE deleted_at IS NULL AND upper(COALESCE(status, '')) IN ('REGISTRADO', 'VENCIDO') AND receivable_id IS NOT NULL
          UNION ALL
          SELECT receivable_id FROM pix_charges
           WHERE deleted_at IS NULL AND status::text = 'ATIVA' AND receivable_id IS NOT NULL
        ) t GROUP BY rid HAVING count(*) > 1) x`);
    const snap = {
      at: new Date().toISOString(),
      tituloSemCobranca: { n: Number(semCobranca.n || 0), valor: Number(semCobranca.valor || 0) },
      boletoPagoSemBaixa: { n: Number(pagoSemBaixa.n || 0), valor: Number(pagoSemBaixa.valor || 0) },
      cobrancaDuplicada: { n: Number(duplicada.n || 0) },
    };
    await db.execute(sql`
      INSERT INTO system_settings (key, value, updated_by)
      VALUES ('saude_cobranca_last', ${JSON.stringify(snap)}, 'cron-saude-cobranca')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
    const total = snap.tituloSemCobranca.n + snap.boletoPagoSemBaixa.n + snap.cobrancaDuplicada.n;
    if (total > 0) {
      console.warn(`⚠️  [SAUDE-COBRANCA] sem cobranca: ${snap.tituloSemCobranca.n} (R$ ${snap.tituloSemCobranca.valor.toFixed(2)}) | boleto pago sem baixa: ${snap.boletoPagoSemBaixa.n} (R$ ${snap.boletoPagoSemBaixa.valor.toFixed(2)}) | cobranca duplicada: ${snap.cobrancaDuplicada.n} titulo(s). Detalhe: GET /api/admin/financial/saude-cobranca`);
    } else {
      console.log('✅ [SAUDE-COBRANCA] nada pendente');
    }
  } catch (e: any) {
    console.error('[SAUDE-COBRANCA] falhou:', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

// ---------------------------------------------------------------------------
// GARANTIR COBRANCA (de hora em hora, 8h-19h, dias uteis).
// Emite a cobranca que faltou nos titulos de VENDA em aberto criados a partir do
// cutoff. Titulo faturado sem boleto e sem PIX e dinheiro que nunca entra: o
// cliente nao paga o que nao foi cobrado.
//
// Limite de 25 por rodada: rodando 12x por dia isso e folgado para o volume real
// (9 pendentes hoje) e, se algo estiver errado na emissao, o estrago para em 25
// e nao em 200.
//
// A instancia que NAO emite (SERV, por decisao de 06/jul) ja fica de fora da lista
// de candidatos dentro de runGarantirCobranca — sem isso, os 7 titulos dela
// seriam tentados 12 vezes por dia, para sempre, e o log de erro viraria ruido.
// ---------------------------------------------------------------------------
cron.schedule('40 8-19 * * 1-5', async () => {
  try {
    const r = await runGarantirCobranca({ apply: true, limit: 25 });
    if (r.ok > 0 || r.fail > 0) {
      console.log(`[GARANTIR-COBRANCA] emitidas=${r.ok} falhas=${r.fail} puladas=${r.skipped} candidatos=${r.candidatos} (instancia que nao emite: ${r.naoEmitem})`);
    }
    if (r.fail > 0) {
      console.warn('⚠️  [GARANTIR-COBRANCA] ' + r.fail + ' titulo(s) falharam ao emitir. Detalhe: POST /api/admin/financial/garantir-cobranca { "apply": false }');
    }
    if ((r.bloqueados || []).length) {
      // Falharam 3x seguidas e sairam da fila: quase sempre e cadastro do cliente
      // (CNPJ do pagador invalido, endereco incompleto). So volta corrigindo o
      // cadastro e rodando com { "destravar": true }.
      console.warn('⚠️  [GARANTIR-COBRANCA] ' + r.bloqueados.length + ' titulo(s) BLOQUEADOS por falha repetida (corrija o cadastro e rode com destravar:true): ' + r.bloqueados.map((b: any) => b.titulo).join(', '));
    }
  } catch (e: any) {
    console.error('[GARANTIR-COBRANCA] cron falhou:', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

console.log('⚠️  Jobs desativados após migração para cards permanentes:');
console.log('   ✗ Sincronização de agenda futura (não necessário com cards permanentes)');
console.log('   ✗ Processamento de cards atrasados (não necessário com cards permanentes)');
console.log('   ✗ Geração de agenda de visitas (substituído por visit_schedule_history)');

// ---------------------------------------------------------------------------
// Insights do Instagram: uma leitura por dia, de madrugada
// ---------------------------------------------------------------------------
//
// coletarTodos() dizia no comentario "Chamada pelo cron" — e o cron nunca existiu.
// A coleta so rodava quando alguem apertava o botao na /marketing. Resultado: a
// serie historica nascia com UM ponto e congelava ali, que e exatamente o buraco
// que a Central foi feita para fechar ("analise vira print de celular").
//
// 03:20 e de proposito: fora do horario comercial, longe dos jobs das 6h, e ja
// virou o dia no fuso de Sao Paulo — entao a medicao do dia anterior fecha com a
// data certa (uma medicao por post por DIA e a regra do modulo).
//
// Inerte quando o modo esta 'off': coletarTodos devolve na hora, sem tocar na API
// da Meta. Nao precisa de guarda aqui.
//
// 400 dias, e nao 30: a janela existe para nao varrer a conta inteira, mas posts
// antigos continuam ganhando alcance por meses. Com ~2 publicacoes por mes, 400
// dias sao poucas dezenas de chamadas — barato, e evita serie que morre cedo.
cron.schedule('20 3 * * *', async () => {
  try {
    const { coletarTodos } = await import('./mkt-posts');
    const r = await coletarTodos(400);
    if (r.modo === 'off') return; // desligado: nem loga, para nao virar ruido diario
    console.log(`[MKT-INSIGHTS] modo=${r.modo} tentados=${r.tentados} gravados=${r.gravados} erros=${r.erros}`);
    if (r.erros > 0) {
      // Quase sempre e token vencido ou permissao revogada. O diagnostico com
      // nome e sobrenome esta em GET /api/mkt/posts/coleta/sonda.
      console.warn('⚠️  [MKT-INSIGHTS] ' + r.erros + ' post(s) falharam. Rode a sonda: GET /api/mkt/posts/coleta/sonda');
    }
  } catch (e: any) {
    console.error('[MKT-INSIGHTS] cron falhou:', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

// ---------------------------------------------------------------------------
// Recompra: o lote do dia fica pronto antes de voce acordar
// ---------------------------------------------------------------------------
//
// montarLote() era chamada de um lugar so: o botao da /marketing. O motor de
// maior retorno da Central — e o unico que nao depende da Meta, de App Review
// nem de verba — dependia de alguem lembrar de entrar e clicar todo dia. Auto-
// macao que depende de memoria humana nao sobrevive a uma semana corrida.
//
// Este job SO PREPARA. A liberacao continua sua: o lote nasce 'previsto', com
// custo estimado e receita esperada na tela, e fica esperando. Nenhuma mensagem
// entra na fila do 1841 sem alguem apertar Liberar.
//
// Tres guardas, nesta ordem:
//
//   1. So monta se o canal oficial estiver de pe (oficial_dispatch_mode != off
//      E oficial_recompra != off). Sem isso o lote nasceria natimorto: liberado,
//      todo item voltaria 'desligado' e ninguem receberia nada. De quebra, evita
//      lote de lixo enquanto os templates nao foram aprovados no Umbler — e
//      dispensa inventar mais uma chave para voce lembrar de ligar.
//   2. Nao monta se ja existe lote 'previsto' esperando decisao. Sem isso, uma
//      semana sem olhar o painel viraria 7 lotes empilhados, e o teto de 1 toque
//      por cliente a cada 14 dias ficaria impossivel de raciocinar. Se o lote
//      parado passar de 3 dias, avisa — represar em silencio seria pior.
//   3. Lote vazio e descartado na hora. Dia sem candidato nao deve deixar cartao
//      vazio na tela nem linha morta no historico.
//
// 06:40: depois da rajada das 6h, antes do comercial. Quando voce pega o
// celular, o lote ja esta la esperando o sim.
cron.schedule('40 6 * * *', async () => {
  try {
    const chave = async (k: string): Promise<string> => {
      try {
        const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${k} LIMIT 1`);
        const v = r.rows?.[0]?.value;
        return v == null ? 'off' : String(v).replace(/^"|"$/g, '');
      } catch { return 'off'; }
    };
    if ((await chave('oficial_dispatch_mode')) === 'off') return;
    if ((await chave('oficial_recompra')) === 'off') return;

    const p: any = await db.execute(sql`
      SELECT id, criado_em, EXTRACT(EPOCH FROM (now() - criado_em)) / 86400 AS dias
        FROM mkt_lotes WHERE status = 'previsto' ORDER BY criado_em ASC LIMIT 1`);
    const parado = p.rows?.[0];
    if (parado) {
      if (Number(parado.dias) >= 3) {
        console.warn('⚠️  [MKT-RECOMPRA] lote ' + parado.id + ' esperando decisao ha '
          + Math.floor(Number(parado.dias)) + ' dia(s). Enquanto ele nao for liberado ou descartado, nao monto outro.');
      }
      return;
    }

    const { montarLote, descartarLote } = await import('./mkt-recompra');
    const r = await montarLote({ criadoPor: 'cron' });
    if (!r.total) { await descartarLote(r.loteId); return; }
    console.log('[MKT-RECOMPRA] lote ' + r.loteId + ': ' + r.total + ' cliente(s), custo ~R$ '
      + r.custoEstimado + ', receita esperada ~R$ ' + r.receitaEsperada + '. Esperando liberacao em /marketing.');
    if ((r.templatesFaltando || []).length) {
      console.warn('⚠️  [MKT-RECOMPRA] template(s) sem cadastro: ' + r.templatesFaltando.join(', ')
        + '. O lote monta, mas a liberacao vai falhar item a item — e o custo acima e palpite,'
        + ' porque a categoria aprovada pela Meta e que define R$ 0,04 (UTILITY) ou R$ 0,34 (MARKETING).');
    }
  } catch (e: any) {
    console.error('[MKT-RECOMPRA] cron falhou:', e?.message || e);
  }
}, { timezone: 'America/Sao_Paulo' });

// ---------------------------------------------------------------------------
// Esteira: peca agendada que passou da hora e ninguem publicou
// ---------------------------------------------------------------------------
//
// 'agendado' e um estado real da esteira, e a UNICA saida dele e alguem marcar
// como publicada — nao existe publicacao automatica no Instagram (nem a permissao
// instagram_content_publish foi concedida ao app). Isso e desenho, nao defeito:
// voce publica na mao e registra.
//
// O defeito seria o silencio. Sem ninguem olhando, uma peca agendada para ontem
// simplesmente para de existir: nao esta na fila de aprovacao, nao esta publicada,
// nao aparece em lugar nenhum como pendencia. Mesma familia do cron que nunca
// existiu e do 'Lead' que a Meta nao aceita — motor construido, resultado nenhum.
//
// So avisa. Nao publica, nao muda estado, nao decide nada.
// 09:00: depois do comercial abrir, quando ainda da tempo de publicar no dia.
cron.schedule('0 9 * * *', async () => {
  try {
    const r: any = await db.execute(sql`
      SELECT id, titulo, canal, agendado_para,
             EXTRACT(EPOCH FROM (now() - agendado_para)) / 86400 AS dias
        FROM mkt_pieces
       WHERE estado = 'agendado' AND agendado_para IS NOT NULL AND agendado_para < now()
       ORDER BY agendado_para ASC LIMIT 20`);
    const vencidas = r.rows || [];
    if (!vencidas.length) return; // dia normal nao vira log

    console.warn('⚠️  [MKT-ESTEIRA] ' + vencidas.length + ' peca(s) agendada(s) passaram da data e ninguem publicou:');
    for (const p of vencidas) {
      console.warn('   • ' + String(p.titulo || p.id).slice(0, 60)
        + ' (' + (p.canal || 'sem canal') + ') — atrasada ha ' + Math.floor(Number(p.dias) || 0) + ' dia(s)');
    }
    console.warn('   Publique e marque em /marketing, ou devolva para producao. Parada em "agendado" ela nao aparece em lugar nenhum.');
  } catch (e: any) {
    // Schema da esteira pode nao existir ainda: nao e erro que mereca alarme.
    const m = String(e?.message || e);
    if (!/does not exist|relation .* does not exist/i.test(m)) {
      console.error('[MKT-ESTEIRA] vigia das agendadas falhou:', m);
    }
  }
}, { timezone: 'America/Sao_Paulo' });

// ---------------------------------------------------------------------------
// Esteira: o agente de conteudo alimenta a fila
// ---------------------------------------------------------------------------
//
// A esteira tinha revisor de IA, portao de aprovacao e decisao em lote — e
// `de_agente: 0`. Filtro bom, sem entrada. Este job e a entrada.
//
// Roda TODO DIA, mas so produz enquanto a cota da semana nao fechou (o proprio
// agente conta e para sozinho). Diario com cota e melhor que "seg/qua/sex": se
// um dia falha, o seguinte recupera, em vez de perder a peca da semana.
//
// O agente NAO publica. Ele cria a peca e manda para revisao; ela para em
// aguardando_aprovacao esperando voce. Nasce com modo 'off' — nada acontece
// aqui ate alguem ligar em /marketing.
//
// 07:10: depois do lote de recompra das 06:40, para as duas coisas ja estarem
// na tela quando voce pega o celular.
cron.schedule('10 7 * * *', async () => {
  try {
    const { rodar, modo } = await import('./mkt-agente-conteudo');
    if ((await modo()) === 'off') return;   // desligado nao vira log todo dia

    const r = await rodar({ quem: 'cron' });
    if (r.criou) {
      console.log('[MKT-CONTEUDO] peca ' + r.pieceId + ' (' + r.assunto?.publico + ' x ' + r.assunto?.gancho
        + ') criada e enviada para revisao: ' + r.estado + '/' + r.veredito
        + '. Cota da semana: ' + ((r.saldo?.feitas || 0) + 1) + '/' + (r.saldo?.cota || 0) + '.');
      return;
    }
    // Cota cumprida e o caso normal — nao merece alarme nenhum dia da semana.
    if (r.ok && /cota/.test(String(r.motivo))) return;
    console.warn('⚠️  [MKT-CONTEUDO] nao produziu hoje: ' + (r.motivo || 'sem motivo informado'));
  } catch (e: any) {
    const m = String(e?.message || e);
    if (!/does not exist|relation .* does not exist/i.test(m)) {
      console.error('[MKT-CONTEUDO] cron falhou:', m);
    }
  }
}, { timezone: 'America/Sao_Paulo' });
