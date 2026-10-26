// ============================================================================
// RELATÓRIO DE QUANTIDADE DE PRODUTOS DOS PEDIDOS SELECIONADOS (Pipeline)
// (26/out/2026) Soma, por produto, as quantidades dos cards selecionados no
// pipeline de faturamento — serve para separar/conferir a carga antes de
// faturar ou montar rota. Só leitura: os produtos já vêm no card
// (billing_pipeline.products), nenhuma chamada extra ao servidor.
// Exporta Excel (Resumo por produto + Detalhe por pedido) e imprime.
// ============================================================================
import { useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, Printer, Package } from 'lucide-react';
import { exportSheetsToExcel } from '@/lib/excelExport';

export interface ItemRelatorioProdutos {
  id: string;
  customerName: string;
  orderNumber?: string | null;
  invoiceNumber?: string | null;
  stage?: string;
  omieInstanceName?: string | null;
  sellerName?: string | null;
  products: Array<{ id?: string; name: string; quantity: number; unitPrice?: number; totalPrice?: number }> | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ItemRelatorioProdutos[];
  stageLabel?: (stage: string) => string;
}

const num = (v: any) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const fmtQtd = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function agregarProdutos(items: ItemRelatorioProdutos[]) {
  const porProduto = new Map<string, { nome: string; quantidade: number; pedidos: Set<string>; valor: number }>();
  const detalhe: Array<{ pedido: string; cliente: string; nf: string; etapa: string; instancia: string; vendedor: string; produto: string; quantidade: number; valor: number }> = [];
  let pedidosComProduto = 0;
  let pedidosSemProduto = 0;

  for (const it of items) {
    const prods = Array.isArray(it.products) ? it.products : [];
    if (prods.length === 0) { pedidosSemProduto++; continue; }
    pedidosComProduto++;
    for (const p of prods) {
      const nome = (p?.name || '').trim() || '(sem nome)';
      const chave = nome.toLowerCase();
      const q = num(p?.quantity);
      const v = num(p?.totalPrice);
      const cur = porProduto.get(chave) || { nome, quantidade: 0, pedidos: new Set<string>(), valor: 0 };
      cur.quantidade += q;
      cur.valor += v;
      cur.pedidos.add(it.id);
      porProduto.set(chave, cur);
      detalhe.push({
        pedido: it.orderNumber || '',
        cliente: it.customerName || '',
        nf: it.invoiceNumber || '',
        etapa: it.stage || '',
        instancia: it.omieInstanceName || '',
        vendedor: it.sellerName || '',
        produto: nome,
        quantidade: q,
        valor: v,
      });
    }
  }

  const resumo = Array.from(porProduto.values())
    .map((r) => ({ nome: r.nome, quantidade: r.quantidade, pedidos: r.pedidos.size, valor: r.valor }))
    .sort((a, b) => b.quantidade - a.quantidade || a.nome.localeCompare(b.nome, 'pt-BR'));

  const totalQtd = resumo.reduce((s, r) => s + r.quantidade, 0);
  const totalValor = resumo.reduce((s, r) => s + r.valor, 0);
  return { resumo, detalhe, totalQtd, totalValor, pedidosComProduto, pedidosSemProduto };
}

