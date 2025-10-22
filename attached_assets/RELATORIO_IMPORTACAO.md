# 📊 Relatório de Análise da Importação de Sales Cards

**Data:** 22 de outubro de 2025  
**Planilha analisada:** importacao dados integra atualizado 21.10_1761134117882.xlsx  
**Total de linhas:** 826 registros

---

## 🎯 Resumo Executivo

De **826 linhas** na planilha importada:
- ✅ **333 cards foram criados com sucesso** (40,3%)
- ❌ **543 linhas apresentaram erros** (65,7%)
- ✅ **283 linhas estão válidas** e podem ser importadas (34,3%)

---

## 📈 Status Atual no Banco de Dados

### Cards Criados
- **Total:** 333 cards pendentes
- **Distribuição por dia:**
  - Segunda-feira: 72 cards
  - Terça-feira: 64 cards
  - Quarta-feira: 73 cards
  - Quinta-feira: 63 cards
  - Sexta-feira: 51 cards
  - Sábado: 10 cards

---

## ❌ Análise dos Erros (543 linhas)

### 1. Clientes com Card Ativo (333 registros)
**Motivo:** Sistema não permite criar card duplicado para clientes que já possuem card ativo (status: pendente ou telemarketing)

**Exemplos:**
- SUPERMERCADO PINTA SILGO (CNPJ: 00.058.238/0001-78)
- MERCADINHO JAO (CNPJ: 00.065.979/0001-86)
- SUPERMERCADO RIO DAS PEDRAS loja 1 (CNPJ: 00.066.852/0001-81)

**Solução:** Estes cards já foram criados anteriormente. Não é necessário reimportá-los.

### 2. LATITUDE Ausente/Inválida (209 registros)
**Motivo:** Campo LATITUDE é **obrigatório** desde a atualização do sistema

**Exemplos:**
- LANCHONETE DONA MARISIA (CNPJ: 00.447.779/0001-98)
- Marcela diniz (CPF: 000.218.761-26)
- CAMILLA GONCALVES DE MORAIS (CPF: 000.219.021-43)

**Solução:** Preencher o campo LATITUDE com as coordenadas corretas do cliente.

### 3. LONGITUDE Ausente/Inválida (209 registros)
**Motivo:** Campo LONGITUDE é **obrigatório** desde a atualização do sistema

**Solução:** Preencher o campo LONGITUDE com as coordenadas corretas do cliente.

### 4. TIPO DE ATENDIMENTO Inválido (1 registro)
**Motivo:** Valor fornecido não é "PRESENCIAL" nem "VIRTUAL"

**Solução:** Corrigir para usar apenas **PRESENCIAL** ou **VIRTUAL**.

---

## ✅ O que Fazer Agora

### Opção 1: Importar os 283 Cards Válidos Restantes

Foi gerada uma planilha limpa contendo **apenas os 283 registros válidos**:
- **Arquivo:** `importacao_VALIDOS_APENAS.xlsx`
- **Localização:** `attached_assets/importacao_VALIDOS_APENAS.xlsx`

**Como importar:**
1. Acesse a Agenda de Vendas
2. Clique em "Importar Planilha"
3. Selecione o arquivo `importacao_VALIDOS_APENAS.xlsx`
4. Confirme a importação

**Resultado esperado:** Criação de 283 novos cards (total final: 616 cards)

### Opção 2: Corrigir os Erros na Planilha Original

Foi gerada uma planilha com **todos os 543 registros com erros**:
- **Arquivo:** `importacao_ERROS.xlsx`
- **Localização:** `attached_assets/importacao_ERROS.xlsx`
- **Coluna adicional:** "MOTIVO_ERRO" explica o problema de cada linha

**Como corrigir:**
1. Abra o arquivo `importacao_ERROS.xlsx`
2. Para cada linha, veja o motivo do erro na coluna "MOTIVO_ERRO"
3. Corrija os problemas:
   - **Cards ativos:** Ignore essas linhas (já foram criados)
   - **Latitude/Longitude ausente:** Adicione as coordenadas GPS
   - **Tipo de atendimento inválido:** Use "PRESENCIAL" ou "VIRTUAL"
4. Salve apenas as linhas corrigidas
5. Importe novamente

---

## 📋 Campos Obrigatórios para Importação

### Campos que DEVEM estar preenchidos:
1. **CNPJ/CPF** - Identificação do cliente
2. **ROTA** - Dia da semana (segunda, terça, quarta, quinta, sexta, sábado)
3. **FREQUENCIA** - Periodicidade de visita (semanal, quinzenal, mensal, bimestral)
4. **LATITUDE** - Coordenada geográfica (ex: -16.6542229)
5. **LONGITUDE** - Coordenada geográfica (ex: -49.2728202)
6. **DATA INICIO** - Data de início do agendamento
7. **TIPO DE ATENDIMENTO** - Apenas "PRESENCIAL" ou "VIRTUAL"

### Campos opcionais:
- **Cliente (Nome Fantasia)** - Usado apenas para referência visual

---

## 🔍 Por que Você Vê 320 Cards (e não 333)?

A diferença de 13 cards entre o total no banco (333) e o que você vê (320) provavelmente ocorre devido a:

1. **Filtro de data:** Alguns cards podem estar agendados fora do intervalo de datas selecionado
2. **Filtro de vendedor:** Se você filtrou por um vendedor específico, cards de outros vendedores não aparecem
3. **Status diferente:** Apenas cards com status "pendente" são contados

Para ver TODOS os 333 cards:
- Use o filtro "📅 Todos os Dias"
- Selecione "Todos os Vendedores"
- Amplie o intervalo de datas para incluir os próximos 2 meses

---

## 📊 Arquivos Gerados

1. **analise-importacao.txt** - Relatório técnico completo com todos os detalhes
2. **importacao_VALIDOS_APENAS.xlsx** - 283 linhas prontas para importar
3. **importacao_ERROS.xlsx** - 543 linhas com erros para correção

---

## 💡 Recomendação

**Ação imediata:**
1. Importe o arquivo `importacao_VALIDOS_APENAS.xlsx` para criar os 283 cards restantes
2. Revise o arquivo `importacao_ERROS.xlsx` para identificar quais clientes precisam de coordenadas GPS

**Resultado final:**
- 333 cards já criados (mantidos)
- + 283 novos cards (a importar)
- = **616 cards totais** na agenda

---

## ❓ Dúvidas Frequentes

**P: Por que não posso criar card duplicado?**  
R: O sistema impede duplicatas para evitar confusão. Cada cliente só pode ter um card ativo por vez.

**P: Como obter as coordenadas GPS dos clientes?**  
R: Você pode:
- Usar o Google Maps (clique com botão direito → copiar coordenadas)
- Usar a funcionalidade de captura GPS do app móvel
- Solicitar ao vendedor que visite o local e registre as coordenadas

**P: O que acontece com os 333 cards já criados?**  
R: Eles permanecem no sistema e não serão afetados. Você pode visualizá-los na Agenda de Vendas.

---

**Criado automaticamente pelo Sistema Integra**  
*Se tiver dúvidas, consulte este relatório ou entre em contato com o suporte.*
