# Correção da Lógica de DATA INICIO na Importação

## 🐛 Problema Identificado

A lógica de cálculo da data da primeira visita tinha um **bug sutil mas importante**:

### Comportamento ANTERIOR (Incorreto):
```typescript
// Se o dia já passou OU É HOJE, ir para próxima semana
if (daysUntilTarget <= 0) {  // ❌ ERRADO
  daysUntilTarget += 7;
}
```

**Problema**: Quando a DATA INICIO caía **exatamente** no dia da rota, o sistema pulava para a próxima semana!

**Exemplo do erro:**
- DATA INICIO: 27/10/2025 (segunda-feira)
- ROTA: SEGUNDA-FEIRA
- ❌ Resultado antigo: 03/11/2025 (pulou 1 semana!)
- ✅ Deveria ser: 27/10/2025 (a própria DATA INICIO)

## ✅ Solução Implementada

### Comportamento NOVO (Correto):
```typescript
// Se o dia já passou, ir para próxima semana
// IMPORTANTE: Se daysUntilTarget = 0, significa que DATA INICIO cai no dia da rota!
// Neste caso, devemos usar a própria DATA INICIO como primeira visita
if (daysUntilTarget < 0) {  // ✅ CORRETO
  daysUntilTarget += 7;
}
```

**Agora funciona corretamente:**
- DATA INICIO: 27/10/2025 (segunda-feira)
- ROTA: SEGUNDA-FEIRA
- ✅ Resultado: 27/10/2025 (usa a própria DATA INICIO!)

## 🧪 Casos de Teste

Todos os 3 casos de teste passaram ✅:

### 1. DATA INICIO cai exatamente no dia da rota
- DATA INICIO: 27/10/2025 (segunda)
- ROTA: segunda
- ✅ Resultado: 27/10/2025

### 2. DATA INICIO é antes do dia da rota (mesma semana)
- DATA INICIO: 26/10/2025 (domingo)  
- ROTA: terça
- ✅ Resultado: 28/10/2025

### 3. DATA INICIO é depois do dia da rota (vai para próxima semana)
- DATA INICIO: 29/10/2025 (quarta)
- ROTA: segunda
- ✅ Resultado: 03/11/2025

## 📊 Impacto

### Cards Já Importados
Os cards já importados com a lógica antiga podem ter datas **1 semana à frente** do esperado quando a DATA INICIO coincidia com o dia da rota.

### Futuras Importações
✅ Todas as importações futuras usarão a lógica correta automaticamente.

## 🔄 Comportamento Esperado

A lógica agora funciona assim:

1. **DATA INICIO = Dia da Rota** → Usa a própria DATA INICIO ✅
2. **DATA INICIO < Dia da Rota** (mesma semana) → Próximo dia da rota nesta semana ✅
3. **DATA INICIO > Dia da Rota** → Próximo dia da rota na semana seguinte ✅

## 📝 Arquivo Modificado

- `server/routes.ts` (linhas 1875-1877) - Mudança de `<= 0` para `< 0`

## ✅ Status

- ✅ Bug identificado e corrigido
- ✅ Testes de validação passaram
- ✅ Documentação atualizada
- ✅ Próximas importações funcionarão corretamente
