import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Customer, SalesCardWithRelations } from "@shared/schema";
import { 
  User, 
  Phone, 
  Mail, 
  MapPin, 
  Building2, 
  Calendar, 
  Navigation,
  MessageSquare,
  Package,
  DollarSign,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  History
} from "lucide-react";
import { getVendorColor, getVendorInitials } from "@/lib/vendorColors";

interface CustomerDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer | null;
}

export default function CustomerDetailsModal({ isOpen, onClose, customer }: CustomerDetailsModalProps) {
  const { data: salesHistory } = useQuery({
    queryKey: ['/api/sales-cards', 'customer', customer?.id],
    enabled: !!customer?.id,
  });

  const openWhatsApp = (phone: string, customerName: string) => {
    const message = encodeURIComponent(
      `Olá ${customerName}! Somos da Honest Sucos. Como está tudo? Gostaria de saber se precisa de algum produto hoje.`
    );
    const whatsappUrl = `https://wa.me/55${phone.replace(/\D/g, '')}?text=${message}`;
    window.open(whatsappUrl, '_blank');
  };

  const openWaze = (latitude: string, longitude: string) => {
    if (!latitude || !longitude) return;
    const wazeUrl = `https://waze.com/ul?ll=${latitude},${longitude}&navigate=yes&zoom=17`;
    window.open(wazeUrl, '_blank');
  };

  const getWeekdaysLabel = (weekdays: string) => {
    try {
      const days = JSON.parse(weekdays);
      const dayLabels: { [key: string]: string } = {
        'monday': 'Seg',
        'tuesday': 'Ter',
        'wednesday': 'Qua',
        'thursday': 'Qui',
        'friday': 'Sex',
        'saturday': 'Sáb',
        'sunday': 'Dom'
      };
      return days.map((day: string) => dayLabels[day] || day).join(', ');
    } catch {
      return 'Não definido';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return (
          <Badge className="bg-green-100 text-green-800">
            <CheckCircle className="h-3 w-3 mr-1" />
            Concluído
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge className="bg-red-100 text-red-800">
            <XCircle className="h-3 w-3 mr-1" />
            Cancelado
          </Badge>
        );
      case 'in_progress':
        return (
          <Badge className="bg-blue-100 text-blue-800">
            <Clock className="h-3 w-3 mr-1" />
            Em Andamento
          </Badge>
        );
      case 'scheduled':
        return (
          <Badge className="bg-yellow-100 text-yellow-800">
            <Calendar className="h-3 w-3 mr-1" />
            Agendado
          </Badge>
        );
      default:
        return (
          <Badge className="bg-gray-100 text-gray-800">
            <AlertCircle className="h-3 w-3 mr-1" />
            Pendente
          </Badge>
        );
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const formatDate = (date: string | null) => {
    if (!date) return 'Não informado';
    return new Date(date).toLocaleDateString('pt-BR');
  };

  const formatDateTime = (date: string) => {
    return new Date(date).toLocaleString('pt-BR');
  };

  if (!customer) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <User className="h-5 w-5 text-blue-600" />
            <span>Detalhes do Cliente</span>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[75vh]">
          <Tabs defaultValue="info" className="space-y-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">Informações</TabsTrigger>
              <TabsTrigger value="history">Histórico de Vendas</TabsTrigger>
            </TabsList>

            <TabsContent value="info" className="space-y-4">
              {/* Informações Básicas */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <User className="h-5 w-5 text-blue-600" />
                    <span>Informações Básicas</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Nome / Razão Social</p>
                      <p className="font-semibold text-lg">{customer.name}</p>
                    </div>
                    {(customer as any).fantasyName && (
                      <div>
                        <p className="text-sm text-gray-600">Nome Fantasia</p>
                        <p className="font-medium">{(customer as any).fantasyName}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-sm text-gray-600">Tipo</p>
                      <Badge variant="outline" className="capitalize">
                        {(customer as any).customerType === 'pessoa_fisica' ? 'Pessoa Física' : 'Pessoa Jurídica'}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Documento</p>
                      <p className="font-mono">{(customer as any).cpf || (customer as any).cnpj || 'Não informado'}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Informações de Contato */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Phone className="h-5 w-5 text-green-600" />
                    <span>Contato</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Phone className="h-4 w-4 text-gray-500" />
                      <span>{customer.phone}</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openWhatsApp(customer.phone, customer.name)}
                      className="text-green-600 hover:text-green-700"
                    >
                      <MessageSquare className="h-4 w-4 mr-1" />
                      WhatsApp
                    </Button>
                  </div>
                  
                  {customer.email && (
                    <div className="flex items-center space-x-2">
                      <Mail className="h-4 w-4 text-gray-500" />
                      <span>{customer.email}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Localização */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <MapPin className="h-5 w-5 text-red-600" />
                    <span>Localização</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-sm text-gray-600">Endereço</p>
                    <p className="text-gray-800">{customer.address}</p>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {(customer as any).city && (
                      <div>
                        <p className="text-sm text-gray-600">Cidade</p>
                        <p className="font-medium">{(customer as any).city}</p>
                      </div>
                    )}
                    {(customer as any).state && (
                      <div>
                        <p className="text-sm text-gray-600">Estado</p>
                        <p className="font-medium">{(customer as any).state}</p>
                      </div>
                    )}
                    {(customer as any).zipCode && (
                      <div>
                        <p className="text-sm text-gray-600">CEP</p>
                        <p className="font-mono">{(customer as any).zipCode}</p>
                      </div>
                    )}
                  </div>

                  {(customer as any).latitude && (customer as any).longitude && (
                    <div className="space-y-2">
                      <p className="text-sm text-gray-600">Coordenadas GPS</p>
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-sm space-y-1">
                          <div>Lat: {parseFloat((customer as any).latitude).toFixed(6)}</div>
                          <div>Lng: {parseFloat((customer as any).longitude).toFixed(6)}</div>
                          {(customer as any).coordinatesLocked && (
                            <Badge variant="secondary" className="bg-red-100 text-red-800 text-xs">
                              Coordenadas Travadas
                            </Badge>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openWaze((customer as any).latitude, (customer as any).longitude)}
                          className="text-blue-600 hover:text-blue-700"
                        >
                          <Navigation className="h-4 w-4 mr-1" />
                          Waze
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Informações de Venda */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Building2 className="h-5 w-5 text-purple-600" />
                    <span>Informações Comerciais</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Dias de Visita</p>
                      <p className="font-medium">{getWeekdaysLabel(customer.weekdays)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Status</p>
                      <Badge className={customer.isActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                        {customer.isActive ? 'Ativo' : 'Inativo'}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Última Venda</p>
                      <div className="space-y-1">
                        <p className="font-medium">{formatDate(customer.lastSaleDate)}</p>
                        {customer.lastSaleValue && (
                          <p className="text-sm text-green-600 font-medium">
                            {formatCurrency(parseFloat(customer.lastSaleValue))}
                          </p>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Vendedor Responsável</p>
                      <div className="flex items-center space-x-3 mt-1">
                        {(customer as any).sellerId && (customer as any).seller && (
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold text-xs ${getVendorColor((customer as any).sellerId)}`}>
                            {getVendorInitials(`${(customer as any).seller?.firstName} ${(customer as any).seller?.lastName}`)}
                          </div>
                        )}
                        <p className="font-medium">{(customer as any).seller?.firstName} {(customer as any).seller?.lastName}</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <History className="h-5 w-5 text-orange-600" />
                    <span>Histórico de Atendimentos</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {salesHistory && salesHistory.length > 0 ? (
                    <div className="space-y-4">
                      {salesHistory.map((card: SalesCardWithRelations) => (
                        <div key={card.id} className="border rounded-lg p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-medium text-gray-900">
                                Card de Venda #{card.id.slice(-6)}
                              </p>
                              <p className="text-sm text-gray-600">
                                {formatDateTime(card.scheduledDate)}
                              </p>
                            </div>
                            {getStatusBadge(card.status)}
                          </div>

                          {card.saleValue && (
                            <div className="flex items-center space-x-2">
                              <DollarSign className="h-4 w-4 text-green-600" />
                              <span className="font-semibold text-green-600">
                                {formatCurrency(parseFloat(card.saleValue))}
                              </span>
                            </div>
                          )}

                          {card.rejectionReason && (
                            <div className="bg-red-50 p-3 rounded">
                              <p className="text-sm text-red-800">
                                <strong>Motivo da recusa:</strong> {card.rejectionReason}
                              </p>
                            </div>
                          )}

                          {card.notes && (
                            <div className="bg-gray-50 p-3 rounded">
                              <p className="text-sm text-gray-700">
                                <strong>Observações:</strong> {card.notes}
                              </p>
                            </div>
                          )}

                          {card.products && card.products.length > 0 && (
                            <div className="border-t pt-3 mt-3">
                              <p className="text-sm font-medium text-gray-700 mb-2">Produtos:</p>
                              <div className="space-y-1">
                                {card.products.map((product: any, index: number) => (
                                  <div key={index} className="flex items-center justify-between text-sm">
                                    <span>{product.name} (x{product.quantity})</span>
                                    <span className="font-medium">
                                      {formatCurrency(product.totalPrice)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <Package className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                      <p className="text-gray-500">Nenhum histórico de vendas encontrado</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}