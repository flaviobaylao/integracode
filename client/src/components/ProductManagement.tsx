import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import ProductModal from "./ProductModal";
import type { Product } from "@shared/schema";

export default function ProductManagement() {
  const [showModal, setShowModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: products, isLoading } = useQuery({
    queryKey: ['/api/products'],
    retry: false,
  });

  const deleteProductMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/products/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      toast({
        title: "Sucesso",
        description: "Produto excluído com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
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
        <Button
          className="bg-honest-blue hover:bg-blue-700"
          onClick={() => setShowModal(true)}
        >
          <i className="fas fa-plus mr-2"></i>Novo Produto
        </Button>
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
                  
                  <div className="flex items-center space-x-2">
                    <Button
                      className="flex-1 bg-honest-blue hover:bg-blue-700 text-white text-sm"
                      onClick={() => {
                        setEditingProduct(product);
                        setShowModal(true);
                      }}
                    >
                      <i className="fas fa-edit mr-1"></i>Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteProductMutation.mutate(product.id)}
                    >
                      <i className="fas fa-trash text-red-600"></i>
                    </Button>
                  </div>
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

      {/* Product Modal */}
      {showModal && (
        <ProductModal
          isOpen={showModal}
          onClose={() => {
            setShowModal(false);
            setEditingProduct(null);
          }}
          editingProduct={editingProduct}
        />
      )}
    </div>
  );
}
