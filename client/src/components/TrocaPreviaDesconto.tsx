// Prévia do desconto de comissão na TROCA POR VENCIMENTO, exibida no card de vendas
// antes de finalizar (política de trocas). Mesma conta do registro definitivo:
// desconto de quem registra a troca, pelo preço e % da última NF que ELE faturou ao cliente.
import { useQuery } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

interface Previa {
  valorTroca: number; pct: number; desconto: number;
  nfNumero: string | null; nfData: string | null; nfSellerName: string | null; nfDoVendedor?: boolean;
  itens: Array<{ produto: string; quantidade: number; precoUnit: number; fontePreco: string }>;
}

const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const dataBR = (s?: string | null) => (s ? s.split('-').reverse().join('/') : '');

export default function TrocaPreviaDesconto({ cardId, products }: { cardId?: string; products: any[] }) {
  const itens = (products || []).map((p: any) => ({ id: p.id, name: p.name, quantity: Number(p.quantity) || 0, unitPrice: Number(p.unitPrice) || 0 }));
  const chave = JSON.stringify(itens.map((i) => [i.id, i.quantity]));
  const { data, isFetching, isError } = useQuery<Previa>({
    queryKey: ['/api/sales-cards/troca-previa', cardId, chave],
    queryFn: async () => {
      const r = await fetch(`/api/sales-cards/${cardId}/troca-previa`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: itens }),
      });
      if (!r.ok) throw new Error('falha');
      return r.json();
    },
    enabled: !!cardId,
    staleTime: 30000,
  });

  return (
    <div className="rounded-lg border-2 border-red-300 bg-white p-3 space-y-2" data-testid="previa-desconto-troca">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-red-700">Desconto na comissão do vendedor</p>
        {isFetching && <Loader2 className="h-4 w-4 animate-spin text-red-600" />}
      </div>
      <p className="text-xs text-gray-700">
        Troca por vencimento. A comissão sobre o valor trocado será descontada da comissão do mês, no fechamento.
      </p>
      {itens.length === 0 ? (
        <p className="text-xs text-gray-500">Adicione os produtos da troca para calcular o desconto.</p>
      ) : isError ? (
        <p className="text-xs text-red-600">Não foi possível calcular a prévia agora. O desconto será calculado ao finalizar.</p>
      ) : data ? (
        <div className="text-sm divide-y">
          {data.nfSellerName && <div className="flex justify-between py-1"><span className="text-gray-600">Vendedor descontado</span><span className="font-medium">{data.nfSellerName}</span></div>}
          <div className="flex justify-between py-1"><span className="text-gray-600">{data.nfDoVendedor ? 'Sua última NF para o cliente' : 'Última NF do cliente (outro vendedor)'}</span><span className="font-medium">{data.nfNumero ? `NF ${data.nfNumero} · ${dataBR(data.nfData)}` : 'sem NF (preço do card)'}</span></div>
          <div className="flex justify-between py-1"><span className="text-gray-600">Valor da troca</span><span className="font-medium">{brl(data.valorTroca)}</span></div>
          <div className="flex justify-between py-1"><span className="text-gray-600">{data.nfDoVendedor ? 'Sua comissão na NF' : 'Sua comissão no mês'}</span><span className="font-medium">{String(Number(data.pct || 0).toFixed(2)).replace('.', ',')}%</span></div>
          <div className="flex justify-between pt-2"><span className="font-bold text-red-700">Desconto</span><span className="font-bold text-red-700 text-base">− {brl(data.desconto)}</span></div>
        </div>
      ) : null}
    </div>
  );
}
