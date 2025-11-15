import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Download, Search, Users, Building2, User as UserIcon, Check, X, AlertCircle, Loader2 } from "lucide-react";
import type { User } from "@shared/schema";

interface OmieClientImportProps {
  isOpen: boolean;
  onClose: () => void;
}

interface OmieClient {
  codigo_cliente_omie: number;
  cnpj_cpf: string;
  razao_social: string;
  nome_fantasia?: string;
  email?: string;
  telefone1_ddd?: string;
  telefone1_numero?: string;
  endereco?: string;
  endereco_numero?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  inativo?: string;
  bloqueado?: string;
  limite_credito?: number;
}

interface OmieClientListResponse {
  clients: OmieClient[];
  totalPages: number;
  totalRecords: number;
  currentPage: number;
}

export default function OmieClientImport({ isOpen, onClose }: OmieClientImportProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedClients, setSelectedClients] = useState<Set<number>>(new Set());
  const [selectedSeller, setSelectedSeller] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Buscar usuários vendedores
  const { data: users } = useQuery({
    queryKey: ['/api/users'],
    retry: false,
  });

  // Buscar clientes do Omie
  const { data: omieData, isLoading: isLoadingClients, refetch } = useQuery({
    queryKey: ['/api/omie/clients', currentPage],
    enabled: isOpen,
    retry: false,
  });

  // Verificar status da integração Omie
  const { data: omieStatus } = useQuery({
    queryKey: ['/api/omie/status'],
    enabled: isOpen,
    retry: false,
  });

  // Mutation para importar clientes
  const importMutation = useMutation({
    mutationFn: async ({ clientIds, sellerId }: { clientIds: number[], sellerId: string }) => {
      return await apiRequest('POST', '/api/omie/import-clients', { clientIds, sellerId });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      toast({
        title: "Importação concluída",
        description: `${data.imported} cliente(s) importado(s) com sucesso! ${data.errors > 0 ? `${data.errors} erro(s) encontrado(s).` : ''}`,
      });
      setSelectedClients(new Set());
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Erro na importação",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleClientToggle = (clientId: number) => {
    const newSelected = new Set(selectedClients);
    if (newSelected.has(clientId)) {
      newSelected.delete(clientId);
    } else {
      newSelected.add(clientId);
    }
    setSelectedClients(newSelected);
  };

  const handleSelectAll = () => {
    if (!omieData?.clients) return;
    
    const filteredClients = getFilteredClients();
    if (selectedClients.size === filteredClients.length) {
      setSelectedClients(new Set());
    } else {
      setSelectedClients(new Set(filteredClients.map(client => client.codigo_cliente_omie)));
    }
  };

  const handleImport = () => {
    if (selectedClients.size === 0) {
      toast({
        title: "Erro",
        description: "Selecione pelo menos um cliente para importar",
        variant: "destructive",
      });
      return;
    }

    // Validação removida: não é mais obrigatório selecionar vendedor

    importMutation.mutate({
      clientIds: Array.from(selectedClients),
      sellerId: selectedSeller === 'no-seller' || !selectedSeller ? null : selectedSeller
    });
  };

  const getFilteredClients = () => {
    if (!omieData?.clients) return [];
    
    return omieData.clients.filter(client => {
      const searchLower = searchTerm.toLowerCase();
      return (
        client.razao_social.toLowerCase().includes(searchLower) ||
        client.nome_fantasia?.toLowerCase().includes(searchLower) ||
        client.cnpj_cpf.includes(searchTerm) ||
        client.email?.toLowerCase().includes(searchLower)
      );
    });
  };

  const formatDocument = (document: string) => {
    if (document.length === 14) {
      // CNPJ
      return document.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    } else if (document.length === 11) {
      // CPF
      return document.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    return document;
  };

  const formatPhone = (ddd?: string, number?: string) => {
    if (!ddd || !number) return '';
    return `(${ddd}) ${number}`;
  };

  if (!omieStatus?.configured) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center space-x-2">
              <AlertCircle className="h-5 w-5 text-yellow-500" />
              <span>Integração Omie Não Configurada</span>
            </DialogTitle>
          </DialogHeader>
          <div className="text-center py-6">
            <p className="text-gray-600 mb-4">
              A integração com o Omie não está configurada. Entre em contato com o administrador do sistema.
            </p>
            <Button onClick={onClose}>Fechar</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const filteredClients = getFilteredClients();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Download className="h-5 w-5 text-honest-blue" />
            <span>Importar Clientes do Omie</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Estatísticas e Filtros */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center space-x-2">
                  <Users className="h-5 w-5 text-blue-500" />
                  <div>
                    <p className="text-sm text-gray-600">Total no Omie</p>
                    <p className="text-2xl font-bold">{omieData?.totalRecords || 0}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center space-x-2">
                  <Check className="h-5 w-5 text-green-500" />
                  <div>
                    <p className="text-sm text-gray-600">Selecionados</p>
                    <p className="text-2xl font-bold">{selectedClients.size}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center space-x-2">
                  <Search className="h-5 w-5 text-orange-500" />
                  <div>
                    <p className="text-sm text-gray-600">Filtrados</p>
                    <p className="text-2xl font-bold">{filteredClients.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Controles */}
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <Input
                placeholder="Buscar por nome, documento ou email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full"
              />
            </div>
            
            <div className="md:w-64">
              <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o vendedor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no-seller">Sem vendedor atribuído</SelectItem>
                  {users && Array.isArray(users) && users
                    .filter((user: User) => user.role === 'vendedor')
                    .map((user: User) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.firstName} {user.lastName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tabela de Clientes */}
          <div className="border rounded-lg overflow-hidden">
            {isLoadingClients ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-honest-blue" />
                <span className="ml-2">Carregando clientes do Omie...</span>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox
                          checked={selectedClients.size === filteredClients.length && filteredClients.length > 0}
                          onCheckedChange={handleSelectAll}
                        />
                      </TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Documento</TableHead>
                      <TableHead>Contato</TableHead>
                      <TableHead>Localização</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredClients.map((client) => (
                      <TableRow key={client.codigo_cliente_omie}>
                        <TableCell>
                          <Checkbox
                            checked={selectedClients.has(client.codigo_cliente_omie)}
                            onCheckedChange={() => handleClientToggle(client.codigo_cliente_omie)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-start space-x-2">
                            {client.cnpj_cpf.length === 14 ? (
                              <Building2 className="h-4 w-4 text-blue-500 mt-1" />
                            ) : (
                              <UserIcon className="h-4 w-4 text-green-500 mt-1" />
                            )}
                            <div>
                              <p className="font-medium">{client.razao_social}</p>
                              {client.nome_fantasia && (
                                <p className="text-sm text-gray-600">{client.nome_fantasia}</p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-sm">
                            {formatDocument(client.cnpj_cpf)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {formatPhone(client.telefone1_ddd, client.telefone1_numero) && (
                              <p>{formatPhone(client.telefone1_ddd, client.telefone1_numero)}</p>
                            )}
                            {client.email && (
                              <p className="text-gray-600">{client.email}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {client.cidade && client.estado && (
                              <p>{client.cidade} - {client.estado}</p>
                            )}
                            {client.bairro && (
                              <p className="text-gray-600">{client.bairro}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col space-y-1">
                            <Badge 
                              variant={client.inativo === 'S' ? 'destructive' : 'default'}
                              className={client.inativo === 'S' ? '' : 'bg-green-600'}
                            >
                              {client.inativo === 'S' ? 'Inativo' : 'Ativo'}
                            </Badge>
                            {client.bloqueado === 'S' && (
                              <Badge variant="destructive">
                                Bloqueado
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {filteredClients.length === 0 && !isLoadingClients && (
                  <div className="text-center py-8 text-gray-500">
                    {searchTerm ? 'Nenhum cliente encontrado para o termo pesquisado.' : 'Nenhum cliente encontrado no Omie.'}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Paginação */}
          {omieData && omieData.totalPages > 1 && (
            <div className="flex justify-between items-center">
              <p className="text-sm text-gray-600">
                Página {omieData.currentPage} de {omieData.totalPages} 
                ({omieData.totalRecords} clientes total)
              </p>
              <div className="flex space-x-2">
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(prev => Math.min(omieData.totalPages, prev + 1))}
                  disabled={currentPage === omieData.totalPages}
                >
                  Próxima
                </Button>
              </div>
            </div>
          )}

          {/* Botões de Ação */}
          <div className="flex justify-end space-x-2 pt-4 border-t">
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              onClick={handleImport}
              disabled={selectedClients.size === 0 || importMutation.isPending}
              className="bg-honest-blue hover:bg-honest-blue/90"
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Importando...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Importar {selectedClients.size} Cliente(s)
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}