# Evolution API - Guia Completo de Configuração

Este documento explica como configurar e usar a Evolution API como alternativa gratuita ao WhatsApp Business API oficial.

## O que é Evolution API?

A Evolution API é uma solução open-source e gratuita que permite conectar seu sistema ao WhatsApp sem custos de mensagens. Ela funciona conectando-se ao WhatsApp Web via QR Code, assim como você faz no celular.

### Vantagens da Evolution API:
- ✅ **100% Gratuita** - Sem custos por mensagem
- ✅ **Fácil Configuração** - Conecta via QR Code
- ✅ **Auto-hospedada** - Você controla seus dados
- ✅ **Webhooks** - Recebe mensagens em tempo real
- ✅ **Sem Aprovação** - Não precisa de aprovação do Facebook

### Comparação: Evolution API vs WhatsApp Business API Oficial

| Recurso | Evolution API | WhatsApp Business API |
|---------|---------------|----------------------|
| Custo | Gratuito | Pago (por mensagem) |
| Aprovação | Não necessária | Requer aprovação Facebook |
| Conexão | QR Code (WhatsApp Web) | API Oficial |
| Templates | Não | Sim |
| Escalabilidade | Limitada | Alta |
| Ideal para | Testes, PMV, pequenos volumes | Produção, grandes volumes |

## Passo 1: Deploy da Evolution API

### Opção 1: Deploy no Replit (Recomendado para Testes)

