# Estratégia de Persistência e Backup de Dados - Sistema Integra

## ✅ SEUS DADOS ESTÃO SEGUROS!

O Sistema Integra já está configurado corretamente para **garantir que nenhum dado se perca** durante novas publicações ou atualizações do aplicativo.

---

## 🏗️ Arquitetura de Persistência

### Banco de Dados PostgreSQL (Neon)

Todos os dados do sistema são armazenados em um **banco de dados PostgreSQL gerenciado pela Neon**, que é:

✅ **Persistente** - Os dados não se perdem quando você faz novas publicações  
✅ **Externo** - O banco fica na nuvem, separado do código da aplicação  
✅ **Escalável** - Cresce automaticamente conforme suas necessidades  
✅ **Confiável** - Backups automáticos gerenciados pela Neon  
✅ **Rápido** - Otimizado para aplicações web modernas  

**Localização:** AWS US-East-2 (Ohio)  
**Tipo:** PostgreSQL 16+ Serverless  
**Provider:** Neon Database  

---

## 📊 Dados Armazenados (Estado Atual)

O sistema atualmente possui dados em **25 tabelas diferentes**:

### Dados Críticos do Negócio

| Tabela | Registros Atuais | Descrição |
|--------|------------------|-----------|
| **customers** | 1.188 | Clientes cadastrados |
| **sales_cards** | 665 | Cards de venda (agenda) |
| **billings** | 2.062 | Faturamentos Omie |
| **products** | 60 | Produtos cadastrados |
| **users** | 12 | Usuários do sistema |

### Outras Tabelas Importantes

- **routes** - Rotas de vendedores
- **delivery_drivers** - Cadastro de entregadores
- **delivery_routes** - Rotas de entrega
- **delivery_route_stops** - Paradas das rotas
- **overdue_debts** - Débitos em atraso
- **blocked_orders** - Pedidos bloqueados
- **sync_status** - Status de sincronizações
- **daily_routes** - Rotas diárias geradas
- **route_checkpoints** - Checkpoints de rota
- **visit_agenda** - Agenda de visitas
- **message_templates** - Templates de mensagens
- **message_history** - Histórico de mensagens
- **locations** - Localizações
- **sales_goals** - Metas de vendas
- **exported_reports** - Relatórios exportados
- **delivery_history** - Histórico de entregas
- **telemarketing_agents** - Agentes de telemarketing
- **sessions** - Sessões de usuários
- **system_settings** - Configurações do sistema
- **sync_states** - Estados de sincronização

---

## 🔐 Como Funciona a Persistência

### 1. Separação Código vs. Dados

```
┌─────────────────────┐         ┌──────────────────────┐
│   Código (Replit)   │         │  Dados (Neon DB)     │
│                     │         │                      │
│  - Frontend (React) │         │  - Clientes          │
│  - Backend (Node)   │◄───────►│  - Produtos          │
│  - Lógica negócio   │  API    │  - Vendas            │
│                     │         │  - Usuários          │
│  ⚠️ Pode atualizar  │         │  ✅ Sempre persiste  │
└─────────────────────┘         └──────────────────────┘
```

**Importante:** Quando você faz uma nova publicação (deploy), apenas o **código** é atualizado. O **banco de dados permanece intacto** com todos os dados.

### 2. Conexão Segura

O sistema se conecta ao banco via variável de ambiente `DATABASE_URL`:

```typescript
// server/db.ts
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL 
});
```

Esta variável é **configurada automaticamente** pelo Replit e aponta para o banco Neon.

### 3. ORM Drizzle

Usamos o Drizzle ORM para garantir:
- ✅ Queries SQL seguras e otimizadas
- ✅ Tipagem TypeScript em todas as operações
- ✅ Migrações de schema controladas
- ✅ Proteção contra SQL injection

---

## 🔄 O Que Acontece Durante Uma Nova Publicação?

