# Guia de Publicação (Deployment) - Sistema Integra

## ⚠️ Problema: Tela em Branco Após Publicação

Se após publicar o app a tela ficar em branco, siga este guia passo a passo.

## 🔍 PRIMEIRO PASSO: Verificar Status do Sistema

Acesse este endpoint para ver o diagnóstico completo:

```
https://SEU-DOMINIO.replit.app/api/health
```

Substitua `SEU-DOMINIO` pelo seu domínio real. Você verá informações como:

```json
{
  "status": "ok",
  "hostname": "seu-app.replit.app",
  "checks": {
    "database": true,
    "session": true,
    "replitDomains": true,
    "omieConfig": true
  },
  "config": {
    "replitDomains": ["seu-app.replit.app"],
    "hasSessionSecret": true,
    "hasDatabaseUrl": true,
    "hasOmieKey": true,
    "hasOmieSecret": true
  }
}
```

**Se algum check estiver `false`, esse é o problema!**

## 🔧 Variáveis de Ambiente Obrigatórias

### ✅ 1. SESSION_SECRET (MAIS IMPORTANTE!)

Esta variável **DEVE** ser configurada manualmente para produção.

**Como configurar:**

1. Vá para a aba **Secrets** no Replit (ícone de cadeado)
2. Clique em **+ New Secret**
3. Configure:
   - **Key**: `SESSION_SECRET`
   - **Value**: Uma string aleatória longa (mínimo 32 caracteres)

**Gerar um secret seguro:**
```bash
# Cole isso no terminal do Replit:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copie o resultado e cole como valor do `SESSION_SECRET`.

### ✅ 2. DATABASE_URL

Esta variável é configurada automaticamente quando você provisiona um banco PostgreSQL.

**Verificar:**
1. Vá na aba **Database** no Replit
2. Confirme que há um banco PostgreSQL provisionado
3. Na aba **Secrets**, deve aparecer `DATABASE_URL` automaticamente

**Se não tiver:**
- Clique em **Create Database** na aba Database
- Escolha **PostgreSQL**

### ⚠️ 3. REPLIT_DOMAINS

**IMPORTANTE: Você NÃO precisa configurar isso manualmente!**

O Replit fornece essa variável automaticamente em produção com:
- Domínio de desenvolvimento: `seu-app-usuario.repl.co`
- Domínio publicado: `seu-app-usuario.replit.app`

Se você configurou manualmente, pode **remover** essa secret.

### 🔧 4. Variáveis da API Omie (Opcionais)

Se você usa integração com Omie ERP:

- `OMIE_APP_KEY`: Chave da aplicação Omie
- `OMIE_APP_SECRET`: Secret da aplicação Omie

Estas devem ser configuradas manualmente na aba Secrets.

## 📋 Checklist de Publicação

Antes de publicar, verifique:

- [ ] Banco de dados PostgreSQL provisionado
- [ ] `SESSION_SECRET` configurada manualmente (string aleatória)
- [ ] `DATABASE_URL` aparece automaticamente nos Secrets
- [ ] **NÃO** configure `REPLIT_DOMAINS` manualmente (é automática)
- [ ] Todas as secrets da API Omie configuradas (se usar)
- [ ] Código sem erros no console

## 🚀 Como Publicar

1. Clique no botão **Deploy** no topo do Replit
2. Configure as opções:
   - **Deployment Type**: Escolha **Autoscale** ou **Reserved VM**
   - **NÃO use Static Deployment** (o app precisa de backend)
3. Clique em **Deploy**
4. Aguarde o deploy completar

## 🐛 Diagnóstico de Problemas

### Método 1: Endpoint de Health Check

Acesse: `https://seu-dominio.replit.app/api/health`

Isso mostrará exatamente qual variável está faltando.

### Método 2: Logs do Servidor

1. No Replit, vá para **Deployments**
2. Clique no deployment ativo
3. Abra a aba **Logs**
4. Procure por mensagens como:
   - `❌ ERRO CRÍTICO: SESSION_SECRET não configurada!`
   - `❌ ERRO CRÍTICO: DATABASE_URL não configurada!`

### Método 3: Console do Navegador

1. Abra o app publicado
2. Pressione **F12** para abrir Developer Tools
3. Vá na aba **Console**
4. Procure por erros em vermelho

## 🔥 Erros Comuns e Soluções

### Erro: "SESSION_SECRET must be provided"

**Solução:**
1. Vá em Secrets
2. Crie `SESSION_SECRET` com valor aleatório longo
3. Redeploy o app

### Erro: "DATABASE_URL must be provided"

**Solução:**
1. Vá na aba Database
2. Provisione um banco PostgreSQL
3. Aguarde alguns minutos
4. Redeploy o app

### Erro: "REPLIT_DOMAINS not provided in production"

**Solução:**
- Este erro NÃO deveria acontecer em produção
- O Replit fornece essa variável automaticamente
- Se acontecer, contacte o suporte do Replit

### Tela em branco sem erros nos logs

**Possíveis causas:**

1. **JavaScript não carregando**: Verifique se há erros 404 no Console do navegador
2. **Tipo de deployment errado**: Use Autoscale ou Reserved VM, não Static
3. **Porta incorreta**: O app deve servir na porta 5000 (já configurado)

**Soluções:**
1. Limpe o cache do navegador (Ctrl + Shift + Delete)
2. Tente em modo anônimo/privado
3. Verifique se escolheu Autoscale/Reserved VM ao publicar

## 🔄 Atualizar App Publicado

Após fazer alterações no código:

1. As mudanças são deployadas **automaticamente**
2. Não precisa republicar manualmente
3. Aguarde 1-2 minutos para o deploy completar
4. Recarregue a página do app

## ⚡ Teste Antes de Publicar

Teste no ambiente de desenvolvimento primeiro:

```bash
# No terminal do Replit
npm run dev
```

Acesse pelo domínio `.repl.co` e verifique se:
- Login funciona
- Dashboard carrega
- Não há erros no console

Se funcionar em desenvolvimento mas não em produção:
- O problema é com variáveis de ambiente
- Use o endpoint `/api/health` para diagnosticar

## 📞 Checklist Final

Se a tela continuar em branco:

1. ✅ Acesse `/api/health` e verifique todos os checks
2. ✅ Confirme que `SESSION_SECRET` está nos Secrets
3. ✅ Confirme que banco PostgreSQL está provisionado
4. ✅ Verifique os Logs do deployment por erros
5. ✅ Verifique o Console do navegador (F12)
6. ✅ Confirme que usou Autoscale/Reserved VM (não Static)

Se todos os checks passarem e ainda tiver tela branca:
- Copie a URL do `/api/health`
- Copie os logs do servidor
- Copie os erros do Console do navegador
- Entre em contato com suporte

## 🎯 Resumo em 3 Passos

**Para resolver tela em branco:**

1. **Configure SESSION_SECRET** nos Secrets (valor aleatório longo)
2. **Provisione PostgreSQL** na aba Database
3. **Use Autoscale ou Reserved VM** ao publicar (não Static)

Isso resolve 99% dos casos!
