// Dados de pagamento salvos por favorecido (03/nov/2026) — usados por Reembolsos e Viagens.
// O servidor grava os dados a cada pedido enviado; aqui o formulário busca a lista do dono
// do pedido (mais recente primeiro) para preencher sozinho e permitir trocar de favorecido.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type FavoritoPagamento = {
  id: string; usos: number; favorecidoNome: string; favorecidoDoc?: string; forma?: string; instancia?: string;
  pixTipo?: string; pixChave?: string; pixTitular?: string; banco?: string; agencia?: string; conta?: string; tipoConta?: string;
};

export function useFavoritosPagamento(userId?: string | null) {
  return useQuery<FavoritoPagamento[]>({
    queryKey: ["/api/pagamento-favoritos", userId || "eu"],
    queryFn: () => apiRequest("GET", "/api/pagamento-favoritos" + (userId ? `?userId=${encodeURIComponent(userId)}` : "")),
    staleTime: 60000,
  });
}

const resumo = (f: FavoritoPagamento) =>
  f.forma === "pix" ? `PIX ${f.pixTipo || ""} ${f.pixChave || ""}`.trim()
    : f.forma === "transferencia" ? `${f.banco || "banco"} ag ${f.agencia || "?"} cc ${f.conta || "?"}`
      : f.forma === "dinheiro" ? "Dinheiro (Caixinha)" : "";

export function SeletorFavorito({ lista, atualId, onEscolher, onLimpar }: {
  lista: FavoritoPagamento[]; atualId: string | null; onEscolher: (f: FavoritoPagamento) => void; onLimpar: () => void;
}) {
  if (!lista.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm">
      <span className="font-semibold text-emerald-900">Dados salvos:</span>
      <select className="h-9 min-w-0 max-w-full rounded-md border bg-white px-2 text-sm" value={atualId || ""} data-testid="select-favorito"
        onChange={(e) => { const f = lista.find((x) => x.id === e.target.value); if (f) onEscolher(f); else onLimpar(); }}>
        <option value="">Preencher outro (novo favorecido)</option>
        {lista.map((f) => <option key={f.id} value={f.id}>{f.favorecidoNome}{resumo(f) ? ` — ${resumo(f)}` : ""}</option>)}
      </select>
      {atualId && <span className="text-[11px] text-emerald-800">preenchido com os dados do último pedido · confira antes de enviar</span>}
    </div>
  );
}
