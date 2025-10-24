# 🔍 Guia de Diagnóstico - Importação com Debug

## Problema Relatado
Coordenadas GPS (latitude e longitude) não estão sendo importadas corretamente em alguns registros, mesmo quando presentes na planilha de importação.

## Nova Funcionalidade de Debug

Foi adicionado um sistema de diagnóstico automático que mostra exatamente o que está acontecendo durante a importação, disponível tanto para **Clientes** quanto para **Sales Cards**.

---

## 📋 Importação de CLIENTES

### Como Usar

1. **Acesse a página de importação:**
   - Dashboard → Clientes → Importar Dados (botão no canto superior)

2. **Selecione sua planilha** que contém as colunas:
   - CPF OU CNPJ (obrigatório)
   - **LATITUDE** (opcional)
   - **LONGITUDE** (opcional)
   - ROTA (opcional)
   - PERIODICIDADE (opcional)

3. **Execute a importação** clicando em "Importar"

4. **Verifique as Informações de Debug (Interface Visual):**
   - Após a importação, uma nova seção aparecerá: **"🔍 Informações de Debug"**
   - Esta seção mostra para as primeiras 5 linhas importadas:
     - ✅ **Colunas disponíveis**: Lista TODAS as colunas encontradas na planilha
     - ✅ **LATITUDE lida**: Mostra o valor exato que foi lido (ou "NÃO ENCONTRADA")
     - ✅ **LONGITUDE lida**: Mostra o valor exato que foi lido (ou "NÃO ENCONTRADA")
     - ✅ **Dados para atualizar**: Mostra exatamente quais dados foram preparados para salvar
     - ✅ **Status da atualização**: Informa se a atualização foi bem-sucedida ou não

## O Que Procurar no Debug

### ✅ Importação Bem-Sucedida
Se você vir algo assim:
```
Colunas disponíveis: CNPJ/CPF, ROTA, FREQUENCIA, DATA INICIO, LATITUDE, LONGITUDE
LATITUDE lida: "-16.6956423" (string)
LONGITUDE lida: "-49.2827381" (string)
Dados para atualizar: {"latitude":"-16.6956423","longitude":"-49.2827381","virtualService":false}
Atualização: ✅ Sucesso
```
**Isso significa:** As coordenadas foram lidas E salvas corretamente! ✅

### ⚠️ Colunas Não Encontradas
Se você vir:
```
Colunas disponíveis: CNPJ, ROTA, FREQUENCIA, DATA INICIO, LAT, LONG
LATITUDE lida: NÃO ENCONTRADA
LONGITUDE lida: NÃO ENCONTRADA
```
**Problema:** As colunas na planilha têm NOMES DIFERENTES!  
**Solução:** Renomeie as colunas para:
- `LATITUDE` (ou `Latitude` ou `latitude`)
- `LONGITUDE` (ou `Longitude` ou `longitude`)

### ⚠️ Valores Inválidos
Se você vir:
```
LATITUDE lida: "abc" (string)
LONGITUDE lida: "xyz" (string)
Dados para atualizar: {"virtualService":false}
```
**Problema:** Os valores não são números válidos  
**Solução:** Verifique se as coordenadas estão no formato correto:
- Latitude: `-16.6956423` ou `-16,6956423`
- Longitude: `-49.2827381` ou `-49,2827381`

### ⚠️ Células Vazias
Se você vir:
```
LATITUDE lida: "" (string)
LONGITUDE lida: "" (string)
Dados para atualizar: {"virtualService":false}
```
**Problema:** As células estão vazias na planilha  
**Solução:** Preencha as coordenadas ou obtenha-as via GPS

## Compartilhando Informações para Suporte

Se o problema persistir, compartilhe:

1. **Screenshot da seção "Informações de Debug"** após a importação
2. **Exemplo de 2-3 linhas** da sua planilha (pode ocultar dados sensíveis, mas mantenha os cabeçalhos e estrutura)
3. **Descrição do problema**: "X cards foram importados mas Y cards estão sem coordenadas"

---

## 📋 Importação de SALES CARDS

### Como Usar

1. **Acesse a página de importação:**
   - Dashboard → Cards de Venda → Importar Planilha (botão no canto superior)

2. **Selecione sua planilha** que contém as colunas:
   - CNPJ/CPF (obrigatório)
   - ROTA (obrigatório)
   - FREQUENCIA (obrigatório)
   - DATA INICIO (obrigatório)
   - **LATITUDE** (opcional)
   - **LONGITUDE** (opcional)
   - TIPO DE ATENDIMENTO (opcional)

3. **Execute a importação** clicando em "Importar"

4. **Verifique as Informações de Debug (Console do Navegador):**
   - Pressione **F12** para abrir o Console do Desenvolvedor
   - Procure por: `🔍 [DEBUG] Informações de importação de Sales Cards:`
   - Expanda o objeto para ver as mesmas informações de debug:
     - Colunas disponíveis na planilha
     - Valores lidos de LATITUDE e LONGITUDE
     - Dados que foram preparados para atualização
     - Status de sucesso/falha da atualização

---

## Formato Esperado das Planilhas

### Para CLIENTES:
```
| CPF OU CNPJ       | LATITUDE     | LONGITUDE    | ROTA         | PERIODICIDADE |
|-------------------|--------------|--------------|--------------|---------------|
| 12.345.678/0001-90| -16.6956423  | -49.2827381  | Segunda-feira| Semanal       |
| 98.765.432/0001-10| -16.7234567  | -49.3012345  | Terça-feira  | Quinzenal     |
```

### Para SALES CARDS:
```
| CNPJ/CPF          | LATITUDE     | LONGITUDE    | ROTA         | FREQUENCIA | DATA INICIO |
|-------------------|--------------|--------------|--------------|------------|-------------|
| 12.345.678/0001-90| -16.6956423  | -49.2827381  | Segunda-feira| Semanal    | 01/11/2025  |
| 98.765.432/0001-10| -16.7234567  | -49.3012345  | Terça-feira  | Quinzenal  | 01/11/2025  |
```

**Observações importantes:**
- ✅ Aceita vírgula ou ponto como separador decimal
- ✅ Latitude e Longitude são OPCIONAIS (se não fornecidas, card mostra "SEM COORDENADAS")
- ✅ Valores podem estar em formato texto ou número no Excel
- ✅ **CORREÇÃO APLICADA:** Sistema agora aceita colunas com espaços extras (ex: " LATITUDE ", " LONGITUDE ")

## Logs no Servidor

Para desenvolvedores/técnicos: Os logs do servidor também mostram informações detalhadas:
```
🔍 [IMPORT-DEBUG] Cliente NOME DO CLIENTE - Colunas disponíveis: [...]
🔍 [IMPORT-DEBUG] Cliente NOME DO CLIENTE - Valores brutos: {...}
📍 Coordenadas atualizadas para cliente NOME DO CLIENTE: Lat=..., Lon=...
```

---

## 🔧 Histórico de Correções

### 24/10/2025 - 15:20
**Problema:** Colunas com espaços extras (ex: " LATITUDE ") não eram reconhecidas  
**Solução:** Sistema atualizado para aceitar todas as variações de espaços  
**Impacto:** Importação passou de 0% para 100% de sucesso na planilha de teste  

---

📝 **Última atualização:** 24/10/2025 15:20  
🔗 **Versão do sistema:** 2.1 com Correção de Espaços em Colunas
