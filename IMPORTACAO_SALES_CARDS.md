# Guia de Importação de Sales Cards via Planilha Excel

## Visão Geral

Este documento descreve o formato correto para importação em massa de Sales Cards (Cards de Venda) através de planilhas Excel ou CSV.

## Formato da Planilha

### Colunas Obrigatórias

A planilha deve conter as seguintes colunas (os nomes não são case-sensitive):

1. **CNPJ/CPF**
   - **Uso**: Chave de identificação do cliente
   - Identificação do cliente por documento
   - O sistema buscará o cliente pelo CNPJ/CPF cadastrado no sistema
   - **Obrigatório**

2. **Cliente (Nome Fantasia)**
   - **Uso**: Apenas para conferência visual na planilha
   - Nome fantasia do cliente
   - Não é usado para busca, apenas para referência do usuário
   - **Opcional**

3. **ROTA**
   - **Uso**: Define o dia da semana de visita do cliente
   - Dia da semana para a visita
   - Formatos aceitos (case-insensitive):
     - `SEGUNDA-FEIRA`, `segunda-feira`, `Segunda`, `SEG`
     - `TERÇA-FEIRA`, `TERCA-FEIRA`, `terça-feira`, `Terça`, `TER`
     - `QUARTA-FEIRA`, `quarta-feira`, `Quarta`, `QUA`
     - `QUINTA-FEIRA`, `quinta-feira`, `Quinta`, `QUI`
     - `SEXTA-FEIRA`, `sexta-feira`, `Sexta`, `SEX`
     - `SÁBADO`, `SABADO`, `sábado`, `Sábado`, `SAB`
     - `DOMINGO`, `domingo`, `Domingo`, `DOM`
   - **Obrigatório**

4. **FREQUENCIA**
   - **Uso**: Define a frequência de visitas do cliente
   - Periodicidade da visita (semanal, quinzenal, mensal ou bimestral)
   - Valores aceitos (case-insensitive):
     - `SEMANAL` ou `SEMANALMENTE`
     - `QUINZENAL` ou `QUINZENALMENTE`
     - `MENSAL` ou `MENSALMENTE`
     - `BIMESTRAL` ou `BIMESTRALMENTE`
   - **Obrigatório**

### Colunas Opcionais

5. **LATITUDE**
   - **Uso**: Atualiza a coordenada de latitude do cliente
   - Coordenada geográfica (latitude)
   - Aceita formato decimal (exemplo: -16.123456)
   - Aceita vírgula ou ponto como separador decimal
   - **Opcional**

6. **LONGITUDE**
   - **Uso**: Atualiza a coordenada de longitude do cliente
   - Coordenada geográfica (longitude)
   - Aceita formato decimal (exemplo: -48.987654)
   - Aceita vírgula ou ponto como separador decimal
   - **Opcional**

7. **DATA INICIO**
   - **Uso**: Define a data de início para criação de cards do cliente
   - O primeiro card de vendas será alocado para a próxima ocorrência da ROTA após esta data
   - Formatos aceitos:
     - `DD/MM/YYYY` (exemplo: 25/10/2025)
     - `DD/MM/YY` (exemplo: 25/10/25)
     - `YYYY-MM-DD` (exemplo: 2025-10-25)
     - Número serial do Excel (convertido automaticamente)
   - Se não fornecida, o card será criado para a próxima ocorrência da ROTA a partir de hoje
   - **Opcional**

8. **TIPO DE ATENDIMENTO**
   - **Uso**: Define se o atendimento ao cliente é presencial ou virtual
   - **Valores aceitos**:
     - `PRESENCIAL` → Atendimento presencial (vendedor visita o cliente)
     - `VIRTUAL` → Atendimento virtual (telefone, WhatsApp, remoto)
   - Atualiza o campo `virtualService` do cliente no sistema
   - **Opcional**

### Exemplo de Planilha

| CNPJ/CPF | Cliente (Nome Fantasia) | ROTA | FREQUENCIA | LATITUDE | LONGITUDE | DATA INICIO | TIPO DE ATENDIMENTO |
|----------|------------------------|------|------------|----------|-----------|-------------|---------------------|
| 00.058.238/0001-78 | SUPERMERCADO PINTA SILGO | QUARTA-FEIRA | SEMANAL | -16.6542229 | -49.2728202 | 25/10/2025 | PRESENCIAL |
| 00.065.979/0001-86 | MERCADINHO JAO | SEGUNDA-FEIRA | QUINZENAL | -16.234567 | -48.876543 | 28/10/2025 | VIRTUAL |
| 00.066.852/0001-81 | SUPERMERCADO RIO DAS PEDRAS | TERÇA-FEIRA | MENSAL | | | 01/11/2025 | PRESENCIAL |

## Como Importar

### Passo a Passo

1. Acesse o sistema e faça login
2. Na página inicial (Cards de Venda), clique no botão **"Importar Planilha"**
3. Selecione o arquivo Excel (.xlsx, .xls) ou CSV
4. Clique em **"Importar"**
5. Aguarde o processamento - o sistema mostrará o resultado da importação

### Regras de Importação

1. **Validação de Cliente**: O sistema procura o cliente por CNPJ/CPF. Se não encontrar, o card **não será criado**.

2. **Cards Existentes**: Se o cliente já tiver um card ativo (status `pending` ou `telemarketing`), um **novo card NÃO será criado** para evitar duplicatas.

3. **Data Agendada**: 
   - Se **DATA INICIO** for fornecida: O card será criado para a próxima ocorrência da ROTA após essa data
   - Se **DATA INICIO** não for fornecida: O card será criado para a próxima ocorrência da ROTA a partir de hoje
   - Exemplo: Se hoje é quinta (20/10) e a ROTA é "segunda", com DATA INICIO em 25/10, o card será criado para segunda 27/10

