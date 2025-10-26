import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ChevronDown, ChevronRight, Menu } from "lucide-react";
import { useState } from "react";
import type { User } from "@shared/schema";
import UserProfileModal from "./UserProfileModal";
import { VersionDisplay } from "./VersionDisplay";
import integraLogo from "@assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png";

interface LayoutProps {
  children: React.ReactNode;
  activeView: string;
  setActiveView: (view: string) => void;
  user?: User;
}

export default function Layout({ children, activeView, setActiveView, user }: LayoutProps) {
  const canAccessReports = user?.role && ['admin', 'coordinator', 'administrative'].includes(user.role);
  const canAccessUsers = user?.role === 'admin';
  const isVendedor = user?.role === 'vendedor';
  const isTelemarketing = user?.role === 'telemarketing';
  const [orderStepsOpen, setOrderStepsOpen] = useState(false);
  const [deliveryMenuOpen, setDeliveryMenuOpen] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: 'fas fa-tachometer-alt', available: true },
    { 
      id: 'sales-cards', 
      label: user?.role === 'vendedor' ? 'Meus Cards de Venda' : 'Cards de Venda',
      icon: 'fas fa-clipboard-list', 
      available: true 
    },
    { id: 'sales-schedule', label: 'Agenda de Vendas', icon: 'fas fa-calendar-week', available: true },
    { id: 'visit-routes', label: 'Rota de Visitas', icon: 'fas fa-route', available: true },
    { 
      id: 'daily-route', 
      label: isVendedor ? 'Minha Rota do Dia' : 'Rotas dos Vendedores', 
      icon: 'fas fa-map-marked-alt', 
      available: isVendedor || canAccessReports 
    },
    { id: 'routes-management', label: 'Gerenciar Rotas', icon: 'fas fa-map-marked-alt', available: canAccessReports },
    { 
      id: 'customers', 
      label: user?.role === 'vendedor' ? 'Minha Carteira' : 'Clientes',
      icon: 'fas fa-users', 
      available: true 
    },
    { id: 'sellers', label: 'Vendedores', icon: 'fas fa-user-tie', available: canAccessReports },
    { 
      id: 'sales-goals', 
      label: user?.role === 'vendedor' ? 'Minhas Metas' : 'Metas de Vendas',
      icon: 'fas fa-bullseye', 
      available: true 
    },
    { id: 'telemarketing', label: 'Telemarketing', icon: 'fas fa-phone', available: canAccessReports },
    { id: 'products', label: 'Produtos', icon: 'fas fa-box', available: canAccessReports },
    { 
      id: 'billings', 
      label: isVendedor ? 'Meus Faturamentos' : 'Faturamentos', 
      icon: 'fas fa-file-invoice-dollar', 
      available: canAccessReports || isVendedor 
    },
    { 
      id: 'contas-receber', 
      label: 'Contas a Receber', 
      icon: 'fas fa-money-bill-wave', 
      available: canAccessReports 
    },
    { 
      id: 'overdue-debts', 
      label: isVendedor ? 'Meus Débitos Vencidos' : 'Débitos Vencidos', 
      icon: 'fas fa-exclamation-triangle', 
      available: canAccessReports || isVendedor 
    },
    { 
      id: 'blocked-orders', 
      label: isVendedor ? 'Meus Pedidos Bloqueados' : 'Pedidos Bloqueados', 
      icon: 'fas fa-ban', 
      available: canAccessReports || isVendedor 
    },
    { id: 'omie', label: 'Integração Omie', icon: 'fas fa-link', available: canAccessReports },
    { id: 'reports', label: 'Relatórios', icon: 'fas fa-chart-bar', available: canAccessReports },
    { id: 'users', label: 'Usuários', icon: 'fas fa-user-cog', available: canAccessUsers },
    { id: 'whatsapp', label: 'WhatsApp', icon: 'fab fa-whatsapp', available: canAccessReports },
    { id: 'locations', label: 'Localizações', icon: 'fas fa-map-marker-alt', available: canAccessReports },
  ];

  const deliveryMenuItems = [
    { id: 'delivery-dashboard', label: 'Dashboard de Entregas', icon: 'fas fa-tachometer-alt' },
    { id: 'delivery-management', label: 'Gestão de Entregas', icon: 'fas fa-shipping-fast' },
    { id: 'driver-management', label: 'Motoristas', icon: 'fas fa-user-tie' },
    { id: 'delivery-reports', label: 'Relatórios de Entregas', icon: 'fas fa-chart-line' },
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
    };
    return roleLabels[role as keyof typeof roleLabels] || role;
  };

  const handleMenuItemClick = (itemId: string) => {
    // Rotas que têm páginas próprias devem navegar diretamente
    const routePages = ['sales-schedule', 'billings', 'sales-goals', 'blocked-orders', 'contas-receber', 'overdue-debts', 'visit-routes', 'daily-route', 'routes-management'];
    
    if (routePages.includes(itemId)) {
      // Navega para a rota correspondente
      const route = '/' + itemId.replace(/_/g, '-');
      window.location.href = route;
    } else {
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
          <SheetContent side="left" className="w-72 p-0 overflow-y-auto">
            <div className="p-4">
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
                {(canAccessReports || isVendedor) && (
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
              
              {/* Versão do Sistema - Rodapé do Menu Mobile */}
              <div className="mt-6 pt-4 border-t border-gray-200">
                <div className="px-2">
                  <VersionDisplay />
                </div>
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
          {/* Notifications */}
          <Button variant="ghost" size="sm" className="relative">
            <i className="fas fa-bell text-lg"></i>
            <Badge className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
              3
            </Badge>
          </Button>
          
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
        <nav className="hidden md:block w-64 bg-white shadow-sm h-screen sticky top-0 border-r border-gray-200">
          <div className="p-4">
            <ul className="space-y-2">
              {menuItems
                .filter(item => item.available)
                .map(item => (
                  <li key={item.id}>
                    <Button
                      variant="ghost"
                      className={`w-full justify-start space-x-3 ${
                        activeView === item.id
                          ? 'text-honest-blue bg-blue-50'
                          : 'text-gray-700 hover:bg-gray-100'
                      }`}
                      onClick={() => setActiveView(item.id)}
                    >
                      <i className={item.icon}></i>
                      <span className="font-medium">{item.label}</span>
                    </Button>
                  </li>
                ))}
              
              {/* Menu Sistema de Entregas */}
              {(canAccessReports || isVendedor) && (
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
                          onClick={() => setActiveView(item.id)}
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
                          onClick={() => setActiveView(item.id)}
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
            
            {/* Versão do Sistema - Rodapé do Sidebar Desktop */}
            <div className="absolute bottom-4 left-0 right-0 px-4">
              <div className="pt-4 border-t border-gray-200">
                <VersionDisplay />
              </div>
            </div>
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
