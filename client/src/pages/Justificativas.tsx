import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// VIGIA 3B — Justificativa de não-atendimento (pendências do dia anterior).
// Piloto: Gilmar (omie-vendor-3882132483). Fonte: /api/vendedor/justificativas/*

const MOTIVOS: [string, string][] = [
  ["fechado", "Estabelecimento fechado"],
  ["ausente", "Responsável ausente"],
  ["sem_tempo", "Sem tempo na rota"],
  ["ja_comprou", "Já comprou / não precisa"],
  ["endereco", "Endereço errado / não localizei"],
  ["sem_interesse", "Sem interesse"],
  ["outro", "Outro"],
];
const MOTIVO_LABEL: Record<string, string> = Object.fromEntries(MOTIVOS);

function ontemBRT(): string {
  const y = new Date(Date.now() - 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(y);
}

type Pend = { customerId: string; nome: string; cidade?: string };

export default function Justificativas() {
  const { user } = useAuth();
  const uAny = user as any;
  const PILOTO = "omie-vendor-3882132483"; // Gilmar
  const sellerId =
    uAny?.omieVendorCode ? "omie-vendor-" + uAny.omieVendorCode : PILOTO;

  const [date, setDate] = useState<string>(ontemBRT());
  const [sel, setSel] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

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

  const salvar = async (cid: string) => {
    const reason = sel[cid];
    if (!reason) {
      alert("Escolha um motivo.");
      return;
    }
    setSavingId(cid);
    try {
      const r = await fetch(`/api/vendedor/justificativas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ date, customerId: cid, sellerId, reason, notes: notes[cid] || "" }),
      });
      if (!r.ok) throw new Error("save");
      setNonce((n) => n + 1);
      await refetch();
    } catch (e) {
      alert("Não foi possível salvar a justificativa.");
    } finally {
      setSavingId(null);
    }
  };

  const meuResumo = useMemo(() => {
    const list = semana?.porVendedor || [];
    return list;
  }, [semana]);

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-justificativas">
      <div className="flex flex-wrap items-center gap-3">
        <BackToDashboardButton />
        <h1 className="text-2xl font-bold">Pendências de Visita — Justificar</h1>
        {isFetching && (
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
              {pendentes.map((p) => (
                <div
                  key={p.customerId}
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
                      value={sel[p.customerId] || ""}
                      onChange={(e) =>
                        setSel((s) => ({ ...s, [p.customerId]: e.target.value }))
                      }
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
                    value={notes[p.customerId] || ""}
                    onChange={(e) =>
                      setNotes((n) => ({ ...n, [p.customerId]: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    disabled={savingId === p.customerId}
                    onClick={() => salvar(p.customerId)}
                  >
                    {savingId === p.customerId ? "Salvando…" : "Justificar"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
        Piloto de justificativa de não-atendimento. Fonte da pendência: cartão de
        visita do dia sem check-in e sem venda.
      </p>
    </div>
  );
}
