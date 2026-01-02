import { db } from "./db";
import { chatAgents, chatConversations, chatDistributionState, chatAiSettings, AGENT_COLORS } from "@shared/schema";
import { eq, and, desc, isNull, lt, ne, sql } from "drizzle-orm";

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
  agentColor: string | null = null
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
  
  console.log(`🔄 [DISTRIBUTION] Conversa ${conversationId} atribuída ao agente ${agentId || 'ChatGPT'}`);
}

export async function distributeNewConversation(conversationId: string): Promise<{ assignedTo: string; isChatGpt: boolean }> {
  // Buscar configurações de IA para verificar prioridade do ChatGPT
  const aiSettings = await db.select().from(chatAiSettings).limit(1);
  const settings = aiSettings[0];
  const chatgptQueuePosition = settings?.chatgptQueuePosition ?? 0;
  const isChatGptEnabled = settings?.isEnabled ?? false;
  
  // Se ChatGPT está habilitado e tem posição 1 (primeiro na fila), ele atende primeiro
  if (isChatGptEnabled && chatgptQueuePosition === 1) {
    console.log(`🤖 [DISTRIBUTION] ChatGPT configurado como primeiro na fila de atendimento.`);
    await assignConversationToAgent(conversationId, "chatgpt", "#9B59B6");
    return { assignedTo: "chatgpt", isChatGpt: true };
  }
  
  // Fluxo normal: distribuir para atendentes humanos via round-robin
  const nextAgent = await getNextAgentRoundRobin();
  
  if (nextAgent) {
    await assignConversationToAgent(conversationId, nextAgent.agentId, nextAgent.agentColor);
    return { assignedTo: nextAgent.agentId, isChatGpt: false };
  } else {
    // Nenhum atendente online - verificar se ChatGPT pode assumir via standby
    const isStandby = settings?.isStandby ?? true;
    
    if (isStandby && isChatGptEnabled) {
      console.log(`🤖 [DISTRIBUTION] Nenhum atendente online. Ativando ChatGPT via standby.`);
      await assignConversationToAgent(conversationId, "chatgpt", "#9B59B6");
      return { assignedTo: "chatgpt", isChatGpt: true };
    } else {
      console.log(`⚠️ [DISTRIBUTION] Nenhum atendente online e ChatGPT não está em standby.`);
      return { assignedTo: "", isChatGpt: false };
    }
  }
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
  isAdmin: boolean
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
  
  if (toAgentId !== "chatgpt") {
    const targetAgent = await db
      .select()
      .from(chatAgents)
      .where(eq(chatAgents.id, toAgentId))
      .limit(1);
    
    if (targetAgent.length === 0) {
      return { success: false, error: "Atendente de destino não encontrado" };
    }
    
    if (!isAdmin && targetAgent[0].status !== "online") {
      return { success: false, error: "Atendente de destino não está online" };
    }
  }
  
  const onlineAgents = await getOnlineTelemarketingAgents();
  const agentIndex = onlineAgents.findIndex(a => a.id === toAgentId);
  const agentColor = toAgentId === "chatgpt" 
    ? "#9B59B6" 
    : AGENT_COLORS[agentIndex >= 0 ? agentIndex % AGENT_COLORS.length : 0];
  
  await assignConversationToAgent(conversationId, toAgentId, agentColor);
  
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
