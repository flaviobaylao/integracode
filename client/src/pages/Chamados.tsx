import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

// CHAMADOS (21/out/2026) — solicitações internas. Backend: server/chamados-routes.ts.
// Cada usuário vê só os chamados dele: os que abriu, os do destino que atende e as
// consultas que recebeu. Funciona no celular (lista ↔ detalhe) e no computador (lado a lado).

type Destino = { key: string; nome: string; setor: string; label: string; configurado: boolean };
type Perfil = { destinos: Destino[]; minhasKeys: string[]; admin: boolean; usuario: { id: string; nome: string } };
type Consulta = { key: string; nome: string; setor: string; pendente: boolean };
type Chamado = {
  id: string; codigo: string; numero: number; assunto: string; descricao: string | null; prioridade: string; status: string;
  autorId: string; autorNome: string; destinoKey: string; destinoNome: string; destinoSetor: string;
  createdAt: string; updatedAt: string; papel: "autor" | "dono" | "consultado" | "admin"; naoLido: boolean;
  consultas: Consulta[]; aguardando: string[]; consultaPendenteParaMim: boolean;
};
type Mensagem = { id: string; tipo: "publica" | "interna" | "sistema"; autorNome: string; deKey: string | null; paraKey: string | null; texto: string; createdAt: string; minha: boolean };

const STATUS: Record<string, { label: string; cls: string }> = {
  novo: { label: "Novo", cls: "bg-orange-100 text-orange-800" },
  em_atendimento: { label: "Em atendimento", cls: "bg-blue-100 text-blue-800" },
  respondido: { label: "Respondido", cls: "bg-green-100 text-green-800" },
};
const PRIO_CLS: Record<string, string> = { Baixa: "text-gray-600", Normal: "text-blue-700", Urgente: "text-red-700" };

