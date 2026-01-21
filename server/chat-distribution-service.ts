import { db } from "./db";
import { chatAgents, chatConversations, chatDistributionState, chatAiSettings, chatMessages, chatAssignmentHistory, AGENT_COLORS } from "@shared/schema";
import { eq, and, desc, isNull, lt, ne, sql } from "drizzle-orm";
import { evolutionAPIService } from "./evolution-api-service";

const REDISTRIBUTION_TIMEOUT_MINUTES = 5;

export async function getOnlineTelemarketingAgents() {
  const agents = await db
    .select()
    .from(chatAgents)
    .where(
      and(
        eq(chatAgents.status, "online"),
        eq(chatAgents.isActive, true)
      )
    )
    .orderBy(chatAgents.name);
  
  return agents;
}

export async function getNextAgentRoundRobin(): Promise<{ agentId: string; agentColor: string } | null> {
  const onlineAgents = await getOnlineTelemarketingAgents();
  
  if (onlineAgents.length === 0) {
    return null;
  }

  let state = await db
    .select()
    .from(chatDistributionState)
    .where(eq(chatDistributionState.id, "singleton"))
    .limit(1);

  let lastAssignedAgentId = state[0]?.lastAssignedAgentId;
  let nextAgent;
  let nextAgentIndex = 0;

  if (!lastAssignedAgentId) {
    nextAgent = onlineAgents[0];
    nextAgentIndex = 0;
  } else {
    const lastAgentIndex = onlineAgents.findIndex(a => a.id === lastAssignedAgentId);
    if (lastAgentIndex === -1) {
      nextAgent = onlineAgents[0];
      nextAgentIndex = 0;
    } else {
      nextAgentIndex = (lastAgentIndex + 1) % onlineAgents.length;
      nextAgent = onlineAgents[nextAgentIndex];
    }
  }

  const agentColor = AGENT_COLORS[nextAgentIndex % AGENT_COLORS.length];

  if (state.length === 0) {
    await db.insert(chatDistributionState).values({
      id: "singleton",
      lastAssignedAgentId: nextAgent.id,
      lastAssignedAt: new Date(),
      updatedAt: new Date()
    });
  } else {
    await db
      .update(chatDistributionState)
      .set({
        lastAssignedAgentId: nextAgent.id,
        lastAssignedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(chatDistributionState.id, "singleton"));
  }

  return { agentId: nextAgent.id, agentColor };
}

export async function assignConversationToAgent(
  conversationId: string,
  agentId: string | null,
  agentColor: string | null = null,
  options?: {
    assignedByUserId?: string;
    assignedByUserName?: string;
    reason?: string;
    agentName?: string;
  }
): Promise<void> {
  await db
    .update(chatConversations)
    .set({
      assignedAgentId: agentId,
      assignedAgentColor: agentColor,
      lastAttendedAt: agentId ? new Date() : null,
      status: agentId ? "assigned" : "new",
      updatedAt: new Date()
    })
    .where(eq(chatConversations.id, conversationId));
  
  // Registrar no histórico de atribuições
  if (agentId) {
    await db.insert(chatAssignmentHistory).values({
      conversationId,
      assignedAgentId: agentId,
      assignedAgentName: options?.agentName || (agentId === 'chatgpt' ? 'ChatGPT' : null),
      assignedByUserId: options?.assignedByUserId || null,
      assignedByUserName: options?.assignedByUserName || 'Sistema',
      reason: options?.reason || 'initial'
    });
  }
  
  console.log(`🔄 [DISTRIBUTION] Conversa ${conversationId} atribuída ao agente ${agentId || 'ChatGPT'}`);
}

/**
 * Distribui uma nova conversa baseado em quem a iniciou:
 * - Iniciada pelo CLIENTE: vai para ChatGPT (se ativado) ou round-robin
 * - Iniciada pelo USUÁRIO: vai direto para esse usuário
 */
export async function distributeNewConversation(
  conversationId: string,
  options?: {
    initiatedBy?: 'customer' | 'user';
    initiatedByUserId?: string;
    initiatedByUserName?: string;
  }
): Promise<{ assignedTo: string; isChatGpt: boolean }> {
  const initiatedBy = options?.initiatedBy || 'customer';
  
  // Se a conversa foi iniciada por um USUÁRIO, atribuir diretamente a ele
  if (initiatedBy === 'user' && options?.initiatedByUserId) {
    console.log(`👤 [DISTRIBUTION] Conversa ${conversationId} iniciada por usuário ${options.initiatedByUserId}`);
    
    // Buscar o chatAgent correspondente ao userId
    const userAgent = await db
      .select()
      .from(chatAgents)
      .where(eq(chatAgents.userId, options.initiatedByUserId))
      .limit(1);
    
    if (userAgent.length === 0) {
      console.warn(`⚠️ [DISTRIBUTION] Usuário ${options.initiatedByUserId} não tem agente de chat - usando round-robin`);
      // Fallback para round-robin se não encontrar agente
      const nextAgent = await getNextAgentRoundRobin();
      if (nextAgent) {
        const agent = await db.select().from(chatAgents).where(eq(chatAgents.id, nextAgent.agentId)).limit(1);
        await assignConversationToAgent(conversationId, nextAgent.agentId, nextAgent.agentColor, {
          reason: 'initial_user',
          agentName: agent[0]?.name || undefined
        });
        return { assignedTo: nextAgent.agentId, isChatGpt: false };
      }
      return { assignedTo: "", isChatGpt: false };
    }
    
    const agentId = userAgent[0].id;
    const agentName = userAgent[0].name;
    
    // Atualizar a conversa com info do iniciador
    await db.update(chatConversations).set({
      initiatedBy: 'user',
      initiatedByUserId: options.initiatedByUserId,
      updatedAt: new Date()
    }).where(eq(chatConversations.id, conversationId));
    
    // Buscar cor do agente
    const agentColor = await getAgentColor(agentId);
    
    await assignConversationToAgent(conversationId, agentId, agentColor, {
      assignedByUserId: options.initiatedByUserId,
      assignedByUserName: agentName || options.initiatedByUserName || 'Usuário',
      reason: 'initial_user',
      agentName: agentName
    });
    
    return { assignedTo: agentId, isChatGpt: false };
  }
  
  // Conversa iniciada pelo CLIENTE
  // Atualizar a conversa com info do iniciador
  await db.update(chatConversations).set({
    initiatedBy: 'customer',
    updatedAt: new Date()
  }).where(eq(chatConversations.id, conversationId));
  
  // Buscar configurações de IA
  const aiSettings = await db.select().from(chatAiSettings).limit(1);
  const settings = aiSettings[0];
  const isChatGptEnabled = settings?.isEnabled ?? false;
  
  // Se ChatGPT ATIVADO: conversas de clientes vão para o ChatGPT
  if (isChatGptEnabled) {
    console.log(`🤖 [DISTRIBUTION] Conversa ${conversationId} iniciada por cliente - encaminhada para ChatGPT`);
    await assignConversationToAgent(conversationId, "chatgpt", "#9B59B6", {
      reason: 'initial_customer',
      agentName: 'ChatGPT'
    });
    return { assignedTo: "chatgpt", isChatGpt: true };
  }
  
  // ChatGPT desativado: distribuir para atendentes humanos via round-robin
  console.log(`👤 [DISTRIBUTION] ChatGPT DESATIVADO - Buscando atendente humano para conversa ${conversationId}`);
  const nextAgent = await getNextAgentRoundRobin();
  
  if (nextAgent) {
    // Buscar nome do agente
    const agent = await db.select().from(chatAgents).where(eq(chatAgents.id, nextAgent.agentId)).limit(1);
    
    await assignConversationToAgent(conversationId, nextAgent.agentId, nextAgent.agentColor, {
      reason: 'initial_customer',
      agentName: agent[0]?.name || undefined
    });
    console.log(`✅ [DISTRIBUTION] Conversa ${conversationId} atribuída ao atendente ${nextAgent.agentId}`);
    return { assignedTo: nextAgent.agentId, isChatGpt: false };
  } else {
    // Nenhum atendente online - enviar mensagem de ausência
    console.log(`⚠️ [DISTRIBUTION] Nenhum atendente online. Enviando mensagem de ausência.`);
    
    // Buscar conversa para obter telefone do cliente
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, conversationId))
      .limit(1);
    
    if (conversation?.customerPhone) {
      const absenceMessage = settings?.absenceMessage || 
        'No momento não há atendentes disponíveis. Por favor, tente novamente em instantes ou envie sua mensagem que responderemos assim que possível.';
      
      try {
        const config = evolutionAPIService.getConfig();
        if (config?.instanceName) {
          await evolutionAPIService.sendTextMessage(config.instanceName, conversation.customerPhone, absenceMessage);
          console.log(`📩 [DISTRIBUTION] Mensagem de ausência enviada para ${conversation.customerPhone}`);
        }
        
        // Registrar mensagem no histórico
        await db.insert(chatMessages).values({
          conversationId: conversationId,
          senderId: 'system',
          senderType: 'system',
          content: `[Mensagem automática - sem atendentes online] ${absenceMessage}`,
          messageType: 'text',
          isRead: true
        });
      } catch (sendErr: any) {
        console.error(`⚠️ [DISTRIBUTION] Erro ao enviar mensagem de ausência:`, sendErr.message);
      }
    }
    
    return { assignedTo: "", isChatGpt: false };
  }
}

