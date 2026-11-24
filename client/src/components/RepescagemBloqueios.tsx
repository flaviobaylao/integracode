// ⛔ BLOQUEIOS DA REPESCAGEM (nov/2026, pedido do Flavio): carteiras, redes de clientes e
// clientes que NUNCA entram em repescagem (ex.: todas as unidades da rede Amorix).
// Só o admin cria/remove. Ao bloquear, o que estava na repescagem de hoje sai na hora.
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Ban, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { queryClient, apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';

type Tipo = 'carteira' | 'rede' | 'cliente';
const ROTULO: Record<Tipo, string> = { carteira: 'Carteira', rede: 'Rede de clientes', cliente: 'Cliente' };

export default function RepescagemBloqueios({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const [aberto, setAberto] = useState(false);
  const [tipo, setTipo] = useState<Tipo>('rede');
  const [refId, setRefId] = useState('');
  const [busca, setBusca] = useState('');
  const [clienteSel, setClienteSel] = useState<{ id: string; nome: string } | null>(null);

  const lista = useQuery<{ itens: any[] }>({
    queryKey: ['/api/repescagem/bloqueios'],
    queryFn: () => apiRequest('GET', '/api/repescagem/bloqueios'),
  });
  const opcoes = useQuery<{ carteiras: any[]; redes: any[] }>({
    queryKey: ['/api/repescagem/bloqueios/opcoes'],
    queryFn: () => apiRequest('GET', '/api/repescagem/bloqueios/opcoes'),
    enabled: aberto && isAdmin,
  });
  const clientes = useQuery<{ clientes: any[] }>({
    queryKey: ['/api/repescagem/bloqueios/clientes', busca],
    queryFn: () => apiRequest('GET', `/api/repescagem/bloqueios/clientes?q=${encodeURIComponent(busca)}`),
    enabled: aberto && isAdmin && tipo === 'cliente' && busca.trim().length >= 2 && !clienteSel,
  });

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/repescagem/bloqueios'] });
    queryClient.invalidateQueries({ queryKey: ['/api/repescagem/assignments'] });
    queryClient.invalidateQueries({ queryKey: ['/api/repescagem/route-overlay'] });
  };
  const bloquear = useMutation({
    mutationFn: (b: { tipo: Tipo; refId: string }) => apiRequest('POST', '/api/repescagem/bloqueios', b),
    onSuccess: (d: any) => {
      toast({ title: 'Bloqueado para repescagem', description: `${ROTULO[d?.tipo as Tipo] || ''}: ${d?.nome || ''}.${d?.canceladas ? ` ${d.canceladas} cliente(s) saíram da repescagem de hoje.` : ''}` });
      setRefId(''); setBusca(''); setClienteSel(null);
      invalidar();
    },
    onError: (e: any) => toast({ title: 'Não foi possível bloquear', description: String(e?.message || 'Tente novamente.').replace(/^\d{3}:\s*/, ''), variant: 'destructive' }),
  });
  const remover = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/repescagem/bloqueios/${id}`),
    onSuccess: (d: any) => { toast({ title: 'Bloqueio removido', description: `${d?.nome || ''} volta às regras normais de repescagem.` }); invalidar(); },
    onError: (e: any) => toast({ title: 'Não foi possível remover', description: String(e?.message || 'Tente novamente.').replace(/^\d{3}:\s*/, ''), variant: 'destructive' }),
  });

  const itens: any[] = Array.isArray(lista.data?.itens) ? lista.data!.itens : [];
  const idEscolhido = tipo === 'cliente' ? (clienteSel?.id || '') : refId;
  const jaBloqueados = new Set(itens.map((i) => `${i.tipo}|${i.refId}`));

  return (
    <Card className="border-rose-200 dark:border-rose-900 border-l-4 border-l-rose-500" data-testid="repescagem-bloqueios">
      <CardHeader className="pb-2">
        <button type="button" onClick={() => setAberto((v) => !v)} className="w-full flex items-center justify-between gap-2 text-left" aria-expanded={aberto}>
          <CardTitle className="text-base flex items-center gap-2">
            <Ban className="h-4 w-4 text-rose-600" />
            Bloqueados da repescagem ({itens.length})
            <span className="text-[11px] font-normal text-gray-400">{aberto ? 'recolher' : 'expandir'}</span>
          </CardTitle>
          {aberto ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
        </button>
      </CardHeader>
      {aberto && (
        <CardContent className="pt-0 space-y-3">
          <p className="text-xs text-gray-500">
            Carteiras, redes de clientes e clientes daqui <b>nunca entram em repescagem</b> — nem pelo sorteio, nem pelo botão "Repescagem" do Inbox.
            Rede bloqueada vale também para as unidades que entrarem nela depois. Ao bloquear, o que estava na repescagem de hoje sai na hora.
          </p>

          {isAdmin && (
            <div className="rounded-md border p-2.5 space-y-2 bg-white dark:bg-gray-900">
              <div className="flex flex-wrap gap-1.5">
                {(['rede', 'carteira', 'cliente'] as Tipo[]).map((t) => (
                  <Button key={t} size="sm" variant={tipo === t ? 'default' : 'outline'} className="h-7 text-xs"
                    onClick={() => { setTipo(t); setRefId(''); setBusca(''); setClienteSel(null); }} data-testid={`bloqueio-tipo-${t}`}>
                    {ROTULO[t]}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {tipo === 'rede' && (
                  <select className="h-9 min-w-[260px] border rounded-md px-2 text-sm bg-white dark:bg-transparent" value={refId} onChange={(e) => setRefId(e.target.value)} data-testid="bloqueio-select-rede">
                    <option value="">{opcoes.isLoading ? 'Carregando redes…' : 'Escolha a rede…'}</option>
                    {(opcoes.data?.redes || []).filter((r: any) => !jaBloqueados.has(`rede|${r.id}`)).map((r: any) => (
                      <option key={r.id} value={r.id}>{r.nome} ({r.clientes} cliente{r.clientes === 1 ? '' : 's'})</option>
                    ))}
                  </select>
                )}
                {tipo === 'carteira' && (
                  <select className="h-9 min-w-[260px] border rounded-md px-2 text-sm bg-white dark:bg-transparent" value={refId} onChange={(e) => setRefId(e.target.value)} data-testid="bloqueio-select-carteira">
                    <option value="">{opcoes.isLoading ? 'Carregando carteiras…' : 'Escolha a carteira…'}</option>
                    {(opcoes.data?.carteiras || []).filter((c: any) => !jaBloqueados.has(`carteira|${c.id}`)).map((c: any) => (
                      <option key={c.id} value={c.id}>{c.nome}{c.ativo ? '' : ' (inativo)'} ({c.clientes} cliente{c.clientes === 1 ? '' : 's'})</option>
                    ))}
                  </select>
                )}
                {tipo === 'cliente' && (
                  <div className="relative min-w-[300px]">
                    {clienteSel ? (
                      <div className="h-9 flex items-center gap-2 border rounded-md px-2 text-sm">
                        <span className="truncate">{clienteSel.nome}</span>
                        <button type="button" onClick={() => { setClienteSel(null); setBusca(''); }} aria-label="Trocar cliente"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    ) : (
                      <>
                        <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome, razão social ou CNPJ…" className="h-9" data-testid="bloqueio-busca-cliente" />
                        {busca.trim().length >= 2 && (
                          <div className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-md border bg-white dark:bg-gray-900 shadow">
                            {clientes.isLoading && <div className="p-2 text-xs text-gray-500"><Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Buscando…</div>}
                            {!clientes.isLoading && (clientes.data?.clientes || []).length === 0 && <div className="p-2 text-xs text-gray-500">Nenhum cliente ativo encontrado.</div>}
                            {(clientes.data?.clientes || []).map((c: any) => (
                              <button key={c.id} type="button" className="w-full text-left px-2 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                                onClick={() => setClienteSel({ id: c.id, nome: c.nome })}>
                                <div className="font-medium">{c.nome}</div>
                                <div className="text-[11px] text-gray-500">{[c.cidade, c.vendedor ? `carteira ${c.vendedor}` : null].filter(Boolean).join(' · ')}</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                <Button size="sm" className="h-9 bg-rose-600 hover:bg-rose-700" disabled={!idEscolhido || bloquear.isPending || jaBloqueados.has(`${tipo}|${idEscolhido}`)}
                  onClick={() => bloquear.mutate({ tipo, refId: idEscolhido })} data-testid="bloqueio-confirmar">
                  {bloquear.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Ban className="h-4 w-4 mr-1" /> Bloquear</>}
                </Button>
              </div>
            </div>
          )}

          {lista.isLoading ? (
            <div className="text-sm text-gray-500"><Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Carregando…</div>
          ) : itens.length === 0 ? (
            <div className="text-sm text-gray-500">Nenhum bloqueio. Todas as carteiras, redes e clientes seguem as regras normais.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {itens.map((i) => (
                <div key={i.id} className="flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-900 pl-2.5 pr-1 py-0.5 text-sm" data-testid={`bloqueio-${i.id}`}
                  title={`${ROTULO[i.tipo as Tipo] || i.tipo}${i.por ? ` · bloqueado por ${i.por}` : ''}`}>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{ROTULO[i.tipo as Tipo] || i.tipo}</Badge>
                  <span className="font-medium">{i.nome}</span>
                  {i.tipo !== 'cliente' && <span className="text-[11px] text-gray-500">{i.clientes} cliente{i.clientes === 1 ? '' : 's'}</span>}
                  {isAdmin && (
                    <button type="button" className="ml-0.5 rounded-full p-1 hover:bg-rose-100 dark:hover:bg-rose-900" disabled={remover.isPending}
                      onClick={() => { if (window.confirm(`Remover o bloqueio de ${i.nome}?\n\nOs clientes voltam às regras normais de repescagem.`)) remover.mutate(i.id); }}
                      aria-label={`Remover bloqueio de ${i.nome}`}>
                      <X className="h-3.5 w-3.5 text-rose-700" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
