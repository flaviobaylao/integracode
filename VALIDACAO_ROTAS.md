# Validação e Correção de Rotas

## 🎯 Objetivo

Sistema de validação automática que garante que **todos os cards** sejam agendados **apenas nos dias corretos** de atendimento do cliente.

## ✅ O Que Foi Implementado

### 1. Validação Automática na Criação de Cards

**Localização**: `server/storage.ts` - função `createSalesCard()`

**Como funciona:**
- Antes de criar qualquer card, o sistema verifica se o `scheduledDate` está alinhado com os `weekdays` do cliente
- Se o cliente atende apenas em segundas (weekdays: ["Seg"]), o sistema **bloqueia** tentativas de criar cards em outros dias
- Lança erro claro: `"Data agendada (Dom) não está nos dias de atendimento do cliente (Seg)"`

**Benefício**: Previne a raiz do problema - cards errados não podem mais ser criados!

### 2. Endpoint de Diagnóstico e Correção Automática

**Endpoint**: `POST /api/admin/validate-cards`

**Permissão**: Apenas usuários `admin`

**Modos de operação:**

#### Modo Diagnóstico (padrão)
```bash
POST /api/admin/validate-cards
Body: { "autoFix": false }
```

**Retorna:**
```json
{
  "totalCards": 8453,
  "inconsistencies": 0,
  "corrected": 0,
  "details": [],
  "message": "0 inconsistências detectadas"
}
```

#### Modo Correção Automática
```bash
POST /api/admin/validate-cards
Body: { "autoFix": true }
```

**O que faz:**
- Escaneia todos os cards futuros
- Identifica cards agendados em dias incompatíveis
- **Corrige automaticamente** a data usando a lógica de `calculateNextVisitDate`
- **Importante**: Mantém o período original (cards de dezembro continuam em dezembro)

**Retorna:**
```json
{
  "totalCards": 8453,
  "inconsistencies": 5,
  "corrected": 5,
  "details": [
    {
      "cardId": "abc-123",
      "customerName": "CLIENTE X",
      "scheduledDate": "2025-11-09T08:00:00.000Z",
      "scheduledDay": "Dom",
      "expectedDays": "Seg",
      "newDate": "2025-11-10T08:00:00.000Z",
      "newDay": "Seg"
    }
  ],
  "message": "5 cards corrigidos automaticamente"
}
```

### 3. Script de Diagnóstico Standalone

**Arquivo**: `diagnose-cards.ts`

**Como usar:**
```bash
tsx diagnose-cards.ts
```

**O que faz:**
- Escaneia todos os cards futuros
- Detecta inconsistências
- Exibe relatório detalhado no terminal
- Mostra estatísticas de distribuição por dia da semana

**Exemplo de saída:**
```
🔍 DIAGNÓSTICO DE CARDS - Sistema Integra

================================================================================

📋 Total de cards futuros: 8453

✅ PERFEITO! Nenhuma inconsistência encontrada!

   Todos os cards estão agendados nos dias corretos.

📊 ESTATÍSTICAS GERAIS
================================================================================

Distribuição de cards por dia da semana:
  Dom: 32 cards
  Seg: 778 cards
  Ter: 3194 cards
  Qua: 690 cards
  Qui: 608 cards
  Sex: 591 cards
  Sab: 1629 cards

✅ Diagnóstico concluído!
```

## 🔧 Como Usar

### Cenário 1: Verificação Preventiva (Recomendado)

Execute o diagnóstico regularmente:

```bash
tsx diagnose-cards.ts
```

Se retornar código de saída 0, está tudo OK!

### Cenário 2: Detectar Problemas Após Importação

Após importar uma planilha, verifique se há problemas:

1. **Via Script:**
   ```bash
   tsx diagnose-cards.ts
   ```

2. **Via API:**
   ```bash
   curl -X POST https://integrahonest.replit.app/api/admin/validate-cards \
     -H "Content-Type: application/json" \
     -d '{"autoFix": false}'
   ```

### Cenário 3: Correção Automática

Se o diagnóstico detectar problemas, corrija automaticamente:

```bash
curl -X POST https://integrahonest.replit.app/api/admin/validate-cards \
  -H "Content-Type: application/json" \
  -d '{"autoFix": true}'
```

⚠️ **IMPORTANTE**: A correção automática é segura e preserva o período original dos cards!

### Cenário 4: Re-sincronização Completa

Se preferir recalcular tudo do zero:

```bash
curl -X POST https://integrahonest.replit.app/api/admin/sync-agenda
```