// Função para buscar histórico de atribuições de uma conversa
export async function getAssignmentHistory(conversationId: string) {
  return await db
    .select()
    .from(chatAssignmentHistory)
    .where(eq(chatAssignmentHistory.conversationId, conversationId))
    .orderBy(desc(chatAssignmentHistory.createdAt));
}

export async function redistributeTimedOutConversations(): Promise<number> {
  const timeoutDate = new Date();
  timeoutDate.setMinutes(timeoutDate.getMinutes() - REDISTRIBUTION_TIMEOUT_MINUTES);
  
  const timedOutConversations = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        lt(chatConversations.lastAttendedAt, timeoutDate),
        ne(chatConversations.assignedAgentId, "chatgpt"),
        eq(chatConversations.status, "assigned")
      )
    );
  
  let redistributedCount = 0;
  
  for (const conv of timedOutConversations) {
    if (!conv.assignedAgentId) continue;
    
    const currentAgent = await db
      .select()
      .from(chatAgents)
      .where(eq(chatAgents.id, conv.assignedAgentId))
      .limit(1);
    
    if (currentAgent.length > 0 && currentAgent[0].status === "online") {
      continue;
    }
    
    const nextAgent = await getNextAgentRoundRobin();
    
    if (nextAgent) {
      await assignConversationToAgent(conv.id, nextAgent.agentId, nextAgent.agentColor);
      console.log(`⏱️ [REDISTRIBUTION] Conversa ${conv.id} redistribuída de ${conv.assignedAgentId} para ${nextAgent.agentId}`);
      redistributedCount++;
    } else {
      const aiSettings = await db.select().from(chatAiSettings).limit(1);
      if (aiSettings[0]?.isStandby && aiSettings[0]?.isEnabled) {
        await assignConversationToAgent(conv.id, "chatgpt", "#9B59B6");
        console.log(`🤖 [REDISTRIBUTION] Conversa ${conv.id} encaminhada para ChatGPT (sem atendentes)`);
        redistributedCount++;
      }
    }
  }
  
  return redistributedCount;
}

