import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RefreshCw, Images, X, Upload } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Product } from "@shared/schema";

export default function ProductManagement() {
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [uploadingImages, setUploadingImages] = useState(false);
  
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

  // Mutation para deletar imagem
  const deleteImageMutation = useMutation({
    mutationFn: async ({ productId, imageIndex }: { productId: string; imageIndex: number }) => {
      const response = await fetch(`/api/products/${productId}/images/${imageIndex}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Erro ao remover imagem');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      toast({
        title: "Sucesso!",
        description: "Imagem removida com sucesso.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao remover",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleImageUpload = async (productId: string, files: FileList) => {
    if (files.length === 0) return;

    setUploadingImages(true);
    const formData = new FormData();
    Array.from(files).forEach(file => {
      formData.append('images', file);
    });

    try {
      const response = await fetch(`/api/products/${productId}/upload-images`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Erro ao fazer upload das imagens');
      }

      await response.json();
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      toast({
        title: "Sucesso!",
        description: "Imagens enviadas com sucesso.",
      });
    } catch (error: any) {
      toast({
        title: "Erro no upload",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setUploadingImages(false);
    }
  };

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
              <div className="h-48 bg-gradient-to-br from-honest-orange to-honest-blue flex items-center justify-center relative">
                {product.imageUrl || (product.images && product.images.length > 0) ? (
                  <img
                    src={product.imageUrl || product.images?.[0]}
                    alt={product.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-white text-center">
                    <i className="fas fa-glass-whiskey text-4xl mb-2"></i>
                    <p className="text-sm">Honest Sucos</p>
                  </div>
                )}
                {product.images && product.images.length > 1 && (
                  <div className="absolute top-2 right-2 bg-black/70 text-white px-2 py-1 rounded-full text-xs">
                    {product.images.length} fotos
                  </div>
                )}
              </div>
              
              <CardContent className="p-6">
                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-gray-800">{product.name}</h3>
                    {product.description && (
                      <p className="text-sm text-gray-600 line-clamp-2">{product.description}</p>
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
                        <span className="truncate">
                          {product.omieCodigo && `Código: ${product.omieCodigo}`}
                          {product.omieCodigo && product.omieCodigoProduto && ' | '}
                          {product.omieCodigoProduto && `ID: ${product.omieCodigoProduto}`}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Botão de gerenciar imagens */}
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button 
                        variant="outline" 
                        className="w-full"
                        onClick={() => setSelectedProduct(product)}
                        data-testid={`button-manage-images-${product.id}`}
                      >
                        <Images className="mr-2 h-4 w-4" />
                        Gerenciar Imagens
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-3xl">
                      <DialogHeader>
                        <DialogTitle>Gerenciar Imagens - {product.name}</DialogTitle>
                      </DialogHeader>
                      
                      <div className="space-y-4">
                        {/* Upload Area */}
                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            onChange={(e) => {
                              if (e.target.files) {
                                handleImageUpload(product.id, e.target.files);
                              }
                            }}
                            className="hidden"
                            id={`image-upload-${product.id}`}
                            disabled={uploadingImages}
                          />
                          <label
                            htmlFor={`image-upload-${product.id}`}
                            className="cursor-pointer"
                          >
                            {uploadingImages ? (
                              <div className="flex flex-col items-center">
                                <RefreshCw className="h-12 w-12 text-gray-400 animate-spin mb-2" />
                                <p className="text-sm text-gray-600">Enviando imagens...</p>
                              </div>
                            ) : (
                              <div className="flex flex-col items-center">
                                <Upload className="h-12 w-12 text-gray-400 mb-2" />
                                <p className="text-sm text-gray-600">
                                  Clique para adicionar imagens (máx. 10)
                                </p>
                                <p className="text-xs text-gray-500 mt-1">
                                  PNG, JPG, JPEG até 10MB cada
                                </p>
                              </div>
                            )}
                          </label>
                        </div>

                        {/* Galeria de Imagens */}
                        <div>
                          <h4 className="font-medium mb-3">
                            Imagens do Produto ({product.images?.length || 0}/10)
                          </h4>
                          {product.images && product.images.length > 0 ? (
                            <div className="grid grid-cols-3 gap-4">
                              {product.images.map((imageUrl, index) => (
                                <div key={index} className="relative group">
                                  <img
                                    src={imageUrl}
                                    alt={`${product.name} - ${index + 1}`}
                                    className="w-full h-32 object-cover rounded-lg"
                                  />
                                  <button
                                    onClick={() => deleteImageMutation.mutate({
                                      productId: product.id,
                                      imageIndex: index
                                    })}
                                    className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                                    data-testid={`button-delete-image-${index}`}
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                  {index === 0 && (
                                    <div className="absolute bottom-2 left-2 bg-blue-500 text-white px-2 py-1 rounded text-xs">
                                      Principal
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-center py-8 text-gray-500">
                              <Images className="h-12 w-12 mx-auto mb-2 opacity-50" />
                              <p className="text-sm">Nenhuma imagem adicionada</p>
                            </div>
                          )}
                        </div>

                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                          <p className="text-xs text-blue-700">
                            <strong>Dica:</strong> A primeira imagem será usada como imagem principal do produto no hotsite.
                            As demais aparecerão na galeria de fotos.
                          </p>
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
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
            As imagens devem ser adicionadas aqui no Sistema Integra para aparecerem no hotsite.
          </p>
        </div>
      </div>
    </div>
  );
}
