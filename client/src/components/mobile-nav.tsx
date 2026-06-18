/**
 * components/mobile-nav.tsx
 * ============================================================
 * Barra de navegação inferior para mobile (vendedores em campo)
 *
 * Aparece apenas em telas < 768px.
 * Destaca o item ativo com verde esmeralda + indicador.
 * Respeita safe-area do iOS (notch/home indicator).
 * ============================================================
 */

import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  CreditCard,
  Users,
  MapPin,
  ClipboardList,
} from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Roles que podem ver este item; undefined = todos */
  roles?: string[];
}

const SELLER_NAV_ITEMS: NavItem[] = [
  {
    label: "Início",
    href: "/",
    icon: LayoutDashboard,
  },
  {
    label: "Cards",
    href: "/cards",
    icon: CreditCard,
  },
  {
    label: "Clientes",
    href: "/customers",
    icon: Users,
  },
  {
    label: "Rota",
    href: "/route",
    icon: MapPin,
  },
  {
    label: "Pedidos",
    href: "/orders",
    icon: ClipboardList,
  },
];

interface MobileNavProps {
  className?: string;
}

export function MobileNav({ className }: MobileNavProps) {
  const [location, navigate] = useLocation();

  return (
    <nav
      className={cn(
        // Visível apenas em mobile
        "fixed bottom-0 left-0 right-0 z-50 md:hidden",
        // Aparência dark elegante
        "bg-[hsl(222_47%_5%/0.95)] backdrop-blur-xl",
        "border-t border-[hsl(222_25%_13%)]",
        // Safe area iOS
        "safe-bottom pb-1",
        className
      )}
      aria-label="Navegação principal"
    >
      <ul className="flex items-stretch h-16">
        {SELLER_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          // Match exato para raiz, prefixo para demais
          const isActive =
            item.href === "/"
              ? location === "/"
              : location.startsWith(item.href);

          return (
            <li key={item.href} className="flex-1">
              <button
                onClick={() => navigate(item.href)}
                className={cn(
                  "relative flex flex-col items-center justify-center gap-0.5",
                  "w-full h-full px-1 py-2",
                  "text-xs font-medium transition-all duration-200",
                  "active:scale-90 touch-manipulation",
                  isActive
                    ? "text-emerald-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-current={isActive ? "page" : undefined}
              >
                {/* Indicador ativo */}
                {isActive && (
                  <span
                    className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-emerald-400 rounded-full"
                    aria-hidden
                  />
                )}

                {/* Ícone com glow quando ativo */}
                <span
                  className={cn(
                    "flex items-center justify-center w-8 h-8 rounded-xl transition-all duration-200",
                    isActive && "bg-emerald-400/10"
                  )}
                >
                  <Icon
                    className={cn(
                      "w-5 h-5 transition-all duration-200",
                      isActive && "drop-shadow-[0_0_6px_hsl(158_64%_52%/0.6)]"
                    )}
                  />
                </span>

                {/* Label */}
                <span
                  className={cn(
                    "transition-all duration-200 leading-none",
                    isActive ? "font-semibold" : "font-normal"
                  )}
                >
                  {item.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Padding-bottom para o conteúdo principal não ficar atrás da
 * bottom nav em mobile. Adicione ao wrapper da página principal.
 *
 * Uso:
 *   <main className={cn("...", MOBILE_NAV_PADDING)}>
 */
export const MOBILE_NAV_PADDING = "pb-20 md:pb-0";