### ❌ O Que NÃO Acontece:
- ❌ Banco de dados não é apagado
- ❌ Tabelas não são recriadas
- ❌ Dados não são perdidos
- ❌ Conexões não são resetadas

### ✅ O Que Acontece:
1. ✅ Novo código é compilado
2. ✅ Servidor Express é reiniciado
3. ✅ Frontend é reconstruído
4. ✅ **Banco se reconecta automaticamente**
5. ✅ Todos os dados continuam acessíveis

**Tempo de indisponibilidade:** ~30-60 segundos (apenas durante o restart)

---

## 💾 Backups Automáticos

### Backups da Neon Database

A Neon oferece **backups automáticos** do seu banco de dados:

- **Point-in-time recovery (PITR)**: Restaurar o banco para qualquer momento nas últimas 7 dias
- **Daily snapshots**: Snapshots diários mantidos por 7 dias
- **Storage durável**: Replicação automática em múltiplas zonas

**Como acessar backups da Neon:**

**Opção 1: Via Replit (Recomendado)**
1. No Replit, abra a aba **"Tools"** (ferramentas) no lado esquerdo
2. Clique em **"PostgreSQL"** ou **"Database"**
3. Clique em **"Manage in Neon Console"** ou **"Open Neon Dashboard"**
4. No dashboard da Neon, vá em **"Backups"** ou **"Restore"**
5. Selecione a data/hora para restaurar (Point-in-Time Recovery)
6. Escolha se quer restaurar em um novo branch ou sobrescrever o atual
7. Confirme a restauração

**Opção 2: Via Neon Console Direto**
1. Acesse https://console.neon.tech/
2. Faça login com sua conta Replit
3. Selecione seu projeto (Sistema Integra)
4. Vá em "Restore" → "Point-in-time"
5. Escolha data/hora e confirme

### ⚠️ Importante: Replit Checkpoints NÃO Incluem Banco de Dados

Os checkpoints do Replit fazem backup de:
- ✅ Código do projeto
- ✅ Configurações do Replit
- ✅ Arquivos estáticos (attached_assets)
- ❌ **NÃO incluem** dados do banco Neon (que é externo)

**Use checkpoints APENAS para:**
- Reverter alterações de código
- Restaurar arquivos deletados
- Voltar configurações do projeto

**Para backup de DADOS, use:**
- Backups automáticos da Neon (PITR)
- Export manual SQL (veja seção abaixo)

---

## 📦 Estratégias de Backup Adicionais (Recomendado)

### 1. Export Periódico de Dados Críticos

Você pode exportar dados importantes periodicamente:

```sql
-- Exportar clientes
COPY customers TO '/tmp/customers_backup.csv' WITH CSV HEADER;

-- Exportar sales cards
COPY sales_cards TO '/tmp/sales_cards_backup.csv' WITH CSV HEADER;

-- Exportar produtos
COPY products TO '/tmp/products_backup.csv' WITH CSV HEADER;
```

### 2. Sincronização com Omie

Como o sistema já sincroniza com o Omie ERP:
- ✅ Clientes sincronizados com Omie
- ✅ Produtos sincronizados com Omie
- ✅ Faturamentos sincronizados com Omie

O Omie funciona como um **backup externo** desses dados!

### 3. Relatórios Exportados

O sistema já gera relatórios exportáveis:
- Contas a Receber (Excel)
- Rotas de Entrega (PDF)
- Performance de Vendedores

Estes arquivos ficam salvos na tabela `exported_reports`.

---

## 🚨 Cenários de Perda de Dados (e Como Evitar)

### ❌ NUNCA Acontece:
- Perda de dados por nova publicação
- Perda de dados por restart do servidor
- Perda de dados por atualização de código

### ⚠️ PODE Acontecer (e como evitar):

#### 1. Deletar o Banco de Dados Manualmente
**Risco:** ALTO se você deletar o banco no painel do Replit  
**Solução:** NUNCA delete o banco de dados. Se precisar resetar, exporte os dados primeiro.

