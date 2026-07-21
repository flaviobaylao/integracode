import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { db } from "./db";
import { sql, and, eq, inArray, isNull, desc } from "drizzle-orm";
import { whatsappService } from "./whatsapp-service";
import { telegramService } from "./telegram-service";
import { evolutionAPIService } from "./evolution-api-service";
import { evolutionPollingService } from "./evolution-polling-service";
import { getAgentColor } from "./chat-distribution-service";
import { uploadMediaFromBase64 } from "./whatsapp-media-storage";
import { objectStorageClient } from "./replit_integrations/object_storage/objectStorage";
import { nanoid } from "nanoid";
import {
  insertChatAgentSchema,
  insertChatConversationSchema,
  insertChatMessageSchema,
  insertChatProductSchema,
  insertChatQuickMessageSchema,
  insertChatOrderSchema,
  insertChatDeliverySchema,
  insertWhatsappConversationAnalysisSchema,
  phoneNumberMappings,
  chatMessages,
  chatConversations,
  chatCustomers,
  chatAiLogs,
  virtualAttendanceStats,
  users,
  chatAssignmentHistory,
} from "@shared/schema";
import { z } from "zod";
import QRCode from "qrcode";
import { nowBrazil } from './brazilTimezone';
import multer from "multer";
import path from "path";
import fs from "fs";

// 🔧 FUNÇÃO DE NORMALIZAÇÃO DE TELEFONE - ÚNICA FONTE DE VERDADE
function normalizePhoneNumber(phone: string): string {
  if (!phone) {
    console.warn(`⚠️  [NORMALIZE] Telefone vazio recebido`);
    return '';
  }
  
  // Remove tudo que não é dígito e o sufixo @lid/@s.whatsapp.net se vier na string
  let digitsOnly = phone.split('@')[0].replace(/\D/g, '');
  
  // IDs internos da Evolution API (padrão 5550...) ou números problemáticos conhecidos
  const mappings: { [key: string]: string } = {
    '5550575396912': '5562996353860',
    '5504884295924': '5562995782812',
    '173250575396912': '5562996353860',
    '50575396912': '5562996353860',
    '04884295924': '5562995782812',
    '5550575396012': '5562996353860',
    '5504884295924@s.whatsapp.net': '5562995782812'
  };

  if (mappings[digitsOnly]) {
    console.log(`🎯 [NORMALIZE] Mapeando ID conhecido ${digitsOnly} para ${mappings[digitsOnly]}`);
    return mappings[digitsOnly];
  }

  // Se começar com 55 e tiver 12 ou 13 dígitos, remove o 55 para normalizar o resto
  if (digitsOnly.startsWith('55') && (digitsOnly.length === 12 || digitsOnly.length === 13)) {
    const candidate = digitsOnly.slice(2);
    if (mappings[candidate]) {
      console.log(`🎯 [NORMALIZE] Mapeando ID conhecido (sem 55) ${candidate} para ${mappings[candidate]}`);
      return mappings[candidate];
    }
    digitsOnly = candidate;
  }
  
  // No Brasil, celulares têm 11 dígitos (DDD + 9 + número) ou 10 dígitos (DDD + número)
  if (digitsOnly.length === 10) {
    const ddd = digitsOnly.slice(0, 2);
    const rest = digitsOnly.slice(2);
    digitsOnly = `${ddd}9${rest}`;
    console.log(`📞 [NORMALIZE] Adicionado 9: ${digitsOnly}`);
  } else if (digitsOnly.length > 11) {
    // Se ainda for maior que 11, pega os últimos 11 (removendo prefixo 55 se houver)
    digitsOnly = digitsOnly.slice(-11);
    
    // Se após pegar os últimos 11, o número não tiver o 9 (ex: 628744073357 -> 28744073357)
    // Precisamos garantir que o 9 esteja lá se for celular brasileiro
    if (digitsOnly.length === 10) {
      const ddd = digitsOnly.slice(0, 2);
      const rest = digitsOnly.slice(2);
      digitsOnly = `${ddd}9${rest}`;
    }
  }
  
  // Garante o prefixo 55
  const normalized = `55${digitsOnly}`;
  console.log(`📞 [NORMALIZE] Input: ${phone} -> Output: ${normalized}`);
  return normalized;
}

// 🔧 FUNÇÃO PARA ENCONTRAR CONVERSA COM NÚMERO "SIMILAR" (COM/SEM 9)
function getPhoneVariants(normalizedPhone: string): string[] {
  // Retorna variações do telefone (com/sem o 9 obrigatório)
  const variants = [normalizedPhone];
  
  // Se tem 13 dígitos (55 + 11): tentar remover o 9 após o 55XX
  if (normalizedPhone.length === 13 && normalizedPhone.startsWith('55')) {
    const ddd = normalizedPhone.slice(2, 4);
    const rest = normalizedPhone.slice(5);
    const withoutNine = `55${ddd}${rest}`;
    if (!variants.includes(withoutNine)) {
      variants.push(withoutNine);
    }
  }
  
  // Se tem 12 dígitos (55 + 10): tentar adicionar o 9 após o 55XX
  if (normalizedPhone.length === 12 && normalizedPhone.startsWith('55')) {
    const ddd = normalizedPhone.slice(2, 4);
    const rest = normalizedPhone.slice(4);
    const withNine = `55${ddd}9${rest}`;
    if (!variants.includes(withNine)) {
      variants.push(withNine);
    }
  }
  
  console.log(`📞 [VARIANTS] ${normalizedPhone} -> Variantes: [${variants.join(', ')}]`);
  return variants;
}

// 🔧 FUNÇÃO PARA PROCESSAR MENSAGEM RECEBIDA (WEBHOOK OU POLLING)
export async function processIncomingMessage(data: any, originalPhone: string): Promise<boolean> {
  try {
    const rawRemoteJid = data.key?.remoteJid;
    if (!rawRemoteJid || rawRemoteJid.includes('@g.us')) {
      return false; // Ignorar grupos
    }

    const phoneNumber = evolutionAPIService.extractPhoneNumber(rawRemoteJid);
    const cleanPhone = phoneNumber.replace(/\D/g, '');

    // Busca mapeamento de telefone
    let targetPhone = phoneNumber;
    const phoneMapping = await storage.getPhoneMappingBySource(cleanPhone);
    
    if (phoneMapping) {
      targetPhone = phoneMapping.canonicalPhone;
      console.log(`🔄 [PROCESS] Remapeando: ${phoneNumber} -> ${targetPhone}`);
    }

    const normalizedPhone = normalizePhoneNumber(targetPhone);
    const isFromMe = data.key?.fromMe === true;
    const messageText = evolutionAPIService.extractMessageText(data.message || {}) || '';
    const rawMessageId = data.key?.id;
    const messageTimestamp = data.messageTimestamp || Date.now();
    
    // CRITICAL: Generate fallback ID when Evolution API doesn't provide one
    // This prevents message loss when webhook events arrive without valid key.id
    const messageId = rawMessageId || `fallback-${normalizedPhone}-${messageTimestamp}-${Date.now()}`;
    
    if (!rawMessageId) {
      console.warn(`⚠️ [PROCESS] Mensagem sem key.id recebida de ${normalizedPhone}, usando ID fallback: ${messageId}`);
    }

    // Busca contato na agenda
    const phonebookContact = await storage.getPhonebookContactByPhone(normalizedPhone);
    const identifiedName = phonebookContact?.name || data.pushName || `Cliente ${normalizedPhone}`;

    // 1. Garante que o cliente e conversa existam
    let conversation = await storage.getChatConversationByPhone(normalizedPhone);
    let customer = await storage.getChatCustomerByPhone(normalizedPhone);

    if (!customer) {
      customer = await storage.createChatCustomer({
        phone: normalizedPhone,
        name: identifiedName
      });
    } else if (phonebookContact && customer.name !== identifiedName) {
      await storage.updateChatCustomer(customer.id, { name: identifiedName });
    }

    if (!conversation) {
      conversation = await storage.createChatConversation({
        customerId: customer.id,
        customerName: identifiedName,
        customerPhone: normalizedPhone,
        status: 'new',
        priority: 'normal'
      });
    } else if (phonebookContact && conversation.customerName !== identifiedName) {
      await storage.updateChatConversation(conversation.id, { customerName: identifiedName });
    }

    // 2. Verifica duplicata (pelo externalId no banco)
    // Only check for duplicates if we have a valid original messageId (not a fallback)
    if (rawMessageId) {
      const isDuplicate = await storage.getChatMessageByExternalId(messageId);
      
      if (isDuplicate) {
        console.log(`🔄 [DEDUP] Mensagem duplicada ignorada: ${messageId} de ${normalizedPhone}, conteúdo: ${messageText?.substring(0, 50)}...`);
        return false; // Já existe
      }
    }

    // 3. Extrair informações de mídia usando extractMediaInfo
    const mediaInfo = evolutionAPIService.extractMediaInfo(data.message || data);
    
    // 4. Garantir fallback para 'text' se messageType for undefined
    const finalMessageType = mediaInfo.messageType || 'text';
    const finalContent = messageText || (finalMessageType !== 'text' ? `[${finalMessageType}]` : '[Mensagem]');
    // 🔁 ANTI-ECO: o Umbler reenvia ao webhook as mensagens ENVIADAS por nós — às vezes 2x
    // (uma como 'member' → 'system' e outra sem Source → entraria como 'customer'), cada
    // uma com externalId diferente, então o dedup por externalId não pega. Se já existe uma
    // saída nossa (agent/system) com o MESMO conteúdo nos últimos 3 min nesta conversa,
    // trata como eco e ignora (não duplica no chat). [fix duplicação ChatCenter]
    if (finalMessageType === 'text' && messageText && messageText.trim()) {
      try {
        const recentOut = await db
          .select({ content: chatMessages.content, createdAt: chatMessages.createdAt })
          .from(chatMessages)
          .where(and(
            eq(chatMessages.conversationId, conversation.id),
            inArray(chatMessages.senderType, ['agent', 'system'])
          ))
          .orderBy(desc(chatMessages.createdAt))
          .limit(15);
        const incNorm = messageText.trim();
        const nowMs = Date.now();
        const isEcho = recentOut.some((m: any) =>
          String(m.content || '').trim() === incNorm &&
          (nowMs - new Date(m.createdAt as any).getTime()) < 3 * 60 * 1000
        );
        if (isEcho) {
          console.log(`🔁 [ANTI-ECO] Eco de mensagem enviada ignorado: ${normalizedPhone} | ${incNorm.substring(0, 40)}`);
          return false;
        }
      } catch (echoErr: any) {
        console.warn(`⚠️ [ANTI-ECO] Falha na checagem de eco (seguindo normal): ${echoErr?.message || echoErr}`);
      }
    }
    
    // 5. Se for mídia, fazer download e salvar no object storage
    let finalMediaUrl = mediaInfo.mediaUrl;
    
    if (finalMessageType !== 'text' && messageId) {
      try {
        console.log(`📥 [MEDIA-DOWNLOAD] Baixando mídia para mensagem ${messageId}...`);
        
        // Tentar baixar a mídia via Evolution API (usando key completo)
        const instanceName = process.env.EVOLUTION_INSTANCE_NAME;
        if (instanceName) {
          // Passar o key completo para Evolution API v2.3.6+
          const messageKey = {
            id: rawMessageId, // Use original ID for API calls, not fallback
            remoteJid: data.key?.remoteJid,
            fromMe: data.key?.fromMe
          };
          const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(instanceName, messageKey, messageTimestamp);
          
          if (mediaResult.success && mediaResult.base64) {
            // Upload para object storage
            const uploadResult = await uploadMediaFromBase64(
              mediaResult.base64,
              mediaResult.mimetype || mediaInfo.mediaType || 'application/octet-stream',
              mediaInfo.mediaFilename
            );
            
            if (uploadResult.success && uploadResult.objectPath) {
              finalMediaUrl = `/objects/${uploadResult.objectPath}`;
              console.log(`✅ [MEDIA-DOWNLOAD] Mídia salva: ${finalMediaUrl}`);
            } else {
              console.warn(`⚠️ [MEDIA-DOWNLOAD] Falha no upload: ${uploadResult.error}`);
            }
          } else {
            console.warn(`⚠️ [MEDIA-DOWNLOAD] Falha ao baixar mídia: ${mediaResult.error}`);
          }
        }
      } catch (mediaErr: any) {
        console.warn(`⚠️ [MEDIA-DOWNLOAD] Erro ao processar mídia: ${mediaErr.message}`);
        // Continua com a URL original (transiente) como fallback
      }
    }
    
    // 6. Salva a mensagem com tipo correto (schema: messageType, mediaUrl, metadata)
    await storage.createChatMessage({
      conversationId: conversation.id,
      senderId: isFromMe ? 'system' : customer.id,
      senderType: isFromMe ? 'system' : 'customer',
      content: finalContent,
      messageType: finalMessageType,
      mediaUrl: finalMediaUrl,
      metadata: mediaInfo.mediaType || mediaInfo.mediaFilename ? { 
        mediaType: mediaInfo.mediaType, 
        mediaFilename: mediaInfo.mediaFilename,
        mediaSize: mediaInfo.mediaSize 
      } : undefined,
      externalId: messageId
    });

    // 4. Atualiza a conversa (lastMessage e status são tratados pela camada de storage)
    await storage.updateChatConversation(conversation.id, {
      status: isFromMe ? conversation.status : 'new'
    });

// Runtime de Agentes de IA — responde pelo 1841 se a janela 24h estiver aberta, senão HONEST2
    if (!isFromMe && finalContent && finalContent.trim()) {
      const replyVia = async (toPhone: string, text: string) => {
        try {
          const c: any = await db.execute(sql`SELECT last_inbound_channel, window_open_until FROM chat_conversations WHERE id = ${conversation.id} LIMIT 1`);
          const row = c.rows?.[0];
          if (row && row.last_inbound_channel === 'oficial_1841' && row.window_open_until && new Date(row.window_open_until) > new Date()) {
            const { sendOfficialText } = await import('./official-dispatch');
            const r = await sendOfficialText(toPhone, text);
            if (r && r.success) return r;
          }
        } catch {}
        return sendUmblerTalkText(toPhone, text);
      };
      import('./agent-runtime').then(({ maybeRunAgent }) => maybeRunAgent({ phone: normalizedPhone, conversationId: conversation.id, incomingText: finalContent, sendText: replyVia })).catch(() => {});
    }

    console.log(`✅ [PROCESS] Mensagem salva: ${normalizedPhone} | FromMe: ${isFromMe} | ${messageText.substring(0, 30)}...`);
    return true;

  } catch (error: any) {
    console.error('❌ [PROCESS] Erro ao processar mensagem:', error.message);
    return false;
  }
}

// 🔧 FUNÇÃO PARA PROCESSAR MENSAGEM DE GRUPO WHATSAPP
export async function processGroupMessage(data: any): Promise<boolean> {
  try {
    const rawRemoteJid = data.key?.remoteJid;
    if (!rawRemoteJid || !rawRemoteJid.includes('@g.us')) {
      return false;
    }

    const groupId = rawRemoteJid.split('@')[0];
    const isFromMe = data.key?.fromMe === true;
    const messageText = evolutionAPIService.extractMessageText(data.message || {}) || '';
    const rawMessageId = data.key?.id;
    const messageTimestamp = data.messageTimestamp || Date.now();
    
    const messageId = rawMessageId || `group-${groupId}-${messageTimestamp}-${Date.now()}`;
    
    const participant = data.key?.participant || data.participant || '';
    const participantPhone = participant ? participant.split('@')[0].replace(/\D/g, '') : '';
    const senderName = data.pushName || (participantPhone ? `Membro ${participantPhone}` : 'Membro do Grupo');
    
    const groupName = data.groupMetadata?.subject || data.verifiedBizName || `Grupo ${groupId}`;

    console.log(`👥 [GROUP] Processando mensagem de grupo: ${groupName} (${groupId}) | FromMe: ${isFromMe} | Sender: ${senderName}`);

    let conversation = await storage.getChatConversationByPhone(groupId);
    
    if (!conversation) {
      let customer = await storage.getChatCustomerByPhone(groupId);
      
      if (!customer) {
        customer = await storage.createChatCustomer({
          name: `GRUPO - ${groupName}`,
          phone: groupId,
          email: null,
          notes: `Grupo WhatsApp: ${groupName}`,
          tags: 'grupo,whatsapp',
          avatar: null
        });
        console.log(`👥 [GROUP] Novo grupo criado: ${customer.name}`);
      }

      conversation = await storage.createChatConversation({
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: groupId,
        status: 'active',
        agentId: null,
        channel: 'whatsapp',
        lastMessageAt: nowBrazil(),
        unreadCount: isFromMe ? 0 : 1
      });
      console.log(`👥 [GROUP] Nova conversa de grupo criada: ${conversation.id}`);
    } else {
      await storage.updateChatConversation(conversation.id, {
        lastMessageAt: nowBrazil(),
        unreadCount: isFromMe ? 0 : (conversation.unreadCount || 0) + 1
      });
    }

    const existingMessage = await storage.getChatMessageByExternalId(messageId);
    if (existingMessage) {
      console.log(`⚠️ [GROUP] Mensagem duplicada ignorada: ${messageId}`);
      return true;
    }

    let mediaUrl: string | null = null;
    let mediaType: string | null = null;
    const messageTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    
    for (const type of messageTypes) {
      if (data.message?.[type]) {
        mediaType = type.replace('Message', '');
        if (data.message[type].url) {
          mediaUrl = data.message[type].url;
        }
        break;
      }
    }

    await storage.createChatMessage({
      conversationId: conversation.id,
      senderId: isFromMe ? 'system' : (participantPhone || groupId),
      senderType: isFromMe ? 'agent' : 'customer',
      content: messageText || (mediaType ? `[${mediaType.toUpperCase()}]` : '[Mensagem sem texto]'),
      messageType: mediaType || 'text',
      mediaUrl: mediaUrl,
      metadata: {
        whatsappMessageId: messageId,
        participant: participantPhone,
        participantName: senderName,
        groupId: groupId,
        groupName: groupName,
        fromMe: isFromMe,
        timestamp: messageTimestamp,
        isGroup: true
      },
      externalMessageId: messageId
    });

    console.log(`✅ [GROUP] Mensagem de grupo salva: ${groupName} | FromMe: ${isFromMe} | ${messageText.substring(0, 30)}...`);
    return true;

  } catch (error: any) {
    console.error('❌ [GROUP] Erro ao processar mensagem de grupo:', error.message);
    return false;
  }
}

// 🔧 FUNÇÃO PARA CONSOLIDAR CONVERSAS DUPLICADAS POR TELEFONE
async function consolidateDuplicateConversations(storage: any): Promise<{ consolidated: number; merged: number }> {
  const conversations = await storage.getChatConversations();
  const phoneGroups: { [key: string]: any[] } = {};
  
  // Agrupar por telefone
  for (const conv of conversations) {
    const phone = conv.customerPhone;
    if (!phoneGroups[phone]) {
      phoneGroups[phone] = [];
    }
    phoneGroups[phone].push(conv);
  }
  
  let consolidatedCount = 0;
  let mergedMessagesCount = 0;
  
  // Processar grupos com múltiplas conversas
  for (const [phone, convs] of Object.entries(phoneGroups)) {
    if (convs.length > 1) {
      console.log(`🔀 [CONSOLIDATE] Telefone ${phone} tem ${convs.length} conversas. Consolidando...`);
      consolidatedCount++;
      
      // Ordenar por data (mais recente primeira)
      convs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      
      const mainConv = convs[0]; // Conversa principal (mais recente)
      const duplicateConvs = convs.slice(1); // Conversas para mesclar
      
      // Mover mensagens das duplicatas para a principal
      for (const dupConv of duplicateConvs) {
        const messages = await storage.getChatMessages(dupConv.id);
        for (const msg of messages) {
          await storage.createChatMessage({
            conversationId: mainConv.id,
            senderId: msg.senderId,
            senderType: msg.senderType,
            content: msg.content,
            messageType: msg.messageType,
            mediaUrl: msg.mediaUrl,
            externalId: msg.externalId
          });
          mergedMessagesCount++;
        }
        
        // Deletar conversa duplicada
        await storage.deleteChatConversation(dupConv.id);
        console.log(`✅ [CONSOLIDATE] Conversa ${dupConv.id} mesclada em ${mainConv.id} (${messages.length} mensagens)`);
      }
    }
  }
  
  return { consolidated: consolidatedCount, merged: mergedMessagesCount };
}

// Helper function to upload chat media to Object Storage
async function uploadChatMediaToStorage(buffer: Buffer, mimetype: string, originalFilename: string): Promise<string | null> {
  // Fallback: guarda a midia no banco e serve via /api/chat-media/:id (funciona no Railway, sem Object Storage do Replit)
  const saveToDb = async (): Promise<string | null> => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS chat_media (id text PRIMARY KEY, mimetype text, filename text, data text, created_at timestamptz DEFAULT now())`);
      const id = nanoid(16);
      const b64 = buffer.toString('base64');
      await db.execute(sql`INSERT INTO chat_media (id, mimetype, filename, data) VALUES (${id}, ${mimetype}, ${originalFilename}, ${b64})`);
      const url = `/api/chat-media/${id}`;
      console.log(`✅ [CHAT-UPLOAD] Salvo no banco (fallback): ${url} (${Math.round(buffer.length / 1024)}KB)`);
      return url;
    } catch (e: any) {
      console.error('❌ [CHAT-UPLOAD] Falha no fallback DB:', e?.message || e);
      return null;
    }
  };
  try {
    console.log(`📤 [CHAT-UPLOAD] Iniciando upload: ${originalFilename} (${mimetype}, ${Math.round(buffer.length / 1024)}KB)`);
    const publicPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS;
    const privateDir = process.env.PRIVATE_OBJECT_DIR;
    const baseDirEnv = publicPaths || privateDir;
    if (!baseDirEnv) {
      console.log('⚠️ [CHAT-UPLOAD] Object Storage nao configurado — usando fallback no banco');
      return await saveToDb();
    }
    const baseDir = baseDirEnv.split(',')[0].trim();
    const pathNorm = baseDir.startsWith('/') ? baseDir : `/${baseDir}`;
    const parts = pathNorm.split('/').filter(p => p);
    const bucketName = parts[0];
    const basePath = parts.slice(1).join('/');
    const fileId = nanoid(12);
    const ext = path.extname(originalFilename).toLowerCase() || '.bin';
    const objectName = `${basePath}/chat-media/${fileId}${ext}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    await file.save(buffer, { contentType: mimetype, resumable: false });
    const serverUrl = `/api/storage-image/${bucketName}/${objectName}`;
    console.log(`✅ [CHAT-UPLOAD] Arquivo salvo: ${serverUrl} (${Math.round(buffer.length / 1024)}KB)`);
    return serverUrl;
  } catch (error: any) {
    console.error('❌ [CHAT-UPLOAD] Erro no Object Storage, tentando fallback no banco:', error.message);
    return await saveToDb();
  }
}

