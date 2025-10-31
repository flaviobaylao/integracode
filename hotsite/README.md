# 🍊 Hotsite Honest Sucos Naturais

Hotsite mobile-first para vendas online integrado ao Sistema Integra.

## 📋 Características

- ✅ Interface mobile-first otimizada para Instagram
- ✅ Catálogo de produtos dinâmico
- ✅ Carrinho de compras com localStorage
- ✅ Cálculo automático de desconto (10% para compras > R$ 200)
- ✅ Formulário de checkout simplificado
- ✅ Integração completa com Sistema Integra via API
- ✅ Suporte para Pix, Cartão e Boleto

## 🚀 Instalação

```bash
cd hotsite
npm install
```

## 💻 Desenvolvimento

Para rodar o hotsite em modo desenvolvimento:

```bash
npm run dev
```

O hotsite será aberto em `http://localhost:5001` e se conectará automaticamente à API do Sistema Integra rodando em `http://localhost:5000`.

## 🏗️ Build para Produção

```bash
npm run build
```

Os arquivos otimizados serão gerados na pasta `dist/`.

## 📦 Deploy no Replit

### Opção 1: Static Deployment (Recomendado)

1. No Replit, vá em **Deploy** > **Static Site**
2. Configure:
   - **Build Command**: `cd hotsite && npm install && npm run build`
   - **Publish Directory**: `hotsite/dist`
   - **Output Directory**: `dist`
3. Clique em **Deploy**

### Opção 2: Servir via Express

Adicione ao `server/index.ts` do Sistema Integra:

```typescript
import express from 'express';
import path from 'path';

app.use('/hotsite', express.static(path.join(__dirname, '../hotsite/dist')));
```

Depois, acesse via: `https://seu-projeto.replit.app/hotsite`

## 🔧 Configuração

### Variáveis de Ambiente

Não são necessárias! O hotsite usa proxy configurado no `vite.config.ts` para se conectar ao Sistema Integra.

### Personalização

- **Cores**: Edite `tailwind.config.js`
- **Telefone WhatsApp**: Edite `src/App.tsx` (procure por `5562999999999`)
- **Meta tags SEO**: Edite `index.html`

## 📱 Funcionalidades

### 1. Catálogo de Produtos
- Lista todos os produtos ativos do Sistema Integra
- Exibe nome, descrição, preço e estoque
- Permite adicionar produtos ao carrinho

### 2. Carrinho de Compras
- Persiste no localStorage
- Atualiza quantidade de produtos
- Remove itens
- Calcula automaticamente desconto de 10% para compras > R$ 200

### 3. Checkout
- Formulário de dados do cliente
- Validação de campos
- Seleção de método de pagamento (Pix, Cartão, Boleto)
- Integração com API do Sistema Integra

### 4. Confirmação
- Exibe número do pedido
- Link direto para WhatsApp
- Opção de fazer novo pedido

## 🔌 Integração com Sistema Integra

O hotsite consome as seguintes APIs públicas:

- `GET /api/public/products` - Lista produtos
- `GET /api/public/products/:id` - Detalhes de produto
- `POST /api/public/customers/check` - Verifica cliente existente
- `POST /api/public/orders` - Cria pedido

Todos os pedidos são registrados automaticamente no Sistema Integra como sales_cards.

## 🧪 Testando

1. Certifique-se que o Sistema Integra está rodando (`npm run dev` na raiz)
2. Execute o hotsite (`npm run dev` na pasta hotsite)
3. Acesse `http://localhost:5001`
4. Teste o fluxo:
   - Adicione produtos ao carrinho
   - Finalize o pedido
   - Verifique no Sistema Integra se o pedido foi criado

## 📊 Monitoramento

Os pedidos criados pelo hotsite:
- São marcados com `source: 'hotsite'` nas observações
- Aparecem no Sistema Integra como sales_cards com `status: 'pendente'`
- Podem ser gerenciados pelos administradores do Sistema Integra

## 🎨 Design

- Framework CSS: Tailwind CSS
- Cores principais:
  - Verde Honest: `#4CAF50`
  - Laranja: `#FF9800`
  - Fundo claro: `#E8F5E9`
- Tipografia: Inter (Google Fonts)

## 📞 Suporte

Para dúvidas sobre o hotsite, consulte a documentação do Sistema Integra ou entre em contato com a equipe de desenvolvimento.