export async function transferConversation(
  conversationId: string,
  fromAgentId: string,
  toAgentId: string,
  requestingUserId: string,
  isAdmin: boolean,
  requestingUserName?: string
): Promise<{ success: boolean; error?: string }> {
  const conversation = await db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .limit(1);
  
  if (conversation.length === 0) {
    return { success: false, error: "Conversa não encontrada" };
  }
  
  if (!isAdmin && conversation[0].assignedAgentId !== fromAgentId) {
    return { success: false, error: "Você não pode transferir uma conversa que não está atribuída a você" };
  }
  
  let targetAgentName: string | undefined;
  
  if (toAgentId !== "chatgpt") {
    const targetAgent = await db
      .select()
      .from(chatAgents)
      .where(eq(chatAgents.id, toAgentId))
      .limit(1);
    
    if (targetAgent.length === 0) {
      return { success: false, error: "Atendente de destino não encontrado" };
    }
    
    targetAgentName = targetAgent[0]?.name || undefined;
    
    if (!isAdmin && targetAgent[0].status !== "online") {
      return { success: false, error: "Atendente de destino não está online" };
    }
  } else {
    targetAgentName = 'ChatGPT';
  }
  
  const onlineAgents = await getOnlineTelemarketingAgents();
  const agentIndex = onlineAgents.findIndex(a => a.id === toAgentId);
  const agentColor = toAgentId === "chatgpt" 
    ? "#9B59B6" 
    : AGENT_COLORS[agentIndex >= 0 ? agentIndex % AGENT_COLORS.length : 0];
  
  await assignConversationToAgent(conversationId, toAgentId, agentColor, {
    assignedByUserId: requestingUserId,
    assignedByUserName: requestingUserName || 'Usuário',
    reason: 'transfer',
    agentName: targetAgentName
  });
  
  console.log(`🔄 [TRANSFER] Conversa ${conversationId} transferida de ${fromAgentId} para ${toAgentId} por ${requestingUserId}`);
  
  return { success: true };
}

