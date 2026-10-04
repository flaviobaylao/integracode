// ============================================================================
// RELATÓRIO PRD/PP/INSUMO (Flavio 04/out/2026) — módulo Indústria
// Movimentação de insumos no período: saldo inicial, entradas (compra NF,
// produção de OP, outras), consumo em ordens de produção, saídas, perdas,
// ajustes, estornos e saldo final; consumo detalhado por OP; extrato.
// Prévia na tela + Excel (3 abas) + impressão. Backend: GET /api/industria/relatorio-insumos
// (server/relatorio-insumos.ts).
// ============================================================================
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { exportSheetsToExcel } from '@/lib/excelExport';
import { Printer, FileSpreadsheet, Loader2, RefreshCw, AlertTriangle, Search } from 'lucide-react';

const TITULO = 'RELATÓRIO PRD/PP/INSUMO';

const CATEGORIAS = [
  { value: 'insumo', label: 'Insumo' }, { value: 'fruta', label: 'Fruta' },
  { value: 'concentrado', label: 'Concentrado' }, { value: 'polpa', label: 'Polpa' },
  { value: 'tampa', label: 'Tampa' }, { value: 'garrafa', label: 'Garrafa' },
  { value: 'rotulo', label: 'Rótulo' }, { value: 'outros', label: 'Outros' },
];
const catLabel = (c: string) => CATEGORIAS.find((x) => x.value === c)?.label || c || 'Outros';

const n = (v: any): number => { const x = Number(v); return isFinite(x) ? x : 0; };
const fq = (v: any) => n(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const fqs = (v: any) => { const x = n(v); return x === 0 ? '-' : (x > 0 ? '+' : '') + fq(x); };
const fz = (v: any) => (n(v) === 0 ? '-' : fq(v));
const brl = (v: any) => n(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dBR = (ymd: string) => (ymd ? ymd.split('-').reverse().join('/') : '-');
const dhBR = (s: string) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : s; };
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]));
const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

const TIPO_COR: Record<string, string> = {
  compras: 'text-emerald-700', producao: 'text-emerald-700', outrasEntradas: 'text-emerald-700',
  consumoOP: 'text-red-600', saidas: 'text-red-600', perdas: 'text-red-600',
  ajustes: 'text-blue-600', estornos: 'text-gray-500',
};

