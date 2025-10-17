# Guia de Publicação (Deployment) - Sistema Integra

## ⚠️ Problema Comum: Tela em Branco Após Publicação

Se após publicar o app a tela ficar em branco, siga este guia para corrigir.

## 🔧 Configuração de Variáveis de Ambiente

### 1. REPLIT_DOMAINS (MAIS IMPORTANTE!)

Esta variável define quais domínios podem usar a autenticação Replit. Após publicar, você terá **dois domínios**:

- **Desenvolvimento**: `nome-do-repl-usuario.repl.co`
- **Produção**: `nome-do-repl-usuario.replit.app`

**Como configurar:**

1. Vá para a aba **Secrets** (ícone de cadeado) no Replit
2. Encontre ou crie a variável `REPLIT_DOMAINS`
3. Configure com **AMBOS** os domínios separados por vírgula:

```
nome-do-repl-usuario.repl.co,nome-do-repl-usuario.replit.app
```

**Exemplo real:**
```
sistema-integra-bebahonest.repl.co,sistema-integra-bebahonest.replit.app
```

### 2. DATABASE_URL

Esta variável já deve estar configurada automaticamente pelo Replit quando você provisiona o banco PostgreSQL.

**Verificar:**
1. Vá na aba **Secrets**
2. Confirme que existe `DATABASE_URL`
3. O valor deve começar com `postgresql://`

Se não existir, você precisa provisionar um banco de dados PostgreSQL através da aba **Database** do Replit.

### 3. SESSION_SECRET

Esta variável é usada para assinar cookies de sessão.

**Configurar:**
1. Vá na aba **Secrets**
2. Crie/edite `SESSION_SECRET`
3. Use uma string aleatória longa (mínimo 32 caracteres)

**Gerar um secret seguro:**
```bash
# No terminal do Replit, rode:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Variáveis da API Omie

Se você usa integração com Omie ERP, configure:

- `OMIE_APP_KEY`: Chave da aplicação Omie
- `OMIE_APP_SECRET`: Secret da aplicação Omie

### 5. Outras Variáveis (Opcionais)

Dependendo das funcionalidades:
- `WHATSAPP_TOKEN`: Token da API WhatsApp Business
- `ISSUER_URL`: URL do provedor OIDC (padrão: `https://replit.com/oidc`)

## ✅ Checklist de Publicação

Antes de publicar, verifique:

- [ ] Banco de dados PostgreSQL provisionado
- [ ] `REPLIT_DOMAINS` inclui domínio `.replit.app`
- [ ] `DATABASE_URL` configurada (automática)
- [ ] `SESSION_SECRET` configurada (string aleatória longa)
- [ ] Todas as secrets da API Omie configuradas
- [ ] Código commitado e sem erros

## 🚀 Como Publicar

1. Clique no botão **Publish** no topo direito do Replit
2. Configure as opções de deployment:
   - **Domain**: Escolha um subdomínio personalizado ou use o padrão
   - **Database**: Selecione o banco de produção
3. Clique em **Publish Project**

## 🐛 Diagnóstico de Problemas

### Tela em Branco

1. **Abra o Console do Navegador** (F12 → Console)
   - Procure por erros em vermelho
   - Erros de autenticação geralmente aparecem aqui

2. **Verifique os Logs do Servidor**
   - No Replit, abra a aba **Logs**
   - Procure por mensagens de erro ao iniciar

3. **Teste o Endpoint de Autenticação**
   - Acesse: `https://seu-dominio.replit.app/api/auth/user`
   - Se retornar 401, a autenticação está funcionando (você só não está logado)
   - Se retornar 500 ou erro, há problema no servidor

### Erros Comuns

**Erro**: "Environment variable REPLIT_DOMAINS not provided"
- **Solução**: Configure `REPLIT_DOMAINS` nos Secrets

**Erro**: "DATABASE_URL must be set"
- **Solução**: Provisione um banco PostgreSQL

**Erro**: "Unauthorized" ao tentar logar
- **Solução**: Verifique se `REPLIT_DOMAINS` inclui o domínio atual

**Erro**: "Session secret not provided"
- **Solução**: Configure `SESSION_SECRET` nos Secrets

## 📞 Suporte

Se após seguir este guia o problema persistir:

1. Verifique se o app funciona em desenvolvimento (`.repl.co`)
2. Compare as variáveis de ambiente entre dev e produção
3. Consulte os logs do servidor para mensagens específicas
4. Entre em contato com suporte técnico com capturas de tela dos erros

## 🔄 Atualizar App Publicado

Após fazer alterações no código:

1. Commite as mudanças
2. A publicação será **automaticamente atualizada**
3. Aguarde alguns segundos para o deploy completar
4. Recarregue a página do app publicado

## ⚡ Dica: Testar Antes de Publicar

Antes de publicar, teste localmente:

```bash
# Simule o ambiente de produção
export NODE_ENV=production
npm run dev
```

Acesse pelo domínio `.repl.co` e verifique se tudo funciona corretamente.
