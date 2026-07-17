import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageCircle } from "lucide-react";

// VIGIA 3B — Justificativa de não-atendimento (pendências do dia anterior).
// Fonte: /api/vendedor/justificativas/* (vendedor) e /api/admin/justificativas/pendentes-todos (admin).

const MOTIVOS: [string, string][] = [
  ["fechado", "Estabelecimento fechado"],
  ["ausente", "Responsável ausente"],
  ["sem_tempo", "Sem tempo na rota"],
  ["ja_comprou", "Já comprou / não precisa"],
  ["endereco", "Endereço errado / não localizei"],
  ["sem_interesse", "Sem interesse"],
  ["outro", "Outro"],
];
const MOTIVO_LABEL: Record<string, string> = { ...Object.fromEntries(MOTIVOS), removido: "Removido da lista" };

function ontemBRT(): string {
  const y = new Date(Date.now() - 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(y);
}

type Pend = { customerId: string; nome: string; cidade?: string };
type VendBox = { sellerId: string; sellerName: string; phone: string | null; clientes: Pend[] };

export default function Justificativas() {
  const { user } = useAuth();
  const uAny = user as any;
  const isAdmin = ["admin", "coordinator", "administrative"].includes(uAny?.role);
  const PILOTO = "omie-vendor-3882132483"; // Gilmar
  const sellerId =
    uAny?.omieVendorCode ? "omie-vendor-" + uAny.omieVendorCode : PILOTO;

  const [date, setDate] = useState<string>(ontemBRT());
  const [sel, setSel] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Vendedor comum: pendências do próprio vendedor.
  const { data, isFetching, refetch } = useQuery<{
    ok: boolean;
    date: string;
    total: number;
    pendentes: Pend[];
  }>({
    queryKey: ["/api/vendedor/justificativas/pendentes", sellerId, date, nonce],
    queryFn: async () => {
      const r = await fetch(
        `/api/vendedor/justificativas/pendentes?sellerId=${encodeURIComponent(sellerId)}&date=${date}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!r.ok) throw new Error("Falha ao carregar pendências");
      return r.json();
    },
    enabled: !isAdmin,
  });

  // Admin: pendências de TODOS os vendedores, agrupadas por vendedor.
  const { data: todos, isFetching: fetchingTodos, refetch: refetchTodos } = useQuery<{
    ok: boolean;
    date: string;
    vendedores: VendBox[];
  }>({
    queryKey: ["/api/admin/justificativas/pendentes-todos", date, nonce],
    queryFn: async () => {
      const r = await fetch(
        `/api/admin/justificativas/pendentes-todos?date=${date}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!r.ok) throw new Error("Falha ao carregar pendências");
      return r.json();
    },
    enabled: isAdmin,
  });

  const { data: semana } = useQuery<{
    ok: boolean;
    porVendedor: { sellerName: string; total: number; motivos: Record<string, number> }[];
  }>({
    queryKey: ["/api/admin/justificativas/semana", nonce],
    queryFn: async () => {
      const r = await fetch(`/api/admin/justificativas/semana?days=7`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error("semana");
      return r.json();
    },
  });

  const pendentes = data?.pendentes || [];
  const vendedores = todos?.vendedores || [];

  const salvar = async (cid: string, sid: string) => {
    const key = sid + ":" + cid;
    const reason = sel[key];
    if (!reason) {
      alert("Escolha um motivo.");
      return;
    }
    setSavingId(key);
    try {
      const r = await fetch(`/api/vendedor/justificativas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ date, customerId: cid, sellerId: sid, reason, notes: notes[key] || "" }),
      });
      if (!r.ok) throw new Error("save");
      setNonce((n) => n + 1);
      if (isAdmin) await refetchTodos();
      else await refetch();
    } catch (e) {
      alert("Não foi possível salvar a justificativa.");
    } finally {
      setSavingId(null);
    }
  };

  // Admin: remove o cliente da lista de não-atendidos (marca como "removido").
  const excluir = async (cid: string, sid: string) => {
    if (!confirm("Remover este cliente da lista de não-atendidos?")) return;
    const key = sid + ":" + cid;
    setSavingId(key);
    try {
      const r = await fetch(`/api/vendedor/justificativas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ date, customerId: cid, sellerId: sid, reason: "removido", notes: "Removido da lista pelo admin" }),
      });
      if (!r.ok) throw new Error("excluir");
      setNonce((n) => n + 1);
      if (isAdmin) await refetchTodos();
      else await refetch();
    } catch (e) {
      alert("Não foi possível remover o cliente da lista.");
    } finally {
      setSavingId(null);
    }
  };

  // Monta o texto padrão do WhatsApp para o vendedor com a relação dos clientes.
  const buildMsg = (box: VendBox): string => {
    const linhas = box.clientes
      .map((c) => `- ${c.nome}${c.cidade ? " (" + c.cidade + ")" : ""}`)
      .join("\n");
    return `Bom dia,\nOntem os clientes abaixo não foram atendidos, pode dizer o que houve?\n${linhas}`;
  };

  // Abre a Central de Atendimento (nova guia) na conversa com o VENDEDOR, já com o texto padrão.
  const enviarWhatsapp = (box: VendBox) => {
    const digits = String(box.phone || "").replace(/\D/g, "");
    if (!digits) {
      alert("Vendedor sem telefone cadastrado. Cadastre o telefone para enviar pela Central.");
      return;
    }
    const msg = buildMsg(box);
    window.open(
      `/telemarketing/atendimento?phone=${digits}&text=${encodeURIComponent(msg)}`,
      "honest-central-atendimento",
    );
  };

  const meuResumo = useMemo(() => semana?.porVendedor || [], [semana]);

  // Linha de um cliente pendente (motivo + observação + justificar).
  const renderCliente = (p: Pend, sid: string) => {
    const key = sid + ":" + p.customerId;
    return (
      <div
        key={key}
        className="border rounded-lg p-3 flex flex-col md:flex-row md:items-end gap-2"
      >
        <div className="flex-1">
          <div className="font-medium">{p.nome}</div>
          {p.cidade ? (
            <div className="text-xs text-muted-foreground">{p.cidade}</div>
          ) : null}
        </div>
        <label className="text-xs">
          Motivo
          <select
            className="block border rounded px-2 py-1 text-sm min-w-[200px]"
            value={sel[key] || ""}
            onChange={(e) => setSel((s) => ({ ...s, [key]: e.target.value }))}
          >
            <option value="">Selecione…</option>
            {MOTIVOS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <input
          className="border rounded px-2 py-1 text-sm md:w-56"
          placeholder="Observação (opcional)"
          value={notes[key] || ""}
          onChange={(e) => setNotes((n) => ({ ...n, [key]: e.target.value }))}
        />
        <Button
          size="sm"
          disabled={savingId === key}
          onClick={() => salvar(p.customerId, sid)}
        >
          {savingId === key ? "Salvando…" : "Justificar"}
        </Button>
        {isAdmin && (
          <Button
            size="sm"
            variant="destructive"
            disabled={savingId === key}
            onClick={() => excluir(p.customerId, sid)}
            title="Remover este cliente da lista de não-atendidos"
            data-testid={`button-excluir-${p.customerId}`}
          >
            Excluir
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-justificativas">
      <div className="flex flex-wrap items-center gap-3">
        <BackToDashboardButton />
        <h1 className="text-2xl font-bold">Pendências de Visita — Justificar</h1>
        {(isFetching || fetchingTodos) && (
          <span className="text-xs text-muted-foreground">carregando…</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          Dia:{" "}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          />
        </label>
        <span className="text-xs text-muted-foreground">
          Clientes planejados sem check-in e sem venda no dia. Registre por que não foram atendidos.
        </span>
      </div>

      {isAdmin ? (
        // Visão do administrador: um box por vendedor com seus clientes não atendidos.
        vendedores.length === 0 ? (
          <Card>
            <CardContent className="py-6">
              <p className="text-sm text-muted-foreground">
                Nenhuma pendência de não-atendimento neste dia. 👍
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {vendedores.map((box) => (
              <Card key={box.sellerId} data-testid={`box-vendedor-${box.sellerId}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">
                      {box.sellerName} ({box.clientes.length})
                    </CardTitle>
                    <Button
                      size="sm"
                      className="bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => enviarWhatsapp(box)}
                      title={`Enviar WhatsApp para ${box.sellerName} pela Central de Atendimento`}
                      data-testid={`button-whatsapp-vendedor-${box.sellerId}`}
                    >
                      <MessageCircle className="h-4 w-4 mr-1" />
                      Enviar WhatsApp
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {box.clientes.map((p) => renderCliente(p, box.sellerId))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : (
        // Visão do vendedor: seus próprios clientes não atendidos.
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Não atendidos ({pendentes.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendentes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nenhuma pendência para justificar neste dia. 👍
              </p>
            ) : (
              <div className="space-y-3">
                {pendentes.map((p) => renderCliente(p, sellerId))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {meuResumo.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Justificativas (últimos 7 dias)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b [&>th]:py-2 [&>th]:pr-3">
                  <th>Vendedor</th>
                  <th className="text-right">Total</th>
                  <th>Motivos</th>
                </tr>
              </thead>
              <tbody>
                {meuResumo.map((s) => (
                  <tr key={s.sellerName} className="border-b [&>td]:py-2 [&>td]:pr-3">
                    <td className="font-medium">{s.sellerName}</td>
                    <td className="text-right">{s.total}</td>
                    <td className="text-xs">
                      {Object.entries(s.motivos)
                        .map(([m, n]) => `${MOTIVO_LABEL[m] || m}: ${n}`)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Fonte da pendência: cartão de visita do dia sem check-in e sem venda.
      </p>
    </div>
  );
}