export default function RelatorioInsumosDialog({ onClose }: { onClose: () => void }) {
  const hoje = hojeBR();
  const [de, setDe] = useState(hoje.slice(0, 8) + '01');
  const [ate, setAte] = useState(hoje);
  const [categoria, setCategoria] = useState('todas');
  const [busca, setBusca] = useState('');
  const [soMovimentados, setSoMovimentados] = useState(true);
  const [comCusto, setComCusto] = useState(true);
  const [imprimirExtrato, setImprimirExtrato] = useState(true);
  const [aba, setAba] = useState('resumo');

  const url = `/api/industria/relatorio-insumos?de=${de}&ate=${ate}${categoria !== 'todas' ? `&categoria=${categoria}` : ''}`;
  const { data, isLoading, isFetching, error, refetch } = useQuery<any>({
    queryKey: ['/api/industria/relatorio-insumos', de, ate, categoria],
    queryFn: async () => {
      const r = await fetch(url, { credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || `Falha (${r.status})`);
      return j;
    },
    enabled: !!de && !!ate && de <= ate,
  });

  const filtrado = useMemo(() => {
    const s = busca.trim().toLowerCase();
    const casa = (nome: any, cod: any) => !s || String(nome || '').toLowerCase().includes(s) || String(cod || '').toLowerCase().includes(s);
    const linhas = (data?.linhas || []).filter((l: any) => (!soMovimentados || l.movimentos > 0) && casa(l.material, l.codigo));
    const ids = new Set(linhas.map((l: any) => l.material_id));
    const extrato = (data?.extrato || []).filter((m: any) => ids.has(m.material_id));
    const ops = (data?.ops || [])
      .map((o: any) => ({ ...o, insumos: o.insumos.filter((i: any) => ids.has(i.material_id)), perdas: (o.perdas || []).filter((i: any) => ids.has(i.material_id)), gerados: o.gerados.filter((i: any) => ids.has(i.material_id)) }))
      .filter((o: any) => o.insumos.length || o.perdas.length || o.gerados.length)
      .map((o: any) => ({ ...o, custo_total: [...o.insumos, ...o.perdas].reduce((s: number, i: any) => s + n(i.valor), 0) }));
    const soma = (k: string) => linhas.reduce((s: number, l: any) => s + n(l[k]), 0);
    return {
      linhas, extrato, ops,
      tot: {
        insumos: linhas.length,
        movimentos: extrato.length,
        ops: ops.length,
        compras: soma('valor_compras'),
        consumo: soma('valor_consumo_op'),
        perdas: soma('valor_perdas'),
        saldo: soma('valor_saldo_final'),
        divergentes: linhas.filter((l: any) => Math.abs(n(l.divergencia)) > 0.0005).length,
      },
    };
  }, [data, busca, soMovimentados]);

  const periodoTxt = `${dBR(de)} a ${dBR(ate)}`;
  const filtroTxt = [categoria !== 'todas' ? `Categoria: ${catLabel(categoria)}` : '', busca.trim() ? `Busca: "${busca.trim()}"` : '', soMovimentados ? 'só insumos movimentados' : 'todos os insumos']
    .filter(Boolean).join(' · ');

  // ------------------------------------------------------------------ Excel
  const doExcel = () => {
    const custo = (o: Record<string, any>) => (comCusto ? o : {});
    const resumo = filtrado.linhas.map((l: any) => ({
      'Categoria': catLabel(l.categoria), 'Insumo': l.material, 'Código': l.codigo, 'Un.': l.unidade,
      'Saldo Inicial': l.saldo_inicial,
      'Entrada Compra (NF)': l.compras, 'Entrada Produção (OP)': l.producao, 'Outras Entradas': l.outras_entradas,
      'Total Entradas': l.entradas,
      'Consumo em OP': l.consumo_op, 'Saída Manual': l.saidas, 'Perdas': l.perdas, 'Total Saídas': l.total_saidas,
      'Ajustes (±)': l.ajustes, 'Estornos (±)': l.estornos,
      'Saldo Final': l.saldo_final, 'Divergência': l.divergencia, 'Movimentos': l.movimentos,
      ...custo({
        'Custo Unit. Atual (R$)': l.custo_unit_atual, 'Valor Compras (R$)': l.valor_compras,
        'Valor Consumo OP (R$)': l.valor_consumo_op, 'Valor Perdas (R$)': l.valor_perdas, 'Valor Saldo Final (R$)': l.valor_saldo_final,
      }),
    }));
    const porOp: any[] = [];
    for (const o of filtrado.ops) {
      const base = { 'OP': o.op, 'Produto': o.produto, 'Lote': o.lote, 'Status': o.status, 'Data Produção': dBR(o.data_producao), 'Qtd OP': n(o.quantidade) };
      for (const i of o.insumos) porOp.push({ ...base, 'Movimento': 'Consumo', 'Insumo': i.material, 'Un.': i.unidade, 'Quantidade': i.quantidade, ...custo({ 'Custo Unit. (R$)': i.custo_unit, 'Valor (R$)': i.valor }) });
      for (const i of o.perdas) porOp.push({ ...base, 'Movimento': 'Perda/Avaria', 'Insumo': i.material, 'Un.': i.unidade, 'Quantidade': i.quantidade, ...custo({ 'Custo Unit. (R$)': i.custo_unit, 'Valor (R$)': i.valor }) });
      for (const i of o.gerados) porOp.push({ ...base, 'Movimento': 'Gerado pela OP', 'Insumo': i.material, 'Un.': i.unidade, 'Quantidade': i.quantidade, ...custo({ 'Custo Unit. (R$)': i.custo_unit, 'Valor (R$)': i.valor }) });
    }
    const extrato = filtrado.extrato.map((m: any) => ({
      'Data/Hora': dhBR(m.data), 'Insumo': m.material, 'Categoria': catLabel(m.categoria), 'Un.': m.unidade,
      'Tipo': m.coluna_label, 'Quantidade (±)': m.quantidade, 'Saldo Anterior': m.saldo_anterior, 'Saldo Novo': m.saldo_novo,
      ...custo({ 'Custo Unit. (R$)': m.custo_unit, 'Valor (R$)': m.valor }),
      'OP': m.op, 'Produto OP': m.op_produto, 'Observação': m.obs, 'Usuário': m.usuario,
    }));
    exportSheetsToExcel([
      { nome: 'Resumo por insumo', linhas: resumo.length ? resumo : [{ 'Aviso': 'Nenhum insumo no filtro' }] },
      { nome: 'Consumo por OP', linhas: porOp.length ? porOp : [{ 'Aviso': 'Nenhuma OP no período' }] },
      { nome: 'Extrato', linhas: extrato.length ? extrato : [{ 'Aviso': 'Nenhuma movimentação no período' }] },
    ], `relatorio-prd-pp-insumo-${de}-a-${ate}`);
  };

  // --------------------------------------------------------------- Impressão
  const doPrint = () => {
    const emitido = new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const grupos = new Map<string, any[]>();
    for (const l of filtrado.linhas) { const k = l.categoria; (grupos.get(k) || grupos.set(k, []).get(k)!).push(l); }
    const nCols = comCusto ? 14 : 12;
    const resumoHtml = Array.from(grupos.entries()).map(([cat, ls]) => `
<tr class="grp"><td colspan="${nCols}">${esc(catLabel(cat))}</td></tr>
${ls.map((l: any) => `<tr${Math.abs(n(l.divergencia)) > 0.0005 ? ' class="div"' : ''}><td>${esc(l.material)}${l.codigo ? ` <small>(${esc(l.codigo)})</small>` : ''}</td><td>${esc(l.unidade)}</td>
<td class="num">${fq(l.saldo_inicial)}</td><td class="num">${fz(l.compras)}</td><td class="num">${fz(l.producao)}</td><td class="num">${fz(l.outras_entradas)}</td>
<td class="num">${fz(l.consumo_op)}</td><td class="num">${fz(l.saidas)}</td><td class="num">${fz(l.perdas)}</td><td class="num">${fqs(n(l.ajustes) + n(l.estornos))}</td>
<td class="num b">${fq(l.saldo_final)}</td><td class="num">${l.movimentos}</td>
${comCusto ? `<td class="num">${brl(l.valor_consumo_op)}</td><td class="num">${brl(l.valor_saldo_final)}</td>` : ''}</tr>`).join('')}`).join('');

    const opsHtml = filtrado.ops.length ? filtrado.ops.map((o: any) => `
<div class="op"><h4>${esc(o.op)} — ${esc(o.produto || '-')} <span class="badge">${esc(o.status || '-')}</span></h4>
<p class="meta">Lote ${esc(o.lote || '-')} · produção ${dBR(o.data_producao)} · qtd ${fq(o.quantidade)}</p>
<table><thead><tr><th>Movimento</th><th>Insumo</th><th>Un.</th><th class="num">Qtd</th>${comCusto ? '<th class="num">Custo unit.</th><th class="num">Valor</th>' : ''}</tr></thead><tbody>
${o.insumos.map((i: any) => `<tr><td>Consumo</td><td>${esc(i.material)}</td><td>${esc(i.unidade)}</td><td class="num">${fq(i.quantidade)}</td>${comCusto ? `<td class="num">${brl(i.custo_unit)}</td><td class="num">${brl(i.valor)}</td>` : ''}</tr>`).join('')}
${o.perdas.map((i: any) => `<tr class="per"><td>Perda/Avaria</td><td>${esc(i.material)}</td><td>${esc(i.unidade)}</td><td class="num">${fq(i.quantidade)}</td>${comCusto ? `<td class="num">${brl(i.custo_unit)}</td><td class="num">${brl(i.valor)}</td>` : ''}</tr>`).join('')}
${o.gerados.map((i: any) => `<tr class="ger"><td>Gerado pela OP</td><td>${esc(i.material)}</td><td>${esc(i.unidade)}</td><td class="num">${fq(i.quantidade)}</td>${comCusto ? `<td class="num">${brl(i.custo_unit)}</td><td class="num">${brl(i.valor)}</td>` : ''}</tr>`).join('')}
</tbody>${comCusto && (o.insumos.length || o.perdas.length) ? `<tfoot><tr><td colspan="5">Custo dos insumos (consumo + perda)</td><td class="num">${brl(o.custo_total)}</td></tr></tfoot>` : ''}</table></div>`).join('')
      : '<p class="vazio">Nenhuma ordem de produção consumiu insumos no período.</p>';

    const extratoHtml = !imprimirExtrato ? '' : `<h3>3. Extrato de movimentações</h3>
<table class="ext"><thead><tr><th>Data/Hora</th><th>Insumo</th><th>Tipo</th><th class="num">Qtd (±)</th><th class="num">Saldo</th><th>OP</th><th>Observação</th><th>Usuário</th></tr></thead><tbody>
${filtrado.extrato.map((m: any) => `<tr><td>${esc(dhBR(m.data))}</td><td>${esc(m.material)}</td><td>${esc(m.coluna_label)}</td><td class="num">${fqs(m.quantidade)}</td><td class="num">${fq(m.saldo_novo)}</td><td>${esc(m.op || '')}</td><td>${esc(m.obs || '')}</td><td>${esc(m.usuario || '')}</td></tr>`).join('') || '<tr><td colspan="8">Nenhuma movimentação</td></tr>'}
</tbody></table>`;

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relatório PRD-PP-INSUMO ${esc(periodoTxt)}</title>
<style>@page{size:A4 landscape;margin:12mm}body{font-family:Arial,sans-serif;margin:16px;color:#111}h1{font-size:18px;margin:0}h2{font-size:12px;color:#555;font-weight:normal;margin:2px 0 0}
h3{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}h4{font-size:13px;margin:0 0 2px}
.cab{display:flex;align-items:center;gap:16px;border-bottom:2px solid #16a34a;padding-bottom:10px;margin-bottom:12px}.cab img{height:54px}
table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f0f0f0}
td.num,th.num{text-align:right;white-space:nowrap}td.b{font-weight:bold}tfoot td{font-weight:bold;background:#fafafa}
tr.grp td{background:#e8f5e9;font-weight:bold}tr.div td{background:#fff7e0}tr.ger td{color:#166534}tr.per td{color:#b45309}
.kpi{display:flex;gap:8px;flex-wrap:wrap}.kpi div{border:1px solid #ccc;border-radius:6px;padding:6px 10px;font-size:11px}.kpi b{display:block;font-size:14px}
.op{border:1px solid #ddd;border-radius:6px;padding:8px 10px;margin-bottom:10px;page-break-inside:avoid}.meta{font-size:11px;color:#555;margin:0 0 4px}
.badge{font-size:10px;font-weight:normal;border:1px solid #999;border-radius:10px;padding:1px 7px;margin-left:6px}
.vazio{font-size:12px;color:#777}.nota{font-size:10px;color:#555;margin-top:4px}small{color:#666}
table.ext td{font-size:10px}
.assin{margin-top:36px;display:flex;gap:40px;font-size:12px}.assin div{flex:1;border-top:1px solid #333;padding-top:4px;text-align:center}</style></head><body>
<div class="cab"><img src="${window.location.origin}/honest-logo.png" alt="Honest"><div>
<h1>${TITULO}</h1>
<h2>Movimentação de insumos · período ${esc(periodoTxt)} · ${esc(filtroTxt)}</h2>
<h2>Sistema Integra · Honest Sucos · emitido em ${emitido}</h2>
</div></div>
<div class="kpi">
<div>Insumos<b>${filtrado.tot.insumos}</b></div><div>Movimentações<b>${filtrado.tot.movimentos}</b></div><div>OPs com consumo<b>${filtrado.tot.ops}</b></div>
${comCusto ? `<div>Compras (NF)<b>${brl(filtrado.tot.compras)}</b></div><div>Consumo em OP<b>${brl(filtrado.tot.consumo)}</b></div><div>Perdas<b>${brl(filtrado.tot.perdas)}</b></div><div>Estoque final<b>${brl(filtrado.tot.saldo)}</b></div>` : ''}
</div>
<h3>1. Resumo por insumo</h3>
<table><thead><tr><th>Insumo</th><th>Un.</th><th class="num">Saldo inicial</th><th class="num">Compra NF</th><th class="num">Produção OP</th><th class="num">Outras ent.</th>
<th class="num">Consumo OP</th><th class="num">Saída manual</th><th class="num">Perdas</th><th class="num">Ajuste/Estorno</th><th class="num">Saldo final</th><th class="num">Mov.</th>
${comCusto ? '<th class="num">R$ consumo OP</th><th class="num">R$ saldo final</th>' : ''}</tr></thead>
<tbody>${resumoHtml || `<tr><td colspan="${nCols}">Nenhum insumo no filtro</td></tr>`}</tbody></table>
<p class="nota">Saldo final = saldo inicial + entradas − saídas ± ajustes/estornos. Linhas em amarelo: histórico com divergência (estoque alterado fora de movimentação).${comCusto ? ' Valores de consumo pelo custo gravado em cada movimento; saldo final pelo custo unitário atual.' : ''}</p>
<h3>2. Consumo de insumos por ordem de produção</h3>
${opsHtml}
${extratoHtml}
<div class="assin"><div>Produção</div><div>Almoxarifado</div><div>Data / Hora</div></div>
<script>window.onload=function(){window.print()}</script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { alert('Libere pop-ups para imprimir o relatório.'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
  };

  const vazio = !isLoading && !error && filtrado.linhas.length === 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{TITULO} — movimentação de insumos</DialogTitle></DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label className="text-xs">De</Label><Input type="date" value={de} max={ate} onChange={(e) => setDe(e.target.value)} className="w-[150px]" /></div>
            <div className="space-y-1"><Label className="text-xs">Até</Label><Input type="date" value={ate} min={de} onChange={(e) => setAte(e.target.value)} className="w-[150px]" /></div>
            <div className="space-y-1">
              <Label className="text-xs">Categoria</Label>
              <Select value={categoria} onValueChange={setCategoria}>
                <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="todas">Todas</SelectItem>
                  {CATEGORIAS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Insumo</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                <Input placeholder="Nome ou código" value={busca} onChange={(e) => setBusca(e.target.value)} className="pl-9 w-[200px]" />
              </div>
            </div>
            <Button variant="outline" size="sm" className="h-9" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
            <div className="flex flex-col gap-1 ml-2 text-sm">
              <label className="flex items-center gap-1.5"><Checkbox checked={soMovimentados} onCheckedChange={(v) => setSoMovimentados(!!v)} /> Só insumos movimentados</label>
              <label className="flex items-center gap-1.5"><Checkbox checked={comCusto} onCheckedChange={(v) => setComCusto(!!v)} /> Mostrar custos (R$)</label>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">Erro ao carregar: {String((error as any)?.message || error)}</p>}
          {isLoading && <p className="text-sm text-gray-400 flex items-center gap-1"><Loader2 className="h-4 w-4 animate-spin" /> Carregando movimentações...</p>}

          {data && (
            <div className={`grid grid-cols-3 ${comCusto ? 'md:grid-cols-7' : 'md:grid-cols-3'} gap-2 text-sm`}>
              <Kpi t="Insumos" v={filtrado.tot.insumos} />
              <Kpi t="Movimentações" v={filtrado.tot.movimentos} />
              <Kpi t="OPs com consumo" v={filtrado.tot.ops} />
              {comCusto && <Kpi t="Compras (NF)" v={brl(filtrado.tot.compras)} />}
              {comCusto && <Kpi t="Consumo em OP" v={brl(filtrado.tot.consumo)} />}
              {comCusto && <Kpi t="Perdas" v={brl(filtrado.tot.perdas)} />}
              {comCusto && <Kpi t="Estoque final" v={brl(filtrado.tot.saldo)} />}
            </div>
          )}
          {filtrado.tot.divergentes > 0 && (
            <p className="text-xs text-amber-700 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> {filtrado.tot.divergentes} insumo(s) com divergência no histórico (saldo alterado fora de movimentação) — destacados em amarelo.
            </p>
          )}

          <Tabs value={aba} onValueChange={setAba}>
            <TabsList>
              <TabsTrigger value="resumo">Resumo por insumo ({filtrado.linhas.length})</TabsTrigger>
              <TabsTrigger value="ops">Consumo por OP ({filtrado.ops.length})</TabsTrigger>
              <TabsTrigger value="extrato">Extrato ({filtrado.extrato.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="resumo">
              <div className="border rounded-lg overflow-auto max-h-[48vh]">
                <Table>
                  <TableHeader className="sticky top-0 bg-white z-10">
                    <TableRow>
                      <TableHead>Insumo</TableHead>
                      <TableHead>Un.</TableHead>
                      <TableHead className="text-right">Saldo inicial</TableHead>
                      <TableHead className="text-right text-emerald-700">Compra NF</TableHead>
                      <TableHead className="text-right text-emerald-700">Produção OP</TableHead>
                      <TableHead className="text-right text-emerald-700">Outras ent.</TableHead>
                      <TableHead className="text-right text-red-600">Consumo OP</TableHead>
                      <TableHead className="text-right text-red-600">Saída</TableHead>
                      <TableHead className="text-right text-red-600">Perda</TableHead>
                      <TableHead className="text-right text-blue-600">Ajuste/Est.</TableHead>
                      <TableHead className="text-right">Saldo final</TableHead>
                      {comCusto && <TableHead className="text-right">R$ consumo</TableHead>}
                      {comCusto && <TableHead className="text-right">R$ saldo</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtrado.linhas.map((l: any) => (
                      <TableRow key={l.material_id} className={Math.abs(n(l.divergencia)) > 0.0005 ? 'bg-amber-50' : ''}>
                        <TableCell className="font-medium">
                          {l.material}
                          <Badge variant="outline" className="ml-1 text-[10px] capitalize">{catLabel(l.categoria)}</Badge>
                        </TableCell>
                        <TableCell className="text-xs">{l.unidade}</TableCell>
                        <TableCell className="text-right">{fq(l.saldo_inicial)}</TableCell>
                        <TableCell className="text-right">{fz(l.compras)}</TableCell>
                        <TableCell className="text-right">{fz(l.producao)}</TableCell>
                        <TableCell className="text-right">{fz(l.outras_entradas)}</TableCell>
                        <TableCell className="text-right">{fz(l.consumo_op)}</TableCell>
                        <TableCell className="text-right">{fz(l.saidas)}</TableCell>
                        <TableCell className="text-right">{fz(l.perdas)}</TableCell>
                        <TableCell className="text-right" title={`Ajustes ${fqs(l.ajustes)} · Estornos ${fqs(l.estornos)}${Math.abs(n(l.divergencia)) > 0.0005 ? ` · Divergência ${fqs(l.divergencia)}` : ''}`}>
                          {fqs(n(l.ajustes) + n(l.estornos))}
                        </TableCell>
                        <TableCell className={`text-right font-semibold ${n(l.saldo_final) < 0 ? 'text-red-600' : ''}`}>{fq(l.saldo_final)}</TableCell>
                        {comCusto && <TableCell className="text-right">{n(l.valor_consumo_op) ? brl(l.valor_consumo_op) : '-'}</TableCell>}
                        {comCusto && <TableCell className="text-right">{brl(l.valor_saldo_final)}</TableCell>}
                      </TableRow>
                    ))}
                    {vazio && <TableRow><TableCell colSpan={13} className="text-center text-gray-400 py-8">Nenhum insumo movimentado no período</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="ops">
              <div className="border rounded-lg overflow-auto max-h-[48vh]">
                <Table>
                  <TableHeader className="sticky top-0 bg-white z-10">
                    <TableRow>
                      <TableHead>OP</TableHead>
                      <TableHead>Produto / Lote</TableHead>
                      <TableHead>Movimento</TableHead>
                      <TableHead>Insumo</TableHead>
                      <TableHead className="text-right">Qtd</TableHead>
                      {comCusto && <TableHead className="text-right">Valor</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtrado.ops.flatMap((o: any) => {
                      const itens = [...o.insumos.map((i: any) => ({ ...i, mov: 'Consumo' })), ...o.perdas.map((i: any) => ({ ...i, mov: 'Perda/Avaria' })), ...o.gerados.map((i: any) => ({ ...i, mov: 'Gerado' }))];
                      return itens.map((i: any, idx: number) => (
                        <TableRow key={o.id + i.material_id + i.mov} className={idx === 0 ? 'border-t-2' : ''}>
                          <TableCell className="font-mono text-xs">{idx === 0 ? o.op : ''}</TableCell>
                          <TableCell className="text-xs">{idx === 0 ? <>{o.produto || '-'}<br /><span className="text-gray-400">lote {o.lote || '-'} · {dBR(o.data_producao)}</span></> : ''}</TableCell>
                          <TableCell className={`text-xs ${i.mov === 'Gerado' ? 'text-emerald-700' : i.mov === 'Perda/Avaria' ? 'text-amber-700' : 'text-red-600'}`}>{i.mov}</TableCell>
                          <TableCell>{i.material}</TableCell>
                          <TableCell className="text-right">{fq(i.quantidade)} <span className="text-xs text-gray-400">{i.unidade}</span></TableCell>
                          {comCusto && <TableCell className="text-right">{brl(i.valor)}</TableCell>}
                        </TableRow>
                      ));
                    })}
                    {filtrado.ops.length === 0 && !isLoading && <TableRow><TableCell colSpan={6} className="text-center text-gray-400 py-8">Nenhuma OP consumiu insumos no período</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="extrato">
              <div className="border rounded-lg overflow-auto max-h-[48vh]">
                <Table>
                  <TableHeader className="sticky top-0 bg-white z-10">
                    <TableRow>
                      <TableHead>Data/Hora</TableHead>
                      <TableHead>Insumo</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="text-right">Qtd (±)</TableHead>
                      <TableHead className="text-right">Saldo</TableHead>
                      <TableHead>OP / Observação</TableHead>
                      <TableHead>Usuário</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtrado.extrato.map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs">{dhBR(m.data)}</TableCell>
                        <TableCell>{m.material}</TableCell>
                        <TableCell className={`text-xs ${TIPO_COR[m.coluna] || ''}`}>{m.coluna_label}</TableCell>
                        <TableCell className="text-right">{fqs(m.quantidade)}</TableCell>
                        <TableCell className="text-right">{fq(m.saldo_novo)}</TableCell>
                        <TableCell className="max-w-[300px] truncate text-xs" title={m.obs || ''}>{m.op ? `${m.op} · ` : ''}{m.obs || '-'}</TableCell>
                        <TableCell className="text-xs">{m.usuario || '-'}</TableCell>
                      </TableRow>
                    ))}
                    {filtrado.extrato.length === 0 && !isLoading && <TableRow><TableCell colSpan={7} className="text-center text-gray-400 py-8">Nenhuma movimentação no período</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter className="items-center">
          <label className="flex items-center gap-1.5 text-sm mr-auto"><Checkbox checked={imprimirExtrato} onCheckedChange={(v) => setImprimirExtrato(!!v)} /> Incluir extrato na impressão</label>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button variant="outline" onClick={doExcel} disabled={!data}><FileSpreadsheet className="h-4 w-4 mr-1" /> Excel</Button>
          <Button onClick={doPrint} disabled={!data} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <Printer className="h-4 w-4 mr-1" /> Imprimir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Kpi({ t, v }: { t: string; v: any }) {
  return <div className="rounded-lg border p-2"><p className="text-xs text-gray-500">{t}</p><p className="font-bold">{v}</p></div>;
}
