// Recorrência de trocas (política de trocas, 30/10/2026): mesmo cliente + mesmo motivo
// em 60 dias. 2ª troca = aviso + "Ação com o cliente" obrigatória; 3ª ou mais = liberação
// no pipeline só por admin, com observação.
//  - TrocaRecorrenciaCard: no card de vendas, ao escolher o motivo (antes de finalizar)
//  - TrocaRecorrenciaPedido: no pedido do pipeline / bloqueados
import { useEffect } from "react";
import { useQuery } from "@/lib/queryClient";

interface Rec {
  motivoLabel: string; janelaDias: number; n: number; ordinal: string;
  ultimaData: string | null; acao?: string | null; valorTroca?: number; customerId: string;
  ultimaCompra: { data: string | null; valor: number; nf: string | null } | null;
  hist: Array<{ data: string; valor: number; itens: string; acao: string | null }>;
}

const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const linkExtrato = (cid: string) => `/extrato-cliente?customerId=${encodeURIComponent(cid)}&secao=trocas`;

async function buscar(qs: string): Promise<{ recorrencia: Rec | null; acoes?: string[] }> {
  const r = await fetch(`/api/trocas/recorrencia?${qs}`, { credentials: 'include' });
  if (!r.ok) return { recorrencia: null };
  return r.json();
}

function Valores({ rec, valorTroca }: { rec: Rec; valorTroca: number }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-md bg-white px-2 py-1.5">
        <div className="text-[11px] text-gray-600">Última compra{rec.ultimaCompra?.data ? ` · ${rec.ultimaCompra.data}` : ''}</div>
        <div className="text-base font-bold text-gray-900">{rec.ultimaCompra ? brl(rec.ultimaCompra.valor) : '—'}</div>
      </div>
      <div className="rounded-md bg-white px-2 py-1.5">
        <div className="text-[11px] text-gray-600">Esta troca</div>
        <div className="text-base font-bold text-red-700">{brl(valorTroca)}</div>
      </div>
    </div>
  );
}

function Historico({ rec }: { rec: Rec }) {
  if (!rec.hist?.length) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-white overflow-hidden">
      <div className="px-2 py-1 text-[11px] font-bold text-gray-700 bg-gray-50">Histórico deste motivo</div>
      {rec.hist.map((h, i) => (
        <div key={i} className="px-2 py-1.5 border-t text-xs">
          <div className="flex justify-between"><span className="font-semibold">{h.data}</span><span>{brl(h.valor)}</span></div>
          {h.itens && <div className="text-gray-700">{h.itens}</div>}
          {h.acao && <div className="text-gray-500">Ação: {h.acao}</div>}
        </div>
      ))}
      <div className="px-2 py-1 border-t">
        <a href={linkExtrato(rec.customerId)} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-green-800 underline">Ver no extrato do cliente</a>
      </div>
    </div>
  );
}

/** Card de vendas: mostra a recorrência e a picklist "Ação com o cliente" (obrigatória da 2ª em diante). */
export function TrocaRecorrenciaCard({ customerId, motivo, valorTroca, acao, onAcao, onExigeAcao }: {
  customerId?: string | null; motivo: string; valorTroca: number;
  acao: string; onAcao: (v: string) => void; onExigeAcao: (v: boolean) => void;
}) {
  const qs = `customerId=${encodeURIComponent(String(customerId || ''))}&motivo=${encodeURIComponent(motivo)}`;
  const { data } = useQuery({ queryKey: ['/api/trocas/recorrencia', qs], queryFn: () => buscar(qs), enabled: !!customerId && !!motivo, staleTime: 60000 });
  const rec = data?.recorrencia || null;
  const exige = !!rec && rec.n >= 2;
  useEffect(() => { onExigeAcao(exige); }, [exige]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rec) return null;
  if (!exige) {
    return rec.ultimaData ? (
      <p className="text-xs text-gray-700">Última troca por este motivo: <b>{rec.ultimaData}</b>.{' '}
        <a href={linkExtrato(rec.customerId)} target="_blank" rel="noopener noreferrer" className="underline">Ver no extrato do cliente</a></p>
    ) : null;
  }
  const acoes = data?.acoes || [];
  return (
    <div className="space-y-2" data-testid="troca-recorrencia">
      <div className="rounded-lg border-2 border-amber-500 bg-amber-100 p-2.5 space-y-2">
        <div>
          <div className="text-sm font-bold text-amber-900">{rec.ordinal} troca por {rec.motivoLabel} em {rec.janelaDias} dias</div>
          <div className="text-[13px] text-amber-900">Data última troca: <b className="text-[15px] text-gray-900">{rec.ultimaData}</b></div>
          <div className="text-[13px] text-amber-900">Informe a ação feita com o cliente.</div>
        </div>
        <Valores rec={rec} valorTroca={valorTroca} />
      </div>
      <Historico rec={rec} />
      <div>
        <label className="text-sm font-semibold">Ação com o cliente <span className="text-red-600">*</span></label>
        <select value={acao} onChange={(e) => onAcao(e.target.value)} data-testid="select-troca-acao"
          className="mt-1 w-full h-10 rounded-md border-2 border-amber-500 bg-white px-2 text-sm">
          <option value="">Selecione a ação…</option>
          {acoes.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      {rec.n >= 3 && <p className="text-xs font-semibold text-red-700">{rec.ordinal} troca: a liberação será feita só pelo admin.</p>}
    </div>
  );
}

/** Pedido no pipeline / bloqueados: faixa de recorrência, valores, histórico e ação informada. */
export function TrocaRecorrenciaPedido({ salesCardId }: { salesCardId: string }) {
  const qs = `salesCardId=${encodeURIComponent(salesCardId)}`;
  const { data } = useQuery({ queryKey: ['/api/trocas/recorrencia', qs], queryFn: () => buscar(qs), enabled: !!salesCardId, staleTime: 60000 });
  const rec = data?.recorrencia || null;
  if (!rec) return null;
  if (rec.n < 2) {
    return (
      <div className="mt-3 text-xs text-gray-700">
        Motivo: <b>{rec.motivoLabel}</b>{rec.ultimaData ? <> · última troca por este motivo em <b>{rec.ultimaData}</b> · <a href={linkExtrato(rec.customerId)} target="_blank" rel="noopener noreferrer" className="underline">ver no extrato</a></> : ' · 1ª troca por este motivo'}
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2" data-testid="pedido-troca-recorrencia">
      <div className="rounded-lg border-2 border-amber-500 bg-amber-100 p-2.5 space-y-2">
        <div>
          <div className="text-sm font-bold text-amber-900">{rec.ordinal} troca por {rec.motivoLabel} em {rec.janelaDias} dias</div>
          <div className="text-[13px] text-amber-900">Data última troca: <b className="text-[15px] text-gray-900">{rec.ultimaData}</b></div>
          {rec.n >= 3 && <div className="text-[13px] font-semibold text-amber-900">Liberação só por admin, com observação.</div>}
        </div>
        <Valores rec={rec} valorTroca={Number(rec.valorTroca || 0)} />
        <div className="text-[13px] text-amber-900">Ação informada pelo vendedor: <b>{rec.acao || 'não informada'}</b></div>
      </div>
      <Historico rec={rec} />
    </div>
  );
}
