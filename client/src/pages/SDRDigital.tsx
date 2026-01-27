import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Search, MapPin, Phone, Star, Globe, Building2, MessageCircle, UserPlus, Loader2, Target } from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface Lead {
  placeId: string;
  name: string;
  address: string;
  phone?: string;
  website?: string;
  rating?: number;
  userRatingsTotal?: number;
  types?: string[];
  openNow?: boolean;
}

const CATEGORIAS = [
  { value: "bar", label: "Bares" },
  { value: "restaurant", label: "Restaurantes" },
  { value: "cafe", label: "Cafeterias" },
  { value: "bakery", label: "Padarias" },
  { value: "supermarket", label: "Supermercados" },
  { value: "convenience_store", label: "Conveniências" },
  { value: "hotel", label: "Hotéis" },
  { value: "gym", label: "Academias" },
  { value: "store", label: "Lojas em Geral" },
];

export default function SDRDigital() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [regiao, setRegiao] = useState("");
  const [categoria, setCategoria] = useState("");
  const [palavraChave, setPalavraChave] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);

  const handleOpenChatCenter = (phone: string) => {
    const normalizedPhone = phone.replace(/\D/g, '');
    window.location.href = `/telemarketing/atendimento?phone=${normalizedPhone}`;
  };

  const searchMutation = useMutation({
    mutationFn: async () => {
      if (!regiao.trim()) throw new Error("Informe a região para buscar");
      
      const params = new URLSearchParams({
        regiao: regiao.trim(),
        ...(categoria && { categoria }),
        ...(palavraChave && { palavraChave: palavraChave.trim() })
      });

      const response = await fetch(`/api/sdr/buscar-leads?${params}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao buscar leads");
      }
      return response.json();
    },
    onSuccess: (data) => {
      setLeads(data.leads || []);
      toast({
        title: "Busca concluída",
        description: `Encontrados ${data.leads?.length || 0} leads`
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro na busca",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const sendWhatsAppMutation = useMutation({
    mutationFn: async (lead: Lead) => {
      if (!lead.phone) throw new Error("Lead sem telefone cadastrado");
      
      const response = await fetch("/api/sdr/enviar-apresentacao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: lead.phone,
          leadName: lead.name,
          leadAddress: lead.address
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao enviar apresentação");
      }
      return response.json();
    },
    onSuccess: (_, lead) => {
      toast({
        title: "Apresentação enviada!",
        description: `Mensagem enviada para ${lead.name}`
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao enviar",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const saveLeadMutation = useMutation({
    mutationFn: async (lead: Lead & { latitude?: number; longitude?: number }) => {
      const response = await fetch("/api/sdr/salvar-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lead.name,
          address: lead.address,
          phone: lead.phone,
          website: lead.website,
          rating: lead.rating,
          placeId: lead.placeId,
          latitude: lead.latitude,
          longitude: lead.longitude,
          source: "sdr_digital"
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao salvar lead");
      }
      return response.json();
    },
    onSuccess: (_, lead) => {
      toast({
        title: "Lead salvo!",
        description: `${lead.name} adicionado ao CRM`
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao salvar",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    searchMutation.mutate();
  };

  const formatPhone = (phone?: string) => {
    if (!phone) return null;
    return phone.replace(/\D/g, "");
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white p-4 shadow-lg">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Target className="w-8 h-8" />
            <div>
              <h1 className="text-2xl font-bold">SDR Digital</h1>
              <p className="text-sm text-blue-100">Prospecção Inteligente de Leads</p>
            </div>
          </div>
          <BackToDashboardButton />
        </div>
      </header>

      <main className="container mx-auto p-4 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="w-5 h-5" />
              Buscar Leads
            </CardTitle>
            <CardDescription>
              Encontre potenciais clientes por região, categoria e palavra-chave
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSearch} className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="regiao">Região *</Label>
                <Input
                  id="regiao"
                  placeholder="Ex: Goiânia, GO"
                  value={regiao}
                  onChange={(e) => setRegiao(e.target.value)}
                  data-testid="input-regiao"
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="categoria">Categoria</Label>
                <Select value={categoria} onValueChange={setCategoria}>
                  <SelectTrigger data-testid="select-categoria">
                    <SelectValue placeholder="Selecione..." />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIAS.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="palavraChave">Palavra-chave</Label>
                <Input
                  id="palavraChave"
                  placeholder="Ex: bebidas, sucos"
                  value={palavraChave}
                  onChange={(e) => setPalavraChave(e.target.value)}
                  data-testid="input-palavra-chave"
                />
              </div>
              
              <div className="flex items-end">
                <Button 
                  type="submit" 
                  className="w-full bg-blue-600 hover:bg-blue-700"
                  disabled={searchMutation.isPending}
                  data-testid="button-buscar"
                >
                  {searchMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Buscando...
                    </>
                  ) : (
                    <>
                      <Search className="w-4 h-4 mr-2" />
                      Buscar
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {searchMutation.isPending && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i}>
                <CardContent className="p-4 space-y-3">
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                  <div className="flex gap-2">
                    <Skeleton className="h-9 w-24" />
                    <Skeleton className="h-9 w-24" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {!searchMutation.isPending && leads.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                Resultados ({leads.length} leads)
              </h2>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {leads.map((lead) => (
                <Card key={lead.placeId} className="hover:shadow-lg transition-shadow">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-900 line-clamp-1" data-testid={`text-lead-name-${lead.placeId}`}>
                          {lead.name}
                        </h3>
                        {lead.rating && (
                          <div className="flex items-center gap-1 mt-1">
                            <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                            <span className="text-sm text-gray-600">
                              {lead.rating.toFixed(1)}
                              {lead.userRatingsTotal && (
                                <span className="text-gray-400 ml-1">({lead.userRatingsTotal})</span>
                              )}
                            </span>
                          </div>
                        )}
                      </div>
                      {lead.openNow !== undefined && (
                        <Badge variant={lead.openNow ? "default" : "secondary"} className="text-xs">
                          {lead.openNow ? "Aberto" : "Fechado"}
                        </Badge>
                      )}
                    </div>
                    
                    <div className="space-y-2 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <span className="line-clamp-2">{lead.address}</span>
                      </div>
                      
                      {lead.phone && (
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4" />
                          <span>{lead.phone}</span>
                        </div>
                      )}
                      
                      {lead.website && (
                        <div className="flex items-center gap-2">
                          <Globe className="w-4 h-4" />
                          <a 
                            href={lead.website} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline truncate max-w-[200px]"
                          >
                            {lead.website.replace(/https?:\/\/(www\.)?/, "").split("/")[0]}
                          </a>
                        </div>
                      )}
                    </div>
                    
                    {lead.types && lead.types.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {lead.types.slice(0, 3).map((type) => (
                          <Badge key={type} variant="outline" className="text-xs">
                            {type.replace(/_/g, " ")}
                          </Badge>
                        ))}
                      </div>
                    )}
                    
                    <div className="flex gap-2 pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => saveLeadMutation.mutate(lead)}
                        disabled={saveLeadMutation.isPending}
                        data-testid={`button-salvar-${lead.placeId}`}
                      >
                        <UserPlus className="w-4 h-4 mr-1" />
                        Salvar
                      </Button>
                      
                      {lead.phone && (
                        <Button
                          size="sm"
                          className="bg-green-600 hover:bg-green-700"
                          onClick={() => handleOpenChatCenter(lead.phone!)}
                          data-testid={`button-whatsapp-${lead.placeId}`}
                        >
                          <MessageCircle className="w-4 h-4 mr-1" />
                          WhatsApp
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {!searchMutation.isPending && leads.length === 0 && regiao && (
          <Card>
            <CardContent className="py-12 text-center">
              <Building2 className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhum lead encontrado</h3>
              <p className="text-gray-500">
                Tente ajustar os filtros ou buscar em outra região
              </p>
            </CardContent>
          </Card>
        )}

        {!regiao && leads.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <Target className="w-12 h-12 text-blue-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Comece sua prospecção</h3>
              <p className="text-gray-500">
                Digite uma região acima para buscar potenciais clientes
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
