// ===========================================================================
// PEDIDO DE VENDA GYN -> SERV (botão no Pipeline de Faturamento) — 04/out/2026
// ===========================================================================
// Mostra, por produto, o que a SERV precisa receber para faturar os pedidos
// pendentes dela (pendente − estoque SERV), os lotes da GYN que seriam usados
// (FIFO) e o preço = CMV atual da indústria. A quantidade é editável. Ao
// confirmar, cria o card em "A Faturar" (GET/POST /api/billing-pipeline/pedido-gyn-serv).
// ===========================================================================
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/hooks/use-toast';
import { Loader2, Truck, AlertTriangle, RefreshCw } from 'lucide-react';

type Linha = {
  productId: string; nome: string; pedidosPendentes: number; pendente: number; estoqueServ: number; necessario: number;
  disponivelGyn: number; cmvInd: number | null; cmvOrigem: string; alocado: number; faltam: number; precoUnit: number | null; total: number;
  lotes: { lotId: string; lotNumber: string; quantidade: number; stockType: string }[];
};
type Preview = {
  origem: { instanceId: string; name: string }; destino: { instanceId: string; name: string; cnpj: string | null };
  cliente: { id: string; nome: string; cnpj: string | null } | null;
  linhas: Linha[];
  resumo: { pedidosPendentes: number; produtos: number; necessario: number; alocado: number; faltam: number; semCmv: number; total: number };
};

const fmtBRL = (v: any) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtInt = (v: any) => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const curto = (n: string) => n.replace(/^SUCO MISTO DE FRUTA\s*-\s*/i, '');

