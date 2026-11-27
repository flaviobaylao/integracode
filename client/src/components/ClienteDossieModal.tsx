import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BookUser, Loader2, Trophy, UserCheck, UserMinus } from "lucide-react";

/**
 * DOSSIÊ DO CLIENTE (nov/2026) — aberto pelo botão "Dossiê do Cliente" da caixa
 * "Ações do Cliente" (Clientes Ativos, Gestão de Carteiras, Mapa, Inbox).
 * Mostra a data de conquista, os dois últimos vendedores (o anterior com a data
 * final e o atual) e um relato curto do cliente dentro do Integra.
 * Dados: GET /api/clientes/:id/dossie (somente leitura).
 */

type Dossie = {
  cliente: { id: string; nome: string; razao: string; documento: string; cidade: string; ativo: boolean };
  conquista: { data: string | null; cadastroEm: string | null; primeiraVenda: string | null };
  vendedores: {
    atual: { nome: string; desde: string | null; fonte: string; pedidos: number; ultimoPedido: string | null };
    anterior: { nome: string; ate: string | null; fonte: string; pedidos: number | null; ultimoPedido: string | null } | null;
  };
  linhaDoTempo: Array<{ nome: string; primeira: string | null; ultima: string | null; pedidos: number }>;
  trocasRegistradas: Array<{ de: string; para: string; data: string | null; quem: string | null }>;
  resumo: null | { classe: string; total: number; mesesComCompra: number; ultimaVendaData: string | null; ultimaVendaValor: number; debito: number; situacao: string };
  relato: string[];
};

const br = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const fmtDoc = (d: string) =>
  d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
  : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") : d;

export default function ClienteDossieModal({
  open,
  onClose,
  customerId,
  customerName,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string | null;
  customerName?: string | null;
}) {
  const { data, isLoading, error } = useQuery<Dossie>({
    queryKey: ["/api/clientes", customerId, "dossie"],
    enabled: open && !!customerId,
    staleTime: 60 * 1000,
    retry: false,
  });

  const nome = data?.cliente?.nome || customerName || "Cliente";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[88vh] overflow-y-auto" data-testid="dossie-cliente">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookUser className="h-5 w-5 text-teal-600" /> Dossiê do Cliente
          </DialogTitle>
        </DialogHeader>

        <div className="text-center -mt-1">
          <p className="font-semibold text-lg leading-tight">{nome}</p>
          {data && (
            <p className="text-xs text-muted-foreground">
              {[data.cliente.cidade, data.cliente.documento ? fmtDoc(data.cliente.documento) : ""].filter(Boolean).join(" · ")}
              {!data.cliente.ativo && <span className="ml-2 text-red-600 font-semibold">INATIVO</span>}
            </p>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Montando o dossiê…
          </div>
        )}
        {error && !isLoading && (
          <p className="text-sm text-red-600 text-center py-6">
            {String((error as any)?.message || "").replace(/^\d+:\s*/, "").replace(/^\{"message":"(.*)"\}$/, "$1") || "Não foi possível carregar o dossiê."}
          </p>
        )}

        {data && (
          <div className="space-y-4 py-1">
            {/* Conquista */}
            <div className="rounded-lg border p-3 flex items-start gap-3" data-testid="dossie-conquista">
              <Trophy className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
              <div className="text-sm">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Data de conquista</p>
                <p className="font-semibold text-base">{br(data.conquista.data)}</p>
                <p className="text-xs text-muted-foreground">
                  1ª venda: {br(data.conquista.primeiraVenda)} · cadastro: {br(data.conquista.cadastroEm)}
                </p>
              </div>
            </div>

            {/* Vendedores */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border p-3" data-testid="dossie-vendedor-anterior">
                <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <UserMinus className="h-3.5 w-3.5" /> Vendedor anterior
                </p>
                {data.vendedores.anterior ? (
                  <>
                    <p className="font-semibold">{data.vendedores.anterior.nome}</p>
                    <p className="text-sm">até <b>{br(data.vendedores.anterior.ate)}</b></p>
                    <p className="text-[11px] text-muted-foreground">
                      {data.vendedores.anterior.pedidos ? `${data.vendedores.anterior.pedidos} pedido(s) · ` : ""}fonte: {data.vendedores.anterior.fonte}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground mt-1">Nenhum outro vendedor registrado.</p>
                )}
              </div>
              <div className="rounded-lg border p-3 border-teal-300 bg-teal-50/50 dark:bg-teal-900/10" data-testid="dossie-vendedor-atual">
                <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <UserCheck className="h-3.5 w-3.5" /> Vendedor atual
                </p>
                <p className="font-semibold">{data.vendedores.atual.nome}</p>
                <p className="text-sm">desde <b>{br(data.vendedores.atual.desde)}</b></p>
                <p className="text-[11px] text-muted-foreground">
                  {data.vendedores.atual.pedidos ? `${data.vendedores.atual.pedidos} pedido(s) · ` : ""}{data.vendedores.atual.fonte ? `fonte: ${data.vendedores.atual.fonte}` : ""}
                </p>
              </div>
            </div>

            {/* Relato */}
            <div className="rounded-lg border p-3" data-testid="dossie-relato">
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Relato do cliente no Integra</p>
              <ul className="text-sm space-y-1 list-disc pl-4">
                {data.relato.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>

            {/* Histórico de vendedores pelos pedidos */}
            {data.linhaDoTempo.length > 0 && (
              <details className="rounded-lg border p-3 text-sm">
                <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground">
                  Vendedores pelos pedidos ({data.linhaDoTempo.length})
                </summary>
                <table className="w-full mt-2 text-xs">
                  <thead>
                    <tr className="text-muted-foreground text-left">
                      <th className="py-1">Vendedor</th><th>1º pedido</th><th>Último pedido</th><th className="text-right">Pedidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.linhaDoTempo.map((v, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1">{v.nome}</td><td>{br(v.primeira)}</td><td>{br(v.ultima)}</td><td className="text-right">{v.pedidos}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.trocasRegistradas.length > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Trocas de carteira registradas:{" "}
                    {data.trocasRegistradas.map((t, i) => (
                      <span key={i}>{i > 0 ? "; " : ""}{br(t.data)} {t.de} → {t.para}{t.quem ? ` (por ${t.quem})` : ""}</span>
                    ))}
                  </div>
                )}
              </details>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
