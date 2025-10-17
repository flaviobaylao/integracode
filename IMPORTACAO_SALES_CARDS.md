# Guia de Importação de Sales Cards via Planilha Excel

## Visão Geral

Este documento descreve o formato correto para importação em massa de Sales Cards (Cards de Venda) através de planilhas Excel ou CSV.

## Formato da Planilha

### Colunas Obrigatórias

A planilha deve conter as seguintes colunas (os nomes não são case-sensitive):

1. **CNPJ/CPF** ou **Cliente (Nome Fantasia)**
   - Identificação do cliente
   - Pode ser CNPJ/CPF ou nome fantasia
   - O sistema tentará localizar o cliente pelo documento primeiro, depois pelo nome

2. **ROTA** ou **Dia da Rota** ou **Dia**
   - Dia da semana para a visita
   - Formatos aceitos (case-insensitive):
     - `SEGUNDA-FEIRA`, `segunda-feira`, `Segunda`, `SEG`
     - `TERÇA-FEIRA`, `TERCA-FEIRA`, `terça-feira`, `Terça`, `TER`
     - `QUARTA-FEIRA`, `quarta-feira`, `Quarta`, `QUA`
     - `QUINTA-FEIRA`, `quinta-feira`, `Quinta`, `QUI`
     - `SEXTA-FEIRA`, `sexta-feira`, `Sexta`, `SEX`
     - `SÁBADO`, `SABADO`, `sábado`, `Sábado`, `SAB`
     - `DOMINGO`, `domingo`, `Domingo`, `DOM`

3. **FREQUENCIA** ou **Periodicidade** ou **Recorrencia**
   - Periodicidade da visita
   - Valores aceitos (case-insensitive):
     - `SEMANAL` ou `SEMANALMENTE`
     - `QUINZENAL` ou `QUINZENALMENTE`
     - `MENSAL` ou `MENSALMENTE`

### Exemplo de Planilha

| CNPJ/CPF | Cliente (Nome Fantasia) | ROTA | FREQUENCIA |
|----------|------------------------|------|------------|
| 00.058.238/0001-78 | SUPERMERCADO PINTA SILGO | QUARTA-FEIRA | SEMANAL |
| 00.065.979/0001-86 | MERCADINHO JAO | SEGUNDA-FEIRA | SEMANAL |
| 00.066.852/0001-81 | SUPERMERCADO RIO DAS PEDRAS | SEGUNDA-FEIRA | QUINZENAL |
| 00.104.071/0001-34 | PANIFICADORA LAGO DAS ROSAS | TERÇA-FEIRA | MENSAL |

## Como Importar

### Passo a Passo

1. Acesse o sistema e faça login
2. Na página inicial (Cards de Venda), clique no botão **"Importar Planilha"**
3. Selecione o arquivo Excel (.xlsx, .xls) ou CSV
4. Clique em **"Importar"**
5. Aguarde o processamento - o sistema mostrará o resultado da importação

### Regras de Importação

1. **Validação de Cliente**: O sistema procura o cliente por CNPJ/CPF ou nome fantasia. Se não encontrar, o card **não será criado**.

2. **Cards Existentes**: Se o cliente já tiver um card ativo (status `pending` ou `telemarketing`), um **novo card NÃO será criado** para evitar duplicatas.

3. **Data Agendada**: O sistema calcula automaticamente a próxima data de visita baseada no dia da rota especificado:
   - Se hoje é quinta-feira e a rota é "segunda", o card será agendado para a próxima segunda-feira
   - Se a rota é "hoje" (mesmo dia), o card é criado para hoje

4. **Fallbacks**:
   - Se a coluna ROTA não for encontrada ou estiver vazia → usa `segunda-feira` como padrão
   - Se o valor da ROTA não for reconhecido → calcula baseado na data agendada
   - Se FREQUENCIA não for especificada → usa a periodicidade cadastrada do cliente

## Mapeamento Interno

### Dias da Semana
O sistema mapeia os dias para valores internos normalizados:

| Entrada na Planilha | Valor Interno |
|---------------------|---------------|
| SEGUNDA-FEIRA, Segunda, SEG | `segunda` |
| TERÇA-FEIRA, TERCA-FEIRA, Terça, TER | `terca` |
| QUARTA-FEIRA, Quarta, QUA | `quarta` |
| QUINTA-FEIRA, Quinta, QUI | `quinta` |
| SEXTA-FEIRA, Sexta, SEX | `sexta` |
| SÁBADO, SABADO, Sábado, SAB | `sabado` |
| DOMINGO, Domingo, DOM | `domingo` |

### Periodicidade
| Entrada na Planilha | Valor Interno |
|---------------------|---------------|
| SEMANAL, SEMANALMENTE | `weekly` |
| QUINZENAL, QUINZENALMENTE | `biweekly` |
| MENSAL, MENSALMENTE | `monthly` |

## Resolução de Problemas

### Problema: Todos os cards foram criados para segunda-feira

**Causa**: A coluna "ROTA" não foi encontrada na planilha ou está com nome diferente.

**Solução**: 
- Verifique se a planilha tem uma coluna chamada exatamente "ROTA" (maiúsculas/minúsculas não importam)
- Alternativas aceitas: "Dia da Rota", "Dia", "rota"
- **Prioridade**: O sistema procura primeiro por "ROTA", depois "Dia da Rota", depois "Dia"

### Problema: Cliente não foi importado

**Causas possíveis**:
1. Cliente não existe no sistema
2. CNPJ/CPF está incorreto ou não está normalizado
3. Cliente já possui card ativo (pending ou telemarketing)

**Solução**:
- Verifique se o cliente existe no cadastro
- Para CNPJ/CPF, não importa se tem pontos/traços - o sistema normaliza automaticamente
- Verifique se há cards pendentes para este cliente antes de importar

### Problema: Erro ao processar planilha

**Causas possíveis**:
1. Arquivo corrompido
2. Formato não suportado
3. Planilha vazia

**Solução**:
- Salve a planilha novamente em formato .xlsx
- Verifique se há pelo menos uma linha de dados (além do cabeçalho)
- Tente com um arquivo menor primeiro para testar

## Logs e Debugging

Durante a importação, o sistema gera logs detalhados no console do servidor:

```
✅ Dia da rota lido da planilha: "QUARTA-FEIRA" → "quarta" para cliente SUPERMERCADO PINTA SILGO
⚠️ Dia da rota não encontrado na planilha, usando fallback: "segunda" para cliente MERCADINHO JAO
📅 Card criado para próximo quarta: 23/10/2025 para cliente SUPERMERCADO PINTA SILGO
```

Estes logs ajudam a identificar:
- Se a coluna ROTA foi lida corretamente
- Qual dia da semana foi atribuído a cada card
- Se algum fallback foi usado

## Histórico de Correções

### Outubro 2025 - Correção do Bug de Alocação
- **Problema**: Todos os cards eram alocados para segunda-feira independente do valor em ROTA
- **Causa**: O código procurava por "Dia da Rota" mas a planilha usava "ROTA"
- **Solução**: Adicionado "ROTA" como primeira opção de busca de coluna
- **Arquivo modificado**: `server/routes.ts` linha 1533

## Contato

Para dúvidas ou problemas, entre em contato com o suporte técnico ou consulte a documentação do Sistema Integra.