export default function RelatorioProdutosSelecionados({ open, onOpenChange, items, stageLabel }: Props) {
  const dados = useMemo(() => agregarProdutos(items), [items]);
  const etiqueta = (s: string) => (stageLabel ? stageLabel(s) : s);
  const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const exportar = () => {
    const resumo = dados.resumo.map((r) => ({
      Produto: r.nome,
      Quantidade: r.quantidade,
      'Nº de pedidos': r.pedidos,
      'Valor (R$)': Number(r.valor.toFixed(2)),
    }));
    resumo.push({ Produto: 'TOTAL', Quantidade: dados.totalQtd, 'Nº de pedidos': items.length, 'Valor (R$)': Number(dados.totalValor.toFixed(2)) });
    const detalhe = dados.detalhe.map((d) => ({
      Pedido: d.pedido,
      Cliente: d.cliente,
      'NF-e': d.nf,
      Etapa: etiqueta(d.etapa),
      Instância: d.instancia,
      Vendedor: d.vendedor,
      Produto: d.produto,
      Quantidade: d.quantidade,
      'Valor (R$)': Number(d.valor.toFixed(2)),
    }));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    exportSheetsToExcel(
      [
        { nome: 'Resumo por produto', linhas: resumo },
        { nome: 'Detalhe por pedido', linhas: detalhe },
      ],
      `produtos-pedidos-selecionados-${stamp}`,
    );
  };

  const imprimir = () => {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const linhas = dados.resumo
      .map((r) => `<tr><td>${esc(r.nome)}</td><td class="n">${fmtQtd(r.quantidade)}</td><td class="n">${r.pedidos}</td><td class="n">${fmtBRL(r.valor)}</td></tr>`)
      .join('');
    const pedidos = items
      .map((it) => `<tr><td>${esc(it.orderNumber || '—')}</td><td>${esc(it.customerName)}</td><td>${esc(it.invoiceNumber || '—')}</td><td>${esc(etiqueta(it.stage || ''))}</td><td class="n">${fmtQtd((it.products || []).reduce((s, p) => s + num(p.quantity), 0))}</td></tr>`)
      .join('');
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Produtos dos pedidos selecionados</title>
<style>body{font-family:Arial,Helvetica,sans-serif;font-size:12px;margin:20px;color:#111}h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px}
.meta{color:#555;margin-bottom:10px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:4px 6px}th{background:#eee;text-align:left}
td.n,th.n{text-align:right}tfoot td{font-weight:bold;background:#f5f5f5}@media print{button{display:none}}</style></head><body>
<h1>Quantidade de produtos — pedidos selecionados</h1>
<div class="meta">${items.length} pedido(s) · gerado em ${esc(dataHora)}${dados.pedidosSemProduto ? ` · ${dados.pedidosSemProduto} pedido(s) sem itens` : ''}</div>
<h2>Resumo por produto</h2>
<table><thead><tr><th>Produto</th><th class="n">Quantidade</th><th class="n">Pedidos</th><th class="n">Valor</th></tr></thead>
<tbody>${linhas}</tbody>
<tfoot><tr><td>TOTAL</td><td class="n">${fmtQtd(dados.totalQtd)}</td><td class="n">${items.length}</td><td class="n">${fmtBRL(dados.totalValor)}</td></tr></tfoot></table>
<h2>Pedidos</h2>
<table><thead><tr><th>Pedido</th><th>Cliente</th><th>NF-e</th><th>Etapa</th><th class="n">Qtd itens</th></tr></thead><tbody>${pedidos}</tbody></table>
<script>window.onload=function(){window.print();}</script></body></html>`;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { alert('O navegador bloqueou a janela de impressão. Libere pop-ups para este site.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-blue-600" />
            Quantidade de produtos — {items.length} {items.length === 1 ? 'pedido selecionado' : 'pedidos selecionados'}
          </DialogTitle>
          <DialogDescription>
            Soma das quantidades por produto nos pedidos marcados no pipeline.
            {dados.pedidosSemProduto > 0 && (
              <span className="text-amber-700"> {dados.pedidosSemProduto} pedido(s) sem itens cadastrados ficaram de fora.</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-auto border rounded-md">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-100 dark:bg-gray-800">
              <tr>
                <th className="text-left p-2">Produto</th>
                <th className="text-right p-2">Quantidade</th>
                <th className="text-right p-2">Pedidos</th>
                <th className="text-right p-2">Valor</th>
              </tr>
            </thead>
            <tbody>
              {dados.resumo.length === 0 && (
                <tr><td colSpan={4} className="p-4 text-center text-gray-500">Nenhum produto nos pedidos selecionados.</td></tr>
              )}
              {dados.resumo.map((r) => (
                <tr key={r.nome} className="border-t hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="p-2">{r.nome}</td>
                  <td className="p-2 text-right font-semibold tabular-nums">{fmtQtd(r.quantidade)}</td>
                  <td className="p-2 text-right tabular-nums">{r.pedidos}</td>
                  <td className="p-2 text-right tabular-nums">{fmtBRL(r.valor)}</td>
                </tr>
              ))}
            </tbody>
            {dados.resumo.length > 0 && (
              <tfoot className="sticky bottom-0 bg-gray-100 dark:bg-gray-800 font-bold">
                <tr className="border-t-2">
                  <td className="p-2">TOTAL</td>
                  <td className="p-2 text-right tabular-nums">{fmtQtd(dados.totalQtd)}</td>
                  <td className="p-2 text-right tabular-nums">{items.length}</td>
                  <td className="p-2 text-right tabular-nums">{fmtBRL(dados.totalValor)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={imprimir} disabled={dados.resumo.length === 0} data-testid="button-print-relatorio-produtos">
            <Printer className="h-4 w-4 mr-1" /> Imprimir
          </Button>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={exportar} disabled={dados.resumo.length === 0} data-testid="button-export-relatorio-produtos">
            <Download className="h-4 w-4 mr-1" /> Exportar Excel
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
