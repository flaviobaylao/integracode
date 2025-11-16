import { eq, and, lt, sql } from "drizzle-orm";
import { db } from "./db";
import { agents, users, conversations, auditLog, messages } from "@shared/schema";

export class AgentActivityService {
  private static instance: AgentActivityService;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutos
  private readonly RESPONSE_TIMEOUT = 5 * 60 * 1000; // 5 minutos para resposta
  private readonly CONVERSATION_INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1 hora para finalização automática
  private readonly HEARTBEAT_CHECK_INTERVAL = 60 * 1000; // 1 minuto

  static getInstance(): AgentActivityService {
    if (!AgentActivityService.instance) {
      AgentActivityService.instance = new AgentActivityService();
    }
    return AgentActivityService.instance;
  }

  public startHeartbeatMonitoring() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      await this.checkInactiveAgents();
      await this.checkUnresponsiveConversations();
      await this.checkInactiveConversations();
    }, this.HEARTBEAT_CHECK_INTERVAL);

    console.log("✅ Sistema de monitoramento de atividade dos agentes iniciado");
  }

  public stopHeartbeatMonitoring() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // Atualizar heartbeat do agente
  public async updateAgentHeartbeat(agentId: string) {
    try {
      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
          lastActivity: new Date(),
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error("Erro ao atualizar heartbeat do agente:", error);
    }
  }

  // Verificar agentes inativos e deslogá-los
  private async checkInactiveAgents() {
    const inactiveThreshold = new Date(Date.now() - this.INACTIVITY_TIMEOUT);

    try {
      // Buscar agentes que estão online mas inativos por mais de 10 minutos
      const inactiveAgents = await db
        .select({
          agentId: agents.id,
          userId: agents.userId,
          name: agents.name,
          userRole: users.role,
        })
        .from(agents)
        .leftJoin(users, eq(agents.userId, users.id))
        .where(
          and(
            eq(agents.status, "online"),
            lt(agents.lastHeartbeat, inactiveThreshold),
            // Não deslogar administradores
            sql`${users.role} != 'admin'`
          )
        );

      for (const agent of inactiveAgents) {
        await this.logoutInactiveAgent(agent.agentId, agent.userId || "", agent.name);
      }
    } catch (error) {
      console.error("Erro ao verificar agentes inativos:", error);
    }
  }

  // Deslogar agente inativo
  private async logoutInactiveAgent(agentId: string, userId: string, agentName: string) {
    try {
      // Atualizar status do agente para offline
      await db
        .update(agents)
        .set({
          status: "offline",
        })
        .where(eq(agents.id, agentId));

      // Redistribuir conversas ativas do agente
      await this.redistributeAgentConversations(agentId);

      // Log da ação
      await db.insert(auditLog).values({
        userId: userId,
        action: "auto_logout_inactivity",
        entityType: "agent",
        entityId: agentId,
        details: {
          reason: "inactivity_timeout",
          agentName: agentName,
        },
      });

      console.log(`🔄 Agente ${agentName} deslogado por inatividade`);
    } catch (error) {
      console.error("Erro ao deslogar agente inativo:", error);
    }
  }

  // Verificar conversas sem resposta há mais de 5 minutos
  private async checkUnresponsiveConversations() {
    const responseThreshold = new Date(Date.now() - this.RESPONSE_TIMEOUT);

    try {
      const unresponsiveConversations = await db
        .select({
          conversationId: conversations.id,
          agentId: conversations.agentId,
          customerId: conversations.customerId,
          lastAgentResponseTime: conversations.lastAgentResponseTime,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.status, "in-progress"),
            lt(conversations.lastAgentResponseTime, responseThreshold)
          )
        );

      for (const conversation of unresponsiveConversations) {
        if (conversation.agentId) {
          await this.reassignConversation(conversation.conversationId, conversation.agentId);
        }
      }
    } catch (error) {
      console.error("Erro ao verificar conversas sem resposta:", error);
    }
  }

  // Verificar conversas inativas há mais de 1 hora e finalizá-las automaticamente
  private async checkInactiveConversations() {
    const inactivityThreshold = new Date(Date.now() - this.CONVERSATION_INACTIVITY_TIMEOUT);

    try {
      const inactiveConversations = await db
        .select({
          conversationId: conversations.id,
          agentId: conversations.agentId,
          customerId: conversations.customerId,
          lastMessageTime: conversations.lastMessageTime,
          status: conversations.status,
        })
        .from(conversations)
        .where(
          and(
            sql`${conversations.status} IN ('assigned', 'in-progress')`,
            lt(conversations.lastMessageTime, inactivityThreshold)
          )
        );

      for (const conversation of inactiveConversations) {
        if (conversation.agentId) {
          await this.autoFinishInactiveConversation(
            conversation.conversationId, 
            conversation.agentId
          );
        }
      }
    } catch (error) {
      console.error("Erro ao verificar conversas inativas:", error);
    }
  }

  // Finalizar automaticamente uma conversa inativa
  private async autoFinishInactiveConversation(conversationId: string, agentId: string) {
    try {
      // Adicionar mensagem do sistema informando sobre a finalização automática
      await db.insert(messages).values({
        conversationId: conversationId,
        senderId: "system",
        senderType: "system",
        content: "Esta conversa foi finalizada automaticamente devido à inatividade por mais de 1 hora. Se precisar de atendimento, por favor inicie uma nova conversa.",
        messageType: "text",
        isRead: false,
      });

      // Usar o método existente de finalização
      const metrics = await this.finishConversation(conversationId, agentId);

      // Criar mensagem de sistema informando sobre a finalização automática
      await db.insert(auditLog).values({
        action: "conversation_auto_finished",
        entityType: "conversation",
        entityId: conversationId,
        details: {
          agentId,
          reason: "inactivity_timeout",
          timeoutDuration: "1 hour",
          metrics,
          finishedAt: new Date(),
        },
      });

      console.log(`⏰ Conversa ${conversationId} finalizada automaticamente por inatividade`);
      return metrics;
    } catch (error) {
      console.error("Erro ao finalizar conversa inativa automaticamente:", error);
    }
  }

  // Redistribuir conversas de um agente
  public async redistributeAgentConversations(agentId: string) {
    try {
      // Buscar conversas ativas do agente
      const activeConversations = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, agentId),
            sql`${conversations.status} IN ('assigned', 'in-progress')`
          )
        );

      for (const conversation of activeConversations) {
        await this.reassignConversation(conversation.id, agentId);
      }

      // Resetar contadores do agente
      await db
        .update(agents)
        .set({
          activeConversations: 0,
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error("Erro ao redistribuir conversas do agente:", error);
    }
  }

  // Reatribuir uma conversa específica
  private async reassignConversation(conversationId: string, oldAgentId: string) {
    try {
      // Buscar agente disponível
      const availableAgent = await this.findAvailableAgent();

      if (availableAgent) {
        // Atribuir a novo agente
        await db
          .update(conversations)
          .set({
            agentId: availableAgent.id,
            status: "assigned",
            assignedAt: new Date(),
            lastAgentResponseTime: new Date(),
          })
          .where(eq(conversations.id, conversationId));

        // Atualizar contadores
        await db
          .update(agents)
          .set({
            activeConversations: sql`${agents.activeConversations} + 1`,
          })
          .where(eq(agents.id, availableAgent.id));

        console.log(`🔄 Conversa ${conversationId} reatribuída para ${availableAgent.name}`);
      } else {
        // Encaminhar para ChatGPT
        const chatGPTAgent = await this.getChatGPTAgent();
        if (chatGPTAgent) {
          await db
            .update(conversations)
            .set({
              agentId: chatGPTAgent.id,
              status: "assigned",
              assignedAt: new Date(),
              lastAgentResponseTime: new Date(),
            })
            .where(eq(conversations.id, conversationId));

          console.log(`🤖 Conversa ${conversationId} encaminhada para ChatGPT`);
        }
      }

      // Log da reatribuição
      await db.insert(auditLog).values({
        action: "conversation_reassigned",
        entityType: "conversation",
        entityId: conversationId,
        details: {
          oldAgentId,
          newAgentId: availableAgent?.id || "chatgpt",
          reason: "response_timeout",
        },
      });
    } catch (error) {
      console.error("Erro ao reatribuir conversa:", error);
    }
  }

  // Buscar agente disponível
  private async findAvailableAgent() {
    try {
      const availableAgents = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.status, "online"),
            eq(agents.type, "human"),
            sql`${agents.activeConversations} < 5` // máximo de 5 conversas simultâneas
          )
        )
        .orderBy(agents.activeConversations)
        .limit(1);

      return availableAgents[0] || null;
    } catch (error) {
      console.error("Erro ao buscar agente disponível:", error);
      return null;
    }
  }

  // Buscar agente ChatGPT
  private async getChatGPTAgent() {
    try {
      const chatGPTAgents = await db
        .select()
        .from(agents)
        .where(eq(agents.type, "bot"))
        .limit(1);

      return chatGPTAgents[0] || null;
    } catch (error) {
      console.error("Erro ao buscar agente ChatGPT:", error);
      return null;
    }
  }

  // Definir agente como online
  public async setAgentOnline(agentId: string) {
    try {
      await db
        .update(agents)
        .set({
          status: "online",
          lastActivity: new Date(),
          lastHeartbeat: new Date(),
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error("Erro ao definir agente como online:", error);
    }
  }

  // Definir agente como offline
  public async setAgentOffline(agentId: string) {
    try {
      await db
        .update(agents)
        .set({
          status: "offline",
        })
        .where(eq(agents.id, agentId));

      // Redistribuir conversas ativas
      await this.redistributeAgentConversations(agentId);
    } catch (error) {
      console.error("Erro ao definir agente como offline:", error);
    }
  }

  // Calcular métricas de tempo para uma conversa
  public async calculateConversationMetrics(conversationId: string) {
    try {
      const conversation = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (conversation[0]) {
        const conv = conversation[0];
        const now = new Date();
        
        let waitingTime = 0;
        let responseTime = 0;

        if (conv.assignedAt && conv.createdAt) {
          waitingTime = Math.floor((conv.assignedAt.getTime() - conv.createdAt.getTime()) / 1000);
        }

        if (conv.resolvedAt && conv.assignedAt) {
          responseTime = Math.floor((conv.resolvedAt.getTime() - conv.assignedAt.getTime()) / 1000);
        } else if (conv.assignedAt) {
          responseTime = Math.floor((now.getTime() - conv.assignedAt.getTime()) / 1000);
        }

        // Atualizar métricas na conversa
        await db
          .update(conversations)
          .set({
            waitingTime,
            responseTime,
          })
          .where(eq(conversations.id, conversationId));

        return { waitingTime, responseTime };
      }
    } catch (error) {
      console.error("Erro ao calcular métricas da conversa:", error);
    }
    
    return null;
  }

  // Finalizar atendimento
  public async finishConversation(conversationId: string, agentId: string) {
    try {
      const now = new Date();
      
      // Calcular métricas finais
      const metrics = await this.calculateConversationMetrics(conversationId);
      
      // Atualizar status da conversa
      await db
        .update(conversations)
        .set({
          status: "resolved",
          resolvedAt: now,
        })
        .where(eq(conversations.id, conversationId));

      // Atualizar contador do agente
      await db
        .update(agents)
        .set({
          activeConversations: sql`${agents.activeConversations} - 1`,
          totalConversations: sql`${agents.totalConversations} + 1`,
        })
        .where(eq(agents.id, agentId));

      // Log da finalização
      await db.insert(auditLog).values({
        action: "conversation_finished",
        entityType: "conversation",
        entityId: conversationId,
        details: {
          agentId,
          metrics,
          finishedAt: now,
        },
      });

      console.log(`✅ Atendimento ${conversationId} finalizado com sucesso`);
      return metrics;
    } catch (error) {
      console.error("Erro ao finalizar atendimento:", error);
      throw error;
    }
  }
}

// Exportar instância singleton
export const agentActivityService = AgentActivityService.getInstance();