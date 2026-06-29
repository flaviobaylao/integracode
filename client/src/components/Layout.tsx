import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ChevronRight, Menu, ArrowLeft } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
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
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [showingSectionOptions, setShowingSectionOptions] = useState(false);

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

  const { data: blockedOrdersData } = useQuery<any[]>({
    queryKey: ['/api/blocked-orders'],
    enabled: canAccessReports || isVendedor,
    refetchInterval: 30000,
  });
  const blockedOrdersCount = blockedOrdersData?.filter(order => order.status === 'blocked').length || 0;

  const { data: hotsiteOrdersData } = useQuery<{ orders: any[] }>({
    queryKey: ['/api/hotsite-orders'],
    enabled: canAccessReports,
    refetchInterval: 30000,
  });
  const hotsiteOrdersCount = hotsiteOrdersData?.orders?.length || 0;

  type MenuItem = { id: string; label: string; icon: string; available: boolean | string | null | undefined; badge: number | null };
  type MenuGroup = { groupLabel: string; color: string; bgColor: string; textColor: string; icon: string; hexColor: string; items: MenuItem[]; subGroups?: { label: string; icon: string; items: MenuItem[]; stateKey: string }[] };

  const menuGroups: MenuGroup[] = [
    {
      groupLabel: 'Geral',
      color: 'bg-slate-500',
      bgColor: 'bg-slate-50',
      textColor: 'text-slate-700',
      hexColor: '#64748b',
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
      hexColor: '#3b82f6',
      icon: 'fas fa-shopping-cart',
      items: [
        { id: 'sales-cards', label: user?.role === 'vendedor' ? 'Meus Cards de Venda' : 'Cards de Venda', icon: 'fas fa-clipboard-list', available: true, badge: null },
        { id: 'sales-schedule', label: 'Agenda de Vendas', icon: 'fas fa-calendar-week', available: true, badge: null },
        { id: 'sales-goals', label: user?.role === 'vendedor' ? 'Minhas Metas' : 'Metas de Vendas', icon: 'fas fa-bullseye', available: true, badge: null },
        { id: 'visit-routes', label: 'Rota de Visitas', icon: 'fas fa-route', available: true, badge: null },
        { id: 'rota-do-dia', label: isVendedor ? 'Minha Rota do Dia' : 'Rota do Dia', icon: 'fas fa-map-marked-alt', available: isVendedor || canAccessReports, badge: null },
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
      hexColor: '#10b981',
      icon: 'fas fa-users',
      items: [
        { id: 'customers', label: user?.role === 'vendedor' ? 'Minha Carteira' : 'Clientes', icon: 'fas fa-users', available: true, badge: null },
        { id: 'clientes-ativos', label: 'Clientes Ativos', icon: 'fas fa-check-circle', available: !isMotorista, badge: null },
        { id: 'clientes-virtuais-hoje', label: 'Clientes Virtuais do Dia', icon: 'fas fa-phone', available: !isMotorista, badge: null },
        { id: 'leads', label: 'LEADs', icon: 'fas fa-crosshairs', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'locations', label: 'Localizações', icon: 'fas fa-map-marker-alt', available: canAccessReports, badge: null },
        { id: 'tabela-precos', label: 'Tabela de Preços', icon: 'fas fa-tags', available: canAccessReports, badge: null },
        { id: 'precos-grade', label: 'Preços (Grade)', icon: 'fas fa-table', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Logística',
      color: 'bg-orange-500',
      bgColor: 'bg-orange-50',
      textColor: 'text-orange-700',
      hexColor: '#f97316',
      icon: 'fas fa-truck',
      items: [
        { id: 'rota-entrega', label: 'Minhas Entregas', icon: 'fas fa-truck', available: isMotorista, badge: null },
        { id: 'entregas-do-dia', label: 'Entregas do Dia', icon: 'fas fa-clipboard-list', available: true, badge: null },
        { id: 'validacao-rotas', label: 'Validação de Rotas', icon: 'fas fa-check-double', available: user?.role && ['admin', 'coordinator'].includes(user.role), badge: null },
        { id: 'check-in-audit', label: isVendedor ? 'Meus Check-ins' : 'Auditoria de Check-ins', icon: 'fas fa-clipboard-check', available: true, badge: null },
        { id: 'delivery-dashboard', label: 'Dashboard de Entregas', icon: 'fas fa-tachometer-alt', available: canAccessReports || isVendedor, badge: null },
        { id: 'delivery-management', label: 'Gestão de Entregas', icon: 'fas fa-shipping-fast', available: canAccessReports || isVendedor, badge: null },
        { id: 'delivery-routes', label: 'Resumo das Rotas', icon: 'fas fa-route', available: canAccessReports, badge: null },
        { id: 'mapa-clientes', label: 'Mapa de Clientes', icon: 'fas fa-map-marked-alt', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'driver-management', label: 'Motoristas', icon: 'fas fa-user-tie', available: canAccessReports, badge: null },
        { id: 'delivery-reports', label: 'Relatórios de Entregas', icon: 'fas fa-chart-line', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Produtos & Estoque',
      color: 'bg-amber-500',
      bgColor: 'bg-amber-50',
      textColor: 'text-amber-700',
      hexColor: '#f59e0b',
      icon: 'fas fa-box',
      items: [
        { id: 'products', label: 'Produtos', icon: 'fas fa-box', available: canAccessReports, badge: null },
        { id: 'hotsite-pricing', label: 'Tabela de Preços Hotsite', icon: 'fas fa-tags', available: canAccessReports, badge: null },
        { id: 'hotsite-orders', label: 'Pedidos do Site', icon: 'fas fa-shopping-bag', available: canAccessReports || isTelemarketing, badge: hotsiteOrdersCount > 0 ? hotsiteOrdersCount : null },
        { id: 'estoque', label: 'Gestão de Estoque', icon: 'fas fa-boxes', available: canAccessReports, badge: null },
        { id: 'cupons', label: 'Cupons de Desconto', icon: 'fas fa-ticket-alt', available: canAccessReports, badge: null },
        { id: 'fornecedores', label: 'Fornecedores', icon: 'fas fa-truck-loading', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Faturamento',
      color: 'bg-purple-500',
      bgColor: 'bg-purple-50',
      textColor: 'text-purple-700',
      hexColor: '#a855f7',
      icon: 'fas fa-file-invoice',
      items: [
        { id: 'billings', label: isVendedor ? 'Meus Faturamentos' : 'Faturamentos', icon: 'fas fa-file-invoice-dollar', available: canAccessReports || isVendedor, badge: null },
        { id: 'fiscal-invoices', label: 'Faturamento NF-e', icon: 'fas fa-file-alt', available: canAccessReports, badge: null },
        { id: 'billing-pipeline', label: 'Pipeline Faturamento', icon: 'fas fa-columns', available: canAccessReports, badge: null },
        { id: 'order-sale', label: 'Pedido de Venda', icon: 'fas fa-shopping-cart', available: canAccessReports, badge: null },
        { id: 'order-billing', label: 'Faturar', icon: 'fas fa-file-invoice', available: canAccessReports, badge: null },
        { id: 'order-billed', label: 'Faturado', icon: 'fas fa-check-circle', available: canAccessReports, badge: null },
        { id: 'order-awaiting-route', label: 'Aguardando Rota', icon: 'fas fa-clock', available: canAccessReports, badge: null },
        { id: 'order-in-route', label: 'Em Rota', icon: 'fas fa-truck', available: canAccessReports, badge: null },
        { id: 'recuperacao-faturamento', label: 'Recuperação de Faturamento', icon: 'fas fa-rotate-left', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Financeiro',
      color: 'bg-rose-500',
      bgColor: 'bg-rose-50',
      textColor: 'text-rose-700',
      hexColor: '#f43f5e',
      icon: 'fas fa-dollar-sign',
      items: [
        { id: 'fin-receivables', label: 'Contas a Receber', icon: 'fas fa-file-invoice-dollar', available: canAccessReports, badge: null },
        { id: 'fin-payables', label: 'Contas a Pagar', icon: 'fas fa-money-check-alt', available: canAccessReports, badge: null },
        { id: 'fin-overdue', label: 'Débitos Vencidos', icon: 'fas fa-exclamation-triangle', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'fin-blocked', label: 'Pedidos Bloqueados', icon: 'fas fa-ban', available: canAccessReports || isVendedor || isTelemarketing, badge: blockedOrdersCount > 0 ? blockedOrdersCount : null },
        { id: 'fin-chart', label: 'Plano de Contas', icon: 'fas fa-sitemap', available: canAccessReports, badge: null },
        { id: 'fin-accounts', label: 'Contas Financeiras', icon: 'fas fa-university', available: canAccessReports, badge: null },
        { id: 'fin-dre', label: 'DRE', icon: 'fas fa-chart-line', available: canAccessReports, badge: null },
        { id: 'fin-xml', label: 'XMLs', icon: 'fas fa-file-code', available: canAccessReports, badge: null },
        { id: 'fin-sped', label: 'SPED Fiscal', icon: 'fas fa-database', available: canAccessReports, badge: null },
        { id: 'todas-as-contas', label: 'Todas as Contas', icon: 'fas fa-list', available: canAccessReports, badge: null },
        { id: 'fluxo-caixa', label: 'Fluxo de Caixa', icon: 'fas fa-chart-area', available: canAccessReports, badge: null },
        { id: 'recuperacao-faturamento', label: 'Recuperação de Faturamento', icon: 'fas fa-rotate-left', available: canAccessReports, badge: null },
        { id: 'conciliacao-bancaria', label: 'Conciliação Bancária', icon: 'fas fa-money-check', available: canAccessReports, badge: null },
        { id: 'conferencia-pagamentos', label: 'Conferência de Pagamentos', icon: 'fas fa-clipboard-check', available: canAccessReports, badge: null },
        { id: 'auditoria-cobrancas', label: 'Auditoria de Cobranças', icon: 'fas fa-user-shield', available: canAccessReports, badge: null },
        { id: 'radar-compras', label: 'Radar de Compras', icon: 'fas fa-satellite-dish', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Comunicação',
      color: 'bg-teal-500',
      bgColor: 'bg-teal-50',
      textColor: 'text-teal-700',
      hexColor: '#14b8a6',
      icon: 'fas fa-comments',
      items: [
        { id: 'whatsapp', label: 'WhatsApp', icon: 'fab fa-whatsapp', available: canAccessReports, badge: null },
        { id: 'telefones-clientes', label: 'Telefones de Clientes', icon: 'fas fa-address-book', available: canAccessReports || isTelemarketing, badge: null },
        { id: 'central-atendimento', label: 'Central de Atendimento', icon: 'fas fa-headset', available: isTelemarketing, badge: null },
        { id: 'telemarketing', label: 'Central de Telemarketing', icon: 'fas fa-comments', available: canAccessReports, badge: null },
        { id: 'telemarketing-dashboard', label: 'Central de Atendimento', icon: 'fas fa-comments', available: canAccessReports, badge: null },
        { id: 'telemarketing-analysis', label: 'Dashboard de Conversas', icon: 'fas fa-chart-bar', available: canAccessReports, badge: null },
        { id: 'telemarketing-whatsapp', label: 'Templates Rápidos', icon: 'fab fa-whatsapp', available: canAccessReports, badge: null },
        { id: 'telemarketing-telegram', label: 'Análises', icon: 'fab fa-telegram', available: canAccessReports, badge: null },
        { id: 'telemarketing-deliveries', label: 'Entregas Chat', icon: 'fas fa-truck', available: canAccessReports, badge: null },
        { id: 'telemarketing-disparo', label: 'Disparo em Massa', icon: 'fas fa-bullhorn', available: canAccessReports, badge: null },
        { id: 'automacoes-comunicacao', label: 'Automações de Comunicação', icon: 'fas fa-bolt', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Agentes IA',
      color: 'bg-violet-500',
      bgColor: 'bg-violet-50',
      textColor: 'text-violet-700',
      hexColor: '#8b5cf6',
      icon: 'fas fa-robot',
      items: [
        { id: 'agentes-ia', label: 'Agentes IA', icon: 'fas fa-robot', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Indústria',
      color: 'bg-emerald-600',
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-700',
      hexColor: '#059669',
      icon: 'fas fa-industry',
      items: [
        { id: 'industria', label: 'Módulo Indústria', icon: 'fas fa-industry', available: canAccessIndustria, badge: null },
        { id: 'industria-dados', label: 'Matéria-Prima e Receitas', icon: 'fas fa-flask', available: canAccessIndustria, badge: null },
      ],
    },
    {
      groupLabel: 'Relatórios',
      color: 'bg-cyan-500',
      bgColor: 'bg-cyan-50',
      textColor: 'text-cyan-700',
      hexColor: '#06b6d4',
      icon: 'fas fa-chart-bar',
      items: [
        { id: 'relatorios', label: 'Relatórios Dinâmicos', icon: 'fas fa-chart-bar', available: canAccessReports, badge: null },
        { id: 'relatorios-ia', label: 'Relatórios IA', icon: 'fas fa-brain', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Administração',
      color: 'bg-indigo-500',
      bgColor: 'bg-indigo-50',
      textColor: 'text-indigo-700',
      hexColor: '#6366f1',
      icon: 'fas fa-cog',
      items: [
        { id: 'omie', label: 'Integração Omie', icon: 'fas fa-link', available: canAccessReports, badge: null },
        { id: 'omie-instances', label: 'Instâncias Omie', icon: 'fas fa-building', available: canAccessUsers, badge: null },
        { id: 'sync-monitor', label: 'Ambiente Fiscal', icon: 'fas fa-file-invoice-dollar', available: canAccessReports, badge: null },
        { id: 'agentes-ia', label: 'Agentes IA', icon: 'fas fa-robot', available: canAccessReports, badge: null },
      { id: 'omie-stage-logs', label: 'Logs Etapas Omie', icon: 'fas fa-list-check', available: canAccessReports, badge: null },
        { id: 'rh', label: isVendedor ? 'Minhas Métricas' : 'RH', icon: 'fas fa-briefcase', available: true, badge: null },
        { id: 'users', label: 'Usuários', icon: 'fas fa-user-cog', available: canAccessUsers, badge: null },
        { id: 'admin-system', label: 'Administração do Sistema', icon: 'fas fa-cogs', available: canAccessUsers, badge: null },
        { id: 'cenarios-fiscais', label: 'Cenários Fiscais', icon: 'fas fa-file-invoice', available: canAccessReports, badge: null },
        { id: 'cielo', label: 'Cielo (PIX/Cartão)', icon: 'fas fa-credit-card', available: canAccessReports, badge: null },
      ],
    },
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

  const roleFilterItems = (items: MenuItem[]) => {
    return items
      .filter(item => item.available)
      .filter(item => !isMotorista || ['rota-entrega', 'entregas-do-dia'].includes(item.id))
      .filter(item => !isTelemarketing || ['dashboard', 'sales-cards', 'sales-schedule', 'visit-routes', 'customers', 'clientes-ativos', 'clientes-virtuais-hoje', 'central-atendimento', 'financeiro', 'hotsite-orders', 'leads', 'sdr-digital', 'entregas-do-dia'].includes(item.id));
  };

  const visibleGroups = useMemo(() => {
    return menuGroups.filter(group => {
      const visibleItems = roleFilterItems(group.items);
      return visibleItems.length > 0;
    });
  }, [menuGroups]);

  const handleMenuItemClick = (itemId: string) => {
    setShowingSectionOptions(false);
    setMobileMenuOpen(false);

    const telemarketingRoutes: Record<string, string> = {
      'telemarketing': '/telemarketing',
      'telemarketing-dashboard': '/telemarketing/atendimento',
      'telemarketing-whatsapp': '/telemarketing/templates',
      'telemarketing-telegram': '/telemarketing/analysis',
      'telemarketing-deliveries': '/telemarketing/analysis',
      'telemarketing-analysis': '/telemarketing/conversas',
      'central-atendimento': '/telemarketing/atendimento',
      'sdr-digital': '/telemarketing/sdr-digital',
      'telemarketing-disparo': '/telemarketing/disparo-em-massa',
    };

    if (telemarketingRoutes[itemId]) {
      navigate(telemarketingRoutes[itemId]);
      return;
    }

    const finTabMap: Record<string, string> = {
      'fin-receivables': 'receivables',
      'fin-payables': 'payables',
      'fin-overdue': 'overdue',
      'fin-blocked': 'blocked',
      'fin-chart': 'chart',
      'fin-accounts': 'accounts',
      'fin-dre': 'dre',
      'fin-xml': 'xml',
      'fin-sped': 'sped',
    };
    if (finTabMap[itemId]) {
      navigate(`/financeiro?tab=${finTabMap[itemId]}`);
      setShowingSectionOptions(false);
      return;
    }

    const routePages = ['sales-schedule', 'billings', 'fiscal-invoices', 'billing-pipeline', 'estoque', 'financeiro', 'industria', 'sales-goals', 'blocked-orders', 'overdue-debts', 'visit-routes', 'rota-do-dia', 'rota-entrega', 'routes-management', 'delivery-routes', 'entregas-do-dia', 'mapa-clientes', 'clientes-ativos', 'clientes-virtuais-hoje', 'check-in-photos', 'check-in-audit', 'rh', 'hotsite-pricing', 'hotsite-orders', 'leads', 'whatsapp', 'telemarketing', 'validacao-rotas', 'central-atendimento', 'vendas-digitais', 'sdr-digital', 'relatorios', 'relatorios-ia', 'radar-compras', 'cenarios-fiscais', 'telefones-clientes', 'tabela-precos', 'precos-grade', 'cupons', 'fornecedores', 'recuperacao-faturamento', 'conciliacao-bancaria', 'auditoria-cobrancas', 'automacoes-comunicacao', 'cielo', 'industria-dados', 'todas-as-contas', 'fluxo-caixa', 'conferencia-pagamentos'];

    if (itemId === 'omie-instances') {
      navigate('/admin/omie-instances');
      return;
    }

    if (itemId === 'omie-stage-logs') {
      navigate('/admin/omie-stage-logs');
      return;
    }

    if (itemId === 'admin-system') {
      navigate('/admin/system');
      return;
    }

    if (itemId === 'sync-monitor') {
      navigate('/admin/sync-monitor');
      return;
    }

    if (itemId === 'agentes-ia') {
      navigate('/admin/agentes');
      return;
    }

    if (routePages.includes(itemId)) {
      const route = '/' + itemId.replace(/_/g, '-');
      navigate(route);
    } else {
      setActiveView(itemId);
    }
  };

  const handleSectionClick = (groupLabel: string) => {
    const group = visibleGroups.find(g => g.groupLabel === groupLabel);
    if (!group) return;

    const items = roleFilterItems(group.items);
    if (items.length === 1) {
      handleMenuItemClick(items[0].id);
      return;
    }

    setSelectedSection(groupLabel);
    setShowingSectionOptions(true);
  };

  const selectedGroup = visibleGroups.find(g => g.groupLabel === selectedSection);

  const findGroupForActiveView = () => {
    for (const group of visibleGroups) {
      const items = roleFilterItems(group.items);
      if (items.some(item => item.id === activeView)) {
        return group.groupLabel;
      }
    }
    return null;
  };

  const activeGroup = findGroupForActiveView();

  const renderSectionCards = (group: MenuGroup) => {
    const items = roleFilterItems(group.items);
    return (
      <div className="p-4 md:p-6">
        <div className="mb-6">
          <button
            onClick={() => setShowingSectionOptions(false)}
            className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-3 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </button>
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center text-white"
              style={{ backgroundColor: group.hexColor }}
            >
              <i className={`${group.icon} text-lg`}></i>
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-800">{group.groupLabel}</h2>
              <p className="text-sm text-gray-500">Selecione uma opção</p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {items.map(item => (
            <button
              key={item.id}
              onClick={() => handleMenuItemClick(item.id)}
              className="group relative flex flex-col items-center justify-center p-5 rounded-xl border-2 border-gray-100 bg-white hover:border-opacity-50 hover:shadow-lg transition-all duration-200 min-h-[120px]"
              style={{ '--hover-color': group.hexColor } as any}
              data-testid={`menu-${item.id}`}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = group.hexColor;
                (e.currentTarget as HTMLElement).style.boxShadow = `0 4px 12px ${group.hexColor}30`;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = '#f3f4f6';
                (e.currentTarget as HTMLElement).style.boxShadow = '';
              }}
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-3 transition-transform group-hover:scale-110"
                style={{ backgroundColor: `${group.hexColor}15`, color: group.hexColor }}
              >
                <i className={`${item.icon} text-xl`}></i>
              </div>
              <span className="text-sm font-medium text-gray-700 text-center leading-tight">{item.label}</span>
              {item.badge && item.badge > 0 && (
                <Badge className="absolute top-2 right-2 bg-red-500 text-white text-[10px] h-5 min-w-[20px] flex items-center justify-center">
                  {item.badge}
                </Badge>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderMobileMenu = () => {
    return visibleGroups.map(group => {
      const items = roleFilterItems(group.items);
      if (items.length === 0) return null;

      return (
        <div key={group.groupLabel} className="mb-1">
          <button
            onClick={() => {
              if (items.length === 1) {
                handleMenuItemClick(items[0].id);
              } else {
                setSelectedSection(group.groupLabel);
              }
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
              selectedSection === group.groupLabel || activeGroup === group.groupLabel
                ? 'bg-gray-100 font-semibold'
                : 'hover:bg-gray-50'
            }`}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white flex-shrink-0"
              style={{ backgroundColor: group.hexColor }}
            >
              <i className={`${group.icon} text-sm`}></i>
            </div>
            <span className="text-sm font-medium text-gray-700 flex-1 text-left">{group.groupLabel}</span>
            {items.length > 1 && <ChevronRight className="h-4 w-4 text-gray-400" />}
          </button>
          {selectedSection === group.groupLabel && items.length > 1 && (
            <div className="ml-4 mt-1 space-y-0.5 border-l-2 pl-3" style={{ borderColor: group.hexColor }}>
              {items.map(item => (
                <button
                  key={item.id}
                  onClick={() => handleMenuItemClick(item.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                    activeView === item.id
                      ? `font-semibold`
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                  style={activeView === item.id ? { color: group.hexColor, backgroundColor: `${group.hexColor}10` } : {}}
                  data-testid={`menu-${item.id}`}
                >
                  <i className={`${item.icon} w-4 text-center text-xs`}></i>
                  <span className="truncate">{item.label}</span>
                  {item.badge && item.badge > 0 && (
                    <Badge className="ml-auto bg-red-500 text-white text-[10px] h-5 min-w-[20px] flex items-center justify-center">
                      {item.badge}
                    </Badge>
                  )}
                </button>
              ))}
            </div>
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

                <div className="space-y-1 mt-4">
                  {renderMobileMenu()}
                </div>
              </div>

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
        {/* Sidebar - Seções (Desktop) */}
        <nav className="hidden md:flex flex-col w-[72px] bg-white shadow-sm h-[calc(100vh-73px)] sticky top-0 border-r border-gray-200">
          <div className="flex-1 overflow-y-auto py-2 px-1.5 space-y-1">
            {visibleGroups.map(group => {
              const isActive = selectedSection === group.groupLabel && showingSectionOptions;
              const isCurrentGroup = activeGroup === group.groupLabel && !showingSectionOptions;
              return (
                <button
                  key={group.groupLabel}
                  onClick={() => handleSectionClick(group.groupLabel)}
                  className={`w-full flex flex-col items-center justify-center py-2.5 px-1 rounded-xl transition-all duration-200 group ${
                    isActive
                      ? 'shadow-md scale-105'
                      : isCurrentGroup
                      ? 'bg-gray-100'
                      : 'hover:bg-gray-50'
                  }`}
                  style={isActive ? { backgroundColor: group.hexColor } : {}}
                  title={group.groupLabel}
                  data-testid={`section-${group.groupLabel.toLowerCase().replace(/[^a-z]/g, '-')}`}
                >
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center mb-1 transition-all ${
                      isActive
                        ? 'bg-white/20 text-white'
                        : isCurrentGroup
                        ? 'text-white'
                        : 'text-white'
                    }`}
                    style={!isActive ? { backgroundColor: group.hexColor } : {}}
                  >
                    <i className={`${group.icon} text-sm`}></i>
                  </div>
                  <span
                    className={`text-[10px] font-medium leading-tight text-center line-clamp-2 ${
                      isActive ? 'text-white' : 'text-gray-600'
                    }`}
                  >
                    {group.groupLabel}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="p-1.5 border-t border-gray-200 flex-shrink-0">
            <VersionDisplay compact />
          </div>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 min-h-[calc(100vh-73px)]">
          {showingSectionOptions && selectedGroup ? (
            renderSectionCards(selectedGroup)
          ) : (
            <div className="p-4 md:p-6">
              {children}
            </div>
          )}
        </main>
      </div>

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
