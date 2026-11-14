import { useEffect, useState, type RefObject } from "react";
import { Link, useLocation } from "wouter";
import { ChevronRight } from "lucide-react";
import { pageInfoFor } from "@/lib/sectionNav";

// (05/nov/2026) Caminho sequencial de abertura exibido acima do titulo de todas as
// telas de modulo: "Integra2.0 > Logistica > Entregas do Dia".
// - Integra2.0 leva ao Dashboard; a secao leva ao grid da secao (/?secao=...).
// - O nome da tela vem do menu; se a rota nao estiver no menu, usa o h1 da tela.
// (14/nov/2026) Depois do nome da tela vem a ABA aberta no momento, quando a tela tem
// abas: "Vendas > Metas de Vendas > Clientes blindados". Troca junto com a aba.
// Le a primeira barra de abas (Radix/shadcn: role="tab" + data-state="active") dentro
// do conteudo, entao vale para toda tela que usa <Tabs> sem precisar alterar a tela.
export default function PageBreadcrumb({ contentRef }: { contentRef: RefObject<HTMLElement> }) {
  const [location] = useLocation();
  const search = typeof window !== "undefined" ? window.location.search : "";
  const { label, group } = pageInfoFor(location, search);
  const [fallback, setFallback] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);

  useEffect(() => {
    setFallback(null);
    if (label) return;
    const el = contentRef.current;
    if (!el) return;
    const read = () => {
      const h = el.querySelector("h1");
      const t = h?.textContent?.trim();
      if (t) { setFallback(t.length > 60 ? t.slice(0, 60) + "…" : t); return true; }
      return false;
    };
    if (read()) return;
    const obs = new MutationObserver(() => { if (read()) obs.disconnect(); });
    obs.observe(el, { childList: true, subtree: true });
    const timer = setTimeout(() => obs.disconnect(), 8000);
    return () => { obs.disconnect(); clearTimeout(timer); };
  }, [location, search, label, contentRef]);

  // Aba ativa da primeira barra de abas da tela (ignora abas aninhadas dentro de cards).
  useEffect(() => {
    setTab(null);
    const el = contentRef.current;
    if (!el) return;
    const read = () => {
      const list = el.querySelector('[role="tablist"]');
      const active = list?.querySelector('[role="tab"][data-state="active"]');
      const t = active?.textContent?.trim() || null;
      setTab(t ? (t.length > 60 ? t.slice(0, 60) + "…" : t) : null);
    };
    read();
    // childList/subtree: a barra de abas aparece depois do carregamento da tela;
    // attributes data-state: o Radix troca active/inactive ao clicar em outra aba.
    const obs = new MutationObserver(read);
    obs.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
    return () => obs.disconnect();
  }, [location, search, contentRef]);

  const page = label || fallback;
  const sep = <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />;

  return (
    <nav aria-label="Caminho" data-testid="page-breadcrumb"
      className="flex items-center gap-1.5 flex-wrap px-6 pt-3 pb-1 text-sm text-gray-500">
      <Link href="/" className="hover:text-emerald-700 hover:underline font-medium">Integra2.0</Link>
      {group ? (<>{sep}<Link href={`/?secao=${encodeURIComponent(group)}`} className="hover:text-emerald-700 hover:underline">{group}</Link></>) : null}
      {page ? (<>{sep}<span className={tab ? "" : "text-gray-800 font-medium"} aria-current={tab ? undefined : "page"}>{page}</span></>) : null}
      {page && tab ? (<>{sep}<span className="text-gray-800 font-medium" aria-current="page" data-testid="breadcrumb-tab">{tab}</span></>) : null}
    </nav>
  );
}