export async function getAgentColor(agentId: string): Promise<string> {
  if (agentId === "chatgpt") {
    return "#9B59B6";
  }
  
  const onlineAgents = await getOnlineTelemarketingAgents();
  const agentIndex = onlineAgents.findIndex(a => a.id === agentId);
  
  return AGENT_COLORS[agentIndex >= 0 ? agentIndex % AGENT_COLORS.length : 0];
}

export async function updateLastAttendedTime(conversationId: string): Promise<void> {
  await db
    .update(chatConversations)
    .set({
      lastAttendedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(chatConversations.id, conversationId));
}

export async function activateChatGPTStandby(): Promise<void> {
  const aiSettings = await db.select().from(chatAiSettings).limit(1);
  
  if (aiSettings.length === 0) {
    console.log('⚠️ [STANDBY] Configurações de IA não encontradas - não é possível ativar standby');
    return;
  }
  
  if (!aiSettings[0].isEnabled) {
    console.log('⚠️ [STANDBY] ChatGPT não está habilitado nas configurações - não ativando standby');
    return;
  }
  
  if (aiSettings[0].isStandby) {
    console.log('ℹ️ [STANDBY] Modo standby já está ativo');
    return;
  }
  
  await db
    .update(chatAiSettings)
    .set({
      isStandby: true,
      updatedAt: new Date()
    })
    .where(eq(chatAiSettings.id, aiSettings[0].id));
  
  console.log('🤖 [STANDBY] Modo standby do ChatGPT ativado automaticamente - nenhum atendente online');
}

export async function deactivateChatGPTStandby(): Promise<void> {
  const aiSettings = await db.select().from(chatAiSettings).limit(1);
  
  if (aiSettings.length === 0 || !aiSettings[0].isStandby) {
    return;
  }
  
  await db
    .update(chatAiSettings)
    .set({
      isStandby: false,
      updatedAt: new Date()
    })
    .where(eq(chatAiSettings.id, aiSettings[0].id));
  
  console.log('👤 [STANDBY] Modo standby do ChatGPT desativado - atendentes online disponíveis');
}

// Transferir conversa do ChatGPT para o primeiro atendente humano online
export async function transferFromChatGptToHuman(conversationId: string): Promise<{ success: boolean; assignedTo: string | null; error?: string }> {
  try {
    // Buscar próximo atendente humano online via round-robin
    const nextAgent = await getNextAgentRoundRobin();
    
    if (nextAgent) {
      await assignConversationToAgent(conversationId, nextAgent.agentId, nextAgent.agentColor);
      
      // Atualizar status para 'assigned'
      await db
        .update(chatConversations)
        .set({
          status: 'assigned',
          updatedAt: new Date()
        })
        .where(eq(chatConversations.id, conversationId));
      
      console.log(`👤 [TRANSFER-TO-HUMAN] Conversa ${conversationId} transferida do ChatGPT para ${nextAgent.agentId}`);
      return { success: true, assignedTo: nextAgent.agentId };
    } else {
      // Nenhum atendente online - manter a conversa com status 'new' para ser pega quando alguém ficar online
      await db
        .update(chatConversations)
        .set({
          assignedAgentId: null,
          assignedAgentColor: null,
          status: 'new',
          updatedAt: new Date()
        })
        .where(eq(chatConversations.id, conversationId));
      
      console.log(`⚠️ [TRANSFER-TO-HUMAN] Nenhum atendente online. Conversa ${conversationId} aguardando na fila.`);
      return { success: true, assignedTo: null, error: "Nenhum atendente online no momento. Você será atendido em breve." };
    }
  } catch (error: any) {
    console.error(`❌ [TRANSFER-TO-HUMAN] Erro ao transferir conversa ${conversationId}:`, error.message);
    return { success: false, assignedTo: null, error: error.message };
  }
}
