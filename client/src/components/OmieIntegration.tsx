import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { 
  Building2, 
  CreditCard, 
  AlertTriangle, 
  CheckCircle, 
  XCircle,
  Search,
  DollarSign,
  Calendar,
  Phone,
  Mail,
  MapPin
} from 'lucide-react';

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
  bloqueado?: string;
  inativo?: string;
  limite_credito?: number;
}

interface OmieCreditInfo {
  limite_credito?: number;
  valor_em_aberto?: number;
  dias_em_atraso?: number;
  bloqueado_financeiro?: string;
}

interface CreditApproval {
  aprovado: boolean;
  motivo?: string;
  limiteCreditoDisponivel?: number;
  diasEmAtraso?: number;
}

interface OmieStatus {
  configured: boolean;
  message: string;
}

export default function OmieIntegration() {
  const [cnpjCpf, setCnpjCpf] = useState('');
  const [valorVenda, setValorVenda] = useState('');
  const [selectedClient, setSelectedClient] = useState<OmieClient | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Verificar status da integração Omie
  const { data: omieStatus, isLoading: statusLoading } = useQuery<OmieStatus>({
    queryKey: ['/api/omie/status'],
  });

  // Buscar cliente no Omie
  const searchClientMutation = useMutation({
    mutationFn: async (cnpjCpf: string) => {
      const response = await fetch(`/api/omie/client/${cnpjCpf}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error('Cliente não encontrado');
      }
      return response.json();
    },
    onSuccess: (client: OmieClient) => {
      setSelectedClient(client);
      toast({
        title: 'Cliente encontrado',
        description: `Cliente ${client.razao_social} localizado no Omie`,
      });
    },
    onError: (error: any) => {
      console.error('Erro ao buscar cliente:', error);
      setSelectedClient(null);
      toast({
        title: 'Cliente não encontrado',
        description: 'Cliente não foi encontrado no sistema Omie',
        variant: 'destructive',
      });
    },
  });

  // Verificar crédito
  const checkCreditMutation = useMutation({
    mutationFn: async ({ cnpjCpf, valorVenda }: { cnpjCpf: string; valorVenda: number }) => {
      const response = await fetch('/api/omie/check-credit', {
        method: 'POST',
        body: JSON.stringify({ cnpjCpf, valorVenda }),
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error('Erro na verificação de crédito');
      }
      return response.json();
    },
    onSuccess: (result: CreditApproval) => {
      toast({
        title: result.aprovado ? 'Crédito aprovado' : 'Crédito negado',
        description: result.motivo || (result.aprovado ? 'Cliente apto para a venda' : 'Verificação concluída'),
        variant: result.aprovado ? 'default' : 'destructive',
      });
    },
    onError: (error: any) => {
      console.error('Erro ao verificar crédito:', error);
      toast({
        title: 'Erro na consulta',
        description: 'Não foi possível verificar o crédito do cliente',
        variant: 'destructive',
      });
    },
  });

  // Buscar informações de crédito
  const { data: creditInfo, isLoading: creditLoading } = useQuery<OmieCreditInfo>({
    queryKey: ['/api/omie/client', cnpjCpf, 'credit'],
    enabled: !!cnpjCpf && cnpjCpf.replace(/\D/g, '').length >= 11,
    queryFn: async () => {
      const response = await fetch(`/api/omie/client/${cnpjCpf.replace(/\D/g, '')}/credit`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error('Informações de crédito não encontradas');
      }
      return response.json();
    },
  });

  const handleSearchClient = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cnpjCpf.trim()) {
      toast({
        title: 'CNPJ/CPF obrigatório',
        description: 'Digite o CNPJ ou CPF do cliente',
        variant: 'destructive',
      });
      return;
    }
    searchClientMutation.mutate(cnpjCpf.replace(/\D/g, ''));
  };

  const handleCheckCredit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cnpjCpf.trim() || !valorVenda.trim()) {
      toast({
        title: 'Dados obrigatórios',
        description: 'Digite o CNPJ/CPF e o valor da venda',
        variant: 'destructive',
      });
      return;
    }

    const valor = parseFloat(valorVenda.replace(/[^\d,]/g, '').replace(',', '.'));
    if (isNaN(valor) || valor <= 0) {
      toast({
        title: 'Valor inválido',
        description: 'Digite um valor válido para a venda',
        variant: 'destructive',
      });
      return;
    }

    checkCreditMutation.mutate({ 
      cnpjCpf: cnpjCpf.replace(/\D/g, ''), 
      valorVenda: valor 
    });
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const formatCnpjCpf = (value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 11) {
      // CPF
      return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    } else {
      // CNPJ
      return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
  };

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Integração Omie ERP
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Consulta de crédito e informações de clientes
          </p>
        </div>
      </div>

      {/* Status da Integração */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Status da Integração
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            {omieStatus?.configured ? (
              <Badge variant="default" className="bg-green-100 text-green-800">
                <CheckCircle className="h-4 w-4 mr-1" />
                Configurado
              </Badge>
            ) : (
              <Badge variant="destructive">
                <XCircle className="h-4 w-4 mr-1" />
                Não Configurado
              </Badge>
            )}
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {omieStatus?.message}
            </span>
          </div>
        </CardContent>
      </Card>

      {!omieStatus?.configured && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Para usar a integração Omie, configure as chaves OMIE_APP_KEY e OMIE_APP_SECRET nas variáveis de ambiente.
          </AlertDescription>
        </Alert>
      )}

      {omieStatus?.configured && (
        <>
          {/* Busca de Cliente */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-5 w-5" />
                Buscar Cliente
              </CardTitle>
              <CardDescription>
                Digite o CNPJ ou CPF do cliente para buscar no Omie
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSearchClient} className="space-y-4">
                <div>
                  <Label htmlFor="cnpjCpf">CNPJ/CPF</Label>
                  <Input
                    id="cnpjCpf"
                    type="text"
                    placeholder="00.000.000/0000-00 ou 000.000.000-00"
                    value={cnpjCpf}
                    onChange={(e) => setCnpjCpf(formatCnpjCpf(e.target.value))}
                    maxLength={18}
                  />
                </div>
                <Button 
                  type="submit" 
                  disabled={searchClientMutation.isPending}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {searchClientMutation.isPending ? 'Buscando...' : 'Buscar Cliente'}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Informações do Cliente */}
          {selectedClient && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  Dados do Cliente
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-gray-600">Razão Social</Label>
                    <p className="text-sm font-semibold">{selectedClient.razao_social}</p>
                  </div>
                  {selectedClient.nome_fantasia && (
                    <div>
                      <Label className="text-sm font-medium text-gray-600">Nome Fantasia</Label>
                      <p className="text-sm">{selectedClient.nome_fantasia}</p>
                    </div>
                  )}
                  <div>
                    <Label className="text-sm font-medium text-gray-600">CNPJ/CPF</Label>
                    <p className="text-sm">{formatCnpjCpf(selectedClient.cnpj_cpf)}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-gray-600">Código Omie</Label>
                    <p className="text-sm">{selectedClient.codigo_cliente_omie}</p>
                  </div>
                  {selectedClient.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-gray-500" />
                      <p className="text-sm">{selectedClient.email}</p>
                    </div>
                  )}
                  {selectedClient.telefone1_ddd && selectedClient.telefone1_numero && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-gray-500" />
                      <p className="text-sm">({selectedClient.telefone1_ddd}) {selectedClient.telefone1_numero}</p>
                    </div>
                  )}
                </div>

                {(selectedClient.endereco || selectedClient.cidade) && (
                  <div className="flex items-start gap-2 pt-2 border-t">
                    <MapPin className="h-4 w-4 text-gray-500 mt-1" />
                    <div>
                      <p className="text-sm">
                        {selectedClient.endereco} {selectedClient.endereco_numero}
                      </p>
                      <p className="text-sm text-gray-600">
                        {selectedClient.bairro}, {selectedClient.cidade} - {selectedClient.estado}
                      </p>
                      {selectedClient.cep && (
                        <p className="text-sm text-gray-600">CEP: {selectedClient.cep}</p>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Badge variant={selectedClient.bloqueado === 'S' ? 'destructive' : 'default'}>
                    {selectedClient.bloqueado === 'S' ? 'Bloqueado' : 'Ativo'}
                  </Badge>
                  {selectedClient.inativo === 'S' && (
                    <Badge variant="secondary">Inativo</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Informações de Crédito */}
          {creditInfo && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  Situação de Crédito
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="text-center p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
                    <DollarSign className="h-8 w-8 mx-auto mb-2 text-blue-600" />
                    <p className="text-sm text-gray-600 dark:text-gray-400">Limite de Crédito</p>
                    <p className="text-lg font-semibold text-blue-600">
                      {formatCurrency(creditInfo.limite_credito || 0)}
                    </p>
                  </div>
                  <div className="text-center p-4 bg-orange-50 dark:bg-orange-950 rounded-lg">
                    <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-orange-600" />
                    <p className="text-sm text-gray-600 dark:text-gray-400">Em Aberto</p>
                    <p className="text-lg font-semibold text-orange-600">
                      {formatCurrency(creditInfo.valor_em_aberto || 0)}
                    </p>
                  </div>
                  <div className="text-center p-4 bg-red-50 dark:bg-red-950 rounded-lg">
                    <Calendar className="h-8 w-8 mx-auto mb-2 text-red-600" />
                    <p className="text-sm text-gray-600 dark:text-gray-400">Dias em Atraso</p>
                    <p className="text-lg font-semibold text-red-600">
                      {creditInfo.dias_em_atraso || 0} dias
                    </p>
                  </div>
                </div>

                <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <p className="text-sm text-gray-600 dark:text-gray-400">Crédito Disponível</p>
                  <p className="text-xl font-bold text-green-600">
                    {formatCurrency((creditInfo.limite_credito || 0) - (creditInfo.valor_em_aberto || 0))}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Verificação de Crédito para Venda */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5" />
                Aprovação de Crédito
              </CardTitle>
              <CardDescription>
                Verifique se o cliente está apto para uma nova venda
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCheckCredit} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="cnpjCpfCredit">CNPJ/CPF</Label>
                    <Input
                      id="cnpjCpfCredit"
                      type="text"
                      placeholder="00.000.000/0000-00"
                      value={cnpjCpf}
                      onChange={(e) => setCnpjCpf(formatCnpjCpf(e.target.value))}
                      maxLength={18}
                    />
                  </div>
                  <div>
                    <Label htmlFor="valorVenda">Valor da Venda</Label>
                    <Input
                      id="valorVenda"
                      type="text"
                      placeholder="R$ 0,00"
                      value={valorVenda}
                      onChange={(e) => setValorVenda(e.target.value)}
                    />
                  </div>
                </div>
                <Button 
                  type="submit" 
                  disabled={checkCreditMutation.isPending}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {checkCreditMutation.isPending ? 'Verificando...' : 'Verificar Crédito'}
                </Button>
              </form>

              {checkCreditMutation.data && (
                <div className="mt-4 p-4 rounded-lg border">
                  <div className="flex items-center gap-2 mb-2">
                    {checkCreditMutation.data.aprovado ? (
                      <CheckCircle className="h-5 w-5 text-green-600" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-600" />
                    )}
                    <span className={`font-semibold ${
                      checkCreditMutation.data.aprovado ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {checkCreditMutation.data.aprovado ? 'Crédito Aprovado' : 'Crédito Negado'}
                    </span>
                  </div>
                  {checkCreditMutation.data.motivo && (
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {checkCreditMutation.data.motivo}
                    </p>
                  )}
                  {checkCreditMutation.data.limiteCreditoDisponivel !== undefined && (
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                      Limite disponível: {formatCurrency(checkCreditMutation.data.limiteCreditoDisponivel)}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}