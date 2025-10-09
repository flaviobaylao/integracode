import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { insertProductSchema, type Product } from "@shared/schema";
import { z } from "zod";

interface ProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingProduct: Product | null;
}

export default function ProductModal({ isOpen, onClose, editingProduct }: ProductModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    price: '',
    stock: '',
    imageUrl: '',
    omieCode: '',
    omieCodigo: '',
    omieCodigoProduto: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (editingProduct) {
      setFormData({
        name: editingProduct.name,
        description: editingProduct.description || '',
        price: editingProduct.price,
        stock: editingProduct.stock.toString(),
        imageUrl: editingProduct.imageUrl || '',
        omieCode: editingProduct.omieCode || '',
        omieCodigo: editingProduct.omieCodigo || '',
        omieCodigoProduto: editingProduct.omieCodigoProduto || '',
      });
    } else {
      setFormData({
        name: '',
        description: '',
        price: '',
        stock: '',
        imageUrl: '',
        omieCode: '',
        omieCodigo: '',
        omieCodigoProduto: '',
      });
    }
    setErrors({});
  }, [editingProduct, isOpen]);

  const createProductMutation = useMutation({
    mutationFn: async (data: any) => {
      if (editingProduct) {
        await apiRequest('PUT', `/api/products/${editingProduct.id}`, data);
      } else {
        await apiRequest('POST', '/api/products', data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      onClose();
      toast({
        title: "Sucesso",
        description: editingProduct 
          ? "Produto atualizado com sucesso!" 
          : "Produto criado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    try {
      const dataToValidate = {
        ...formData,
        price: parseFloat(formData.price),
        stock: parseInt(formData.stock),
        description: formData.description || undefined,
        imageUrl: formData.imageUrl || undefined,
        omieCode: formData.omieCode || undefined,
        omieCodigo: formData.omieCodigo || undefined,
        omieCodigoProduto: formData.omieCodigoProduto || undefined,
      };

      const validatedData = insertProductSchema.parse(dataToValidate);
      createProductMutation.mutate(validatedData);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fieldErrors: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) {
            fieldErrors[err.path[0] as string] = err.message;
          }
        });
        setErrors(fieldErrors);
      }
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editingProduct ? 'Editar Produto' : 'Novo Produto'}
          </DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Nome do Produto *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              className={errors.name ? "border-red-500" : ""}
              placeholder="Ex: Suco de Laranja Natural"
            />
            {errors.name && <p className="text-sm text-red-500 mt-1">{errors.name}</p>}
          </div>
          
          <div>
            <Label htmlFor="description">Descrição</Label>
            <Textarea
              id="description"
              rows={3}
              value={formData.description}
              onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
              className={errors.description ? "border-red-500" : ""}
              placeholder="Ex: 500ml - Suco natural sem conservantes"
            />
            {errors.description && <p className="text-sm text-red-500 mt-1">{errors.description}</p>}
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="price">Preço (R$) *</Label>
              <Input
                id="price"
                type="number"
                step="0.01"
                value={formData.price}
                onChange={(e) => setFormData(prev => ({ ...prev, price: e.target.value }))}
                className={errors.price ? "border-red-500" : ""}
                placeholder="0,00"
              />
              {errors.price && <p className="text-sm text-red-500 mt-1">{errors.price}</p>}
            </div>
            
            <div>
              <Label htmlFor="stock">Estoque *</Label>
              <Input
                id="stock"
                type="number"
                value={formData.stock}
                onChange={(e) => setFormData(prev => ({ ...prev, stock: e.target.value }))}
                className={errors.stock ? "border-red-500" : ""}
                placeholder="0"
              />
              {errors.stock && <p className="text-sm text-red-500 mt-1">{errors.stock}</p>}
            </div>
          </div>
          
          <div className="border-t border-gray-200 pt-4">
            <h3 className="text-sm font-semibold mb-3">Códigos do Omie (opcional)</h3>
            <div className="space-y-3">
              <div>
                <Label htmlFor="omieCodigo">Código Alfanumérico Omie</Label>
                <Input
                  id="omieCodigo"
                  value={formData.omieCodigo}
                  onChange={(e) => setFormData(prev => ({ ...prev, omieCodigo: e.target.value }))}
                  placeholder="Ex: PRD00003"
                  data-testid="input-omie-codigo"
                />
                <p className="text-xs text-gray-500 mt-1">Código do produto no Omie (ex: PRD00003)</p>
              </div>
              
              <div>
                <Label htmlFor="omieCodigoProduto">ID Numérico do Produto Omie</Label>
                <Input
                  id="omieCodigoProduto"
                  value={formData.omieCodigoProduto}
                  onChange={(e) => setFormData(prev => ({ ...prev, omieCodigoProduto: e.target.value }))}
                  placeholder="Ex: 2425693571"
                  data-testid="input-omie-codigo-produto"
                />
                <p className="text-xs text-gray-500 mt-1">ID numérico do produto no Omie</p>
              </div>
            </div>
          </div>
          
          <div>
            <Label htmlFor="imageUrl">URL da Imagem</Label>
            <Input
              id="imageUrl"
              type="url"
              value={formData.imageUrl}
              onChange={(e) => setFormData(prev => ({ ...prev, imageUrl: e.target.value }))}
              className={errors.imageUrl ? "border-red-500" : ""}
              placeholder="https://exemplo.com/imagem.jpg"
              data-testid="input-image-url"
            />
            {errors.imageUrl && <p className="text-sm text-red-500 mt-1">{errors.imageUrl}</p>}
          </div>
          
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel">
              Cancelar
            </Button>
            <Button 
              type="submit" 
              className="bg-honest-blue hover:bg-blue-700"
              disabled={createProductMutation.isPending}
              data-testid="button-save-product"
            >
              {createProductMutation.isPending 
                ? 'Salvando...' 
                : editingProduct ? 'Atualizar Produto' : 'Salvar Produto'
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
