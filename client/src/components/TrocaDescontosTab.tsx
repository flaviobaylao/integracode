// Aba "Descontos por troca" do módulo Metas (política de trocas 23/10/2026).
// Troca por VENCIMENTO é comercial: a comissão sobre o valor trocado (preço da
// última NF do cliente × % de comissão do vendedor que faturou essa NF) é
// descontada da comissão do mês da troca. Trocas de qualidade aparecem com
// "Mostrar também trocas de qualidade", sem desconto.
import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "lucide-react";
import type { User } from "@shared/schema";

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const MOTIVO: Record<string, { label: string; cls: string }> = {
  vencido: { label: 'Vencido', cls: 'bg-red-100 text-red-800' },
  fermentado: { label: 'Fermentado', cls: 'bg-amber-100 text-amber-800' },
  lacre: { label: 'Lacre', cls: 'bg-amber-100 text-amber-800' },
  tampa: { label: 'Tampa', cls: 'bg-amber-100 text-amber-800' },
  avaria: { label: 'Avaria / deformação / rótulo', cls: 'bg-amber-100 text-amber-800' },
};
const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const dataBR = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? `${s}T12:00:00` : s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

interface Registro {
  id: string; salesCardId: string; cliente: string | null; motivo: string; categoria: string;
  temperatura: number | null; valorTroca: number; nfNumero: string | null; nfData: string | null;
  vendedorId: string | null; vendedor: string | null; comissaoPct: number; desconto: number; data: string;
}
interface Resp {
  ym: string; registros: Registro[];
  porVendedor: Array<{ vendedorId: string; vendedor: string; trocas: number; valorTroca: number; desconto: number }>;
}

export default function TrocaDescontosTab({ user }: { user: User }) {
  const hoje = new Date();
  const [mes, setMes] = useState(hoje.getMonth() + 1);
  const [ano, setAno] = useState(hoje.getFullYear());
  const [todos, setTodos] = useState(false);
  const ym = `${ano}-${String(mes).padStart(2, '0')}`;
  const anos = Array.from({ length: 3 }, (_, i) => hoje.getFullYear() - 1 + i);
  const equipe = ['admin', 'coordinator', 'administrative'].includes((user as any).role);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ['/api/trocas/descontos', ym, todos],
    queryFn: async () => {
      const res = await fetch(`/api/trocas/descontos?ym=${ym}${todos ? '&todos=1' : ''}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Falha ao carregar');
      return res.json();
    },
  });

  const registros = data?.registros || [];
  const totalDesconto = (data?.porVendedor || []).reduce((s, v) => s + v.desconto, 0);
  const totalValor = (data?.porVendedor || []).reduce((s, v) => s + v.valorTroca, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Descontos por troca</CardTitle>
              <CardDescription>
                Troca por vencimento: a comissão sobre o valor trocado (preço da última NF faturada ao cliente) é descontada
                do vendedor que faturou essa NF, no mês da troca. Trocas por qualidade não geram desconto.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={String(mes)} onValueChange={(v) => setMes(parseInt(v))}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>{MESES.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={String(ano)} onValueChange={(v) => setAno(parseInt(v))}>
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>{anos.map((a) => <SelectItem key={a} value={String(a)}>{a}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Trocas por vencimento</div>
                <div className="text-2xl font-semibold">{(data?.porVendedor || []).reduce((s, v) => s + v.trocas, 0)}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Valor trocado (vencido)</div>
                <div className="text-2xl font-semibold">{brl(totalValor)}</div>
              </div>
              <div className="rounded-lg border p-3 border-red-200 bg-red-50">
                <div className="text-xs text-red-700">Desconto de comissão no mês</div>
                <div className="text-2xl font-semibold text-red-700">{brl(totalDesconto)}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {equipe && (data?.porVendedor || []).length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Por vendedor</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendedor</TableHead>
                  <TableHead className="text-right">Trocas</TableHead>
                  <TableHead className="text-right">Valor trocado</TableHead>
                  <TableHead className="text-right">Desconto na comissão</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.porVendedor || []).map((v) => (
                  <TableRow key={v.vendedorId}>
                    <TableCell>{v.vendedor}</TableCell>
                    <TableCell className="text-right">{v.trocas}</TableCell>
                    <TableCell className="text-right">{brl(v.valorTroca)}</TableCell>
                    <TableCell className="text-right text-red-700 font-medium">− {brl(v.desconto)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Registros do mês</CardTitle>
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <Checkbox checked={todos} onCheckedChange={(v) => setTodos(v === true)} data-testid="checkbox-trocas-qualidade" />
              Mostrar também trocas de qualidade
            </label>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {registros.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma troca registrada neste mês.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead>Última NF</TableHead>
                  <TableHead>Vendedor da NF</TableHead>
                  <TableHead className="text-right">Valor da troca</TableHead>
                  <TableHead className="text-right">% comissão</TableHead>
                  <TableHead className="text-right">Desconto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registros.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{dataBR(r.data)}</TableCell>
                    <TableCell>{r.cliente || '—'}</TableCell>
                    <TableCell>
                      <Badge className={MOTIVO[r.motivo]?.cls || ''}>{MOTIVO[r.motivo]?.label || r.motivo}</Badge>
                      {r.temperatura != null && <span className="ml-1 text-xs text-muted-foreground">{String(r.temperatura).replace('.', ',')} °C</span>}
                    </TableCell>
                    <TableCell>{r.nfNumero ? `NF ${r.nfNumero} · ${dataBR(r.nfData)}` : <span className="text-muted-foreground">sem NF</span>}</TableCell>
                    <TableCell>{r.vendedor || '—'}</TableCell>
                    <TableCell className="text-right">{brl(r.valorTroca)}</TableCell>
                    <TableCell className="text-right">{r.motivo === 'vencido' ? `${r.comissaoPct.toFixed(2).replace('.', ',')}%` : '—'}</TableCell>
                    <TableCell className="text-right font-medium text-red-700">{r.desconto > 0 ? `− ${brl(r.desconto)}` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {!todos && (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>Total</TableCell>
                    <TableCell className="text-right">{brl(totalValor)}</TableCell>
                    <TableCell />
                    <TableCell className="text-right text-red-700">− {brl(totalDesconto)}</TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
