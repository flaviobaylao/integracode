# 🔍 Guia de Diagnóstico - Importação de Sales Cards

## Problema Relatado
Coordenadas GPS (latitude e longitude) não estão sendo importadas corretamente em alguns cards, mesmo quando presentes na planilha de importação.

## Nova Funcionalidade de Debug

Foi adicionado um sistema de diagnóstico automático que mostra exatamente o que está acontecendo durante a importação.

### Como Usar

1. **Acesse a página de importação:**
   - Dashboard → Cards de Venda → Importar Planilha (botão no canto superior)
   - OU use o botão "Importar Planilha" na página inicial

2. **Selecione sua planilha** que contém as colunas:
   - CNPJ/CPF
   - ROTA
   - FREQUENCIA
   - DATA INICIO
   - **LATITUDE** (coluna que deve conter coordenadas)
   - **LONGITUDE** (coluna que deve conter coordenadas)

3. **Execute a importação** clicando em "Importar"

4. **Verifique as Informações de Debug:**
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

## Formato Esperado da Planilha

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

## Logs no Servidor

Para desenvolvedores/técnicos: Os logs do servidor também mostram informações detalhadas:
```
🔍 [IMPORT-DEBUG] Cliente NOME DO CLIENTE - Colunas disponíveis: [...]
🔍 [IMPORT-DEBUG] Cliente NOME DO CLIENTE - Valores brutos: {...}
📍 Coordenadas atualizadas para cliente NOME DO CLIENTE: Lat=..., Lon=...
```

---

📝 **Última atualização:** 24/10/2025  
🔗 **Versão do sistema:** 2.0 com Debug de Importação