// -- Umbler uTalk (api.utalk.chat): envio de texto via WhatsApp --
async function sendUmblerText(toPhone: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const token = process.env.UMBLER_API_KEY;
  if (!token) return { success: false, error: 'UMBLER_API_KEY ausente' };
  let digits = String(toPhone || '').replace(/\\D/g, '');
  if (digits && !digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) digits = '55' + digits;
  if (!digits) return { success: false, error: 'Telefone do cliente vazio' };
  const to = `${digits}@c.us`;
  try {
    const body = new URLSearchParams({ token, cmd: 'chat', to, msg: text }).toString();
    const resp = await fetch('https://api.utalk.chat/send/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const raw = await resp.text();
    console.log(`[UMBLER] to=${to} httpStatus=${resp.status} resp=${raw.slice(0, 200)}`);
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${raw.slice(0, 200)}` };
    let waStatus = '';
    try { waStatus = String(JSON.parse(raw).status || '').toLowerCase(); } catch {}
    if (waStatus === 'offline') return { success: false, error: 'uTalk: sessao WhatsApp offline (token invalido ou WhatsApp desconectado no painel Umbler)' };
    return { success: true, messageId: waStatus || undefined };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// -- Umbler Talk (app-utalk.umbler.com): API oficial com Bearer token --
const UMBLER_TALK_BASE = (process.env.UMBLER_TALK_BASE || 'https://app-utalk.umbler.com/api').replace(/\/+$/, '');
let _umblerTalkCfg: { orgId: string; fromPhone: string; at: number } | null = null;

async function umblerTalkFetch(path: string, init?: any) {
  const token = process.env.UMBLER_TALK_TOKEN;
  const headers = Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, (init && init.headers) || {});
  return fetch(UMBLER_TALK_BASE + path, Object.assign({}, init, { headers, signal: AbortSignal.timeout(30000) }));
}

async function resolveUmblerTalkConfig(): Promise<{ orgId: string; fromPhone: string } | { error: string }> {
  const token = process.env.UMBLER_TALK_TOKEN;
  if (!token) return { error: 'UMBLER_TALK_TOKEN ausente' };
  if (_umblerTalkCfg && (Date.now() - _umblerTalkCfg.at) < 600000) {
    return { orgId: _umblerTalkCfg.orgId, fromPhone: _umblerTalkCfg.fromPhone };
  }
  let orgId = process.env.UMBLER_TALK_ORG_ID || '';
  const envFromPhone = String(process.env.UMBLER_TALK_FROM_PHONE || '').replace(/\D/g, '');
  let fromPhone = '';
  try {
    if (!orgId) {
      const meResp = await umblerTalkFetch('/v1/members/me/');
      if (!meResp.ok) return { error: `members/me HTTP ${meResp.status}: ${(await meResp.text()).slice(0, 160)}` };
      const me: any = await meResp.json();
      const orgs = me && me.organizations;
      const first = Array.isArray(orgs) ? orgs[0] : (orgs && (orgs.items || [])[0]);
      orgId = (first && (first.id || first.organizationId || (first.organization && first.organization.id))) || '';
      if (!orgId) return { error: 'Nao foi possivel resolver organizationId via members/me' };
    }
    // Sempre buscar canais para GARANTIR que o remetente esteja CONECTADO (Live).
    // Um numero fixado por env (UMBLER_TALK_FROM_PHONE) so e respeitado se estiver Live;
    // caso contrario, cai para um canal Live (preferindo HONEST5).
    {
      const chResp = await umblerTalkFetch('/v1/channels/?organizationId=' + encodeURIComponent(orgId));
      if (!chResp.ok) return { error: `channels HTTP ${chResp.status}: ${(await chResp.text()).slice(0, 160)}` };
      const chans: any = await chResp.json();
      const list = Array.isArray(chans) ? chans : (chans && (chans.items || chans.channels || []));
      const wa = (list || []).filter((c: any) => c && c.phoneNumber);
      const _isLive = (c: any) => /live|online|connected|conectad|ativo/i.test(String((c.status || c.connectionStatus || c.state || (c.isConnected ? 'connected' : '')) || ''));
      const _liveWa = wa.filter(_isLive);
      const _digits = (c: any) => String(c.phoneNumber).replace(/\D/g, '');
      const HONEST5 = '5562993227169';
      const envLive = envFromPhone && _liveWa.find((c: any) => _digits(c) === envFromPhone);
      if (envLive) {
        fromPhone = envFromPhone;
      } else {
        const _pool = _liveWa.length ? _liveWa : wa;
        const pick = _pool.find((c: any) => _digits(c) === HONEST5)
          || _pool.find((c: any) => /whats/i.test(String(c._t || c.channelType || c.name || '')))
          || _pool[0];
        fromPhone = pick ? _digits(pick) : '';
      }
      if (!fromPhone) return { error: 'Nenhum canal com phoneNumber encontrado' };
    }
    _umblerTalkCfg = { orgId, fromPhone, at: Date.now() };
    return { orgId, fromPhone };
  } catch (e: any) {
    return { error: 'resolve config: ' + (e && e.message ? e.message : String(e)) };
  }
}

export async function sendUmblerTalkText(toPhone: string, text: string, fromPhoneOverride?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const token = process.env.UMBLER_TALK_TOKEN;
  if (!token) return { success: false, error: 'UMBLER_TALK_TOKEN ausente' };
  let digits = String(toPhone || '').replace(/\D/g, '');
  if (digits && !digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) digits = '55' + digits;
  if (!digits) return { success: false, error: 'Telefone do cliente vazio' };
  const cfg = await resolveUmblerTalkConfig();
  if ('error' in cfg) return { success: false, error: 'Umbler Talk config: ' + cfg.error };
  try {
    const fromPhone = String(fromPhoneOverride || cfg.fromPhone || '').replace(/\D/g, '');
    const body = JSON.stringify({ organizationId: cfg.orgId, fromPhone, toPhone: digits, message: text });
    const resp = await umblerTalkFetch('/v1/messages/simplified/', { method: 'POST', body });
    const raw = await resp.text();
    console.log(`[UMBLER-TALK] to=${digits} from=${cfg.fromPhone} httpStatus=${resp.status} resp=${raw.slice(0, 200)}`);
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${raw.slice(0, 200)}` };
    let id: string | undefined;
    try { id = JSON.parse(raw).id; } catch {}
    return { success: true, messageId: id };
  } catch (e: any) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

async function sendUmblerTalkMedia(toPhone: string, fileUrl: string, caption?: string, fromPhoneOverride?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const token = process.env.UMBLER_TALK_TOKEN;
  if (!token) return { success: false, error: 'UMBLER_TALK_TOKEN ausente' };
  let digits = String(toPhone || '').replace(/\D/g, '');
  if (digits && !digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) digits = '55' + digits;
  if (!digits) return { success: false, error: 'Telefone do cliente vazio' };
  if (!fileUrl) return { success: false, error: 'URL de midia vazia' };
  const cfg = await resolveUmblerTalkConfig();
  if ('error' in cfg) return { success: false, error: 'Umbler Talk config: ' + cfg.error };
  try {
    const fromPhone = String(fromPhoneOverride || cfg.fromPhone || '').replace(/\D/g, '');
    const payload: any = { organizationId: cfg.orgId, fromPhone, toPhone: digits, file: fileUrl };
    if (caption) payload.message = caption;
    const resp = await umblerTalkFetch('/v1/messages/simplified/', { method: 'POST', body: JSON.stringify(payload) });
    const raw = await resp.text();
    console.log(`[UMBLER-TALK-MEDIA] to=${digits} file=${String(fileUrl).slice(0, 80)} httpStatus=${resp.status} resp=${raw.slice(0, 200)}`);
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${raw.slice(0, 200)}` };
    let id: string | undefined;
    try { id = JSON.parse(raw).id; } catch {}
    return { success: true, messageId: id };
  } catch (e: any) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

// -- Transcricao de audio recebido via OpenAI Whisper --
async function transcribeAudioSource(src: string, mimetype?: string): Promise<string | null> {
  try {
    if (!process.env.OPENAI_API_KEY || !src) return null;
    let buffer: Buffer; let mt = mimetype || 'audio/ogg';
    if (src.startsWith('data:')) {
      const m = src.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) return null;
      mt = m[1]; buffer = Buffer.from(m[2], 'base64');
    } else if (/^https?:\/\//.test(src)) {
      const r = await fetch(src, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return null;
      mt = r.headers.get('content-type') || mt;
      buffer = Buffer.from(await r.arrayBuffer());
    } else {
      return null;
    }
    if (!buffer || buffer.length === 0) return null;
    const ext = /ogg|opus/.test(mt) ? 'ogg' : /mpeg|mp3/.test(mt) ? 'mp3' : /wav/.test(mt) ? 'wav' : /m4a|mp4|aac/.test(mt) ? 'm4a' : 'ogg';
    const mod: any = await import('openai');
    const OpenAI = mod.default || mod.OpenAI || mod;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let fileArg: any;
    if (typeof mod.toFile === 'function') fileArg = await mod.toFile(buffer, `audio.${ext}`, { type: mt });
    else fileArg = new File([buffer], `audio.${ext}`, { type: mt });
    const resp = await client.audio.transcriptions.create({ file: fileArg, model: 'whisper-1', language: 'pt' });
    return (resp && resp.text) ? String(resp.text).trim() : null;
  } catch (e: any) {
    console.error('[TRANSCRIBE] erro:', e && e.message ? e.message : String(e));
    return null;
  }
}

// -- Umbler Talk: resolver arquivo de uma mensagem (audio/imagem) via API (upload async) --
async function fetchUmblerTalkMessageFile(messageId: string): Promise<{ url?: string; mime?: string; fileName?: string } | null> {
  try {
    if (!process.env.UMBLER_TALK_TOKEN || !messageId) return null;
    const cfg = await resolveUmblerTalkConfig();
    const orgId = ('error' in cfg) ? '' : cfg.orgId;
    if (!orgId) return null;
    const resp = await umblerTalkFetch('/v1/messages/' + encodeURIComponent(messageId) + '/?organizationId=' + encodeURIComponent(orgId));
    if (!resp.ok) return null;
    const m: any = await resp.json();
    const f = m && (m.File || m.file || (m.LastMessage && (m.LastMessage.File || m.LastMessage.file)));
    if (!f) return null;
    return { url: f.Url || f.url, mime: f.MimeType || f.mimetype || f.mimeType, fileName: f.FileName || f.fileName || f.Name };
  } catch {
    return null;
  }
}

export function registerChatRoutes(app: Express): void {
  // Configure multer for memory storage (will upload to Object Storage)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 16 * 1024 * 1024, // 16MB limit
    }
  });

  // ============================================================
  // FILE UPLOAD ENDPOINT (using Object Storage for persistence)
  // ============================================================

  app.post(
    "/api/chat/upload",
    authenticateUser,
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "Nenhum arquivo enviado" });
        }

        // Upload to Object Storage for persistent storage
        const fileUrl = await uploadChatMediaToStorage(
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname
        );

        if (!fileUrl) {
          return res.status(500).json({ error: "Erro ao salvar arquivo no storage" });
        }

        res.json({
          success: true,
          file: {
            url: fileUrl,
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          },
        });
      } catch (error) {
        console.error("[CHAT] Upload error:", error);
        res.status(500).json({ error: "Erro ao fazer upload do arquivo" });
      }
    }
  );


  // Serve midia guardada no banco (fallback de upload) — publico p/ o Umbler baixar a imagem
  app.get("/api/chat-media/:id", async (req: any, res: any) => {
    try {
      const { id } = req.params;
      const r: any = await db.execute(sql`SELECT mimetype, data FROM chat_media WHERE id = ${id} LIMIT 1`);
      const row = (r as any)?.rows?.[0];
      if (!row || !row.data) return res.status(404).send('not found');
      const buf = Buffer.from(String(row.data), 'base64');
      res.setHeader('Content-Type', row.mimetype || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      return res.send(buf);
    } catch (e: any) {
      return res.status(500).send('erro');
    }
  });

  // ============================================================
  // BUSCAR/CRIAR CONVERSA POR TELEFONE
  // ============================================================
  
  app.post("/api/chat/conversations/by-phone/:phone", authenticateUser, async (req, res) => {
    try {
      const { phone } = req.params;
      const cleanPhone = phone.replace(/\D/g, '');
      const normalizedPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
      
      console.log(`🔍 [BY-PHONE] Buscando conversa para: ${normalizedPhone}`);
      
      // Passo 1: Buscar conversa existente
      let conversation = await storage.getChatConversationByPhone(normalizedPhone);
      console.log(`🔍 [BY-PHONE] Conversa direta:`, conversation?.id || 'não encontrada');
      
      // Passo 2: Tentar variantes do número
      if (!conversation) {
        const phoneVariants = getPhoneVariants(normalizedPhone);
        console.log(`🔍 [BY-PHONE] Tentando ${phoneVariants.length} variantes...`);
        for (const variant of phoneVariants) {
          conversation = await storage.getChatConversationByPhone(variant);
          if (conversation) {
            console.log(`✅ [BY-PHONE] Conversa encontrada com variante: ${variant}`);
            break;
          }
        }
      }
      
      // Passo 3: Criar nova conversa se não existir
      if (!conversation) {
        console.log(`🔍 [BY-PHONE] Criando nova conversa...`);
        
        // Buscar cliente real pelo telefone para obter nome fantasia
        const realCustomer = await storage.getCustomerByPhone(normalizedPhone);
        const customerDisplayName = realCustomer?.fantasyName || realCustomer?.name || null;
        console.log(`🔍 [BY-PHONE] Cliente real:`, realCustomer?.id || 'não encontrado', `Nome: ${customerDisplayName}`);
        
        // Buscar ou criar cliente do chat
        let customer = await storage.getChatCustomerByPhone(normalizedPhone);
        console.log(`🔍 [BY-PHONE] Cliente chat existente:`, customer?.id || 'não encontrado');
        
        if (!customer) {
          const phonebookContact = await storage.getPhonebookContactByPhone(normalizedPhone);
          console.log(`🔍 [BY-PHONE] Contato da agenda:`, phonebookContact?.name || 'não encontrado');
          
          // Prioridade: nome fantasia do cliente > nome da agenda > número
          const displayName = customerDisplayName || phonebookContact?.name || `Cliente ${normalizedPhone}`;
          
          customer = await storage.createChatCustomer({
            name: displayName,
            phone: normalizedPhone,
            email: null,
            notes: realCustomer ? `Cliente ativo: ${realCustomer.fantasyName || realCustomer.name}` : 
                   phonebookContact ? `Contato da agenda: ${phonebookContact.name}` : null,
            tags: null,
            avatar: null
          });
          console.log(`👤 [BY-PHONE] Cliente criado: ${customer.id} - ${customer.name}`);
        }
        
        const user = req.user as any;
        console.log(`🔍 [BY-PHONE] Usuário logado:`, user?.email || 'desconhecido');
        const agent = user?.email ? await storage.getChatAgentByEmail(user.email) : null;
        console.log(`🔍 [BY-PHONE] Agente:`, agent?.id || 'não encontrado');
        
        // Usar o nome fantasia do cliente real como título da conversa
        const conversationName = customerDisplayName || customer.name;
        
        conversation = await storage.createChatConversation({
          customerId: customer.id,
          customerName: conversationName,
          customerPhone: normalizedPhone,
          status: 'new',
          agentId: agent?.id || null,
          lastMessageTime: nowBrazil(),
          unreadCount: 0
        });
        console.log(`💬 [BY-PHONE] Conversa criada: ${conversation.id} - Nome: ${conversationName}`);
      }
      
      console.log(`✅ [BY-PHONE] Retornando conversationId: ${conversation.id}`);
      res.json({ conversationId: conversation.id, phone: normalizedPhone });
    } catch (error: any) {
      console.error('[BY-PHONE] Erro completo:', error);
      console.error('[BY-PHONE] Stack:', error.stack);
      res.status(500).json({ error: 'Erro ao buscar/criar conversa', details: error.message });
    }
  });

  // ============================================================
  // SINCRONIZAR CLIENTES ATIVOS PARA AGENDA
  // ============================================================

  app.post("/api/chat/sync-customers-to-phonebook", authenticateUser, async (req, res) => {
    try {
      console.log(`📞 [SYNC-PHONEBOOK] Iniciando sincronização de clientes ativos para agenda...`);
      const result = await storage.syncActiveCustomersToPhonebook();
      res.json({ 
        success: true, 
        message: `Sincronizados ${result.synced} clientes para a agenda`,
        ...result 
      });
    } catch (error: any) {
      console.error('[SYNC-PHONEBOOK] Erro:', error);
      res.status(500).json({ error: 'Erro ao sincronizar clientes', details: error.message });
    }
  });

  // Re-vincula CONVERSAS existentes ao cadastro via agenda (phonebook): atualiza o nome do cliente
  // nas conversas/chat_customers pelo contato da agenda (que carrega o customerId do cadastro).
  // Corrige as conversas que ficaram com nome antigo/so-numero apos popular a agenda.
  app.post("/api/chat/relink-conversations-from-phonebook", authenticateUser, async (req, res) => {
    try {
      const convs = await storage.getChatConversations();
      let updated = 0, jaOk = 0, semMatch = 0; const erros: string[] = [];
      for (const conv of (convs as any[])) {
        try {
          const normalizedPhone = normalizePhoneNumber(conv.customerPhone || '');
          if (!normalizedPhone) { semMatch++; continue; }
          const pb = await storage.getPhonebookContactByPhone(normalizedPhone);
          if (!pb || !pb.name) { semMatch++; continue; }
          if (conv.customerName === pb.name) { jaOk++; continue; }
          await storage.updateChatConversation(conv.id, { customerName: pb.name } as any);
          if (conv.customerId) { try { await storage.updateChatCustomer(conv.customerId, { name: pb.name } as any); } catch {} }
          updated++;
        } catch (e: any) { if (erros.length < 10) erros.push(String(e?.message || e).slice(0, 60)); }
      }
      res.json({ success: true, total: (convs as any[]).length, updated, jaOk, semMatch, erros });
    } catch (error: any) {
      console.error('[RELINK-CONVERSAS] Erro:', error);
      res.status(500).json({ error: 'Erro ao re-vincular conversas', details: error.message });
    }
  });

  // Migrar TODO o historico de conversas do 1.0 -> 2.0 (fire-and-forget, idempotente)
  async function writeChatMigStatus(obj: any) {
    const v = JSON.stringify(obj);
    try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('chat_migration_last', ${v}, 'migrate-chat-history', now()) ON CONFLICT (key) DO UPDATE SET value=${v}, updated_by='migrate-chat-history', updated_at=now()`); } catch (e) { console.error("[MIGRATE-CHAT] persist:", e); }
  }
  async function runChatHistoryMigration(dryRun: boolean) {
    const out: any[] = [];
    await writeChatMigStatus({ at: new Date().toISOString(), step: "iniciando", dryRun });
    const { Client } = await import("pg");
    const src = new Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000, query_timeout: 60000 });
    src.on("error", (e: any) => { console.error("[MIGRATE-CHAT] src client error:", e?.message || e); });
    try {
      await Promise.race([
        src.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout conectando ao 1.0 (25s)")), 25000)),
      ]);
      await writeChatMigStatus({ at: new Date().toISOString(), step: "conectado ao 1.0", dryRun });
      for (const t of ["chat_customers", "chat_conversations", "chat_messages"]) {
        const info: any = { table: t };
        try {
          const tgtColsQ: any = await db.execute(sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=${t}`);
          const srcColsQ = await src.query("SELECT column_name FROM information_schema.columns WHERE table_name=$1", [t]);
          const tgtCols = new Map<string, string>((tgtColsQ.rows || []).map((r: any) => [r.column_name, r.data_type]));
          const srcCols = new Set<string>(srcColsQ.rows.map((r: any) => r.column_name));
          const cols = Array.from(tgtCols.keys()).filter((c) => srcCols.has(c));
          if (!cols.includes("id")) { info.skip = "sem coluna id"; out.push(info); continue; }
          const tgtIdsQ: any = await db.execute(sql.raw(`SELECT id FROM "${t}"`));
          const srcIdsQ = await src.query(`SELECT id FROM "${t}"`);
          const tgtIds = new Set<string>((tgtIdsQ.rows || []).map((r: any) => String(r.id)));
          const missing = srcIdsQ.rows.map((r: any) => String(r.id)).filter((id: string) => !tgtIds.has(id));
          info.total_1_0 = srcIdsQ.rowCount; info.tinha_2_0 = (tgtIdsQ.rows || []).length; info.faltando = missing.length;
          if (dryRun || missing.length === 0) { out.push(info); continue; }
          const colListRaw = cols.map((c) => `"${c}"`).join(",");
          let inserted = 0, failed = 0; const errs: string[] = [];
          for (let k = 0; k < missing.length; k += 500) {
            const chunk = missing.slice(k, k + 500);
            const rowsQ = await src.query(`SELECT ${colListRaw} FROM "${t}" WHERE id::text = ANY($1)`, [chunk]);
            for (const row of rowsQ.rows) {
              const valExprs = cols.map((c) => {
                const dt = tgtCols.get(c) || "";
                let v = (row as any)[c];
                if ((dt === "json" || dt === "jsonb") && v !== null) {
                  const jsonStr = typeof v === "string" ? v : JSON.stringify(v);
                  return sql`${jsonStr}::${sql.raw(dt)}`;
                }
                return sql`${v}`;
              });
              try {
                await db.execute(sql`INSERT INTO ${sql.identifier(t)} (${sql.raw(colListRaw)}) VALUES (${sql.join(valExprs, sql`, `)}) ON CONFLICT (id) DO NOTHING`);
                inserted++;
              } catch (e: any) { failed++; if (errs.length < 8) errs.push(`${(row as any).id}: ${String(e?.message || e).slice(0, 90)}`); }
            }
          }
          info.inserido = inserted; info.falhou = failed; if (errs.length) info.erros = errs;
        } catch (e: any) { info.erroTabela = String(e?.message || e).slice(0, 140); }
        out.push(info);
      }
      await writeChatMigStatus({ at: new Date().toISOString(), step: "concluido", dryRun, resultado: out });
    } catch (error: any) {
      console.error("[MIGRATE-CHAT] Erro:", error);
      await writeChatMigStatus({ at: new Date().toISOString(), step: "erro", erro: String(error?.message || error).slice(0, 200), parcial: out });
    } finally { try { await src.end(); } catch {} }
  }
  app.post("/api/admin/chat/migrate-history-from-1-0", authenticateUser, async (req: any, res: any) => {
    if (!process.env.REPLIT_DATABASE_URL) return res.status(400).json({ error: "REPLIT_DATABASE_URL nao configurado" });
    const dryRun = req.body?.dryRun === true;
    res.json({ started: true, dryRun, note: "rodando em background; veja /api/admin/chat/migrate-history-from-1-0/status" });
    runChatHistoryMigration(dryRun).catch((e) => console.error("[MIGRATE-CHAT] bg:", e));
  });
  app.get("/api/admin/chat/migrate-history-from-1-0/status", authenticateUser, async (req: any, res: any) => {
    try {
      const r = await db.execute(sql`SELECT value, updated_at FROM system_settings WHERE key='chat_migration_last'`);
      const row = (r as any).rows?.[0];
      res.json(row ? { ...JSON.parse(row.value), updated_at: row.updated_at } : { none: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e).slice(0, 120) }); }
  });

  // ============================================================
  // CHAT AGENTS CRUD
  // ============================================================

  // Get all chat agents
  app.get("/api/chat/agents", authenticateUser, async (req, res) => {
    try {
      const agents = await storage.getChatAgents();
      res.json(agents);
    } catch (error) {
      console.error("[CHAT] Get agents error:", error);
      res.status(500).json({ error: "Erro ao buscar agentes" });
    }
  });

  // Create chat agent
  app.post(
    "/api/chat/agents",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const validatedData = insertChatAgentSchema.parse(req.body);
        const agent = await storage.createChatAgent(validatedData);
        res.json(agent);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: error.errors });
        }
        console.error("[CHAT] Create agent error:", error);
        res.status(500).json({ error: "Erro ao criar agente" });
      }
    }
  );

  // Delete chat agent
  app.delete(
    "/api/chat/agents/:id",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const { id } = req.params;
        await storage.deleteChatAgent(id);
        res.json({ success: true });
      } catch (error) {
        console.error("[CHAT] Delete agent error:", error);
        res.status(500).json({ error: "Erro ao deletar agente" });
      }
    }
  );

  // ============================================================
  // AGENT PRESENCE / HEARTBEAT
  // ============================================================

  // Heartbeat endpoint - called periodically when ChatCenter is open
  app.post("/api/chat/agents/heartbeat", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      if (!currentUser?.email) {
        return res.status(401).json({ error: "Usuário não autenticado" });
      }

      // Find the agent by user email and update their status to online
      const agents = await storage.getChatAgents();
      const agent = agents.find(a => a.email === currentUser.email);

      if (agent) {
        const wasOffline = agent.status !== "online";
        await storage.updateChatAgentPresence(agent.id, "online");
        
        // Se o agente estava offline e agora está online, desativar standby do ChatGPT
        if (wasOffline) {
          console.log(`🟢 [HEARTBEAT] Agent ${currentUser.email} is now online`);
          const { deactivateChatGPTStandby } = await import("./chat-distribution-service");
          await deactivateChatGPTStandby();
        }
      }

      res.json({ success: true, status: "online" });
    } catch (error) {
      console.error("[CHAT] Heartbeat error:", error);
      res.status(500).json({ error: "Erro ao atualizar presença" });
    }
  });

  // Set agent offline - called when ChatCenter is closed
  app.post("/api/chat/agents/offline", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      if (!currentUser?.email) {
        return res.status(401).json({ error: "Usuário não autenticado" });
      }

      // Find the agent by user email and update their status to offline
      const agents = await storage.getChatAgents();
      const agent = agents.find(a => a.email === currentUser.email);

      if (agent) {
        await storage.updateChatAgentPresence(agent.id, "offline");
        console.log(`⚫ [OFFLINE] Agent ${currentUser.email} is offline`);
        
        // Verificar se ainda há agentes online - se não houver, ativar standby
        const { getOnlineTelemarketingAgents, activateChatGPTStandby } = await import("./chat-distribution-service");
        const onlineAgents = await getOnlineTelemarketingAgents();
        
        if (onlineAgents.length === 0) {
          console.log('🤖 [STANDBY] Nenhum agente online - ativando standby do ChatGPT');
          await activateChatGPTStandby();
        }
      }

      res.json({ success: true, status: "offline" });
    } catch (error) {
      console.error("[CHAT] Offline error:", error);
      res.status(500).json({ error: "Erro ao atualizar presença" });
    }
  });

  // ⚠️ GET /api/chat/agents/online movido para linha 3672 com ChatGPT standby incluído

  // ============================================================
  // CHAT CONVERSATIONS CRUD
  // ============================================================

  // ⚠️ GET /api/chat/conversations movido para linha 2085 com autenticação e filtragem por role

  // Create conversation
  app.post("/api/chat/conversations", async (req, res) => {
    try {
      const validatedData = insertChatConversationSchema.parse(req.body);
      const conversation = await storage.createChatConversation(validatedData);
      res.json(conversation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create conversation error:", error);
      res.status(500).json({ error: "Erro ao criar conversa" });
    }
  });

  // Start new conversation (initiate message to customer)
  app.post("/api/chat/conversations/start", authenticateUser, async (req, res) => {
    try {
      const { customerPhone, customerName } = req.body;
      const currentUser = (req as any).currentUser;
      
      console.log(`🚀 [START-CONVERSATION] Requisição recebida:`, {
        phone: customerPhone,
        name: customerName,
        user: currentUser?.email
      });

      if (!customerPhone) {
        console.warn(`⚠️  [START-CONVERSATION] Telefone vazio`);
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }

      // Normalize phone
      const normalizedPhone = normalizePhoneNumber(customerPhone);
      console.log(`📞 [START-CONVERSATION] Telefone normalizado: ${customerPhone} → ${normalizedPhone}`);

      // (Evolution API removida — provedor atual é Umbler Talk; a conversa e apenas um registro no banco, o envio ocorre no endpoint de mensagem)

      // Create or get customer
      console.log(`👤 [START-CONVERSATION] Criando cliente...`);
      
      // First, try to find existing customer by phone
      let existingCustomer = await storage.getChatCustomerByPhone(normalizedPhone);
      let createdCustomer: typeof existingCustomer | null = existingCustomer || null;
      
      if (!existingCustomer) {
        // Customer doesn't exist, create new one
        createdCustomer = await storage.createChatCustomer({
          name: customerName || `Cliente ${normalizedPhone}`,
          phone: normalizedPhone
        }).catch((err) => {
          console.warn(`⚠️  [START-CONVERSATION] Erro ao criar cliente (pode ser duplicado):`, err.message);
          return null;
        });
        
        // If creation failed, try to fetch again (race condition)
        if (!createdCustomer) {
          createdCustomer = await storage.getChatCustomerByPhone(normalizedPhone);
        }
      } else {
        console.log(`👤 [START-CONVERSATION] Cliente existente encontrado:`, existingCustomer.id);
      }

      if (!createdCustomer) {
        console.warn(`⚠️  [START-CONVERSATION] Cliente não foi criado nem encontrado`);
        return res.status(400).json({ error: "Erro ao criar cliente para a conversa" });
      }
      console.log(`✅ [START-CONVERSATION] Cliente criado/obtido:`, createdCustomer.id);

      // Create conversation using upsert logic
      console.log(`💬 [START-CONVERSATION] Criando/atualizando conversa...`);
      const conversation = await storage.upsertChatConversation({
        customerId: createdCustomer.id,
        customerName: customerName || `Cliente ${normalizedPhone}`,
        customerPhone: normalizedPhone,
        status: "new",
        priority: "normal"
      });
      console.log(`✅ [START-CONVERSATION] Conversa criada/atualizada:`, conversation.id);

      // 🔧 NOVO: Atribuir conversa ao atendente que iniciou (não passa pelo ChatGPT)
      // Conversas iniciadas por atendentes NUNCA vão para o ChatGPT
      const agents = await storage.getChatAgents();
      const userAgent = agents.find((a: any) => a.userId === currentUser?.id || a.email === currentUser?.email);
      
      if (userAgent) {
        const { getAgentColor } = await import("./chat-distribution-service");
        const agentColor = await getAgentColor(userAgent.id);
        await storage.updateChatConversation(conversation.id, {
          status: 'in-progress',
          assignedAgentId: userAgent.id,
          assignedAgentColor: agentColor,
          lastAttendedAt: nowBrazil()
        });
        console.log(`👤 [START-CONVERSATION] Conversa ${conversation.id} atribuída ao atendente ${userAgent.name} (${userAgent.id})`);
      }

      const response = {
        id: conversation.id,
        customerId: createdCustomer.id,
        phoneNumber: normalizedPhone,
        customerName: customerName || `Cliente ${normalizedPhone}`,
        status: userAgent ? "in-progress" : "new"
      };
      
      console.log(`🎉 [START-CONVERSATION] Retornando resposta:`, response);
      res.json(response);
    } catch (error: any) {
      console.error("[CHAT] Start conversation error:", error);
      console.error("[CHAT] Stack:", error.stack);
      res.status(500).json({ error: "Erro ao iniciar conversa: " + error.message });
    }
  });

  // Update conversation
  app.patch("/api/chat/conversations/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const conversation = await storage.updateChatConversation(id, req.body);
      res.json(conversation);
    } catch (error) {
      console.error("[CHAT] Update conversation error:", error);
      res.status(500).json({ error: "Erro ao atualizar conversa" });
    }
  });

  // ============================================================
  // CHAT MESSAGES CRUD
  // ============================================================

  // Get messages for a conversation
  app.get("/api/chat/messages/:conversationId", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await storage.getChatMessages(conversationId);
      res.json(messages);
    } catch (error) {
      console.error("[CHAT] Get messages error:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens" });
    }
  });

  // Create message
  app.post("/api/chat/messages", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertChatMessageSchema.parse(req.body);
      const message = await storage.createChatMessage(validatedData);
      
      // If message is from agent/system, send via Evolution API
      if (message.senderType !== 'customer' && message.conversationId) {
        try {
          console.log(`📨 [CHAT-MESSAGE] Enviando mensagem via Evolution API...`);
          
          // Get conversation to get customer phone
          const conversation = await storage.getChatConversation(message.conversationId);
          if (!conversation || !conversation.customerPhone) {
            console.warn(`⚠️  [CHAT-MESSAGE] Conversa ou telefone não encontrados`);
            return res.json(message); 
          }
          
          const config = evolutionAPIService.getConfig();
          if (!config || !config.apiKey) {
            console.warn(`⚠️  [CHAT-MESSAGE] Evolution API não configurada no service`);
            return res.json(message);
          }
          
          console.log(`📱 [CHAT-MESSAGE] Telefone do cliente: ${conversation.customerPhone}`);
          
          const sendResult = await evolutionAPIService.sendTextMessage(
            config.instanceName,
            conversation.customerPhone,
            message.content
          );
          
          if (sendResult.success) {
            console.log(`✅ [CHAT-MESSAGE] Mensagem entregue via WhatsApp! ID:`, sendResult.messageId);
          } else {
            console.warn(`⚠️  [CHAT-MESSAGE] Erro ao enviar via WhatsApp:`, sendResult.error);
          }
        } catch (sendError: any) {
          console.error(`❌ [CHAT-MESSAGE] Erro ao enviar mensagem:`, sendError.message);
        }
      }
      
      res.json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create message error:", error);
      res.status(500).json({ error: "Erro ao criar mensagem" });
    }
  });

  // ============================================================
  // CHAT PRODUCTS CRUD
  // ============================================================

  // Get all chat products
  app.get("/api/chat/products", authenticateUser, async (req, res) => {
    try {
      const products = await storage.getChatProducts();
      res.json(products);
    } catch (error) {
      console.error("[CHAT] Get products error:", error);
      res.status(500).json({ error: "Erro ao buscar produtos" });
    }
  });

  // Create chat product
  app.post(
    "/api/chat/products",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const validatedData = insertChatProductSchema.parse(req.body);
        const product = await storage.createChatProduct(validatedData);
        res.json(product);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: error.errors });
        }
        console.error("[CHAT] Create product error:", error);
        res.status(500).json({ error: "Erro ao criar produto" });
      }
    }
  );

  // Update chat product
  app.patch(
    "/api/chat/products/:id",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const { id } = req.params;
        const product = await storage.updateChatProduct(id, req.body);
        res.json(product);
      } catch (error) {
        console.error("[CHAT] Update product error:", error);
        res.status(500).json({ error: "Erro ao atualizar produto" });
      }
    }
  );

  // ============================================================
  // CHAT QUICK MESSAGES CRUD
  // ============================================================

  // Get all quick messages
  app.get("/api/chat/quick-messages", authenticateUser, async (req, res) => {
    try {
      const quickMessages = await storage.getChatQuickMessages();
      res.json(quickMessages);
    } catch (error) {
      console.error("[CHAT] Get quick messages error:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens rápidas" });
    }
  });

  // Create quick message
  app.post("/api/chat/quick-messages", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const validatedData = insertChatQuickMessageSchema.parse({
        ...req.body,
        createdBy: currentUser.id,
      });
      const quickMessage = await storage.createChatQuickMessage(validatedData);
      res.json(quickMessage);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create quick message error:", error);
      res.status(500).json({ error: "Erro ao criar mensagem rápida" });
    }
  });

  // ============================================================
  // CHAT ORDERS CRUD
  // ============================================================

  // Get all chat orders
  app.get("/api/chat/orders", authenticateUser, async (req, res) => {
    try {
      const { status, customerId } = req.query;
      
      let orders = await storage.getChatOrders();
      
      // Filter on the server side
      if (status) {
        orders = orders.filter(o => o.status === status);
      }
      if (customerId) {
        orders = orders.filter(o => o.customerId === customerId);
      }
      
      res.json(orders);
    } catch (error) {
      console.error("[CHAT] Get orders error:", error);
      res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
  });

  // Create chat order
  app.post("/api/chat/orders", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertChatOrderSchema.parse(req.body);
      const order = await storage.createChatOrder(validatedData);
      res.json(order);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create order error:", error);
      res.status(500).json({ error: "Erro ao criar pedido" });
    }
  });

  // Update chat order
  app.patch("/api/chat/orders/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const order = await storage.updateChatOrder(id, req.body);
      res.json(order);
    } catch (error) {
      console.error("[CHAT] Update order error:", error);
      res.status(500).json({ error: "Erro ao atualizar pedido" });
    }
  });

  // ============================================================
  // CHAT DELIVERIES CRUD
  // ============================================================

  // Get all chat deliveries
  app.get("/api/chat/deliveries", authenticateUser, async (req, res) => {
    try {
      const { status, deliveryPersonId } = req.query;
      
      let deliveries = await storage.getChatDeliveries();
      
      // Filter on the server side
      if (status) {
        deliveries = deliveries.filter(d => d.status === status);
      }
      if (deliveryPersonId) {
        deliveries = deliveries.filter(d => d.deliveryPersonId === deliveryPersonId);
      }
      
      res.json(deliveries);
    } catch (error) {
      console.error("[CHAT] Get deliveries error:", error);
      res.status(500).json({ error: "Erro ao buscar entregas" });
    }
  });

  // Create chat delivery
  app.post("/api/chat/deliveries", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertChatDeliverySchema.parse(req.body);
      const delivery = await storage.createChatDelivery(validatedData);
      res.json(delivery);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create delivery error:", error);
      res.status(500).json({ error: "Erro ao criar entrega" });
    }
  });

  // Update chat delivery
  app.patch("/api/chat/deliveries/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const delivery = await storage.updateChatDelivery(id, req.body);
      res.json(delivery);
    } catch (error) {
      console.error("[CHAT] Update delivery error:", error);
      res.status(500).json({ error: "Erro ao atualizar entrega" });
    }
  });

  // ============================================================
  // WHATSAPP SETUP ROUTES
  // ============================================================

  // Get WhatsApp QR Code
  app.get("/api/chat/whatsapp/qr", authenticateUser, async (req, res) => {
    try {
      const status = await whatsappService.getStatus();
      
      if (status.qrCode) {
        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(status.qrCode);
        res.json({ qrCode: qrDataUrl, status: status.status });
      } else {
        res.json({ status: status.status, phoneNumber: status.phoneNumber });
      }
    } catch (error) {
      console.error("[CHAT] WhatsApp QR error:", error);
      res.status(500).json({ error: "Erro ao gerar QR Code do WhatsApp" });
    }
  });

  // Disconnect WhatsApp
  app.post("/api/chat/whatsapp/disconnect", authenticateUser, async (req, res) => {
    try {
      await whatsappService.disconnect();
      res.json({ success: true });
    } catch (error) {
      console.error("[CHAT] WhatsApp disconnect error:", error);
      res.status(500).json({ error: "Erro ao desconectar WhatsApp" });
    }
  });

  // Send WhatsApp message via Evolution API (Test endpoint - without auth)
  app.post("/api/chat/send-message-test", async (req, res) => {
    try {
      const { phoneNumber, message, messageType = 'text' } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }

      if (!message && messageType === 'text') {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }

      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Config: " + JSON.stringify(config) });
      }

      console.log(`📨 [WHATSAPP-SEND-TEST] Enviando mensagem para ${phoneNumber} via ${messageType}`);

      const result = await evolutionAPIService.sendTextMessage(config.instanceName, phoneNumber, message);

      if (!result.success) {
        console.error(`❌ [WHATSAPP-SEND-TEST] Erro ao enviar:`, result.error);
        return res.status(500).json({ error: result.error || "Erro ao enviar mensagem" });
      }

      console.log(`✅ [WHATSAPP-SEND-TEST] Mensagem enviada com sucesso para ${phoneNumber}`);
      res.json({ 
        success: true, 
        messageId: result.messageId,
        message: "Mensagem enviada com sucesso"
      });
    } catch (error: any) {
      console.error("[CHAT] Send message test error:", error);
      res.status(500).json({ error: "Erro ao enviar mensagem: " + error.message });
    }
  });

  // ============================================================
  // EVOLUTION API WEBHOOK - RECEBER MENSAGENS
  // ============================================================

  // POST /api/chat/webhook/messages - Receber TODAS as mensagens via webhook da Evolution API
  // 🪞 ESPELHO COMPLETO DO WHATSAPP - Captura mensagens enviadas via celular E via sistema
  // Diagnostico Umbler/uTalk (read-only)
  app.get("/api/chat/umbler/status", (req: any, res: any) => {
    const host = req.headers.host || "integracode-production.up.railway.app";
    res.json({
      provider: process.env.UMBLER_TALK_TOKEN ? "umbler-talk" : (process.env.UMBLER_API_KEY ? "utalk" : "evolution"),
      umblerTalkTokenPresent: !!process.env.UMBLER_TALK_TOKEN,
      umblerKeyPresent: !!process.env.UMBLER_API_KEY,
      sendImplemented: true,
      webhookReceiverUrl: "https://" + host + "/api/chat/webhook/messages",
      note: "Umbler Talk API (Bearer) preferida quando UMBLER_TALK_TOKEN setado; senao api.utalk.chat. Webhook de recebimento via shim.",
    });
  });

  // Diagnostico de envio Umbler (retorna resultado real do sendUmblerText)
  app.get("/api/chat/umbler/test-send", async (req: any, res: any) => {
    try {
      const to = String(req.query.to || "");
      const msg = String(req.query.msg || "Teste Umbler uTalk");
      if (!to) return res.status(400).json({ error: "informe ?to=5562999999999" });
      const useTalk = !!process.env.UMBLER_TALK_TOKEN;
      const r = useTalk ? await sendUmblerTalkText(to, msg) : await sendUmblerText(to, msg);
      res.json({ provider: useTalk ? "umbler-talk" : "utalk", umblerTalkTokenPresent: !!process.env.UMBLER_TALK_TOKEN, umblerKeyPresent: !!process.env.UMBLER_API_KEY, to, result: r });
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  // Diagnostico Umbler Talk: resolve organizationId + fromPhone via API (read-only)
  app.get("/api/chat/umbler-talk/channels", authenticateUser, async (req: any, res: any) => {
    try {
      const cfg = await resolveUmblerTalkConfig();
      if ('error' in cfg) return res.status(400).json({ error: cfg.error });
      const chResp = await umblerTalkFetch('/v1/channels/?organizationId=' + encodeURIComponent(cfg.orgId));
      const raw = await chResp.text();
      if (!chResp.ok) return res.status(502).json({ error: `channels HTTP ${chResp.status}`, body: raw.slice(0, 300) });
      let chans: any; try { chans = JSON.parse(raw); } catch { chans = raw; }
      const list = Array.isArray(chans) ? chans : (chans && (chans.items || chans.channels || []));
      const canais = (list || []).map((c: any) => ({ phone: c.phoneNumber, nome: c.name || c.displayName || c.description, tipo: c._t || c.channelType, status: c.status || c.connectionStatus || c.state || c.isConnected, id: c.id }));
      res.json({ fromPhoneUsado: cfg.fromPhone, orgId: cfg.orgId, totalCanais: canais.length, canais });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  app.get("/api/chat/umbler-talk/diagnose", async (req: any, res: any) => {
    try {
      const cfg = await resolveUmblerTalkConfig();
      res.json({ umblerTalkTokenPresent: !!process.env.UMBLER_TALK_TOKEN, base: UMBLER_TALK_BASE, resolved: cfg });
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  // Teste de envio de MIDIA via Umbler Talk (file = URL publica acessivel)
  app.get("/api/chat/umbler-talk/test-media", async (req: any, res: any) => {
    try {
      const to = String(req.query.to || "");
      const url = String(req.query.url || "");
      const caption = String(req.query.caption || "");
      if (!to || !url) return res.status(400).json({ error: "informe ?to=...&url=..." });
      const r = await sendUmblerTalkMedia(to, url, caption);
      res.json({ provider: "umbler-talk", to, url, result: r });
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  // Teste de transcricao de audio (OpenAI Whisper) — ?url=<audio publico>
  app.get("/api/chat/transcribe-test", async (req: any, res: any) => {
    try {
      const url = String(req.query.url || "");
      if (!url) return res.status(400).json({ error: "informe ?url=<audio>" });
      const t0 = Date.now();
      const transcript = await transcribeAudioSource(url);
      res.json({ hasOpenAIKey: !!process.env.OPENAI_API_KEY, ms: Date.now() - t0, transcript });
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  // Diagnostico: ultimas mensagens de audio recebidas + transcricao (read-only)
  app.get("/api/chat/transcribe-status", async (req: any, res: any) => {
    try {
      const rows: any = await db.execute(sql`SELECT id, conversation_id, content, metadata, created_at FROM chat_messages WHERE message_type = 'audio' AND sender_type = 'customer' ORDER BY created_at DESC LIMIT 5`);
      const list = (rows.rows || rows || []);
      const out = list.map((r: any) => {
        let meta: any = r.metadata; try { if (typeof meta === 'string') meta = JSON.parse(meta); } catch {}
        const transcription = meta && meta.transcription ? String(meta.transcription) : null;
        return { id: r.id, at: r.created_at, transcribed: !!transcription, content: r.content, transcription };
      });
      res.json({ hasOpenAIKey: !!process.env.OPENAI_API_KEY, count: out.length, items: out });
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  // Diagnostico: content-type/length dos ultimos webhooks (EARLY-RAW), nao mascarado
  app.get("/api/chat/webhook-meta", async (req: any, res: any) => {
    try {
      const rows: any = await db.execute(sql`SELECT created_at, extracted_phone, normalized_phone, LENGTH(raw_payload) as body_len FROM webhook_debug_log WHERE raw_remote_jid = 'EARLY-RAW' ORDER BY created_at DESC LIMIT 8`);
      const list = (rows.rows || rows || []);
      res.json({ items: list.map((r: any) => ({ at: r.created_at, contentType: r.extracted_phone, contentLength: r.normalized_phone, bodyLen: r.body_len })) });
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  // Diagnostico: estrutura MASCARADA dos ultimos webhooks recebidos (read-only, nao vaza conteudo)
  app.get("/api/chat/umbler-talk/last-webhook", async (req: any, res: any) => {
    try {
      const rows: any = await db.execute(sql`SELECT id, created_at, LEFT(raw_payload, 38000) as raw FROM webhook_debug_log ORDER BY created_at DESC LIMIT 5`);
      const mask = (v: any): any => {
        if (typeof v === 'string') return 'str(' + v.length + ')';
        if (Array.isArray(v)) return v.slice(0, 3).map(mask);
        if (v && typeof v === 'object') { const o: any = {}; for (const k of Object.keys(v).slice(0, 40)) o[k] = mask(v[k]); return o; }
        return v;
      };
      const list = (rows.rows || rows || []);
      const out = list.map((r: any) => { let parsed: any = null; try { parsed = JSON.parse(r.raw); } catch {} return { id: r.id, at: r.created_at, topKeys: parsed ? Object.keys(parsed) : [], structure: parsed ? mask(parsed) : String(r.raw || '').slice(0, 120) }; });
      res.json({ count: out.length, items: out });
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  app.post("/api/chat/webhook/messages", async (req, res) => {
    // CRITICAL: Log immediately when webhook is called to confirm Evolution API connectivity
    console.log(`📥 [WEBHOOK-HIT] Webhook recebido às ${new Date().toISOString()}, evento=${req.body?.event || 'unknown'}`);
    
    const debugInfo: any = { 
      timestamp: new Date().toISOString(),
      steps: [],
      env: process.env.NODE_ENV
    };
    
    try {
      let { event, instance, data } = req.body;
      debugInfo.steps.push('1-parse-body');
      // Captura crua antecipada (qualquer payload, mesmo nao reconhecido) p/ diagnostico de formato
      try {
        await db.execute(sql`INSERT INTO webhook_debug_log (raw_payload, raw_remote_jid, extracted_phone, normalized_phone, mapping_found, mapped_to) VALUES (${JSON.stringify(req.body || {}).substring(0, 40000)}, ${'EARLY-RAW'}, ${String((req.headers && req.headers['content-type']) || '').substring(0, 120)}, ${String((req.headers && req.headers['content-length']) || '')}, ${false}, ${null})`);
      } catch {}
      
      // Suportar múltiplos formatos de webhook (Evolution API pode enviar de diferentes formas)
      if (!event && req.body.webhook?.event) {
        event = req.body.webhook.event;
        instance = req.body.webhook.instance;
        data = req.body.webhook.data;
      }
      
      if (!event) {
        if (req.body.key && req.body.message) {
          event = 'messages.upsert';
          data = req.body;
        }
      }
      
      // uTalk (Umbler api.utalk.chat) — normalizar webhook de RECEBIMENTO para shape Evolution (texto + midia)
      if (!event) {
        const ub: any = req.body || {};
        const utext = ub.msg ?? ub.message ?? ub.body ?? ub.text ?? ub.texto;
        const uphoneRaw = ub.from ?? ub.sender ?? ub.phone ?? ub.chatId ?? ub.de ?? ub.to;
        // Deteccao tolerante de midia (uTalk: base64 no corpo, ou url, + mimetype/nome)
        const umediaRaw = ub.base64 ?? ub.blob ?? ub.media ?? ub.file ?? ub.attachment ?? ub.image ?? ub.audio ?? ub.document ?? null;
        const umediaUrl = ub.url ?? ub.mediaUrl ?? ub.fileUrl ?? ub.link ?? null;
        const umime = ub.mimetype ?? ub.mime ?? ub.contentType ?? ub.fileType ?? null;
        const ufilename = ub.fn ?? ub.filename ?? ub.fileName ?? null;
        const hasMedia = !!(umediaUrl || (umediaRaw && typeof umediaRaw === 'string'));
        if (uphoneRaw && (utext != null || hasMedia)) {
          const digits = String(uphoneRaw).replace(/@.*/, '').replace(/\D/g, '');
          const isFromMe = ub.fromMe === true || ub.fromMe === 'true' || ub.sent === true
            || String(ub.direction || '').toLowerCase() === 'sent'
            || String(ub.type || '').toLowerCase() === 'sent';
          const caption = utext != null ? String(utext) : '';
          let msgObj: any;
          if (hasMedia) {
            const builtUrl = umediaUrl
              || (typeof umediaRaw === 'string'
                ? (umediaRaw.startsWith('data:') ? umediaRaw : `data:${umime || 'application/octet-stream'};base64,${umediaRaw}`)
                : undefined);
            let mt: 'image' | 'audio' | 'video' | 'document' = 'document';
            if (umime && umime.startsWith('image/')) mt = 'image';
            else if (umime && umime.startsWith('audio/')) mt = 'audio';
            else if (umime && umime.startsWith('video/')) mt = 'video';
            else if (!umime && /\.(jpe?g|png|gif|webp)$/i.test(ufilename || '')) mt = 'image';
            else if (!umime && /\.(mp3|ogg|wav|m4a|opus)$/i.test(ufilename || '')) mt = 'audio';
            else if (!umime && /\.(mp4|webm|mov)$/i.test(ufilename || '')) mt = 'video';
            if (mt === 'image') msgObj = { imageMessage: { url: builtUrl, mimetype: umime || 'image/jpeg', caption } };
            else if (mt === 'video') msgObj = { videoMessage: { url: builtUrl, mimetype: umime || 'video/mp4', caption } };
            else msgObj = { documentMessage: { url: builtUrl, mimetype: umime || 'application/octet-stream', fileName: ufilename || 'documento', caption } };
            (debugInfo as any).utalkMedia = mt;
          } else {
            msgObj = { conversation: String(utext) };
          }
        event = 'messages.upsert';
          data = {
            key: { remoteJid: digits + '@s.whatsapp.net', fromMe: !!isFromMe, id: String(ub.id || ub.messageId || ('utalk-' + Date.now())) },
            message: msgObj,
            pushName: ub.senderName || ub.name || ub.pushName || ub.nome || undefined,
            messageTimestamp: ub.time || ub.timestamp || Math.floor(Date.now() / 1000),
          };
          (debugInfo as any).utalk = true;
          debugInfo.steps.push(hasMedia ? 'utalk-normalized-media' : 'utalk-normalized');
        }
      }

      // Umbler Talk (app-utalk.umbler.com) — normalizar webhook de RECEBIMENTO para shape Evolution
      if (!event) {
        const ut: any = req.body || {};
        const chat = (ut.Payload && ut.Payload.Content) || (ut.payload && ut.payload.content) || null;
        const lm = chat && (chat.LastMessage || chat.lastMessage);
        if (chat && lm) {
          const contact = chat.Contact || chat.contact || {};
          const phoneRaw = contact.PhoneNumber || contact.phoneNumber || contact.Phone || '';
          const digits = String(phoneRaw).replace(/\D/g, '');
          if (digits) {
            const source = String(lm.Source || lm.source || '').toLowerCase();
            const isFromMe = source === 'member' || !!(lm.SentByOrganizationMember || lm.sentByOrganizationMember);
            const mtypeRaw = String(lm.MessageType || lm.messageType || 'Text').toLowerCase();
            const caption = String(lm.Content != null ? lm.Content : (lm.content != null ? lm.content : ''));
            let file = lm.File || lm.file || null;
            let fileUrl = file && (file.Url || file.url);
            let fileMime = file && (file.MimeType || file.mimetype || file.mimeType);
            let fileName = file && (file.FileName || file.fileName || file.Name);
            let mt: 'text' | 'image' | 'audio' | 'video' | 'document' = 'text';
            if (/image/.test(mtypeRaw)) mt = 'image';
            else if (/audio|ptt|voice/.test(mtypeRaw)) mt = 'audio';
            else if (/video/.test(mtypeRaw)) mt = 'video';
            else if (/file|document|application/.test(mtypeRaw) || fileUrl) {
              mt = (fileMime && /^image\//.test(fileMime)) ? 'image' : (fileMime && /^audio\//.test(fileMime)) ? 'audio' : (fileMime && /^video\//.test(fileMime)) ? 'video' : 'document';
            }
            const umMsgId = String(lm.Id || lm.id || '');
            // Umbler envia o evento Message de midia SEM o arquivo (File=null, upload async). Resolver via API.
            if (mt !== 'text' && !fileUrl && umMsgId && process.env.UMBLER_TALK_TOKEN) {
              const resolved = await fetchUmblerTalkMessageFile(umMsgId);
              if (resolved && resolved.url) {
                fileUrl = resolved.url; fileMime = resolved.mime || fileMime; fileName = resolved.fileName || fileName;
                (debugInfo as any).umblerTalkFileResolved = true;
              }
            }
            if (mt !== 'text' && !fileUrl) {
              // midia ainda sem arquivo (upload nao concluido) — ignorar; o evento MessageFileUploaded trara o arquivo
              (debugInfo as any).umblerTalkSkipped = 'media-no-file:' + mt;
              debugInfo.steps.push('umbler-talk-skip-media-no-file');
            } else {
              let msgObj: any;
              if (mt !== 'text' && fileUrl) {
                if (mt === 'image') msgObj = { imageMessage: { url: fileUrl, mimetype: fileMime || 'image/jpeg', caption } };
                else if (mt === 'audio') msgObj = { audioMessage: { url: fileUrl, mimetype: fileMime || 'audio/ogg' } };
                else if (mt === 'video') msgObj = { videoMessage: { url: fileUrl, mimetype: fileMime || 'video/mp4', caption } };
                else msgObj = { documentMessage: { url: fileUrl, mimetype: fileMime || 'application/octet-stream', fileName: fileName || 'documento', caption } };
                (debugInfo as any).umblerTalkMedia = mt;
              } else {
                msgObj = { conversation: caption };
              }
              event = 'messages.upsert';
              data = {
                key: { remoteJid: digits + '@s.whatsapp.net', fromMe: !!isFromMe, id: umMsgId || String(ut.EventId || ('umblertalk-' + Date.now())) },
                message: msgObj,
                pushName: contact.Name || contact.name || undefined,
                messageTimestamp: Math.floor(Date.now() / 1000),
              };
              (debugInfo as any).umblerTalk = true;
              (data as any).__channelId = (chat.Channel && (chat.Channel.Id || chat.Channel.id)) || null;
              debugInfo.steps.push('umbler-talk-normalized');
            }
          }
        }
      }
      
      const messageEvents = [
        'messages.upsert', 'MESSAGES_UPSERT',
        'send.message', 'SEND_MESSAGE', 
        'message.create', 'MESSAGE_CREATE',
        'messages.set', 'MESSAGES_SET',
        'messages.edited', 'MESSAGES_EDITED'
      ];
      
      debugInfo.event = event;
      
      if (!event || !messageEvents.includes(event)) {
        return res.json({ received: false, reason: 'Evento ignorado', debug: debugInfo });
      }

      if (!data || !data.key) {
        return res.json({ received: false, reason: 'Dados inválidos', debug: debugInfo });
      }

      const rawRemoteJid = data.key.remoteJid;
      debugInfo.rawRemoteJid = rawRemoteJid;
      
      // 👥 GRUPOS: Processar mensagens de grupos separadamente
      if (rawRemoteJid.includes('@g.us')) {
        debugInfo.steps.push('2-process-group');
        const groupProcessed = await processGroupMessage(data);
        debugInfo.groupProcessed = groupProcessed;
        return res.json({ received: groupProcessed, reason: 'Grupo processado', debug: debugInfo });
      }

      // 🎯 NOVO: Usar resolveCanonicalPhone para buscar número real automaticamente
      const { phone: resolvedPhone, source: phoneSource } = evolutionAPIService.resolveCanonicalPhone(data);
      const cleanPhone = resolvedPhone.replace(/\D/g, '');
      debugInfo.phoneNumber = resolvedPhone;
      debugInfo.cleanPhone = cleanPhone;
      debugInfo.phoneSource = phoneSource;
      debugInfo.steps.push('2-resolve-canonical-phone');
      
      // Mapeamento de telefone como fallback (apenas para @lid sem número real)
      let targetPhone = resolvedPhone;
      
      // Buscar mapeamento no banco de dados APENAS se for @lid
      debugInfo.steps.push('3-lookup-mapping');
      let phoneMapping = null;
      if (phoneSource.includes('@lid')) {
        phoneMapping = await storage.getPhoneMappingBySource(cleanPhone);
        debugInfo.phoneMappingFound = !!phoneMapping;
        
        if (phoneMapping) {
          targetPhone = phoneMapping.canonicalPhone;
          debugInfo.mappedTo = targetPhone;
          console.log(`🔄 [WEBHOOK-MIRROR] Remapeando @lid via DB: ${resolvedPhone} -> ${targetPhone}`);
        }
      } else {
        debugInfo.phoneMappingFound = false;
        console.log(`✅ [WEBHOOK-MIRROR] Número real encontrado, sem necessidade de mapeamento: ${resolvedPhone}`);
      }

      const normalizedPhone = normalizePhoneNumber(targetPhone);
      
    // 🔍 DEBUG: Registrar todos os dados para diagnóstico
      try {
        const debugPayload = JSON.stringify(req.body);
        await db.execute(sql`
          INSERT INTO webhook_debug_log (raw_payload, raw_remote_jid, extracted_phone, normalized_phone, mapping_found, mapped_to)
          VALUES (${debugPayload.substring(0, 8000)}, ${rawRemoteJid}, ${cleanPhone}, ${normalizedPhone}, ${!!phoneMapping}, ${phoneMapping?.canonicalPhone || null})
        `);
        console.log(`🔍 [WEBHOOK-DEBUG] Registrado: ${rawRemoteJid} -> ${cleanPhone} -> ${normalizedPhone} (fonte: ${phoneSource})`);
        
        // Log específico para mídias
        if (debugPayload.includes('Message') && (debugPayload.includes('url') || debugPayload.includes('base64'))) {
          console.log(`📎 [WEBHOOK-DEBUG-MEDIA] Detectada possível mídia no payload de ${normalizedPhone}`);
        }
      } catch (dbErr) {
        console.error(`⚠️ [WEBHOOK-DEBUG] Erro ao registrar debug:`, dbErr);
      }
      const isFromMe = data.key.fromMe === true;
      const messageText = evolutionAPIService.extractMessageText(data.message) || '';
      const messageId = data.key.id;
      
      // 🖼️ Extrair informações de mídia
      const mediaInfo = evolutionAPIService.extractMediaInfo(data.message);
      debugInfo.mediaInfo = mediaInfo;
      
      // 🎯 NOVO: Suporte a estrutura de mídia da Evolution API v2 (pode estar em msg.message ou msg direto)
      if (mediaInfo.messageType !== 'text' && !mediaInfo.mediaUrl) {
        const msg = data.message?.message || data.message;
        const deepMsg = msg?.message || msg;
        
        // Check for base64 in various possible locations in Evolution API payload
        const base64Source = deepMsg?.base64 || msg?.base64 || data.message?.base64 || data.base64 || 
                           deepMsg?.imageMessage?.base64 || deepMsg?.audioMessage?.base64 || 
                           deepMsg?.videoMessage?.base64 || deepMsg?.documentMessage?.base64 ||
                           deepMsg?.image?.base64 || deepMsg?.audio?.base64 ||
                           deepMsg?.video?.base64 || deepMsg?.document?.base64 ||
                           data.message?.image?.base64 || data.message?.video?.base64;

        const mimeSource = deepMsg?.mimetype || msg?.mimetype || data.message?.mimetype || data.mimetype ||
                          deepMsg?.imageMessage?.mimetype || deepMsg?.audioMessage?.mimetype ||
                          deepMsg?.videoMessage?.mimetype || deepMsg?.documentMessage?.mimetype ||
                          deepMsg?.image?.mimetype || deepMsg?.audio?.mimetype ||
                          deepMsg?.video?.mimetype || deepMsg?.document?.mimetype ||
                          data.message?.image?.mimetype || data.message?.video?.mimetype;
        
        if (base64Source) {
          mediaInfo.mediaUrl = base64Source.startsWith('data:') ? base64Source : `data:${mimeSource || 'image/jpeg'};base64,${base64Source}`;
          
          // Identify message type if it wasn't already
          if (!mediaInfo.messageType || mediaInfo.messageType === 'text') {
            if (mimeSource?.startsWith('image/')) mediaInfo.messageType = 'image';
            else if (mimeSource?.startsWith('audio/')) mediaInfo.messageType = 'audio';
            else if (mimeSource?.startsWith('video/')) mediaInfo.messageType = 'video';
            else mediaInfo.messageType = 'document';
          }
          
          console.log(`✅ [WEBHOOK-MEDIA] Mídia encontrada no payload (v2 structure detected, type: ${mediaInfo.messageType})`);
        }
      }

      const finalMessageType = mediaInfo.messageType || 'text';
      let finalMediaUrl = mediaInfo.mediaUrl || null;
      const finalContent = messageText || (finalMessageType !== 'text' ? `[Mídia: ${finalMessageType}]` : '');
      
      // 🔧 MELHORADO: Se for mídia, garantir que temos a URL/base64
      // Prioridade: 1) Tentar getBase64FromMediaMessage (mais confiável), 2) Usar URL do payload se disponível
      if (finalMessageType !== 'text' && messageId) {
        const instanceName = process.env.EVOLUTION_INSTANCE_NAME;
        
        // Sempre tentar baixar via getBase64FromMediaMessage primeiro (mais confiável que URLs que expiram)
        if (instanceName) {
          try {
            console.log(`📥 [WEBHOOK-MEDIA] Baixando mídia via getBase64FromMediaMessage: ${messageId}`);
            const messageKey = {
              id: messageId,
              remoteJid: data.key?.remoteJid,
              fromMe: data.key?.fromMe
            };
            const messageTimestamp = data.messageTimestamp;
            const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(instanceName, messageKey, messageTimestamp);
            if (mediaResult.success && mediaResult.base64) {
              const mimeType = mediaResult.mimetype || mediaInfo.mediaType || 'application/octet-stream';
              finalMediaUrl = `data:${mimeType};base64,${mediaResult.base64}`;
              console.log(`✅ [WEBHOOK-MEDIA] Mídia baixada com sucesso via API: ${mimeType}`);
            } else {
              console.warn(`⚠️ [WEBHOOK-MEDIA] Falha ao baixar via API: ${mediaResult.error}`);
            }
          } catch (downloadErr: any) {
            console.warn(`⚠️ [WEBHOOK-MEDIA] Erro ao baixar via API: ${downloadErr.message}`);
          }
        }
        
        // Fallback: Se não conseguiu baixar via API, tentar usar URL do WhatsApp (pode estar expirada)
        if (!finalMediaUrl && mediaInfo.mediaUrl && mediaInfo.mediaUrl.startsWith('http')) {
          console.log(`📥 [WEBHOOK-MEDIA] Tentando URL direta do WhatsApp: ${mediaInfo.mediaUrl.substring(0, 80)}...`);
          finalMediaUrl = mediaInfo.mediaUrl;
        }
        
        // Se ainda não temos mídia, logar mas continuar (mensagem será salva com placeholder)
        if (!finalMediaUrl) {
          console.warn(`⚠️ [WEBHOOK-MEDIA] Não foi possível obter mídia para mensagem ${messageId}. Será salva como placeholder.`);
        }
      }
      
      debugInfo.normalizedPhone = normalizedPhone;
      debugInfo.isFromMe = isFromMe;
      debugInfo.messageText = messageText.substring(0, 50);
      debugInfo.steps.push('4-normalize-phone');
      
      console.log(`📱 [WEBHOOK-MIRROR] Processando: ${normalizedPhone} | FromMe: ${isFromMe} | Texto: ${messageText.substring(0, 50)}`);

      // 🔍 Buscar contato na agenda (Phonebook) para identificação prioritária
      debugInfo.steps.push('5-lookup-phonebook');
      const phonebookContact = await storage.getPhonebookContactByPhone(normalizedPhone);
      const identifiedName = phonebookContact?.name || data.pushName || `Cliente ${normalizedPhone}`;
      debugInfo.identifiedName = identifiedName;
      
      if (phonebookContact) {
        console.log(`📖 [WEBHOOK-MIRROR] Contato identificado na agenda: ${identifiedName}`);
      }

      // 1. Garantir Cliente e Conversa
      debugInfo.steps.push('6-get-customer-conversation');
      let conversation = await storage.getChatConversationByPhone(normalizedPhone);
      let customer = await storage.getChatCustomerByPhone(normalizedPhone);
      debugInfo.existingCustomer = !!customer;
      debugInfo.existingConversation = !!conversation;

      if (!customer) {
        debugInfo.steps.push('7a-create-customer');
        customer = await storage.createChatCustomer({
          phone: normalizedPhone,
          name: identifiedName
        });
        debugInfo.createdCustomerId = customer.id;
      } else if (phonebookContact && customer.name !== identifiedName) {
        // Atualizar nome do cliente se mudou na agenda
        await storage.updateChatCustomer(customer.id, { name: identifiedName });
      }

      if (!conversation) {
        debugInfo.steps.push('7b-create-conversation');
        conversation = await storage.createChatConversation({
          customerId: customer.id,
          customerName: identifiedName,
          customerPhone: normalizedPhone,
          status: 'new',
          priority: 'normal'
        });
        debugInfo.createdConversationId = conversation.id;
        
        // 🔄 Distribuir nova conversa para atendente disponível (round-robin)
        try {
          debugInfo.steps.push('7c-distribute-conversation');
          const { distributeNewConversation } = await import("./chat-distribution-service");
          await distributeNewConversation(conversation.id);
          console.log(`🔄 [WEBHOOK] Nova conversa ${conversation.id} distribuída via round-robin`);
        } catch (distErr: any) {
          console.error(`⚠️ [WEBHOOK] Erro ao distribuir conversa:`, distErr.message);
        }
      } else if (phonebookContact && conversation.customerName !== identifiedName) {
        // Atualizar nome na conversa se mudou na agenda
        await storage.updateChatConversation(conversation.id, { customerName: identifiedName });
      }
// 1841: etiqueta de canal + janela 24h + opt-out (canal oficial)
   if (!isFromMe && (data as any).__channelId === 'ajqNf-Vjp4yjcaJf') {
     try {
       await db.execute(sql`UPDATE chat_conversations SET last_inbound_channel='oficial_1841', window_open_until = now() + interval '24 hours' WHERE id = ${conversation.id}`);
       const _txt = (finalContent || '').trim().toLowerCase();
       if (['sair','parar','descadastrar','cancelar','remover'].includes(_txt)) {
         await db.execute(sql`UPDATE chat_customers SET whatsapp_opt_out = true, whatsapp_opt_out_at = now() WHERE id = ${customer.id}`);
         console.log('[OFICIAL-OPTOUT] ' + normalizedPhone + ' pediu SAIR');
       }
       console.log('[OFICIAL-INBOUND] canal 1841 -> janela 24h aberta, conversa ' + conversation.id);
     } catch (e) { console.error('[OFICIAL-INBOUND] erro', e); }
   }
      // 2. Verificar duplicidade (externalId)
      debugInfo.steps.push('8-check-duplicate');
      const existingMessages = await storage.getChatMessages(conversation.id);
      const isDuplicate = existingMessages.some(m => m.externalId === messageId);
      debugInfo.messageCount = existingMessages.length;
      
      if (isDuplicate) {
        console.log(`⏭️  [WEBHOOK-MIRROR] Mensagem duplicada ignorada: ${messageId}`);
        return res.json({ success: true, duplicate: true, debug: debugInfo });
      }

      // 🔁 ANTI-ECO (webhook): o Umbler reenvia p/ cá as mensagens ENVIADAS por nós — às vezes 2x,
      // uma como 'member' → 'system' e outra sem Source → 'customer', com externalIds diferentes,
      // então o dedup por externalId acima não pega. Se já existe uma saída nossa (agent/system) com
      // o MESMO conteúdo nos últimos 3 min, é eco → ignora (não duplica). NÃO afeta espelhamento:
      // msg enviada de fora (número pessoal) não tem registro prévio nosso → passa e é espelhada.
      if (finalMessageType === 'text' && finalContent && finalContent.trim()) {
        const _incEco = finalContent.trim();
        const _nowEco = Date.now();
        const _isEco = existingMessages.some((m: any) =>
          (m.senderType === 'agent' || m.senderType === 'system') &&
          String(m.content || '').trim() === _incEco &&
          (_nowEco - new Date(m.createdAt as any).getTime()) < 3 * 60 * 1000
        );
        if (_isEco) {
          console.log(`🔁 [WEBHOOK-ANTI-ECO] Eco de mensagem enviada ignorado: ${normalizedPhone} | ${_incEco.substring(0, 40)}`);
          return res.json({ success: true, echoIgnored: true, debug: debugInfo });
        }
      }

      // 3. Salvar Mensagem (com suporte a mídia)
      debugInfo.steps.push('9-save-message');
      
      console.log(`📎 [WEBHOOK-MEDIA] Tipo: ${finalMessageType} | URL: ${finalMediaUrl ? 'SIM' : 'NÃO'} | Conteúdo: ${finalContent.substring(0, 30)}`);
      
      // 🗄️ NOVO: Salvar mídia no Object Storage externo se houver
      let storedMediaUrl = finalMediaUrl;
      if (finalMediaUrl && finalMessageType !== 'text') {
        try {
          debugInfo.steps.push('9a-upload-media-to-storage');
          const { uploadWhatsAppMediaToStorage, uploadMediaFromBase64 } = await import("./whatsapp-media-storage");
          
          if (finalMediaUrl.startsWith('data:')) {
            // É base64, extrair e fazer upload
            const mimeMatch = finalMediaUrl.match(/data:([^;]+);base64,/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
            const base64Data = finalMediaUrl.replace(/^data:[^;]+;base64,/, '');
            
            const uploadResult = await uploadMediaFromBase64(base64Data, mimeType);
            if (uploadResult.success && uploadResult.objectPath) {
              storedMediaUrl = uploadResult.objectPath;
              console.log(`✅ [WEBHOOK-MEDIA] Mídia base64 salva no Object Storage: ${storedMediaUrl}`);
            }
          } else if (finalMediaUrl.startsWith('http')) {
            // É URL externa, baixar e fazer upload
            const uploadResult = await uploadWhatsAppMediaToStorage(finalMediaUrl, mediaInfo.mediaType || 'image/jpeg', mediaInfo.mediaFilename);
            if (uploadResult.success && uploadResult.objectPath) {
              storedMediaUrl = uploadResult.objectPath;
              console.log(`✅ [WEBHOOK-MEDIA] Mídia URL salva no Object Storage: ${storedMediaUrl}`);
            }
          }
        } catch (uploadErr: any) {
          console.error(`⚠️ [WEBHOOK-MEDIA] Erro ao salvar mídia no Object Storage:`, uploadErr.message);
          // Continua com a URL original se houver erro
        }
      }
      
      const savedMsg = await storage.createChatMessage({
        conversationId: conversation.id,
        senderId: isFromMe ? 'system' : (customer?.id || 'unknown'),
        senderType: isFromMe ? 'system' : 'customer',
        content: finalContent,
        messageType: finalMessageType,
        mediaUrl: storedMediaUrl,
        externalId: messageId,
        isRead: true
      });

      // 🎤 Transcricao de audio recebido (OpenAI Whisper) — fire-and-forget, atualiza a mensagem
      if (finalMessageType === 'audio' && !isFromMe && savedMsg?.id) {
        const audioSrc = finalMediaUrl;
        const audioMime = mediaInfo.mediaType;
        (async () => {
          const transcript = await transcribeAudioSource(audioSrc as string, audioMime);
          if (transcript) {
            await storage.updateChatMessage(savedMsg.id, {
              content: '🎤 ' + transcript,
              metadata: { ...((savedMsg as any).metadata || {}), transcription: transcript, transcribedAt: new Date().toISOString() },
            } as any);
            console.log(`🎤 [TRANSCRIBE] Audio transcrito (${savedMsg.id}): ${transcript.slice(0, 60)}`);
          }
        })().catch((e: any) => console.error('[TRANSCRIBE] fire-and-forget erro:', e && e.message ? e.message : String(e)));
      }

      // 4. Atualizar Conversa - Forçar lastMessageTime para ordenação
      // IMPORTANTE: NÃO mudar status para 'new' se conversa já tem agente atribuído
      // Isso evita redistribuição indesejada de conversas que já estão em atendimento
      debugInfo.steps.push('10-update-conversation');
      const hasAssignedAgent = !!conversation.assignedAgentId;
      const newStatus = isFromMe ? conversation.status : (hasAssignedAgent ? conversation.status : 'new');
      
      await storage.updateChatConversation(conversation.id, {
        updatedAt: nowBrazil(),
        lastMessageTime: nowBrazil(),
        status: newStatus,
        unreadCount: 0
      });
      
      console.log(`📝 [WEBHOOK] Status: ${conversation.status} -> ${newStatus} | Agente: ${conversation.assignedAgentId || 'nenhum'} | Mantido: ${hasAssignedAgent}`);

      // 🤖 NOVO: Acionar resposta automática do ChatGPT se estiver habilitado
      // SÓ acionar IA se:
      // 1. Mensagem é do CLIENTE (não do sistema)
      // 2. ChatGPT está habilitado
      // 3. Conversa está atribuída ao ChatGPT OU é nova/reaberta (não atribuída a atendente humano)
      if (!isFromMe) {
        debugInfo.steps.push('10a-ai-trigger');
        try {
          const aiSettings = await storage.getChatAiSettings();
          
          // IMPORTANTE: Recarregar conversa para pegar o status atualizado (linha 1270-1275 atualizou para 'new')
          const currentConversation = await storage.getChatConversation(conversation.id);
          
          if (!currentConversation) {
            console.error(`❌ [WEBHOOK-AI] Conversa ${conversation.id} não encontrada após atualização`);
          } else {
            // Verificar se a conversa está atribuída ao ChatGPT ou é nova/reaberta
            const isAssignedToChatGpt = currentConversation.assignedAgentId === 'chatgpt';
            // Conversa é "nova" se: não tem agente atribuído OU status é 'new'
            const isNewOrReopened = !currentConversation.assignedAgentId || currentConversation.status === 'new';
            const isAssignedToHuman = currentConversation.assignedAgentId && 
                                      currentConversation.assignedAgentId !== 'chatgpt';
            
            console.log(`🔍 [WEBHOOK-AI] Status: ${currentConversation.status} | Agent: ${currentConversation.assignedAgentId || 'nenhum'} | isNew: ${isNewOrReopened} | isHuman: ${isAssignedToHuman} | isChatGPT: ${isAssignedToChatGpt}`);
            
            // 🚫 SPAM/GRUPO FILTER: Não processar mensagens de contatos marcados como SPAM ou GRUPO
            const isSpamContact = identifiedName.toUpperCase().includes('SPAM');
            const isGrupoContact = identifiedName.toUpperCase().includes('GRUPO');
            if (isSpamContact) {
              console.log(`🚫 [WEBHOOK-AI] Contato "${identifiedName}" marcado como SPAM - IGNORANDO resposta automática`);
              // Não distribuir nem responder - apenas arquivar silenciosamente
            } else if (isGrupoContact) {
              console.log(`🚫 [WEBHOOK-AI] Contato "${identifiedName}" marcado como GRUPO - IGNORANDO resposta automática`);
              // Não distribuir nem responder - apenas arquivar silenciosamente
            } else if (isAssignedToHuman) {
              // 🔒 REGRA: Conversas atribuídas a humanos PERMANECEM com eles até serem finalizadas
              console.log(`👤 [WEBHOOK-AI] Conversa ${conversation.id} atribuída a atendente humano (${currentConversation.assignedAgentId}) - MANTENDO atribuição`);
            } else if (isAssignedToChatGpt) {
              // 🤖 REGRA: Conversas do ChatGPT PERMANECEM com ele (até transferência explícita)
              console.log(`🤖 [WEBHOOK-AI] Conversa ${conversation.id} atribuída ao ChatGPT - MANTENDO atribuição`);
              
              if (aiSettings && aiSettings.isEnabled && aiSettings.mode !== 'disabled') {
                const { handleIncomingMessage } = await import("./chatgpt-service");
                handleIncomingMessage(
                  {
                    id: conversation.id,
                    customerName: identifiedName,
                    customerPhone: normalizedPhone
                  },
                  {
                    content: finalContent,
                    timestamp: nowBrazil()
                  },
                  aiSettings
                ).catch(err => console.error(`❌ [WEBHOOK-AI] Erro ao processar resposta da IA:`, err));
              }
            } else if (!currentConversation.assignedAgentId) {
              // 🆕 NOVA CONVERSA: Ainda não foi atribuída a ninguém - distribuir
              console.log(`🆕 [WEBHOOK-AI] Conversa ${conversation.id} SEM atribuição - distribuindo...`);
              
              if (aiSettings && aiSettings.isEnabled && aiSettings.mode !== 'disabled') {
                // ChatGPT ativado - distribuir (vai para ChatGPT por padrão)
                const { distributeNewConversation } = await import("./chat-distribution-service");
                const distribution = await distributeNewConversation(conversation.id);
                
                if (distribution.isChatGpt) {
                  const { handleIncomingMessage } = await import("./chatgpt-service");
                  handleIncomingMessage(
                    {
                      id: conversation.id,
                      customerName: identifiedName,
                      customerPhone: normalizedPhone
                    },
                    {
                      content: finalContent,
                      timestamp: nowBrazil()
                    },
                    aiSettings
                  ).catch(err => console.error(`❌ [WEBHOOK-AI] Erro ao processar resposta da IA:`, err));
                } else {
                  console.log(`👤 [WEBHOOK-AI] Nova conversa distribuída para atendente humano: ${distribution.assignedTo}`);
                }
              } else {
                // ChatGPT desativado - distribuir para humanos
                const { distributeNewConversation } = await import("./chat-distribution-service");
                const distribution = await distributeNewConversation(conversation.id);
                console.log(`👤 [WEBHOOK-AI] ChatGPT DESATIVADO - Nova conversa distribuída para: ${distribution.assignedTo || 'fila'}`);
              }
            }
          }
        } catch (aiErr: any) {
          console.error(`⚠️ [WEBHOOK-AI] Erro ao verificar configurações de IA:`, aiErr.message);
        }
      }

      debugInfo.steps.push('11-complete');
      console.log(`✅ [WEBHOOK-MIRROR] Sucesso total: ${normalizedPhone}`);
      res.json({ success: true, debug: debugInfo });
    } catch (error: any) {
      debugInfo.error = error.message;
      debugInfo.stack = error.stack?.split('\n').slice(0, 5);
      console.error("❌ [WEBHOOK-MIRROR] Erro Crítico:", error.message);
      res.status(200).json({ error: error.message, debug: debugInfo });
    }
  });

  // ============================================================
  // SDR DIGITAL ROUTES
  // ============================================================

  // Send WhatsApp message via Evolution API
  app.post("/api/chat/send-message", authenticateUser, async (req, res) => {
    try {
      const { phoneNumber, message, messageType = 'text', mediaUrl, caption } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }

      if (!message && messageType === 'text') {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }

      // Normalizar telefone
      let targetPhone = phoneNumber;
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      // Buscar mapeamento no banco de dados (correspondência exata apenas)
      const phoneMapping = await storage.getPhoneMappingBySource(cleanPhone);
      
      if (phoneMapping) {
        targetPhone = phoneMapping.canonicalPhone;
        console.log(`🔄 [WHATSAPP-SEND] Remapeando via DB: ${phoneNumber} -> ${targetPhone}`);
      }
      
      const normalizedPhone = normalizePhoneNumber(targetPhone);
      console.log(`📨 [WHATSAPP-SEND] Enviando para: ${phoneNumber} -> ${normalizedPhone}`);

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Configure a Evolution API primeiro." });
      }

      console.log(`📨 [WHATSAPP-SEND] Enviando mensagem para ${normalizedPhone} via ${messageType}`);

      // Determinar tipo de mídia real e normalizar
      const isMediaMessage = ['media', 'image', 'audio', 'video', 'document'].includes(messageType);
      const actualMediaType = messageType === 'media' ? 'image' : messageType as 'text' | 'image' | 'audio' | 'video' | 'document';
      
      // Validar que mídia tem mediaUrl
      if (isMediaMessage && !mediaUrl) {
        return res.status(400).json({ error: "mediaUrl é obrigatório para envio de mídia" });
      }

      let result;
      if (isMediaMessage && mediaUrl) {
        console.log(`📤 [WHATSAPP-SEND] Processando mídia: ${mediaUrl}`);
        
        // Convert Object Storage URLs to base64 for Evolution API
        let finalMediaUrl = mediaUrl;
        let detectedMimetype: string | undefined;
        let detectedFileName: string | undefined;
        
        const mimeTypes: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.mp3': 'audio/mpeg',
          '.ogg': 'audio/ogg',
          '.wav': 'audio/wav',
          '.pdf': 'application/pdf',
          '.doc': 'application/msword',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xls': 'application/vnd.ms-excel',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        };
        
        // Handle Object Storage URLs - convert to base64
        if (mediaUrl.startsWith('/api/storage-image/')) {
          try {
            const storagePathMatch = mediaUrl.match(/^\/api\/storage-image\/([^/]+)\/(.+)$/);
            console.log(`📤 [WHATSAPP-SEND] Object Storage match: ${storagePathMatch ? 'success' : 'failed'}`);
            if (storagePathMatch) {
              const [, bucketName, objectPath] = storagePathMatch;
              console.log(`📤 [WHATSAPP-SEND] Buscando do Object Storage: bucket=${bucketName}, object=${objectPath}`);
              
              const bucket = objectStorageClient.bucket(bucketName);
              const file = bucket.file(objectPath);
              
              const [exists] = await file.exists();
              console.log(`📤 [WHATSAPP-SEND] Arquivo existe: ${exists}`);
              
              if (exists) {
                const [fileBuffer] = await file.download();
                const base64Data = fileBuffer.toString('base64');
                const filename = path.basename(objectPath);
                
                const ext = path.extname(filename).toLowerCase();
                detectedMimetype = mimeTypes[ext] || 'application/octet-stream';
                detectedFileName = filename;
                
                finalMediaUrl = `data:${detectedMimetype};base64,${base64Data}`;
                console.log(`📤 [WHATSAPP-SEND] Convertido para base64: ${detectedMimetype} (${Math.round(base64Data.length / 1024)}KB)`);
              } else {
                console.error(`❌ [WHATSAPP-SEND] Arquivo não encontrado: ${objectPath}`);
                return res.status(404).json({ error: "Arquivo de mídia não encontrado" });
              }
            }
          } catch (storageErr: any) {
            console.error(`❌ [WHATSAPP-SEND] Erro ao buscar do Object Storage:`, storageErr.message);
            return res.status(500).json({ error: "Erro ao processar arquivo de mídia" });
          }
        }
        // Handle legacy /uploads/ paths
        else if (mediaUrl.startsWith('/uploads/') || mediaUrl.includes('attached_assets')) {
          try {
            let filePath = mediaUrl;
            if (mediaUrl.startsWith('/uploads/')) {
              filePath = path.join(process.cwd(), mediaUrl.substring(1));
            }
            
            if (fs.existsSync(filePath)) {
              const fileBuffer = fs.readFileSync(filePath);
              const base64Data = fileBuffer.toString('base64');
              const filename = path.basename(filePath);
              
              const ext = path.extname(filename).toLowerCase();
              detectedMimetype = mimeTypes[ext] || 'application/octet-stream';
              detectedFileName = filename;
              
              finalMediaUrl = `data:${detectedMimetype};base64,${base64Data}`;
              console.log(`📤 [WHATSAPP-SEND] Arquivo local convertido: ${detectedMimetype} (${Math.round(base64Data.length / 1024)}KB)`);
            } else {
              console.error(`❌ [WHATSAPP-SEND] Arquivo local não encontrado: ${filePath}`);
              return res.status(404).json({ error: "Arquivo de mídia não encontrado" });
            }
          } catch (fileErr: any) {
            console.error(`❌ [WHATSAPP-SEND] Erro ao processar arquivo local:`, fileErr.message);
            return res.status(500).json({ error: "Erro ao processar arquivo de mídia" });
          }
        }
        
        result = await evolutionAPIService.sendMediaMessage(
          config.instanceName, 
          normalizedPhone, 
          finalMediaUrl, 
          caption, 
          actualMediaType as 'image' | 'audio' | 'video' | 'document',
          3,
          { mimetype: detectedMimetype, fileName: detectedFileName }
        );
      } else if (messageType === 'location' && req.body.latitude && req.body.longitude) {
        result = await evolutionAPIService.sendLocationMessage(config.instanceName, normalizedPhone, req.body.latitude, req.body.longitude, caption);
      } else {
        result = await evolutionAPIService.sendTextMessage(config.instanceName, normalizedPhone, message);
      }

      if (!result.success) {
        console.error(`❌ [WHATSAPP-SEND] Erro ao enviar:`, result.error);
        return res.status(500).json({ error: result.error || "Erro ao enviar mensagem" });
      }

      // Save message to conversation history (SEMPRE SALVAR, nunca ignorar)
      try {
        // 1. Buscar ou criar cliente
        let customer = await storage.getChatCustomerByPhone(normalizedPhone);
        if (!customer) {
          customer = await storage.createChatCustomer({
            phone: normalizedPhone,
            name: `Cliente ${normalizedPhone}`
          });
          console.log(`✅ [WHATSAPP-SEND] Cliente criado: ${customer.id}`);
        }

        // 2. Usar UPSERT para garantir uma única conversa por telefone
        const conversation = await storage.upsertChatConversation({
          customerId: customer.id,
          customerName: customer.name || `Cliente ${normalizedPhone}`,
          customerPhone: normalizedPhone,
          status: 'new' as const,
          priority: 'normal' as const,
          lastMessageTime: nowBrazil(),
          updatedAt: nowBrazil()
        });
        console.log(`✅ [WHATSAPP-SEND] Conversa: ${conversation.id}`);

      // 3. Salvar mensagem ENVIADA com tipo normalizado
        await storage.createChatMessage({
          conversationId: conversation.id,
          senderId: (req as any).user?.id || "system",
          senderType: "system",
          content: message || caption || (actualMediaType !== 'text' ? `[${actualMediaType}]` : ''),
          messageType: actualMediaType as any,
          mediaUrl: mediaUrl,
          externalId: result.messageId
        });
        console.log(`💬 [WHATSAPP-SEND] Mensagem salva`);
      } catch (err) {
        console.error("[CHAT] Error saving message history:", err);
        // Não falhar o envio se falhar ao salvar histórico
      }

      console.log(`✅ [WHATSAPP-SEND] Mensagem enviada com sucesso para ${normalizedPhone}`);
      res.json({ 
        success: true, 
        messageId: result.messageId,
        message: "Mensagem enviada com sucesso"
      });
    } catch (error) {
      console.error("[CHAT] Send message error:", error);
      res.status(500).json({ error: "Erro ao enviar mensagem" });
    }
  });

  // ============================================================
  // DISPARO EM MASSA - BULK WHATSAPP MESSAGING
  // ============================================================

  // Estado global do disparo em massa (por usuário)
  const bulkMessageJobs: Map<string, {
    status: 'running' | 'paused' | 'stopped' | 'completed';
    totalContacts: number;
    sentCount: number;
    successCount: number;
    errorCount: number;
    startedAt: Date;
    pausedAt?: Date;
  }> = new Map();

  // Verificar status do disparo
  app.get("/api/chat/bulk-message/status", authenticateUser, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id || 'default';
      const job = bulkMessageJobs.get(userId);
      
      if (!job) {
        return res.json({ active: false });
      }
      
      res.json({
        active: job.status === 'running' || job.status === 'paused',
        status: job.status,
        totalContacts: job.totalContacts,
        sentCount: job.sentCount,
        successCount: job.successCount,
        errorCount: job.errorCount,
        progress: Math.round((job.sentCount / job.totalContacts) * 100),
        startedAt: job.startedAt
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Pausar disparo
  app.post("/api/chat/bulk-message/pause", authenticateUser, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id || 'default';
      const job = bulkMessageJobs.get(userId);
      
      if (!job || job.status !== 'running') {
        return res.status(400).json({ error: "Nenhum disparo em andamento" });
      }
      
      job.status = 'paused';
      job.pausedAt = nowBrazil();
      console.log(`⏸️ [BULK] Disparo pausado pelo usuário ${userId}`);
      
      res.json({ success: true, message: "Disparo pausado" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Continuar disparo
  app.post("/api/chat/bulk-message/resume", authenticateUser, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id || 'default';
      const job = bulkMessageJobs.get(userId);
      
      if (!job || job.status !== 'paused') {
        return res.status(400).json({ error: "Nenhum disparo pausado" });
      }
      
      job.status = 'running';
      delete job.pausedAt;
      console.log(`▶️ [BULK] Disparo retomado pelo usuário ${userId}`);
      
      res.json({ success: true, message: "Disparo retomado" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Encerrar disparo
  app.post("/api/chat/bulk-message/stop", authenticateUser, async (req, res) => {
    try {
      const userId = (req as any).currentUser?.id || 'default';
      const job = bulkMessageJobs.get(userId);
      
      if (!job || (job.status !== 'running' && job.status !== 'paused')) {
        return res.status(400).json({ error: "Nenhum disparo em andamento" });
      }
      
      job.status = 'stopped';
      console.log(`⏹️ [BULK] Disparo encerrado pelo usuário ${userId} - ${job.sentCount}/${job.totalContacts} enviados`);
      
      res.json({ 
        success: true, 
        message: "Disparo encerrado",
        sentCount: job.sentCount,
        successCount: job.successCount,
        errorCount: job.errorCount
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Upload spreadsheet and parse phone numbers
  app.post("/api/chat/bulk-message/parse", authenticateUser, requireRole(["admin", "coordinator", "telemarketing"]), upload.single("file"), async (req, res) => {
    try {
      console.log(`[BULK] Parsing spreadsheet...`, req.file ? { 
        filename: req.file.filename, 
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
        hasBuffer: !!req.file.buffer
      } : "No file");

      if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }

      const XLSX = await import("xlsx");
      let workbook;
      
      // Using memoryStorage - read from buffer first (primary method)
      if (req.file.buffer && req.file.buffer.length > 0) {
        console.log(`[BULK] Reading file from buffer (${req.file.buffer.length} bytes)`);
        workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      } else if (req.file.path && fs.existsSync(req.file.path)) {
        // Fallback to disk if buffer not available
        console.log(`[BULK] Reading file from path: ${req.file.path}`);
        try {
          workbook = XLSX.readFile(req.file.path);
        } catch (readErr: any) {
          console.error(`[BULK] Error reading file via XLSX.readFile:`, readErr.message);
          const fileBuffer = fs.readFileSync(req.file.path);
          workbook = XLSX.read(fileBuffer, { type: "buffer" });
        }
      } else {
        console.error(`[BULK] No file buffer or valid path found`);
        return res.status(400).json({ error: "Dados do arquivo não encontrados no servidor" });
      }
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { header: 1 });

      // Find phone column (looking for common header names)
      const headers = data[0] as string[];
      const phoneColumnIndex = headers?.findIndex((h: string) => 
        h && typeof h === 'string' && 
        (h.toLowerCase().includes('telefone') || 
         h.toLowerCase().includes('phone') || 
         h.toLowerCase().includes('celular') || 
         h.toLowerCase().includes('whatsapp') ||
         h.toLowerCase().includes('numero') ||
         h.toLowerCase().includes('número') ||
         h.toLowerCase() === 'tel')
      );

      // Find name column if exists
      const nameColumnIndex = headers?.findIndex((h: string) => 
        h && typeof h === 'string' && 
        (h.toLowerCase().includes('nome') || 
         h.toLowerCase().includes('name') ||
         h.toLowerCase().includes('cliente'))
      );

      if (phoneColumnIndex === -1) {
        // If no header found, assume first column is phone
        console.log(`⚠️ Coluna de telefone não encontrada pelo cabeçalho. Usando primeira coluna.`);
      }

      const colIndex = phoneColumnIndex !== -1 ? phoneColumnIndex : 0;
      const nameColIndex = nameColumnIndex !== -1 ? nameColumnIndex : -1;

      // Extract phone numbers (skip header row)
      const contacts: Array<{ phone: string; name: string; valid: boolean }> = [];
      const seen = new Set<string>();

      for (let i = 1; i < data.length; i++) {
        const row = data[i] as any[];
        if (!row || row.length === 0) continue;

        const rawValue = row[colIndex];
        if (rawValue === undefined || rawValue === null) continue;
        
        const rawPhone = String(rawValue).trim();
        if (!rawPhone) continue;

        const nameValue = nameColIndex !== -1 ? row[nameColIndex] : null;
        const name = nameValue ? String(nameValue).trim() : '';
        
        // Clean phone number
        const digitsOnly = rawPhone.replace(/\D/g, '');
        
        if (digitsOnly.length >= 8) {
          const normalized = normalizePhoneNumber(digitsOnly);
          
          if (!seen.has(normalized)) {
            seen.add(normalized);
            contacts.push({
              phone: normalized,
              name: name || `Contato ${i}`,
              valid: true
            });
          }
        }
      }

      // Cleanup uploaded file
      if (req.file.path) {
        fs.unlink(req.file.path, () => {});
      }

      console.log(`📊 [BULK] Planilha processada: ${contacts.length} contatos válidos de ${data.length - 1} linhas`);

      res.json({
        success: true,
        totalRows: data.length - 1,
        validContacts: contacts.length,
        contacts: contacts.slice(0, 500) // Limit to 500 for preview
      });
    } catch (error: any) {
      console.error("[BULK] Parse error:", error);
      res.status(500).json({ error: `Erro ao processar planilha: ${error.message}` });
    }
  });

  // Send bulk messages
  app.post("/api/chat/bulk-message/send", authenticateUser, requireRole(["admin", "coordinator", "telemarketing"]), async (req, res) => {
    try {
      const { contacts, message, delaySeconds = 3 } = req.body;
      const userId = (req as any).currentUser?.id || 'default';

      console.log(`[BULK] Starting message blast...`, { 
        contactsCount: contacts?.length,
        messagePreview: message?.substring(0, 30),
        delaySeconds 
      });

      if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ error: "Lista de contatos é obrigatória" });
      }

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }

      // Verificar se já há um disparo ativo
      const existingJob = bulkMessageJobs.get(userId);
      if (existingJob && (existingJob.status === 'running' || existingJob.status === 'paused')) {
        return res.status(400).json({ error: "Já existe um disparo em andamento. Encerre-o antes de iniciar outro." });
      }

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Configure a Evolution API primeiro." });
      }

      console.log(`📤 [BULK] Iniciando disparo em massa para ${contacts.length} contatos`);

      // Criar job de controle
      const job = {
        status: 'running' as const,
        totalContacts: contacts.length,
        sentCount: 0,
        successCount: 0,
        errorCount: 0,
        startedAt: nowBrazil()
      };
      bulkMessageJobs.set(userId, job);

      const delay = Math.max(1, Math.min(30, delaySeconds || 3)) * 1000;

      // Return immediately with job started
      res.json({
        success: true,
        message: `Disparo iniciado para ${contacts.length} contatos`,
        totalContacts: contacts.length,
        estimatedTimeMinutes: Math.ceil((contacts.length * delay) / 60000)
      });

      // Process messages in background
      (async () => {
        for (let i = 0; i < contacts.length; i++) {
          const currentJob = bulkMessageJobs.get(userId);
          
          // Verificar se foi parado
          if (!currentJob || currentJob.status === 'stopped') {
            console.log(`⏹️ [BULK] Disparo encerrado pelo usuário após ${i} mensagens`);
            break;
          }
          
          // Se pausado, aguardar até retomar ou parar
          while (currentJob && currentJob.status === 'paused') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const updatedJob = bulkMessageJobs.get(userId);
            if (!updatedJob || updatedJob.status === 'stopped') {
              console.log(`⏹️ [BULK] Disparo encerrado enquanto pausado`);
              return;
            }
            if (updatedJob.status === 'running') break;
          }
          
          const contact = contacts[i];
          
          try {
            const personalizedMessage = message.replace(/\{\{nome\}\}/gi, contact.name || 'Cliente');
            
            const result = await evolutionAPIService.sendTextMessage(
              config.instanceName,
              contact.phone,
              personalizedMessage
            );

            const jobRef = bulkMessageJobs.get(userId);
            if (jobRef) {
              jobRef.sentCount++;
              if (result.success) {
                jobRef.successCount++;
              } else {
                jobRef.errorCount++;
              }
            }

            console.log(`📤 [BULK] ${i + 1}/${contacts.length}: ${contact.phone} - ${result.success ? '✅' : '❌ ' + result.error}`);

            if (i < contacts.length - 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } catch (error: any) {
            const jobRef = bulkMessageJobs.get(userId);
            if (jobRef) {
              jobRef.sentCount++;
              jobRef.errorCount++;
            }
            console.error(`❌ [BULK] Erro ao enviar para ${contact.phone}:`, error.message);
          }
        }

        // Marcar como concluído
        const finalJob = bulkMessageJobs.get(userId);
        if (finalJob && finalJob.status === 'running') {
          finalJob.status = 'completed';
        }
        console.log(`📊 [BULK] Disparo concluído: ${finalJob?.successCount || 0}/${contacts.length} enviados com sucesso`);
      })();

    } catch (error: any) {
      console.error("[BULK] Send error:", error);
      res.status(500).json({ error: `Erro ao enviar mensagens: ${error.message}` });
    }
  });

  // Download sample spreadsheet template
  app.get("/api/chat/bulk-message/template", authenticateUser, async (req, res) => {
    try {
      const XLSX = await import("xlsx");
      
      // Create sample workbook
      const sampleData = [
        ["Nome", "Telefone"],
        ["João Silva", "62999991111"],
        ["Maria Santos", "62999992222"],
        ["Pedro Oliveira", "(62) 99999-3333"]
      ];
      
      const worksheet = XLSX.utils.aoa_to_sheet(sampleData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Contatos");
      
      const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename=modelo_disparo_whatsapp.xlsx");
      res.send(buffer);
    } catch (error: any) {
      console.error("[BULK] Template error:", error);
      res.status(500).json({ error: "Erro ao gerar modelo" });
    }
  });

  // ============================================================
  // TELEGRAM SETUP ROUTES
  // ============================================================

  // Get Telegram status
  app.get("/api/chat/telegram/status", authenticateUser, async (req, res) => {
    try {
      const status = await telegramService.getStatus();
      res.json(status);
    } catch (error) {
      console.error("[CHAT] Telegram status error:", error);
      res.status(500).json({ error: "Erro ao buscar status do Telegram" });
    }
  });

  // Setup Telegram
  app.post(
    "/api/chat/telegram/setup",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const { botToken } = req.body;
        
        if (!botToken) {
          return res.status(400).json({ error: "Token do bot é obrigatório" });
        }

        // Store token in system settings for later use
        await storage.upsertSystemSetting({ key: "telegram_bot_token", value: botToken, description: "Token do bot do Telegram" });
        res.json({ success: true, message: "Token salvo com sucesso" });
      } catch (error) {
        console.error("[CHAT] Telegram setup error:", error);
        res.status(500).json({ error: "Erro ao configurar Telegram" });
      }
    }
  );

  // ============================================================
  // WHATSAPP ANALYSIS ROUTES
  // ============================================================

  // Analyze WhatsApp conversation
  app.post("/api/chat/whatsapp/analyze", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertWhatsappConversationAnalysisSchema.parse(req.body);
      // Store the analysis request
      const analysis = await storage.createWhatsappAnalysis(validatedData);
      res.json(analysis);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] WhatsApp analysis error:", error);
      res.status(500).json({ error: "Erro ao analisar conversa do WhatsApp" });
    }
  });

  // ============================================================
  // WEBHOOK PARA RECEBER MENSAGENS DO WHATSAPP
  // ============================================================
  
  // GET endpoint para validação do webhook (Evolution API pode solicitar)
  app.get("/api/chat/webhook/messages", (req, res) => {
    console.log(`✅ [WEBHOOK-GET] Validação do webhook recebida`);
    res.status(200).json({ status: 'ok', message: 'Webhook is active' });
  });

  // Diagnóstico COMPLETO - verificar status da instância e webhook
  app.get("/api/chat/webhook/debug", async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      
      // 1. Verificar configuração
      const isConfigured = evolutionAPIService.isConfigured();
      
      // 2. Testar conexão com Evolution API
      const connectionTest = await evolutionAPIService.testConnection();
      
      // 3. Buscar status da instância
      const instanceStatus = await evolutionAPIService.getInstanceStatus(instanceName);
      
      // 4. Buscar status do webhook
      const webhookStatus = await evolutionAPIService.getWebhook(instanceName);
      
      // 5. Determinar diagnóstico
      let diagnostico = "PROBLEMAS IDENTIFICADOS:\n";
      let problemas = [];
      
      if (!isConfigured) {
        problemas.push("❌ Evolution API não configurada");
      } else {
        diagnostico += "✅ Evolution API configurada\n";
      }
      
      if (!connectionTest.success) {
        problemas.push(`❌ Conexão com Evolution API falhou: ${connectionTest.error}`);
      } else {
        diagnostico += "✅ Conexão com Evolution API OK\n";
      }
      
      if (!instanceStatus.success) {
        problemas.push(`❌ Status da instância indisponível: ${instanceStatus.error}`);
      } else if (instanceStatus.status !== 'open') {
        problemas.push(`❌ Instância não conectada (status: ${instanceStatus.status}). AÇÃO: Conectar ao WhatsApp usando QR Code`);
      } else {
        diagnostico += `✅ Instância ${instanceName} CONECTADA ao WhatsApp\n`;
      }
      
      if (!webhookStatus.success) {
        problemas.push(`❌ Webhook indisponível: ${webhookStatus.error}`);
      } else if (webhookStatus.webhook?.enabled !== true) {
        problemas.push("❌ Webhook não está ATIVO (disabled)");
      } else {
        diagnostico += "✅ Webhook ATIVO e pronto para receber mensagens\n";
      }
      
      res.json({
        success: true,
        diagnostico,
        problemas: problemas.length > 0 ? problemas : null,
        detalhes: {
          evolutionConfigured: isConfigured,
          connectionOk: connectionTest.success,
          instanceConnected: instanceStatus.status === 'open',
          instanceStatus: instanceStatus.status,
          webhookEnabled: webhookStatus.webhook?.enabled,
          webhookUrl: webhookStatus.webhook?.url
        },
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      console.error('[WEBHOOK-DEBUG] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para FORÇAR reconfiguração do webhook de PRODUÇÃO
  // Use este endpoint quando precisar garantir que o webhook aponte para produção
  app.post("/api/chat/webhook/force-production", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      const prodDomain = process.env.REPLIT_DOMAIN || (process.env.REPLIT_DOMAINS ? process.env.REPLIT_DOMAINS.split(',')[0] : null);
      
      if (!prodDomain) {
        return res.status(400).json({ 
          error: "Domínio de produção não encontrado", 
          message: "Não foi possível determinar o domínio de produção" 
        });
      }
      
      const webhookUrl = `https://${prodDomain}/api/chat/webhook/messages`;
      console.log(`🔧 [FORCE-PROD] Forçando webhook para produção: ${webhookUrl}`);
      
      const result = await evolutionAPIService.setWebhook(instanceName, webhookUrl);
      
      if (result.success) {
        console.log(`✅ [FORCE-PROD] Webhook reconfigurado com sucesso para produção`);
        res.json({ 
          success: true, 
          message: "Webhook reconfigurado para produção com sucesso",
          url: webhookUrl
        });
      } else {
        console.error(`❌ [FORCE-PROD] Erro:`, result.error);
        res.status(500).json({ error: result.error });
      }
    } catch (error: any) {
      console.error('[FORCE-PROD] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para FORÇAR reconfiguração do webhook de DESENVOLVIMENTO (apenas para testes)
  app.post("/api/chat/webhook/force-dev-config", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      
      if (!devDomain) {
        return res.status(400).json({ 
          error: "REPLIT_DEV_DOMAIN não encontrado", 
          message: "Este endpoint só funciona no ambiente de desenvolvimento" 
        });
      }
      
      const webhookUrl = `https://${devDomain}/api/chat/webhook/messages`;
      console.log(`🔧 [FORCE-DEV] Forçando webhook para desenvolvimento: ${webhookUrl}`);
      
      const result = await evolutionAPIService.setWebhook(instanceName, webhookUrl);
      
      if (result.success) {
        console.log(`✅ [FORCE-DEV] Webhook reconfigurado para desenvolvimento`);
        res.json({ 
          success: true, 
          message: "Webhook reconfigurado para desenvolvimento com sucesso",
          url: webhookUrl,
          warning: "ATENÇÃO: O webhook agora aponta para desenvolvimento. Mensagens de produção NÃO serão recebidas!"
        });
      } else {
        console.error(`❌ [FORCE-DEV] Erro:`, result.error);
        res.status(500).json({ error: result.error });
      }
    } catch (error: any) {
      console.error('[FORCE-DEV] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para conectar instância ao WhatsApp (gerar QR Code)
  app.get("/api/chat/webhook/connect", async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      console.log(`📱 [CONNECT] Gerando QR Code para instância ${instanceName}...`);
      
      const qrResult = await evolutionAPIService.getQRCode(instanceName);
      
      if (!qrResult.success) {
        return res.status(400).json({ 
          error: qrResult.error,
          message: `Erro ao gerar QR Code: ${qrResult.error}`
        });
      }
      
      if (qrResult.alreadyConnected) {
        return res.json({
          connected: true,
          message: 'Instância já está conectada ao WhatsApp'
        });
      }
      
      res.json({
        success: true,
        message: 'QR Code gerado com sucesso',
        qrcode: qrResult.qrcode,
        instructions: 'Abra WhatsApp no seu celular, vá em Configurações > Aparelhos conectados > Conectar um aparelho e escaneie o QR Code'
      });
    } catch (error: any) {
      console.error('[CONNECT] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Teste de webhook GET - simular mensagem recebida (acessível via navegador)
  app.get("/api/chat/webhook/test", async (req, res) => {
    try {
      console.log(`🧪 [WEBHOOK-TEST-GET] Simulando mensagem recebida via GET...`);
      
      const testMessage = {
        event: "MESSAGES_UPSERT",
        instance: "CHAT_HONEST",
        data: {
          key: {
            remoteJid: "5562995782812@s.whatsapp.net",
            fromMe: false,
            id: "test_" + Date.now()
          },
          message: {
            conversation: "Teste de resposta do webhook GET - " + nowBrazil().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })
          },
          pushName: "Teste WhatsApp"
        }
      };

      // Fazer requisição interna para testar o webhook
      const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testMessage)
      });

      const result = await response.json();
      console.log(`✅ [WEBHOOK-TEST-GET] Resposta:`, result);

      res.json({ success: true, message: "Teste enviado via GET", result, timestamp: new Date().toISOString() });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST-GET] Erro:", error);
      res.status(500).json({ error: "Erro no teste de webhook" });
    }
  });

  // Teste de webhook - simular mensagem recebida
  app.post("/api/chat/webhook/test", async (req, res) => {
    try {
      console.log(`🧪 [WEBHOOK-TEST] Simulando mensagem recebida...`);
      
      const testMessage = {
        event: "MESSAGES_UPSERT",
        instance: "CHAT_HONEST",
        data: {
          key: {
            remoteJid: "5562995782812@s.whatsapp.net",
            fromMe: false,
            id: "test_" + Date.now()
          },
          message: {
            conversation: "Teste de resposta do webhook - " + nowBrazil().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })
          },
          pushName: "Teste WhatsApp"
        }
      };

      // Fazer requisição interna para testar o webhook
      const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testMessage)
      });

      const result = await response.json();
      console.log(`✅ [WEBHOOK-TEST] Resposta:`, result);

      res.json({ success: true, message: "Teste enviado", result });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST] Erro:", error);
      res.status(500).json({ error: "Erro no teste de webhook" });
    }
  });

  // Teste avançado de webhook com parâmetros customizados
  app.post("/api/chat/webhook/test-advanced", async (req, res) => {
    try {
      const { phone = "5562995782812", message = "Teste avançado", fromMe = false } = req.body;
      
      console.log(`🧪 [WEBHOOK-TEST-ADVANCED] Enviando mensagem de teste com parâmetros:`);
      console.log(`   - Telefone: ${phone}`);
      console.log(`   - Mensagem: ${message}`);
      console.log(`   - De mim: ${fromMe}`);
      
      const testMessage = {
        event: "MESSAGES_UPSERT",
        instance: "CHAT_HONEST",
        data: {
          key: {
            remoteJid: `${phone}@s.whatsapp.net`,
            fromMe: fromMe,
            id: "test_adv_" + Date.now()
          },
          message: {
            conversation: message + ` (${nowBrazil().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`
          },
          pushName: fromMe ? "Sistema" : "Cliente Teste"
        }
      };

      console.log(`📤 [WEBHOOK-TEST-ADVANCED] Payload:`, JSON.stringify(testMessage, null, 2));

      // Fazer requisição interna para testar o webhook
      const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testMessage)
      });

      const result = await response.json();
      console.log(`✅ [WEBHOOK-TEST-ADVANCED] Resposta do webhook:`, result);

      // Aguardar um pouco para garantir processamento
      await new Promise(resolve => setTimeout(resolve, 500));

      // Tentar buscar a conversa criada
      let conversation: any;
      try {
        const normalizedPhone = normalizePhoneNumber(phone);
        const customer = await storage.getChatCustomerByPhone(normalizedPhone).catch(() => null);
        if (customer) {
          conversation = await storage.getChatConversationByCustomerId(customer.id).catch(() => null);
        }
      } catch (err) {
        console.warn(`⚠️  [WEBHOOK-TEST-ADVANCED] Erro ao buscar conversa:`, err);
      }

      res.json({ 
        success: true, 
        message: "Teste avançado enviado", 
        webhook_response: result,
        conversation_found: !!conversation,
        conversation
      });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST-ADVANCED] Erro:", error);
      res.status(500).json({ error: error.message || "Erro no teste avançado de webhook" });
    }
  });

  // Teste rápido: enviar várias mensagens para teste de volume
  app.post("/api/chat/webhook/test-batch", async (req, res) => {
    try {
      const { count = 3, phone = "5562995782812" } = req.body;
      
      console.log(`🧪 [WEBHOOK-TEST-BATCH] Enviando ${count} mensagens de teste...`);
      
      const results = [];
      for (let i = 1; i <= count; i++) {
        const testMessage = {
          event: "MESSAGES_UPSERT",
          instance: "CHAT_HONEST",
          data: {
            key: {
              remoteJid: `${phone}@s.whatsapp.net`,
              fromMe: false,
              id: `test_batch_${Date.now()}_${i}`
            },
            message: {
              conversation: `Mensagem de teste #${i} - ${nowBrazil().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
            },
            pushName: "Teste Batch"
          }
        };

        try {
          const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(testMessage)
          });
          const result = await response.json();
          results.push({ index: i, success: true, response: result });
          console.log(`✅ [WEBHOOK-TEST-BATCH] Mensagem ${i}/${count} enviada`);
        } catch (err) {
          results.push({ index: i, success: false, error: (err as any).message });
          console.error(`❌ [WEBHOOK-TEST-BATCH] Erro na mensagem ${i}:`, err);
        }

        // Pequeno delay entre mensagens
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      res.json({ 
        success: true, 
        message: `${count} mensagens de teste enviadas`,
        results
      });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST-BATCH] Erro:", error);
      res.status(500).json({ error: "Erro no teste em batch" });
    }
  });

  // ============================================================
  // POLLING SERVICE - ALTERNATIVA AO WEBHOOK
  // ============================================================

  // GET /api/chat/polling/status - Status do serviço de polling
  app.get("/api/chat/polling/status", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const status = evolutionPollingService.getStatus();
      res.json(status);
    } catch (error: any) {
      console.error("[POLLING] Erro ao buscar status:", error);
      res.status(500).json({ error: "Erro ao buscar status do polling" });
    }
  });

  // POST /api/chat/polling/start - Iniciar serviço de polling
  app.post("/api/chat/polling/start", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const { intervalMs = 15000 } = req.body; // Default 15 seconds
      evolutionPollingService.start(intervalMs);
      res.json({ 
        success: true, 
        message: `Polling iniciado a cada ${intervalMs / 1000}s`
      });
    } catch (error: any) {
      console.error("[POLLING] Erro ao iniciar:", error);
      res.status(500).json({ error: "Erro ao iniciar polling" });
    }
  });

  // POST /api/chat/polling/stop - Parar serviço de polling
  app.post("/api/chat/polling/stop", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      evolutionPollingService.stop();
      res.json({ success: true, message: "Polling parado" });
    } catch (error: any) {
      console.error("[POLLING] Erro ao parar:", error);
      res.status(500).json({ error: "Erro ao parar polling" });
    }
  });

  // POST /api/chat/polling/phone - Polling manual para um telefone específico
  app.post("/api/chat/polling/phone", authenticateUser, requireRole(["admin", "coordinator", "telemarketing"]), async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      
      if (!phoneNumber) {
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }
      
      const result = await evolutionPollingService.pollForPhone(phoneNumber);
      res.json(result);
    } catch (error: any) {
      console.error("[POLLING] Erro no polling manual:", error);
      res.status(500).json({ error: "Erro no polling manual" });
    }
  });

  // ============================================================
  // ENDPOINTS PARA GESTÃO DE CONVERSAS
  // ============================================================

  // GET /api/chat/conversations/stats - Estatísticas gerais de conversas
  app.get("/api/chat/conversations/stats", async (req, res) => {
    try {
      const conversations = await storage.getChatConversations();
      const agents = await storage.getChatAgents() || [];
      const messages: any[] = [];

      const activeConversations = conversations.filter(c => c.status !== 'resolved').length;
      const totalConversations = conversations.length;
      
      // Calcular tempo médio de resposta
      const averageResponseTime = 0;

      // Dados por dia
      const messagesByDay: Record<string, number> = {};
      messages.forEach((msg: any) => {
        const date = new Date(msg.timestamp || msg.createdAt).toISOString().split('T')[0];
        messagesByDay[date] = (messagesByDay[date] || 0) + 1;
      });

      const totalMessagesPerDay = Object.entries(messagesByDay)
        .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
        .map(([date, count]) => ({ date, count }))
        .slice(-30); // Últimos 30 dias

      // Desempenho por atendente
      const responseTimeByAgent = agents.map((agent: any) => ({
        agentName: agent.name,
        totalHandled: agent.totalConversations || 0
      }));

      res.json({
        totalConversations,
        activeConversations,
        averageResponseTime,
        totalMessagesPerDay,
        responseTimeByAgent
      });
    } catch (error: any) {
      console.error("[CHAT-STATS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar estatísticas" });
    }
  });

  // GET /api/chat/conversations - Lista de conversas com filtros
  app.get("/api/chat/conversations", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      // 🔧 Telemarketing também pode ver TODAS as conversas para visualizar/transferir conversas do ChatGPT
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative' || currentUser?.role === 'telemarketing';
      
      let conversations: any[] = [];
      let agents: any[] = [];
      let customers: any[] = [];
      let phonebookContacts: any[] = [];

      try {
        conversations = await storage.getChatConversations() || [];
      } catch (e) {
        console.error("[CHAT] Error getting conversations:", e);
      }

      try {
        agents = await storage.getChatAgents() || [];
      } catch (e) {
        console.error("[CHAT] Error getting agents:", e);
      }

      try {
        customers = await storage.getChatCustomers() || [];
      } catch (e) {
        console.error("[CHAT] Error getting customers:", e);
      }

      // ✅ Buscar contatos da agenda para priorizar nomes salvos
      try {
        phonebookContacts = await storage.getPhonebookContacts() || [];
      } catch (e) {
        console.error("[CHAT] Error getting phonebook contacts:", e);
      }

      // 👤 Mapa telefone -> nome do contato da empresa (coluna aditiva contact_name).
      // Tolerante à ausência da coluna (só existe após o 1º salvamento no modal da agenda).
      const contactNameByPhone: Record<string, string> = {};
      try {
        const cnRows: any = await db.execute(sql`SELECT phone, contact_name FROM phonebook_contacts WHERE contact_name IS NOT NULL AND contact_name <> ''`);
        for (const r of (cnRows?.rows || [])) {
          const p = String(r.phone || '').replace(/\D/g, '');
          if (p) contactNameByPhone[p] = r.contact_name;
        }
      } catch (e) { /* coluna ainda não existe — ignora */ }

      // 🔐 Filtrar conversas - admins veem TODAS, agents veem só suas atribuídas
      let filteredConversations = conversations;
      if (!isAdmin && currentUser?.id) {
        // Buscar agente ligado ao usuário
        const userAgent = agents.find(a => a.userId === currentUser.id);
        if (userAgent) {
          // Filtrar conversas atribuídas a este agente (usando assignedAgentId)
          filteredConversations = conversations.filter(c => 
            c.assignedAgentId === userAgent.id || c.agentId === userAgent.id
          );
        } else {
          // Usuário sem agente - vê conversas não atribuídas
          filteredConversations = conversations.filter(c => !c.assignedAgentId && !c.agentId);
        }
      }

      // Enriquecer conversas com dados relacionados
      const enrichedConversations = filteredConversations.map((conv: any) => {
        const assignedAgent = agents.find(a => a.id === conv.assignedAgentId);
        const creatorAgent = agents.find(a => a.id === conv.agentId);
        const customer = customers.find(c => c.id === conv.customerId);
        
        // ✅ PRIORIDADE: Agenda (phonebook) > Customer > Conversa > Fallback
        // Normalizar telefone para busca na agenda
        const normalizedPhone = (conv.customerPhone || customer?.phone || '').replace(/\D/g, '');
        const pbMatches = phonebookContacts.filter((p: any) => {
          const pPhone = (p.phone || '').replace(/\D/g, '');
          return pPhone === normalizedPhone || pPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(pPhone);
        });
        // ⚠️ Pode haver linhas duplicadas para o mesmo telefone (ex.: uma criada
        // automaticamente com o nome = próprio número, às vezes mal formatado).
        // Um nome "real" (razão social) tem pelo menos uma LETRA; nomes só com
        // dígitos/pontuação são telefone e não devem sobrescrever a razão social.
        const hasLetter = (s: any) => /[A-Za-zÀ-ÿ]/.test(String(s || ''));
        const phonebookContact = pbMatches.find((p: any) => hasLetter(p.name)) || pbMatches[0];

        // Nome priorizado: agenda (nome real com letra) > customer > conversa > fallback.
        const pbName = String(phonebookContact?.name || '').trim();
        const pbNameReal = hasLetter(pbName) ? pbName : '';
        const displayName = pbNameReal || customer?.name || conv.customerName || "Desconhecido";
        
        return {
          id: conv.id,
          customerId: conv.customerId,
          customerName: displayName,
          contactName: contactNameByPhone[normalizedPhone] || (phonebookContact ? contactNameByPhone[String((phonebookContact as any).phone || '').replace(/\D/g, '')] : '') || null,
          customerPhone: conv.customerPhone || customer?.phone || "-",
          customerLinked: !!(phonebookContact && (phonebookContact as any).customerId),
          channelPhone: (conv as any).channelPhone || null,
          agentId: conv.agentId,
          agentName: creatorAgent?.name,
          assignedAgentId: conv.assignedAgentId,
          assignedAgentName: conv.assignedAgentId === 'chatgpt' ? 'ChatGPT' : assignedAgent?.name || null,
          assignedAgentColor: conv.assignedAgentColor || null,
          lastAttendedAt: conv.lastAttendedAt,
          status: conv.status,
          priority: conv.priority,
          lastMessageTime: conv.lastMessageTime,
          createdAt: conv.createdAt,
          unreadCount: 0,
          hasUnread: false
        };
      });

      // 🔴 ORDENAÇÃO: por data da última mensagem
      enrichedConversations.sort((a: any, b: any) => {
        return new Date(b.lastMessageTime || 0).getTime() - new Date(a.lastMessageTime || 0).getTime();
      });

      res.json(enrichedConversations);
    } catch (error: any) {
      console.error("[CHAT-CONVERSATIONS] Erro fatal:", error.message || error);
      res.status(500).json({ error: "Erro ao buscar conversas", details: error.message });
    }
  });

  // ============================================================
  // 🆕 GET /api/conversations/:conversationId - Conversa COM mensagens ordenadas cronologicamente
  // Este endpoint é usado pelo chat-area.tsx para exibir mensagens intercaladas
  // ============================================================
  app.get("/api/conversations/:conversationId", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      
      // Buscar conversa
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }
      
      // Buscar mensagens e ordenar EXPLICITAMENTE por timestamp/createdAt (crescente - antigo primeiro)
      const rawMessages = await storage.getChatMessages(conversationId) || [];
      
      // 🔴 ORDENAÇÃO EXPLÍCITA: Garantir ordem cronológica exata (timestamp ou createdAt)
      // Isso é CRÍTICO para que mensagens de customer e agent sejam INTERCALADAS corretamente
      const messages = rawMessages.sort((a: any, b: any) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return timeA - timeB; // CRESCENTE: antigo primeiro, novo depois
      });
      
      console.log(`📋 [CONVERSATION-GET] Mensagens ordenadas: ${messages.length} | Primeira: ${messages[0]?.createdAt || 'N/A'} | Última: ${messages[messages.length-1]?.createdAt || 'N/A'}`);
      
      // Enriquecer mensagens com informações do remetente
      const agents = await storage.getChatAgents() || [];
      const customers = await storage.getChatCustomers() || [];
      
      const enrichedMessages = messages.map((msg: any) => {
        let senderName = 'Sistema';
        
        if (msg.senderType === 'customer') {
          const customer = customers.find((c: any) => c.id === msg.senderId);
          senderName = customer?.name || conversation.customerName || 'Cliente';
        } else if (msg.senderType === 'agent') {
          if (msg.senderId === 'system') {
            senderName = 'Sistema';
          } else {
            const agent = agents.find((a: any) => a.id === msg.senderId);
            senderName = agent?.name || 'Sem vendedor atrelado';
          }
        }
        
        return {
          ...msg,
          sender: {
            id: msg.senderId,
            name: senderName,
            type: msg.senderType
          }
        };
      });
      
      // Marcar mensagens de clientes como lidas ao abrir a conversa (DESATIVADO)
      /*
      const unreadMessages = messages.filter((m: any) => m.senderType === "customer" && !m.isRead);
      if (unreadMessages.length > 0) {
        console.log(`📖 [CONVERSATION-GET] Marcando ${unreadMessages.length} mensagens como lidas...`);
        for (const msg of unreadMessages) {
          await storage.updateChatMessage(msg.id, { isRead: true });
        }
        await storage.resetUnreadCount(conversationId);
      }
      */
      
      console.log(`📊 [CONVERSATION-GET] Conversa ${conversationId}: ${enrichedMessages.length} mensagens retornadas em ordem cronológica`);
      
      res.json({
        ...conversation,
        messages: enrichedMessages
      });
    } catch (error: any) {
      console.error("[CONVERSATION-GET] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar conversa" });
    }
  });

  // POST /api/conversations/:conversationId/assign - Atribuir conversa a agente
  app.post("/api/conversations/:conversationId/assign", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { agentId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "agentId é obrigatório" });
      }

      // 🎨 Obter cor do agente para visualização
      const agentColor = await getAgentColor(agentId);

      const updatedConv = await storage.updateChatConversation(conversationId, {
        agentId,
        assignedAgentId: agentId,
        assignedAgentColor: agentColor,
        lastAttendedAt: nowBrazil(),
        status: 'assigned'
      });

      console.log(`✅ [ASSIGN] Conversa ${conversationId} atribuída a ${agentId} com cor ${agentColor}`);
      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CONVERSATION-ASSIGN] Erro:", error);
      res.status(500).json({ error: "Erro ao atribuir conversa" });
    }
  });

  // PATCH /api/conversations/:conversationId - Atualizar status da conversa
  app.patch("/api/conversations/:conversationId", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { status, ...otherUpdates } = req.body;

      const updatedConv = await storage.updateChatConversation(conversationId, {
        status,
        ...otherUpdates
      });

      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CONVERSATION-UPDATE] Erro:", error);
      res.status(500).json({ error: "Erro ao atualizar conversa" });
    }
  });

  // POST /api/conversations/:conversationId/sync-history - Sincronizar histórico da conversa
  app.post("/api/conversations/:conversationId/sync-history", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      
      // Buscar conversa para obter telefone
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      // Por enquanto, retornar sucesso sem sincronização (Evolution API sync)
      console.log(`📞 [SYNC-HISTORY] Sincronização solicitada para conversa ${conversationId}`);
      
      res.json({ 
        success: true, 
        messageCount: 0,
        message: "Sincronização em andamento"
      });
    } catch (error: any) {
      console.error("[SYNC-HISTORY] Erro:", error);
      res.status(500).json({ error: "Erro ao sincronizar histórico" });
    }
  });

  // GET /api/chat/history/phone/:phone - Buscar COMPLETO histórico por número telefônico
  app.get("/api/chat/history/phone/:phone", async (req, res) => {
    try {
      const { phone } = req.params;
      
      if (!phone) {
        return res.status(400).json({ error: "Telefone é obrigatório" });
      }

      // 🔍 Buscar cliente pelo telefone
      const chatCustomer = await storage.getChatCustomerByPhone(phone).catch(() => null);
      
      if (!chatCustomer) {
        return res.status(404).json({ 
          error: "Nenhum histórico encontrado para este número",
          phone 
        });
      }

      // 📋 Buscar TODAS as conversas do cliente
      const conversations = await storage.getChatConversations();
      const customerConversations = conversations.filter(c => c.customerId === chatCustomer.id);

      // 💬 Buscar TODAS as mensagens
      const allMessages: any[] = [];
      for (const conv of customerConversations) {
        const messages = await storage.getChatMessages(conv.id) || [];
        allMessages.push(...messages);
      }

      // ✅ Retornar histórico COMPLETO atrelado ao telefone
      res.json({
        phone: chatCustomer.phone,
        customerName: chatCustomer.name,
        customerId: chatCustomer.id,
        totalConversations: customerConversations.length,
        totalMessages: allMessages.length,
        conversations: customerConversations.map(c => ({
          id: c.id,
          customerPhone: c.customerPhone,
          status: c.status,
          createdAt: c.createdAt,
          messageCount: allMessages.filter(m => m.conversationId === c.id).length
        })),
        recentMessages: allMessages.sort((a: any, b: any) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        ).slice(0, 50) // Últimas 50 mensagens
      });
    } catch (error: any) {
      console.error("[CHAT-HISTORY] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar histórico" });
    }
  });

  // GET /api/chat/conversations/messages/:conversationId - Mensagens de uma conversa

  // GET /api/chat/conversation-for-customer/:customerId - conversa da Central (texto) p/ anexar no Registro de Atendimento
  app.get("/api/chat/conversation-for-customer/:customerId", async (req: any, res: any) => {
    try {
      const { customerId } = req.params;
      const customer = await storage.getCustomer(customerId);
      const rawPhone = (customer as any)?.phone || "";
      if (!rawPhone) {
        return res.json({ found: false, reason: "Cliente sem telefone cadastrado" });
      }
      const normalized = normalizePhoneNumber(String(rawPhone));
      const variants = getPhoneVariants(normalized);
      let conversation: any = null;
      for (const v of variants) {
        conversation = await storage.getChatConversationByPhone(v);
        if (conversation) break;
      }
      if (!conversation) {
        return res.json({ found: false, reason: "Sem conversa vinculada na Central de Atendimento" });
      }
      const allMsgs = (await storage.getChatMessages(conversation.id)) || [];
      const dayOf = (d: any) => { try { return new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); } catch { return ""; } };
      const reqDate = String((req.query && req.query.date) || "").slice(0, 10);
      const days = Array.from(new Set(allMsgs.map((m: any) => dayOf(m.createdAt)).filter(Boolean))).sort();
      const targetDay = (reqDate && days.includes(reqDate)) ? reqDate : (days.length ? days[days.length - 1] : "");
      const dayMsgs = targetDay ? allMsgs.filter((m: any) => dayOf(m.createdAt) === targetDay) : [];
      const messages = dayMsgs.map((m: any) => ({ senderType: m.senderType, content: m.content, createdAt: m.createdAt }));
      return res.json({ found: true, conversationId: conversation.id, customerName: conversation.customerName, phone: normalized, date: targetDay, totalConversation: allMsgs.length, messages });
    } catch (error: any) {
      console.error("[CONVERSA-CENTRAL] erro:", error?.message || error);
      return res.status(500).json({ found: false, error: error?.message || "erro" });
    }
  });
  app.get("/api/chat/conversations/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await storage.getChatMessages(conversationId) || [];
      
      // Marcar TODAS as mensagens de clientes como lidas ao abrir a conversa (DESATIVADO)
      /*
      const unreadMessages = messages.filter(m => m.senderType === "customer" && !m.isRead);
      if (unreadMessages.length > 0) {
        console.log(`📖 [UNREAD-MARK] Marcando ${unreadMessages.length} mensagens como lidas...`);
        for (const msg of unreadMessages) {
          await storage.updateChatMessage(msg.id, { isRead: true });
        }
        
        // 🟢 Resetar contador de unread da conversa
        try {
          await storage.resetUnreadCount(conversationId);
          console.log(`🟢 [UNREAD-RESET] Contador resetado para conversa ${conversationId}`);
        } catch (err) {
          console.warn(`⚠️  [UNREAD-RESET] Erro ao resetar contador:`, err);
        }
      }
      */
      
      // Buscar mensagens novamente após marcar como lidas
      const updatedMessages = await storage.getChatMessages(conversationId) || [];
      
      // DEBUG: Verificar campos de mídia
      const mediaMessages = updatedMessages.filter((m: any) => m.messageType !== 'text' || m.mediaUrl);
      if (mediaMessages.length > 0) {
        console.log(`🖼️ [MEDIA-DEBUG] Conversa ${conversationId}: ${mediaMessages.length} mensagens de mídia`);
        mediaMessages.slice(0, 3).forEach((m: any) => {
          console.log(`   📎 ID: ${m.id} | Type: ${m.messageType} | URL: ${m.mediaUrl} | Content: ${m.content?.substring(0, 30)}`);
        });
      }
      
      res.json(updatedMessages);
    } catch (error: any) {
      console.error("[CHAT-MESSAGES] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens" });
    }
  });

  // GET /api/chat/conversations/:conversationId/assignment-history - Histórico de atribuições
  app.get("/api/chat/conversations/:conversationId/assignment-history", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { getAssignmentHistory } = await import("./chat-distribution-service");
      const history = await getAssignmentHistory(conversationId);
      res.json(history);
    } catch (error: any) {
      console.error("[CHAT-ASSIGNMENT-HISTORY] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar histórico de atribuições" });
    }
  });

  // GET /api/chat/agents/stats - Stats de conversas por agente (admin only)
  app.get("/api/chat/agents/stats", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req, res) => {
    try {
      const stats = await storage.getConversationsCountByAgent();
      res.json(stats);
    } catch (error: any) {
      console.error("[CHAT-AGENT-STATS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar stats de agentes" });
    }
  });

  // GET /api/chat/agents/detailed-stats - Stats detalhadas por agente (admin only)
  app.get("/api/chat/agents/detailed-stats", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req, res) => {
    try {
      console.log("[CHAT-AGENT-DETAILED-STATS] Iniciando busca de stats...");
      const stats = await storage.getAgentDetailedStats();
      console.log("[CHAT-AGENT-DETAILED-STATS] Stats obtidas:", stats.length, "agentes");
      res.json(stats);
    } catch (error: any) {
      console.error("[CHAT-AGENT-DETAILED-STATS] Erro detalhado:", error.message);
      console.error("[CHAT-AGENT-DETAILED-STATS] Stack:", error.stack);
      res.status(500).json({ error: "Erro ao buscar stats detalhadas de agentes", details: error.message });
    }
  });

  // GET /api/chat/virtual-attendance - Estatísticas de atendimentos virtuais por agente/data
  app.get("/api/chat/virtual-attendance", authenticateUser, requireRole(["admin", "coordinator", "administrative", "telemarketing"]), async (req, res) => {
    try {
      const { startDate, endDate, agentId } = req.query;
      
      // Default: últimos 30 dias se não especificado
      const now = nowBrazil();
      const defaultStartDate = new Date(now);
      defaultStartDate.setDate(defaultStartDate.getDate() - 30);
      
      const filters = {
        startDate: startDate ? new Date(startDate as string) : defaultStartDate,
        endDate: endDate ? new Date(endDate as string) : now,
        agentId: agentId as string | undefined,
      };
      
      const summary = await storage.getVirtualAttendanceSummary(filters);
      res.json({ summaries: summary });
    } catch (error: any) {
      console.error("[VIRTUAL-ATTENDANCE] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar estatísticas de atendimentos" });
    }
  });

  // GET /api/chat/virtual-attendance/details - Detalhes dos atendimentos (clientes atendidos) por data/agente
  app.get("/api/chat/virtual-attendance/details", authenticateUser, requireRole(["admin", "coordinator", "administrative", "telemarketing"]), async (req, res) => {
    try {
      const { date, agentId } = req.query;
      
      if (!date) {
        return res.status(400).json({ error: "Data é obrigatória" });
      }
      
      const targetDate = date as string;
      
      // Buscar atendimentos com detalhes da conversa e cliente
      const details = await db.select({
        id: virtualAttendanceStats.id,
        conversationId: virtualAttendanceStats.conversationId,
        agentId: virtualAttendanceStats.agentId,
        serviceDate: virtualAttendanceStats.serviceDate,
        countedAt: virtualAttendanceStats.countedAt,
        agentFirstName: users.firstName,
        agentLastName: users.lastName,
        customerName: chatConversations.customerName,
        customerPhone: chatConversations.customerPhone,
        customerId: chatConversations.customerId,
        conversationStatus: chatConversations.status,
      })
      .from(virtualAttendanceStats)
      .leftJoin(users, eq(virtualAttendanceStats.agentId, users.id))
      .leftJoin(chatConversations, eq(virtualAttendanceStats.conversationId, chatConversations.id))
      .where(
        and(
          eq(virtualAttendanceStats.serviceDate, targetDate),
          agentId ? eq(virtualAttendanceStats.agentId, agentId as string) : undefined
        )
      )
      .orderBy(desc(virtualAttendanceStats.countedAt));
      
      const result = details.map(d => ({
        id: d.id,
        conversationId: d.conversationId,
        agentId: d.agentId,
        agentName: `${d.agentFirstName || ''} ${d.agentLastName || ''}`.trim() || 'Desconhecido',
        serviceDate: d.serviceDate,
        countedAt: d.countedAt,
        customerName: d.customerName || 'Cliente não identificado',
        customerPhone: d.customerPhone || '',
        customerId: d.customerId,
        conversationStatus: d.conversationStatus
      }));
      
      res.json({ details: result });
    } catch (error: any) {
      console.error("[VIRTUAL-ATTENDANCE-DETAILS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar detalhes de atendimentos" });
    }
  });

  // PATCH /api/chat/conversations/:conversationId/finish - Finalizar atendimento
  app.patch("/api/chat/conversations/:conversationId/finish", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const userId = (req as any).currentUser?.id;
      const currentUser = (req as any).currentUser;

      // Buscar conversa
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      // Verificar permissão: admin/coord/administrativo + telemarketing/vendedor podem finalizar qualquer conversa
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative' || currentUser?.role === 'telemarketing' || currentUser?.role === 'vendedor';
      if (!isAdmin && conversation.assignedAgentId) {
        const agents = await storage.getChatAgents();
        const userAgent = agents.find(a => a.userId === userId);
        if (!userAgent || userAgent.id !== conversation.assignedAgentId) {
          return res.status(403).json({ error: "Você não tem permissão para finalizar esta conversa" });
        }
      }

      // Buscar configurações para mensagem de finalização
      const aiSettings = await storage.getChatAiSettings();
      const finalizeMessage = aiSettings?.finalizeMessage || 
        'Atendimento finalizado. Obrigado pelo contato! Caso precise de algo mais, estamos à disposição.';

      // Enviar mensagem de finalização ao cliente via WhatsApp
      if (conversation.customerPhone) {
        try {
          const config = await evolutionAPIService.getConfig();
          if (config?.instanceName) {
            await evolutionAPIService.sendTextMessage(config.instanceName, conversation.customerPhone, finalizeMessage);
            console.log(`📩 [CHAT-FINISH] Mensagem de finalização enviada para ${conversation.customerPhone}`);
          }
          
          // Registrar mensagem no histórico
          await storage.createChatMessage({
            conversationId: conversationId,
            senderId: 'system',
            senderType: 'system',
            content: `[Finalização manual] ${finalizeMessage}`,
            messageType: 'text',
            isRead: true
          });
        } catch (sendErr: any) {
          console.error(`⚠️ [CHAT-FINISH] Erro ao enviar mensagem de finalização:`, sendErr.message);
        }
      }

      // Registrar atendimento virtual se havia agente humano atribuído
      if (conversation.assignedAgentId && conversation.assignedAgentId !== 'chatgpt') {
        const agents = await storage.getChatAgents();
        const assignedAgent = agents.find(a => a.id === conversation.assignedAgentId);
        if (assignedAgent?.userId) {
          await storage.logVirtualAttendance(conversationId, assignedAgent.userId, nowBrazil());
          console.log(`📊 [VIRTUAL-ATTENDANCE] Registrado atendimento: agente=${assignedAgent.userId}, conversa=${conversationId}`);
        }
      }

      // Finalizar conversa e desvincular atendente
      const updated = await storage.updateChatConversation(conversationId, {
        status: 'resolved',
        assignedAgentId: null,
        assignedAgentColor: null
      });

      console.log(`✅ [CHAT-FINISH] Conversa ${conversationId} finalizada por ${currentUser?.email || userId}`);
      res.json(updated);
    } catch (error: any) {
      console.error("[CHAT-FINISH] Erro:", error);
      res.status(500).json({ error: "Erro ao finalizar conversa" });
    }
  });

  // PATCH /api/chat/conversations/:conversationId/transfer - Transferir conversa (admin only)
  app.patch("/api/chat/conversations/:conversationId/transfer", authenticateUser, requireRole(["admin", "coordinator", "administrative", "telemarketing", "vendedor"]), async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { newAgentId } = req.body;

      if (!newAgentId) {
        return res.status(400).json({ error: "newAgentId é obrigatório" });
      }

      // Validar que conversa existe
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      // Validar que agente existe
      const agents = await storage.getChatAgents();
      const targetAgent = agents.find(a => a.id === newAgentId);
      if (!targetAgent) {
        return res.status(404).json({ error: "Agente não encontrado" });
      }

      // Transferir
      const updated = await storage.transferConversation(conversationId, newAgentId);
      res.json(updated);
    } catch (error: any) {
      console.error("[CHAT-TRANSFER] Erro:", error);
      res.status(500).json({ error: "Erro ao transferir conversa" });
    }
  });

  // POST /api/chat/conversations/:conversationId/message - Enviar mensagem ou mídia
  app.post("/api/chat/conversations/:conversationId/message", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { content, messageType = "text", mediaUrl, mediaCaption } = req.body;
      const userId = (req as any).currentUser?.id;
      const currentUser = (req as any).currentUser;

      if (!content && !mediaUrl) {
        return res.status(400).json({ error: "Conteúdo ou mídia é obrigatório" });
      }

      // 🔍 Buscar conversa
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(400).json({ error: "Conversa não encontrada" });
      }

      // 🔐 Verificar permissão: admin/coord/administrativo + telemarketing/vendedor podem enviar em qualquer conversa
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative' || currentUser?.role === 'telemarketing' || currentUser?.role === 'vendedor';
      if (!isAdmin && conversation.agentId) {
        const agents = await storage.getChatAgents();
        const userAgent = agents.find(a => a.userId === userId);
        if (userAgent?.id !== conversation.agentId) {
          return res.status(403).json({ error: "Você não tem permissão para enviar mensagens nesta conversa" });
        }
      }

      // 💬 Salvar mensagem no banco
      const message = await storage.createChatMessage({
        conversationId: conversation.id,
        senderId: userId,
        senderType: "agent",
        content: content || mediaCaption || "Mídia enviada",
        messageType,
        mediaUrl,
      });

      console.log(`💬 [SEND-MESSAGE] Mensagem salva: ${message.id} na conversa ${conversation.id}`);

      // 🟢 Atualizar status para em-progresso e atribuir ao atendente que enviou a mensagem
      if (storage.updateChatConversation) {
        const agents = await storage.getChatAgents();
        const userAgent = agents.find(a => a.userId === userId);
        
        if (userAgent) {
          const { assignConversationToAgent } = await import("./chat-distribution-service");
          const agentColor = await getAgentColor(userAgent.id);
          
          // Verificar se é a primeira atribuição ou mudança de atendente
          const isFirstAssignment = !conversation.assignedAgentId || conversation.assignedAgentId === 'chatgpt';
          const isAgentChange = conversation.assignedAgentId && 
                                conversation.assignedAgentId !== userAgent.id && 
                                conversation.assignedAgentId !== 'chatgpt';
          
          if (isFirstAssignment) {
            // Primeira atribuição - conversa iniciada pelo usuário
            await assignConversationToAgent(conversation.id, userAgent.id, agentColor, {
              assignedByUserId: userId,
              assignedByUserName: userAgent.name,
              reason: 'initial_user',
              agentName: userAgent.name
            });
            
            // Atualizar também o status e info do iniciador
            await storage.updateChatConversation(conversation.id, {
              status: 'in-progress',
              initiatedBy: 'user',
              initiatedByUserId: userId
            });
            
            console.log(`🔄 [SEND-MESSAGE] Conversa ${conversation.id} iniciada pelo atendente ${userAgent.name}`);
          } else if (isAgentChange) {
            // Outro atendente pegou a conversa - registrar takeover
            await assignConversationToAgent(conversation.id, userAgent.id, agentColor, {
              assignedByUserId: userId,
              assignedByUserName: userAgent.name,
              reason: 'manual_takeover',
              agentName: userAgent.name
            });
            
            await storage.updateChatConversation(conversation.id, {
              status: 'in-progress'
            });
            
            console.log(`🔄 [SEND-MESSAGE] Conversa ${conversation.id} assumida pelo atendente ${userAgent.name}`);
          } else {
            // Mesmo atendente - apenas atualizar lastAttendedAt
            await storage.updateChatConversation(conversation.id, {
              status: 'in-progress',
              lastAttendedAt: nowBrazil()
            });
            
            console.log(`🔄 [SEND-MESSAGE] Conversa ${conversation.id} atualizada pelo atendente ${userAgent.name}`);
          }
        } else {
          await storage.updateChatConversation(conversation.id, {
            status: 'in-progress'
          });
        }
      }

      // 📱 Enviar para WhatsApp via Evolution API
      console.log(`📱 [SEND-WHATSAPP-START] Iniciando envio ${messageType} via WhatsApp...`);
      let deliveryOutcome: { success: boolean; error?: string; messageId?: string } | null = null;
      try {
        if (!conversation.customerId) {
          console.warn(`⚠️ [SEND-WHATSAPP] Sem customerId na conversa`);
        } else {
          const chatCustomer = await storage.getChatCustomer(conversation.customerId);
          console.log(`📱 [SEND-WHATSAPP] Cliente encontrado:`, chatCustomer?.id, chatCustomer?.phone);
          
          if (!chatCustomer?.phone) {
            console.warn(`⚠️ [SEND-WHATSAPP] Cliente sem telefone`);
          } else {
            const config = {
              instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST',
              apiUrl: process.env.EVOLUTION_API_BASE_URL || 'https://api.bothonest.com.br',
              apiKey: process.env.EVOLUTION_API_KEY || ''
            };
            
            console.log(`📱 [SEND-WHATSAPP] Config: instanceName=${config.instanceName}, hasKey=${!!config.apiKey}`);
            
            if (!process.env.UMBLER_TALK_TOKEN && !process.env.UMBLER_API_KEY && (!config.instanceName || !config.apiKey)) {
              console.warn(`⚠️ [SEND-WHATSAPP] Configuração incompleta (Evolution/Umbler)`);
            } else {
              const phoneNormalized = normalizePhoneNumber(chatCustomer.phone);
              const phoneFormatted = phoneNormalized.includes('@') 
                ? phoneNormalized 
                : `${phoneNormalized}@s.whatsapp.net`;
              
              let sendResult;
              if (messageType === 'text' && content) {
                if (process.env.UMBLER_TALK_TOKEN) {
                  console.log(`📤 [SEND-WHATSAPP] Enviando texto via Umbler Talk para ${chatCustomer.phone}`);
                  sendResult = await sendUmblerTalkText(chatCustomer.phone, content, (conversation as any).channelPhone);
                } else if (process.env.UMBLER_API_KEY) {
                  console.log(`📤 [SEND-WHATSAPP] Enviando texto via Umbler para ${chatCustomer.phone}`);
                  sendResult = await sendUmblerText(chatCustomer.phone, content);
                } else {
                  console.log(`📤 [SEND-WHATSAPP] Enviando texto para ${phoneFormatted}: "${content.substring(0, 50)}..."`);
                  sendResult = await evolutionAPIService.sendTextMessage(
                    config.instanceName,
                    phoneFormatted,
                    content
                  );
                }
              } else if (mediaUrl && process.env.UMBLER_TALK_TOKEN) {
                const host = req.headers.host || 'integracode-production.up.railway.app';
                const absMediaUrl = /^https?:\/\//.test(mediaUrl) ? mediaUrl : ('https://' + host + mediaUrl);
                console.log(`📤 [SEND-WHATSAPP] Enviando ${messageType} via Umbler Talk: ${absMediaUrl.substring(0, 80)}`);
                sendResult = await sendUmblerTalkMedia(chatCustomer.phone, absMediaUrl, mediaCaption || content || '', (conversation as any).channelPhone);
              } else if (mediaUrl) {
                console.log(`📤 [SEND-WHATSAPP] Enviando ${messageType} para ${phoneFormatted}`);
                
                // Convert to base64 depending on source
                let finalMediaUrl = mediaUrl;
                let detectedMimetype: string | undefined;
                let detectedFileName: string | undefined;
                let conversionSuccess = false;
                
                const mimeTypes: Record<string, string> = {
                  '.jpg': 'image/jpeg',
                  '.jpeg': 'image/jpeg',
                  '.png': 'image/png',
                  '.gif': 'image/gif',
                  '.webp': 'image/webp',
                  '.mp4': 'video/mp4',
                  '.webm': 'video/webm',
                  '.mp3': 'audio/mpeg',
                  '.ogg': 'audio/ogg',
                  '.wav': 'audio/wav',
                  '.pdf': 'application/pdf',
                  '.doc': 'application/msword',
                  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  '.xls': 'application/vnd.ms-excel',
                  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                };
                
                console.log(`📤 [SEND-WHATSAPP] mediaUrl recebida: ${mediaUrl}`);
                
                // Handle Object Storage URLs (new method - persistent)
                if (mediaUrl.startsWith('/api/storage-image/')) {
                  try {
                    // Parse /api/storage-image/{bucket}/{objectPath}
                    const storagePathMatch = mediaUrl.match(/^\/api\/storage-image\/([^/]+)\/(.+)$/);
                    console.log(`📤 [SEND-WHATSAPP] Regex match: ${storagePathMatch ? 'success' : 'failed'}`);
                    if (storagePathMatch) {
                      const [, bucketName, objectPath] = storagePathMatch;
                      console.log(`📤 [SEND-WHATSAPP] Buscando do Object Storage: bucket=${bucketName}, object=${objectPath}`);
                      
                      const bucket = objectStorageClient.bucket(bucketName);
                      const file = bucket.file(objectPath);
                      
                      console.log(`📤 [SEND-WHATSAPP] Verificando existência do arquivo...`);
                      const [exists] = await file.exists();
                      console.log(`📤 [SEND-WHATSAPP] Arquivo existe: ${exists}`);
                      
                      if (!exists) {
                        console.error(`❌ [SEND-WHATSAPP] Arquivo não encontrado no Object Storage: ${objectPath}`);
                        sendResult = { success: false, error: 'Arquivo de mídia não encontrado no storage' };
                      } else {
                        const [fileBuffer] = await file.download();
                        const base64Data = fileBuffer.toString('base64');
                        const filename = path.basename(objectPath);
                        
                        const ext = path.extname(filename).toLowerCase();
                        detectedMimetype = mimeTypes[ext] || 'application/octet-stream';
                        detectedFileName = filename;
                        
                        finalMediaUrl = `data:${detectedMimetype};base64,${base64Data}`;
                        conversionSuccess = true;
                        console.log(`📤 [SEND-WHATSAPP] Object Storage convertido para base64: ${detectedMimetype} (${Math.round(base64Data.length / 1024)}KB)`);
                      }
                    } else {
                      console.error(`❌ [SEND-WHATSAPP] Regex não encontrou bucket/path na URL: ${mediaUrl}`);
                      sendResult = { success: false, error: 'URL de mídia inválida' };
                    }
                  } catch (storageErr: any) {
                    console.error(`❌ [SEND-WHATSAPP] Erro ao buscar do Object Storage:`, storageErr.message, storageErr.stack);
                    sendResult = { success: false, error: `Erro ao acessar storage: ${storageErr.message}` };
                  }
                }
                // Handle legacy /uploads/chat/ paths (fallback for old uploads)
                else if (mediaUrl.startsWith('/uploads/') || mediaUrl.includes('attached_assets')) {
                  try {
                    let filePath = mediaUrl;
                    if (mediaUrl.startsWith('/uploads/')) {
                      filePath = path.join(process.cwd(), mediaUrl.substring(1));
                    }
                    
                    if (fs.existsSync(filePath)) {
                      const fileBuffer = fs.readFileSync(filePath);
                      const base64Data = fileBuffer.toString('base64');
                      const filename = path.basename(filePath);
                      
                      const ext = path.extname(filename).toLowerCase();
                      detectedMimetype = mimeTypes[ext] || 'application/octet-stream';
                      detectedFileName = filename;
                      
                      finalMediaUrl = `data:${detectedMimetype};base64,${base64Data}`;
                      conversionSuccess = true;
                      console.log(`📤 [SEND-WHATSAPP] Arquivo local convertido para base64: ${detectedMimetype} (${Math.round(base64Data.length / 1024)}KB)`);
                    } else {
                      console.error(`❌ [SEND-WHATSAPP] Arquivo local não encontrado: ${filePath}`);
                      sendResult = { success: false, error: 'Arquivo de mídia local não encontrado' };
                    }
                  } catch (fileErr: any) {
                    console.error(`❌ [SEND-WHATSAPP] Erro ao converter arquivo local para base64:`, fileErr.message);
                    sendResult = { success: false, error: `Erro ao processar arquivo local: ${fileErr.message}` };
                  }
                }
                // Handle external URLs or already base64
                else if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://') || mediaUrl.startsWith('data:')) {
                  console.log(`📤 [SEND-WHATSAPP] URL externa ou base64 detectada, enviando diretamente`);
                  conversionSuccess = true;
                }
                else {
                  console.error(`❌ [SEND-WHATSAPP] Tipo de URL de mídia não suportado: ${mediaUrl.substring(0, 50)}...`);
                  sendResult = { success: false, error: 'Tipo de mídia não suportado' };
                }
                
                // Only send if conversion was successful or URL is external
                if (conversionSuccess) {
                  // Map frontend messageType to Evolution API expected mediaType
                  let evolutionMediaType: 'image' | 'audio' | 'video' | 'document' = 'document';
                  if (messageType === 'image') evolutionMediaType = 'image';
                  else if (messageType === 'audio') evolutionMediaType = 'audio';
                  else if (messageType === 'video') evolutionMediaType = 'video';
                  
                  console.log(`📤 [SEND-WHATSAPP] Enviando para Evolution API: tipo=${evolutionMediaType}, tamanho=${Math.round(finalMediaUrl.length/1024)}KB`);
                  
                  sendResult = await evolutionAPIService.sendMediaMessage(
                    config.instanceName,
                    phoneFormatted,
                    finalMediaUrl,
                    mediaCaption || content || undefined,
                    evolutionMediaType,
                    3,
                    { mimetype: detectedMimetype, fileName: detectedFileName }
                  );
                }
              } else if (messageType === 'location' && content) {
                let lat: any = '', lng: any = '';
                try { const o: any = typeof content === 'string' ? JSON.parse(content) : content; lat = o.lat || o.latitude; lng = o.lng || o.lon || o.longitude; } catch {}
                if (!lat || !lng) { const m = String(content).match(/(-?\d+\.\d+)[,;\s]+(-?\d+\.\d+)/); if (m) { lat = m[1]; lng = m[2]; } }
                const mapsUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : String(content);
                const locText = (mediaCaption ? mediaCaption + ' ' : '') + mapsUrl;
                if (process.env.UMBLER_TALK_TOKEN) sendResult = await sendUmblerTalkText(chatCustomer.phone, locText, (conversation as any).channelPhone);
                else sendResult = await evolutionAPIService.sendTextMessage(config.instanceName, phoneFormatted, locText);
              } else {
                sendResult = { success: false, error: 'Tipo de mensagem não suportado' };
              }
              
              if (sendResult?.success) {
                deliveryOutcome = { success: true, messageId: sendResult.messageId };
                console.log(`✅ [SEND-WHATSAPP] Mensagem entregue com sucesso! ID:`, sendResult.messageId);
              } else if (sendResult) {
                deliveryOutcome = { success: false, error: sendResult.error };
                console.warn(`⚠️ [SEND-WHATSAPP] Erro ao enviar:`, sendResult.error);
              } else {
                deliveryOutcome = { success: false, error: 'Nenhum resultado de envio disponivel' };
                console.warn(`⚠️ [SEND-WHATSAPP] Nenhum resultado de envio disponível`);
              }
            }
          }
        }
      } catch (err: any) {
        deliveryOutcome = { success: false, error: err.message };
        console.error(`❌ [SEND-WHATSAPP] Erro crítico:`, err.message);
      }

      // 📌 Refletir o status real de entrega na mensagem persistida e na resposta
      let responseMessage: any = message;
      try {
        if (deliveryOutcome) {
          const newAck = deliveryOutcome.success ? 1 : 0;
          const newMeta = {
            ...((message as any).metadata || {}),
            delivery: {
              success: deliveryOutcome.success,
              error: deliveryOutcome.error || null,
              providerStatus: deliveryOutcome.messageId || null,
              at: new Date().toISOString(),
            },
          };
          const updated = await storage.updateChatMessage(message.id, { ack: newAck, metadata: newMeta } as any);
          responseMessage = updated || { ...message, ack: newAck, metadata: newMeta };
          if (!deliveryOutcome.success) {
            console.warn(`⚠️ [SEND-MESSAGE] Entrega NAO confirmada (ack=0): ${deliveryOutcome.error}`);
          }
        }
      } catch (persistErr: any) {
        console.error(`⚠️ [SEND-MESSAGE] Falha ao persistir status de entrega:`, persistErr.message);
      }

      res.json({ ...responseMessage, delivery: deliveryOutcome || { success: true } });
    } catch (error: any) {
      console.error("[CHAT-MESSAGE-SEND] Erro:", error);
      res.status(500).json({ error: "Erro ao enviar mensagem" });
    }
  });

  // PATCH /api/chat/conversations/:conversationId/assign - Atribuir conversa a agente
  app.patch("/api/chat/conversations/:conversationId/assign", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { agentId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "agentId é obrigatório" });
      }

      // 🎨 Obter cor do agente para visualização
      const agentColor = await getAgentColor(agentId);

      const updatedConv = await storage.updateChatConversation(conversationId, {
        agentId,
        assignedAgentId: agentId,
        assignedAgentColor: agentColor,
        lastAttendedAt: nowBrazil(),
        status: 'assigned'
      });

      console.log(`✅ [CHAT-ASSIGN] Conversa ${conversationId} atribuída a ${agentId} com cor ${agentColor}`);
      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CHAT-ASSIGN] Erro:", error);
      res.status(500).json({ error: "Erro ao atribuir conversa" });
    }
  });

  // PATCH /api/chat/conversations/:conversationId/status - Atualizar status
  app.patch("/api/chat/conversations/:conversationId/status", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({ error: "status é obrigatório" });
      }

      const updateData: any = { status };

      const updatedConv = await storage.updateChatConversation(conversationId, updateData);

      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CHAT-STATUS] Erro:", error);
      res.status(500).json({ error: "Erro ao atualizar status" });
    }
  });

  // POST /api/chat/conversations/:conversationId/mark-read - Marcar conversa como lida
  app.post("/api/chat/conversations/:conversationId/mark-read", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;

      // Zerar unreadCount da conversa
      const updatedConv = await storage.updateChatConversation(conversationId, {
        unreadCount: 0
      });

      // Marcar todas as mensagens do cliente como lidas
      await db.update(chatMessages)
        .set({ isRead: true })
        .where(
          and(
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.senderType, 'customer'),
            eq(chatMessages.isRead, false)
          )
        );

      console.log(`✅ [MARK-READ] Conversa ${conversationId} marcada como lida`);
      res.json({ success: true, conversation: updatedConv });
    } catch (error: any) {
      console.error("[MARK-READ] Erro:", error);
      res.status(500).json({ error: "Erro ao marcar como lida" });
    }
  });

  // ============================================================
  // ENDPOINTS PARA TEMPLATES DE RESPOSTA RÁPIDA
  // ============================================================

  // GET /api/chat/quick-templates - Lista de templates (requer autenticação)
  app.get("/api/chat/quick-templates", authenticateUser, async (req, res) => {
    try {
      const templates = await storage.getChatQuickMessages() || [];
      // Enriquecer com o nome de quem criou (para exibir "criado por")
      let users: any[] = [];
      try { users = await storage.getUsers(); } catch {}
      const nameById = new Map<string, string>(users.map((u: any) => [u.id, (`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || '')]));
      const enriched = (templates as any[]).map((t: any) => ({
        ...t,
        createdByName: nameById.get(t.createdBy) || null,
      }));
      res.json(enriched);
    } catch (error: any) {
      console.error("[CHAT-TEMPLATES] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar templates" });
    }
  });

  // GET /api/chat/quick-templates/:id - Buscar template específico
  app.get("/api/chat/quick-templates/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const template = await storage.getChatQuickMessage(id);
      if (!template) {
        return res.status(404).json({ error: "Template não encontrado" });
      }
      res.json(template);
    } catch (error: any) {
      console.error("[CHAT-TEMPLATE-GET] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar template" });
    }
  });

  // POST /api/chat/quick-templates - Criar template (qualquer usuário; limite de 2 para não-admin)
  app.post("/api/chat/quick-templates", authenticateUser, async (req, res) => {
    try {
      const { title, content, category, imageUrl, messageType, sortOrder } = req.body;
      const currentUser = (req as any).currentUser;
      const userId = currentUser?.id;
      const isAdmin = currentUser?.role === 'admin';

      if (!title) {
        return res.status(400).json({ error: "Título é obrigatório" });
      }

      if (!content && !imageUrl) {
        return res.status(400).json({ error: "Conteúdo ou imagem são obrigatórios" });
      }

      // Limite de 2 templates por usuário (admin é ilimitado)
      if (!isAdmin) {
        const all = await storage.getChatQuickMessages() || [];
        const mine = (all as any[]).filter((t: any) => t.createdBy === userId);
        if (mine.length >= 2) {
          return res.status(400).json({ error: "Você já atingiu o limite de 2 templates. Exclua um para criar outro." });
        }
      }

      const template = await storage.createChatQuickMessage({
        title,
        content: content || "",
        messageType: imageUrl ? "image" : (messageType || "text"),
        imageUrl: imageUrl || null,
        category: category || null,
        sortOrder: sortOrder || 0,
        isActive: true,
        createdBy: userId
      });

      console.log(`✅ [TEMPLATE] Template criado: ${template.id} - ${template.title}`);
      res.json(template);
    } catch (error: any) {
      console.error("[CHAT-TEMPLATE-CREATE] Erro:", error);
      res.status(500).json({ error: "Erro ao criar template" });
    }
  });

  // PUT /api/chat/quick-templates/:id - Atualizar template (dono ou admin)
  app.put("/api/chat/quick-templates/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const { title, content, category, imageUrl, messageType, sortOrder, isActive } = req.body;
      const currentUser = (req as any).currentUser;
      const isAdmin = currentUser?.role === 'admin';

      const existing = await storage.getChatQuickMessage(id);
      if (!existing) {
        return res.status(404).json({ error: "Template não encontrado" });
      }

      if (!isAdmin && existing.createdBy !== currentUser?.id) {
        return res.status(403).json({ error: "Você só pode editar os templates que você criou." });
      }

      const updateData: any = {};
      if (title !== undefined) updateData.title = title;
      if (content !== undefined) updateData.content = content;
      if (category !== undefined) updateData.category = category;
      if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
      if (messageType !== undefined) updateData.messageType = messageType;
      if (sortOrder !== undefined) updateData.sortOrder = sortOrder;
      if (isActive !== undefined) updateData.isActive = isActive;

      const template = await storage.updateChatQuickMessage(id, updateData);
      console.log(`✅ [TEMPLATE] Template atualizado: ${id}`);
      res.json(template);
    } catch (error: any) {
      console.error("[CHAT-TEMPLATE-UPDATE] Erro:", error);
      res.status(500).json({ error: "Erro ao atualizar template" });
    }
  });

  // DELETE /api/chat/quick-templates/:id - Deletar template (dono ou admin)
  app.delete("/api/chat/quick-templates/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const currentUser = (req as any).currentUser;
      const isAdmin = currentUser?.role === 'admin';

      const existing = await storage.getChatQuickMessage(id);
      if (!existing) {
        return res.status(404).json({ error: "Template não encontrado" });
      }

      if (!isAdmin && existing.createdBy !== currentUser?.id) {
        return res.status(403).json({ error: "Você só pode excluir os templates que você criou." });
      }

      await storage.deleteChatQuickMessage(id);
      console.log(`🗑️ [TEMPLATE] Template deletado: ${id}`);
      res.json({ success: true, message: "Template deletado" });
    } catch (error: any) {
      console.error("[CHAT-TEMPLATE-DELETE] Erro:", error);
      res.status(500).json({ error: "Erro ao deletar template" });
    }
  });

  // DEBUG: Testar busca de histórico de um contato
  app.get("/api/chat/debug-history/:phone", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const { phone } = req.params;
      console.log(`🔍 [DEBUG] Testando histórico para: ${phone}`);
      
      const historyResult = await evolutionAPIService.fetchChatHistory('CHAT_HONEST', phone, 50);
      
      console.log(`📊 [DEBUG] Resultado:`, historyResult);
      
      res.json({
        phone,
        success: historyResult.success,
        messageCount: historyResult.messages?.length || 0,
        error: historyResult.error,
        firstMessages: historyResult.messages?.slice(0, 3).map(m => ({
          id: m.key?.id,
          text: evolutionAPIService.extractMessageText(m.message),
          timestamp: m.messageTimestamp,
          fromMe: m.key?.fromMe
        }))
      });
    } catch (error: any) {
      console.error("[CHAT-DEBUG] Erro:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // DEBUG: Test apenas 3 primeiros chats com logging detalhado

    // 🔄 Rota para reconfigurar webhook (SEMPRE para PRODUÇÃO - fix critical issue)
  app.post("/api/chat/webhook/force-config", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      // SEMPRE usar o domínio de produção estável - NUNCA o domínio de dev
      const prodDomain = 'integrahonest.replit.app';
      const webhookUrl = `https://${prodDomain}/api/chat/webhook/messages`;
      
      console.log(`📡 [WEBHOOK-FORCE] Reconfigurando webhook SEMPRE para PRODUÇÃO: ${webhookUrl}`);
      
      const config = evolutionAPIService.getConfig();
      if (!config) throw new Error("Evolution API não configurada");
      
      const webhookEvents = [
        'MESSAGES_UPSERT',
        'SEND_MESSAGE',
        'MESSAGES_UPDATE',
        'MESSAGES_SET',
        'MESSAGES_EDITED'
      ];
      
      const result = await evolutionAPIService.setWebhook(config.instanceName, webhookUrl, webhookEvents);
      
      if (result.success) {
        console.log(`✅ [WEBHOOK-FORCE] Webhook fixado para produção: ${webhookUrl}`);
        res.json({ success: true, message: `Webhook reconfigurado com sucesso para PRODUÇÃO: ${webhookUrl}` });
      } else {
        res.status(500).json({ error: result.error || "Falha ao configurar na Evolution API" });
      }
    } catch (error: any) {
      console.error("❌ [WEBHOOK-FORCE] Erro:", error);
      res.status(500).json({ error: error.message });
    }
  });