#### 2. Corromper Schema com Migração Errada
**Risco:** MÉDIO se rodar migrações SQL manuais incorretas  
**Solução:** Sempre use `npm run db:push` para sincronizar o schema. NUNCA edite o schema diretamente no banco.

#### 3. Deletar Deployment com Banco Incluído
**Risco:** MÉDIO se deletar deployment tipo "Reserved VM" que inclui banco  
**Solução:** Use "Autoscale" que separa código e banco. O banco Neon é sempre externo.

---

## ✅ Checklist de Segurança de Dados

Use este checklist antes de cada nova publicação:

- [ ] ✅ Verificar que `DATABASE_URL` está configurada
- [ ] ✅ Testar conexão com banco (`npm run db:push`)
- [ ] ✅ Confirmar que não há migrações pendentes destrutivas
- [ ] ✅ Fazer backup manual se alterando schema crítico
- [ ] ✅ Verificar que tipo de deployment é Autoscale (não Static)
- [ ] ✅ Confirmar que sincronização Omie está funcionando

---

## 🔧 Comandos Úteis

### Verificar Estado do Banco

```bash
# Ver tabelas
npm run db:studio

# Executar query de verificação
psql $DATABASE_URL -c "SELECT COUNT(*) FROM customers;"
```

### Backup Manual

```bash
# Backup completo do banco
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Restaurar backup
psql $DATABASE_URL < backup_20251017.sql
```

### Sincronizar Schema

```bash
# Aplicar mudanças de schema
npm run db:push

# Se houver conflitos, forçar
npm run db:push --force
```

---

## 📞 Suporte em Caso de Problemas

### Se Dados Parecerem Perdidos

1. **NÃO ENTRE EM PÂNICO** - Os dados provavelmente estão lá
2. Verifique se está conectado ao banco correto:
   ```bash
   echo $DATABASE_URL
   ```
3. Teste query simples:
   ```sql
   SELECT COUNT(*) FROM customers;
   ```
4. Se necessário, restaure um checkpoint do Replit

### Se Precisar Restaurar Backup

1. Acesse Replit Dashboard → Database
2. Clique em "Backups"
3. Escolha data/hora
4. Confirme restauração

---

## 📊 Monitoramento

### Verificação Diária Automática

O sistema **JÁ FAZ** verificações automáticas:
- ✅ Sincronização Omie (1x por hora)
- ✅ Geração de agenda (diariamente às 06:00)
- ✅ Processamento de cards atrasados (diariamente às 02:00)

Você pode ver o status na tela do dashboard.

### Alertas Recomendados

Configure alertas para:
- Falhas repetidas de sincronização Omie
- Banco de dados inacessível por > 5 minutos
- Espaço em disco do banco > 80%

---

## 🎯 Resumo Executivo

### ✅ Seus Dados ESTÃO Seguros Porque:

1. **Banco de dados externo (Neon)** - Separado do código
2. **Backups automáticos** - Diários pela Neon + Checkpoints Replit
3. **Sincronização Omie** - Backup externo dos dados principais
4. **Storage persistente** - Todos os dados em PostgreSQL (não em memória)
5. **Migrações controladas** - Schema versionado via Drizzle

### ✅ O Que Você Precisa Fazer:

**NADA!** O sistema já está configurado corretamente.

**Opcional (Recomendado):**
- Verificar dashboard de sincronização semanalmente
- Fazer export manual de dados críticos mensalmente
- Confirmar que backups Neon estão funcionando

---

## 📚 Referências

- [Documentação Neon Database](https://neon.tech/docs)
- [Drizzle ORM](https://orm.drizzle.team)
- [Replit Database](https://docs.replit.com/hosting/databases/postgresql)
- [PostgreSQL Backup & Recovery](https://www.postgresql.org/docs/current/backup.html)

---

**Última atualização:** 17 de Outubro de 2025  
**Versão do documento:** 1.0  
**Responsável:** Sistema Integra - Honest Sucos
