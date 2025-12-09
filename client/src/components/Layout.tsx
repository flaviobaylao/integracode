import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ChevronDown, ChevronRight, Menu } from "lucide-react";
import { useState, useEffect } from "react";
import { useQuery } from "@/lib/queryClient";
import { useLocation } from "wouter";
import type { User } from "@shared/schema";
import UserProfileModal from "./UserProfileModal";
import { VersionDisplay } from "./VersionDisplay";
import integraLogo from "@assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png";
import { useToast } from "@/hooks/use-toast";

interface LayoutProps {
  children: React.ReactNode;
  activeView: string;
  setActiveView: (view: string) => void;
  user?: User;
}

export default function Layout({ children, activeView, setActiveView, user }: LayoutProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const canAccessReports = user?.role && ['admin', 'coordinator', 'administrative'].includes(user.role);
  const canAccessUsers = user?.role === 'admin';
  const isVendedor = user?.role === 'vendedor';
  const isTelemarketing = user?.role === 'telemarketing';
  const isMotorista = user?.role === 'motorista';
  const [orderStepsOpen, setOrderStepsOpen] = useState(false);
  const [deliveryMenuOpen, setDeliveryMenuOpen] = useState(false);
  const [telemarketingMenuOpen, setTelemarketingMenuOpen] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleSessionExpired = (event: CustomEvent) => {
      toast({
        title: "Sessão Expirada",
        description: event.detail.message || "Sua sessão expirou. Redirecionando para login...",
        variant: "destructive",
      });
    };

    window.addEventListener('session-expired', handleSessionExpired as EventListener);
    return () => {
      window.removeEventListener('session-expired', handleSessionExpired as EventListener);
    };
  }, [toast]);

  // Buscar contagem de pedidos bloqueados (atualiza a cada 30 segundos)
  const { data: blockedOrdersData } = useQuery<any[]>({
    queryKey: ['/api/blocked-orders'],
    enabled: canAccessReports || isVendedor,
    refetchInterval: 30000,
  });
  const blockedOrdersCount = blockedOrdersData?.filter(order => order.status === 'blocked').length || 0;

  // Buscar contagem de pedidos do hotsite (atualiza a cada 30 segundos)
  const { data: hotsiteOrdersData } = useQuery<{ orders: any[] }>({
    queryKey: ['/api/hotsite-orders'],
    enabled: canAccessReports,
    refetchInterval: 30000,
  });
  const hotsiteOrdersCount = hotsiteOrdersData?.orders?.length || 0;

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: 'fas fa-tachometer-alt', available: true, badge: null },
    { 
      id: 'sales-cards', 
      label: user?.role === 'vendedor' ? 'Meus Cards de Venda' : 'Cards de Venda',
      icon: 'fas fa-clipboard-list', 
      available: true,
      badge: null
    },
    { id: 'sales-schedule', label: 'Agenda de Vendas', icon: 'fas fa-calendar-week', available: true, badge: null },
    { id: 'visit-routes', label: 'Rota de Visitas', icon: 'fas fa-route', available: true, badge: null },
    { 
      id: 'rota-do-dia', 
      label: isVendedor ? 'Minha Rota do Dia' : 'Rota do Dia', 
      icon: 'fas fa-map-marked-alt', 
      available: isVendedor || canAccessReports,
      badge: null
    },
    { 
      id: 'rota-entrega', 
      label: 'Minhas Entregas', 
      icon: 'fas fa-truck', 
      available: isMotorista,
      badge: null
    },
    { 
      id: 'customers', 
      label: user?.role === 'vendedor' ? 'Minha Carteira' : 'Clientes',
      icon: 'fas fa-users', 
      available: true,
      badge: null
    },
    { 
      id: 'clientes-ativos', 
      label: 'Clientes Ativos',
      icon: 'fas fa-check-circle', 
      available: !isMotorista,
      badge: null
    },
    { 
      id: 'clientes-virtuais-hoje', 
      label: 'Clientes Virtuais do Dia',
      icon: 'fas fa-phone', 
      available: !isMotorista,
      badge: null
    },
    { 
      id: 'leads', 
      label: 'LEADs',
      icon: 'fas fa-crosshairs', 
      available: true,
      badge: null
    },
    { id: 'sellers', label: 'Vendedores', icon: 'fas fa-user-tie', available: canAccessReports, badge: null },
    { 
      id: 'sales-goals', 
      label: user?.role === 'vendedor' ? 'Minhas Metas' : 'Metas de Vendas',
      icon: 'fas fa-bullseye', 
      available: true,
      badge: null
    },
    { id: 'products', label: 'Produtos', icon: 'fas fa-box', available: canAccessReports, badge: null },
    { id: 'hotsite-pricing', label: 'Tabela de Preços Hotsite', icon: 'fas fa-tags', available: canAccessReports, badge: null },
    { 
      id: 'hotsite-orders', 
      label: 'Pedidos do Site', 
      icon: 'fas fa-shopping-bag', 
      available: canAccessReports,
      badge: hotsiteOrdersCount > 0 ? hotsiteOrdersCount : null
    },
    { 
      id: 'billings', 
      label: isVendedor ? 'Meus Faturamentos' : 'Faturamentos', 
      icon: 'fas fa-file-invoice-dollar', 
      available: canAccessReports || isVendedor,
      badge: null
    },
    { 
      id: 'overdue-debts', 
      label: isVendedor ? 'Meus Débitos Vencidos' : 'Débitos Vencidos', 
      icon: 'fas fa-exclamation-triangle', 
      available: canAccessReports || isVendedor,
      badge: null
    },
    { 
      id: 'blocked-orders', 
      label: isVendedor ? 'Meus Pedidos Bloqueados' : 'Pedidos Bloqueados', 
      icon: 'fas fa-ban', 
      available: canAccessReports || isVendedor,
      badge: blockedOrdersCount > 0 ? blockedOrdersCount : null
    },
    { 
      id: 'check-in-audit', 
      label: isVendedor ? 'Meus Check-ins' : 'Auditoria de Check-ins', 
      icon: 'fas fa-clipboard-check', 
      available: true,
      badge: null
    },
    { id: 'omie', label: 'Integração Omie', icon: 'fas fa-link', available: canAccessReports, badge: null },
    { 
      id: 'rh', 
      label: isVendedor ? 'Minhas Métricas' : 'RH', 
      icon: 'fas fa-briefcase', 
      available: true,
      badge: null
    },
    { id: 'users', label: 'Usuários', icon: 'fas fa-user-cog', available: canAccessUsers, badge: null },
    { id: 'validacao-rotas', label: 'Validação de Rotas', icon: 'fas fa-check-double', available: user?.role && ['admin', 'coordinator'].includes(user.role), badge: null },
    { id: 'whatsapp', label: 'WhatsApp', icon: 'fab fa-whatsapp', available: canAccessReports || isTelemarketing, badge: null },
    { id: 'telemarketing', label: 'Central de Telemarketing', icon: 'fas fa-comments', available: canAccessReports, badge: null },
    { id: 'locations', label: 'Localizações', icon: 'fas fa-map-marker-alt', available: canAccessReports, badge: null },
  ];

  const deliveryMenuItems = [
    { id: 'delivery-dashboard', label: 'Dashboard de Entregas', icon: 'fas fa-tachometer-alt' },
    { id: 'delivery-management', label: 'Gestão de Entregas', icon: 'fas fa-shipping-fast' },
    { id: 'delivery-routes', label: 'Resumo das Rotas', icon: 'fas fa-route' },
    { id: 'mapa-clientes', label: 'Mapa de Clientes', icon: 'fas fa-map-marked-alt' },
    { id: 'driver-management', label: 'Motoristas', icon: 'fas fa-user-tie' },
    { id: 'delivery-reports', label: 'Relatórios de Entregas', icon: 'fas fa-chart-line' },
  ];

  const telemarketingMenuItems = [
    { id: 'telemarketing-dashboard', label: 'Central de Atendimento', icon: 'fas fa-comments' },
    { id: 'telemarketing-analysis', label: 'Dashboard de Conversas', icon: 'fas fa-chart-bar' },
    { id: 'telemarketing-whatsapp', label: 'Templates Rápidos', icon: 'fab fa-whatsapp' },
    { id: 'telemarketing-telegram', label: 'Análises', icon: 'fab fa-telegram' },
    { id: 'telemarketing-deliveries', label: 'Entregas Chat', icon: 'fas fa-truck' },
  ];

  const orderStepsItems = [
    { id: 'order-sale', label: 'Pedido de Venda', icon: 'fas fa-shopping-cart' },
    { id: 'order-billing', label: 'Faturar', icon: 'fas fa-file-invoice' },
    { id: 'order-billed', label: 'Faturado', icon: 'fas fa-check-circle' },
    { id: 'order-awaiting-route', label: 'Aguardando Rota', icon: 'fas fa-clock' },
    { id: 'order-in-route', label: 'Em Rota', icon: 'fas fa-truck' },
  ];

  const getRoleLabel = (role: string) => {
    const roleLabels = {
      admin: 'Administrador',
      coordinator: 'Coordenador',
      administrative: 'Administrativo',
      vendedor: 'Vendedor',
      telemarketing: 'Telemarketing',
      motorista: 'Motorista',
    };
    return roleLabels[role as keyof typeof roleLabels] || role;
  };

  const handleMenuItemClick = (itemId: string) => {
    console.log('🖱️ Menu item clicado:', itemId);
    
    // Mapeamento específico para itens de telemarketing
    const telemarketingRoutes: Record<string, string> = {
      'telemarketing': '/telemarketing',
      'telemarketing-dashboard': '/telemarketing/atendimento',
      'telemarketing-whatsapp': '/telemarketing/templates',
      'telemarketing-telegram': '/telemarketing/analysis',
      'telemarketing-deliveries': '/telemarketing/analysis',
      'telemarketing-analysis': '/telemarketing/conversas',
    };
    
    if (telemarketingRoutes[itemId]) {
      console.log('🔗 Navegando para rota de telemarketing:', telemarketingRoutes[itemId]);
      navigate(telemarketingRoutes[itemId]);
      setMobileMenuOpen(false);
      return;
    }
    
    // Rotas que têm páginas próprias devem navegar diretamente
    const routePages = ['sales-schedule', 'billings', 'sales-goals', 'blocked-orders', 'overdue-debts', 'visit-routes', 'rota-do-dia', 'rota-entrega', 'routes-management', 'delivery-routes', 'mapa-clientes', 'clientes-ativos', 'clientes-virtuais-hoje', 'check-in-photos', 'check-in-audit', 'rh', 'hotsite-pricing', 'hotsite-orders', 'leads', 'whatsapp', 'telemarketing', 'validacao-rotas'];
    
    if (routePages.includes(itemId)) {
      // Navega para a rota correspondente
      const route = '/' + itemId.replace(/_/g, '-');
      console.log('🔗 Navegando para rota:', route);
      navigate(route);
    } else {
      console.log('📋 Mudando activeView para:', itemId);
      setActiveView(itemId);
    }
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200 px-4 md:px-6 py-4 flex items-center justify-between">
        {/* Mobile Menu Button */}
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="sm" className="md:hidden" data-testid="button-mobile-menu">
              <Menu className="h-6 w-6" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <div className="h-full flex flex-col">
              <div className="p-4 flex-1 overflow-y-auto">
                {/* User Info */}
                <div className="flex items-center space-x-3 pb-4 border-b border-gray-200">
                <Avatar>
                  <AvatarImage src={user?.profileImageUrl || ''} />
                  <AvatarFallback>
                    <i className="fas fa-user text-gray-600"></i>
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium text-gray-800">
                    {user?.firstName} {user?.lastName}
                  </p>
                  <p className="text-xs text-gray-600">
                    {user?.role && getRoleLabel(user.role)}
                  </p>
                </div>
              </div>

              {/* Menu Items */}
              <ul className="space-y-2 mt-4">
                {menuItems
                  .filter(item => item.available)
                  .filter(item => !isMotorista || item.id === 'rota-entrega')
                  .filter(item => !isTelemarketing || ['dashboard', 'sales-cards', 'sales-schedule', 'visit-routes', 'customers', 'whatsapp'].includes(item.id))
                  .map(item => (
                    <li key={item.id}>
                      <Button
                        variant="ghost"
                        className={`w-full justify-start space-x-3 ${
                          activeView === item.id
                            ? 'text-honest-blue bg-blue-50'
                            : 'text-gray-700 hover:bg-gray-100'
                        }`}
                        onClick={() => handleMenuItemClick(item.id)}
                        data-testid={`menu-${item.id}`}
                      >
                        <i className={item.icon}></i>
                        <span className="font-medium">{item.label}</span>
                        {item.badge && item.badge > 0 && (
                          <Badge className="ml-auto bg-red-500 text-white text-xs">
                            {item.badge}
                          </Badge>
                        )}
                      </Button>
                    </li>
                  ))}
                
                {/* Menu Sistema de Entregas */}
                {(canAccessReports || isVendedor) && !isMotorista && !isTelemarketing && (
                  <li>
                    <Collapsible open={deliveryMenuOpen} onOpenChange={setDeliveryMenuOpen}>
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          className="w-full justify-start space-x-3 text-gray-700 hover:bg-gray-100"
                        >
                          <i className="fas fa-truck"></i>
                          <span className="font-medium">{isVendedor ? 'Minhas Entregas' : 'Sistema de Entregas'}</span>
                          {deliveryMenuOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="ml-4 mt-2 space-y-1">
                        {deliveryMenuItems
                          .filter(item => canAccessReports || (isVendedor && ['delivery-dashboard', 'delivery-management'].includes(item.id)))
                          .map(item => (
                          <Button
                            key={item.id}
                            variant="ghost"
                            className={`w-full justify-start space-x-3 text-sm ${
                              activeView === item.id
                                ? 'text-honest-blue bg-blue-50'
                                : 'text-gray-600 hover:bg-gray-50'
                            }`}
                            onClick={() => handleMenuItemClick(item.id)}
                            data-testid={`menu-${item.id}`}
                          >
                            <i className={item.icon}></i>
                            <span>{item.label}</span>
                          </Button>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                )}

                {/* Menu Central de Telemarketing */}
                {canAccessReports && !isMotorista && !isTelemarketing && (
                  <li>
                    <Collapsible open={telemarketingMenuOpen} onOpenChange={setTelemarketingMenuOpen}>
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          className="w-full justify-start space-x-3 text-gray-700 hover:bg-gray-100"
                          data-testid="menu-telemarketing-hub"
                        >
                          <i className="fas fa-phone"></i>
                          <span className="font-medium">Central de Telemarketing</span>
                          {telemarketingMenuOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="ml-4 mt-2 space-y-1">
                        {telemarketingMenuItems.map(item => (
                          <Button
                            key={item.id}
                            variant="ghost"
                            className={`w-full justify-start space-x-3 text-sm ${
                              activeView === item.id
                                ? 'text-honest-blue bg-blue-50'
                                : 'text-gray-600 hover:bg-gray-50'
                            }`}
                            onClick={() => handleMenuItemClick(item.id)}
                            data-testid={`menu-${item.id}`}
                          >
                            <i className={item.icon}></i>
                            <span>{item.label}</span>
                          </Button>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                )}

                {/* Menu Etapas dos Pedidos */}
                {canAccessReports && (
                  <li>
                    <Collapsible open={orderStepsOpen} onOpenChange={setOrderStepsOpen}>
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          className="w-full justify-start space-x-3 text-gray-700 hover:bg-gray-100"
                        >
                          <i className="fas fa-list-ol"></i>
                          <span className="font-medium">Etapas dos Pedidos</span>
                          {orderStepsOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="ml-4 mt-2 space-y-1">
                        {orderStepsItems.map(item => (
                          <Button
                            key={item.id}
                            variant="ghost"
                            className={`w-full justify-start space-x-3 text-sm ${
                              activeView === item.id
                                ? 'text-honest-blue bg-blue-50'
                                : 'text-gray-600 hover:bg-gray-50'
                            }`}
                            onClick={() => handleMenuItemClick(item.id)}
                            data-testid={`menu-${item.id}`}
                          >
                            <i className={item.icon}></i>
                            <span>{item.label}</span>
                          </Button>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                )}
              </ul>
              </div>
              
              {/* Versão do Sistema - Rodapé do Menu Mobile */}
              <div className="p-4 border-t border-gray-200 flex-shrink-0">
                <VersionDisplay />
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <div className="flex items-center space-x-4">
          <img 
            src={integraLogo} 
            alt="Honest Sucos - Sistema Integra" 
            className="w-10 h-10"
          />
          <div>
            <h1 className="text-lg md:text-xl font-bold text-gray-800">Sistema Integra</h1>
            {user?.route && (
              <p className="text-xs md:text-sm text-gray-600">Rota: {user.route}</p>
            )}
          </div>
        </div>
        
        <div className="flex items-center space-x-4">
          {/* User Menu */}
          <div className="flex items-center space-x-3">
            <div className="text-right">
              <p className="text-sm font-medium text-gray-800">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-xs text-gray-600">
                {user?.role && getRoleLabel(user.role)}
              </p>
            </div>
            <Avatar>
              <AvatarImage src={user?.profileImageUrl || ''} />
              <AvatarFallback>
                <i className="fas fa-user text-gray-600"></i>
              </AvatarFallback>
            </Avatar>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowProfileModal(true)}
              title="Meu Perfil"
            >
              <i className="fas fa-cog text-gray-600"></i>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.location.href = '/api/logout'}
              title="Sair"
            >
              <i className="fas fa-sign-out-alt text-gray-600"></i>
            </Button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar Navigation - Hidden on mobile */}
        <nav className="hidden md:block w-64 bg-white shadow-sm h-screen sticky top-0 border-r border-gray-200 flex flex-col">
          <div className="p-4 flex-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 80px)' }}>
            <ul className="space-y-2">
              {menuItems
                .filter(item => item.available)
                .filter(item => !isMotorista || item.id === 'rota-entrega')
                .filter(item => !isTelemarketing || ['dashboard', 'sales-cards', 'sales-schedule', 'visit-routes', 'customers', 'whatsapp'].includes(item.id))
                .map(item => (
                  <li key={item.id}>
                    <Button
                      variant="ghost"
                      className={`w-full justify-start space-x-3 ${
                        activeView === item.id
                          ? 'text-honest-blue bg-blue-50'
                          : 'text-gray-700 hover:bg-gray-100'
                      }`}
                      onClick={() => handleMenuItemClick(item.id)}
                      data-testid={`menu-${item.id}`}
                    >
                      <i className={item.icon}></i>
                      <span className="font-medium">{item.label}</span>
                    </Button>
                  </li>
                ))}
              
              {/* Menu Sistema de Entregas */}
              {(canAccessReports || isVendedor) && !isMotorista && !isTelemarketing && (
                <li>
                  <Collapsible open={deliveryMenuOpen} onOpenChange={setDeliveryMenuOpen}>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        className="w-full justify-start space-x-3 text-gray-700 hover:bg-gray-100"
                      >
                        <i className="fas fa-truck"></i>
                        <span className="font-medium">{isVendedor ? 'Minhas Entregas' : 'Sistema de Entregas'}</span>
                        {deliveryMenuOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="ml-4 mt-2 space-y-1">
                      {deliveryMenuItems
                        .filter(item => canAccessReports || (isVendedor && ['delivery-dashboard', 'delivery-management'].includes(item.id)))
                        .map(item => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          className={`w-full justify-start space-x-3 text-sm ${
                            activeView === item.id
                              ? 'text-honest-blue bg-blue-50'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                          onClick={() => handleMenuItemClick(item.id)}
                          data-testid={`menu-${item.id}`}
                        >
                          <i className={item.icon}></i>
                          <span>{item.label}</span>
                        </Button>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              )}

              {/* Menu Central de Telemarketing - Desktop */}
              {canAccessReports && !isMotorista && !isTelemarketing && (
                <li>
                  <Collapsible open={telemarketingMenuOpen} onOpenChange={setTelemarketingMenuOpen}>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        className="w-full justify-start space-x-3 text-gray-700 hover:bg-gray-100"
                        data-testid="menu-telemarketing-desktop"
                      >
                        <i className="fas fa-phone"></i>
                        <span className="font-medium">Central de Telemarketing</span>
                        {telemarketingMenuOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="ml-4 mt-2 space-y-1">
                      {telemarketingMenuItems.map(item => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          className={`w-full justify-start space-x-3 text-sm ${
                            activeView === item.id
                              ? 'text-honest-blue bg-blue-50'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                          onClick={() => handleMenuItemClick(item.id)}
                          data-testid={`menu-${item.id}`}
                        >
                          <i className={item.icon}></i>
                          <span>{item.label}</span>
                        </Button>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              )}

              {/* Menu Etapas dos Pedidos */}
              {canAccessReports && !isMotorista && !isTelemarketing && (
                <li>
                  <Collapsible open={orderStepsOpen} onOpenChange={setOrderStepsOpen}>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        className="w-full justify-start space-x-3 text-gray-700 hover:bg-gray-100"
                      >
                        <i className="fas fa-list-ol"></i>
                        <span className="font-medium">Etapas dos Pedidos</span>
                        {orderStepsOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="ml-4 mt-2 space-y-1">
                      {orderStepsItems.map(item => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          className={`w-full justify-start space-x-3 text-sm ${
                            activeView === item.id
                              ? 'text-honest-blue bg-blue-50'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                          onClick={() => handleMenuItemClick(item.id)}
                          data-testid={`menu-${item.id}`}
                        >
                          <i className={item.icon}></i>
                          <span>{item.label}</span>
                        </Button>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              )}
            </ul>
          </div>
          
          {/* Versão do Sistema - Rodapé do Sidebar Desktop */}
          <div className="p-4 border-t border-gray-200">
            <VersionDisplay />
          </div>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>

      {/* User Profile Modal */}
      {showProfileModal && user && (
        <UserProfileModal
          isOpen={showProfileModal}
          onClose={() => setShowProfileModal(false)}
          user={user}
        />
      )}
    </div>
  );
}
