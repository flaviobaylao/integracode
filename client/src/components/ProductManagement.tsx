import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw } from "lucide-react";
import type { Product } from "@shared/schema";

export default function ProductManagement() {
  const { data: products, isLoading } = useQuery<Product[]>({
    queryKey: ['/api/products'],
    retry: false,
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Mutation para sincronizar produtos do Omie
  const syncProductsMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/omie/sync-products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Erro ao sincronizar produtos');
      }
      
      return await response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      toast({
        title: "Sincronização concluída",
        description: `${data.imported} novos produtos, ${data.updated} atualizados${data.skipped ? `, ${data.skipped} inativos pulados` : ''}.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro na sincronização",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-800">Catálogo de Produtos</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {[...Array(8)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-48 bg-gray-200 rounded mb-4"></div>
                <div className="h-4 bg-gray-200 rounded mb-2"></div>
                <div className="h-4 bg-gray-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">Catálogo de Produtos</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              window.location.hash = '#omie-integration';
            }}
            data-testid="button-omie-integration"
          >
            <i className="fas fa-cog mr-2"></i>Configurações Omie
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={() => syncProductsMutation.mutate()}
            disabled={syncProductsMutation.isPending}
            data-testid="button-sync-products"
          >
            {syncProductsMutation.isPending ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Sincronizando...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Sincronizar Produtos
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Product Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {products && products.length > 0 ? (
          products.map((product: Product) => (
            <Card key={product.id} className="overflow-hidden">
              {/* Product Image */}
              <div className="h-48 bg-gradient-to-br from-honest-orange to-honest-blue flex items-center justify-center">
                {product.imageUrl ? (
                  <img
                    src={product.imageUrl}
                    alt={product.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-white text-center">
                    <i className="fas fa-glass-whiskey text-4xl mb-2"></i>
                    <p className="text-sm">Honest Sucos</p>
                  </div>
                )}
              </div>
              
              <CardContent className="p-6">
                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-gray-800">{product.name}</h3>
                    {product.description && (
                      <p className="text-sm text-gray-600">{product.description}</p>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-lg font-bold text-honest-orange">
                        {formatCurrency(parseFloat(product.price))}
                      </p>
                      <p className="text-sm text-gray-600">por unidade</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-600">Estoque</p>
                      <p className="text-sm font-medium text-gray-800">{product.stock} un</p>
                    </div>
                  </div>
                  
                  {(product.omieCodigoProduto || product.omieCodigo) && (
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-gray-500 flex items-center">
                        <i className="fas fa-check-circle text-green-500 mr-1"></i>
                        <span>
                          {product.omieCodigo && `Código: ${product.omieCodigo}`}
                          {product.omieCodigo && product.omieCodigoProduto && ' | '}
                          {product.omieCodigoProduto && `ID: ${product.omieCodigoProduto}`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="col-span-full text-center py-12">
            <p className="text-gray-500">Nenhum produto cadastrado</p>
          </div>
        )}
      </div>

      {/* Informações sobre importação */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-center">
          <i className="fas fa-info-circle text-blue-500 mr-2"></i>
          <p className="text-sm text-blue-700">
            <strong>Importante:</strong> Todos os produtos são importados automaticamente do Omie ERP. 
            Para adicionar novos produtos, cadastre-os primeiro no sistema Omie e depois use a função de importação.
          </p>
        </div>
      </div>
    </div>
  );
}
