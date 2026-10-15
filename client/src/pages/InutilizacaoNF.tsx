import { useEffect, useMemo, useState } from "react";
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
type Conferir = { numero: number; motivo: string; statusIntegra: string; cliente: string | null; invoiceId: string };
type Grupo = { cnpj: string; nome: string; uf: string; modelo: string; serie: number; notas: number; primeiro: number; ultimo: number; ultimaEmissao: string; faixas: Faixa[]; conferir?: Conferir[]; totalFaixas: number; totalNumeros: number };
type Lote = {
  id: string; nome: string; modelo: string; serie: number; status: "executando" | "concluido" | "interrompido";
  faixasPrevistas: number; numerosPrevistos: number; pedidos: number; homologadas: number; numerosInutilizados: number;
  usadosNaSefaz: { ini: number; fim: number; cStat: string; xMotivo: string }[]; erros: { ini: number; fim: number; cStat: string | null; msg: string }[];
  motivoParada: string | null; atual?: string;
};

const JUST_PADRAO = "Quebra de sequencia na numeracao por falha no sistema emissor - numeros nao utilizados";

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
  const [loteId, setLoteId] = useState<string | null>(null);
  const [confLote, setConfLote] = useState<null | { g: Grupo; just: string; palavra: string }>(null);

  const lacunas = useQuery<{ geradoEm: string; grupos: Grupo[] }>({
    queryKey: ["/api/fiscal/inutilizacao/lacunas", desde, cnpjSel],
    queryFn: () => jfetch(`/api/fiscal/inutilizacao/lacunas?desde=${encodeURIComponent(desde)}&cnpj=${cnpjSel}`),
  });
  const historico = useQuery<any[]>({ queryKey: ["/api/fiscal/inutilizacao"], queryFn: () => jfetch("/api/fiscal/inutilizacao") });
  // Lote roda NO SERVIDOR (não depende da aba aberta); a tela só acompanha.
  const lote = useQuery<Lote>({
    queryKey: ["/api/fiscal/inutilizacao/lote", loteId],
    queryFn: () => jfetch(`/api/fiscal/inutilizacao/lote/${loteId}`),
    enabled: !!loteId,
    retry: false,
    refetchInterval: (q: any) => (q?.state?.status === "error" ? false : (q?.state?.data?.status === "executando" || !q?.state?.data ? 3000 : false)),
  });

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

  // Lote no servidor: todas as faixas do grupo, com pausa entre pedidos e divisão
  // automática quando a SEFAZ acusa número já usado/inutilizado dentro da faixa.
  const [iniciando, setIniciando] = useState(false);
  async function iniciarLote() {
    if (!confLote || iniciando) return;
    const { g, just, palavra } = confLote;
    if (palavra.trim().toUpperCase() !== "INUTILIZAR") return toast({ title: "Confirmação", description: "Digite INUTILIZAR para confirmar.", variant: "destructive" });
    if (just.trim().length < 15) return toast({ title: "Justificativa curta", description: "Mínimo de 15 caracteres.", variant: "destructive" });
    setIniciando(true);
    try {
      const j = await jfetch("/api/fiscal/inutilizacao/lote", { method: "POST", body: JSON.stringify({ cnpj: g.cnpj, modelo: g.modelo, serie: g.serie, desde, justificativa: just, confirmacao: palavra }) });
      setLoteId(j.id);
      setConfLote(null);
      toast({ title: "Lote iniciado", description: `${j.faixasPrevistas} faixas · ${Number(j.numerosPrevistos).toLocaleString("pt-BR")} números` });
    } catch (e: any) {
      toast({ title: "Não iniciou", description: e.message, variant: "destructive" });
    } finally {
      setIniciando(false);
    }
  }
  async function pararLote() {
    if (!loteId) return;
    try { await jfetch(`/api/fiscal/inutilizacao/lote/${loteId}/parar`, { method: "POST" }); } catch {}
  }
  const loteAtivo = lote.data?.status === "executando";
  // Ao terminar o lote, atualiza levantamento e histórico (o que foi homologado sai das faixas).
  useEffect(() => {
    if (lote.data && lote.data.status !== "executando") refrescar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lote.data?.status]);

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Inutilização de NF-e / NFC-e</h1>
        <p className="text-sm text-gray-500 mt-1">
          Números pulados na sequência de cada CNPJ + modelo + série devem ser inutilizados na SEFAZ até o dia 10 do mês seguinte (Ajuste SINIEF 07/05).
          O levantamento usa a chave de acesso das notas autorizadas, canceladas, devolvidas e denegadas em produção. Faixas acima de 9.000 números são divididas (limite da SEFAZ: 10.000 por pedido).
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

      {lote.data && (
        <Card className={lote.data.status === "interrompido" ? "border-red-300" : "border-blue-300"}>
          <CardContent className="p-4 text-sm space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <b>
                Lote {lote.data.nome} mod {lote.data.modelo}/série {lote.data.serie} — {lote.data.status}
                {lote.data.atual ? ` · enviando ${lote.data.atual}` : ""}
              </b>
              <div className="flex gap-2">
                {loteAtivo && <Button size="sm" variant="outline" onClick={pararLote}>Parar</Button>}
                {!loteAtivo && <Button size="sm" variant="ghost" onClick={() => setLoteId(null)}>Fechar</Button>}
              </div>
            </div>
            <p>
              Pedidos enviados: {lote.data.pedidos} · homologados: {lote.data.homologadas} ·
              números inutilizados: {lote.data.numerosInutilizados.toLocaleString("pt-BR")} de {lote.data.numerosPrevistos.toLocaleString("pt-BR")} previstos
            </p>
            {lote.data.motivoParada && <p className="text-red-700">Parou: {lote.data.motivoParada}</p>}
            {lote.data.usadosNaSefaz.length > 0 && (
              <div>
                <p className="text-amber-800 font-semibold">Números que a SEFAZ diz já usados/inutilizados (não estão no Integra — conferir):</p>
                <p className="font-mono text-xs">{lote.data.usadosNaSefaz.map((u) => (u.ini === u.fim ? u.ini : `${u.ini}–${u.fim}`) + ` (${u.cStat})`).join(", ")}</p>
              </div>
            )}
            {lote.data.erros.length > 0 && <ul className="max-h-40 overflow-auto text-red-700 text-xs">{lote.data.erros.map((f, i) => <li key={i}>{f.ini}–{f.fim}: {f.cStat ? `cStat ${f.cStat} ` : ""}{f.msg}</li>)}</ul>}
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
                        <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={() => setConfLote({ g, just: JUST_PADRAO, palavra: "" })} disabled={loteAtivo}>Inutilizar todas…</Button>
                      </>}
                </div>
              </div>
            </CardHeader>
            {(g.conferir?.length || 0) > 0 && (
              <div className="px-4 py-2 bg-amber-50 border-b text-xs text-amber-900">
                <b>Conferir na SEFAZ antes ({g.conferir!.length}):</b> estes números ficaram fora das faixas porque há indício de uso —{" "}
                {g.conferir!.map((c) => `${c.numero} (${c.motivo}${c.cliente ? `, ${c.cliente}` : ""})`).join("; ")}.
                {" "}Use "Consultar situação" na nota; se a SEFAZ não tiver nada, inutilize pelo botão da faixa.
              </div>
            )}
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

      {confLote && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setConfLote(null)}>
          <div className="bg-white rounded-xl p-5 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-lg">Inutilizar todas as faixas — PRODUÇÃO</h2>
            <p className="text-sm text-gray-700">
              {confLote.g.nome} · {fmtCnpj(confLote.g.cnpj)} · mod {confLote.g.modelo} · série {confLote.g.serie}<br />
              <b>{confLote.g.totalFaixas} faixas · {confLote.g.totalNumeros.toLocaleString("pt-BR")} números</b> (lacunas a partir de {fmtData(desde + "T12:00:00Z")}).
            </p>
            <p className="text-xs text-gray-600">
              O servidor envia uma faixa por vez (pausa de 1,5 s). Se a SEFAZ disser que há número já usado dentro da faixa, ela é dividida
              ao meio até isolar esse número, que vai para a lista "conferir". 3 falhas seguidas de outro tipo param o lote.
            </p>
            <div><label className="text-xs text-gray-600">Justificativa (mín. 15)</label><Input value={confLote.just} onChange={(e) => setConfLote({ ...confLote, just: e.target.value })} /></div>
            <div><label className="text-xs text-gray-600">Digite <b>INUTILIZAR</b> para confirmar</label><Input value={confLote.palavra} onChange={(e) => setConfLote({ ...confLote, palavra: e.target.value })} /></div>
            <p className="text-xs text-red-700">Definitivo: números inutilizados nunca mais poderão ser usados.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfLote(null)}>Cancelar</Button>
              <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={iniciarLote} disabled={iniciando}>{iniciando ? "Iniciando..." : "Iniciar lote"}</Button>
            </div>
          </div>
        </div>
      )}

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