Isso vai:
- Deletar todos os cards futuros pendentes
- Recalcular usando os `weekdays` e `visitPeriodicity` corretos de cada cliente
- Gerar novos cards com datas corretas

## 🛡️ Garantias de Segurança

### ✅ Validação na Criação
- **Impossível** criar cards em dias errados manualmente
- **Impossível** importar planilhas com rotas incorretas
- Erro claro e imediato se houver tentativa

### ✅ Correção Inteligente
- Preserva o período original (dezembro → dezembro)
- Apenas ajusta para o dia da semana correto mais próximo
- Não puxa cards para "hoje"

### ✅ Rastreabilidade
- Todos os logs são salvos
- Script de diagnóstico roda sem modificar dados
- Endpoint retorna detalhes de todas as correções

## 📊 Monitoramento

### Métricas Disponíveis

O endpoint `/api/admin/validate-cards` retorna:

- `totalCards`: Total de cards futuros
- `inconsistencies`: Quantidade de problemas detectados
- `corrected`: Quantidade corrigida (se autoFix=true)
- `details`: Lista detalhada de cada problema/correção

### Alertas Automáticos

Se `inconsistencies > 0`, significa que:
1. Há cards agendados em dias incompatíveis
2. Provavelmente houve importação manual incorreta
3. Recomenda-se executar correção automática

## 🔍 Troubleshooting

### "Ainda vejo cards em dias errados"

**Possíveis causas:**

1. **Cache do navegador**: Force refresh (Ctrl+Shift+R)
2. **Dados não sincronizados**: Execute `POST /api/admin/sync-agenda`
3. **Confusão de clientes**: Verifique se é realmente o cliente correto

### "Validação falhou ao criar card"

**Mensagem de erro:**
```
Data agendada (Dom) não está nos dias de atendimento do cliente (Seg)
```

**Solução:**
1. Verifique os `weekdays` do cliente no cadastro
2. Certifique-se que a data escolhida está alinhada
3. Se os weekdays estiverem errados, atualize o cadastro do cliente

### "Script de diagnóstico não executa"

**Solução:**
```bash
# Certifique-se de estar no diretório correto
cd /home/runner/workspace

# Execute com tsx
tsx diagnose-cards.ts
```

## 📝 Logs e Auditoria

### Logs de Validação

Toda tentativa de criar card gera log:

```
✅ Validação OK: Card para CLIENTE X agendado para Seg está alinhado com weekdays [Seg]
```

ou

```
❌ ERRO DE VALIDAÇÃO: Tentativa de criar card para CLIENTE Y em Dom (2025-11-09), mas cliente só atende em: Seg
```

### Logs de Correção

Quando `autoFix=true`:

```
🔍 Iniciando diagnóstico de cards...
⚠️ Encontradas 5 inconsistências
✅ Corrigindo card abc-123: Dom → Seg
✅ Corrigindo card def-456: Dom → Seg
...
✅ 5 cards corrigidos automaticamente
```

## 🎓 Boas Práticas

### ✅ Fazer

- Execute `diagnose-cards.ts` após cada importação grande
- Use `autoFix: false` primeiro para ver o que será alterado
- Mantenha os `weekdays` dos clientes sempre atualizados
- Documente mudanças de rota no sistema

### ❌ Evitar

- Não crie cards manualmente sem verificar os weekdays
- Não ignore mensagens de validação
- Não execute múltiplas correções simultâneas
- Não modifique datas de cards diretamente no banco

## 🚀 Integração CI/CD

Você pode adicionar o diagnóstico como check automático:

```bash
#!/bin/bash
# pre-deploy-check.sh

echo "Verificando integridade dos cards..."
tsx diagnose-cards.ts

if [ $? -ne 0 ]; then
  echo "❌ ERRO: Cards com inconsistências detectadas!"
  echo "Execute: POST /api/admin/validate-cards com autoFix=true"
  exit 1
fi

echo "✅ Todos os cards estão corretos!"
```

## 📞 Suporte

Se encontrar problemas:

1. Execute `diagnose-cards.ts` e salve a saída
2. Execute `POST /api/admin/validate-cards` (sem autoFix)
3. Reporte ambas as saídas para análise

## 🔄 Próximas Versões

Melhorias planejadas:

- [ ] Dashboard visual de inconsistências
- [ ] Notificações automáticas quando detectar problemas
- [ ] Histórico de correções executadas
- [ ] Exportação de relatórios em Excel
- [ ] Validação em background a cada hora

---

**Última atualização**: 04/11/2025  
**Versão**: 1.0.0
