import { Link } from "wouter";
import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { MENU_ITEM_INDEX, resolveMenuHref } from "@/lib/menuItems";
import integraLogo from "@assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png";

// (15/jul/2026) Cabeçalho persistente exibido em todas as páginas de módulo
// (rotas fora do Layout do Dashboard), junto com a sidebar de seções persistente.
// Mostra o logo, os atalhos favoritos (até 7) e o usuário — igual ao topo do
// Dashboard — para que fique sempre visível.
const FAVORITES_KEY = "integra_favorites";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  coordinator: "Coordenador",
  administrative: "Administrativo",
  vendedor: "Vendedor",
  telemarketing: "Telemarketing",
  motorista: "Motorista",
};

export default function PersistentHeader() {
  const { user } = useAuth();
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    const load = () => {
      try { setFavorites(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")); } catch { /* noop */ }
    };
    load();
    // Persistência por USUÁRIO (servidor): hidrata os favoritos salvos na conta.
    fetch('/api/user/favorites', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d && Array.isArray(d.favorites) && d.favorites.length > 0) { setFavorites(d.favorites); try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(d.favorites)); } catch { /* noop */ } } })
      .catch(() => { /* noop */ });
    window.addEventListener("storage", load);
    return () => window.removeEventListener("storage", load);
  }, []);

  const u = user as any;
  const roleLabel = u?.role ? (ROLE_LABELS[u.role] || u.role) : "";

  return (
    <header className="bg-white shadow-sm border-b border-gray-200 px-4 md:px-6 h-14 flex items-center justify-between flex-shrink-0 sticky top-0 z-40">
      <Link href="/">
        <div className="flex items-center space-x-3 cursor-pointer" title="Ir para o Dashboard">
          <img src={integraLogo} alt="Honest Sucos - Sistema Integra" className="w-9 h-9" />
          <h1 className="text-base md:text-xl font-bold text-gray-800 hidden sm:block">Sistema Integra</h1>
        </div>
      </Link>

      {/* Atalhos favoritos (até 7) */}
      <div className="hidden md:flex flex-1 items-center justify-center gap-2 px-4">
        {favorites.map((favId) => {
          const info = MENU_ITEM_INDEX[favId];
          if (!info) return null;
          return (
            <Link key={favId} href={resolveMenuHref(favId)}>
              <button
                title={info.label}
                data-testid={`fav-shortcut-header-${favId}`}
                className="relative w-10 h-10 rounded-lg flex items-center justify-center transition-transform hover:scale-110 shadow-sm"
                style={{ backgroundColor: `${info.hexColor}15`, color: info.hexColor }}
              >
                <i className={`${info.icon} text-base`}></i>
              </button>
            </Link>
          );
        })}
      </div>

      <div className="flex items-center space-x-3">
        <div className="text-right hidden sm:block">
          <p className="text-sm font-medium text-gray-800">
            {u?.firstName} {u?.lastName}
          </p>
          <p className="text-xs text-gray-600">{roleLabel}</p>
        </div>
        <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center overflow-hidden">
          {u?.profileImageUrl ? (
            <img src={u.profileImageUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <i className="fas fa-user text-gray-600"></i>
          )}
        </div>
        <button
          onClick={() => { window.location.href = "/api/logout"; }}
          title="Sair"
          className="p-2 rounded hover:bg-gray-100"
          data-testid="header-logout"
        >
          <i className="fas fa-sign-out-alt text-gray-600"></i>
        </button>
      </div>
    </header>
  );
}
