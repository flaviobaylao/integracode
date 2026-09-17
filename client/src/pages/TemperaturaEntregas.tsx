import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { toast } from "@/hooks/use-toast";
import { Thermometer, FileDown, Search, Loader2, Truck } from "lucide-react";

/**
 * TEMPERATURA DAS ENTREGAS (Logística) — set/2026
 * Temperatura da carga informada pelo motorista em cada entrega de CAMINHÃO
 * (entre "Iniciar Entrega" e a finalização), por nota fiscal. PDF com timbre Honest.
 * Fonte: GET /api/deliveries/reports/temperaturas (server/temperatura-entregas.ts).
 */

interface Linha {
  id: string; nf: string | null; pedido: string | null; cliente: string; endereco: string | null;
  status: string; data: string; rota: string | null; motorista: string; motoristaEmail: string | null;
  inicioEntrega: string | null; finalizadaEm: string | null;
  temperatura: number | null; temperaturaEm: string | null; origem: string | null;
}
interface Resposta {
  linhas: Linha[];
  resumo: { entregas: number; comTemperatura: number; semTemperatura: number; minima: number | null; maxima: number | null; media: number | null };
  motoristas: { label: string; value: string }[];
}

const COMPANY = 'PURO INDUSTRIA E COMERCIO DE PRODUTOS NATURAIS LTDA';
const GREEN: [number, number, number] = [31, 111, 67];
const LOGO_RATIO = 619 / 490;

const hojeISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const inicioMesISO = () => hojeISO().slice(0, 8) + '01';
const fmtData = (s: string | null) => { if (!s) return '-'; const d = new Date(String(s).slice(0, 10) + 'T12:00:00'); return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('pt-BR'); };
const fmtHora = (s: string | null) => { if (!s) return '-'; const d = new Date(s); return isNaN(d.getTime()) ? '-' : d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }); };
const fmtTemp = (t: number | null) => t == null ? '-' : `${t.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;
const statusLabel = (s: string) => s === 'efetuada' ? 'Entregue' : s === 'devolvida' ? 'Devolvida' : s;

async function carregarLogo(): Promise<string | null> {
  try {
    const r = await fetch('/honest-logo.png');
    const blob = await r.blob();
    return await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onloadend = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(blob); });
  } catch { return null; }
}

export default function TemperaturaEntregas() {
  const [inicio, setInicio] = useState(inicioMesISO());
  const [fim, setFim] = useState(hojeISO());
  const [motorista, setMotorista] = useState('all');
  const [busca, setBusca] = useState('');
  const [gerando, setGerando] = useState(false);

  const { data, isLoading, error } = useQuery<Resposta>({
    queryKey: ['/api/deliveries/reports/temperaturas', inicio, fim, motorista],
    queryFn: async () => {
      const p = new URLSearchParams({ inicio, fim, motorista });
      const r = await fetch(`/api/deliveries/reports/temperaturas?${p}`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!inicio && !!fim,
  });

  const linhas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const todas = data?.linhas || [];
    if (!q) return todas;
    return todas.filter(l => [l.nf, l.pedido, l.cliente, l.motorista, l.rota].some(v => String(v || '').toLowerCase().includes(q)));
  }, [data, busca]);

  const resumo = useMemo(() => {
    const t = linhas.filter(l => l.temperatura != null).map(l => l.temperatura as number);
    return {
      entregas: linhas.length, com: t.length, sem: linhas.length - t.length,
      min: t.length ? Math.min(...t) : null, max: t.length ? Math.max(...t) : null,
      media: t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length * 10) / 10 : null,
    };
  }, [linhas]);

  const temHistorico = linhas.some(l => l.origem === 'historico');
  const nomeMotorista = motorista === 'all' ? 'Todos' : (data?.motoristas.find(m => m.value === motorista)?.label || motorista);

  const gerarPdf = async () => {
    if (!linhas.length) { toast({ title: 'Nada para imprimir', description: 'Nenhuma entrega no filtro.' }); return; }
    setGerando(true);
    try {
      const logo = await carregarLogo();
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const W = 297;
      const cabecalho = () => {
        if (logo) { let dw = 32, dh = 32 / LOGO_RATIO; if (dh > 13) { dh = 13; dw = 13 * LOGO_RATIO; } try { doc.addImage(logo, 'PNG', 12, 8, dw, dh); } catch {} }
        doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREEN);
        doc.text(COMPANY, 47, 11);
        doc.setTextColor(80); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
        doc.text('Honest Sucos Naturais · AVENIDA T 63, nº 4446, QUADRA 03 LOTE 71 SALA 1 E GALPAO, ANHANGUERA', 47, 14.5);
        doc.text('Goiânia/GO · CEP 74.335-102 · CNPJ 28.295.493/0002-34', 47, 17.5);
        doc.text('Contato: (62) 3093-5050 · (62) 99327-5962 · (62) 99322-9699 · (62) 99578-2812', 47, 20.5);
        doc.setTextColor(0); doc.setFontSize(14); doc.setFont('helvetica', 'bold');
        doc.text('TEMPERATURA DAS ENTREGAS', W - 12, 12, { align: 'right' });
        doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        doc.text(`Período ${fmtData(inicio)} a ${fmtData(fim)} · Motorista: ${nomeMotorista}`, W - 12, 17, { align: 'right' });
        doc.text('Entregas em caminhão · temperatura da carga por nota fiscal', W - 12, 21, { align: 'right' });
        doc.setDrawColor(...GREEN); doc.setLineWidth(0.6); doc.line(12, 24, W - 12, 24); doc.setLineWidth(0.2); doc.setDrawColor(0);
      };
      cabecalho();

      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      doc.text(
        `Entregas: ${resumo.entregas}   ·   Com temperatura: ${resumo.com}   ·   Mínima: ${fmtTemp(resumo.min)}   ·   Média: ${fmtTemp(resumo.media)}   ·   Máxima: ${fmtTemp(resumo.max)}`,
        12, 30);

      autoTable(doc, {
        startY: 34,
        margin: { top: 28, left: 12, right: 12, bottom: 16 },
        head: [['Nota Fiscal', 'Pedido', 'Data', 'Cliente', 'Motorista', 'Rota', 'Início', 'Finalizada', 'Situação', 'Temperatura']],
        body: linhas.map(l => [
          l.nf || '-', l.pedido || '-', fmtData(l.data), l.cliente, l.motorista, l.rota || '-',
          fmtHora(l.inicioEntrega), fmtHora(l.finalizadaEm), statusLabel(l.status),
          fmtTemp(l.temperatura) + (l.origem === 'historico' ? ' (histórico)' : ''),
        ]),
        styles: { fontSize: 7.5, cellPadding: 1.4, overflow: 'linebreak' },
        headStyles: { fillColor: GREEN, textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 248, 246] },
        columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 20 }, 2: { cellWidth: 18 }, 3: { cellWidth: 70 }, 6: { cellWidth: 14 }, 7: { cellWidth: 17 }, 8: { cellWidth: 18 }, 9: { cellWidth: 30, halign: 'right', fontStyle: 'bold' } },
        didDrawPage: () => { if ((doc as any).getCurrentPageInfo().pageNumber > 1) cabecalho(); },
      });

      const paginas = doc.getNumberOfPages();
      for (let i = 1; i <= paginas; i++) {
        doc.setPage(i);
        doc.setFontSize(6.5); doc.setTextColor(110); doc.setFont('helvetica', 'normal');
        const nota = temHistorico ? '(histórico) Valor anterior ao início de registro pelo sistema Integra2.0  ·  ' : '';
        doc.text(`${nota}Emitido pelo Integra em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, 12, 203);
        doc.text(`${i}/${paginas}`, W - 12, 203, { align: 'right' });
      }
      doc.save(`Temperatura_Entregas_${inicio}_a_${fim}.pdf`);
    } catch (e: any) {
      toast({ title: 'Erro ao gerar PDF', description: e?.message, variant: 'destructive' });
    } finally {
      setGerando(false);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <BackToDashboardButton />
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Thermometer className="h-6 w-6 text-sky-600" /> Temperatura das Entregas</h1>
          <p className="text-sm text-muted-foreground flex items-center gap-1"><Truck className="h-4 w-4" /> Entregas em caminhão · temperatura da carga por nota fiscal</p>
        </div>
        <Button onClick={gerarPdf} disabled={gerando || isLoading || !linhas.length} className="bg-green-700 hover:bg-green-800" data-testid="btn-pdf-temperaturas">
          {gerando ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileDown className="h-4 w-4 mr-2" />} Relatório PDF
        </Button>
      </div>

      <Card>
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div><Label>De</Label><Input type="date" value={inicio} onChange={e => setInicio(e.target.value)} /></div>
          <div><Label>Até</Label><Input type="date" value={fim} onChange={e => setFim(e.target.value)} /></div>
          <div>
            <Label>Motorista</Label>
            <Select value={motorista} onValueChange={setMotorista}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {(data?.motoristas || []).filter(m => m.value).map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Buscar</Label>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2 top-3 text-muted-foreground" />
              <Input className="pl-8" placeholder="NF, pedido, cliente..." value={busca} onChange={e => setBusca(e.target.value)} data-testid="busca-temperaturas" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ['Entregas', String(resumo.entregas)],
          ['Sem temperatura', String(resumo.sem)],
          ['Mínima', fmtTemp(resumo.min)],
          ['Média', fmtTemp(resumo.media)],
          ['Máxima', fmtTemp(resumo.max)],
        ].map(([k, v]) => (
          <Card key={k}><CardContent className="p-3"><p className="text-xs text-muted-foreground">{k}</p><p className="text-xl font-bold">{v}</p></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : error ? (
            <p className="p-6 text-red-600">{(error as any).message}</p>
          ) : !linhas.length ? (
            <p className="p-6 text-muted-foreground">Nenhuma entrega de caminhão finalizada no período.</p>
          ) : (
            <table className="w-full text-sm" data-testid="tabela-temperaturas">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2">Nota Fiscal</th><th className="p-2">Pedido</th><th className="p-2">Data</th><th className="p-2">Cliente</th>
                  <th className="p-2">Motorista</th><th className="p-2">Início</th><th className="p-2">Finalizada</th><th className="p-2">Situação</th>
                  <th className="p-2 text-right">Temperatura</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map(l => (
                  <tr key={l.id} className="border-t">
                    <td className="p-2 font-medium">{l.nf || '-'}</td>
                    <td className="p-2">{l.pedido || '-'}</td>
                    <td className="p-2 whitespace-nowrap">{fmtData(l.data)}</td>
                    <td className="p-2">{l.cliente}</td>
                    <td className="p-2">{l.motorista}</td>
                    <td className="p-2">{fmtHora(l.inicioEntrega)}</td>
                    <td className="p-2">{fmtHora(l.finalizadaEm)}</td>
                    <td className="p-2"><Badge variant="outline" className={l.status === 'devolvida' ? 'text-red-700 border-red-300' : 'text-green-700 border-green-300'}>{statusLabel(l.status)}</Badge></td>
                    <td className="p-2 text-right font-semibold whitespace-nowrap">
                      {l.temperatura == null ? <span className="text-amber-600">não informada</span> : fmtTemp(l.temperatura)}
                      {l.origem === 'historico' && <Badge variant="outline" className="ml-2 text-xs text-slate-600 border-slate-300" title="Valor anterior ao início de registro pelo sistema Integra2.0">histórico</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
