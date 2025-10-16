# Guia de Geração Automática de Agenda Futura

## Visão Geral

Sistema automatizado que gera cards de vendas futuros (3+ meses) para clientes com base em suas configurações de periodicidade de visitas. Alcançou 52% de cobertura completa (350/673 clientes com agenda de 4+ meses).

## Arquitetura

### Componentes Principais

1. **`shared/visitSchedule.ts`**: Lógica de cálculo de próxima visita
   - `calculateNextVisitDate()`: Calcula próxima data baseada em weekdays e periodicidade
   
2. **`server/storage.ts`**: Geração recursiva de cards
   - `generateNextSalesCard()`: Cria automaticamente o próximo card quando um card é completado
   
3. **Scripts Utilitários**:
   - `generate-future-agenda.ts`: Geração em lote (até 3 meses à frente)
   - `unlock-all-clients.ts`: Desbloqueia clientes sem `next_card_id` vinculado

## Fluxo de Geração

### 1. Geração Automática (Recursiva)

Quando um card é marcado como "completed":
```typescript
// storage.ts - generateNextSalesCard()
1. Busca customer data (weekdays, periodicity)
2. Calcula próxima data usando calculateNextVisitDate()
3. Deriva routeDay do dia da semana
4. Cria novo card pendente com parentCardId = card atual
5. Atualiza card atual com nextCardId = novo card
6. Retorna novo card criado
```

### 2. Geração em Lote (Script)

Para popular agenda inicial de 3 meses:
```bash
NODE_ENV=development tsx server/scripts/generate-future-agenda.ts
```

Lógica:
- Para cada cliente com periodicidade configurada
- Segue a cadeia de next_card_id até o último card pendente
- Gera cards até atingir 3 meses à frente
- Usa mesma lógica de calculateNextVisitDate()

### 3. Desbloqueio de Clientes

Quando clientes não têm next_card_id vinculado:
```bash
NODE_ENV=development tsx server/scripts/unlock-all-clients.ts
```

Processo:
- Identifica clientes com apenas 1 card e sem next_card_id
- Cria manualmente o primeiro próximo card
- Vincula next_card_id no card pai
- Permite que geração automática continue

## Requisitos para Geração

### Cliente deve ter:
1. ✅ `visitPeriodicity` configurado (semanal, quinzenal, mensal, bimestral)
2. ✅ `weekdays` array JSON válido (ex: ["segunda", "quarta"])
3. ✅ Pelo menos 1 sales card pendente

### Card deve ter:
- `customerId` válido
- `sellerId` válido
- `status = 'pending'`
- `scheduledDate` preenchida

## Resultados Alcançados

### Geração Total: 2,127 cards

**Distribuição por Mês:**
- Outubro/2025: 1,229 cards (673 clientes)
- Novembro/2025: 1,111 cards (442 clientes)
- Dezembro/2025: 1,031 cards (350 clientes)
- Janeiro/2026: 830 cards (345 clientes)

**Cobertura de Agenda:**
- ✅ 4+ meses completos: 350 clientes (52.0%)
- ⚠️ 2 meses: 92 clientes (13.7%)
- ❌ 1 mês: 231 clientes (34.3%)

**Melhoria:** De 20.5% → 52% de clientes com agenda completa (+154%)

## Processo de Execução

### Cenário 1: Primeira Geração (Sistema Novo)

```bash
# 1. Gerar agenda inicial de 3 meses
NODE_ENV=development tsx server/scripts/generate-future-agenda.ts

# 2. Verificar cobertura no banco
# (usar query SQL abaixo)

# 3. Se houver clientes com apenas 1 mês, desbloquear
NODE_ENV=development tsx server/scripts/unlock-all-clients.ts

# 4. Rodar novamente geração de agenda
NODE_ENV=development tsx server/scripts/generate-future-agenda.ts

# 5. Repetir passos 3-4 até cobertura satisfatória
```

### Cenário 2: Manutenção Contínua

A geração automática acontece via `generateNextSalesCard()` quando:
- Vendedor completa um card (marca como "completed")
- Sistema automaticamente cria o próximo card da cadeia
- Não precisa rodar scripts manualmente

## Queries de Diagnóstico

### Verificar Cobertura Atual
```sql
WITH cliente_agenda AS (
  SELECT 
    customer_id,
    COUNT(DISTINCT DATE_TRUNC('month', scheduled_date)) as meses_distintos
  FROM sales_cards
  WHERE status = 'pending'
  GROUP BY customer_id
)
SELECT 
  CASE
    WHEN meses_distintos = 1 THEN '❌ 1 mês'
    WHEN meses_distintos = 2 THEN '⚠️ 2 meses'
    WHEN meses_distintos = 3 THEN '✅ 3 meses'
    WHEN meses_distintos >= 4 THEN '✅ 4+ meses'
  END as status,
  COUNT(*) as clientes,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) as percentual
FROM cliente_agenda
GROUP BY meses_distintos
ORDER BY meses_distintos;
```

### Identificar Clientes Bloqueados
```sql
SELECT 
  c.id,
  c.name,
  COUNT(sc.id) as total_cards
FROM customers c
INNER JOIN sales_cards sc ON c.id = sc.customer_id
WHERE sc.status = 'pending'
  AND sc.next_card_id IS NULL
  AND sc.parent_card_id IS NULL
GROUP BY c.id, c.name
HAVING COUNT(sc.id) = 1;
```

## Troubleshooting

### Problema: Cliente não gera cards automaticamente

**Causa:** Falta next_card_id no último card
**Solução:**
```bash
NODE_ENV=development tsx server/scripts/unlock-all-clients.ts
```

### Problema: Script retorna NULL para alguns clientes

**Causa:** Falta weekdays ou visitPeriodicity
**Solução:** Verificar e corrigir dados do cliente:
```sql
SELECT id, name, visit_periodicity, weekdays
FROM customers
WHERE (visit_periodicity IS NULL OR weekdays IS NULL)
  AND id IN (SELECT customer_id FROM sales_cards WHERE status = 'pending');
```

### Problema: Cards gerados com datas incorretas

**Causa:** weekdays em formato errado
**Solução:** Garantir que weekdays seja array JSON:
```json
["segunda", "terca"] ✅
"segunda,terca" ❌
```

## Limitações Conhecidas

1. **Clientes sem periodicidade**: Não geram cards automaticamente
2. **Mudança de periodicidade**: Requer regeneração manual da agenda
3. **Timeout em execuções longas**: Scripts podem demorar 10-15 min para processar todos os clientes
4. **Cards fora da sequência**: Se card intermediário for deletado, quebra a cadeia de next_card_id

## Manutenção Futura

### Quando rodar os scripts:

1. **unlock-all-clients.ts**:
   - Após importação em lote de novos clientes
   - Quando cobertura < 50% de clientes com agenda completa
   - Mensalmente para manutenção preventiva

2. **generate-future-agenda.ts**:
   - Logo após unlock-all-clients.ts
   - Quando adicionar novos clientes ao sistema
   - Início de cada trimestre para garantir cobertura de 3 meses

### Monitoramento:

Execute query de cobertura semanalmente para identificar degradação:
```sql
-- Se percentual de "✅ 4+ meses" cair abaixo de 40%, rodar scripts de manutenção
```

## Referências de Código

- **Cálculo de data**: `shared/visitSchedule.ts` → `calculateNextVisitDate()`
- **Geração automática**: `server/storage.ts` → `generateNextSalesCard()`
- **Script de geração**: `server/scripts/generate-future-agenda.ts`
- **Script de desbloqueio**: `server/scripts/unlock-all-clients.ts`
