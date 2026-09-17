import { useQuery } from "@tanstack/react-query";

export type Instancia = { id: string; nome: string; apelido?: string | null; cnpj?: string | null; ativa?: boolean };

export function useInstancias() {
  return useQuery<Instancia[]>({
    queryKey: ["/api/contabilidade/instancias"],
    queryFn: async () => {
      const r = await fetch("/api/contabilidade/instancias", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60 * 1000,
  });
}

// Filtro de instância compartilhado pelas abas Fiscal e Contábil.
// Multisseleção por botões (nenhuma selecionada = todas).
export default function FiltroInstancia({
  valor,
  aoMudar,
}: {
  valor: string[];
  aoMudar: (ids: string[]) => void;
}) {
  const { data: instancias = [], isLoading } = useInstancias();

  const alterna = (id: string) => {
    aoMudar(valor.includes(id) ? valor.filter((v) => v !== id) : [...valor, id]);
  };

  if (isLoading) return <div className="text-sm text-gray-400">Carregando instâncias…</div>;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filtro-instancia">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Instância</span>
      <button
        type="button"
        onClick={() => aoMudar([])}
        className={`px-3 py-1 rounded-full text-sm border transition ${
          valor.length === 0 ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
        }`}
        data-testid="filtro-instancia-todas"
      >
        Todas
      </button>
      {instancias.map((i) => (
        <button
          key={i.id}
          type="button"
          onClick={() => alterna(i.id)}
          title={i.cnpj || undefined}
          className={`px-3 py-1 rounded-full text-sm border transition ${
            valor.includes(i.id) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
          }`}
          data-testid={`filtro-instancia-${i.id}`}
        >
          {i.apelido || i.nome}
        </button>
      ))}
    </div>
  );
}
