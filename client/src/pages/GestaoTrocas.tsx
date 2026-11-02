import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Copy } from "lucide-react";

// ---------------------------------------------------------------------------
// GESTÃO DE TROCAS (Produtos e Estoque) — 01/nov/2026
// Lista das NF-e de troca → conferência no CD garrafa a garrafa (lote, validade, como
// chegou, destino) → qualidade: validação da Indústria · comercial: Indústria só avisada.
// Backend: server/gestao-trocas-routes.ts
// ---------------------------------------------------------------------------

type Nota = { invoiceId: string; nf: string; emissao: string; cliente: string; vendedor: string | null; motivo: string | null; garrafas: number; valor: number; status: string; statusLabel: string };
type Garrafa = { n: number; lote: string; validade: string; cond: string; destino: string };
type Item = { invoiceItemId: string; productId: string; produto: string; qtdNF: number; valorUnit: number; qtdRecebida: number; saborOk: boolean; recebido: boolean; conferido: boolean; garrafas: Garrafa[] };

const brl = (v: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0);
const STATUS_CLS: Record<string, string> = {
  aguardando: "bg-gray-100 text-gray-700",
  em_conferencia: "bg-amber-100 text-amber-800",
  na_industria: "bg-blue-100 text-blue-800",
  validada: "bg-green-100 text-green-800",
  comercial: "bg-purple-100 text-purple-800",
};
const ABAS: Array<[string, string]> = [["todas", "Todas"], ["aguardando", "Aguardando chegada"], ["em_conferencia", "Em conferência"], ["na_industria", "Na Indústria"], ["concluidas", "Concluídas"]];
const naAba = (st: string, aba: string) => aba === "todas" || st === aba || (aba === "concluidas" && (st === "validada" || st === "comercial"));

async function api(method: string, url: string, body?: any) {
  const r = await fetch(url, { method, credentials: "include", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || "Falha");
  return j;
}

export default function GestaoTrocas() {
  const [location, navigate] = useLocation();
  const qs = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const [nfSel, setNfSel] = useState<string | null>(qs.get("nf"));
  useEffect(() => { setNfSel(new URLSearchParams(window.location.search).get("nf")); }, [location]);
  const abrir = (id: string | null) => { navigate(id ? `/gestao-trocas?nf=${encodeURIComponent(id)}` : "/gestao-trocas"); setNfSel(id); };
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-6 space-y-4">
        {nfSel ? <Detalhe invoiceId={nfSel} voltar={() => abrir(null)} /> : <Lista abrir={abrir} />}
      </div>
    </div>
  );
}

