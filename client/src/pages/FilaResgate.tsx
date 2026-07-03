import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useActiveSellers,
  MultiSelect,
  multiMatch,
  exportToExcel,
  ExportExcelButton,
} from "@/lib/tableTools";

// VIGIA 3A — Fila de Resgate (telemarketing). Fonte: /api/admin/churn/resgate-queue

type Item = {
  id: string;
  customerId: string;
  customer_name: string;
  cidade?: string;
  bairro?: string;
  telefone?: string;
  contato?: string;
  documento?: string;
  seller_name?: string;
  faixa: string;
  dias_sem_compra?: number;
  ultima_compra?: string;
  valor_hist?: number;
  valor_6m?: number;
  status: string;
  outcome?: string;
  outcome_reason?: string;
  notes?: string;
};

const MOTIVOS = [
  ["preco", "Preço"],
  ["concorrente", "Concorrente"],
  ["fechou", "Fechou/encerrou"],
  ["entrega", "Entrega/logística"],
  ["sem_contato", "Sem contato"],
  ["voltou", "Voltou a comprar"],
  ["outro", "Outro"],
];
const MOTIVO_LABEL: Record<string, string> = Object.fromEntries(MOTIVOS);

const fmtBRL = (v?: number) =>
  (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const FAIXA_COR: Record<string, string> = {
  em_risco: "bg-orange-600 text-white",
  perdido: "bg-red-600 text-white",
};
const STATUS_COR: Record<string, string> = {
  pendente: "bg-gray-200 text-gray-700",
  em_atendimento: "bg-blue-600 text-white",
  concluido: "bg-green-600 text-white",
};

export default function FilaResgate() {
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [statusFiltro, setStatusFiltro] = useState<string>("");
  const [editId, setEditId] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState("concluido");
  const [fMotivo, setFMotivo] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);
  const { sellerOptions, resolveSeller } = useActiveSellers();

  const { data, isFetching, refetch } = useQuery<{
    ok: boolean;
    resumo: Record<string, number>;
    total: number;
    itens: Item[];
  }>({
    queryKey: ["/api/admin/churn/resgate-queue", statusFiltro, nonce],
    queryFn: async () => {
      const qs = statusFiltro ? `?status=${statusFiltro}` : "";
      const r = await fetch(`/api/admin/churn/resgate-queue${qs}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Falha ao carregar fila");
      return r.json();
    },
  });

  const { data: motivosData } = useQuery<{
    ok: boolean;
    motivos: { motivo: string; quantidade: number; valor6m: number }[];
  }>({
    queryKey: ["/api/admin/churn/resgate-motivos", nonce],
    queryFn: async () => {
      const r = await fetch(`/api/admin/churn/resgate-motivos`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error("motivos");
      return r.json();
    },
  });

  const itens = useMemo(() => {
    const all = data?.itens || [];
    return all.filter((i) =>
      multiMatch(sellerMulti, resolveSeller(i.seller_name || "")),
    );
  }, [data, sellerMulti, resolveSeller]);

  const abrirDesfecho = (id: string, statusAtual: string) => {
    setEditId(id);
    setFStatus(statusAtual === "concluido" ? "concluido" : "concluido");
    setFMotivo("");
    setFNotes("");
  };

  const salvarDesfecho = async (id: string) => {
    setSaving(true);
    try {
      const body: any = { status: fStatus, notes: fNotes };
      if (fMotivo) body.outcome_reason = fMotivo;
      const r = await fetch(`/api/admin/churn/resgate-queue/${id}/desfecho`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Falha ao salvar");
      setEditId(null);
      setNonce((n) => n + 1);
      await refetch();
    } catch (e) {
      alert("Não foi possível salvar o desfecho.");
    } finally {
      setSaving(false);
    }
  };

  const exportar = () => {
    exportToExcel(
      itens.map((i) => ({
        Cliente: i.customer_name,
        Cidade: i.cidade || "",
        Vendedor: i.seller_name || "",
        Faixa: i.faixa,
        "Dias sem compra": i.dias_sem_compra ?? "",
        "Valor 6m": i.valor_6m ?? "",
        Telefone: i.telefone || "",
        Contato: i.contato || "",
        Status: i.status,
        Motivo: i.outcome_reason ? MOTIVO_LABEL[i.outcome_reason] : "",
      })),
      `fila-resgate`,
    );
  };

  const resumo = data?.resumo || {};

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-fila-resgate">
      <div className="flex flex-wrap items-center gap-3">
        <BackToDashboardButton />
        <h1 className="text-2xl font-bold">Fila de Resgate</h1>
        {isFetching && (
          <span className="text-xs text-muted-foreground">atualizando…</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          label="Vendedor"
          options={sellerOptions}
          selected={sellerMulti}
          onChange={setSellerMulti}
          testId="multiselect-vendedor-resgate"
        />
        {["", "pendente", "em_atendimento", "concluido"].map((st) => (
          <Button
            key={st || "todos"}
            variant={statusFiltro === st ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFiltro(st)}
          >
            {st === "" ? "Todos" : st === "em_atendimento" ? "Em atendimento" : st.charAt(0).toUpperCase() + st.slice(1)}
          </Button>
        ))}
        <ExportExcelButton onClick={exportar} testId="export-fila-resgate" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(
          [
            ["Pendentes", resumo.pendente || 0, "text-gray-700"],
            ["Em atendimento", resumo.em_atendimento || 0, "text-blue-700"],
            ["Concluídos", resumo.concluido || 0, "text-green-700"],
            ["Total na fila", (resumo.pendente || 0) + (resumo.em_atendimento || 0) + (resumo.concluido || 0), "text-gray-900"],
          ] as [string, number, string][]
        ).map(([label, val, cor]) => (
          <Card key={label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className={`text-2xl font-bold ${cor}`}>{val}</CardContent>
          </Card>
        ))}
      </div>

      {motivosData && motivosData.motivos && motivosData.motivos.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Motivos do mês</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {motivosData.motivos.map((m) => (
                <span
                  key={m.motivo}
                  className="inline-block bg-muted rounded px-2 py-1 text-xs"
                >
                  {MOTIVO_LABEL[m.motivo] || m.motivo}: <b>{m.quantidade}</b>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fila ({itens.length})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b [&>th]:py-2 [&>th]:pr-3 [&>th]:sticky [&>th]:top-0 [&>th]:bg-background">
                <th>Cliente</th>
                <th>Vendedor</th>
                <th>Faixa</th>
                <th className="text-right">Dias</th>
                <th className="text-right">Valor 6m</th>
                <th>Contato</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {itens.map((i) => (
                <>
                  <tr
                    key={i.id}
                    className="border-b hover:bg-muted/40 [&>td]:py-2 [&>td]:pr-3 align-top"
                  >
                    <td className="font-medium">
                      {i.customer_name}
                      {i.cidade ? (
                        <div className="text-xs text-muted-foreground">{i.cidade}</div>
                      ) : null}
                    </td>
                    <td>{i.seller_name || "—"}</td>
                    <td>
                      <Badge className={FAIXA_COR[i.faixa] || "bg-gray-400 text-white"}>
                        {i.faixa === "em_risco" ? "Em risco" : "Perdido"}
                      </Badge>
                    </td>
                    <td className="text-right">{i.dias_sem_compra ?? "—"}</td>
                    <td className="text-right">{fmtBRL(i.valor_6m)}</td>
                    <td className="text-xs">
                      {i.telefone || "—"}
                      {i.contato ? (
                        <div className="text-muted-foreground">{i.contato}</div>
                      ) : null}
                    </td>
                    <td>
                      <Badge className={STATUS_COR[i.status] || ""}>
                        {i.status === "em_atendimento" ? "Em atend." : i.status}
                      </Badge>
                      {i.outcome_reason ? (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {MOTIVO_LABEL[i.outcome_reason] || i.outcome_reason}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          editId === i.id ? setEditId(null) : abrirDesfecho(i.id, i.status)
                        }
                      >
                        {editId === i.id ? "Fechar" : "Desfecho"}
                      </Button>
                    </td>
                  </tr>
                  {editId === i.id && (
                    <tr key={i.id + "-ed"} className="border-b bg-muted/20">
                      <td colSpan={8} className="py-3 px-2">
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="text-xs">
                            Status
                            <select
                              className="block border rounded px-2 py-1 text-sm"
                              value={fStatus}
                              onChange={(e) => setFStatus(e.target.value)}
                            >
                              <option value="em_atendimento">Em atendimento</option>
                              <option value="concluido">Concluído</option>
                              <option value="pendente">Pendente</option>
                            </select>
                          </label>
                          <label className="text-xs">
                            Motivo
                            <select
                              className="block border rounded px-2 py-1 text-sm"
                              value={fMotivo}
                              onChange={(e) => setFMotivo(e.target.value)}
                            >
                              <option value="">—</option>
                              {MOTIVOS.map(([v, l]) => (
                                <option key={v} value={v}>
                                  {l}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="text-xs flex-1 min-w-[180px]">
                            Observação
                            <input
                              className="block border rounded px-2 py-1 text-sm w-full"
                              value={fNotes}
                              onChange={(e) => setFNotes(e.target.value)}
                              placeholder="opcional"
                            />
                          </label>
                          <Button
                            size="sm"
                            disabled={saving}
                            onClick={() => salvarDesfecho(i.id)}
                          >
                            {saving ? "Salvando…" : "Salvar"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {itens.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-muted-foreground">
                    Fila vazia para o filtro atual.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Clientes em risco/perdido (Radar de Churn) enfileirados para recuperação.
        Registre o desfecho e o motivo padronizado; os motivos alimentam o
        relatório mensal. Ordenado por valor dos últimos 6 meses.
      </p>
    </div>
  );
}
