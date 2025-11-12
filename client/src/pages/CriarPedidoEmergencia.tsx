import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

export default function CriarPedidoEmergencia() {
  const [customers, setCustomers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [selectedProducts, setSelectedProducts] = useState<{[key: string]: number}>({});
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<any>(null);
  const { toast } = useToast();

  // Carregar usuário logado
  useEffect(() => {
    fetch('/api/user', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setUser(data))
      .catch(() => {
        toast({ title: "Erro", description: "Não foi possível carregar usuário", variant: "destructive" });
      });
  }, []);

  // Carregar clientes e produtos
  useEffect(() => {
    Promise.all([
      fetch('/api/customers', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/products', { credentials: 'include' }).then(r => r.json())
    ])
      .then(([customersData, productsData]) => {
        setCustomers(customersData);
        setProducts(productsData);
      })
      .catch(() => {
        toast({ title: "Erro", description: "Não foi possível carregar dados", variant: "destructive" });
      });
  }, []);

  const handleCreateOrder = async () => {
    if (!selectedCustomer) {
      toast({ title: "Erro", description: "Selecione um cliente", variant: "destructive" });
      return;
    }

    const productsArray = Object.entries(selectedProducts)
      .filter(([_, qty]) => qty > 0)
      .map(([productId, quantity]) => ({
        productId: parseInt(productId),
        quantity
      }));

    if (productsArray.length === 0) {
      toast({ title: "Erro", description: "Adicione pelo menos um produto", variant: "destructive" });
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/sales-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          customerId: parseInt(selectedCustomer),
          status: 'completed',
          products: productsArray,
          scheduledDate: new Date().toISOString().split('T')[0]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Erro ao criar pedido');
      }

      toast({ title: "Sucesso!", description: "Pedido criado com sucesso!" });
      
      // Limpar formulário
      setSelectedCustomer('');
      setSelectedProducts({});
    } catch (error: any) {
      toast({ 
        title: "Erro ao criar pedido", 
        description: error.message, 
        variant: "destructive" 
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-4">
      <div className="max-w-4xl mx-auto">
        <Card className="mb-6 border-orange-200 bg-orange-50">
          <CardHeader>
            <CardTitle className="text-orange-900">🚨 Página de Emergência - Criar Pedido</CardTitle>
            <CardDescription className="text-orange-700">
              Esta página permite criar pedidos sem depender de cache do navegador
            </CardDescription>
          </CardHeader>
        </Card>

        {user && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Bem-vindo, {user.name || user.email}</CardTitle>
              <CardDescription>Vendedor: {user.role}</CardDescription>
            </CardHeader>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Novo Pedido</CardTitle>
            <CardDescription>Selecione cliente e produtos</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Seleção de Cliente */}
            <div>
              <Label htmlFor="customer">Cliente *</Label>
              <select
                id="customer"
                className="w-full mt-2 p-2 border rounded-md"
                value={selectedCustomer}
                onChange={(e) => setSelectedCustomer(e.target.value)}
                data-testid="select-customer"
              >
                <option value="">Selecione um cliente...</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name} - {customer.city || 'Sem cidade'}
                  </option>
                ))}
              </select>
            </div>

            {/* Produtos */}
            <div>
              <Label>Produtos *</Label>
              <div className="mt-2 space-y-3 max-h-96 overflow-y-auto border rounded-md p-4">
                {products.map((product) => (
                  <div key={product.id} className="flex items-center gap-4 p-3 bg-gray-50 rounded">
                    <div className="flex-1">
                      <p className="font-medium">{product.name}</p>
                      <p className="text-sm text-gray-600">
                        Preço: R$ {product.price?.toFixed(2) || '0.00'}
                      </p>
                    </div>
                    <Input
                      type="number"
                      min="0"
                      placeholder="Qtd"
                      className="w-24"
                      value={selectedProducts[product.id] || ''}
                      onChange={(e) => {
                        const qty = parseInt(e.target.value) || 0;
                        setSelectedProducts(prev => ({
                          ...prev,
                          [product.id]: qty
                        }));
                      }}
                      data-testid={`input-qty-${product.id}`}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Resumo */}
            <div className="bg-blue-50 p-4 rounded-md">
              <h3 className="font-semibold mb-2">Resumo do Pedido</h3>
              <p>Cliente: {customers.find(c => c.id === parseInt(selectedCustomer))?.name || 'Não selecionado'}</p>
              <p>Produtos selecionados: {Object.values(selectedProducts).filter(q => q > 0).length}</p>
              <p className="font-bold mt-2">
                Total: R$ {
                  Object.entries(selectedProducts)
                    .reduce((total, [productId, qty]) => {
                      const product = products.find(p => p.id === parseInt(productId));
                      return total + (product?.price || 0) * qty;
                    }, 0)
                    .toFixed(2)
                }
              </p>
            </div>

            {/* Botão de Criar */}
            <Button
              onClick={handleCreateOrder}
              disabled={loading}
              className="w-full bg-green-600 hover:bg-green-700"
              data-testid="button-create-order"
            >
              {loading ? 'Criando...' : 'Criar Pedido'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
