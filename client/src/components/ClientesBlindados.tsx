import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Download, Info } from "lucide-react";
import { exportToExcel } from "@/lib/tableTools";

// Aba "Clientes blindados" de Metas de Vendas.
// Cliente que compra com o dono da carteira mas não responde a Honest pelos
// outros canais (WhatsApp oficial, telemarketing, outro vendedor).
// Dados: GET /api/reports/clientes-blindados?dias=N

type Vend = {
  vendedorId: string; vendedor: string; tipo: string; clientes: number; semTelefone: number;
  comTentativa: number; responderam: number; esquivas?: number; blindados: number; atencao: number;
  taxaResposta: number | null; pctBlindados: number | null;
};
type Cli = {
  clienteId: string; cliente: string; cidade: string; telefone: string; contato: string;
  vendedorId: string; vendedor: string; situacao: "blindado" | "atencao";
  tentativas: number; diasTentativa: string[]; pedidosDono: number;
  esquivas?: number; semResposta?: number; diasEsquiva?: string[];
};

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1).replace(".", ",")}%`);
const dataBR = (d: string) => d.split("-").reverse().join("/");

export default function ClientesBlindados() {
  const [dias, setDias] = useState("60");
  const [vendSel, setVendSel] = useState<string>("todos");

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/reports/clientes-blindados", dias],
    queryFn: async () => {
      const r = await fetch(`/api/reports/clientes-blindados?dias=${dias}`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `Erro ${r.status}`);
      return j;
    },
  });

  const vendedores: Vend[] = data?.vendedores || [];
  const clientes: Cli[] = useMemo(
    () => (data?.clientes || []).filter((c: Cli) => vendSel === "todos" || c.vendedorId === vendSel),
    [data, vendSel],
  );
  const tot = data?.totais;

  const corPct = (v: number | null) =>
    v == null ? "" : v >= 20 ? "text-red-700 font-semibold" : v >= 10 ? "text-amber-700 font-semibold" : "text-green-700";
  const corResp = (v: number | null) =>
    v == null ? "" : v < 30 ? "text-red-700 font-semibold" : v < 60 ? "text-amber-700" : "text-green-700";

  const exportar = () => {
    exportToExcel(
      clientes.map((c) => ({
        Situação: c.situacao === "blindado" ? "Blindado" : "Atenção",
        Cliente: c.cliente, Cidade: c.cidade, Telefone: c.telefone, Contato: c.contato,
        Vendedor: c.vendedor, "Contatos de outros vendedores (dias)": c.tentativas,
        "Esquivas": c.esquivas ?? 0, "Sem resposta": c.semResposta ?? 0,
        "Datas das esquivas": (c.diasEsquiva || []).map(dataBR).join(", "),
        "Datas dos contatos": c.diasTentativa.map(dataBR).join(", "),
        "Pedidos do vendedor": c.pedidosDono,
      })),
      `clientes-blindados-${dias}d`,
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Clientes blindados</CardTitle>
              <CardDescription>
                Clientes que compram com o dono da carteira, mas não respondem a Honest pelos outros canais.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={dias} onValueChange={setDias}>
                <SelectTrigger className="w-[150px]" data-testid="select-dias-blindados"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">Últimos 30 dias</SelectItem>
                  <SelectItem value="60">Últimos 60 dias</SelectItem>
                  <SelectItem value="90">Últimos 90 dias</SelectItem>
                </SelectContent>
              </Select>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon" data-testid="info-blindados"><Info className="h-4 w-4" /></Button>
                </PopoverTrigger>
                <PopoverContent className="w-[420px] text-sm space-y-2">
                  <p><b>Contato:</b> dia em que outro vendedor (interno ou externo, ≠ dono da carteira) mandou mensagem pelo WhatsApp oficial ou registrou atendimento do cliente. Mensagens da IA não contam.</p>
                  <p><b>Esquiva:</b> ninguém vendeu nesse contato, mas o dono da carteira digitou pedido do cliente de 0 a {data?.janelaEsquiva ?? 3} dias depois — o "não preciso hoje" seguido de pedido com o vendedor.</p>
                  <p><b>Sem resposta:</b> o cliente não respondeu ao contato em até 2 dias.</p>
                  <p><b>Blindado:</b> {data?.minEsquivas ?? 2} ou mais esquivas, ou {data?.minTentativas ?? 3} ou mais contatos sem resposta, com pedido do dono e nenhuma compra pelos outros vendedores. <b>Atenção:</b> 1 esquiva, ou 1–2 contatos sem resposta.</p>
                  <p><b>Taxa de resposta:</b> clientes que responderam ÷ clientes contatados por outros vendedores.</p>
                  <p>O telefone do cliente é comparado pelo DDD e pelos últimos 8 dígitos. Cliente sem telefone no cadastro não entra na conta.</p>
                  <p className="text-muted-foreground">É um indicador para investigar, não uma prova. Confirme com o comprador antes de qualquer medida.</p>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error && <div className="text-red-600 text-sm">Erro ao carregar: {(error as Error).message}</div>}
          {isLoading && <div className="text-muted-foreground text-sm">Calculando…</div>}
          {tot && (
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              <Kpi label="Clientes na carteira" valor={tot.clientes} />
              <Kpi label="Contatados por outros vendedores" valor={tot.comTentativa} />
              <Kpi label="Taxa de resposta" valor={pct(tot.taxaResposta)} />
              <Kpi label="Esquivas" valor={tot.esquivas ?? 0} destaque="text-red-700" />
              <Kpi label="Blindados" valor={tot.blindados} destaque="text-red-700" />
              <Kpi label="Atenção" valor={tot.atencao} destaque="text-amber-700" />
            </div>
          )}
          {data && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="tabela-blindados-vendedores">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2">Vendedor</th><th>Tipo</th>
                    <th className="text-right">Clientes</th><th className="text-right">Sem telefone</th>
                    <th className="text-right">Contatados</th><th className="text-right">Responderam</th><th className="text-right">Esquivas</th>
                    <th className="text-right">Taxa de resposta</th><th className="text-right">Blindados</th>
                    <th className="text-right">% blindados</th><th className="text-right">Atenção</th>
                  </tr>
                </thead>
                <tbody>
                  {vendedores.map((v) => (
                    <tr key={v.vendedorId}
                      className={`border-b last:border-0 hover:bg-slate-50 cursor-pointer ${vendSel === v.vendedorId ? "bg-blue-50" : ""}`}
                      onClick={() => setVendSel(vendSel === v.vendedorId ? "todos" : v.vendedorId)}>
                      <td className="py-1.5 text-blue-700">{v.vendedor}</td><td>{v.tipo}</td>
                      <td className="text-right">{v.clientes}</td><td className="text-right">{v.semTelefone}</td>
                      <td className="text-right">{v.comTentativa}</td><td className="text-right">{v.responderam}</td><td className="text-right">{v.esquivas ?? 0}</td>
                      <td className={`text-right ${corResp(v.taxaResposta)}`}>{pct(v.taxaResposta)}</td>
                      <td className="text-right">{v.blindados}</td>
                      <td className={`text-right ${corPct(v.pctBlindados)}`}>{pct(v.pctBlindados)}</td>
                      <td className="text-right">{v.atencao}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground mt-2">Clique em um vendedor para ver só os clientes dele.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {data && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-lg">
                  Clientes sinalizados{vendSel !== "todos" ? ` — ${vendedores.find((v) => v.vendedorId === vendSel)?.vendedor || ""}` : ""}
                </CardTitle>
                <CardDescription>{clientes.length} cliente(s). Contatos = dias em que outro vendedor falou com o cliente; esquivas = contatos seguidos de pedido com o dono.</CardDescription>
              </div>
              <div className="flex gap-2">
                {vendSel !== "todos" && <Button variant="outline" size="sm" onClick={() => setVendSel("todos")}>Ver todos</Button>}
                <Button variant="outline" size="sm" onClick={exportar} data-testid="exportar-blindados">
                  <Download className="h-4 w-4 mr-1" /> Exportar Excel
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto max-h-[60vh]">
            {clientes.length === 0 ? (
              <div className="text-sm text-muted-foreground">Nenhum cliente sinalizado no período.</div>
            ) : (
              <table className="w-full text-sm" data-testid="tabela-blindados-clientes">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2">Situação</th><th>Cliente</th><th>Contato / telefone</th><th>Vendedor</th>
                    <th className="text-right">Contatos</th><th className="text-right">Esquivas</th><th className="text-right">Sem resposta</th><th>Datas das esquivas</th><th className="text-right">Pedidos do vendedor</th>
                  </tr>
                </thead>
                <tbody>
                  {clientes.map((c) => (
                    <tr key={c.clienteId} className="border-b last:border-0 align-top">
                      <td className="py-1.5">
                        {c.situacao === "blindado"
                          ? <Badge className="bg-red-600 hover:bg-red-600 text-white">Blindado</Badge>
                          : <Badge className="bg-amber-500 hover:bg-amber-500 text-white">Atenção</Badge>}
                      </td>
                      <td>{c.cliente}<div className="text-xs text-muted-foreground">{c.cidade}</div></td>
                      <td>{c.contato || "—"}<div className="text-xs text-muted-foreground">{c.telefone}</div></td>
                      <td>{c.vendedor}</td>
                      <td className="text-right">{c.tentativas}</td>
                      <td className="text-right font-semibold text-red-700">{c.esquivas ?? 0}</td>
                      <td className="text-right">{c.semResposta ?? 0}</td>
                      <td className="text-xs">{(c.diasEsquiva || []).map(dataBR).join(", ") || "—"}</td>
                      <td className="text-right">{c.pedidosDono}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Kpi({ label, valor, destaque }: { label: string; valor: any; destaque?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${destaque || ""}`}>{valor}</div>
    </div>
  );
}
