import { Link, useLocation } from "wouter";
import { Home, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { groupForPath } from "@/lib/sectionNav";

// (05/jul/2026) Alem de "Voltar ao Dashboard", mostra um botao "Voltar para <secao>"
// que leva a pagina inicial (grid de cards) da secao do sidebar a que a pagina pertence.
// A Home/Layout le ?secao=<grupo> e abre a secao correspondente.
export default function BackToDashboardButton() {
  const [location] = useLocation();
  const group = groupForPath(location);
  return (
    <div className="flex items-center gap-2">
      {group ? (
        <Link href={`/?secao=${encodeURIComponent(group)}`}>
          <Button variant="outline" size="sm" className="flex items-center gap-2" data-testid="button-back-section">
            <ChevronLeft className="w-4 h-4" />
            Voltar para {group}
          </Button>
        </Link>
      ) : null}
      <Link href="/">
        <Button variant="outline" size="sm" className="flex items-center gap-2" data-testid="button-back-dashboard">
          <Home className="w-4 h-4" />
          Voltar ao Dashboard
        </Button>
      </Link>
    </div>
  );
}
