import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

// Inutilização de NF-e / NFC-e (Ajuste SINIEF 07/05, cl. 14ª).
// Levanta os números pulados por CNPJ + modelo + série (pela chave de acesso
// das notas que consumiram número) e envia o pedido à SEFAZ com o A1 do CNPJ.

type Faixa = { ini: number; fim: number; qtd: number; dataAntes: string | null; dataDepois: string | null; ano: number; statusIntegra: string[] };
type Grupo = { cnpj: string; nome: string; uf: string; modelo: string; serie: number; notas: number; primeiro: number; ultimo: number; ultimaEmissao: string; faixas: Faixa[]; totalFaixas: number; totalNumeros: number };

const JUST_PADRAO = "Numeracao nao utilizada por falha no sistema emissor";

const fmtData = (s: string | null) => (s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
const fmtCnpj = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

// Prazo legal: até o dia 10 do mês seguinte ao da nota que "pulou" a numeração.
function prazo(f: Faixa) {
  if (!f.dataDepois) return { vencido: true, label: "—" };
  const d = new Date(f.dataDepois);
  const lim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 10, 23, 59));
  return { vencido: Date.now() > lim.getTime(), label: lim.toLocaleDateString("pt-BR", { timeZone: "UTC" }) };
}

async function jfetch(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error || j?.xMotivo || `HTTP ${r.status}`), { body: j });
  return j;
}

