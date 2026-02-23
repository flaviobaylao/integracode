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
  const canAccessIndustria = user?.role && ['admin', 'industria'].includes(user.role);
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

  type MenuItem = { id: string; label: string; icon: string; available: boolean | string | null | undefined; badge: number | null };
  type MenuGroup = { groupLabel: string; color: string; bgColor: string; textColor: string; icon: string; items: MenuItem[]; subGroups?: { label: string; icon: string; items: MenuItem[]; stateKey: string }[] };

  const menuGroups: MenuGroup[] = [
    {
      groupLabel: 'Geral',
      color: 'bg-slate-500',
      bgColor: 'bg-slate-50',
      textColor: 'text-slate-700',
      icon: 'fas fa-home',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'fas fa-tachometer-alt', available: true, badge: null },
      ],
    },
    {
      groupLabel: 'Vendas',
      color: 'bg-blue-500',
      bgColor: 'bg-blue-50',
      textColor: 'text-blue-700',
      icon: 'fas fa-shopping-cart',
      items: [
        { id: 'sales-cards', label: user?.role === 'vendedor' ? 'Meus Cards de Venda' : 'Cards de Venda', icon: 'fas fa-clipboard-list', available: true, badge: null },
        { id: 'sales-schedule', label: 'Agenda de Vendas', icon: 'fas fa-calendar-week', available: true, badge: null },
        { id: 'sales-goals', label: user?.role === 'vendedor' ? 'Minhas Metas' : 'Metas de Vendas', icon: 'fas fa-bullseye', available: true, badge: null },
        { id: 'sellers', label: 'Vendedores', icon: 'fas fa-user-tie', available: canAccessReports, badge: null },
        { id: 'vendas-digitais', label: 'Vendas Digitais', icon: 'fas fa-chart-line', available: canAccessReports, badge: null },
        { id: 'sdr-digital', label: 'SDR Digital', icon: 'fas fa-search-location', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
      ],
    },
    {
      groupLabel: 'Clientes',
      color: 'bg-emerald-500',
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-700',
      icon: 'fas fa-users',
      items: [
        { id: 'customers', label: user?.role === 'vendedor' ? 'Minha Carteira' : 'Clientes', icon: 'fas fa-users', available: true, badge: null },
        { id: 'clientes-ativos', label: 'Clientes Ativos', icon: 'fas fa-check-circle', available: !isMotorista, badge: null },
        { id: 'clientes-virtuais-hoje', label: 'Clientes Virtuais do Dia', icon: 'fas fa-phone', available: !isMotorista, badge: null },
        { id: 'leads', label: 'LEADs', icon: 'fas fa-crosshairs', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'locations', label: 'Localizações', icon: 'fas fa-map-marker-alt', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Logística',
      color: 'bg-orange-500',
      bgColor: 'bg-orange-50',
      textColor: 'text-orange-700',
      icon: 'fas fa-truck',
      items: [
        { id: 'visit-routes', label: 'Rota de Visitas', icon: 'fas fa-route', available: true, badge: null },
        { id: 'rota-do-dia', label: isVendedor ? 'Minha Rota do Dia' : 'Rota do Dia', icon: 'fas fa-map-marked-alt', available: isVendedor || canAccessReports, badge: null },
        { id: 'rota-entrega', label: 'Minhas Entregas', icon: 'fas fa-truck', available: isMotorista, badge: null },
        { id: 'entregas-do-dia', label: 'Entregas do Dia', icon: 'fas fa-clipboard-list', available: true, badge: null },
        { id: 'validacao-rotas', label: 'Validação de Rotas', icon: 'fas fa-check-double', available: user?.role && ['admin', 'coordinator'].includes(user.role), badge: null },
        { id: 'check-in-audit', label: isVendedor ? 'Meus Check-ins' : 'Auditoria de Check-ins', icon: 'fas fa-clipboard-check', available: true, badge: null },
      ],
      subGroups: [
        {
          label: isVendedor ? 'Minhas Entregas' : 'Sistema de Entregas',
          icon: 'fas fa-shipping-fast',
          stateKey: 'delivery',
          items: [
            { id: 'delivery-dashboard', label: 'Dashboard de Entregas', icon: 'fas fa-tachometer-alt', available: canAccessReports || isVendedor, badge: null },
            { id: 'delivery-management', label: 'Gestão de Entregas', icon: 'fas fa-shipping-fast', available: canAccessReports || isVendedor, badge: null },
            { id: 'delivery-routes', label: 'Resumo das Rotas', icon: 'fas fa-route', available: canAccessReports, badge: null },
            { id: 'mapa-clientes', label: 'Mapa de Clientes', icon: 'fas fa-map-marked-alt', available: canAccessReports, badge: null },
            { id: 'driver-management', label: 'Motoristas', icon: 'fas fa-user-tie', available: canAccessReports, badge: null },
            { id: 'delivery-reports', label: 'Relatórios de Entregas', icon: 'fas fa-chart-line', available: canAccessReports, badge: null },
          ],
        },
      ],
    },
    {
      groupLabel: 'Produtos & Estoque',
      color: 'bg-amber-500',
      bgColor: 'bg-amber-50',
      textColor: 'text-amber-700',
      icon: 'fas fa-box',
      items: [
        { id: 'products', label: 'Produtos', icon: 'fas fa-box', available: canAccessReports, badge: null },
        { id: 'hotsite-pricing', label: 'Tabela de Preços Hotsite', icon: 'fas fa-tags', available: canAccessReports, badge: null },
        { id: 'hotsite-orders', label: 'Pedidos do Site', icon: 'fas fa-shopping-bag', available: canAccessReports || isTelemarketing, badge: hotsiteOrdersCount > 0 ? hotsiteOrdersCount : null },
        { id: 'estoque', label: 'Gestão de Estoque', icon: 'fas fa-boxes', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Faturamento',
      color: 'bg-purple-500',
      bgColor: 'bg-purple-50',
      textColor: 'text-purple-700',
      icon: 'fas fa-file-invoice',
      items: [
        { id: 'billings', label: isVendedor ? 'Meus Faturamentos' : 'Faturamentos', icon: 'fas fa-file-invoice-dollar', available: canAccessReports || isVendedor, badge: null },
        { id: 'fiscal-invoices', label: 'Faturamento NF-e', icon: 'fas fa-file-alt', available: canAccessReports, badge: null },
        { id: 'billing-pipeline', label: 'Pipeline Faturamento', icon: 'fas fa-columns', available: canAccessReports, badge: null },
      ],
      subGroups: [
        {
          label: 'Etapas dos Pedidos',
          icon: 'fas fa-list-ol',
          stateKey: 'orderSteps',
          items: [
            { id: 'order-sale', label: 'Pedido de Venda', icon: 'fas fa-shopping-cart', available: canAccessReports, badge: null },
            { id: 'order-billing', label: 'Faturar', icon: 'fas fa-file-invoice', available: canAccessReports, badge: null },
            { id: 'order-billed', label: 'Faturado', icon: 'fas fa-check-circle', available: canAccessReports, badge: null },
            { id: 'order-awaiting-route', label: 'Aguardando Rota', icon: 'fas fa-clock', available: canAccessReports, badge: null },
            { id: 'order-in-route', label: 'Em Rota', icon: 'fas fa-truck', available: canAccessReports, badge: null },
          ],
        },
      ],
    },
    {
      groupLabel: 'Financeiro',
      color: 'bg-rose-500',
      bgColor: 'bg-rose-50',
      textColor: 'text-rose-700',
      icon: 'fas fa-dollar-sign',
      items: [
        { id: 'financeiro', label: 'Módulo Financeiro', icon: 'fas fa-dollar-sign', available: canAccessReports, badge: null },
        { id: 'overdue-debts', label: isVendedor ? 'Meus Débitos Vencidos' : 'Débitos Vencidos', icon: 'fas fa-exclamation-triangle', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'blocked-orders', label: isVendedor ? 'Meus Pedidos Bloqueados' : 'Pedidos Bloqueados', icon: 'fas fa-ban', available: canAccessReports || isVendedor, badge: blockedOrdersCount > 0 ? blockedOrdersCount : null },
      ],
    },
    {
      groupLabel: 'Comunicação',
      color: 'bg-teal-500',
      bgColor: 'bg-teal-50',
      textColor: 'text-teal-700',
      icon: 'fas fa-comments',
      items: [
        { id: 'whatsapp', label: 'WhatsApp', icon: 'fab fa-whatsapp', available: canAccessReports, badge: null },
        { id: 'central-atendimento', label: 'Central de Atendimento', icon: 'fas fa-headset', available: isTelemarketing, badge: null },
        { id: 'telemarketing', label: 'Central de Telemarketing', icon: 'fas fa-comments', available: canAccessReports, badge: null },
      ],
      subGroups: [
        {
          label: 'Central de Telemarketing',
          icon: 'fas fa-phone',
          stateKey: 'telemarketing',
          items: [
            { id: 'telemarketing-dashboard', label: 'Central de Atendimento', icon: 'fas fa-comments', available: canAccessReports, badge: null },
            { id: 'telemarketing-analysis', label: 'Dashboard de Conversas', icon: 'fas fa-chart-bar', available: canAccessReports, badge: null },
            { id: 'telemarketing-whatsapp', label: 'Templates Rápidos', icon: 'fab fa-whatsapp', available: canAccessReports, badge: null },
            { id: 'telemarketing-telegram', label: 'Análises', icon: 'fab fa-telegram', available: canAccessReports, badge: null },
            { id: 'telemarketing-deliveries', label: 'Entregas Chat', icon: 'fas fa-truck', available: canAccessReports, badge: null },
          ],
        },
      ],
    },
    {
      groupLabel: 'Indústria',
      color: 'bg-emerald-500',
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-700',
      icon: 'fas fa-industry',
      items: [
        { id: 'industria', label: 'Módulo Indústria', icon: 'fas fa-industry', available: canAccessIndustria, badge: null },
      ],
    },
    {
      groupLabel: 'Administração',
      color: 'bg-indigo-500',
      bgColor: 'bg-indigo-50',
      textColor: 'text-indigo-700',
      icon: 'fas fa-cog',
      items: [
        { id: 'omie', label: 'Integração Omie', icon: 'fas fa-link', available: canAccessReports, badge: null },
        { id: 'omie-instances', label: 'Instâncias Omie', icon: 'fas fa-building', available: canAccessUsers, badge: null },
        { id: 'omie-stage-logs', label: 'Logs Etapas Omie', icon: 'fas fa-list-check', available: canAccessReports, badge: null },
        { id: 'rh', label: isVendedor ? 'Minhas Métricas' : 'RH', icon: 'fas fa-briefcase', available: true, badge: null },
        { id: 'users', label: 'Usuários', icon: 'fas fa-user-cog', available: canAccessUsers, badge: null },
      ],
    },
  ];

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    menuGroups.forEach(g => { initial[g.groupLabel] = true; });
    return initial;
  });
  const [subGroupOpen, setSubGroupOpen] = useState<Record<string, boolean>>({});

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
      'central-atendimento': '/telemarketing/atendimento',
      'sdr-digital': '/telemarketing/sdr-digital',
    };
    
    if (telemarketingRoutes[itemId]) {
      console.log('🔗 Navegando para rota de telemarketing:', telemarketingRoutes[itemId]);
      navigate(telemarketingRoutes[itemId]);
      setMobileMenuOpen(false);
      return;
    }
    
    // Rotas que têm páginas próprias devem navegar diretamente
    const routePages = ['sales-schedule', 'billings', 'fiscal-invoices', 'billing-pipeline', 'estoque', 'financeiro', 'industria', 'sales-goals', 'blocked-orders', 'overdue-debts', 'visit-routes', 'rota-do-dia', 'rota-entrega', 'routes-management', 'delivery-routes', 'entregas-do-dia', 'mapa-clientes', 'clientes-ativos', 'clientes-virtuais-hoje', 'check-in-photos', 'check-in-audit', 'rh', 'hotsite-pricing', 'hotsite-orders', 'leads', 'whatsapp', 'telemarketing', 'validacao-rotas', 'central-atendimento', 'vendas-digitais', 'sdr-digital'];
    
    // Rotas admin especiais
    if (itemId === 'omie-instances') {
      console.log('🔗 Navegando para admin/omie-instances');
      navigate('/admin/omie-instances');
      setMobileMenuOpen(false);
      return;
    }
    
    if (itemId === 'omie-stage-logs') {
      navigate('/admin/omie-stage-logs');
      setMobileMenuOpen(false);
      return;
    }
    
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

  const toggleGroup = (label: string) => {
    setOpenGroups(prev => ({ ...prev, [label]: !prev[label] }));
  };

  const toggleSubGroup = (key: string) => {
    setSubGroupOpen(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const roleFilterItems = (items: MenuItem[]) => {
    return items
      .filter(item => item.available)
      .filter(item => !isMotorista || ['rota-entrega', 'entregas-do-dia'].includes(item.id))
      .filter(item => !isTelemarketing || ['dashboard', 'sales-cards', 'sales-schedule', 'visit-routes', 'customers', 'clientes-ativos', 'clientes-virtuais-hoje', 'central-atendimento', 'overdue-debts', 'hotsite-orders', 'leads', 'sdr-digital', 'entregas-do-dia'].includes(item.id));
  };

  const renderGroupedMenu = () => {
    return menuGroups.map(group => {
      const visibleItems = roleFilterItems(group.items);
      const visibleSubGroups = (group.subGroups || []).filter(sg => roleFilterItems(sg.items).length > 0);
      if (visibleItems.length === 0 && visibleSubGroups.length === 0) return null;
      const isOpen = openGroups[group.groupLabel] !== false;

      return (
        <div key={group.groupLabel} className="mb-1">
          <button
            onClick={() => toggleGroup(group.groupLabel)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-colors ${group.bgColor} ${group.textColor} hover:opacity-80`}
          >
            <span className={`w-2 h-2 rounded-full ${group.color} flex-shrink-0`} />
            <i className={`${group.icon} text-[10px]`}></i>
            <span className="flex-1 text-left">{group.groupLabel}</span>
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          {isOpen && (
            <ul className="mt-0.5 space-y-0.5 ml-1 border-l-2 border-opacity-30" style={{ borderColor: `var(--group-${group.groupLabel.toLowerCase().replace(/[^a-z]/g, '')})` }}>
              {visibleItems.map(item => (
                <li key={item.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`w-full justify-start space-x-2 h-8 text-[13px] ${
                      activeView === item.id
                        ? `${group.textColor} ${group.bgColor} font-semibold`
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                    onClick={() => handleMenuItemClick(item.id)}
                    data-testid={`menu-${item.id}`}
                  >
                    <i className={`${item.icon} w-4 text-center text-xs`}></i>
                    <span className="truncate">{item.label}</span>
                    {item.badge && item.badge > 0 && (
                      <Badge className="ml-auto bg-red-500 text-white text-[10px] h-5 min-w-[20px] flex items-center justify-center">
                        {item.badge}
                      </Badge>
                    )}
                  </Button>
                </li>
              ))}
              {visibleSubGroups.map(sg => {
                const sgItems = roleFilterItems(sg.items);
                const sgOpen = subGroupOpen[sg.stateKey] || false;
                return (
                  <li key={sg.stateKey}>
                    <Collapsible open={sgOpen} onOpenChange={() => toggleSubGroup(sg.stateKey)}>
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={`w-full justify-start space-x-2 h-8 text-[13px] ${group.textColor} hover:${group.bgColor}`}
                        >
                          <i className={`${sg.icon} w-4 text-center text-xs`}></i>
                          <span className="truncate font-medium">{sg.label}</span>
                          {sgOpen ? <ChevronDown className="ml-auto h-3 w-3" /> : <ChevronRight className="ml-auto h-3 w-3" />}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="ml-4 space-y-0.5">
                        {sgItems.map(item => (
                          <Button
                            key={item.id}
                            variant="ghost"
                            size="sm"
                            className={`w-full justify-start space-x-2 h-7 text-xs ${
                              activeView === item.id
                                ? `${group.textColor} ${group.bgColor} font-semibold`
                                : 'text-gray-600 hover:bg-gray-50'
                            }`}
                            onClick={() => handleMenuItemClick(item.id)}
                            data-testid={`menu-${item.id}`}
                          >
                            <i className={`${item.icon} w-4 text-center`}></i>
                            <span className="truncate">{item.label}</span>
                          </Button>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      );
    });
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

              {/* Menu Items - Grouped */}
              <div className="space-y-1 mt-4">
                {renderGroupedMenu()}
              </div>
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
          <div className="p-3 flex-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 80px)' }}>
            <div className="space-y-1">
              {renderGroupedMenu()}
            </div>
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
