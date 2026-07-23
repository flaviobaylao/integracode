import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ChevronRight, Menu, ArrowLeft, Search, X } from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@/lib/queryClient";
import { useLocation } from "wouter";
import type { User } from "@shared/schema";
import UserProfileModal from "./UserProfileModal";
import { VersionDisplay } from "./VersionDisplay";
import integraLogo from "@assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/permissions";

// Mapeia o id de cada item de menu para o CARD correspondente na matriz de
// permissões. Itens sem card mapeado ficam fora do gating (fail-open).
const MENU_CARD: Record<string, string> = {
  dashboard: "Dashboard",
  "sales-cards": "Cards de Venda", "sales-schedule": "Agenda de Vendas", "sales-goals": "Metas de Vendas",
  "visit-routes": "Rota de Visitas", "rota-do-dia": "Rota do Dia", "vendas-digitais": "Vendas Digitais",
  "sdr-digital": "SDR Digital", sellers: "Vendedores",
  customers: "Clientes / Carteira", "clientes-ativos": "Clientes Ativos",
  "clientes-virtuais-hoje": "Clientes Virtuais do Dia", leads: "LEADs", locations: "Localizações",
  "tabela-precos": "Tabela de Preços", "precos-grade": "Preços (Grade)", "mapa-clientes": "Mapa de Clientes",
  "rota-entrega": "Minhas Entregas", "entregas-do-dia": "Entregas do Dia", "validacao-rotas": "Validação de Rotas",
  "check-in-audit": "Auditoria de Check-ins", "delivery-dashboard": "Dashboard de Entregas",
  "delivery-management": "Gestão de Entregas", "delivery-routes": "Resumo das Rotas",
  "driver-management": "Motoristas", "delivery-reports": "Relatórios de Entregas",
  products: "Produtos", "hotsite-pricing": "Tabela de Preços Hotsite", "hotsite-orders": "Pedidos do Site",
  estoque: "Gestão de Estoque", cupons: "Cupons de Desconto", fornecedores: "Fornecedores",
  billings: "Faturamentos", "fiscal-invoices": "Faturamento NF-e", "billing-pipeline": "Pipeline Faturamento",
  "order-sale": "Pedido de Venda", "order-billing": "Faturar / Faturado", "order-billed": "Faturar / Faturado",
  "recuperacao-faturamento": "Recuperação de Faturamento",
  "fin-receivables": "Contas a Receber", "fin-payables": "Contas a Pagar", "fin-overdue": "Débitos Vencidos",
  "fin-blocked": "Pedidos Bloqueados", "fin-chart": "Plano de Contas / DRE", "fin-dre": "Plano de Contas / DRE",
  "fin-accounts": "Contas Financeiras", "fin-xml": "XMLs / SPED Fiscal", "fin-sped": "XMLs / SPED Fiscal",
  "fluxo-caixa": "Fluxo de Caixa", "conciliacao-bancaria": "Conciliação Bancária",
  "conferencia-pagamentos": "Conferência de Pagamentos", "auditoria-cobrancas": "Auditoria de Cobranças",
  "radar-compras": "Radar de Compras", cielo: "Cielo (PIX/Cartão)", "pix-charges": "Cielo (PIX/Cartão)",
  whatsapp: "WhatsApp", "telefones-clientes": "Telefones de Clientes", "central-atendimento": "Central de Atendimento",
  telemarketing: "Central de Telemarketing", "telemarketing-analysis": "Dashboard de Conversas",
  "telemarketing-disparo": "Disparo em Massa", "automacoes-comunicacao": "Automações de Comunicação",
  industria: "Módulo Indústria", "industria-dados": "Matéria-Prima e Receitas",
  relatorios: "Relatórios Dinâmicos", "relatorios-ia": "Relatórios IA",
  omie: "Integração Omie", "omie-instances": "Instâncias Omie", "sync-monitor": "Ambiente Fiscal",
  "agentes-ia": "Agentes IA", "omie-stage-logs": "Logs Etapas Omie", rh: "RH / Métricas",
  users: "Usuários", "admin-system": "Administração do Sistema", "cenarios-fiscais": "Cenários Fiscais",
  "acessos-delegacoes": "Acessos e Delegações",
};

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
  const perms = usePermissions(); // aplica permissões salvas (fail-open enquanto carrega / sem config)
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [showingSectionOptions, setShowingSectionOptions] = useState(false);
  // (05/jul) contador de acessos por card + abre secao via ?secao=
  const MENU_COUNTS_KEY = "integra_menu_counts";
  const [menuCounts, setMenuCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    try { setMenuCounts(JSON.parse(localStorage.getItem(MENU_COUNTS_KEY) || "{}")); } catch { /* noop */ }
    try {
      const secao = new URLSearchParams(window.location.search).get("secao");
      if (secao) { setSelectedSection(secao); setShowingSectionOptions(true); }
    } catch { /* noop */ }
  }, []);
  const bumpMenuCount = (itemId: string) => {
    setMenuCounts((prev) => {
      const next = { ...prev, [itemId]: (prev[itemId] || 0) + 1 };
      try { localStorage.setItem(MENU_COUNTS_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  };

  // (15/jul) Atalhos favoritos: estrela nos cards + barra de até 7 ícones no cabeçalho
  const FAVORITES_KEY = "integra_favorites";
  const MAX_FAVORITES = 7;
  const [favorites, setFavorites] = useState<string[]>([]);
  useEffect(() => {
    let local: string[] = [];
    try { local = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); } catch { /* noop */ }
    if (Array.isArray(local)) setFavorites(local);
    // Persistência por USUÁRIO (servidor): sobrevive a logout/login e troca de dispositivo.
    fetch('/api/user/favorites', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!d || !Array.isArray(d.favorites)) return;
        if (d.favorites.length > 0) {
          setFavorites(d.favorites);
          try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(d.favorites)); } catch { /* noop */ }
        } else if (Array.isArray(local) && local.length > 0) {
          // servidor ainda vazio, mas já existem favoritos locais → migra pro servidor (não apaga)
          fetch('/api/user/favorites', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ favorites: local }) }).catch(() => { /* noop */ });
        }
      })
      .catch(() => { /* mantém o localStorage */ });
  }, []);
  const toggleFavorite = (itemId: string) => {
    setFavorites((prev) => {
      let next: string[];
      if (prev.includes(itemId)) {
        next = prev.filter((x) => x !== itemId);
      } else if (prev.length >= MAX_FAVORITES) {
        toast({ title: "Limite de atalhos", description: `Você pode favoritar até ${MAX_FAVORITES} atalhos. Remova um para adicionar outro.`, variant: "destructive" });
        return prev;
      } else {
        next = [...prev, itemId];
      }
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch { /* noop */ }
      fetch('/api/user/favorites', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ favorites: next }) }).catch(() => { /* noop */ });
      return next;
    });
  };

  // (busca global) Campo de busca no cabeçalho para localizar qualquer
  // função, módulo ou atividade do sistema — mostra um dropdown estilo menu
  // e navega para a tela ao selecionar. Respeita papel e permissões do usuário.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const normalizeSearch = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

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
        { id: 'rota-do-dia', label: (isVendedor || isTelemarketing) ? 'Minha Rota do Dia' : 'Rota do Dia', icon: 'fas fa-map-marked-alt', available: isVendedor || isTelemarketing || canAccessReports, badge: null },
        { id: 'vendas-digitais', label: 'Vendas Digitais', icon: 'fas fa-chart-line', available: canAccessReports, badge: null },
        { id: 'relatorios-graficos', label: 'Relatórios Gráficos', icon: 'fas fa-chart-column', available: canAccessReports, badge: null },
        { id: 'sdr-digital', label: 'SDR Digital', icon: 'fas fa-search-location', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'repescagem', label: 'Repescagem', icon: 'fas fa-redo', available: canAccessReports || isTelemarketing, badge: null },
        { id: 'execucao-rota', label: 'Execução de Rota', icon: 'fas fa-route', available: canAccessReports, badge: null },
        { id: 'justificativas', label: 'Justificar Visitas', icon: 'fas fa-clipboard-check', available: true, badge: null },
        { id: 'minha-agenda', label: 'Minha Agenda', icon: 'fas fa-calendar-day', available: true, badge: null },
        { id: 'visitas-dia', label: 'Visitas', icon: 'fas fa-clipboard-check', available: canAccessReports, badge: null },
        { id: 'resumo-visitas', label: 'Resumo de Visitas', icon: 'fas fa-calendar-check', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
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
        { id: 'radar-churn', label: 'Radar de Churn', icon: 'fas fa-heart-pulse', available: canAccessReports, badge: null },
        { id: 'fila-resgate', label: 'Fila de Resgate', icon: 'fas fa-life-ring', available: canAccessReports, badge: null },
        { id: 'programa-indicacao', label: 'Programa de Indicação', icon: 'fas fa-gift', available: canAccessReports, badge: null },
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
        { id: 'radar-compras', label: 'Compras', icon: 'fas fa-cart-shopping', available: canAccessReports, badge: null },
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
        { id: 'billing-pipeline', label: 'Pipeline Faturamento', icon: 'fas fa-columns', available: canAccessReports || isTelemarketing || isVendedor, badge: null },
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
        { id: 'fin-receivables', label: 'Contas a Receber', icon: 'fas fa-file-invoice-dollar', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'fin-payables', label: 'Contas a Pagar', icon: 'fas fa-money-check-alt', available: canAccessReports, badge: null },
        { id: 'fin-overdue', label: 'Débitos Vencidos', icon: 'fas fa-exclamation-triangle', available: canAccessReports || isVendedor || isTelemarketing, badge: null },
        { id: 'fin-blocked', label: 'Pedidos Bloqueados', icon: 'fas fa-ban', available: canAccessReports || isVendedor || isTelemarketing, badge: blockedOrdersCount > 0 ? blockedOrdersCount : null },
        { id: 'fin-chart', label: 'Plano de Contas', icon: 'fas fa-sitemap', available: canAccessReports, badge: null },
        { id: 'fin-accounts', label: 'Contas Financeiras', icon: 'fas fa-university', available: canAccessReports, badge: null },
        { id: 'fin-dre', label: 'DRE', icon: 'fas fa-chart-line', available: canAccessReports, badge: null },
        { id: 'fin-xml', label: 'XMLs', icon: 'fas fa-file-code', available: canAccessReports, badge: null },
        { id: 'fin-sped', label: 'SPED Fiscal', icon: 'fas fa-database', available: canAccessReports, badge: null },
        { id: 'dashboard-financeiro', label: 'Dashboard Financeiro', icon: 'fas fa-chart-pie', available: canAccessReports, badge: null },
        { id: 'todas-as-contas', label: 'Todas as Contas', icon: 'fas fa-list', available: canAccessReports, badge: null },
        { id: 'fluxo-caixa', label: 'Fluxo de Caixa', icon: 'fas fa-chart-area', available: canAccessReports, badge: null },
        { id: 'recuperacao-faturamento', label: 'Recuperação de Faturamento', icon: 'fas fa-rotate-left', available: canAccessReports, badge: null },
        { id: 'conciliacao-bancaria', label: 'Conciliação Bancária', icon: 'fas fa-money-check', available: canAccessReports, badge: null },
        { id: 'conferencia-pagamentos', label: 'Conferência de Pagamentos', icon: 'fas fa-clipboard-check', available: canAccessReports, badge: null },
        { id: 'auditoria-cobrancas', label: 'Auditoria de Cobranças', icon: 'fas fa-user-shield', available: canAccessReports, badge: null },
        { id: 'auditoria-financeira', label: 'Auditoria Financeira', icon: 'fas fa-shield-halved', available: canAccessReports, badge: null },
        { id: 'lixeira-financeira', label: 'Lixeira Financeira', icon: 'fas fa-trash-arrow-up', available: canAccessReports, badge: null },
        { id: 'radar-compras', label: 'Compras', icon: 'fas fa-cart-shopping', available: canAccessReports, badge: null },
        { id: 'pix-charges', label: 'PIX', icon: 'fas fa-qrcode', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Dashboard Financeiro',
      color: 'bg-emerald-500',
      bgColor: 'bg-emerald-50',
      textColor: 'text-emerald-700',
      hexColor: '#10b981',
      icon: 'fas fa-chart-pie',
      items: [
        { id: 'dashboard-financeiro', label: 'Dashboard Financeiro', icon: 'fas fa-chart-pie', available: canAccessReports, badge: null },
      ],
    },
    {
      groupLabel: 'Compras',
      color: 'bg-amber-500',
      bgColor: 'bg-amber-50',
      textColor: 'text-amber-700',
      hexColor: '#f59e0b',
      icon: 'fas fa-cart-shopping',
      items: [
        { id: 'radar-compras', label: 'Compras', icon: 'fas fa-cart-shopping', available: canAccessReports, badge: null },
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
        { id: 'central-atendimento', label: 'Central de Atendimento', icon: 'fas fa-headset', available: isTelemarketing || isVendedor, badge: null },
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
        { id: 'sellers', label: 'Vendedores', icon: 'fas fa-user-tie', available: canAccessReports, badge: null },
        { id: 'customer-payments', label: 'Pagamento Clientes', icon: 'fas fa-credit-card', available: canAccessReports, badge: null },
        { id: 'admin-system', label: 'Administração do Sistema', icon: 'fas fa-cogs', available: canAccessUsers, badge: null },
        { id: 'cenarios-fiscais', label: 'Cenários Fiscais', icon: 'fas fa-file-invoice', available: canAccessReports, badge: null },
        { id: 'cielo', label: 'Cielo (PIX/Cartão)', icon: 'fas fa-credit-card', available: canAccessReports, badge: null },
      { id: 'acessos-delegacoes', label: 'Acessos e Delegações', icon: 'fas fa-user-shield', available: canAccessUsers, badge: null },
      ],
    },
  ];

  // Índice id -> {label, icon, hexColor} para renderizar os atalhos favoritos no cabeçalho
  const itemIndex = new Map<string, { label: string; icon: string; hexColor: string }>();
  for (const g of menuGroups) {
    for (const it of g.items) {
      if (!itemIndex.has(it.id)) itemIndex.set(it.id, { label: it.label, icon: it.icon, hexColor: g.hexColor });
    }
  }

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
      // Aplicação das permissões salvas: esconde o item se o usuário configurado
      // não tem "ver" no card correspondente. Itens sem card mapeado passam livres.
      .filter(item => { const card = MENU_CARD[item.id]; return !card || perms.can(card, "ver"); })
      .filter(item => !isMotorista || ['rota-entrega', 'entregas-do-dia'].includes(item.id))
      .filter(item => !isTelemarketing || ['dashboard', 'sales-cards', 'sales-schedule', 'visit-routes', 'rota-do-dia', 'repescagem', 'customers', 'clientes-ativos', 'clientes-virtuais-hoje', 'central-atendimento', 'financeiro', 'fin-receivables', 'fin-overdue', 'resumo-visitas', 'hotsite-orders', 'leads', 'sdr-digital', 'entregas-do-dia', 'billing-pipeline'].includes(item.id));
  };

  const visibleGroups = useMemo(() => {
    return menuGroups.filter(group => {
      const visibleItems = roleFilterItems(group.items);
      return visibleItems.length > 0;
    });
    // inclui perms.map: quando as permissões carregam, recalcula para remover
    // seções que ficaram sem nenhum item visível.
  }, [menuGroups, perms.map]);

  // Índice achatado de TODOS os itens visíveis (de todas as seções) para a busca
  // global do cabeçalho. Deduplica por id e guarda a seção/cor de cada item.
  const searchIndex = useMemo(() => {
    const seen = new Set<string>();
    const list: { id: string; label: string; icon: string; groupLabel: string; hexColor: string }[] = [];
    for (const g of visibleGroups) {
      for (const it of roleFilterItems(g.items)) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        list.push({ id: it.id, label: it.label, icon: it.icon, groupLabel: g.groupLabel, hexColor: g.hexColor });
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleGroups, perms.map]);

  const searchResults = useMemo(() => {
    const q = normalizeSearch(searchQuery.trim());
    if (!q) return [] as typeof searchIndex;
    const terms = q.split(/\s+/).filter(Boolean);
    return searchIndex
      .filter((x) => {
        const hay = normalizeSearch(x.label + ' ' + x.groupLabel);
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 12);
  }, [searchQuery, searchIndex]);

  const handleMenuItemClick = (itemId: string) => {
    bumpMenuCount(itemId);
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

    const routePages = ['execucao-rota', 'radar-churn', 'fila-resgate', 'programa-indicacao', 'justificativas', 'sales-schedule', 'billings', 'fiscal-invoices', 'billing-pipeline', 'estoque', 'financeiro', 'industria', 'sales-goals', 'blocked-orders', 'overdue-debts', 'visit-routes', 'rota-do-dia', 'rota-entrega', 'routes-management', 'delivery-routes', 'entregas-do-dia', 'mapa-clientes', 'clientes-ativos', 'clientes-virtuais-hoje', 'check-in-photos', 'check-in-audit', 'rh', 'hotsite-pricing', 'hotsite-orders', 'leads', 'whatsapp', 'telemarketing', 'validacao-rotas', 'central-atendimento', 'vendas-digitais', 'sdr-digital', 'relatorios', 'relatorios-ia', 'relatorios-graficos', 'radar-compras', 'cenarios-fiscais', 'telefones-clientes', 'tabela-precos', 'precos-grade', 'cupons', 'fornecedores', 'recuperacao-faturamento', 'conciliacao-bancaria', 'auditoria-cobrancas', 'automacoes-comunicacao', 'cielo', 'industria-dados', 'todas-as-contas', 'fluxo-caixa', 'conferencia-pagamentos', 'dashboard-financeiro', 'auditoria-financeira', 'lixeira-financeira'];

    if (itemId === 'omie-instances') {
      navigate('/admin/omie-instances');
      return;
    }
    if (itemId === 'acessos-delegacoes') { navigate('/admin/acessos-delegacoes'); return; }

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

    if (itemId === 'customer-payments') {
      navigate('/pagamento-clientes');
      return;
    }

    if (itemId === 'repescagem') {
      navigate('/repescagem');
      return;
    }

    if (itemId === 'minha-agenda') {
      navigate('/minha-agenda');
      return;
    }

    if (itemId === 'visitas-dia') {
      navigate('/visitas');
      return;
    }

    if (itemId === 'resumo-visitas') {
      navigate('/resumo-visitas');
      return;
    }

    if (itemId === 'pix-charges') {
      navigate('/pix-charges');
      return;
    }

    if (routePages.includes(itemId)) {
      const route = '/' + itemId.replace(/_/g, '-');
      navigate(route);
    } else {
      setActiveView(itemId);
    }
  };

  // Seleciona um resultado da busca global: limpa o campo, fecha o dropdown e navega.
  const runSearchSelect = (id: string) => {
    setSearchQuery('');
    setSearchFocused(false);
    setSearchActiveIdx(0);
    handleMenuItemClick(id);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchFocused(false);
      (e.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (!searchResults.length) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchActiveIdx((i) => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = searchResults[searchActiveIdx] || searchResults[0];
      if (item) runSearchSelect(item.id);
    }
  };

  // Atalhos favoritos do cabeçalho persistente: quando chega em "/?ir=<id>",
  // abre o item correspondente (reaproveita toda a lógica de handleMenuItemClick)
  // e limpa o parâmetro da URL.
  useEffect(() => {
    try {
      const ir = new URLSearchParams(window.location.search).get('ir');
      if (ir) {
        handleMenuItemClick(ir);
        const url = new URL(window.location.href);
        url.searchParams.delete('ir');
        window.history.replaceState({}, '', url.pathname + url.search);
      }
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const items = [...roleFilterItems(group.items)]
      .map((it, i) => ({ it, i }))
      .sort((a, b) => ((menuCounts[b.it.id] || 0) - (menuCounts[a.it.id] || 0)) || (a.i - b.i))
      .map((x) => x.it);
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
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleFavorite(item.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggleFavorite(item.id); } }}
                title={favorites.includes(item.id) ? 'Remover dos atalhos favoritos' : 'Adicionar aos atalhos favoritos'}
                data-testid={`fav-star-${item.id}`}
                className="absolute top-2 left-2 w-6 h-6 flex items-center justify-center rounded-md hover:bg-gray-100 cursor-pointer z-10"
              >
                <i className="fas fa-star text-sm" style={{ color: favorites.includes(item.id) ? '#f59e0b' : '#d1d5db' }}></i>
              </span>
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
    <div className="h-screen flex flex-col overflow-hidden bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200 px-4 md:px-6 py-4 flex items-center justify-between flex-shrink-0">
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

        {/* Busca global + Atalhos favoritos (até 7) */}
        <div className="hidden md:flex flex-1 items-center gap-3 px-4">
          {/* Busca de funções, módulos e atividades */}
          <div ref={searchRef} className="relative w-full max-w-sm">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setSearchActiveIdx(0); setSearchFocused(true); }}
                onFocus={() => setSearchFocused(true)}
                onKeyDown={onSearchKeyDown}
                placeholder="Buscar função, módulo ou atividade..."
                data-testid="global-search-input"
                aria-label="Buscar funções, módulos e atividades do sistema"
                className="w-full h-9 pl-9 pr-8 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent focus:bg-white transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setSearchActiveIdx(0); }}
                  title="Limpar busca"
                  aria-label="Limpar busca"
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {searchFocused && searchQuery.trim() && (
              <div
                className="absolute left-0 right-0 mt-1 max-h-80 overflow-y-auto bg-white rounded-lg border border-gray-200 shadow-lg z-50"
                data-testid="global-search-results"
              >
                {searchResults.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-gray-500">
                    Nenhum resultado para "{searchQuery.trim()}".
                  </div>
                ) : (
                  searchResults.map((r, idx) => (
                    <button
                      key={r.id}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); runSearchSelect(r.id); }}
                      onMouseEnter={() => setSearchActiveIdx(idx)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${idx === searchActiveIdx ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
                      data-testid={`global-search-result-${r.id}`}
                    >
                      <span
                        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: `${r.hexColor}15`, color: r.hexColor }}
                      >
                        <i className={`${r.icon} text-sm`}></i>
                      </span>
                      <span className="flex flex-col min-w-0">
                        <span className="text-sm font-medium text-gray-800 truncate">{r.label}</span>
                        <span className="text-[11px] text-gray-400 truncate">{r.groupLabel}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Atalhos favoritos (até 7) */}
          <div className="flex items-center justify-end gap-2 ml-auto">
            {favorites.map((favId) => {
              const info = itemIndex.get(favId);
              if (!info) return null;
              return (
                <button
                  key={favId}
                  onClick={() => handleMenuItemClick(favId)}
                  title={info.label}
                  data-testid={`fav-shortcut-${favId}`}
                  className="relative w-10 h-10 rounded-lg flex items-center justify-center transition-transform hover:scale-110 shadow-sm"
                  style={{ backgroundColor: `${info.hexColor}15`, color: info.hexColor }}
                >
                  <i className={`${info.icon} text-base`}></i>
                </button>
              );
            })}
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

      <div className="flex flex-1 min-h-0">
        {/* Sidebar - Seções (Desktop) */}
        <nav className="hidden md:flex flex-col w-[72px] bg-white shadow-sm h-full border-r border-gray-200">
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
        <main className="flex-1 min-w-0 overflow-auto h-full">
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