export default function InutilizacaoNF() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [desde, setDesde] = useState(`${new Date().getFullYear()}-01-01`);
  const [cnpjSel, setCnpjSel] = useState("");
  const [aberto, setAberto] = useState<string | null>(null);
  const [envio, setEnvio] = useState<null | { g: Grupo; ini: number; fim: number; ano: number; just: string; ambiente: "producao" | "homologacao" }>(null);
  const [lote, setLote] = useState<{ total: number; feitos: number; ok: number; falhas: string[] } | null>(null);

  const lacunas = useQuery<{ geradoEm: string; grupos: Grupo[] }>({
    queryKey: ["/api/fiscal/inutilizacao/lacunas", desde, cnpjSel],
    queryFn: () => jfetch(`/api/fiscal/inutilizacao/lacunas?desde=${encodeURIComponent(desde)}&cnpj=${cnpjSel}`),
  });
  const historico = useQuery<any[]>({ queryKey: ["/api/fiscal/inutilizacao"], queryFn: () => jfetch("/api/fiscal/inutilizacao") });

  const enviar = useMutation({
    mutationFn: (v: { cnpj: string; uf: string; modelo: string; serie: number; ano: number; numeroInicial: number; numeroFinal: number; justificativa: string; ambiente: string }) =>
      jfetch("/api/fiscal/inutilizacao", { method: "POST", body: JSON.stringify(v) }),
  });

  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ["/api/fiscal/inutilizacao/lacunas"] });
    qc.invalidateQueries({ queryKey: ["/api/fiscal/inutilizacao"] });
  };

  const grupos = lacunas.data?.grupos || [];
  const cnpjs = useMemo(() => Array.from(new Map(grupos.map((g) => [g.cnpj, g.nome])).entries()), [grupos]);

  async function confirmarEnvio() {
    if (!envio) return;
    const { g, ini, fim, ano, just, ambiente } = envio;
    if (just.trim().length < 15) return toast({ title: "Justificativa curta", description: "Mínimo de 15 caracteres.", variant: "destructive" });
    try {
      const r = await enviar.mutateAsync({ cnpj: g.cnpj, uf: g.uf, modelo: g.modelo, serie: g.serie, ano, numeroInicial: ini, numeroFinal: fim, justificativa: just, ambiente });
      toast({ title: `Inutilização homologada (${ambiente})`, description: `Protocolo ${r.protocolo || "—"} · ${r.xMotivo || ""}` });
      setEnvio(null);
    } catch (e: any) {
      toast({ title: "SEFAZ não homologou", description: `${e.body?.cStat ? `cStat ${e.body.cStat} — ` : ""}${e.message}`, variant: "destructive" });
    } finally {
      refrescar();
    }
  }

  // Envia todas as faixas do grupo, uma por vez (a SEFAZ rejeita a faixa inteira se houver número usado).
  async function enviarGrupo(g: Grupo) {
    const alvo = g.faixas;
    if (!alvo.length) return;
    const just = window.prompt(`Justificativa para as ${alvo.length} faixas (${g.totalNumeros} números) de ${g.nome} mod ${g.modelo} série ${g.serie} — PRODUÇÃO:`, JUST_PADRAO);
    if (!just) return;
    if (just.trim().length < 15) return toast({ title: "Justificativa curta", description: "Mínimo de 15 caracteres.", variant: "destructive" });
    if (!window.confirm(`Enviar ${alvo.length} pedidos de inutilização à SEFAZ em PRODUÇÃO? Não há como desfazer.`)) return;
    const st = { total: alvo.length, feitos: 0, ok: 0, falhas: [] as string[] };
    setLote({ ...st });
    for (const f of alvo) {
      try {
        await enviar.mutateAsync({ cnpj: g.cnpj, uf: g.uf, modelo: g.modelo, serie: g.serie, ano: f.ano, numeroInicial: f.ini, numeroFinal: f.fim, justificativa: just, ambiente: "producao" });
        st.ok++;
      } catch (e: any) {
        st.falhas.push(`${f.ini}–${f.fim}: ${e.body?.cStat ? `cStat ${e.body.cStat} ` : ""}${e.message}`);
      }
      st.feitos++;
      setLote({ ...st, falhas: st.falhas.slice() });
    }
    refrescar();
  }

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Inutilização de NF-e / NFC-e</h1>
        <p className="text-sm text-gray-500 mt-1">
          Números pulados na sequência de cada CNPJ + modelo + série devem ser inutilizados na SEFAZ até o dia 10 do mês seguinte (Ajuste SINIEF 07/05).
          O levantamento usa a chave de acesso das notas autorizadas, canceladas e denegadas em produção.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Lacunas a partir de</label>
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-44" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Empresa</label>
            <select className="border rounded-md h-10 px-2 text-sm" value={cnpjSel} onChange={(e) => setCnpjSel(e.target.value)}>
              <option value="">Todas</option>
              {cnpjs.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
          </div>
          <Button variant="outline" onClick={() => setDesde("2006-01-01")}>Todo o histórico</Button>
          <Button onClick={refrescar} disabled={lacunas.isFetching}>{lacunas.isFetching ? "Levantando..." : "Atualizar"}</Button>
          <p className="text-xs text-amber-700 w-full">
            ⚠️ Faixas anteriores à entrada do Integra 2.0 podem conter notas emitidas por outro emissor (Omie/1.0) que não estão no banco. A SEFAZ recusa a faixa se algum número já foi usado — nesse caso, divida a faixa. Teste antes em homologação.
          </p>
        </CardContent>
      </Card>

      {lote && (
        <Card className="border-blue-300">
          <CardContent className="p-4 text-sm">
            <div className="flex justify-between">
              <b>Envio em lote: {lote.feitos}/{lote.total} · homologadas {lote.ok} · falhas {lote.falhas.length}</b>
              {lote.feitos === lote.total && <Button size="sm" variant="ghost" onClick={() => setLote(null)}>Fechar</Button>}
            </div>
            {lote.falhas.length > 0 && <ul className="mt-2 max-h-40 overflow-auto text-red-700 text-xs">{lote.falhas.map((f, i) => <li key={i}>{f}</li>)}</ul>}
          </CardContent>
        </Card>
      )}

      {lacunas.isLoading && <p className="text-sm text-gray-500">Levantando lacunas...</p>}
      {lacunas.error && <p className="text-sm text-red-600">Erro: {(lacunas.error as any).message}</p>}

      {grupos.map((g) => {
        const k = `${g.cnpj}|${g.modelo}|${g.serie}`;
        const vencidas = g.faixas.filter((f) => prazo(f).vencido).length;
        return (
          <Card key={k}>
            <CardHeader className="border-b py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{g.nome}</CardTitle>
                  <p className="text-xs text-gray-500">
                    {fmtCnpj(g.cnpj)} · {g.uf} · {g.modelo === "65" ? "NFC-e (65)" : "NF-e (55)"} · série {g.serie} · {g.notas} notas ({g.primeiro}…{g.ultimo}) · última {fmtData(g.ultimaEmissao)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {g.totalFaixas === 0
                    ? <Badge className="bg-green-100 text-green-800">Sem lacunas</Badge>
                    : <>
                        <Badge className="bg-amber-100 text-amber-800">{g.totalFaixas} faixas · {g.totalNumeros.toLocaleString("pt-BR")} números</Badge>
                        {vencidas > 0 && <Badge className="bg-red-100 text-red-800">{vencidas} fora do prazo</Badge>}
                        <Button size="sm" variant="outline" onClick={() => setAberto(aberto === k ? null : k)}>{aberto === k ? "Ocultar" : "Ver faixas"}</Button>
                        <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={() => enviarGrupo(g)} disabled={!!lote && lote.feitos < lote.total}>Inutilizar todas</Button>
                      </>}
                </div>
              </div>
            </CardHeader>
            {aberto === k && g.totalFaixas > 0 && (
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600 sticky top-0">
                    <tr><th className="text-left p-2">Faixa</th><th className="text-right p-2">Qtd</th><th className="text-left p-2">Entre notas de</th><th className="text-left p-2">Ano</th><th className="text-left p-2">Prazo</th><th className="text-left p-2">No Integra</th><th className="p-2"></th></tr>
                  </thead>
                  <tbody>
                    {g.faixas.map((f) => {
                      const p = prazo(f);
                      return (
                        <tr key={f.ini} className="border-t">
                          <td className="p-2 font-mono">{f.ini === f.fim ? f.ini : `${f.ini} – ${f.fim}`}</td>
                          <td className="p-2 text-right">{f.qtd.toLocaleString("pt-BR")}</td>
                          <td className="p-2 text-xs">{fmtData(f.dataAntes)} → {fmtData(f.dataDepois)}</td>
                          <td className="p-2">{f.ano}</td>
                          <td className={`p-2 text-xs ${p.vencido ? "text-red-700" : "text-gray-700"}`}>{p.label}{p.vencido ? " (vencido)" : ""}</td>
                          <td className="p-2 text-xs">{f.statusIntegra.length ? f.statusIntegra.join(", ") : "—"}</td>
                          <td className="p-2 text-right">
                            <Button size="sm" variant="outline" onClick={() => setEnvio({ g, ini: f.ini, fim: f.fim, ano: f.ano, just: JUST_PADRAO, ambiente: "producao" })}>Inutilizar…</Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            )}
          </Card>
        );
      })}

      {envio && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !enviar.isPending && setEnvio(null)}>
          <div className="bg-white rounded-xl p-5 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-lg">Pedido de inutilização</h2>
            <p className="text-xs text-gray-600">{envio.g.nome} · {fmtCnpj(envio.g.cnpj)} · mod {envio.g.modelo} · série {envio.g.serie} · {envio.g.uf}</p>
            <div className="grid grid-cols-3 gap-2">
              <div><label className="text-xs text-gray-600">Nº inicial</label><Input type="number" value={envio.ini} onChange={(e) => setEnvio({ ...envio, ini: Number(e.target.value) })} /></div>
              <div><label className="text-xs text-gray-600">Nº final</label><Input type="number" value={envio.fim} onChange={(e) => setEnvio({ ...envio, fim: Number(e.target.value) })} /></div>
              <div><label className="text-xs text-gray-600">Ano</label><Input type="number" value={envio.ano} onChange={(e) => setEnvio({ ...envio, ano: Number(e.target.value) })} /></div>
            </div>
            <div><label className="text-xs text-gray-600">Justificativa (mín. 15)</label><Input value={envio.just} onChange={(e) => setEnvio({ ...envio, just: e.target.value })} /></div>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1"><input type="radio" checked={envio.ambiente === "homologacao"} onChange={() => setEnvio({ ...envio, ambiente: "homologacao" })} /> Homologação (teste)</label>
              <label className="flex items-center gap-1"><input type="radio" checked={envio.ambiente === "producao"} onChange={() => setEnvio({ ...envio, ambiente: "producao" })} /> Produção</label>
            </div>
            {envio.ambiente === "producao" && <p className="text-xs text-red-700">Em produção a inutilização é definitiva: esses números nunca mais poderão ser usados.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEnvio(null)} disabled={enviar.isPending}>Cancelar</Button>
              <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={confirmarEnvio} disabled={enviar.isPending}>{enviar.isPending ? "Enviando à SEFAZ..." : "Enviar"}</Button>
            </div>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="border-b py-3"><CardTitle className="text-base">Histórico de pedidos</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr><th className="text-left p-2">Data</th><th className="text-left p-2">CNPJ</th><th className="text-left p-2">Mod/Série</th><th className="text-left p-2">Faixa</th><th className="text-left p-2">Amb.</th><th className="text-left p-2">Status</th><th className="text-left p-2">SEFAZ</th><th className="text-left p-2">Protocolo</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {(historico.data || []).map((h: any) => (
                <tr key={h.id} className="border-t">
                  <td className="p-2 text-xs">{new Date(h.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
                  <td className="p-2 text-xs">{fmtCnpj(h.cnpj)}</td>
                  <td className="p-2">{h.modelo}/{h.serie}</td>
                  <td className="p-2 font-mono">{h.numero_inicial}–{h.numero_final}</td>
                  <td className="p-2 text-xs">{h.ambiente === "producao" ? "Prod" : "Homolog"}</td>
                  <td className="p-2"><Badge className={h.status === "homologada" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{h.status}</Badge></td>
                  <td className="p-2 text-xs">{h.c_stat ? `${h.c_stat} — ` : ""}{h.x_motivo}</td>
                  <td className="p-2 text-xs font-mono">{h.protocolo || "—"}</td>
                  <td className="p-2">{h.status === "homologada" && <a className="text-blue-600 text-xs underline" href={`/api/fiscal/inutilizacao/${h.id}/xml`}>XML</a>}</td>
                </tr>
              ))}
              {!historico.data?.length && <tr><td colSpan={9} className="p-3 text-sm text-gray-500">Nenhum pedido enviado ainda.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
