import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, ShoppingBag, DollarSign, Package, MapPin } from "lucide-react";
import type { Product } from "@shared/schema";

export default function HotsitePricing() {
  const { toast } = useToast();
  const [editedProducts, setEditedProducts] = useState<Record<string, Partial<Product>>>({});

  const { data: products, isLoading } = useQuery<Product[]>({
    queryKey: ['/api/products'],
  });

  const updateProductMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Product> }) => {
      return apiRequest(`/api/products/${id}`, 'PUT', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      toast({
        title: "Sucesso!",
        description: "Preços atualizados com sucesso.",
      });
      setEditedProducts({});
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao atualizar",
        description: error.message || "Ocorreu um erro ao salvar os preços.",
        variant: "destructive",
      });
    },
  });

  const handlePriceChange = (productId: string, field: keyof Product, value: string) => {
    const numValue = value === '' ? null : parseFloat(value);
    setEditedProducts(prev => ({
      ...prev,
      [productId]: {
        ...(prev[productId] || {}),
        [field]: numValue,
      },
    }));
  };

  const handleSave = (productId: string) => {
    const edits = editedProducts[productId];
    if (!edits) return;

    updateProductMutation.mutate({
      id: productId,
      data: edits,
    });
  };

  const formatPrice = (value: number | null | undefined): string => {
    if (value === null || value === undefined) return '';
    return value.toString();
  };

  const hasEdits = (productId: string) => {
    return editedProducts[productId] && Object.keys(editedProducts[productId]).length > 0;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-honest-blue" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
          <ShoppingBag className="h-8 w-8 text-honest-orange" />
          Tabela de Preços do Hotsite
        </h1>
        <p className="text-gray-600 mt-2">
          Gerencie os 5 tipos de preço para cada produto do hotsite Instagram
        </p>
      </div>

      <div className="grid gap-4 mb-6">
        <Card className="bg-blue-50 border-blue-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-blue-600" />
              Tipos de Preço
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="font-semibold text-blue-900 mb-1">👤 Para Consumidores:</p>
                <ul className="ml-4 space-y-1 text-blue-800">
                  <li>• <strong>Varejo</strong> - Compras até R$ 200</li>
                  <li>• <strong>Atacado</strong> - Compras acima de R$ 200 (10% desconto)</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-blue-900 mb-1">🏪 Para Revendedores:</p>
                <ul className="ml-4 space-y-1 text-blue-800">
                  <li>• <strong>Goiânia</strong> - Revenda na capital</li>
                  <li>• <strong>Interior GO</strong> - Revenda no interior de Goiás</li>
                  <li>• <strong>Brasília/Entorno</strong> - Revenda no DF e entorno</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        {products?.map((product) => {
          const currentEdits = editedProducts[product.id] || {};
          const displayRetail = currentEdits.retailPrice !== undefined ? (currentEdits.retailPrice as number | null) : product.retailPrice;
          const displayWholesale = currentEdits.wholesalePrice !== undefined ? (currentEdits.wholesalePrice as number | null) : product.wholesalePrice;
          const displayGoiania = currentEdits.resaleGoianiaPrice !== undefined ? (currentEdits.resaleGoianiaPrice as number | null) : product.resaleGoianiaPrice;
          const displayInterior = currentEdits.resaleInteriorPrice !== undefined ? (currentEdits.resaleInteriorPrice as number | null) : product.resaleInteriorPrice;
          const displayBrasilia = currentEdits.resaleBrasiliaPrice !== undefined ? (currentEdits.resaleBrasiliaPrice as number | null) : product.resaleBrasiliaPrice;

          return (
            <Card key={product.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="bg-honest-orange/10 p-3 rounded-lg">
                      <Package className="h-6 w-6 text-honest-orange" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{product.name}</CardTitle>
                      <CardDescription>{product.description || 'Sem descrição'}</CardDescription>
                    </div>
                  </div>
                  {hasEdits(product.id) && (
                    <Button
                      onClick={() => handleSave(product.id)}
                      disabled={updateProductMutation.isPending}
                      size="sm"
                      data-testid={`button-save-${product.id}`}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      {updateProductMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Salvar
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-5 gap-4">
                  {/* Preço Varejo */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
                      <DollarSign className="h-4 w-4 text-green-600" />
                      Varejo
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={formatPrice(displayRetail)}
                      onChange={(e) => handlePriceChange(product.id, 'retailPrice', e.target.value)}
                      data-testid={`input-retail-${product.id}`}
                      className="text-right"
                    />
                    <p className="text-xs text-gray-500">{'< R$ 200'}</p>
                  </div>

                  {/* Preço Atacado */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
                      <Package className="h-4 w-4 text-blue-600" />
                      Atacado
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={formatPrice(displayWholesale)}
                      onChange={(e) => handlePriceChange(product.id, 'wholesalePrice', e.target.value)}
                      data-testid={`input-wholesale-${product.id}`}
                      className="text-right"
                    />
                    <p className="text-xs text-gray-500">{'>= R$ 200'}</p>
                  </div>

                  {/* Preço Goiânia */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
                      <MapPin className="h-4 w-4 text-purple-600" />
                      Goiânia
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={formatPrice(displayGoiania)}
                      onChange={(e) => handlePriceChange(product.id, 'resaleGoianiaPrice', e.target.value)}
                      data-testid={`input-goiania-${product.id}`}
                      className="text-right"
                    />
                    <p className="text-xs text-gray-500">Revenda</p>
                  </div>

                  {/* Preço Interior */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
                      <MapPin className="h-4 w-4 text-orange-600" />
                      Interior GO
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={formatPrice(displayInterior)}
                      onChange={(e) => handlePriceChange(product.id, 'resaleInteriorPrice', e.target.value)}
                      data-testid={`input-interior-${product.id}`}
                      className="text-right"
                    />
                    <p className="text-xs text-gray-500">Revenda</p>
                  </div>

                  {/* Preço Brasília */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
                      <MapPin className="h-4 w-4 text-yellow-600" />
                      Brasília/DF
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={formatPrice(displayBrasilia)}
                      onChange={(e) => handlePriceChange(product.id, 'resaleBrasiliaPrice', e.target.value)}
                      data-testid={`input-brasilia-${product.id}`}
                      className="text-right"
                    />
                    <p className="text-xs text-gray-500">Revenda</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {products && products.length === 0 && (
        <Card className="text-center py-12">
          <CardContent>
            <Package className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600 text-lg">Nenhum produto cadastrado</p>
            <p className="text-gray-500 text-sm mt-2">
              Cadastre produtos primeiro para configurar os preços do hotsite
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
