import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";

// (15/jul/2026) Sidebar de seções persistente, visível em todas as páginas de módulo
// (rotas que renderizam fora do Layout do Dashboard). Cada seção leva à página inicial
// da seção via /?secao=<label> (a Home/Layout lê ?secao e abre o grid de cards da seção).
// É puramente navegacional — não altera o modelo de navegação do Dashboard.

type Section = {
  label: string;
  icon: string;
  hex: string;
  canView: (f: RoleFlags) => boolean;
};

type RoleFlags = {
  canAccessReports: boolean;
  canAccessUsers: boolean;
  isVendedor: boolean;
  isTelemarketing: boolean;
  isMotorista: boolean;
  canAccessIndustria: boolean;
};

const SECTIONS: Section[] = [
  { label: "Geral", icon: "fas fa-home", hex: "#64748b", canView: () => true },
  { label: "Vendas", icon: "fas fa-shopping-cart", hex: "#3b82f6", canView: (f) => !f.isMotorista },
  { label: "Clientes", icon: "fas fa-users", hex: "#10b981", canView: (f) => !f.isMotorista },
  { label: "Logística", icon: "fas fa-truck", hex: "#f97316", canView: () => true },
  { label: "Produtos & Estoque", icon: "fas fa-box", hex: "#f59e0b", canView: (f) => f.canAccessReports || f.isTelemarketing },
  { label: "Faturamento", icon: "fas fa-file-invoice", hex: "#a855f7", canView: (f) => f.canAccessReports || f.isVendedor || f.isTelemarketing },
  { label: "Financeiro", icon: "fas fa-dollar-sign", hex: "#f43f5e", canView: (f) => f.canAccessReports || f.isVendedor || f.isTelemarketing },
  { label: "Comunicação", icon: "fas fa-comments", hex: "#14b8a6", canView: (f) => f.canAccessReports || f.isTelemarketing || f.isVendedor },
  { label: "Agentes IA", icon: "fas fa-robot", hex: "#8b5cf6", canView: (f) => f.canAccessReports },
  { label: "Indústria", icon: "fas fa-industry", hex: "#059669", canView: (f) => f.canAccessIndustria },
  { label: "Relatórios", icon: "fas fa-chart-bar", hex: "#06b6d4", canView: (f) => f.canAccessReports },
  { label: "Administração", icon: "fas fa-cog", hex: "#6366f1", canView: (f) => f.canAccessReports || f.isVendedor },
];

export default function PersistentSectionSidebar() {
  const { user } = useAuth();
  const [location] = useLocation();
  const role = (user as any)?.role as string | undefined;

  const flags: RoleFlags = {
    canAccessReports: !!role && ["admin", "coordinator", "administrative"].includes(role),
    canAccessUsers: role === "admin",
    isVendedor: role === "vendedor",
    isTelemarketing: role === "telemarketing",
    isMotorista: role === "motorista",
    canAccessIndustria: !!role && ["admin", "industria"].includes(role),
  };

  const isMotorista = flags.isMotorista;
  const sections = SECTIONS.filter((s) => {
    if (isMotorista) return s.label === "Geral" || s.label === "Logística";
    return s.canView(flags);
  });

  const currentPath = location.split("?")[0].split("#")[0];

  return (
    <nav className="hidden md:flex flex-col w-[64px] bg-white shadow-sm border-r border-gray-200 flex-shrink-0 sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto z-30">
      <div className="flex-1 py-2 px-1.5 space-y-1">
        {sections.map((s) => {
          const href = s.label === "Geral" ? "/" : `/?secao=${encodeURIComponent(s.label)}`;
          return (
            <Link key={s.label} href={href}>
              <button
                title={s.label}
                data-testid={`persistent-section-${s.label.toLowerCase().replace(/[^a-z]/g, "-")}`}
                className="w-full flex flex-col items-center justify-center py-2 px-1 rounded-xl transition-all duration-200 hover:bg-gray-50"
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center mb-1 text-white"
                  style={{ backgroundColor: s.hex }}
                >
                  <i className={`${s.icon} text-sm`}></i>
                </div>
                <span className="text-[9px] font-medium leading-tight text-center text-gray-600 line-clamp-2">
                  {s.label}
                </span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