// 🔄 Rota para sincronizar atendentes ativos
  app.post("/api/chat/agents/sync", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative';
      
      if (!isAdmin) {
        return res.status(403).json({ error: "Acesso negado. Apenas administradores podem sincronizar atendentes." });
      }

      await storage.syncUsersAsAgents();
      res.json({ success: true, message: "Lista de atendentes sincronizada com sucesso" });
    } catch (error: any) {
      console.error("❌ [SYNC-AGENTS-API] Erro ao sincronizar atendentes:", error);
      res.status(500).json({ error: "Erro ao sincronizar atendentes" });
    }
  });
  app.post("/api/chat/debug-sync-3", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("🔍 DEBUG: Processando apenas 3 chats com logging detalhado...");
      
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ 
          error: allChatsResult.error || 'Erro ao buscar conversas',
          success: false 
        });
      }

      const chats = allChatsResult.chats.slice(0, 3);
      console.log(`🔍 DEBUG: Total available: ${allChatsResult.chats.length}, testando: ${chats.length}`);
      
      const debugResults: any[] = [];

      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        console.log(`\n🔍 [${i + 1}/3] Chat ID raw: ${chat.id}`);
        
        const contactPhone = evolutionAPIService.extractPhoneNumber(chat.id);
        console.log(`🔍 [${i + 1}/3] Extracted phone: ${contactPhone}`);
        
        const normalizedPhone = normalizePhoneNumber(contactPhone);
        console.log(`🔍 [${i + 1}/3] Normalized phone: ${normalizedPhone}`);
        
        const contactName = chat.name || contactPhone;
        console.log(`🔍 [${i + 1}/3] Contact name: ${contactName}`);
        
        if (!normalizedPhone || normalizedPhone === '55') {
          console.warn(`⚠️  [${i + 1}/3] SKIPPED: Invalid normalized phone`);
          debugResults.push({
            index: i + 1,
            phone: contactPhone,
            error: 'Invalid normalized phone'
          });
          continue;
        }
        
        try {
          // Try to create customer
          console.log(`🔍 [${i + 1}/3] Creating chat customer...`);
          const chatCustomer = await storage.createChatCustomer({
            phone: normalizedPhone,
            name: contactName
          });
          console.log(`✅ [${i + 1}/3] Chat customer created: ${chatCustomer.id}`);
          
          // Try to create conversation
          console.log(`🔍 [${i + 1}/3] Creating conversation...`);
          const conversation = await storage.createChatConversation({
            customerId: chatCustomer.id,
            customerName: contactName,
            customerPhone: normalizedPhone,
            status: 'new' as const,
            priority: 'normal' as const
          });
          console.log(`✅ [${i + 1}/3] Conversation created: ${conversation.id}`);
          
          debugResults.push({
            index: i + 1,
            phone: normalizedPhone,
            name: contactName,
            success: true,
            customerId: chatCustomer.id,
            conversationId: conversation.id
          });
        } catch (err: any) {
          console.error(`❌ [${i + 1}/3] Error:`, err.message);
          debugResults.push({
            index: i + 1,
            phone: normalizedPhone,
            name: contactName,
            error: err.message
          });
        }
      }

      res.json({
        success: true,
        results: debugResults
      });
    } catch (error: any) {
      console.error("[DEBUG-SYNC] Erro:", error);
      res.status(500).json({ 
        error: error.message || "Erro no debug sync",
        success: false 
      });
    }
  });

  // Sincronizar conversas - TESTE SEM AUTENTICAÇÃO
  app.post("/api/chat/sync-test", async (req, res) => {
    console.log("🔄 [SYNC-TEST] Iniciando sincronização de teste (SEM AUTH)...");
    try {
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      console.log(`📊 [SYNC-TEST] API Result:`, allChatsResult.success ? `${allChatsResult.chats?.length} chats` : allChatsResult.error);
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.json({ error: 'API failed', success: false });
      }

      let created = 0;
      const logs: string[] = [];

      for (let i = 0; i < Math.min(allChatsResult.chats.length, 5); i++) {
        try {
          const chat = allChatsResult.chats[i];
          const phone = evolutionAPIService.extractPhoneNumber(chat.id);
          logs.push(`[${i}] phone=${phone}`);
          
          if (!phone || phone.length < 10) {
            logs.push(`  SKIPPED short`);
            continue;
          }
          
          let cust = await storage.createChatCustomer({ phone, name: chat.name || phone }).catch(() => null);
          if (!cust) cust = await storage.getChatCustomerByPhone(phone);
          if (!cust?.id) {
            logs.push(`  NO CUSTOMER`);
            continue;
          }
          
          await storage.createChatConversation({
            customerId: cust.id,
            customerName: chat.name || phone,
            customerPhone: phone,
            status: 'new' as const,
            priority: 'normal' as const
          });
          
          created++;
          logs.push(`  ✅ CREATED`);
        } catch (e: any) {
          logs.push(`  ERROR: ${e.message?.substring(0, 50)}`);
        }
      }

      console.log(`🎉 [SYNC-TEST] Created: ${created}`);
      res.json({ success: true, created, logs, total: allChatsResult.chats.length });
    } catch (error: any) {
      console.error("[SYNC-TEST] Error:", error.message);
      res.json({ error: error.message, success: false });
    }
  });

  // Sincronizar conversas do WhatsApp
  app.post("/api/chat/sync-conversations-only", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    console.log("🔄 [SYNC] Iniciando sincronização...");
    
    try {
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      console.log(`📊 [SYNC] Resultado da API:`, allChatsResult.success ? `${allChatsResult.chats?.length} chats` : allChatsResult.error);
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ error: 'Falha ao buscar chats', success: false });
      }

      const chats = allChatsResult.chats;
      let successCount = 0;

      for (let i = 0; i < chats.length; i++) {
        try {
          const chat = chats[i];
          const phone = evolutionAPIService.extractPhoneNumber(chat.id);
          const name = chat.name || phone;
          
          if (!phone || phone.length < 10) continue;
          
          let customer = await storage.createChatCustomer({ phone, name }).catch(() => null);
          if (!customer) customer = await storage.getChatCustomerByPhone(phone);
          if (!customer?.id) continue;
          
          await storage.createChatConversation({
            customerId: customer.id,
            customerName: name,
            customerPhone: phone,
            status: 'new' as const,
            priority: 'normal' as const
          });
          
          successCount++;
          if (successCount % 100 === 0) console.log(`✅ [SYNC] ${successCount} created...`);
        } catch (e) {
          // Continue
        }
      }

      console.log(`🎉 [SYNC] Total: ${successCount}/${chats.length}`);
      res.json({ success: true, summary: { totalChats: chats.length, conversationsCreated: successCount } });
    } catch (error: any) {
      console.error("[SYNC] Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/chat/sync-history - Sincronizar histórico de chats do WhatsApp
  app.post("/api/chat/sync-history", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("🔄 Iniciando sincronização de histórico de chats do WhatsApp...");
      
      // Buscar todas as conversas do WhatsApp
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ 
          error: allChatsResult.error || 'Erro ao buscar conversas do WhatsApp',
          success: false 
        });
      }

      const chats = allChatsResult.chats;
      console.log(`📊 Total de conversas encontradas: ${chats.length}`);
      
      let totalMessages = 0;
      let successCount = 0;
      let errorCount = 0;
      const results: any[] = [];

      // Para cada chat, buscar histórico e sincronizar (limitado a 50 para teste inicial)
      const maxChatsToSync = Math.min(chats.length, 50);
      for (let i = 0; i < maxChatsToSync; i++) {
        const chat = chats[i];
        try {
          const contactPhone = evolutionAPIService.extractPhoneNumber(chat.id);
          const normalizedPhone = normalizePhoneNumber(contactPhone);
          const contactName = chat.name || contactPhone;
          
          console.log(`📱 [${i + 1}/${maxChatsToSync}] Sincronizando chat: ${contactName} (${contactPhone} -> ${normalizedPhone})`);
          
          // Buscar histórico de mensagens
          const historyResult = await evolutionAPIService.fetchChatHistory('CHAT_HONEST', contactPhone, 100);
          
          if (historyResult.success && historyResult.messages && historyResult.messages.length > 0) {
            console.log(`   📄 Histórico carregado: ${historyResult.messages.length} mensagens`);
            
            // Sincronizar no banco de dados
            const syncResult = await storage.syncChatHistory(
              normalizedPhone,
              contactName,
              historyResult.messages
            );
            
            console.log(`✅ Chat sincronizado: ${contactName} - ${syncResult.messageCount} mensagens importadas`);
            
            results.push({
              phone: normalizedPhone,
              name: contactName,
              messagesImported: syncResult.messageCount,
              status: 'success'
            });
            
            totalMessages += syncResult.messageCount;
            successCount++;
          } else if (historyResult.success && (!historyResult.messages || historyResult.messages.length === 0)) {
            console.log(`⚪ Chat sem mensagens: ${contactName}`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              messagesImported: 0,
              status: 'success'
            });
            successCount++;
          } else {
            console.warn(`⚠️  Erro ao buscar histórico de ${contactName}: ${historyResult.error}`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              status: 'error',
              error: historyResult.error || 'Erro desconhecido'
            });
            errorCount++;
          }
        } catch (chatError: any) {
          console.error(`❌ Erro ao processar chat:`, chatError.message);
          errorCount++;
          results.push({
            status: 'error',
            error: chatError.message
          });
        }
      }

      console.log(`🎉 Sincronização concluída: ${successCount} conversas processadas, ${totalMessages} mensagens importadas`);
      
      res.json({
        success: true,
        summary: {
          totalChats: chats.length,
          chatsProcessed: maxChatsToSync,
          successCount,
          errorCount,
          totalMessagesImported: totalMessages
        },
        details: results.slice(0, 20) // Retornar apenas os 20 primeiros para não sobrecarregar a resposta
      });
    } catch (error: any) {
      console.error("[CHAT-SYNC-HISTORY] Erro:", error);
      res.status(500).json({ 
        error: error.message || "Erro ao sincronizar histórico", 
        success: false 
      });
    }
  });

  // GET /api/chat/customer-seller/:phone - Buscar vendedor associado ao cliente
  app.get("/api/chat/customer-seller/:phone", authenticateUser, async (req, res) => {
    try {
      const { phone } = req.params;
      const customer = await storage.getCustomerByPhone(phone);
      
      if (!customer) {
        return res.json({ 
          success: true,
          sellerName: "Sem vendedor atrelado",
          found: false 
        });
      }
      
      const sellerName = customer.seller?.firstName ? `${customer.seller.firstName} ${customer.seller.lastName || ''}`.trim() : "Sem vendedor atrelado";
      
      res.json({
        success: true,
        sellerName,
        found: true,
        sellerId: customer.seller?.id
      });
    } catch (error: any) {
      console.error("[CUSTOMER-SELLER] Erro:", error);
      res.json({ success: true, sellerName: "Sem vendedor atrelado", found: false });
    }
  });

  // POST /api/chat/sync-contacts - Sincronizar contatos do WhatsApp para o banco de dados
  app.post("/api/chat/sync-contacts", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("👥 [SYNC-CONTACTS] Iniciando sincronização de contatos do WhatsApp...");
      
      // Buscar todas as conversas do WhatsApp (os contatos)
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ 
          error: allChatsResult.error || 'Erro ao buscar contatos do WhatsApp',
          success: false 
        });
      }

      const chats = allChatsResult.chats;
      console.log(`👥 [SYNC-CONTACTS] Total de contatos encontrados: ${chats.length}`);
      
      let createdCount = 0;
      let alreadyExists = 0;
      let errorCount = 0;
      const results: any[] = [];

      for (let i = 0; i < chats.length; i++) {
        try {
          const chat = chats[i];
          const contactPhone = evolutionAPIService.extractPhoneNumber(chat.id);
          const normalizedPhone = normalizePhoneNumber(contactPhone);
          const contactName = chat.name || contactPhone;
          
          if (!normalizedPhone || normalizedPhone.length < 10) {
            console.warn(`⚠️  [SYNC-CONTACTS] Telefone inválido: ${contactPhone}`);
            continue;
          }

          // Buscar ou criar cliente
          let customer = await storage.getChatCustomerByPhone(normalizedPhone);
          if (!customer) {
            customer = await storage.createChatCustomer({
              phone: normalizedPhone,
              name: contactName
            });
            createdCount++;
            console.log(`✅ [SYNC-CONTACTS] Contato criado: ${contactName} (${normalizedPhone})`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              status: 'created'
            });
          } else {
            alreadyExists++;
            console.log(`⚪ [SYNC-CONTACTS] Contato já existe: ${contactName} (${normalizedPhone})`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              status: 'exists'
            });
          }
        } catch (error: any) {
          errorCount++;
          console.error(`❌ [SYNC-CONTACTS] Erro ao sincronizar contato:`, error.message);
          results.push({
            status: 'error',
            error: error.message
          });
        }
      }

      console.log(`🎉 [SYNC-CONTACTS] Sincronização concluída: ${createdCount} criados, ${alreadyExists} já existiam`);
      
      res.json({
        success: true,
        summary: {
          totalContacts: chats.length,
          created: createdCount,
          alreadyExists,
          errors: errorCount
        },
        details: results.slice(0, 50)
      });
    } catch (error: any) {
      console.error("[SYNC-CONTACTS] Erro:", error);
      res.status(500).json({ 
        error: error.message || "Erro ao sincronizar contatos", 
        success: false 
      });
    }
  });

  // Mutation para sincronizar mensagens do WhatsApp
  app.post("/api/chat/sync-whatsapp", authenticateUser, async (req, res) => {
    try {
      console.log(`🔄 [SYNC-WHATSAPP] Iniciando sincronização solicitada por: ${(req as any).user?.email}`);
      
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado" });
      }

      // 1. Corrigir banco de dados imediatamente (Migração de dados históricos do número errado para o correto)
      await db.execute(sql`
        DO $$ 
        BEGIN
            -- Garante que o cliente correto existe
            IF NOT EXISTS (SELECT 1 FROM chat_customers WHERE phone = '5562996353860') THEN
                INSERT INTO chat_customers (id, phone, name)
                VALUES (gen_random_uuid(), '5562996353860', 'Honest');
            END IF;

            -- Migra conversas vinculadas ao número antigo
            UPDATE chat_conversations 
            SET customer_phone = '5562996353860',
                customer_id = (SELECT id FROM chat_customers WHERE phone = '5562996353860')
            WHERE customer_phone = '5504884295924' OR customer_phone = '04884295924';

            -- Migra mensagens do cliente antigo
            UPDATE chat_messages 
            SET sender_id = (SELECT id FROM chat_customers WHERE phone = '5562996353860') 
            WHERE sender_id IN (SELECT id FROM chat_customers WHERE phone = '5504884295924' OR phone = '04884295924') 
            AND sender_type = 'customer';

            -- Remove o registro do cliente com número incorreto
            DELETE FROM chat_customers WHERE phone = '5504884295924' OR phone = '04884295924';
        END $$;
      `);

      // 2. Buscar histórico da API externa para o número correto
      const targetPhone = '5562996353860';
      const history = await evolutionAPIService.fetchChatHistory(config.instanceName, targetPhone);
      
      if (history.success && history.messages) {
        // Garantir cliente e conversa para o sync
        let customer = await storage.getChatCustomerByPhone(targetPhone);
        if (!customer) {
          customer = await storage.createChatCustomer({ phone: targetPhone, name: 'Honest' });
        }
        
        const conversation = await storage.upsertChatConversation({
          customerId: customer.id,
          customerName: customer.name || 'Honest',
          customerPhone: targetPhone,
          status: 'new',
          priority: 'normal'
        });

        // Importar mensagens faltantes
        const existingMessages = await storage.getChatMessages(conversation.id);
        const existingIds = new Set(existingMessages.map(m => m.externalId));

        let importedCount = 0;
        const { uploadMediaFromBase64 } = await import("./whatsapp-media-storage");
        
        for (const msg of history.messages) {
          const messageId = msg.key?.id;
          if (messageId && !existingIds.has(messageId)) {
            const isFromMe = msg.key?.fromMe === true;
            const text = evolutionAPIService.extractMessageText(msg.message) || '';
            
            const mediaInfo = evolutionAPIService.extractMediaInfo(msg.message);
            let finalMediaUrl = mediaInfo.mediaUrl;
            const finalMessageType = mediaInfo.messageType || 'text';
            const messageTimestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : nowBrazil();
            
            if (finalMessageType !== 'text' && !finalMediaUrl && messageId) {
              try {
                console.log(`📥 [SYNC-MEDIA] Baixando mídia para: ${messageId}`);
                // Passar o key completo para Evolution API v2.3.6+
                const messageKey = {
                  id: messageId,
                  remoteJid: msg.key?.remoteJid,
                  fromMe: msg.key?.fromMe
                };
                const messageTimestampSec = msg.messageTimestamp;
                const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(config.instanceName, messageKey, messageTimestampSec);
                if (mediaResult.success && mediaResult.base64) {
                  const mimeType = mediaResult.mimetype || mediaInfo.mediaType || 'application/octet-stream';
                  const uploadResult = await uploadMediaFromBase64(
                    mediaResult.base64,
                    mimeType,
                    mediaInfo.mediaFilename
                  );
                  if (uploadResult.success && uploadResult.objectPath) {
                    finalMediaUrl = uploadResult.objectPath;
                    console.log(`✅ [SYNC-MEDIA] Mídia salva: ${finalMediaUrl}`);
                  }
                }
              } catch (mediaErr: any) {
                console.warn(`⚠️ [SYNC-MEDIA] Erro ao baixar mídia: ${mediaErr.message}`);
              }
            }
            
            await storage.createChatMessage({
              conversationId: conversation.id,
              senderId: isFromMe ? 'system' : customer.id,
              senderType: isFromMe ? 'system' : 'customer',
              content: text || (finalMessageType !== 'text' ? `[${finalMessageType}]` : '[Mensagem]'),
              messageType: finalMessageType,
              mediaUrl: finalMediaUrl,
              externalId: messageId,
              createdAt: messageTimestamp
            });
            importedCount++;
          }
        }
        console.log(`✅ [SYNC-WHATSAPP] Importadas ${importedCount} novas mensagens para ${targetPhone}`);
      }
      
      res.json({ success: true, message: "Sincronização concluída e histórico corrigido", totalChats: history.messages?.length || 0 });
    } catch (error: any) {
      console.error("❌ [SYNC-WHATSAPP] Erro crítico:", error.message);
      res.status(500).json({ error: "Erro ao sincronizar histórico: " + error.message });
    }
  });

  // POST /api/chat/consolidate - Consolidar manualmente conversas por telefone
  app.post("/api/chat/consolidate", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("🔀 [CONSOLIDATE] Iniciando consolidação de conversas duplicadas por telefone...");
      const result = await consolidateDuplicateConversations(storage);
      
      res.json({
        success: true,
        message: `Consolidação concluída: ${result.consolidated} grupos unificados, ${result.merged} mensagens mescladas`,
        ...result
      });
    } catch (error: any) {
      console.error("[CHAT-CONSOLIDATE] Erro:", error);
      res.status(500).json({ error: "Erro ao consolidar conversas", success: false });
    }
  });

  // POST /api/chat/phone-mappings - Criar mapeamento de números alternativos
  app.post("/api/chat/phone-mappings", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const { canonicalPhone, alternativePhone, description } = req.body;
      
      if (!canonicalPhone || !alternativePhone) {
        return res.status(400).json({ error: "canonicalPhone e alternativePhone são obrigatórios" });
      }
      
      // Usar a função de normalização do webhook
      const normalized55CanonicalPhone = `55${canonicalPhone.replace(/\D/g, '').slice(-11)}`;
      const normalized55AlternativePhone = `55${alternativePhone.replace(/\D/g, '').slice(-11)}`;
      
      const [mapping] = await db.insert(phoneNumberMappings).values({
        canonicalPhone: normalized55CanonicalPhone,
        alternativePhone: normalized55AlternativePhone,
        description: description || `Mapeamento criado em ${new Date().toISOString()}`
      }).returning();
      
      console.log(`✅ [PHONE-MAPPING] Criado: ${normalized55AlternativePhone} -> ${normalized55CanonicalPhone}`);
      res.json({ success: true, mapping });
    } catch (error: any) {
      console.error("[PHONE-MAPPING] Erro:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/fix-phone-numbers - Corrigir números errados em registros existentes
  app.post("/api/chat/fix-phone-numbers", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      console.log("🔧 [FIX-PHONES] Iniciando correção de números de telefone...");
      
      // Mapeamentos conhecidos de IDs Evolution API para números reais
      const knownMappings: { [key: string]: string } = {
        '5504884295924': '5562995782812',
        '5550575396912': '5562996353860',
        '04884295924': '5562995782812',
        '50575396912': '5562996353860',
      };
      
      const results = {
        customersUpdated: 0,
        conversationsUpdated: 0,
        mappingsCreated: 0,
        errors: [] as string[]
      };
      
      // 1. Buscar todos os clientes e conversas
      const allConversations = await storage.getChatConversations();
      
      for (const conv of allConversations) {
        const cleanPhone = conv.customerPhone?.replace(/\D/g, '') || '';
        
        // Verificar se o telefone precisa ser corrigido
        for (const [wrongPhone, correctPhone] of Object.entries(knownMappings)) {
          if (cleanPhone === wrongPhone || cleanPhone.includes(wrongPhone)) {
            try {
              // Atualizar conversa
              await storage.updateChatConversation(conv.id, {
                customerPhone: correctPhone
              });
              results.conversationsUpdated++;
              console.log(`✅ [FIX-PHONES] Conversa ${conv.id}: ${cleanPhone} -> ${correctPhone}`);
              
              // Atualizar cliente se existir
              if (conv.customerId) {
                const customer = await storage.getChatCustomer(conv.customerId);
                if (customer && customer.phone !== correctPhone) {
                  await storage.updateChatCustomer(customer.id, {
                    phone: correctPhone
                  });
                  results.customersUpdated++;
                  console.log(`✅ [FIX-PHONES] Cliente ${customer.id}: ${customer.phone} -> ${correctPhone}`);
                }
              }
            } catch (err: any) {
              results.errors.push(`Erro ao atualizar ${conv.id}: ${err.message}`);
            }
            break;
          }
        }
      }
      
      // 2. Garantir que os mapeamentos existam no banco
      for (const [sourcePhone, canonicalPhone] of Object.entries(knownMappings)) {
        try {
          const existingMapping = await storage.getPhoneMappingBySource(sourcePhone);
          if (!existingMapping) {
            await db.insert(phoneNumberMappings).values({
              canonicalPhone: canonicalPhone,
              alternativePhone: sourcePhone,
              description: `Mapeamento automático - ${new Date().toISOString()}`
            });
            results.mappingsCreated++;
            console.log(`✅ [FIX-PHONES] Mapeamento criado: ${sourcePhone} -> ${canonicalPhone}`);
          }
        } catch (err: any) {
          // Ignorar erro de duplicata
          if (!err.message.includes('duplicate')) {
            results.errors.push(`Erro ao criar mapeamento ${sourcePhone}: ${err.message}`);
          }
        }
      }
      
      console.log("🔧 [FIX-PHONES] Correção concluída:", results);
      res.json({ 
        success: true, 
        message: `Correção concluída: ${results.conversationsUpdated} conversas, ${results.customersUpdated} clientes atualizados, ${results.mappingsCreated} mapeamentos criados`,
        ...results 
      });
    } catch (error: any) {
      console.error("[FIX-PHONES] Erro:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // ============================================================================
  // ADMIN: RE-PROCESS MEDIA FOR MESSAGES WITHOUT URL
  // ============================================================================
  
  app.post("/api/chat/admin/fix-media", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      console.log("📷 [FIX-MEDIA] Iniciando re-processamento de mídia...");
      
      const messagesWithoutMedia = await db.select({
        id: chatMessages.id,
        externalId: chatMessages.externalId,
        messageType: chatMessages.messageType,
        mediaUrl: chatMessages.mediaUrl,
        content: chatMessages.content
      })
      .from(chatMessages)
      .where(
        and(
          inArray(chatMessages.messageType, ['image', 'audio', 'video', 'document']),
          isNull(chatMessages.mediaUrl)
        )
      )
      .limit(50);
      
      console.log(`📷 [FIX-MEDIA] Encontradas ${messagesWithoutMedia.length} mensagens de mídia sem URL`);
      
      if (messagesWithoutMedia.length === 0) {
        return res.json({
          success: true,
          message: "Nenhuma mensagem de mídia sem URL encontrada",
          processed: 0,
          failed: 0
        });
      }
      
      const results = {
        processed: 0,
        failed: 0,
        errors: [] as string[]
      };
      
      const config = evolutionAPIService.getConfig();
      if (!config) {
        return res.status(400).json({ error: "Evolution API não configurada" });
      }
      
      for (const msg of messagesWithoutMedia) {
        if (!msg.externalId) {
          results.failed++;
          results.errors.push(`Mensagem ${msg.id}: sem externalId`);
          continue;
        }
        
        try {
          console.log(`📷 [FIX-MEDIA] Baixando mídia: ${msg.externalId} (${msg.messageType})`);
          
          // Para mensagens antigas, só temos o messageId (externalId)
          // Tentar com messageId apenas (pode funcionar se a mensagem ainda estiver no cache)
          const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(
            config.instanceName,
            { id: msg.externalId }
          );
          
          if (!mediaResult.success || !mediaResult.base64) {
            results.failed++;
            results.errors.push(`${msg.id}: ${mediaResult.error || 'sem dados'}`);
            continue;
          }
          
          const mimeType = mediaResult.mimetype || getMimeTypeFromMessageType(msg.messageType || 'image');
          const extension = getExtensionFromMimeType(mimeType);
          const fileName = `${msg.externalId}.${extension}`;
          
          console.log(`📤 [FIX-MEDIA] Fazendo upload: ${fileName}`);
          
          const uploadResult = await uploadMediaFromBase64(
            mediaResult.base64,
            mimeType,
            fileName
          );
          
          if (uploadResult.success && uploadResult.objectPath) {
            await db.update(chatMessages)
              .set({ mediaUrl: uploadResult.objectPath })
              .where(eq(chatMessages.id, msg.id));
            
            console.log(`✅ [FIX-MEDIA] Mídia atualizada: ${msg.id} -> ${uploadResult.objectPath}`);
            results.processed++;
          } else {
            results.failed++;
            results.errors.push(`${msg.id}: upload falhou`);
          }
          
        } catch (err: any) {
          results.failed++;
          results.errors.push(`${msg.id}: ${err.message}`);
        }
      }
      
      console.log(`📷 [FIX-MEDIA] Concluído: ${results.processed} processadas, ${results.failed} falhas`);
      
      res.json({
        success: true,
        message: `Re-processamento concluído: ${results.processed} processadas, ${results.failed} falhas`,
        ...results,
        remaining: messagesWithoutMedia.length - results.processed - results.failed
      });
      
    } catch (error: any) {
      console.error("[FIX-MEDIA] Erro:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });
  
  function getMimeTypeFromMessageType(messageType: string): string {
    switch (messageType) {
      case 'image': return 'image/jpeg';
      case 'audio': return 'audio/ogg';
      case 'video': return 'video/mp4';
      case 'document': return 'application/octet-stream';
      default: return 'application/octet-stream';
    }
  }
  
  function getExtensionFromMimeType(mimeType: string): string {
    const map: { [key: string]: string } = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
    };
    return map[mimeType] || 'bin';
  }

  // ============================================================================
  // ADMIN: DEBUG WEBHOOK LOGS
  // ============================================================================
  
  // GET /api/chat/admin/webhook-debug - Ver logs de debug do webhook (ADMIN ONLY)
  app.get("/api/chat/admin/webhook-debug", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, raw_remote_jid, extracted_phone, normalized_phone, mapping_found, mapped_to, created_at,
               LEFT(raw_payload, 500) as payload_preview
        FROM webhook_debug_log
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ 
        success: true, 
        logs: result.rows,
        count: result.rows.length,
        message: "Últimos 50 registros de debug do webhook"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // DELETE /api/chat/admin/webhook-debug - Limpar logs de debug do webhook (ADMIN ONLY)
  app.delete("/api/chat/admin/webhook-debug", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      await db.execute(sql`DELETE FROM webhook_debug_log`);
      res.json({ success: true, message: "Logs de debug limpos" });
    } catch (error: any) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // ============================================================================
  // ADMIN: CLEAR ALL CHAT DATA (NUCLEAR OPTION)
  // ============================================================================
  
  // POST /api/chat/admin/clear-all - Limpar TODOS os dados de chat (ADMIN ONLY)
  app.post("/api/chat/admin/clear-all", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const userEmail = (req.user as any)?.email;
      
      console.log(`⚠️ [ADMIN-CLEAR] Iniciando limpeza TOTAL de chat por: ${userEmail} (${userId})`);
      console.log(`⚠️ [ADMIN-CLEAR] Timestamp: ${new Date().toISOString()}`);
      
      // Contagem antes da limpeza
      const beforeCounts = {
        messages: await db.select({ count: sql<number>`count(*)` }).from(chatMessages).then(r => Number(r[0].count)),
        conversations: await db.select({ count: sql<number>`count(*)` }).from(chatConversations).then(r => Number(r[0].count)),
        customers: await db.select({ count: sql<number>`count(*)` }).from(chatCustomers).then(r => Number(r[0].count)),
        aiLogs: await db.select({ count: sql<number>`count(*)` }).from(chatAiLogs).then(r => Number(r[0].count)),
      };
      
      console.log("📊 [ADMIN-CLEAR] Registros antes da limpeza:", beforeCounts);
      
      // Ordem correta para evitar FK failures: logs -> messages -> conversations -> customers
      const deletedAiLogs = await db.delete(chatAiLogs).returning();
      console.log(`🗑️ [ADMIN-CLEAR] AI Logs deletados: ${deletedAiLogs.length}`);
      
      const deletedMessages = await db.delete(chatMessages).returning();
      console.log(`🗑️ [ADMIN-CLEAR] Mensagens deletadas: ${deletedMessages.length}`);
      
      const deletedConversations = await db.delete(chatConversations).returning();
      console.log(`🗑️ [ADMIN-CLEAR] Conversas deletadas: ${deletedConversations.length}`);
      
      const deletedCustomers = await db.delete(chatCustomers).returning();
      console.log(`🗑️ [ADMIN-CLEAR] Clientes de chat deletados: ${deletedCustomers.length}`);
      
      const result = {
        success: true,
        message: "Todos os dados de chat foram limpos com sucesso!",
        deletedCounts: {
          messages: deletedMessages.length,
          conversations: deletedConversations.length,
          customers: deletedCustomers.length,
          aiLogs: deletedAiLogs.length,
        },
        executedBy: userEmail,
        executedAt: new Date().toISOString(),
      };
      
      console.log("✅ [ADMIN-CLEAR] Limpeza concluída:", result);
      
      res.json(result);
    } catch (error: any) {
      console.error("❌ [ADMIN-CLEAR] Erro ao limpar dados:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // ============================================================================
  // CHATGPT AUTO-ATTENDANCE SETTINGS ROUTES
  // ============================================================================

  // GET /api/chat/ai-settings - Obter configurações do ChatGPT automático
  app.get("/api/chat/ai-settings", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const settings = await storage.getChatAiSettings();
      res.json({ success: true, settings: settings || getDefaultAiSettings() });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao obter configurações:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // PUT /api/chat/ai-settings - Atualizar configurações do ChatGPT automático
  app.put("/api/chat/ai-settings", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      
      // Buscar configurações existentes para fazer merge
      const existingSettings = await storage.getChatAiSettings();
      
      // Fazer merge das configurações existentes com as novas (permite atualização parcial)
      const mergedSettings = {
        isEnabled: req.body.isEnabled ?? existingSettings?.isEnabled ?? false,
        mode: req.body.mode ?? existingSettings?.mode ?? 'disabled',
        businessHours: req.body.businessHours ?? existingSettings?.businessHours ?? null,
        timeoutMinutes: req.body.timeoutMinutes ?? existingSettings?.timeoutMinutes ?? 5,
        maxTurnsBeforeEscalation: req.body.maxTurnsBeforeEscalation ?? existingSettings?.maxTurnsBeforeEscalation ?? 10,
        handoffKeywords: req.body.handoffKeywords ?? existingSettings?.handoffKeywords ?? [],
        systemPrompt: req.body.systemPrompt ?? existingSettings?.systemPrompt ?? null,
        companyContext: req.body.companyContext ?? existingSettings?.companyContext ?? null,
        gptModel: req.body.gptModel ?? existingSettings?.gptModel ?? 'gpt-4o-mini',
        chatgptImages: req.body.chatgptImages ?? existingSettings?.chatgptImages ?? [],
        inactivityTimeoutMinutes: req.body.inactivityTimeoutMinutes ?? existingSettings?.inactivityTimeoutMinutes ?? 30,
        finalizeMessage: req.body.finalizeMessage ?? existingSettings?.finalizeMessage ?? null,
        absenceMessage: req.body.absenceMessage ?? existingSettings?.absenceMessage ?? null,
        isStandby: req.body.isStandby ?? existingSettings?.isStandby ?? true,
        chatgptQueuePosition: req.body.chatgptQueuePosition ?? existingSettings?.chatgptQueuePosition ?? 0,
        updatedBy: userId
      };
      
      const settings = await storage.upsertChatAiSettings(mergedSettings);
      
      console.log(`✅ [AI-SETTINGS] Configurações atualizadas por usuário ${userId}:`, 
                  { isEnabled: mergedSettings.isEnabled, mode: mergedSettings.mode, chatgptImages: mergedSettings.chatgptImages?.length || 0 });
      
      res.json({ success: true, settings });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao atualizar configurações:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-settings/toggle - Alternar estado ligado/desligado
  app.post("/api/chat/ai-settings/toggle", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const currentSettings = await storage.getChatAiSettings();
      const newEnabled = !(currentSettings?.isEnabled ?? false);
      
      const settings = await storage.upsertChatAiSettings({
        ...currentSettings,
        isEnabled: newEnabled,
        updatedBy: userId
      } as any);
      
      console.log(`✅ [AI-SETTINGS] ChatGPT ${newEnabled ? 'ATIVADO' : 'DESATIVADO'} por usuário ${userId}`);
      res.json({ success: true, settings, enabled: newEnabled });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao alternar:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-settings/standby - Alternar modo standby do ChatGPT
  app.post("/api/chat/ai-settings/standby", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const currentSettings = await storage.getChatAiSettings();
      const newStandby = !(currentSettings?.isStandby ?? true);
      
      const settings = await storage.upsertChatAiSettings({
        ...currentSettings,
        isStandby: newStandby,
        updatedBy: userId
      } as any);
      
      console.log(`✅ [AI-SETTINGS] Modo standby ${newStandby ? 'ATIVADO' : 'DESATIVADO'} por usuário ${userId}`);
      res.json({ success: true, settings, standby: newStandby });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao alternar standby:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/conversations/:id/transfer - Transferir conversa para outro atendente (apenas admin)
  app.post("/api/chat/conversations/:id/transfer", authenticateUser, requireRole(['admin', 'coordinator', 'administrative', 'telemarketing', 'vendedor']), async (req, res) => {
    try {
      const { id } = req.params;
      const { toAgentId } = req.body;
      const currentUser = (req as any).currentUser;
      
      if (!toAgentId) {
        return res.status(400).json({ error: "toAgentId é obrigatório" });
      }
      
      // Verificar se agente destino existe (ou é ChatGPT)
      if (toAgentId !== 'chatgpt') {
        const agents = await storage.getChatAgents() || [];
        const targetAgent = agents.find(a => a.id === toAgentId);
        if (!targetAgent) {
          return res.status(400).json({ error: "Agente de destino não encontrado" });
        }
      }
      
      const { transferConversation } = await import("./chat-distribution-service");
      const result = await transferConversation(id, "", toAgentId, currentUser?.id, true);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.json({ success: true, message: "Conversa transferida com sucesso" });
    } catch (error: any) {
      console.error("[TRANSFER] Erro ao transferir conversa:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // GET /api/chat/agents/online - Listar atendentes online para transferência (inclui ChatGPT)
  app.get("/api/chat/agents/online", authenticateUser, async (req, res) => {
    try {
      const { getOnlineTelemarketingAgents } = await import("./chat-distribution-service");
      const onlineAgents = await getOnlineTelemarketingAgents();
      
      // Buscar configurações de AI para verificar posição na fila
      const aiSettings = await storage.getChatAiSettings();
      const isAiEnabled = aiSettings?.isEnabled ?? false;
      const chatgptQueuePosition = aiSettings?.chatgptQueuePosition ?? 0;
      
      // Determinar status do ChatGPT baseado na configuração
      // position=1 = primeiro na fila (online), position=0 = standby (só assume quando ninguém disponível)
      const chatgptStatus = chatgptQueuePosition === 1 ? "online" : "standby";
      
      // Criar objeto ChatGPT
      const chatgptAgent = {
        id: "chatgpt",
        name: "ChatGPT (IA)",
        email: "",
        status: chatgptStatus,
        type: "bot" as const,
        queuePosition: chatgptQueuePosition,
        activeConversations: 0
      };
      
      // Montar lista de agentes respeitando a posição do ChatGPT na fila
      // Filtrar agentes com IDs válidos para evitar erro no Select do frontend
      const validOnlineAgents = onlineAgents.filter(a => a.id && a.id.trim() !== '');
      let agents: any[] = [];
      
      if (isAiEnabled && chatgptQueuePosition === 1) {
        // ChatGPT primeiro na fila
        agents = [
          chatgptAgent,
          ...validOnlineAgents.map(a => ({
            id: a.id,
            name: a.name,
            email: a.email,
            status: a.status,
            type: "human" as const,
            activeConversations: a.activeConversations
          }))
        ];
      } else {
        // Atendentes humanos primeiro, ChatGPT no final (standby)
        agents = [
          ...validOnlineAgents.map(a => ({
            id: a.id,
            name: a.name,
            email: a.email,
            status: a.status,
            type: "human" as const,
            activeConversations: a.activeConversations
          })),
          ...(isAiEnabled ? [chatgptAgent] : [])
        ];
      }
      
      res.json({ success: true, agents, chatgptQueuePosition });
    } catch (error: any) {
      console.error("[AGENTS-ONLINE] Erro ao buscar atendentes:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/conversations/:id/attend - Marcar atendimento (atualiza lastAttendedAt)
  app.post("/api/chat/conversations/:id/attend", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const { updateLastAttendedTime } = await import("./chat-distribution-service");
      await updateLastAttendedTime(id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[ATTEND] Erro ao marcar atendimento:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-reports/refresh - Regenerar relatórios de IA manualmente
  app.post("/api/chat/ai-reports/refresh", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      console.log(`🔄 [AI-REPORTS] Regeneração manual solicitada por usuário ${userId}`);
      
      const { generateAndSaveAllReports } = await import("./ai-reports-service");
      await generateAndSaveAllReports();
      
      console.log(`✅ [AI-REPORTS] Relatórios regenerados com sucesso por usuário ${userId}`);
      res.json({ success: true, message: "Relatórios regenerados com sucesso" });
    } catch (error: any) {
      console.error("[AI-REPORTS] Erro ao regenerar relatórios:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // GET /api/chat/ai-logs - Obter logs de atendimento automático
  app.get("/api/chat/ai-logs", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const { conversationId, limit } = req.query;
      const logs = await storage.getChatAiLogs(
        conversationId as string | undefined,
        Math.min(parseInt(limit as string) || 50, 500)
      );
      res.json({ success: true, logs });
    } catch (error: any) {
      console.error("[AI-LOGS] Erro ao obter logs:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-suggestion - Obter sugestão de resposta da IA para o atendente
  app.post("/api/chat/ai-suggestion", authenticateUser, requireRole(['admin', 'coordinator', 'telemarketing']), async (req, res) => {
    try {
      const { conversationId, customerName, customerPhone, messages } = req.body;
      
      if (!conversationId || !messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "conversationId e messages são obrigatórios" });
      }
      
      const settings = await storage.getChatAiSettings();
      if (!settings) {
        return res.status(400).json({ error: "Configurações de IA não encontradas. Configure em /telemarketing/ai-settings" });
      }
      
      // Converter mensagens para o formato esperado pelo generateAutoResponse
      const recentMessages = messages.slice(-15).map((msg: any) => ({
        role: (msg.senderType === 'customer' ? 'customer' : 'agent') as 'customer' | 'agent' | 'bot',
        content: msg.content || '',
        timestamp: new Date(msg.createdAt || msg.timestamp || Date.now())
      }));
      
      const { generateAutoResponse } = await import("./chatgpt-service");
      
      const result = await generateAutoResponse({
        customerName: customerName || "Cliente",
        customerPhone: customerPhone || "",
        conversationId: conversationId,
        recentMessages
      }, settings);
      
      console.log(`✨ [AI-SUGGESTION] Sugestão gerada para conversa ${conversationId} via ${settings.aiProvider || 'openai'}`);
      
      res.json({ 
        success: true, 
        response: result.response.reply,
        shouldTransfer: result.response.shouldTransfer,
        transferReason: result.response.transferReason,
        tokensUsed: result.tokensUsed,
        responseTimeMs: result.responseTimeMs,
        provider: settings.aiProvider || 'openai'
      });
    } catch (error: any) {
      console.error("[AI-SUGGESTION] Erro ao gerar sugestão:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/test-ai-response - Testar resposta do ChatGPT
  app.post("/api/chat/test-ai-response", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const { message, customerName, customerPhone } = req.body;
      
      if (!message) {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }
      
      const settings = await storage.getChatAiSettings();
      if (!settings) {
        return res.status(400).json({ error: "Configurações de IA não encontradas" });
      }
      
      const { generateAutoResponse } = await import("./chatgpt-service");
      
      const result = await generateAutoResponse({
        customerName: customerName || "Cliente Teste",
        customerPhone: customerPhone || "5562999999999",
        conversationId: "test-" + Date.now(),
        recentMessages: [{
          role: 'customer',
          content: message,
          timestamp: nowBrazil()
        }]
      }, settings);
      
      res.json({ 
        success: true, 
        response: result.response.reply,
        shouldTransfer: result.response.shouldTransfer,
        transferReason: result.response.transferReason,
        tokensUsed: result.tokensUsed,
        responseTimeMs: result.responseTimeMs
      });
    } catch (error: any) {
      console.error("[AI-TEST] Erro ao testar resposta:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // ===== Etiquetas (labels) das conversas =====
  // Cria as tabelas idempotentemente (o app não roda migração no deploy)
  db.execute(sql`CREATE TABLE IF NOT EXISTS chat_labels (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), name varchar NOT NULL, color varchar NOT NULL DEFAULT '#3B82F6', created_by varchar NOT NULL, created_by_name varchar, created_at timestamp DEFAULT now())`)
    .then(() => db.execute(sql`CREATE TABLE IF NOT EXISTS chat_conversation_labels (conversation_id varchar NOT NULL, label_id varchar NOT NULL, created_at timestamp DEFAULT now(), PRIMARY KEY (conversation_id, label_id))`))
    .catch((e: any) => console.warn('⚠️ [LABELS] create tables:', e?.message));

  // Listar todas as etiquetas (compartilhadas p/ marcar; canEdit = dono ou admin)
  app.get("/api/chat/labels", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const rows: any = await db.execute(sql`SELECT id, name, color, created_by, created_by_name, created_at FROM chat_labels ORDER BY created_at ASC`);
      const isAdmin = currentUser?.role === 'admin';
      const labels = (rows?.rows || []).map((l: any) => ({
        id: l.id, name: l.name, color: l.color, createdBy: l.created_by, createdByName: l.created_by_name,
        canEdit: isAdmin || l.created_by === currentUser?.id,
      }));
      res.json({ labels });
    } catch (e: any) { console.error('[LABELS] list:', e); res.status(500).json({ error: e?.message }); }
  });

  // Criar etiqueta (máx 5 por usuário)
  app.post("/api/chat/labels", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const name = String(req.body?.name || '').trim().slice(0, 40);
      const color = String(req.body?.color || '#3B82F6').slice(0, 20);
      if (!name) return res.status(400).json({ error: "Nome da etiqueta é obrigatório" });
      const cntQ: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM chat_labels WHERE created_by = ${currentUser.id}`);
      const n = cntQ?.rows?.[0]?.n || 0;
      if (n >= 5) return res.status(400).json({ error: "Limite de 5 etiquetas por usuário atingido" });
      const uname = [currentUser.firstName, currentUser.lastName].filter(Boolean).join(' ').trim() || currentUser.email || '';
      const ins: any = await db.execute(sql`INSERT INTO chat_labels (name, color, created_by, created_by_name) VALUES (${name}, ${color}, ${currentUser.id}, ${uname}) RETURNING id`);
      res.json({ ok: true, id: ins?.rows?.[0]?.id });
    } catch (e: any) { console.error('[LABELS] create:', e); res.status(500).json({ error: e?.message }); }
  });

  // Editar etiqueta (somente dono ou admin)
  app.patch("/api/chat/labels/:id", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const { id } = req.params;
      const q: any = await db.execute(sql`SELECT created_by FROM chat_labels WHERE id = ${id} LIMIT 1`);
      const row = q?.rows?.[0];
      if (!row) return res.status(404).json({ error: "Etiqueta não encontrada" });
      if (currentUser.role !== 'admin' && row.created_by !== currentUser.id) return res.status(403).json({ error: "Você só pode alterar suas próprias etiquetas" });
      if (req.body?.name !== undefined) { const nm = String(req.body.name).trim().slice(0, 40); if (nm) await db.execute(sql`UPDATE chat_labels SET name = ${nm} WHERE id = ${id}`); }
      if (req.body?.color !== undefined) { const cl = String(req.body.color).slice(0, 20); await db.execute(sql`UPDATE chat_labels SET color = ${cl} WHERE id = ${id}`); }
      res.json({ ok: true });
    } catch (e: any) { console.error('[LABELS] update:', e); res.status(500).json({ error: e?.message }); }
  });

  // Excluir etiqueta (somente dono ou admin)
  app.delete("/api/chat/labels/:id", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const { id } = req.params;
      const q: any = await db.execute(sql`SELECT created_by FROM chat_labels WHERE id = ${id} LIMIT 1`);
      const row = q?.rows?.[0];
      if (!row) return res.status(404).json({ error: "Etiqueta não encontrada" });
      if (currentUser.role !== 'admin' && row.created_by !== currentUser.id) return res.status(403).json({ error: "Você só pode excluir suas próprias etiquetas" });
      await db.execute(sql`DELETE FROM chat_conversation_labels WHERE label_id = ${id}`);
      await db.execute(sql`DELETE FROM chat_labels WHERE id = ${id}`);
      res.json({ ok: true });
    } catch (e: any) { console.error('[LABELS] delete:', e); res.status(500).json({ error: e?.message }); }
  });

  // 🗑️ Excluir (soft-delete) uma mensagem do chat.
  // Regra: o usuário SÓ pode excluir a PRÓPRIA mensagem (msg.senderId === currentUser.id).
  // Não apaga o registro — marca metadata.deleted e guarda quem excluiu, para exibir
  // "Mensagem excluída pelo usuário [nome]" no lugar do conteúdo.
  app.delete("/api/chat/messages/:messageId", authenticateUser, async (req: any, res: any) => {
    try {
      const currentUser = (req as any).currentUser;
      const userId = currentUser?.id;
      const userName = [currentUser?.firstName, currentUser?.lastName]
        .filter(Boolean).join(' ').trim() || currentUser?.email || 'Usuário';
      const { messageId } = req.params;

      const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
      if (!msg) return res.status(404).json({ error: "Mensagem não encontrada" });

      // 🔒 Só o autor pode excluir a própria mensagem
      if (!userId || String(msg.senderId) !== String(userId)) {
        return res.status(403).json({ error: "Você só pode excluir suas próprias mensagens" });
      }

      const prevMeta = (msg.metadata || {}) as any;
      if (prevMeta.deleted) {
        return res.json({ success: true, alreadyDeleted: true, deletedByName: prevMeta.deletedByName });
      }
      const newMeta = {
        ...prevMeta,
        deleted: true,
        deletedByName: userName,
        deletedById: userId,
        deletedAt: new Date().toISOString(),
      };
      await db.update(chatMessages).set({ metadata: newMeta }).where(eq(chatMessages.id, messageId));
      console.log(`🗑️ [MSG-DELETE] Mensagem ${messageId} excluída por ${userName} (${userId})`);
      return res.json({ success: true, deletedByName: userName });
    } catch (e: any) {
      console.error('[MSG-DELETE] erro:', e?.message || e);
      return res.status(500).json({ error: e?.message || "erro" });
    }
  });

  // Todas as marcações conversa->etiqueta
  app.get("/api/chat/conversation-labels", authenticateUser, async (_req, res) => {
    try {
      const rows: any = await db.execute(sql`SELECT conversation_id, label_id FROM chat_conversation_labels`);
      res.json({ items: (rows?.rows || []).map((r: any) => ({ conversationId: r.conversation_id, labelId: r.label_id })) });
    } catch (e: any) { console.error('[LABELS] map:', e); res.status(500).json({ error: e?.message }); }
  });

  // Definir as etiquetas de uma conversa (substitui o conjunto) — qualquer atendente pode marcar
  app.post("/api/chat/conversations/:id/labels", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const labelIds: string[] = Array.isArray(req.body?.labelIds) ? req.body.labelIds.map((x: any) => String(x)) : [];
      await db.execute(sql`DELETE FROM chat_conversation_labels WHERE conversation_id = ${id}`);
      for (const lid of labelIds) {
        await db.execute(sql`INSERT INTO chat_conversation_labels (conversation_id, label_id) VALUES (${id}, ${lid}) ON CONFLICT DO NOTHING`);
      }
      res.json({ ok: true, count: labelIds.length });
    } catch (e: any) { console.error('[LABELS] set conv labels:', e); res.status(500).json({ error: e?.message }); }
  });

  console.log("✅ Chat routes registered successfully");
}

// Helper para configurações padrão
function getDefaultAiSettings() {
  return {
    id: null,
    isEnabled: false,
    mode: 'disabled' as const,
    businessHours: {
      weekdays: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'],
      startTime: '08:00',
      endTime: '18:00'
    },
    timeoutMinutes: 5,
    maxTurnsBeforeEscalation: 10,
    handoffKeywords: ['atendente', 'humano', 'gerente', 'vendedor', 'reclamação'],
    systemPrompt: null,
    companyContext: null,
    gptModel: 'gpt-4o-mini',
    createdAt: null,
    updatedAt: null,
    updatedBy: null
  };
}
