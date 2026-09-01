import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RefreshCw, Images, X, Upload, Check, Pencil, FileText, Download, Trash2, AlertTriangle, Plus } from "lucide-react";
import ProductModal from "@/components/ProductModal";
import { apiRequest } from "@/lib/queryClient";
import type { Product } from "@shared/schema";

type FichaMeta = {
  fileName: string;
  fileSize: number;
  extractStatus: string; // ok | sem_texto | falha
  textLength: number;
  updatedAt: string | null;
};

const formatFileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function ProductManagement() {
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [editingNcm, setEditingNcm] = useState<string | null>(null);
  const [ncmValue, setNcmValue] = useState("");
  // Ficha técnica: qual produto está com upload em andamento (só um por vez).
  const [uploadingFicha, setUploadingFicha] = useState<string | null>(null);
  // CADASTRO DE PRODUTO: o ProductModal ja existia e fazia POST /api/products,
  // mas nao era usado por nenhuma tela desde que o botao de sincronizar o Omie
  // saiu (26/ago/2026) — na pratica o catalogo ficou sem NENHUMA porta de
  // entrada pela interface. Aqui ele volta a ser aberto: "Novo Produto" no
  // cabecalho e o lapis de editar em cada card.
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  
  const { data: products, isLoading } = useQuery<Product[]>({
    queryKey: ['/api/products'],
    retry: false,
  });
  // Metadado das fichas técnicas (nome, tamanho, status da extração de texto).
  // Query separada de propósito: o PDF em si NUNCA entra na listagem do catálogo.
  const { data: fichas } = useQuery<Record<string, FichaMeta>>({
    queryKey: ['/api/products/datasheets'],
    retry: false,
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // A mutation de "Sincronizar Produtos" foi REMOVIDA em 26/ago/2026 junto com o
  // botão. Ela chamava POST /api/omie/sync-products, rota que apagava todos os
  // produtos antes de importar e que hoje responde 410. Removida por inteiro (e
  // não só desligada) para ninguém reaproveitar a fiação achando que ainda serve:
  // com o Omie descontinuado, o catálogo daqui não tem origem para reimportação.

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

  const deleteFichaMutation = useMutation({
    mutationFn: async (productId: string) => {
      const response = await fetch(`/api/products/${productId}/ficha-tecnica`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Erro ao remover ficha técnica');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products/datasheets'] });
      toast({ title: "Ficha removida", description: "A ficha técnica foi excluída." });
    },
    onError: (error: any) => {
      toast({ title: "Erro ao remover", description: error.message, variant: "destructive" });
    },
  });

  const handleFichaUpload = async (productId: string, file: File) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      toast({ title: "Arquivo inválido", description: "A ficha técnica precisa ser um PDF.", variant: "destructive" });
      return;
    }
    setUploadingFicha(productId);
    try {
      const formData = new FormData();
      formData.append('ficha', file);
      const response = await fetch(`/api/products/${productId}/ficha-tecnica`, { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || 'Erro ao enviar a ficha técnica');
      queryClient.invalidateQueries({ queryKey: ['/api/products/datasheets'] });
      // O PDF sem camada de texto (escaneado) é anexado do mesmo jeito, mas não
      // alimenta a IA — o usuário precisa saber disso na hora, não depois.
      toast({
        title: data?.extractStatus === 'ok' ? "Ficha técnica anexada" : "Ficha anexada, sem texto legível",
        description: data?.extractStatus === 'ok'
          ? `Texto lido (${data.textLength} caracteres) e disponível para os agentes de IA.`
          : "O PDF parece ser digitalizado (imagem). Ele fica disponível para download, mas a IA não consegue ler o conteúdo.",
        variant: data?.extractStatus === 'ok' ? undefined : "destructive",
      });
    } catch (error: any) {
      toast({ title: "Erro no upload", description: error.message, variant: "destructive" });
    } finally {
      setUploadingFicha(null);
    }
  };

  const updateNcmMutation = useMutation({
    mutationFn: async ({ productId, ncm }: { productId: string; ncm: string }) => {
      const response = await apiRequest('PUT', `/api/products/${productId}`, { ncm });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      setEditingNcm(null);
      toast({ title: "NCM atualizado", description: "Código NCM salvo com sucesso." });
    },
    onError: (error: any) => {
      toast({ title: "Erro ao salvar NCM", description: error.message, variant: "destructive" });
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
            onClick={() => { setEditingProduct(null); setModalOpen(true); }}
            data-testid="button-novo-produto"
          >
            <Plus className="mr-2 h-4 w-4" />
            Novo Produto
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              window.location.hash = '#omie-integration';
            }}
            data-testid="button-omie-integration"
          >
            <i className="fas fa-cog mr-2"></i>Configurações Omie
          </Button>
          {/*
            BOTÃO "Sincronizar Produtos" REMOVIDO (26/ago/2026).

            Ele chamava POST /api/omie/sync-products, que APAGA todos os
            produtos antes de importar. Com o Omie descontinuado, o INTEGRA
            virou a fonte de verdade do catálogo: apagar levaria junto preços
            de varejo e atacado, fotos e NCM, sem nada de onde reimportar — e
            derrubaria o PDV do balcão, que lê essas mesmas colunas.

            A rota no servidor também foi desativada (responde 410). Este
            botão sai da tela para ninguém bater numa porta fechada; a trava
            que importa é a do servidor.

            Preço de produto agora se altera em Produtos & Estoque →
            Preços de Venda.
          */}
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

                  <div className="flex items-center gap-1">
                    <span className="text-xs font-medium text-gray-600">NCM:</span>
                    {editingNcm === product.id ? (
                      <div className="flex items-center gap-1 flex-1">
                        <Input
                          value={ncmValue}
                          onChange={(e) => setNcmValue(e.target.value.replace(/[^0-9.]/g, '').slice(0, 10))}
                          placeholder="00000000"
                          className="h-6 text-xs px-2 flex-1"
                          maxLength={10}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') updateNcmMutation.mutate({ productId: product.id, ncm: ncmValue });
                            if (e.key === 'Escape') setEditingNcm(null);
                          }}
                        />
                        <button
                          onClick={() => updateNcmMutation.mutate({ productId: product.id, ncm: ncmValue })}
                          className="text-green-600 hover:text-green-700 p-0.5"
                          disabled={updateNcmMutation.isPending}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setEditingNcm(null)} className="text-gray-400 hover:text-gray-600 p-0.5">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 flex-1">
                        <span className="text-xs text-gray-500">{product.ncm || '—'}</span>
                        <button
                          onClick={() => { setEditingNcm(product.id); setNcmValue(product.ncm || ''); }}
                          className="text-gray-400 hover:text-blue-600 p-0.5"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>

                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => { setEditingProduct(product); setModalOpen(true); }}
                    data-testid={`button-edit-product-${product.id}`}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Editar Produto
                  </Button>

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

                  {/* Ficha técnica (PDF) — anexo do produto e fonte dos agentes de IA */}
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full"
                        data-testid={`button-ficha-tecnica-${product.id}`}
                      >
                        <FileText className="mr-2 h-4 w-4" />
                        {fichas?.[product.id] ? "Ficha Técnica ✓" : "Ficha Técnica"}
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>Ficha Técnica - {product.name}</DialogTitle>
                      </DialogHeader>

                      <div className="space-y-4">
                        {fichas?.[product.id] ? (
                          <div className="border rounded-lg p-4 space-y-3">
                            <div className="flex items-start gap-3">
                              <FileText className="h-8 w-8 text-red-500 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="font-medium truncate" title={fichas[product.id].fileName}>
                                  {fichas[product.id].fileName}
                                </p>
                                <p className="text-xs text-gray-500">
                                  {formatFileSize(fichas[product.id].fileSize)}
                                  {fichas[product.id].updatedAt &&
                                    ` · enviada em ${new Date(fichas[product.id].updatedAt as string).toLocaleDateString('pt-BR')}`}
                                </p>
                              </div>
                            </div>

                            {fichas[product.id].extractStatus === 'ok' ? (
                              <div className="bg-green-50 border border-green-200 rounded p-3 text-xs text-green-800">
                                <strong>Disponível para os agentes de IA.</strong> O texto da ficha
                                ({fichas[product.id].textLength.toLocaleString('pt-BR')} caracteres) foi lido e é
                                consultado quando o cliente pergunta composição, informação nutricional,
                                validade ou qualquer detalhe técnico.
                              </div>
                            ) : (
                              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800 flex gap-2">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                <span>
                                  <strong>A IA não consegue ler este PDF.</strong> Ele parece ser digitalizado
                                  (imagem, sem camada de texto). O arquivo continua disponível para download e
                                  para envio ao cliente. Para alimentar a IA, envie a versão em PDF de texto.
                                </span>
                              </div>
                            )}

                            <div className="flex gap-2">
                              <Button variant="outline" size="sm" asChild>
                                <a href={`/api/products/${product.id}/ficha-tecnica`} target="_blank" rel="noreferrer">
                                  <FileText className="mr-2 h-4 w-4" /> Visualizar
                                </a>
                              </Button>
                              <Button variant="outline" size="sm" asChild>
                                <a href={`/api/products/${product.id}/ficha-tecnica?download=1`}>
                                  <Download className="mr-2 h-4 w-4" /> Baixar
                                </a>
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-red-600 hover:text-red-700"
                                onClick={() => deleteFichaMutation.mutate(product.id)}
                                disabled={deleteFichaMutation.isPending}
                                data-testid={`button-delete-ficha-${product.id}`}
                              >
                                <Trash2 className="mr-2 h-4 w-4" /> Remover
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="text-center py-6 text-gray-500">
                            <FileText className="h-12 w-12 mx-auto mb-2 opacity-40" />
                            <p className="text-sm">Nenhuma ficha técnica anexada</p>
                          </div>
                        )}

                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleFichaUpload(product.id, f);
                              e.target.value = '';
                            }}
                            className="hidden"
                            id={`ficha-upload-${product.id}`}
                            disabled={uploadingFicha === product.id}
                          />
                          <label htmlFor={`ficha-upload-${product.id}`} className="cursor-pointer">
                            {uploadingFicha === product.id ? (
                              <div className="flex flex-col items-center">
                                <RefreshCw className="h-10 w-10 text-gray-400 animate-spin mb-2" />
                                <p className="text-sm text-gray-600">Enviando e lendo o PDF...</p>
                              </div>
                            ) : (
                              <div className="flex flex-col items-center">
                                <Upload className="h-10 w-10 text-gray-400 mb-2" />
                                <p className="text-sm text-gray-600">
                                  {fichas?.[product.id] ? "Clique para substituir a ficha" : "Clique para anexar a ficha técnica"}
                                </p>
                                <p className="text-xs text-gray-500 mt-1">PDF até 15MB</p>
                              </div>
                            )}
                          </label>
                        </div>

                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                          <p className="text-xs text-blue-700">
                            <strong>Como a IA usa:</strong> o texto do PDF é lido no envio e fica disponível
                            para todos os agentes do sistema. Quando o cliente perguntar sobre ingredientes,
                            tabela nutricional, alergênicos, validade ou conservação, o agente responde
                            com o que está escrito na ficha — e pode enviar o próprio PDF ao cliente.
                            Cada produto tem uma ficha; enviar outra substitui a anterior.
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
            <strong>Importante:</strong> O catálogo é mantido aqui no Sistema Integra — o Omie não é mais a origem
            dos produtos. Use "Novo Produto" para cadastrar e "Editar Produto" para ajustar preços, NCM e códigos.
            As imagens e a ficha técnica também são adicionadas aqui para aparecerem no hotsite.
          </p>
        </div>
      </div>
      <ProductModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setEditingProduct(null); }}
        editingProduct={editingProduct}
      />

    </div>
  );
}
