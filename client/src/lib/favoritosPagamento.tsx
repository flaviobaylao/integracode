// Dados de pagamento salvos por favorecido (03/nov/2026) — usados por Reembolsos e Viagens.
// O servidor grava os dados a cada pedido enviado; aqui o formulário busca a lista do dono
// do pedido (mais recente primeiro). Desde 17/nov: nada é preenchido sozinho; os campos sugerem ao digitar.
import { useState } from "react";
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

// Campo com SUGESTÕES (17/nov/2026): nada é preenchido sozinho; conforme a pessoa digita
// o nome, o CPF/CNPJ ou a chave PIX, aparecem os favorecidos já usados que combinam, e
// escolher um completa o restante dos dados de pagamento.
const soDig = (v: string) => String(v || "").replace(/\D/g, "");
const semAcento = (v: string) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function sugestoesPara(lista: FavoritoPagamento[], campo: "nome" | "doc" | "chave", valor: string): FavoritoPagamento[] {
  const v = String(valor || "").trim();
  if (!v) return [];
  const vd = soDig(v), vt = semAcento(v);
  return lista.filter((f) => {
    if (campo === "nome") return semAcento(f.favorecidoNome).includes(vt) && semAcento(f.favorecidoNome) !== vt;
    if (campo === "doc") return !!vd && soDig(f.favorecidoDoc || "").startsWith(vd) && soDig(f.favorecidoDoc || "") !== vd;
    const k = String(f.pixChave || "");
    return !!k && (k.toLowerCase().startsWith(v.toLowerCase()) || (!!vd && soDig(k).startsWith(vd))) && k.toLowerCase() !== v.toLowerCase();
  }).slice(0, 6);
}
export function CampoComSugestao({ campo, lista, value, onValor, onEscolher, inputClassName = "", ...rest }: {
  campo: "nome" | "doc" | "chave"; lista: FavoritoPagamento[]; value: string; onValor: (v: string) => void; onEscolher: (f: FavoritoPagamento) => void;
  inputClassName?: string; placeholder?: string; inputMode?: any; "data-testid"?: string;
}) {
  const [aberto, setAberto] = useState(false);
  const sug = aberto ? sugestoesPara(lista, campo, value) : [];
  return (
    <span className="relative block">
      <input {...rest} value={value} autoComplete="off"
        onChange={(e) => { onValor(e.target.value); setAberto(true); }}
        onFocus={() => setAberto(true)} onBlur={() => setTimeout(() => setAberto(false), 150)}
        className={`flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${inputClassName}`} />
      {sug.length > 0 && (
        <span className="absolute z-40 left-0 mt-1 w-full min-w-[300px] max-w-[90vw] bg-white border rounded-lg shadow-lg overflow-hidden block" role="listbox">
          <span className="block px-3 py-1 text-[11px] font-normal text-muted-foreground bg-gray-50 border-b">Usados antes — toque para preencher o resto</span>
          {sug.map((f) => (
            <button key={f.id} type="button" role="option" data-testid="sugestao-favorito"
              onMouseDown={(e) => e.preventDefault()} onClick={() => { onEscolher(f); setAberto(false); }}
              className="block w-full text-left px-3 py-2 text-sm font-normal hover:bg-green-50">
              <b>{f.favorecidoNome}</b>{f.favorecidoDoc ? <span className="text-gray-500"> · {f.favorecidoDoc}</span> : null}
              <span className="block text-xs text-gray-500">{resumo(f) || "—"}{f.instancia ? ` · ${f.instancia}` : ""}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
