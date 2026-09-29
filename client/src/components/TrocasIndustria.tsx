// ---------------------------------------------------------------------------
// TROCAS (módulo Indústria › aba Trocas) — 28/set/2026
// ---------------------------------------------------------------------------
// Lista de todas as solicitações de troca do pipeline de faturamento:
// cliente · quem solicitou · motivo/descrição · data · link da(s) foto(s).
// Somente leitura — nada aqui altera o pipeline. Dados vêm de
// GET /api/industria/trocas (server/trocas-industria-routes.ts).
// Acesso: admins e Naiara (a aba só é montada para quem passa em
// GET /api/industria/trocas/acesso; o servidor barra os demais com 403).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { exportToExcel, DateRangeFilter, dateInRange } from '@/lib/tableTools';
import { Search, RefreshCw, Loader2, FileSpreadsheet, Camera, ImageOff, ExternalLink, Repeat } from 'lucide-react';

type Troca = {
  id: string;
  origem: 'pipeline' | 'bloqueado';
  salesCardId: string;
  customerId: string;
  cliente: string;
  clienteFantasia: string | null;
  clienteDocumento: string | null;
  solicitante: string;
  sellerId: string | null;
  motivo: string;
  produtos: string;
  valor: number | null;
  etapa: string;
  pedido: string | null;
  nf: string | null;
  data: string | null;
  dataPipeline: string | null;
  atualizadoEm: string | null;
  fotos: { url: string; em: string }[];
};

const ETAPA_LABEL: Record<string, string> = {
  bloqueado: 'Bloqueado (aguardando liberação)',
  agendado: 'Agendado',
  pedido: 'Pedido',
  a_faturar: 'A Faturar',
  faturado: 'Faturado',
  impresso: 'Impresso',
  bsb: 'BSB',
  aguardando_rota_bsb: 'Ag. Rota BSB',
  em_rota_bsb: 'Em Rota BSB',
  outras_cidades: 'Outras Cidades',
  aguardando_rota: 'Aguardando Rota',
  em_rota: 'Em Rota',
  entregue: 'Entregue',
  lixeira: 'Lixeira',
};
const ETAPA_COR: Record<string, string> = {
  bloqueado: 'bg-red-100 text-red-800',
  agendado: 'bg-cyan-100 text-cyan-800',
  pedido: 'bg-blue-100 text-blue-800',
  a_faturar: 'bg-yellow-100 text-yellow-800',
  faturado: 'bg-orange-100 text-orange-800',
  impresso: 'bg-purple-100 text-purple-800',
  bsb: 'bg-pink-100 text-pink-800',
  aguardando_rota_bsb: 'bg-teal-100 text-teal-800',
  em_rota_bsb: 'bg-sky-100 text-sky-800',
  outras_cidades: 'bg-violet-100 text-violet-800',
  aguardando_rota: 'bg-gray-100 text-gray-800',
  em_rota: 'bg-indigo-100 text-indigo-800',
  entregue: 'bg-green-100 text-green-800',
  lixeira: 'bg-gray-200 text-gray-700',
};