1. **Criar novo Repl**
   - Acesse [replit.com](https://replit.com)
   - Clique em "Create Repl"
   - Escolha template "Node.js"
   - Nome: "evolution-api-server"

2. **Clonar Evolution API**
   ```bash
   git clone https://github.com/EvolutionAPI/evolution-api.git .
   npm install
   ```

3. **Configurar variáveis de ambiente**
   Crie arquivo `.env`:
   ```env
   # Servidor
   SERVER_URL=https://seu-repl-url.replit.dev
   PORT=5000
   
   # Database (opcional - usar SQLite)
   DATABASE_ENABLED=true
   DATABASE_PROVIDER=sqlite
   
   # Autenticação
   AUTHENTICATION_API_KEY=sua_chave_secreta_aqui
   
   # Webhooks
   WEBHOOK_GLOBAL_ENABLED=false
   ```

4. **Iniciar servidor**
   ```bash
   npm start
   ```

### Opção 2: Deploy no Railway (Recomendado para Produção)

1. **Criar conta no Railway**
   - Acesse [railway.app](https://railway.app)
   - Faça login com GitHub

2. **Deploy da Evolution API**
   - Clique em "New Project"
   - Selecione "Deploy from GitHub repo"
   - Escolha: `EvolutionAPI/evolution-api`
   - Configure variáveis de ambiente (mesmas do passo anterior)

3. **Obter URL do servidor**
   - Após deploy, copie a URL pública
   - Exemplo: `https://evolution-api-production.up.railway.app`

### Opção 3: Deploy no Render

1. **Criar conta no Render**
   - Acesse [render.com](https://render.com)
   - Faça login com GitHub

2. **Criar Web Service**
   - Clique em "New +" → "Web Service"
   - Conecte ao repositório: `EvolutionAPI/evolution-api`
   - Configure:
     - Name: evolution-api
     - Environment: Node
     - Build Command: `npm install`
     - Start Command: `npm start`

3. **Adicionar variáveis de ambiente**
   - Vá em "Environment"
   - Adicione as mesmas variáveis do passo 1

## Passo 2: Configurar no Sistema

### 2.1 Acessar Painel Administrativo

1. Login como administrador no sistema
2. Vá em "Configurações" (menu lateral)
3. Role até a seção "Evolution API (Alternativa Gratuita)"

### 2.2 Configurar Credenciais

Preencha os seguintes campos:

1. **URL da API**
   - URL do servidor Evolution API deployado
   - Exemplo: `https://evolution-api-production.up.railway.app`

2. **API Key**
   - A mesma que você configurou no `.env` da Evolution API
   - Exemplo: `sua_chave_secreta_aqui`

3. **Nome da Instância**
   - Nome único para sua instância WhatsApp
   - Exemplo: `whatsapp-customer-service`
   - Use apenas letras, números e hífens

4. Clique em "Salvar Configuração Evolution API"

### 2.3 Testar Conexão

1. Clique no botão "Testar Conexão"
2. Se bem-sucedido, verá: ✅ "Conexão bem-sucedida!"
3. Se falhar, verifique:
   - URL está correta e acessível
   - API Key está correta
   - Servidor Evolution API está rodando

## Passo 3: Conectar WhatsApp via QR Code

### 3.1 Criar/Conectar Instância

1. No painel administrativo, clique em "Conectar Instância"
2. Uma nova instância será criada no servidor Evolution API
3. Status mudará para "disconnected" (normal)

### 3.2 Escanear QR Code

**Importante**: A geração do QR Code deve ser feita diretamente na Evolution API:

1. **Acessar Evolution API Manager**
   - URL: `https://sua-evolution-api.com/manager`
   - Login com a API Key

2. **Gerar QR Code**
   - Clique na instância criada
   - Clique em "Connect"
   - QR Code aparecerá na tela

3. **Escanear no WhatsApp**
   - Abra WhatsApp no celular
   - Vá em Menu → Aparelhos conectados
   - Clique em "Conectar um aparelho"
   - Escaneie o QR Code

4. **Aguardar Conexão**
   - Status mudará para "open" quando conectado
   - No painel do sistema, status mostrará: ✅ Conectado

### 3.3 Verificar Status

No painel administrativo:
- **Status**: Mostra estado da conexão
  - ✅ "open" = Conectado e funcionando
  - ⚠️ "connecting" = Conectando...
  - ❌ "disconnected" = Desconectado
  - ⚠️ "Não criada" = Instância não existe

## Passo 4: Configurar Webhook para Receber Mensagens

### 4.1 URL do Webhook

O sistema já está configurado para receber mensagens em:
```
https://seu-dominio.replit.dev/api/evolution/webhook
```

### 4.2 Configurar na Evolution API

**Opção A: Via API (Automático)**
- Já configurado automaticamente quando você salva as credenciais
- O sistema configura o webhook automaticamente

**Opção B: Via Manager (Manual)**
1. Acesse Evolution API Manager
2. Clique na instância
3. Vá em "Settings" → "Webhook"
4. Configure:
   - URL: `https://seu-dominio.replit.dev/api/evolution/webhook`
   - Enabled: `true`
   - Events: Selecione `messages.upsert`

### 4.3 Testar Recebimento

1. Envie uma mensagem para o WhatsApp conectado de outro número
2. Verifique no dashboard se a mensagem apareceu
3. Se não aparecer:
   - Verifique logs do servidor
   - Confirme que webhook está configurado
   - Teste a URL do webhook manualmente

## Passo 5: Começar a Usar

### 5.1 Prioridade de Envio

O sistema usa a seguinte ordem de prioridade para enviar mensagens:

1. **Evolution API** (se configurada e conectada)
2. **WhatsApp Business API Oficial** (se configurada)
3. **Modo Simulação** (se nenhuma configurada)

### 5.2 Enviar Mensagem de Teste

1. Crie uma nova conversa no dashboard
2. Digite uma mensagem
3. Envie
4. A mensagem será enviada via Evolution API automaticamente
5. Verifique no WhatsApp se foi recebida

### 5.3 Receber Mensagens

1. Cliente envia mensagem para seu WhatsApp
2. Evolution API recebe via WhatsApp Web
3. Webhook envia para seu sistema
4. Mensagem aparece no dashboard
5. Agente pode responder em tempo real

## Solução de Problemas

### Problema: QR Code não aparece

**Solução**:
- Acesse diretamente o Manager da Evolution API
- URL: `https://sua-evolution-api.com/manager`
- Gere o QR Code por lá

### Problema: Conexão cai constantemente

**Solução**:
- Verifique internet do celular conectado
- WhatsApp precisa estar aberto no celular periodicamente
- Considere usar WhatsApp Business (mais estável)
- Em produção, use servidor dedicado (não Replit gratuito)

### Problema: Mensagens não chegam

**Solução**:
1. Verifique status da conexão: "open"
2. Confirme webhook configurado corretamente
3. Teste webhook manualmente:
   ```bash
   curl -X POST https://seu-dominio.replit.dev/api/evolution/webhook \
     -H "Content-Type: application/json" \
     -d '{"event":"messages.upsert","data":{"key":{"remoteJid":"5511999999999@s.whatsapp.net"},"message":{"conversation":"teste"}}}'
   ```
4. Verifique logs do servidor

### Problema: Não consigo enviar mensagens

**Solução**:
1. Confirme Evolution API está configurada
2. Verifique status da instância: "open"
3. Teste envio manual via API da Evolution
4. Verifique logs de erro no console

### Problema: "Instance not found"

**Solução**:
- Clique em "Conectar Instância" novamente
- Isso criará uma nova instância
- Escaneie o QR Code novamente

## Boas Práticas

### Para Testes e Desenvolvimento

✅ **Recomendado**:
- Use Evolution API no Replit
- Número de telefone pessoal/teste
- Baixo volume de mensagens

❌ **Evite**:
- Usar número de produção
- Alto volume de mensagens
- Dados sensíveis de clientes

### Para Produção

✅ **Recomendado**:
- Deploy dedicado (Railway, Render, VPS)
- WhatsApp Business (mais estável)
- Monitoramento de conexão
- Backup da sessão
- Considere WhatsApp Business API Oficial para alto volume

❌ **Evite**:
- Servidor gratuito com sleep/timeout
- Compartilhar API Key
- Desconectar/reconectar frequentemente

## Custos Estimados

| Plataforma | Custo Mensal | Recursos |
|------------|--------------|----------|
| Replit (Free) | $0 | Limitado, com sleep |
| Railway (Hobby) | ~$5 | Servidor dedicado 24/7 |
| Render (Starter) | $7 | Servidor dedicado 24/7 |
| VPS Digital Ocean | $6 | Servidor dedicado, mais controle |

## Migração para API Oficial

Quando seu negócio crescer, você pode migrar para WhatsApp Business API:

1. Mantenha Evolution API configurada
2. Configure também WhatsApp Business API
3. Sistema priorizará Evolution API automaticamente
4. Para migrar: desconecte Evolution API
5. Sistema usará automaticamente API Oficial

## Suporte e Documentação

- **Evolution API Docs**: https://doc.evolution-api.com/
- **GitHub**: https://github.com/EvolutionAPI/evolution-api
- **Community**: Discord da Evolution API
- **API Reference**: https://doc.evolution-api.com/v2/pt/get-started/introduction

## Segurança

⚠️ **Importante**:
- Nunca compartilhe sua API Key
- Use HTTPS sempre
- Mantenha Evolution API atualizada
- Monitore logs de acesso
- Use autenticação forte
- Em produção, configure firewall/restrições de IP

---

## Checklist Rápido

- [ ] Deploy da Evolution API realizado
- [ ] Variáveis de ambiente configuradas
- [ ] URL e API Key salvos no sistema
- [ ] Teste de conexão bem-sucedido
- [ ] Instância criada
- [ ] QR Code escaneado
- [ ] Status "open" confirmado
- [ ] Webhook configurado
- [ ] Mensagem de teste enviada
- [ ] Mensagem de teste recebida
- [ ] Sistema funcionando ✅

---

**Última atualização**: Setembro 2025
