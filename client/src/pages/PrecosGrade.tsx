import { useMemo, useState } from "react";
import { hojeBR } from '@shared/tempo';
import { useQuery } from "@tanstack/react-query";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportToExcel, ExportExcelButton, useTableSort, SortableTh } from "@/lib/tableTools";
import { writeLine, brl as brlPdf } from "@/lib/pdfLayout";
import honestLogo from "@/assets/honest-logo.png";

function brl(v: any) {
  const n = Number(v);
  return isNaN(n) ? "-" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function PrecosGrade() {
  const [q, setQ] = useState("");
  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort("tabela", "asc");
  const items = useQuery({ queryKey: ["/api/synced-table", "price_table_items"], queryFn: async () => (await fetch("/api/synced-table/price_table_items?limit=5000", { credentials: "include" })).json() });
  const tables = useQuery({ queryKey: ["/api/synced-table", "price_tables"], queryFn: async () => (await fetch("/api/synced-table/price_tables?limit=2000", { credentials: "include" })).json() });
  const products = useQuery({ queryKey: ["/api/products"], queryFn: async () => (await fetch("/api/products", { credentials: "include" })).json() });

  const tableName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of (tables.data?.rows || [])) m[t.id] = t.name;
    return m;
  }, [tables.data]);
  const productName = useMemo(() => {
    const m: Record<string, string> = {};
    const arr = Array.isArray(products.data) ? products.data : (products.data?.products || []);
    for (const p of arr) m[p.id] = p.name || p.productName || p.description;
    return m;
  }, [products.data]);

  const rows = useMemo(() => {
    const r = (items.data?.rows || []).map((it: any) => ({
      tabela: tableName[it.price_table_id] || it.price_table_id,
      produto: productName[it.product_id] || it.product_id,
      preco: it.price,
    }));
    const filtered = !q.trim()
      ? r
      : (() => {
          const s = q.toLowerCase();
          return r.filter((x: any) => String(x.tabela).toLowerCase().includes(s) || String(x.produto).toLowerCase().includes(s));
        })();
    // Ordenação A-Z / Z-A pela coluna clicada. `preco` ordena como número.
    return sortRows(filtered, (row: any, key: string) => (key === "preco" ? Number(row.preco) || 0 : row[key]));
  }, [items.data, tableName, productName, q, sortKey, sortDir]);

  const hoje = new Date().toLocaleDateString("pt-BR");

  const exportarExcel = () => {
    exportToExcel(
      rows.map((r: any) => ({ Tabela: r.tabela, Produto: r.produto, Preco: Number(r.preco) || 0 })),
      `tabela_de_precos_${hojeBR()}`
    );
  };

  // PDF em layout de envio ao cliente: capa com logo, uma seção por tabela de
  // preços e o produto/preço em duas colunas legíveis. Respeita o filtro da tela.
  const exportarPDF = () => {
    if (!rows.length) return;
    const pdf = new jsPDF();
    const larguraPagina = pdf.internal.pageSize.getWidth();

    try {
      pdf.addImage(honestLogo, "PNG", larguraPagina - 55, 10, 40, 40);
    } catch { /* sem logo, segue */ }

    pdf.setFontSize(20);
    pdf.text("Tabela de Preços", 20, 28);
    let y = 38;
    y = writeLine(pdf, y, ["Honest Sucos", "Sucos Naturais e Saudáveis"], { size: 11, gap: 6 });
    y = writeLine(pdf, y + 2, `Emitida em ${hoje}`, { size: 10, gap: 6 });

    // Agrupa por tabela de preços, mantendo a ordem alfabética das tabelas.
    const grupos = new Map<string, Array<{ produto: string; preco: any }>>();
    for (const r of rows as any[]) {
      const k = String(r.tabela || "—");
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k)!.push({ produto: r.produto, preco: r.preco });
    }
    const nomesTabelas = Array.from(grupos.keys()).sort((a, b) => a.localeCompare(b, "pt-BR"));

    for (const nome of nomesTabelas) {
      const lista = grupos.get(nome)!.slice().sort((a, b) => String(a.produto).localeCompare(String(b.produto), "pt-BR"));
      y = writeLine(pdf, y + 6, nome, { size: 13, gap: 8 });
      // Quando a lista de uma tabela atravessa a página, repete o nome no topo
      // com "(continuação)" — senão o cliente perde a referência do que está lendo.
      let primeiraPaginaDaSecao = true;
      autoTable(pdf, {
        head: [["Produto", "Preço"]],
        body: lista.map((l) => [l.produto, brlPdf(Number(l.preco) || 0)]),
        startY: y,
        margin: { left: 20, right: 20, top: 24, bottom: 22 },
        styles: { fontSize: 10, cellPadding: 2.5 },
        headStyles: { fillColor: [41, 128, 185], textColor: 255 },
        columnStyles: { 1: { halign: "right", cellWidth: 32 } },
        didDrawPage: () => {
          if (!primeiraPaginaDaSecao) {
            pdf.setFontSize(13);
            pdf.text(`${nome} (continuação)`, 20, 18);
          }
          primeiraPaginaDaSecao = false;
        },
      });
      y = ((pdf as any).lastAutoTable?.finalY || y) + 4;
    }

    // Rodapé de envio ao cliente + numeração em todas as páginas.
    y = writeLine(pdf, y + 6, [
      "Preços sujeitos a alteração sem aviso prévio.",
      "Consulte seu vendedor para condições de pagamento e prazo de entrega.",
    ], { size: 9, gap: 5 });

    const totalPaginas = (pdf as any).internal.getNumberOfPages();
    for (let p = 1; p <= totalPaginas; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8);
      pdf.setTextColor(130);
      pdf.text(
        `Honest Sucos · Tabela de Preços · ${hoje} · Página ${p} de ${totalPaginas}`,
        larguraPagina / 2,
        pdf.internal.pageSize.getHeight() - 8,
        { align: "center" }
      );
      pdf.setTextColor(0);
    }

    pdf.save(`tabela_de_precos_${hojeBR()}.pdf`);
  };

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Preços (Grade)</h1>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Input placeholder="Buscar produto ou tabela..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <span className="text-sm text-gray-500">{rows.length} preços</span>
        <div className="ml-auto flex items-center gap-2">
          <ExportExcelButton onClick={exportarExcel} testId="button-exportar-precos-excel" />
          <Button
            type="button"
            variant="outline"
            onClick={exportarPDF}
            disabled={!rows.length}
            data-testid="button-exportar-precos-pdf"
          >
            <i className="fas fa-file-pdf mr-2" /> Exportar PDF
          </Button>
        </div>
      </div>
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTh label="Tabela" colKey="tabela" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="h-12 px-4 text-left align-middle font-medium text-muted-foreground" />
              <SortableTh label="Produto" colKey="produto" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="h-12 px-4 text-left align-middle font-medium text-muted-foreground" />
              <SortableTh label="Preço" colKey="preco" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="h-12 px-4 text-left align-middle font-medium text-muted-foreground" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r: any, i: number) => (
              <TableRow key={i}><TableCell>{r.tabela}</TableCell><TableCell>{r.produto}</TableCell><TableCell>{brl(r.preco)}</TableCell></TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={3} className="text-center text-gray-400 py-8">Nenhum preço</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
