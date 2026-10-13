// DESCONTO EXTRA NO BOLETO (13/out/2026) — bloco do modal "Detalhes do Pedido" do
// Pipeline de Faturamento. Valor em R$ que vale só para o boleto do pedido (a NF-e
// sai com o valor cheio) e SOMA com o "Desconto de Cobrança (%)" do cadastro do
// cliente. Quem lança fica registrado. Regra no servidor: server/boleto-desconto-pipeline.ts
import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { toast } from '@/hooks/use-toast';
import { Ticket, Lock } from 'lucide-react';

const brl = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dtBR = (s: any) => {
  try { return new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(s || ''); }
};
const FORMA: Record<string, string> = { boleto: 'Boleto', pix: 'PIX', a_vista: 'À vista', dinheiro: 'Dinheiro', card: 'Cartão', cartao: 'Cartão' };

function msgErro(e: any): string {
  const raw = String(e?.message || e || 'Erro');
  const m = raw.match(/\{[\s\S]*\}$/);
  if (m) { try { const j = JSON.parse(m[0]); if (j?.message) return j.message; } catch {} }
  return raw.replace(/^\d{3}:\s*/, '');
}

export default function DescontoBoletoBox({ itemId, canEdit, operationType }: { itemId: string; canEdit: boolean; operationType?: string | null }) {
  const qk = ['/api/billing-pipeline', itemId, 'desconto-boleto'];
  const { data, isLoading } = useQuery<any>({
    queryKey: qk,
    queryFn: async () => await apiRequest('GET', `/api/billing-pipeline/${itemId}/desconto-boleto`),
    staleTime: 0,
  });
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [editando, setEditando] = useState(false);

  useEffect(() => {
    setValor(data?.ativo ? String(data.ativo.valor.toFixed(2)).replace('.', ',') : '');
    setMotivo(data?.ativo?.motivo || '');
    setEditando(false);
  }, [data?.ativo?.id, itemId]);

  const salvar = useMutation({
    mutationFn: async (v: { valor: string; motivo: string }) =>
      await apiRequest('PUT', `/api/billing-pipeline/${itemId}/desconto-boleto`, v),
    onSuccess: (r: any) => {
      queryClient.setQueryData(qk, (old: any) => ({ ...(old || {}), ...r }));
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline', 'card-notes', itemId] });
      setEditando(false);
      toast({ title: r?.ativo ? `Desconto no boleto: ${brl(r.ativo.valor)}` : 'Desconto no boleto removido' });
    },
    onError: (e: any) => toast({ title: 'Não foi possível salvar o desconto', description: msgErro(e), variant: 'destructive' }),
  });

  if (String(operationType || 'venda').toLowerCase() !== 'venda') return null;
  if (isLoading || !data) return null;

  const ativo = data.ativo;
  const pv = data.preview || {};
  const travado = !!data.travado;
  const valorDigitado = (() => {
    const t = valor.trim().replace(/\s/g, '');
    if (!t) return 0;
    const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
    return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
  })();
  const extra = editando ? valorDigitado : (ativo?.valor || 0);
  const boleto = Math.round(((pv.total || 0) - (pv.cadastroValor || 0) - extra) * 100) / 100;
  const historicoAntigo = (data.historico || []).filter((h: any) => !h.ativo);

  return (
    <div className="rounded-lg p-4 border border-amber-200 bg-amber-50 dark:bg-amber-950/20" data-testid="box-desconto-boleto">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Ticket className="h-4 w-4 text-amber-700" />
          <span className="font-semibold text-sm text-amber-900 dark:text-amber-200">Desconto no boleto</span>
          {travado && <span className="flex items-center gap-1 text-[10px] text-gray-500"><Lock className="h-3 w-3" /> pedido já faturado</span>}
        </div>
        {canEdit && !travado && !editando && (
          <button className="text-xs text-amber-800 underline" onClick={() => setEditando(true)} data-testid="btn-editar-desconto-boleto">
            {ativo ? 'Alterar' : 'Lançar desconto'}
          </button>
        )}
      </div>

      {editando ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-amber-700 font-medium">Valor (R$)</label>
            <input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00"
              className="w-full border rounded px-2 py-1 text-sm" data-testid="input-desconto-boleto" autoFocus />
          </div>
          <div className="sm:col-span-2">
            <label className="text-[10px] uppercase tracking-wider text-amber-700 font-medium">Motivo (opcional)</label>
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500}
              placeholder="Ex.: acordo comercial, crédito de troca…" className="w-full border rounded px-2 py-1 text-sm" />
          </div>
          <div className="sm:col-span-3 flex gap-2 justify-end">
            <button className="text-xs px-3 py-1 rounded border" onClick={() => { setEditando(false); setValor(ativo ? String(ativo.valor.toFixed(2)).replace('.', ',') : ''); setMotivo(ativo?.motivo || ''); }}>Cancelar</button>
            {ativo && (
              <button className="text-xs px-3 py-1 rounded border border-red-300 text-red-700" disabled={salvar.isPending}
                onClick={() => salvar.mutate({ valor: '0', motivo: '' })}>Remover desconto</button>
            )}
            <button className="text-xs px-3 py-1 rounded bg-amber-600 text-white disabled:opacity-50" disabled={salvar.isPending}
              onClick={() => salvar.mutate({ valor, motivo })} data-testid="btn-salvar-desconto-boleto">
              {salvar.isPending ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      ) : ativo ? (
        <p className="text-xs text-amber-900 mb-2">
          <b>{brl(ativo.valor)}</b> lançado por <b>{ativo.userName || ativo.userEmail || '—'}</b> em {dtBR(ativo.createdAt)}
          {ativo.motivo ? <> — <i>{ativo.motivo}</i></> : null}
          {ativo.aplicadoReceivableId ? <span className="ml-1 text-green-700">· aplicado no título</span> : null}
        </p>
      ) : (
        <p className="text-xs text-gray-500 mb-2">Nenhum desconto extra lançado para o boleto deste pedido.</p>
      )}

      {(extra > 0 || (pv.cadastroValor || 0) > 0) && (
        <div className="text-xs bg-white/70 dark:bg-gray-900/40 rounded border border-amber-100 p-2 space-y-0.5">
          <div className="flex justify-between"><span>Valor do pedido (NF-e)</span><span>{brl(pv.total)}</span></div>
          {(pv.cadastroValor || 0) > 0 && (
            <div className="flex justify-between"><span>− Desconto do cadastro ({String(pv.cadastroPct).replace('.', ',')}%)</span><span>{brl(pv.cadastroValor)}</span></div>
          )}
          {extra > 0 && <div className="flex justify-between"><span>− Desconto no boleto (pipeline)</span><span>{brl(extra)}</span></div>}
          <div className={`flex justify-between font-semibold border-t pt-0.5 ${boleto < 0.01 ? 'text-red-700' : 'text-green-800'}`}>
            <span>Valor do boleto (já no DDA)</span><span>{brl(boleto)}</span>
          </div>
        </div>
      )}

      {extra > 0 && !pv.aplicaNoBoleto && (
        <p className="text-xs text-red-700 mt-2">
          ⚠️ A cobrança deste pedido hoje sai em <b>{FORMA[pv.formaEfetiva] || pv.formaEfetiva || '—'}</b>, não em boleto — o desconto só é
          aplicado se a cobrança sair em boleto (forma do cadastro do cliente ou, sem cadastro, a do pedido).
        </p>
      )}
      <p className="text-[10px] text-amber-700 mt-2">
        Vale só para a cobrança: a NF-e sai com o valor cheio. No faturamento o % do cadastro (sobre o valor cheio)
        e este desconto viram abatimento no título, e o boleto é registrado no banco já pelo valor final.
      </p>

      {historicoAntigo.length > 0 && (
        <details className="mt-2">
          <summary className="text-[10px] text-gray-500 cursor-pointer">Histórico ({historicoAntigo.length})</summary>
          <ul className="text-[10px] text-gray-600 mt-1 space-y-0.5">
            {historicoAntigo.map((h: any) => (
              <li key={h.id}>
                {brl(h.valor)} por {h.userName || h.userEmail || '—'} em {dtBR(h.createdAt)}
                {h.motivo ? ` (${h.motivo})` : ''} — substituído/removido por {h.removidoPor || '—'} em {dtBR(h.removidoEm)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
