# Controle de Acesso por Email para Vendedores

## Visão Geral
O sistema CRM da Honest Sucos implementa controle de acesso baseado no email do vendedor, onde cada vendedor cadastrado no Omie ERP só consegue visualizar e gerenciar os dados da sua própria carteira de clientes.

## Como Funciona

### 1. Autenticação por Email
- O vendedor faz login no sistema usando o mesmo email cadastrado no Omie ERP
- O sistema verifica se existe um usuário com role "vendedor" e esse email específico
- Caso encontrado, o acesso é liberado apenas para os dados associados a esse vendedor

### 2. Filtros Automáticos
Quando um vendedor acessa o sistema, os seguintes filtros são aplicados automaticamente:

- **Clientes**: Apenas clientes onde `sellerId` corresponde ao ID do vendedor logado
- **Cards de Venda**: Apenas cards onde `sellerId` corresponde ao vendedor logado
- **Dashboard**: Estatísticas filtradas pela carteira do vendedor
- **Relatórios**: Dados limitados ao desempenho individual do vendedor

### 3. Interface Personalizada
- Menu adaptado: "Minha Carteira" ao invés de "Clientes"
- Menu adaptado: "Meus Cards de Venda" ao invés de "Cards de Venda"
- Funcionalidades administrativas ocultas (usuários, relatórios gerais, etc.)

### 4. Implementação Técnica

#### Middleware de Controle
```typescript
export const checkSellerAccess = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).currentUser;
  
  if (user.role === 'vendedor') {
    // Adicionar filtro de vendedor às queries
    (req as any).sellerId = user.id;
  }
  
  next();
};
```

#### Busca por Email
```typescript
async getUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user;
}
```

### 5. Segurança
- Vendedores não podem reatribuir clientes para outros vendedores
- Vendedores não podem ver dados de outros vendedores
- Vendedores não têm acesso a funcionalidades administrativas
- Todas as consultas são filtradas automaticamente no backend

## Configuração do Vendedor

### Pré-requisitos
1. Vendedor deve estar cadastrado no Omie ERP com email válido
2. Usuário deve ser criado no CRM com:
   - `role: 'vendedor'`
   - `email: 'mesmo_email_do_omie@empresa.com'`
   - `isActive: true`

### Processo de Login
1. Vendedor acessa o sistema via autenticação Replit
2. Sistema verifica email no banco de dados
3. Se encontrado e role = 'vendedor', acesso liberado com filtros
4. Interface personalizada é carregada

## Logs de Depuração
O sistema gera logs para acompanhar o acesso:

```
Fetching customers for user vendedor@honestsucos.com (role: vendedor, sellerId: vendedor-001)
Fetching sales cards for user vendedor@honestsucos.com (role: vendedor, sellerId: vendedor-001)
```

## Integração com Omie
- Sincronização de vendedores via API do Omie
- Email como campo chave para associação
- Atualização automática de dados do vendedor
- Sincronização de clientes e carteira