async function getJson(url: string) {
  const r = await fetch(url, { credentials: "include" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || `Erro ${r.status}`);
  return j;
}
async function postJson(url: string, body: any) {
  const r = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || `Erro ${r.status}`);
  return j;
}
function dataHora(iso: string) {
  try {
    return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

export default function Chamados() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const idUrl = useMemo(() => new URLSearchParams(window.location.search).get("id"), []);
  const [caixa, setCaixa] = useState<string>("tudo");
  const [busca, setBusca] = useState("");
  const [selId, setSelId] = useState<string | null>(idUrl);
  const [novoAberto, setNovoAberto] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const perfilQ = useQuery<Perfil>({ queryKey: ["/api/chamados/perfil"], queryFn: () => getJson("/api/chamados/perfil") });
  const perfil = perfilQ.data;
  const atendeAlgum = (perfil?.minhasKeys?.length || 0) > 0;

  const escopo = caixa === "todos" ? "todos" : "tudo";
  const listaQ = useQuery<{ chamados: Chamado[] }>({
    queryKey: ["/api/chamados", escopo],
    queryFn: () => getJson("/api/chamados?caixa=" + escopo),
    refetchInterval: 30000,
  });

  const todos = listaQ.data?.chamados || [];
  const uid = perfil?.usuario?.id;
  const contagem = {
    tudo: todos.filter((c) => c.naoLido).length,
    meus: todos.filter((c) => c.autorId === uid && c.naoLido).length,
    recebidos: todos.filter((c) => c.papel === "dono" && (c.naoLido || c.status === "novo")).length,
    consultas: todos.filter((c) => c.papel === "consultado" && (c.naoLido || c.consultaPendenteParaMim)).length,
  };
  const lista = todos
    .filter((c) => {
      if (caixa === "meus") return c.autorId === uid;
      if (caixa === "recebidos") return c.papel === "dono";
      if (caixa === "consultas") return c.papel === "consultado";
      return true;
    })
    .filter((c) => {
      const q = busca.trim().toLowerCase();
      if (!q) return true;
      return (c.codigo + " " + c.assunto + " " + c.autorNome + " " + c.destinoNome + " " + (c.descricao || "")).toLowerCase().includes(q);
    });

  const abas: [string, string, number][] = [
    ["tudo", "Todos os meus", contagem.tudo],
    ["meus", "Abertos por mim", contagem.meus],
  ];
  if (atendeAlgum) abas.push(["recebidos", "Recebidos", contagem.recebidos]);
  if (atendeAlgum || todos.some((c) => c.papel === "consultado")) abas.push(["consultas", "Consultas para mim", contagem.consultas]);
  if (perfil?.admin) abas.push(["todos", "Todos (admin)", 0]);

  const refresh = () => {
    // só a lista e o contador do menu (o detalhe se atualiza sozinho; invalidá-lo aqui faria loop)
    qc.invalidateQueries({ queryKey: ["/api/chamados"] });
    qc.invalidateQueries({ queryKey: ["/api/chamados/contadores"] });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-[1400px] mx-auto p-3 sm:p-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BackToDashboardButton />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Chamados</h1>
              <p className="text-sm text-gray-500">Solicitações para Administração, Comercial, Indústria e Adm/Logística/Financeiro</p>
            </div>
          </div>
          <Button className="bg-green-700 hover:bg-green-800 text-white h-11 px-5" onClick={() => setNovoAberto(true)} data-testid="button-novo-chamado">
            + Abrir chamado
          </Button>
        </div>

        <div className="flex flex-wrap gap-2" role="tablist">
          {abas.map(([k, label, n]) => (
            <button key={k} type="button" role="tab" aria-selected={caixa === k}
              onClick={() => { setCaixa(k); setSelId(null); }}
              className={`min-h-[40px] px-4 rounded-full border text-sm font-semibold ${caixa === k ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-800 border-gray-300"}`}>
              {label}{n > 0 && <span className={`ml-2 inline-flex min-w-[20px] h-5 px-1.5 items-center justify-center rounded-full text-xs ${caixa === k ? "bg-white text-gray-900" : "bg-orange-600 text-white"}`}>{n}</span>}
            </button>
          ))}
        </div>

        <div className="flex flex-col lg:flex-row gap-4 items-start">
          <div className={`w-full lg:w-[420px] lg:flex-shrink-0 bg-white border rounded-xl ${selId ? "hidden lg:block" : ""}`}>
            <div className="p-3 border-b">
              <label htmlFor="busca-chamado" className="sr-only">Buscar chamado</label>
              <input id="busca-chamado" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nº, assunto ou pessoa"
                className="w-full h-10 px-3 border rounded-lg text-sm" />
            </div>
            <div className="max-h-[70vh] overflow-y-auto">
              {listaQ.isLoading && <div className="p-6 text-center text-gray-500 text-sm">Carregando…</div>}
              {!listaQ.isLoading && lista.length === 0 && (
                <div className="p-8 text-center text-gray-500 text-sm">Nenhum chamado aqui. Toque em “Abrir chamado” para criar um.</div>
              )}
              {lista.map((c) => {
                const st = STATUS[c.status] || STATUS.novo;
                return (
                  <button key={c.id} type="button" onClick={() => setSelId(c.id)} data-testid={`chamado-${c.codigo}`}
                    className={`w-full text-left px-4 py-3 border-b flex flex-col gap-1 ${selId === c.id ? "bg-green-50" : c.naoLido ? "bg-orange-50" : "bg-white"}`}>
                    <span className="flex justify-between gap-2 text-xs">
                      <span className="font-bold text-gray-600">{c.codigo} · {c.papel === "autor" ? `Para ${c.destinoNome}` : `De ${c.autorNome}`}</span>
                      <span className="text-gray-500">{dataHora(c.createdAt)}</span>
                    </span>
                    <span className={`text-[15px] leading-snug ${c.naoLido ? "font-bold" : "font-medium"} text-gray-900`}>{c.assunto}</span>
                    <span className="flex flex-wrap gap-2 items-center text-xs">
                      {c.papel === "consultado"
                        ? <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-semibold">Consulta de {c.destinoNome}</span>
                        : <span className={`px-2 py-0.5 rounded-full font-semibold ${st.cls}`}>{st.label}</span>}
                      {c.aguardando.length > 0 && <span className="text-purple-800 font-semibold">⏳ Aguardando {c.aguardando.join(", ")}</span>}
                      <span className={`font-semibold ${PRIO_CLS[c.prioridade] || ""}`}>{c.prioridade}</span>
                      {c.naoLido && <span className="text-orange-700 font-bold">● novidade</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`w-full flex-1 min-w-0 ${selId ? "" : "hidden lg:block"}`}>
            {selId
              ? <Detalhe id={selId} perfil={perfil} onVoltar={() => setSelId(null)} onMudou={refresh} />
              : <div className="bg-white border rounded-xl p-10 text-center text-gray-500">Selecione um chamado na lista</div>}
          </div>
        </div>
      </div>

      {novoAberto && perfil && (
        <NovoChamado perfil={perfil} enviando={enviando} onFechar={() => setNovoAberto(false)}
          onEnviar={async (body) => {
            setEnviando(true);
            try {
              const r = await postJson("/api/chamados", body);
              toast({ title: `Chamado ${r.codigo} aberto`, description: `Enviado para ${r.destino}. Você será avisado quando for respondido.` });
              setNovoAberto(false);
              setCaixa("tudo");
              setSelId(r.id);
              refresh();
            } catch (e: any) {
              toast({ title: "Não foi possível abrir", description: e.message, variant: "destructive" });
            } finally { setEnviando(false); }
          }} />
      )}
    </div>
  );
}

function NovoChamado({ perfil, enviando, onFechar, onEnviar }: { perfil: Perfil; enviando: boolean; onFechar: () => void; onEnviar: (b: any) => void }) {
  const [destinoKey, setDestinoKey] = useState("");
  const [assunto, setAssunto] = useState("");
  const [descricao, setDescricao] = useState("");
  const [prioridade, setPrioridade] = useState("Normal");
  const ok = !!destinoKey && assunto.trim().length >= 3;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="titulo-novo">
      <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 id="titulo-novo" className="text-lg font-bold">Novo chamado</h2>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="w-10 h-10 rounded-lg bg-gray-100 text-xl leading-none">×</button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ch-destino" className="text-sm font-semibold">Para quem é o chamado?</label>
          <select id="ch-destino" value={destinoKey} onChange={(e) => setDestinoKey(e.target.value)} className="h-12 px-3 border rounded-lg text-[15px] bg-white" data-testid="select-destino">
            <option value="">Selecione…</option>
            {perfil.destinos.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ch-assunto" className="text-sm font-semibold">Assunto</label>
          <input id="ch-assunto" value={assunto} onChange={(e) => setAssunto(e.target.value)} maxLength={150}
            placeholder="Ex.: 2ª via de boleto do cliente" className="h-11 px-3 border rounded-lg text-[15px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ch-desc" className="text-sm font-semibold">Descreva o que precisa</label>
          <textarea id="ch-desc" value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={5}
            placeholder="Cliente, pedido, NF, o que aconteceu…" className="px-3 py-2 border rounded-lg text-[15px] resize-none" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Prioridade</span>
          <div className="flex gap-2">
            {["Baixa", "Normal", "Urgente"].map((p) => (
              <button key={p} type="button" onClick={() => setPrioridade(p)} aria-pressed={prioridade === p}
                className={`flex-1 h-11 rounded-lg border text-sm font-semibold ${prioridade === p ? (p === "Urgente" ? "bg-red-700 text-white border-red-700" : p === "Baixa" ? "bg-gray-700 text-white border-gray-700" : "bg-blue-800 text-white border-blue-800") : "bg-white"}`}>{p}</button>
            ))}
          </div>
        </div>
        <Button disabled={!ok || enviando} className="h-12 bg-green-700 hover:bg-green-800 text-white text-base"
          onClick={() => onEnviar({ destinoKey, assunto, descricao, prioridade })} data-testid="button-enviar-chamado">
          {enviando ? "Enviando…" : ok ? "Enviar chamado" : "Escolha o destino e o assunto"}
        </Button>
      </div>
    </div>
  );
}

function Detalhe({ id, perfil, onVoltar, onMudou }: { id: string; perfil?: Perfil; onVoltar: () => void; onMudou: () => void }) {
  const { toast } = useToast();
  const q = useQuery<{ chamado: Chamado; mensagens: Mensagem[] }>({
    queryKey: ["/api/chamados/detalhe", id],
    queryFn: () => getJson("/api/chamados/" + id),
    refetchInterval: 30000,
  });
  const [modo, setModo] = useState<"responder" | "consultar">("responder");
  const [texto, setTexto] = useState("");
  const [alvo, setAlvo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTexto(""); setAlvo(""); setModo("responder"); }, [id]);
  useEffect(() => { if (q.data) onMudou(); /* atualiza o "não lido" da lista */ /* eslint-disable-next-line */ }, [q.dataUpdatedAt]);

  if (q.isLoading) return <div className="bg-white border rounded-xl p-10 text-center text-gray-500">Carregando…</div>;
  if (q.error || !q.data) return <div className="bg-white border rounded-xl p-10 text-center text-red-700">{(q.error as any)?.message || "Chamado não encontrado"}</div>;
  const c = q.data.chamado;
  const st = STATUS[c.status] || STATUS.novo;
  const destLabel = (k: string | null) => perfil?.destinos.find((d) => d.key === k)?.nome || k || "";

  const acao = async (url: string, body: any, okMsg: string) => {
    setBusy(true);
    try { await postJson(url, body); toast({ title: okMsg }); setTexto(""); setAlvo(""); await q.refetch(); onMudou(); }
    catch (e: any) { toast({ title: "Não foi possível", description: e.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const ehDono = c.papel === "dono" || (c.papel === "admin" && perfil?.admin);
  const minhaConsultaPendente = c.papel === "consultado";

  return (
    <div className="bg-white border rounded-xl flex flex-col">
      <div className="p-4 border-b flex flex-col gap-2">
        <button type="button" onClick={onVoltar} className="lg:hidden self-start h-10 px-3 rounded-lg bg-gray-100 text-sm font-semibold">← Voltar à lista</button>
        <div className="flex flex-wrap justify-between gap-2 items-start">
          <span className="text-xs font-bold text-gray-600">Chamado {c.codigo} · responsável: {c.destinoNome} ({c.destinoSetor})</span>
          <span className={`px-3 py-1 rounded-full text-xs font-semibold ${st.cls}`}>{st.label}</span>
        </div>
        <h2 className="text-lg sm:text-xl font-bold text-gray-900">{c.assunto}</h2>
        <span className="text-sm text-gray-600">Aberto por <b>{c.autorNome}</b> em {dataHora(c.createdAt)} · Prioridade <b className={PRIO_CLS[c.prioridade]}>{c.prioridade}</b></span>
        {c.papel !== "autor" && c.consultas.length > 0 && (
          <span className="text-sm text-purple-800">Setores consultados: {c.consultas.map((x) => `${x.nome} (${x.pendente ? "aguardando" : "respondeu"})`).join(", ")}</span>
        )}
      </div>

      <div className="p-4 flex flex-col gap-3 bg-gray-50 max-h-[50vh] overflow-y-auto">
        {q.data.mensagens.map((m) => m.tipo === "sistema" ? (
          <span key={m.id} className="self-center text-center text-xs text-gray-600 bg-gray-200/70 px-3 py-1 rounded-full">{m.texto} · {dataHora(m.createdAt)}</span>
        ) : (
          <div key={m.id} className={`max-w-[85%] sm:max-w-[72%] rounded-xl px-3.5 py-2.5 flex flex-col gap-1 ${m.minha ? "self-end" : "self-start"} ${m.tipo === "interna" ? (m.minha ? "bg-purple-800 text-white" : "bg-purple-50 border border-dashed border-purple-400 text-gray-900") : (m.minha ? "bg-green-700 text-white" : "bg-white border text-gray-900")}`}>
            <span className="text-xs font-bold opacity-90">{m.tipo === "interna" ? `Interno · ${destLabel(m.deKey)} → ${destLabel(m.paraKey)}` : m.autorNome}</span>
            <span className="text-sm leading-relaxed whitespace-pre-line">{m.texto}</span>
            <span className="text-[11px] opacity-75 self-end">{dataHora(m.createdAt)}</span>
          </div>
        ))}
      </div>

      {c.papel === "autor" && (
        <div className="p-4 border-t flex flex-col gap-2">
          <label htmlFor="ch-comp" className="text-sm font-semibold">Complementar o chamado</label>
          <textarea id="ch-comp" value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} className="px-3 py-2 border rounded-lg text-sm resize-none" placeholder="Mais informação para o responsável…" />
          <Button disabled={busy || !texto.trim()} className="self-end h-11 bg-green-700 hover:bg-green-800 text-white"
            onClick={() => acao(`/api/chamados/${c.id}/complementar`, { texto }, "Mensagem enviada")}>Enviar</Button>
        </div>
      )}

      {ehDono && c.status === "novo" && (
        <div className="p-4 border-t bg-orange-50 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-orange-900">Este chamado ainda não foi recebido. Ao receber, o solicitante vê “Em atendimento”.</span>
          <Button disabled={busy} className="h-11 bg-orange-700 hover:bg-orange-800 text-white" data-testid="button-receber"
            onClick={() => acao(`/api/chamados/${c.id}/receber`, {}, "Chamado recebido")}>Receber chamado</Button>
        </div>
      )}

      {ehDono && c.status !== "novo" && (
        <div className="p-4 border-t flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setModo("responder")} aria-pressed={modo === "responder"}
              className={`h-9 px-4 rounded-full border text-sm font-semibold ${modo === "responder" ? "bg-green-700 text-white border-green-700" : "bg-white"}`}>Responder ao solicitante</button>
            <button type="button" onClick={() => setModo("consultar")} aria-pressed={modo === "consultar"}
              className={`h-9 px-4 rounded-full border text-sm font-semibold ${modo === "consultar" ? "bg-purple-800 text-white border-purple-800" : "bg-white"}`}>Consultar outro setor</button>
          </div>
          {modo === "responder" ? (
            <>
              <label htmlFor="ch-resp" className="text-sm font-semibold">Resposta para {c.autorNome}</label>
              <textarea id="ch-resp" value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} className="px-3 py-2 border rounded-lg text-sm resize-none" placeholder="Escreva a solução ou o encaminhamento…" />
              <div className="flex flex-wrap justify-between items-center gap-2">
                <span className={`text-xs ${c.aguardando.length ? "text-purple-800 font-semibold" : "text-gray-500"}`}>
                  {c.aguardando.length ? `Atenção: ainda aguardando retorno de ${c.aguardando.join(", ")}.` : "Ao enviar: vai para o inbox do solicitante e ele recebe aviso no celular."}
                </span>
                <Button disabled={busy || !texto.trim()} className="h-11 bg-green-700 hover:bg-green-800 text-white" data-testid="button-responder"
                  onClick={() => acao(`/api/chamados/${c.id}/responder`, { texto }, "Resposta enviada e solicitante avisado")}>Responder e notificar</Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 max-w-sm">
                <label htmlFor="ch-alvo" className="text-sm font-semibold">Enviar este chamado para</label>
                <select id="ch-alvo" value={alvo} onChange={(e) => setAlvo(e.target.value)} className="h-11 px-3 border rounded-lg text-sm bg-white">
                  <option value="">Selecione…</option>
                  {(perfil?.destinos || []).filter((d) => d.key !== c.destinoKey).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              </div>
              <label htmlFor="ch-cons" className="text-sm font-semibold">O que você precisa saber?</label>
              <textarea id="ch-cons" value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} className="px-3 py-2 border rounded-lg text-sm resize-none" placeholder="Ex.: tem produção de 900 ml para entregar quinta?" />
              <div className="flex flex-wrap justify-between items-center gap-2">
                <span className="text-xs text-purple-800">Conversa interna — o solicitante só vê que o chamado foi encaminhado.</span>
                <Button disabled={busy || !texto.trim() || !alvo} className="h-11 bg-purple-800 hover:bg-purple-900 text-white"
                  onClick={() => acao(`/api/chamados/${c.id}/consultar`, { destinoKey: alvo, texto }, "Consulta enviada")}>Enviar consulta</Button>
              </div>
            </>
          )}
        </div>
      )}

      {minhaConsultaPendente && (
        <div className="p-4 border-t bg-purple-50 flex flex-col gap-2">
          <span className="text-sm text-purple-900"><b>{c.destinoNome}</b> pediu sua ajuda neste chamado. Seu retorno vai para {c.destinoNome}, não para o solicitante.</span>
          <label htmlFor="ch-ret" className="text-sm font-semibold">Retorno para {c.destinoNome}</label>
          <textarea id="ch-ret" value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} className="px-3 py-2 border border-purple-300 rounded-lg text-sm resize-none bg-white" placeholder="Escreva a informação pedida…" />
          <Button disabled={busy || !texto.trim()} className="self-end h-11 bg-purple-800 hover:bg-purple-900 text-white" data-testid="button-retorno"
            onClick={() => acao(`/api/chamados/${c.id}/retorno`, { texto }, `Retorno enviado para ${c.destinoNome}`)}>Enviar retorno para {c.destinoNome}</Button>
        </div>
      )}
    </div>
  );
}