4. **Coordenadas Geográficas**:
   - Se LATITUDE e/ou LONGITUDE forem fornecidas, os dados do cliente serão atualizados
   - Coordenadas são essenciais para geração de rotas otimizadas
   - Aceita tanto vírgula quanto ponto como separador decimal

5. **Tipo de Atendimento**:
   - Define se o cliente será atendido presencialmente ou virtualmente
   - **PRESENCIAL**: vendedor visita fisicamente o cliente
   - **VIRTUAL**: atendimento remoto (telefone, WhatsApp, etc.)
   - Apenas dois tipos disponíveis: PRESENCIAL ou VIRTUAL
   - Esta informação é usada para planejamento de rotas e gestão de tempo

6. **Fallbacks**:
   - Se o valor da ROTA não for reconhecido → usa `segunda-feira` como padrão
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
| SEMANAL, SEMANALMENTE | `semanal` |
| QUINZENAL, QUINZENALMENTE | `quinzenal` |
| MENSAL, MENSALMENTE | `mensal` |
| BIMESTRAL, BIMESTRALMENTE | `bimestral` |

### Tipo de Atendimento
| Entrada na Planilha | Valor Interno | Descrição |
|---------------------|---------------|-----------|
| PRESENCIAL | `virtualService = false` | Vendedor visita o cliente |
| VIRTUAL | `virtualService = true` | Atendimento remoto |

## Resolução de Problemas

### Problema: Card não foi criado para um cliente

**Causas possíveis**:
1. Cliente não existe no sistema (CNPJ/CPF não encontrado)
2. Cliente já possui card ativo (pending ou telemarketing)
3. CNPJ/CPF está incorreto

**Solução**:
- Verifique se o cliente existe no cadastro
- Para CNPJ/CPF, não importa se tem pontos/traços - o sistema normaliza automaticamente
- Verifique se há cards pendentes para este cliente antes de importar

### Problema: Data do card está incorreta

**Causas possíveis**:
1. Campo DATA INICIO está em formato não reconhecido
2. Campo ROTA está incorreto

**Solução**:
- Use formato DD/MM/YYYY para DATA INICIO (exemplo: 25/10/2025)
- Verifique se o dia da semana em ROTA está correto
- O sistema sempre agenda para a próxima ocorrência do dia especificado

### Problema: Coordenadas não foram atualizadas

**Causas possíveis**:
1. Formato incorreto (usar ponto ou vírgula como decimal)
2. Valores vazios

**Solução**:
- Use formato decimal: -16.123456 ou -16,123456
- Verifique se os valores não estão como texto
- Ambos LATITUDE e LONGITUDE podem ser fornecidos separadamente

### Problema: Tipo de atendimento não foi atualizado

**Causas possíveis**:
1. Valor não reconhecido na coluna TIPO DE ATENDIMENTO
2. Campo em branco

**Solução**:
- Use exatamente: **PRESENCIAL** ou **VIRTUAL**
- Valores são case-insensitive (maiúsculas/minúsculas não importam)
- Apenas estes dois tipos são aceitos

## Logs e Debugging

Durante a importação, o sistema gera logs detalhados no console do servidor:

```
✅ Dia da rota lido da planilha: "QUARTA-FEIRA" → "quarta" para cliente SUPERMERCADO PINTA SILGO
✅ Periodicidade lida da planilha: "SEMANAL" → "semanal" para cliente SUPERMERCADO PINTA SILGO
📍 Coordenadas atualizadas para cliente SUPERMERCADO PINTA SILGO: Lat=-16.6542229, Lon=-49.2728202
🏪 Tipo de atendimento definido como PRESENCIAL para cliente SUPERMERCADO PINTA SILGO
📅 DATA INICIO fornecida (25/10/2025). Primeira visita agendada para próximo quarta: 29/10/2025 para cliente SUPERMERCADO PINTA SILGO
📱 Tipo de atendimento definido como VIRTUAL para cliente MERCADINHO JAO
```

Estes logs ajudam a identificar:
- Se a coluna ROTA foi lida corretamente
- Qual dia da semana foi atribuído a cada card
- Se coordenadas foram atualizadas
- Se DATA INICIO foi processada
- Se o tipo de atendimento foi definido

## Histórico de Atualizações

### Outubro 2025 - Novo Formato de Planilha
- **Adicionado**: Campo TIPO DE ATENDIMENTO (PRESENCIAL/VIRTUAL)
- **Removido**: Campo OBSERVAÇÕES/IMPEDIMENTO (não faz mais parte do modelo)
- **Mantido**: Suporte para LATITUDE, LONGITUDE, DATA INICIO
- **Modificado**: FREQUENCIA agora é lido prioritariamente (antes era Periodicidade)
- **Modificado**: Cliente (Nome Fantasia) agora é apenas para conferência visual

### Outubro 2025 - Novos Campos
- **Adicionado**: Suporte para LATITUDE e LONGITUDE
- **Adicionado**: Campo DATA INICIO para controle da primeira visita
- **Adicionado**: Campo OBSERVAÇÕES/IMPEDIMENTO para bloquear criação de cards
- **Modificado**: FREQUENCIA agora é lido prioritariamente (antes era Periodicidade)
- **Modificado**: Cliente (Nome Fantasia) agora é apenas para conferência

### Outubro 2025 - Correção do Bug de Alocação
- **Problema**: Todos os cards eram alocados para segunda-feira independente do valor em ROTA
- **Causa**: O código procurava por "Dia da Rota" mas a planilha usava "ROTA"
- **Solução**: Adicionado "ROTA" como primeira opção de busca de coluna

## Contato

Para dúvidas ou problemas, entre em contato com o suporte técnico ou consulte a documentação do Sistema Integra.
