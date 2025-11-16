import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Customer } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchIcon, UserIcon, PhoneIcon, PlusIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface CustomerSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectCustomer: (customer: Customer) => void;
}

export function CustomerSearchModal({ isOpen, onClose, onSelectCustomer }: CustomerSearchModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreatingMode, setIsCreatingMode] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Function to extract phone number from search query
  const extractPhoneNumber = (query: string): string | null => {
    // Remove all non-digit characters except +
    const cleaned = query.replace(/[^\d+]/g, '');
    
    // Check if it looks like a phone number (has at least 8 digits)
    if (cleaned.replace(/\+/g, '').length >= 8) {
      // If doesn't start with +, assume Brazilian number and add +55
      if (!cleaned.startsWith('+')) {
        return `+55${cleaned}`;
      }
      return cleaned;
    }
    
    return null;
  };

  // Check if search query contains a phone number
  const detectedPhone = extractPhoneNumber(searchQuery);
  const isPhoneNumber = detectedPhone !== null;

  // Query to search customers - only run when there's a search query
  const { data: customers, isLoading, error } = useQuery({
    queryKey: ["/api/customers/search", searchQuery],
    queryFn: async () => {
      if (!searchQuery.trim()) return [];
      const response = await fetch(`/api/customers/search?q=${encodeURIComponent(searchQuery.trim())}`);
      if (!response.ok) {
        throw new Error("Erro ao buscar clientes");
      }
      return response.json() as Customer[];
    },
    enabled: searchQuery.trim().length >= 2, // Only search when at least 2 characters
  });

  // Mutation to create new customer
  const createCustomerMutation = useMutation({
    mutationFn: async (customerData: { name: string; phone: string }) => {
      const response = await apiRequest("POST", "/api/customers", customerData);
      return response.json() as Customer;
    },
    onSuccess: (newCustomer) => {
      toast({
        title: "Sucesso",
        description: `Cliente ${newCustomer.name} criado com sucesso`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/search"] });
      onSelectCustomer(newCustomer);
      onClose();
      setSearchQuery("");
      setIsCreatingMode(false);
      setCustomerName("");
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar cliente",
        variant: "destructive",
      });
    },
  });

  const handleStartCreation = () => {
    if (!detectedPhone) {
      toast({
        title: "Erro", 
        description: "Digite um número de telefone válido para criar o cliente",
        variant: "destructive",
      });
      return;
    }

    // Extract name from search query (remove phone number parts)
    const nameFromQuery = searchQuery
      .replace(/[\d\s\-\(\)\+]/g, '') // Remove digits, spaces, dashes, parentheses, plus
      .trim() || "";

    setCustomerName(nameFromQuery);
    setIsCreatingMode(true);
  };

  const handleConfirmCreation = () => {
    if (!customerName.trim()) {
      toast({
        title: "Erro",
        description: "Nome é obrigatório",
        variant: "destructive",
      });
      return;
    }

    createCustomerMutation.mutate({
      name: customerName.trim(),
      phone: detectedPhone!,
    });
  };

  const handleCancelCreation = () => {
    setIsCreatingMode(false);
    setCustomerName("");
  };

  const handleCustomerSelect = (customer: Customer) => {
    onSelectCustomer(customer);
    onClose();
    setSearchQuery("");
  };

  const handleClose = () => {
    onClose();
    setSearchQuery("");
    setIsCreatingMode(false);
    setCustomerName("");
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md" data-testid="modal-customer-search">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="text-modal-title">
            <SearchIcon className="h-5 w-5" />
            Buscar Cliente
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Search Input */}
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              type="text"
              placeholder="Digite o nome ou número do cliente..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-customer"
              autoFocus
            />
          </div>

          {/* Search Results */}
          <div className="max-h-60 overflow-y-auto space-y-2">
            {searchQuery.trim().length < 2 && (
              <p className="text-gray-500 text-sm text-center py-4" data-testid="text-search-instruction">
                Digite pelo menos 2 caracteres para buscar
              </p>
            )}

            {searchQuery.trim().length >= 2 && isLoading && (
              <p className="text-gray-500 text-sm text-center py-4" data-testid="text-loading">
                Buscando clientes...
              </p>
            )}

            {searchQuery.trim().length >= 2 && error && (
              <p className="text-red-500 text-sm text-center py-4" data-testid="text-error">
                Erro ao buscar clientes. Tente novamente.
              </p>
            )}

            {searchQuery.trim().length >= 2 && !isLoading && !error && customers && customers.length === 0 && !isCreatingMode && (
              <div className="text-center py-4 space-y-3">
                <p className="text-gray-500 text-sm" data-testid="text-no-results">
                  Nenhum cliente encontrado
                </p>
                {isPhoneNumber && (
                  <div className="space-y-2">
                    <p className="text-sm text-gray-600">
                      Número detectado: <span className="font-medium">{detectedPhone}</span>
                    </p>
                    <Button
                      onClick={handleStartCreation}
                      className="w-full bg-whatsapp-500 hover:bg-whatsapp-600 text-white"
                      data-testid="button-create-new-customer"
                    >
                      <PlusIcon className="h-4 w-4 mr-2" />
                      Criar novo cliente
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Customer Creation Form */}
            {isCreatingMode && (
              <div className="py-4 space-y-4 border rounded-lg p-4 bg-gray-50" data-testid="form-create-customer">
                <div className="text-center">
                  <h3 className="text-lg font-medium text-gray-900">Criar Novo Cliente</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Número: <span className="font-medium">{detectedPhone}</span>
                  </p>
                </div>
                
                <div className="space-y-2">
                  <label htmlFor="customer-name" className="text-sm font-medium text-gray-700">
                    Nome do Cliente *
                  </label>
                  <Input
                    id="customer-name"
                    type="text"
                    placeholder="Digite o nome do cliente..."
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    data-testid="input-customer-name"
                    autoFocus
                  />
                </div>

                <div className="flex space-x-2">
                  <Button
                    onClick={handleCancelCreation}
                    variant="outline"
                    className="flex-1"
                    data-testid="button-cancel-creation"
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={handleConfirmCreation}
                    disabled={createCustomerMutation.isPending}
                    className="flex-1 bg-whatsapp-500 hover:bg-whatsapp-600 text-white"
                    data-testid="button-confirm-creation"
                  >
                    {createCustomerMutation.isPending ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                        Criando...
                      </>
                    ) : (
                      <>
                        <PlusIcon className="h-4 w-4 mr-2" />
                        Criar Cliente
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {customers && customers.length > 0 && (
              <div className="space-y-2" data-testid="list-customers">
                {customers.map((customer) => (
                  <Button
                    key={customer.id}
                    variant="outline"
                    className="w-full justify-start h-auto p-3 hover:bg-gray-50"
                    onClick={() => handleCustomerSelect(customer)}
                    data-testid={`button-select-customer-${customer.id}`}
                  >
                    <div className="flex items-center space-x-3 w-full">
                      <div className="w-8 h-8 bg-whatsapp-500 rounded-full flex items-center justify-center flex-shrink-0">
                        <UserIcon className="h-4 w-4 text-white" />
                      </div>
                      <div className="flex-1 text-left">
                        <div className="font-medium text-gray-900" data-testid={`text-customer-name-${customer.id}`}>
                          {customer.name}
                        </div>
                        <div className="flex items-center text-sm text-gray-500" data-testid={`text-customer-phone-${customer.id}`}>
                          <PhoneIcon className="h-3 w-3 mr-1" />
                          {customer.phone}
                        </div>
                        {customer.lastContact && (
                          <div className="text-xs text-gray-400" data-testid={`text-customer-last-contact-${customer.id}`}>
                            Último contato: {new Date(customer.lastContact).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end space-x-2 pt-4 border-t">
            <Button
              variant="outline"
              onClick={handleClose}
              data-testid="button-cancel"
            >
              Cancelar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}