export default function PedidoGynServDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [qtd, setQtd] = useState<Record<string, string>>({});
  const [obs, setObs] = useState('');
  const [enviando, setEnviando] = useState(false);

  const { data, isLoading, isFetching, refetch, error } = useQuery<Preview>({
    queryKey: ['/api/billing-pipeline/pedido-gyn-serv/preview'],
    queryFn: async () => {
      const r = await fetch('/api/billing-pipeline/pedido-gyn-serv/preview', { credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || `Falha (${r.status})`);
      return j;
    },
    enabled: open, staleTime: 0,
  });

  useEffect(() => {
    if (!data) return;
    setQtd(Object.fromEntries(data.linhas.map((l) => [l.productId, String(l.necessario)])));
  }, [data]);

  const linhas = data?.linhas || [];
  // Recalculo local do que muda ao editar a quantidade (alocado/total exatos vêm do servidor na criação).
  const calc = (l: Linha) => {
    const q = Math.max(0, Math.round(Number(qtd[l.productId] ?? l.necessario) || 0));
    const aloc = Math.min(q, l.disponivelGyn);
    return { q, aloc, faltam: q - aloc, total: l.precoUnit != null ? l.precoUnit * aloc : 0 };
  };
  const totais = linhas.reduce((s, l) => { const c = calc(l); return { aloc: s.aloc + c.aloc, faltam: s.faltam + c.faltam, total: s.total + c.total }; }, { aloc: 0, faltam: 0, total: 0 });
  const semCmv = linhas.filter((l) => calc(l).aloc > 0 && l.precoUnit == null);
  const podeCriar = !!data?.cliente && totais.aloc > 0 && !semCmv.length && !enviando;

  const criar = async () => {
    setEnviando(true);
    try {
      const r = await fetch('/api/billing-pipeline/pedido-gyn-serv', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itens: linhas.map((l) => ({ productId: l.productId, quantity: calc(l).q })), notes: obs || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || `Falha (${r.status})`);
      toast({ title: `Pedido ${j.orderNumber} criado`, description: `${j.linhas} produto(s) · ${fmtBRL(j.total)} — está em "A Faturar" (GYN → SERV).${j.faltam ? ` Faltaram ${fmtInt(j.faltam)} un sem saldo na GYN.` : ''}` });
      qc.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      qc.invalidateQueries({ queryKey: ['/api/inventory/summary'] });
      onClose();
    } catch (e: any) {
      toast({ title: 'Não foi possível criar o pedido', description: String(e.message || e), variant: 'destructive' });
    } finally { setEnviando(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Truck className="h-5 w-5 text-emerald-600" /> Pedido de venda GYN → SERV</DialogTitle>
          <DialogDescription>
            Quantidade necessária = pedidos pendentes da SERV (Agendado / Pedido / A Faturar) − estoque atual da SERV. Lotes da GYN por FIFO. Preço = CMV atual da indústria (último lote produzido na IND). A NF sai como venda (CFOP 5101/6101) e os lotes entram na SERV com esse CMV.
          </DialogDescription>
        </DialogHeader>

        {error && <div className="text-sm text-red-600">{String((error as any).message)}</div>}
        {isLoading || !data ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-6"><Loader2 className="h-4 w-4 animate-spin" /> Calculando…</div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">{data.resumo.pedidosPendentes} pedido(s) pendente(s) da SERV</Badge>
              <Badge variant="outline">{linhas.length} produto(s)</Badge>
              <Badge variant="outline">destinatário: {data.cliente ? data.cliente.nome : <span className="text-red-600">Puro Serviços não cadastrada em Clientes</span>}</Badge>
              <div className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /></Button>
            </div>

            {linhas.length === 0 ? (
              <div className="text-sm text-gray-500 py-4">Não há pedidos pendentes da SERV no pipeline.</div>
            ) : (
              <div className="max-h-[50vh] overflow-auto border rounded">
                <Table>
                  <TableHeader><TableRow className="text-xs">
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-right">Pendente SERV</TableHead>
                    <TableHead className="text-right">Estoque SERV</TableHead>
                    <TableHead className="text-right">Necessário</TableHead>
                    <TableHead className="text-right">Disponível GYN</TableHead>
                    <TableHead className="w-24">Pedir</TableHead>
                    <TableHead>Lotes GYN</TableHead>
                    <TableHead className="text-right">CMV ind.</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {linhas.map((l) => {
                      const c = calc(l);
                      return (
                        <TableRow key={l.productId} className={`text-sm ${c.faltam > 0 ? 'bg-amber-50/60' : ''}`}>
                          <TableCell className="font-medium">{curto(l.nome)}<div className="text-[11px] text-gray-500">{l.pedidosPendentes} pedido(s)</div></TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(l.pendente)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(l.estoqueServ)}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">{fmtInt(l.necessario)}</TableCell>
                          <TableCell className={`text-right tabular-nums ${l.disponivelGyn < l.necessario ? 'text-red-600 font-semibold' : ''}`}>{fmtInt(l.disponivelGyn)}</TableCell>
                          <TableCell><Input type="number" min={0} value={qtd[l.productId] ?? ''} onChange={(e) => setQtd((q) => ({ ...q, [l.productId]: e.target.value }))} className="h-8 text-right" /></TableCell>
                          <TableCell className="text-[11px] text-gray-600">
                            {l.lotes.length ? l.lotes.map((x) => `${x.lotNumber} ×${fmtInt(x.quantidade)}${x.stockType === 'blocked' ? ' (bloq.)' : ''}`).join(' · ') : '—'}
                            {c.faltam > 0 && <div className="text-amber-700 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> faltam {fmtInt(c.faltam)} un na GYN</div>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {l.precoUnit != null ? fmtBRL(l.precoUnit) : <span className="text-red-600">sem CMV</span>}
                            <div className="text-[10px] text-gray-400">{l.cmvOrigem}</div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmtBRL(c.total)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span>Total do pedido (a CMV): <b className="text-emerald-700">{fmtBRL(totais.total)}</b> · {fmtInt(totais.aloc)} garrafas</span>
              {totais.faltam > 0 && <span className="text-amber-700">{fmtInt(totais.faltam)} un sem saldo na GYN ficam de fora</span>}
              {semCmv.length > 0 && <span className="text-red-600">{semCmv.length} produto(s) sem CMV — não dá para precificar</span>}
            </div>
            <Input placeholder="Observação (opcional)" value={obs} onChange={(e) => setObs(e.target.value)} className="h-8" />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={enviando}>Cancelar</Button>
          <Button onClick={criar} disabled={!podeCriar} className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid="btn-criar-pedido-gyn-serv">
            {enviando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Truck className="h-4 w-4 mr-1" />} Gerar pedido GYN → SERV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