function Lista({ abrir }: { abrir: (id: string) => void }) {
  const [aba, setAba] = useState("todas");
  const [busca, setBusca] = useState("");
  const { data, isLoading, isError } = useQuery<{ notas: Nota[]; dias: number }>({ queryKey: ["/api/gestao-trocas"], queryFn: () => api("GET", "/api/gestao-trocas?dias=60") });
  const notas = data?.notas || [];
  const q = busca.trim().toLowerCase();
  const lista = notas.filter((x) => naAba(x.status, aba) && (!q || [x.nf, x.cliente, x.vendedor].some((v) => String(v || "").toLowerCase().includes(q))));
  const conta = (st: string) => notas.filter((x) => naAba(x.status, st)).length;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-gray-600">Produtos e Estoque › Gestão de Trocas</div>
          <h1 className="text-2xl font-bold">Gestão de Trocas</h1>
          <p className="text-sm text-gray-600">Notas de troca emitidas e o recebimento dos produtos no CD Goiânia (últimos {data?.dias ?? 60} dias)</p>
        </div>
        <div className="flex gap-2 items-end">
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="NF, cliente ou vendedor" className="h-10 w-60 rounded-md border px-3 text-sm bg-white" />
          <BackToDashboardButton />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[["aguardando", "Aguardando chegada"], ["em_conferencia", "Em conferência"], ["na_industria", "Na Indústria"], ["concluidas", "Concluídas"]].map(([k, l]) => (
          <div key={k} className="rounded-lg border bg-white p-3"><div className="text-xs text-gray-600">{l}</div><div className="text-2xl font-bold">{conta(k)}</div></div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 border-b">
        {ABAS.map(([k, l]) => (
          <button key={k} onClick={() => setAba(k)} className={`px-4 py-2.5 text-sm border-b-2 ${aba === k ? "border-green-700 text-green-800 font-bold" : "border-transparent text-gray-600"}`}>
            {l} <span className="ml-1 rounded-full bg-gray-100 px-2 text-xs">{conta(k)}</span>
          </button>
        ))}
      </div>
      <div className="rounded-lg border bg-white overflow-x-auto">
        {isLoading ? <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>
          : isError ? <div className="p-6 text-center text-sm text-red-600">Não foi possível carregar.</div>
          : lista.length === 0 ? <div className="p-6 text-center text-sm text-gray-500">Nenhuma nota nesta situação.</div>
          : (
            <table className="w-full text-sm min-w-[980px]">
              <thead className="bg-gray-100 text-left text-gray-700">
                <tr className="[&>th]:px-3 [&>th]:py-2"><th>NF de troca</th><th>Emissão</th><th>Cliente</th><th>Vendedor</th><th>Motivo no card</th><th className="text-right">Garrafas</th><th className="text-right">Valor</th><th>Situação</th><th></th></tr>
              </thead>
              <tbody>
                {lista.map((x) => (
                  <tr key={x.invoiceId} className="border-t [&>td]:px-3 [&>td]:py-2">
                    <td className="font-semibold">{x.nf}</td><td className="text-gray-600">{x.emissao}</td><td>{x.cliente}</td><td className="text-gray-600">{x.vendedor || "—"}</td>
                    <td>{x.motivo || "—"}</td><td className="text-right">{x.garrafas}</td><td className="text-right">{brl(x.valor)}</td>
                    <td><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLS[x.status] || ""}`}>{x.statusLabel}</span></td>
                    <td className="text-right">
                      <Button size="sm" variant={x.status === "aguardando" || x.status === "em_conferencia" ? "default" : "outline"} onClick={() => abrir(x.invoiceId)}>
                        {x.status === "aguardando" || x.status === "em_conferencia" ? "Receber e conferir" : "Abrir"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}

function Detalhe({ invoiceId, voltar }: { invoiceId: string; voltar: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<any>({ queryKey: ["/api/gestao-trocas", invoiceId], queryFn: () => api("GET", `/api/gestao-trocas/${invoiceId}`) });
  const [itens, setItens] = useState<Item[]>([]);
  const [tipo, setTipo] = useState<"qualidade" | "comercial">("qualidade");
  const [obs, setObs] = useState("");
  const [descarte, setDescarte] = useState("");
  const [enviando, setEnviando] = useState(false);
  useEffect(() => {
    if (!data) return;
    setItens(data.itens || []);
    setObs(data.conferencia?.observacaoCd || "");
    setDescarte(data.conferencia?.descarteComo || "");
    const temDef = (data.itens || []).some((i: Item) => i.garrafas.some((g) => g.cond !== "ok" && g.cond !== "vencida"));
    setTipo(data.conferencia?.tipo || (temDef ? "qualidade" : "comercial"));
  }, [data]);

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (isError || !data) return <div className="p-6 text-center text-sm text-red-600">Não foi possível abrir a nota. <button className="underline" onClick={voltar}>Voltar</button></div>;
  const st = data.conferencia?.status || "aguardando";
  const editavel = (st === "aguardando" || st === "em_conferencia") && data.podeConferir;
  const CONDS: Record<string, string> = data.condicoes || {};
  const DESTS: Record<string, string> = data.destinos || {};
  const ehDef = (c: string) => c !== "ok" && c !== "vencida";
  const sugerido = (c: string) => (c === "ok" ? "estoque" : c === "vencida" ? "descarte" : c === "fermentada" ? "industria" : "quarentena");

  const upd = (i: number, fn: (it: Item) => Item) => setItens((xs) => xs.map((x, k) => (k === i ? fn({ ...x, garrafas: x.garrafas.map((g) => ({ ...g })) }) : x)));
  const setQtd = (i: number, q: number) => upd(i, (it) => {
    const qq = Math.max(0, Math.min(999, Math.floor(q || 0)));
    const g = it.garrafas.slice(0, qq);
    while (g.length < qq) g.push({ n: g.length + 1, lote: "", validade: "", cond: "ok", destino: "estoque" });
    return { ...it, qtdRecebida: qq, garrafas: g };
  });
  const todas = itens.flatMap((i) => i.garrafas);
  const defeitos = todas.filter((g) => ehDef(g.cond)).length;
  const temDescarte = todas.some((g) => g.destino === "descarte");
  const resumo = (gs: Garrafa[], campo: "cond" | "destino") => {
    const m: Record<string, number> = {};
    gs.forEach((g) => { m[g[campo]] = (m[g[campo]] || 0) + 1; });
    return Object.entries(m).map(([k, v]) => `${v} ${(campo === "cond" ? CONDS[k] : DESTS[k]) || k}`.toLowerCase());
  };

  const salvar = async () => {
    try { setEnviando(true); await api("POST", `/api/gestao-trocas/${invoiceId}/salvar`, { itens, observacao: obs, descarteComo: descarte }); toast({ title: "Conferência salva" }); qc.invalidateQueries({ queryKey: ["/api/gestao-trocas"] }); }
    catch (e: any) { toast({ title: "Não foi possível salvar", description: e.message, variant: "destructive" }); }
    finally { setEnviando(false); }
  };
  const fechar = async () => {
    try {
      setEnviando(true);
      const r = await api("POST", `/api/gestao-trocas/${invoiceId}/fechar`, { itens, tipo, observacao: obs, descarteComo: descarte });
      const est = (r.estoque || []).filter((x: any) => x.ok).reduce((s: number, x: any) => s + x.qtd, 0);
      toast({ title: tipo === "comercial" ? "Troca registrada como comercial" : "Enviada para a Indústria", description: `${est ? `${est} garrafa(s) voltaram ao estoque da GYN. ` : ""}${tipo === "comercial" ? "A Indústria recebeu o aviso." : "A Indústria foi avisada para validar."}` });
      qc.invalidateQueries({ queryKey: ["/api/gestao-trocas"] });
    } catch (e: any) { toast({ title: "Não foi possível fechar", description: e.message, variant: "destructive" }); }
    finally { setEnviando(false); }
  };

  const nf = data.nf;
  return (
    <div className="space-y-4">
      <button onClick={voltar} className="text-sm text-green-800 flex items-center gap-1"><ArrowLeft className="h-4 w-4" /> Gestão de Trocas</button>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">NF de troca {nf.nf}</h1>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLS[st] || ""}`}>{data.conferencia?.statusLabel}</span>
      </div>
      <div className="rounded-lg border bg-white p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <div><div className="text-gray-500">Cliente</div><b>{nf.cliente}</b></div>
        <div><div className="text-gray-500">Vendedor</div><b>{nf.vendedor || "—"}</b></div>
        <div><div className="text-gray-500">Emissão</div><b>{nf.emissao}</b></div>
        <div><div className="text-gray-500">Motivo no card</div><b>{nf.motivo || "—"}</b></div>
        <div><div className="text-gray-500">Fotos do card</div>{nf.fotos?.length ? nf.fotos.map((u: string, i: number) => <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="mr-2 underline text-green-800">foto {i + 1}</a>) : "—"}</div>
      </div>
      {nf.observacaoVendedor && <div className="rounded-md border bg-yellow-50 p-3 text-sm"><b>Observação do vendedor:</b> {nf.observacaoVendedor}</div>}

      {editavel && (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm">Para cada produto: confira quantidade e sabor, marque <b>Recebido</b> e <b>Conferido</b>, informe lote e validade de cada garrafa, como ela chegou e o destino. Se as garrafas seguintes têm o mesmo lote e validade, use <b>Copiar para as de baixo</b>.</div>
      )}

      {itens.map((it, i) => (
        <section key={i} className="rounded-lg border bg-white overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 px-4 py-3 border-b">
            <div><div className="font-bold">{it.produto}</div><div className="text-xs text-gray-600">Na NF: {it.qtdNF} garrafas · {brl(it.valorUnit)} cada</div></div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">Qtd recebida
                <input type="number" min={0} disabled={!editavel} value={it.qtdRecebida} onChange={(e) => setQtd(i, parseInt(e.target.value, 10))} className="h-10 w-20 rounded-md border px-2" />
              </label>
              {(["saborOk", "recebido", "conferido"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5 min-h-[40px]"><input type="checkbox" disabled={!editavel} checked={it[k]} onChange={() => upd(i, (x) => ({ ...x, [k]: !x[k] }))} className="h-4 w-4" />{k === "saborOk" ? "Sabor confere" : k === "recebido" ? "Recebido" : "Conferido"}</label>
              ))}
            </div>
          </div>
          {it.qtdRecebida !== it.qtdNF && <div className="px-4 py-2 text-sm font-semibold text-red-800 bg-red-50 border-b">Quantidade recebida diferente da NF ({it.qtdRecebida} de {it.qtdNF}).</div>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[1050px]">
              <thead className="text-left text-gray-700"><tr className="[&>th]:px-3 [&>th]:py-2"><th className="w-16">Garrafa</th><th>Lote</th><th>Validade</th><th></th><th>Como chegou</th><th>Destino</th></tr></thead>
              <tbody>
                {it.garrafas.map((g, gi) => (
                  <tr key={gi} className="border-t [&>td]:px-3 [&>td]:py-1.5">
                    <td className="text-gray-500">#{gi + 1}</td>
                    <td><input disabled={!editavel} value={g.lote} placeholder="Ex.: H170926" onChange={(e) => upd(i, (x) => { x.garrafas[gi].lote = e.target.value.toUpperCase(); return x; })} className="h-9 w-36 rounded-md border px-2" /></td>
                    <td><input type="date" disabled={!editavel} value={g.validade} onChange={(e) => upd(i, (x) => { x.garrafas[gi].validade = e.target.value; return x; })} className="h-9 w-40 rounded-md border px-2" /></td>
                    <td>{editavel && gi < it.garrafas.length - 1 && (
                      <button onClick={() => upd(i, (x) => { for (let k = gi + 1; k < x.garrafas.length; k++) { x.garrafas[k].lote = x.garrafas[gi].lote; x.garrafas[k].validade = x.garrafas[gi].validade; } return x; })}
                        className="h-9 px-2.5 rounded-md border border-green-300 bg-green-50 text-green-800 text-xs font-semibold flex items-center gap-1 whitespace-nowrap"><Copy className="h-3.5 w-3.5" />Copiar para as de baixo</button>
                    )}</td>
                    <td>
                      <select disabled={!editavel} value={g.cond} onChange={(e) => upd(i, (x) => { x.garrafas[gi].cond = e.target.value; x.garrafas[gi].destino = sugerido(e.target.value); return x; })}
                        className={`h-9 min-w-[220px] rounded-md border px-2 ${g.cond === "ok" ? "bg-white" : g.cond === "vencida" ? "bg-purple-50 border-purple-300" : "bg-red-50 border-red-300"}`}>
                        {Object.entries(CONDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </td>
                    <td>
                      <select disabled={!editavel} value={g.destino} onChange={(e) => upd(i, (x) => { x.garrafas[gi].destino = e.target.value; return x; })} className="h-9 min-w-[190px] rounded-md border px-2 bg-white">
                        {Object.entries(DESTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 border-t text-xs">
            <span className="text-gray-600">Resumo: {resumo(it.garrafas, "cond").join(" · ") || "—"}</span>
            {editavel && (
              <label className="flex items-center gap-2 text-sm">Mesmo destino para todas
                <select value="" onChange={(e) => { const d = e.target.value; if (d) upd(i, (x) => { x.garrafas.forEach((g) => { g.destino = d; }); return x; }); }} className="h-9 rounded-md border px-2 bg-white">
                  <option value="">Escolher…</option>{Object.entries(DESTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
            )}
          </div>
        </section>
      ))}

      {editavel && (
        <section className="rounded-lg border bg-white p-4 space-y-3">
          <h2 className="text-lg font-bold">Fechar a conferência</h2>
          <div className="text-sm text-gray-700">Total: {resumo(todas, "cond").join(" · ") || "—"} · Destino: {resumo(todas, "destino").join(" · ") || "—"}</div>
          {todas.some((g) => g.destino === "estoque" && g.cond !== "ok") && <div className="rounded-md bg-red-50 border border-red-200 p-2 text-sm font-semibold text-red-800">Só volta ao estoque garrafa sem defeito e dentro da validade.</div>}
          <div className="grid md:grid-cols-2 gap-3">
            {(["qualidade", "comercial"] as const).map((t) => (
              <label key={t} className={`flex gap-2 rounded-lg p-3 cursor-pointer border-2 ${tipo === t ? (t === "qualidade" ? "border-blue-700" : "border-purple-700") : "border-gray-200"}`}>
                <input type="radio" checked={tipo === t} onChange={() => setTipo(t)} className="mt-1" />
                <span><b>{t === "qualidade" ? "Problema de qualidade" : "Somente comercial"}</b>
                  <span className="block text-sm text-gray-600">{t === "qualidade" ? "Há garrafa com defeito. Vai para validação da Indústria." : "Sem defeito de fabricação, envase ou industrialização. Fica registrado e a Indústria só recebe o aviso."}</span></span>
              </label>
            ))}
          </div>
          {tipo === "comercial" && defeitos > 0 && <div className="rounded-md bg-red-50 border border-red-200 p-2 text-sm font-semibold text-red-800">Há {defeitos} garrafa(s) marcadas com defeito. Para registrar como comercial, revise a coluna "Como chegou".</div>}
          {tipo === "qualidade" && defeitos === 0 && <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-sm text-amber-900">Nenhuma garrafa com defeito. Se não houve problema de qualidade, escolha "Somente comercial".</div>}
          {temDescarte && (
            <label className="block text-sm font-semibold">Como foi feito o descarte <span className="text-red-600">*</span>
              <textarea rows={2} value={descarte} onChange={(e) => setDescarte(e.target.value)} placeholder="Ex.: conteúdo descartado no ralo do CD em 01/11; garrafas separadas para reciclagem." className="mt-1 w-full rounded-md border p-2 font-normal" />
            </label>
          )}
          <label className="block text-sm">Observação do CD (opcional)
            <textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} className="mt-1 w-full rounded-md border p-2" />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={enviando} onClick={salvar}>Salvar e continuar depois</Button>
            <Button disabled={enviando} onClick={fechar} className={tipo === "qualidade" ? "bg-blue-800 hover:bg-blue-900" : "bg-purple-800 hover:bg-purple-900"}>
              {enviando && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{tipo === "qualidade" ? "Enviar para Indústria" : "Registrar como comercial"}
            </Button>
          </div>
        </section>
      )}

      {!editavel && (st === "aguardando" || st === "em_conferencia") && <div className="text-sm text-gray-600">A conferência é feita pelo CD (Flavio, Lanucy e Robson).</div>}
      {st !== "aguardando" && st !== "em_conferencia" && <ResumoCD data={data} />}
      {st === "na_industria" && <Validacao data={data} invoiceId={invoiceId} />}
      {st === "validada" && <ParecerFinal data={data} />}
    </div>
  );
}

function ResumoCD({ data }: { data: any }) {
  const c = data.conferencia || {};
  return (
    <section className="rounded-lg border bg-white p-4 space-y-1 text-sm">
      <h2 className="text-base font-bold">Conferência do CD</h2>
      <div>Conferida por <b>{c.conferidoPor || "—"}</b> em {c.enviadoEm || "—"} · {c.tipo === "comercial" ? "Somente comercial (Indústria avisada)" : "Problema de qualidade"}</div>
      {c.descarteComo && <div><b>Descarte:</b> {c.descarteComo}</div>}
      {c.observacaoCd && <div className="whitespace-pre-line"><b>Observação do CD:</b> {c.observacaoCd}</div>}
    </section>
  );
}

function Validacao({ data, invoiceId }: { data: any; invoiceId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const defeitos: any[] = data.defeitos || [];
  const [parecer, setParecer] = useState<Record<string, { origem: string; destinoFinal: string }>>({});
  const [analise, setAnalise] = useState("");
  const [plano, setPlano] = useState(false);
  const [descarte, setDescarte] = useState("");
  const [enviando, setEnviando] = useState(false);
  const lotesRepetidos = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const h of data.historicoLotes || []) { const s = m.get(h.lote) || new Set(); s.add(h.cliente); m.set(h.lote, s); }
    return Array.from(m.entries()).filter(([, s]) => Array.from(s).some((c) => c !== data.nf?.cliente)).map(([l]) => l);
  }, [data]);
  useEffect(() => { if (lotesRepetidos.length) setPlano(true); }, [lotesRepetidos.length]);
  if (!data.podeValidar) return <div className="rounded-md border bg-blue-50 p-3 text-sm">Aguardando a validação da Indústria (Naiara e Flavio).</div>;
  const get = (k: string, d: any) => parecer[k] || { origem: "", destinoFinal: d.destino };
  const set = (k: string, d: any, campo: "origem" | "destinoFinal", v: string) => setParecer((p) => ({ ...p, [k]: { ...get(k, d), [campo]: v } }));
  const precisaDescarte = defeitos.some((d) => get(d.chave, d).destinoFinal === "descarte" && d.destino !== "descarte");
  const validar = async () => {
    try {
      setEnviando(true);
      await api("POST", `/api/gestao-trocas/${invoiceId}/validar`, { parecer: defeitos.map((d) => ({ chave: d.chave, ...get(d.chave, d) })), analise, planoAcao: plano, descarteComo: descarte });
      toast({ title: "Troca validada" });
      qc.invalidateQueries({ queryKey: ["/api/gestao-trocas"] });
    } catch (e: any) { toast({ title: "Não foi possível validar", description: e.message, variant: "destructive" }); }
    finally { setEnviando(false); }
  };
  const devolver = async () => {
    const motivo = window.prompt("O que o CD deve corrigir?", "");
    if (!motivo) return;
    try { await api("POST", `/api/gestao-trocas/${invoiceId}/devolver`, { motivo }); toast({ title: "Devolvida ao CD" }); qc.invalidateQueries({ queryKey: ["/api/gestao-trocas"] }); }
    catch (e: any) { toast({ title: "Não foi possível devolver", description: e.message, variant: "destructive" }); }
  };
  return (
    <section className="rounded-lg border-2 border-blue-700 bg-white p-4 space-y-3">
      <h2 className="text-lg font-bold">Validação da Indústria</h2>
      {lotesRepetidos.length > 0 && <div className="rounded-md bg-amber-50 border border-amber-300 p-2 text-sm font-semibold text-amber-900">Lote {lotesRepetidos.join(", ")} já teve troca de qualidade em outro cliente. Pela política, abre plano de ação.</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-gray-50 text-left"><tr className="[&>th]:px-3 [&>th]:py-2"><th>Produto</th><th>Lote</th><th>Como chegou</th><th className="text-right">Garrafas</th><th>Parecer</th><th>Destino final</th></tr></thead>
          <tbody>
            {defeitos.map((d) => (
              <tr key={d.chave} className="border-t [&>td]:px-3 [&>td]:py-1.5">
                <td>{d.produto}</td><td>{d.lote}</td><td><span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800">{d.condLabel}</span></td><td className="text-right">{d.qtd}</td>
                <td><select value={get(d.chave, d).origem} onChange={(e) => set(d.chave, d, "origem", e.target.value)} className="h-9 min-w-[230px] rounded-md border px-2 bg-white">
                  <option value="">Selecione…</option>{Object.entries(data.origens || {}).map(([k, l]: any) => <option key={k} value={k}>{l}</option>)}
                </select></td>
                <td><select value={get(d.chave, d).destinoFinal} onChange={(e) => set(d.chave, d, "destinoFinal", e.target.value)} className="h-9 min-w-[190px] rounded-md border px-2 bg-white">
                  {Object.entries(data.destinos || {}).map(([k, l]: any) => <option key={k} value={k}>{l}</option>)}
                </select><div className="text-[11px] text-gray-500">CD indicou: {d.destinoLabel}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(data.historicoLotes || []).length > 0 && (
        <div className="text-sm"><b>Histórico dos lotes:</b>{(data.historicoLotes || []).map((h: any, i: number) => <div key={i} className="text-gray-700">{h.data} · {h.cliente} · NF {h.nf} · {h.produto} · lote {h.lote} · {h.cond} · {h.qtd} garrafa(s)</div>)}</div>
      )}
      <label className="block text-sm font-semibold">Análise e causa provável <span className="text-red-600">*</span>
        <textarea rows={3} value={analise} onChange={(e) => setAnalise(e.target.value)} className="mt-1 w-full rounded-md border p-2 font-normal" />
      </label>
      {precisaDescarte && (
        <label className="block text-sm font-semibold">Como será/foi feito o descarte <span className="text-red-600">*</span>
          <textarea rows={2} value={descarte} onChange={(e) => setDescarte(e.target.value)} className="mt-1 w-full rounded-md border p-2 font-normal" />
        </label>
      )}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={plano} onChange={() => setPlano(!plano)} className="h-4 w-4" />Abrir plano de ação</label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={devolver}>Devolver ao CD para correção</Button>
        <Button disabled={enviando} onClick={validar} className="bg-green-800 hover:bg-green-900">{enviando && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Validar troca</Button>
      </div>
    </section>
  );
}

function ParecerFinal({ data }: { data: any }) {
  const c = data.conferencia || {};
  const ORIG: Record<string, string> = data.origens || {}; const DEST: Record<string, string> = data.destinos || {};
  return (
    <section className="rounded-lg border bg-white p-4 space-y-2 text-sm">
      <h2 className="text-base font-bold">Parecer da Indústria</h2>
      <div>Validada por <b>{c.validadoPor || "—"}</b> em {c.validadoEm || "—"}{c.planoAcao ? " · plano de ação aberto" : ""}</div>
      {(c.parecer || []).map((p: any, i: number) => <div key={i}>{p.qtd} × {p.produto} · lote {p.lote} · {(data.condicoes || {})[p.cond]} → <b>{ORIG[p.origem] || p.origem}</b> · destino final: {DEST[p.destinoFinal] || p.destinoFinal}</div>)}
      {c.analise && <div className="whitespace-pre-line"><b>Análise:</b> {c.analise}</div>}
      {c.descarteComoIndustria && <div><b>Descarte:</b> {c.descarteComoIndustria}</div>}
    </section>
  );
}
