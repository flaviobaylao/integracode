import { Link } from "wouter";
import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { MENU_ITEM_INDEX, resolveMenuHref } from "@/lib/menuItems";
import integraLogo from "@assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png";

// (15/jul/2026) Cabeçalho persistente exibido em todas as páginas de módulo
// (rotas fora do Layout do Dashboard), junto com a sidebar de seções persistente.
// Mostra o logo, os atalhos favoritos (até 7, centralizados), o "Ver como" (só
// admin) e o usuário — igual ao topo do Dashboard — para que fique sempre visível.
const FAVORITES_KEY = "integra_favorites";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  coordinator: "Coordenador",
  administrative: "Administrativo",
  vendedor: "Vendedor",
  telemarketing: "Telemarketing",
  motorista: "Motorista",
  industria: "Indústria",
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

  // Solicitações de Alteração pendentes (inbox) — badge no atalho (admin).
  const [pendingCR, setPendingCR] = useState(0);
  useEffect(() => {
    if ((user as any)?.role !== 'admin') { setPendingCR(0); return; }
    let alive = true;
    const load = () => fetch('/api/change-requests', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (alive && d && typeof d.pendingCount === 'number') setPendingCR(d.pendingCount); })
      .catch(() => { /* noop */ });
    load();
    const iv = setInterval(() => { if (alive && document.visibilityState !== 'hidden') load(); }, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [user]);

  const u = user as any;
  const roleLabel = u?._perfilIndustria ? ROLE_LABELS.industria : (u?.role ? (ROLE_LABELS[u.role] || u.role) : "");

  // Atalhos exibidos no cabeçalho: fixa o Inbox de Solicitações de Alteração
  // (admin) sempre visível e limita a 10 atalhos no total.
  const isAdmin = u?.role === 'admin';
  const _favs = favorites.filter((f) => f !== 'solicitacoes-alteracao');
  const shortcutIds = isAdmin ? [..._favs.slice(0, 9), 'solicitacoes-alteracao'] : _favs.slice(0, 10);

  // 🔁 "Entrar como" (impersonação de admin) — só admin REAL ativa; sempre dá para voltar.
  const realRole = u?._realRole || u?.role;
  const isRealAdmin = realRole === 'admin';
  const impersonatingRole = u?._impersonatingRole as string | undefined;
  const [verComoUsers, setVerComoUsers] = useState<any[]>([]);
  useEffect(() => {
    if (!isRealAdmin) return;
    let alive = true;
    fetch('/api/users', { credentials: 'include' }).then((r) => r.ok ? r.json() : []).then((list) => { if (alive && Array.isArray(list)) setVerComoUsers(list); }).catch(() => {});
    return () => { alive = false; };
  }, [isRealAdmin]);
  const VER_COMO_ORDER = ['vendedor', 'telemarketing', 'coordinator', 'administrative', 'motorista', 'industria'];
  const usersByRole = VER_COMO_ORDER.map((r) => [r, verComoUsers.filter((x: any) => x && x.role === r && x.role !== 'admin' && (r !== 'vendedor' || x.isActive !== false)).sort((a: any, b: any) => (((a.firstName || '') + ' ' + (a.lastName || '')).localeCompare((b.firstName || '') + ' ' + (b.lastName || '')))) ] as [string, any[]]).filter(([, list]) => list.length > 0);
  const verComo = async (userId: string) => {
    if (!userId) return;
    try {
      await fetch('/api/admin/impersonate', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
      window.location.reload();
    } catch { /* noop */ }
  };
  const voltarAdmin = async () => {
    try {
      await fetch('/api/admin/impersonate/stop', { method: 'POST', credentials: 'include' });
      window.location.reload();
    } catch { /* noop */ }
  };

  return (
    <div className="sticky top-0 z-40">
      {impersonatingRole && (
        <div className="bg-amber-500 text-white px-4 py-2 text-sm flex items-center justify-center gap-3">
          <i className="fas fa-user-secret"></i>
          <span>Você está vendo o sistema como <b>{ROLE_LABELS[impersonatingRole] || impersonatingRole}</b> (visão de administrador).</span>
          <button onClick={voltarAdmin} className="ml-2 bg-white text-amber-700 font-semibold rounded px-3 py-1 text-xs hover:bg-amber-50" data-testid="button-voltar-admin">
            Voltar para Administrador
          </button>
        </div>
      )}
      <header className="relative bg-white shadow-sm border-b border-gray-200 px-4 md:px-6 h-14 flex items-center justify-between flex-shrink-0">
        <Link href="/">
          <div className="flex items-center space-x-3 cursor-pointer" title="Ir para o Dashboard">
            <img src={integraLogo} alt="Honest Sucos - Sistema Integra" className="w-9 h-9" />
            <h1 className="text-base md:text-xl font-bold text-gray-800 hidden sm:block">Sistema Integra</h1>
          </div>
        </Link>

        {/* Atalhos (até 10) — sempre centralizados no cabeçalho */}
        <div className="hidden md:flex items-center gap-2 absolute left-1/2 -translate-x-1/2">
          {shortcutIds.map((favId) => {
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
                  {favId === 'solicitacoes-alteracao' && pendingCR > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
                      {pendingCR}
                    </span>
                  )}
                </button>
              </Link>
            );
          })}
        </div>

        <div className="flex items-center space-x-3">
          {isRealAdmin && !impersonatingRole && (
            <select
              defaultValue=""
              onChange={(e) => { const v = e.target.value; if (v) verComo(v); }}
              title="Entrar como — ver o sistema com a visão de outra função"
              className="text-xs border border-gray-300 rounded px-2 py-1 text-gray-700 bg-white cursor-pointer"
              data-testid="select-ver-como"
            >
              <option value="">Ver como…</option>
              {usersByRole.map(([r, list]) => (
                <optgroup key={r} label={ROLE_LABELS[r] || r}>
                  {list.map((usr: any) => (<option key={usr.id} value={usr.id}>{[usr.firstName, usr.lastName].filter(Boolean).join(' ') || usr.email || usr.id}</option>))}
                </optgroup>
              ))}
            </select>
          )}
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
    </div>
  );
}
