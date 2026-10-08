import { useLocation } from "wouter";
import { Crosshair } from "lucide-react";

/**
 * Botão flutuante global "Consulta no local" — SÓ no celular (md:hidden).
 * Aparece em qualquer tela do app autenticado, para acesso rápido em campo,
 * exceto na própria página da consulta e na Rota do Dia (que já tem o seu FAB).
 */
const ROTAS_SEM_FAB = ["/consulta-local", "/rota-do-dia"];

export default function MobileConsultaFab() {
  const [location, navigate] = useLocation();
  if (ROTAS_SEM_FAB.some((p) => location === p || location.startsWith(p + "/"))) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => navigate("/consulta-local")}
      className="md:hidden fixed bottom-20 right-4 z-50 flex items-center gap-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-600/30 px-4 py-3 transition active:scale-95"
      aria-label="Consultar local"
      data-testid="fab-consulta-local-global"
    >
      <Crosshair className="h-5 w-5" />
      <span className="text-sm font-medium">Consultar local</span>
    </button>
  );
}