const jfetch = async (url: string) => {
  const r = await fetch(url, { credentials: 'include' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};

const fmtDataHora = (v: any) => {
  if (!v) return '-';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtData = (v: any) => {
  if (!v) return '-';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};
const fmtMoney = (v: number | null) => (v == null ? '-' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
// URLs das fotos são relativas (/api/photo-media/:id) — para a planilha e para copiar, absolutas.
const absUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `${window.location.origin}${u.startsWith('/') ? '' : '/'}${u}`);
const norm = (s: any) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function TrocasIndustria() {
  const [busca, setBusca] = useState('');
  const [etapa, setEtapa] = useState('todas');
  const [foto, setFoto] = useState<'todas' | 'com' | 'sem'>('todas');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [aberta, setAberta] = useState<Troca | null>(null);

  const { data, isLoading, isFetching, refetch, error } = useQuery<{ total: number; comFoto: number; bloqueadas: number; itens: Troca[] }>({
    queryKey: ['/api/industria/trocas'],
    queryFn: () => jfetch('/api/industria/trocas'),
    refetchOnWindowFocus: true,
  });

  const itens = data?.itens || [];
  const etapasPresentes = useMemo(() => {
    const s = new Set(itens.map((i) => i.etapa));
    return Object.keys(ETAPA_LABEL).filter((k) => s.has(k));
  }, [itens]);

  const filtrados = useMemo(() => {
    const q = norm(busca.trim());
    return itens.filter((i) => {
      if (etapa !== 'todas' && i.etapa !== etapa) return false;
      if (foto === 'com' && i.fotos.length === 0) return false;
      if (foto === 'sem' && i.fotos.length > 0) return false;
      if ((de || ate) && !dateInRange(i.data, de, ate)) return false;
      if (!q) return true;
      return norm(`${i.cliente} ${i.clienteFantasia || ''} ${i.solicitante} ${i.motivo} ${i.produtos} ${i.pedido || ''} ${i.nf || ''}`).includes(q);
    });
  }, [itens, busca, etapa, foto, de, ate]);

  const exportar = () => {
    exportToExcel(filtrados.map((i) => ({
      'Data': fmtDataHora(i.data),
      'Cliente': i.cliente,
      'Nome fantasia': i.clienteFantasia || '',
      'Solicitante': i.solicitante,
      'Motivo / Descrição': i.motivo || '',
      'Produtos': i.produtos || '',
      'Valor': i.valor ?? '',
      'Etapa': ETAPA_LABEL[i.etapa] || i.etapa,
      'Pedido': i.pedido || '',
      'NF': i.nf || '',
      'Fotos': i.fotos.map((f) => absUrl(f.url)).join(' | '),
    })), `trocas-${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="space-y-4">
      {/* Resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-gray-500">Solicitações de troca</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{data?.total ?? '-'}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-gray-500">Com foto</p>
          <p className="text-2xl font-bold text-emerald-700">{data?.comFoto ?? '-'}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-gray-500">Sem foto</p>
          <p className="text-2xl font-bold text-amber-600">{data ? data.total - data.comFoto : '-'}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-gray-500">Aguardando liberação</p>
          <p className="text-2xl font-bold text-red-600">{data?.bloqueadas ?? '-'}</p>
        </CardContent></Card>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input className="pl-8" placeholder="Cliente, solicitante, motivo, produto, pedido ou NF" value={busca} onChange={(e) => setBusca(e.target.value)} data-testid="input-trocas-busca" />
          </div>
          <Select value={etapa} onValueChange={setEtapa}>
            <SelectTrigger className="w-[210px]" data-testid="select-trocas-etapa"><SelectValue placeholder="Etapa" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas as etapas</SelectItem>
              {etapasPresentes.map((k) => <SelectItem key={k} value={k}>{ETAPA_LABEL[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={foto} onValueChange={(v) => setFoto(v as any)}>
            <SelectTrigger className="w-[150px]" data-testid="select-trocas-foto"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Com e sem foto</SelectItem>
              <SelectItem value="com">Só com foto</SelectItem>
              <SelectItem value="sem">Só sem foto</SelectItem>
            </SelectContent>
          </Select>
          <DateRangeFilter start={de} end={ate} onChange={(s, e) => { setDe(s); setAte(e); }} label="Data da solicitação" testId="trocas-periodo" />
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-trocas-atualizar">
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          <Button variant="outline" size="sm" onClick={exportar} disabled={filtrados.length === 0} data-testid="button-trocas-excel">
            <FileSpreadsheet className="h-4 w-4 mr-1" /> Excel
          </Button>
        </CardContent>
      </Card>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3">{String((error as any)?.message || error)}</div>
      )}

      {/* Lista */}
      <div className="bg-white dark:bg-gray-800 border rounded-lg overflow-x-auto">
        <div className="px-4 py-2 text-xs text-gray-500 border-b">{filtrados.length} de {itens.length} solicitação(ões)</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Data</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>Solicitante</TableHead>
              <TableHead className="min-w-[260px]">Motivo / Descrição</TableHead>
              <TableHead>Produtos</TableHead>
              <TableHead className="whitespace-nowrap">Etapa</TableHead>
              <TableHead className="whitespace-nowrap">Foto</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Carregando trocas…</TableCell></TableRow>
            )}
            {!isLoading && filtrados.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">Nenhuma solicitação de troca encontrada</TableCell></TableRow>
            )}
            {filtrados.map((i) => (
              <TableRow key={`${i.origem}-${i.id}`} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40" onClick={() => setAberta(i)} data-testid={`row-troca-${i.id}`}>
                <TableCell className="whitespace-nowrap text-sm">{fmtDataHora(i.data)}</TableCell>
                <TableCell className="text-sm">
                  <div className="font-medium">{i.cliente}</div>
                  {i.clienteFantasia && i.clienteFantasia !== i.cliente && <div className="text-xs text-gray-500">{i.clienteFantasia}</div>}
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap">{i.solicitante}</TableCell>
                <TableCell className="text-sm max-w-[420px]">
                  <div className="line-clamp-3 whitespace-pre-wrap" title={i.motivo}>{i.motivo || <span className="text-gray-400">(sem descrição)</span>}</div>
                </TableCell>
                <TableCell className="text-xs text-gray-600 max-w-[240px]"><div className="line-clamp-2" title={i.produtos}>{i.produtos || '-'}</div></TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge className={`${ETAPA_COR[i.etapa] || 'bg-gray-100 text-gray-800'} font-normal`}>{ETAPA_LABEL[i.etapa] || i.etapa}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  {i.fotos.length === 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-gray-400"><ImageOff className="h-3.5 w-3.5" /> sem foto</span>
                  ) : (
                    <div className="flex items-center gap-1">
                      {i.fotos.map((f, idx) => (
                        <a key={f.url} href={f.url} target="_blank" rel="noreferrer" title={`Abrir foto ${idx + 1}`}
                          className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline border border-emerald-200 bg-emerald-50 rounded px-1.5 py-0.5"
                          data-testid={`link-troca-foto-${i.id}-${idx}`}>
                          <Camera className="h-3.5 w-3.5" /> {i.fotos.length > 1 ? `Foto ${idx + 1}` : 'Foto'}
                        </a>
                      ))}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Detalhe */}
      <Dialog open={!!aberta} onOpenChange={(o) => { if (!o) setAberta(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Repeat className="h-5 w-5 text-yellow-600" /> Troca — {aberta?.cliente}</DialogTitle>
          </DialogHeader>
          {aberta && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div><span className="text-gray-500">Solicitado em:</span> {fmtDataHora(aberta.data)}</div>
                <div><span className="text-gray-500">Solicitante:</span> {aberta.solicitante}</div>
                <div><span className="text-gray-500">Etapa:</span> <Badge className={`${ETAPA_COR[aberta.etapa] || ''} font-normal`}>{ETAPA_LABEL[aberta.etapa] || aberta.etapa}</Badge></div>
                <div><span className="text-gray-500">Valor:</span> {fmtMoney(aberta.valor)}</div>
                {aberta.pedido && <div><span className="text-gray-500">Pedido:</span> {aberta.pedido}</div>}
                {aberta.nf && <div><span className="text-gray-500">NF:</span> {aberta.nf}</div>}
                {aberta.clienteDocumento && <div><span className="text-gray-500">CNPJ/CPF:</span> {aberta.clienteDocumento}</div>}
                <div><span className="text-gray-500">Última movimentação:</span> {fmtData(aberta.atualizadoEm)}</div>
              </div>
              <div>
                <p className="text-gray-500 mb-1">Motivo / descrição</p>
                <div className="whitespace-pre-wrap border rounded-md p-3 bg-gray-50 dark:bg-gray-900">{aberta.motivo || '(sem descrição)'}</div>
              </div>
              {aberta.produtos && (
                <div>
                  <p className="text-gray-500 mb-1">Produtos</p>
                  <div className="border rounded-md p-3 bg-gray-50 dark:bg-gray-900">{aberta.produtos}</div>
                </div>
              )}
              <div>
                <p className="text-gray-500 mb-1">{aberta.fotos.length === 1 ? 'Foto da troca' : `Fotos da troca (${aberta.fotos.length})`}</p>
                {aberta.fotos.length === 0 ? (
                  <p className="text-gray-400 text-xs">O vendedor não anexou foto nesta troca.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {aberta.fotos.map((f, idx) => (
                      <div key={f.url} className="border rounded-md overflow-hidden">
                        <a href={f.url} target="_blank" rel="noreferrer">
                          <img src={f.url} alt={`Foto ${idx + 1} dos produtos da troca`} className="w-full max-h-72 object-contain bg-black/5" loading="lazy" data-testid={`img-troca-foto-${idx}`} />
                        </a>
                        <div className="flex items-center justify-between px-2 py-1 text-xs text-gray-500">
                          <span>{fmtDataHora(f.em)}</span>
                          <a href={f.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-700 hover:underline"><ExternalLink className="h-3 w-3" /> abrir</a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
