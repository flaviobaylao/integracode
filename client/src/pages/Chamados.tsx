import { useEffect, useMemo, useRef, useState } from "react";
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
  createdAt: string; updatedAt: string; solucionadoEm?: string | null; canceladoEm?: string | null; papel: "autor" | "dono" | "consultado" | "admin"; naoLido: boolean;
  consultas: Consulta[]; aguardando: string[]; consultaPendenteParaMim: boolean;
};
type Anexo = { id: string; nome: string; mime: string | null; tamanho: number | null };
type Mensagem = { id: string; tipo: "publica" | "interna" | "sistema"; autorNome: string; deKey: string | null; paraKey: string | null; texto: string; createdAt: string; minha: boolean; anexos?: Anexo[] };

const STATUS: Record<string, { label: string; cls: string }> = {
  novo: { label: "Novo", cls: "bg-orange-100 text-orange-800" },
  em_atendimento: { label: "Em atendimento", cls: "bg-blue-100 text-blue-800" },
  respondido: { label: "Respondido", cls: "bg-green-100 text-green-800" },
  reaberto: { label: "Reaberto", cls: "bg-amber-100 text-amber-900" },
  solucionado: { label: "Solucionado", cls: "bg-gray-200 text-gray-800" },
  cancelado: { label: "Cancelado", cls: "bg-red-100 text-red-800" },
};
const encerrado = (st: string) => st === "solucionado" || st === "cancelado";
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
// Envia texto + arquivos (multipart). O servidor aceita JSON ou multipart nas mesmas rotas.
async function postForm(url: string, campos: Record<string, any>, arquivos: File[]) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== null) fd.append(k, String(v));
  for (const f of arquivos) fd.append("arquivos", f, f.name);
  let r: Response;
  try { r = await fetch(url, { method: "POST", credentials: "include", body: fd }); }
  catch { throw new Error("Sem conexão com o servidor. Confira a internet e toque em enviar de novo — o que você escreveu continua aqui."); }
  const txt = await r.text();
  let j: any = {};
  try { j = JSON.parse(txt); } catch { /* resposta não-JSON (ex.: proxy do Railway) */ }
  const parseOk = txt.trim().startsWith("{");
  if (!r.ok || !parseOk) {
    if (parseOk && j?.message) throw new Error(j.message);
    throw new Error(r.status >= 500 || /failed to respond/i.test(txt)
      ? "O servidor demorou para responder. Toque em enviar de novo — o que você escreveu e os anexos continuam aqui."
      : `Erro ${r.status}`);
  }
  return j;
}

// Fotos do celular chegam com 3–6 MB. Reduzimos no próprio aparelho (lado maior 1600 px, JPEG ~82%)
// antes de enviar: o upload fica ~10x menor e não estoura o tempo em rede móvel. Outros arquivos vão como estão.
async function reduzirImagem(f: File): Promise<File> {
  try {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(f.type) || f.size < 600 * 1024) return f;
    const bmp = await (window as any).createImageBitmap(f, { imageOrientation: "from-image" });
    const max = 1600;
    const esc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * esc), h = Math.round(bmp.height * esc);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d"); if (!ctx) return f;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob: Blob | null = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.82));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg", { type: "image/jpeg", lastModified: Date.now() });
  } catch { return f; }
}
function tamanhoFmt(n?: number | null) {
  if (!n) return "";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
const MAX_MB = 15;

// Seletor de anexos: arquivo (qualquer tipo) ou foto pela câmera. Nunca obrigatório.
function Anexador({ arquivos, setArquivos, compacto }: { arquivos: File[]; setArquivos: (f: File[]) => void; compacto?: boolean }) {
  const { toast } = useToast();
  const refArq = useRef<HTMLInputElement>(null);
  const refCam = useRef<HTMLInputElement>(null);
  const [preparando, setPreparando] = useState(false);
  const add = async (lista: FileList | null) => {
    if (!lista) return;
    setPreparando(true);
    const novos = await Promise.all(Array.from(lista).map(reduzirImagem));
    setPreparando(false);
    const grandes = novos.filter((f) => f.size > MAX_MB * 1024 * 1024);
    if (grandes.length) toast({ title: `Arquivo acima de ${MAX_MB} MB não enviado`, description: grandes.map((f) => f.name).join(", "), variant: "destructive" });
    const total = [...arquivos, ...novos.filter((f) => f.size <= MAX_MB * 1024 * 1024)].slice(0, 10);
    setArquivos(total);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" onClick={() => refArq.current?.click()} className="h-9 px-3 rounded-lg border bg-white text-sm font-medium text-gray-700 hover:bg-gray-50" data-testid="button-anexar">
          <i className="fas fa-paperclip mr-1.5" aria-hidden="true"></i>Anexar arquivo
        </button>
        <button type="button" onClick={() => refCam.current?.click()} className="h-9 px-3 rounded-lg border bg-white text-sm font-medium text-gray-700 hover:bg-gray-50" data-testid="button-camera">
          <i className="fas fa-camera mr-1.5" aria-hidden="true"></i>Câmera
        </button>
        {preparando && <span className="text-xs text-gray-600">Preparando foto…</span>}
        {!compacto && !preparando && <span className="text-xs text-gray-500">Opcional · fotos, PDF, planilhas… até {MAX_MB} MB cada</span>}
        <input ref={refArq} type="file" multiple className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        <input ref={refCam} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>
      {arquivos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {arquivos.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 max-w-full pl-2.5 pr-1 h-8 rounded-full bg-gray-100 border text-xs text-gray-800">
              <i className={`fas ${f.type.startsWith("image/") ? "fa-image" : "fa-file"} text-gray-500`} aria-hidden="true"></i>
              <span className="truncate max-w-[180px]">{f.name}</span>
              <span className="text-gray-500">{tamanhoFmt(f.size)}</span>
              <button type="button" aria-label={`Remover ${f.name}`} onClick={() => setArquivos(arquivos.filter((_, j) => j !== i))} className="w-6 h-6 rounded-full hover:bg-gray-200 text-gray-600">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Celular/tablet (tela de toque sem mouse): o Enter do teclado quebra a linha e só o botão envia.
const ehToque = () => { try { return window.matchMedia("(hover: none) and (pointer: coarse)").matches; } catch { return false; } };

// Caixa de mensagem: no computador Enter envia e Alt+Enter (ou Shift+Enter) quebra a linha;
// no celular o Enter quebra a linha (comportamento normal do teclado) e envia-se pelo botão.
function CaixaTexto({ id, valor, setValor, onEnviar, placeholder, className }: { id: string; valor: string; setValor: (v: string) => void; onEnviar: () => void; placeholder?: string; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <textarea id={id} ref={ref} value={valor} rows={3} placeholder={placeholder} enterKeyHint={ehToque() ? "enter" : "send"}
      className={className || "px-3 py-2 border rounded-lg text-sm resize-none"}
      onChange={(e) => setValor(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || (e.nativeEvent as any).isComposing) return;
        if (ehToque()) return; // celular: Enter quebra a linha
        if (e.altKey || e.shiftKey) {
          e.preventDefault();
          const el = ref.current; if (!el) return;
          const ini = el.selectionStart ?? valor.length, fim = el.selectionEnd ?? valor.length;
          const novo = valor.slice(0, ini) + "\n" + valor.slice(fim);
          setValor(novo);
          requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = ini + 1; });
          return;
        }
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        onEnviar();
      }} />
  );
}

function ListaAnexos({ anexos, escuro }: { anexos: Anexo[]; escuro?: boolean }) {
  if (!anexos?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-1">
      {anexos.map((a) => {
        const url = `/api/chamados/anexos/${a.id}`;
        if ((a.mime || "").startsWith("image/")) {
          return (
            <a key={a.id} href={url} target="_blank" rel="noreferrer" title={a.nome} className="block">
              <img src={url} alt={a.nome} loading="lazy" className="w-28 h-28 object-cover rounded-lg border bg-white" />
            </a>
          );
        }
        return (
          <a key={a.id} href={url} target="_blank" rel="noreferrer"
            className={`inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-xs font-medium max-w-full ${escuro ? "bg-white/15 border-white/30 text-white" : "bg-white text-gray-800"}`}>
            <i className={`fas ${(a.mime || "").includes("pdf") ? "fa-file-pdf" : "fa-file"}`} aria-hidden="true"></i>
            <span className="truncate max-w-[200px]">{a.nome}</span>
            <span className="opacity-70">{tamanhoFmt(a.tamanho)}</span>
          </a>
        );
      })}
    </div>
  );
}

// O banco grava "timestamp" sem fuso (em UTC) e o driver devolve o texto cru,
// ex.: "2026-10-22 14:23:05.1". Sem o "Z" o navegador lia como hora local e
// mostrava 3h a mais. Aqui tratamos como UTC e exibimos no horário de Brasília.
function paraData(v: string) {
  const t = String(v || "").trim();
  if (!t) return new Date(NaN);
  if (/[zZ]$|[+-]\d\d(:?\d\d)?$/.test(t)) return new Date(t.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return new Date(t.replace(" ", "T") + "Z");
}
// Tamanho ajustável pelo usuário de computador (arrastando), lembrado no navegador.
function useTamanho(chave: string): [number | null, (v: number | null) => void] {
  const [v, setV] = useState<number | null>(() => {
    try { const n = Number(localStorage.getItem(chave)); return n > 0 ? n : null; } catch { return null; }
  });
  const set = (n: number | null) => {
    setV(n);
    try { n ? localStorage.setItem(chave, String(Math.round(n))) : localStorage.removeItem(chave); } catch {}
  };
  return [v, set];
}

// Alça de arrasto (só aparece em telas de computador). dir "x" = largura, "y" = altura.
// Duplo clique volta ao tamanho padrão.
function Puxador({ dir, alvo, setValor, min, max, rotulo }: {
  dir: "x" | "y"; alvo: React.RefObject<HTMLElement>; setValor: (v: number | null) => void; min: number; max: () => number; rotulo: string;
}) {
  const inicio = (e: React.PointerEvent) => {
    const el = alvo.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const base = dir === "x" ? r.width : r.height;
    const p0 = dir === "x" ? e.clientX : e.clientY;
    const mover = (ev: PointerEvent) => {
      const d = (dir === "x" ? ev.clientX : ev.clientY) - p0;
      setValor(Math.max(min, Math.min(max(), base + d)));
    };
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = dir === "x" ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
  };
  return dir === "x" ? (
    <div role="separator" aria-orientation="vertical" aria-label={rotulo} title={`${rotulo} — arraste (duplo clique: tamanho padrão)`}
      onPointerDown={inicio} onDoubleClick={() => setValor(null)}
      className="hidden lg:flex self-stretch w-4 -mx-2 cursor-col-resize items-center justify-center group flex-shrink-0">
      <span className="w-1 h-12 rounded-full bg-gray-300 group-hover:bg-green-600 transition-colors" />
    </div>
  ) : (
    <div role="separator" aria-orientation="horizontal" aria-label={rotulo} title={`${rotulo} — arraste (duplo clique: tamanho padrão)`}
      onPointerDown={inicio} onDoubleClick={() => setValor(null)}
      className="hidden lg:flex h-3 cursor-row-resize items-center justify-center group border-t bg-white rounded-b-xl">
      <span className="h-1 w-12 rounded-full bg-gray-300 group-hover:bg-green-600 transition-colors" />
    </div>
  );
}

function diaBrasilia(iso: string) {
  try { return paraData(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); } catch { return ""; }
}
function dataHora(iso: string) {
  try {
    return paraData(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

export default function Chamados() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const idUrl = useMemo(() => new URLSearchParams(window.location.search).get("id"), []);
  const [caixa, setCaixa] = useState<string>("tudo");
  const [busca, setBusca] = useState("");
  const [statusSel, setStatusSel] = useState<string[]>([]); // vazio = todos
  const [statusAberto, setStatusAberto] = useState(false);
  const [dataDe, setDataDe] = useState("");
  const [dataAte, setDataAte] = useState("");
  // Ordem padrão: mais antigos em cima, os novos entram embaixo (A-Z). Seletor discreto troca.
  const [ordem, setOrdem] = useState<"asc" | "desc">(() => {
    try { return localStorage.getItem("chamados-ordem") === "desc" ? "desc" : "asc"; } catch { return "asc"; }
  });
  const listaRef = useRef<HTMLDivElement>(null);
  const painelRef = useRef<HTMLDivElement>(null);
  const [larguraLista, setLarguraLista] = useTamanho("chamados-largura-lista");
  const [alturaLista, setAlturaLista] = useTamanho("chamados-altura-lista");
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem("chamados-ordem", ordem); } catch {} }, [ordem]);
  useEffect(() => {
    if (!statusAberto) return;
    const fora = (e: MouseEvent) => { if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusAberto(false); };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [statusAberto]);
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
  const q = busca.trim().toLowerCase();
  const pedeEncerrado = statusSel.some(encerrado);
  const lista = todos
    .filter((c) => {
      // Arquivo: solucionados saem das outras abas, mas continuam aparecendo na busca
      // (ou quando "Solucionado" é marcado no filtro de status).
      if (caixa === "arquivados") return encerrado(c.status);
      if (encerrado(c.status) && !q && !pedeEncerrado) return false;
      return true;
    })
    .filter((c) => {
      if (caixa === "meus") return c.autorId === uid;
      if (caixa === "recebidos") return c.papel === "dono";
      if (caixa === "consultas") return c.papel === "consultado";
      return true;
    })
    .filter((c) => statusSel.length === 0 || statusSel.includes(c.status) || (caixa === "arquivados" && !statusSel.some(encerrado)))
    .filter((c) => {
      if (!dataDe && !dataAte) return true;
      const d = diaBrasilia(c.createdAt);
      if (dataDe && d < dataDe) return false;
      if (dataAte && d > dataAte) return false;
      return true;
    })
    .filter((c) => {
      if (!q) return true;
      return (c.codigo + " " + c.assunto + " " + c.autorNome + " " + c.destinoNome + " " + (c.descricao || "")).toLowerCase().includes(q);
    })
    .sort((a, b) => (ordem === "asc" ? a.numero - b.numero : b.numero - a.numero));
  const qtdArquivados = todos.filter((c) => encerrado(c.status)).length;
  const filtrosAtivos = statusSel.length > 0 || !!dataDe || !!dataAte;

  // Em ordem crescente os novos ficam embaixo: ao abrir/trocar aba ou ordem, rola até o fim.
  const chaveRolagem = `${caixa}|${ordem}|${listaQ.dataUpdatedAt ? 1 : 0}`;
  useEffect(() => {
    const el = listaRef.current;
    if (!el) return;
    el.scrollTop = ordem === "asc" ? el.scrollHeight : 0;
  }, [chaveRolagem]); // eslint-disable-line react-hooks/exhaustive-deps

  const abas: [string, string, number][] = [
    ["tudo", "Todos os meus", contagem.tudo],
    ["meus", "Abertos por mim", contagem.meus],
  ];
  if (atendeAlgum) abas.push(["recebidos", "Recebidos", contagem.recebidos]);
  if (atendeAlgum || todos.some((c) => c.papel === "consultado")) abas.push(["consultas", "Consultas para mim", contagem.consultas]);
  abas.push(["arquivados", `Arquivados${qtdArquivados ? ` (${qtdArquivados})` : ""}`, 0]);
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
          <div ref={painelRef} style={{ ["--lw" as any]: `${larguraLista || 420}px` }}
            className={`w-full lg:w-[var(--lw)] lg:flex-shrink-0 bg-white border rounded-xl ${selId ? "hidden lg:block" : ""}`}>
            <div className="p-3 border-b flex flex-col gap-2">
              <label htmlFor="busca-chamado" className="sr-only">Buscar chamado</label>
              <input id="busca-chamado" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nº, assunto ou pessoa (inclui arquivados)"
                className="w-full h-10 px-3 border rounded-lg text-sm" />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <div className="relative" ref={statusRef}>
                  <button type="button" onClick={() => setStatusAberto((v) => !v)} data-testid="filtro-status" aria-expanded={statusAberto}
                    
                    className={`h-9 px-3 border rounded-lg bg-white disabled:opacity-50 ${statusSel.length ? "border-green-700 text-green-800 font-semibold" : "text-gray-700"}`}>
                    {statusSel.length === 0 ? "Status: todos" : statusSel.length === 1 ? `Status: ${STATUS[statusSel[0]]?.label}` : `Status: ${statusSel.length} selecionados`} ▾
                  </button>
                  {statusAberto && (
                    <div className="absolute z-30 mt-1 w-56 bg-white border rounded-lg shadow-lg p-2 flex flex-col">
                      {Object.entries(STATUS).map(([k, v]) => (
                        <label key={k} className="flex items-center gap-2 px-2 py-2 rounded hover:bg-gray-50 cursor-pointer">
                          <input type="checkbox" className="w-4 h-4" checked={statusSel.includes(k)}
                            onChange={(e) => setStatusSel((cur) => e.target.checked ? [...cur, k] : cur.filter((x) => x !== k))} />
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${v.cls}`}>{v.label}</span>
                        </label>
                      ))}
                      <div className="flex justify-between border-t mt-1 pt-2 px-1">
                        <button type="button" className="text-xs text-gray-600 underline" onClick={() => setStatusSel([])}>Limpar</button>
                        <button type="button" className="text-xs text-gray-600 underline" onClick={() => setStatusSel(["novo", "em_atendimento", "respondido", "reaberto"])}>Só em aberto</button>
                      </div>
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-1 text-gray-600">De
                  <input type="date" value={dataDe} max={dataAte || undefined} onChange={(e) => setDataDe(e.target.value)} data-testid="filtro-data-de"
                    className={`h-9 px-2 border rounded-lg bg-white ${dataDe ? "border-green-700" : ""}`} />
                </label>
                <label className="flex items-center gap-1 text-gray-600">até
                  <input type="date" value={dataAte} min={dataDe || undefined} onChange={(e) => setDataAte(e.target.value)} data-testid="filtro-data-ate"
                    className={`h-9 px-2 border rounded-lg bg-white ${dataAte ? "border-green-700" : ""}`} />
                </label>
                {filtrosAtivos && (
                  <button type="button" className="text-xs text-gray-600 underline" onClick={() => { setStatusSel([]); setDataDe(""); setDataAte(""); }}>Limpar filtros</button>
                )}
              </div>
            </div>
            <div className="px-4 py-1.5 border-b flex justify-between items-center text-xs text-gray-500">
              <span>{lista.length} chamado{lista.length === 1 ? "" : "s"}</span>
              <button type="button" onClick={() => setOrdem((o) => (o === "asc" ? "desc" : "asc"))} data-testid="ordem-lista"
                title="Trocar a ordem da lista" className="hover:text-gray-800">
                {ordem === "asc" ? "A-Z · antigos primeiro ↓" : "Z-A · recentes primeiro ↑"}
              </button>
            </div>
            <div ref={listaRef} style={{ ["--lh" as any]: alturaLista ? `${alturaLista}px` : "70vh" }}
              className="max-h-[70vh] lg:max-h-[var(--lh)] overflow-y-auto">
              {listaQ.isLoading && <div className="p-6 text-center text-gray-500 text-sm">Carregando…</div>}
              {!listaQ.isLoading && lista.length === 0 && (
                <div className="p-8 text-center text-gray-500 text-sm">{filtrosAtivos || q ? "Nenhum chamado com esses filtros." : caixa === "arquivados" ? "Nenhum chamado solucionado ou cancelado ainda." : "Nenhum chamado aqui. Toque em “Abrir chamado” para criar um."}</div>
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
            <Puxador dir="y" alvo={listaRef} setValor={setAlturaLista} min={160} max={() => window.innerHeight * 3} rotulo="Altura da lista" />
          </div>

          <Puxador dir="x" alvo={painelRef} setValor={setLarguraLista} min={320} max={() => Math.max(340, window.innerWidth - 560)} rotulo="Largura da lista" />

          <div className={`w-full flex-1 min-w-0 ${selId ? "" : "hidden lg:block"}`}>
            {selId
              ? <Detalhe id={selId} perfil={perfil} onVoltar={() => setSelId(null)} onMudou={refresh} />
              : <div className="bg-white border rounded-xl p-10 text-center text-gray-500">Selecione um chamado na lista</div>}
          </div>
        </div>
      </div>

      {novoAberto && perfil && (
        <NovoChamado perfil={perfil} enviando={enviando} onFechar={() => setNovoAberto(false)}
          onEnviar={async (body, arquivos) => {
            setEnviando(true);
            try {
              const r = await postForm("/api/chamados", body, arquivos);
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

function NovoChamado({ perfil, enviando, onFechar, onEnviar }: { perfil: Perfil; enviando: boolean; onFechar: () => void; onEnviar: (b: any, arquivos: File[]) => void }) {
  const [arquivos, setArquivos] = useState<File[]>([]);
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
          <span className="text-sm font-semibold">Anexos</span>
          <Anexador arquivos={arquivos} setArquivos={setArquivos} />
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
          onClick={() => onEnviar({ destinoKey, assunto, descricao, prioridade }, arquivos)} data-testid="button-enviar-chamado">
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
  const [arquivos, setArquivos] = useState<File[]>([]);
  const fimRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);
  const [alturaMsgs, setAlturaMsgs] = useTamanho("chamados-altura-mensagens");
  useEffect(() => { setTexto(""); setAlvo(""); setModo("responder"); setArquivos([]); }, [id]);
  useEffect(() => { fimRef.current?.scrollIntoView({ block: "nearest" }); }, [q.data?.mensagens?.length]);
  useEffect(() => { if (q.data) onMudou(); /* atualiza o "não lido" da lista */ /* eslint-disable-next-line */ }, [q.dataUpdatedAt]);

  if (q.isLoading) return <div className="bg-white border rounded-xl p-10 text-center text-gray-500">Carregando…</div>;
  if (q.error || !q.data) return <div className="bg-white border rounded-xl p-10 text-center text-red-700">{(q.error as any)?.message || "Chamado não encontrado"}</div>;
  const c = q.data.chamado;
  const st = STATUS[c.status] || STATUS.novo;
  const destLabel = (k: string | null) => perfil?.destinos.find((d) => d.key === k)?.nome || k || "";

  const temConteudo = !!texto.trim() || arquivos.length > 0;
  const acao = async (url: string, body: any, okMsg: string, opts?: { exigeConteudo?: boolean }) => {
    if (busy) return;
    if (opts?.exigeConteudo !== false && !temConteudo) return;
    setBusy(true);
    try { await postForm(url, body, arquivos); toast({ title: okMsg }); setTexto(""); setAlvo(""); setArquivos([]); await q.refetch(); onMudou(); }
    catch (e: any) { toast({ title: "Não foi possível", description: e.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const ehDono = c.papel === "dono" || (c.papel === "admin" && perfil?.admin);
  const minhaConsultaPendente = c.papel === "consultado" && !encerrado(c.status);
  const fechado = encerrado(c.status);
  const cancelado = c.status === "cancelado";
  const dicaTeclas = ehToque() ? null : <span className="text-[11px] text-gray-500">Enter envia · Alt+Enter quebra a linha</span>;

  return (
    <div className="bg-white border rounded-xl flex flex-col">
      {/* Cabeçalho do chamado congelado: fica visível (logo abaixo do topo do Integra) ao rolar a conversa */}
      <div className="sticky top-14 z-20 bg-white rounded-t-xl shadow-[0_1px_0_0_#e5e7eb] p-4 border-b flex flex-col gap-2">
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

      <div ref={msgsRef} style={{ ["--mh" as any]: alturaMsgs ? `${alturaMsgs}px` : "50vh" }}
        className="p-4 flex flex-col gap-3 bg-gray-50 max-h-[50vh] lg:max-h-[var(--mh)] overflow-y-auto">
        {q.data.mensagens.map((m) => m.tipo === "sistema" ? (
          <span key={m.id} className="self-center text-center text-xs text-gray-600 bg-gray-200/70 px-3 py-1 rounded-full">{m.texto} · {dataHora(m.createdAt)}</span>
        ) : (
          <div key={m.id} className={`max-w-[85%] sm:max-w-[72%] rounded-xl px-3.5 py-2.5 flex flex-col gap-1 ${m.minha ? "self-end" : "self-start"} ${m.tipo === "interna" ? (m.minha ? "bg-purple-800 text-white" : "bg-purple-50 border border-dashed border-purple-400 text-gray-900") : (m.minha ? "bg-green-700 text-white" : "bg-white border text-gray-900")}`}>
            <span className="text-xs font-bold opacity-90">{m.tipo === "interna" ? `Interno · ${destLabel(m.deKey)} → ${destLabel(m.paraKey)}` : m.autorNome}</span>
            {m.texto !== "(anexo)" && <span className="text-sm leading-relaxed whitespace-pre-line">{m.texto}</span>}
            <ListaAnexos anexos={m.anexos || []} escuro={m.minha} />
            <span className="text-[11px] opacity-75 self-end">{dataHora(m.createdAt)}</span>
          </div>
        ))}
        <div ref={fimRef} />
      </div>
      <Puxador dir="y" alvo={msgsRef} setValor={setAlturaMsgs} min={160} max={() => window.innerHeight * 3} rotulo="Altura da conversa" />

      {c.papel === "autor" && !fechado && (
        <div className="p-4 border-t flex flex-col gap-2">
          <label htmlFor="ch-comp" className="text-sm font-semibold">Complementar o chamado</label>
          <CaixaTexto id="ch-comp" valor={texto} setValor={setTexto} placeholder="Mais informação para o responsável…"
            onEnviar={() => acao(`/api/chamados/${c.id}/complementar`, { texto }, "Mensagem enviada")} />
          <div className="flex flex-wrap justify-between items-center gap-2">
            <Anexador arquivos={arquivos} setArquivos={setArquivos} compacto />
            <div className="flex items-center gap-3">
              {dicaTeclas}
              <Button disabled={busy || !temConteudo} className="h-11 bg-green-700 hover:bg-green-800 text-white"
                onClick={() => acao(`/api/chamados/${c.id}/complementar`, { texto }, "Mensagem enviada")}>Enviar</Button>
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <button type="button" disabled={busy} data-testid="button-cancelar"
              className="text-sm text-red-700 hover:text-red-800 underline underline-offset-2 disabled:opacity-50"
              onClick={() => {
                if (window.confirm(`Cancelar o chamado ${c.codigo}?\n${texto.trim() ? "O texto digitado vai junto como motivo.\n" : ""}O responsável será avisado e você poderá reabrir depois, se precisar.`))
                  acao(`/api/chamados/${c.id}/cancelar`, { texto }, "Chamado cancelado", { exigeConteudo: false });
              }}>
              <i className="fas fa-ban mr-1" aria-hidden="true"></i>Cancelar chamado</button>
          </div>
        </div>
      )}

      {fechado && (
        <div className="p-4 border-t bg-gray-50 flex flex-col gap-2">
          {cancelado ? (
            <span className="text-sm text-gray-700"><i className="fas fa-ban text-red-700 mr-1.5" aria-hidden="true"></i>
              Chamado <b>cancelado</b> por quem abriu{c.canceladoEm ? ` em ${dataHora(c.canceladoEm)}` : ""}.
              {c.papel === "autor" ? " Se ainda precisar, você pode reabrir." : ""}</span>
          ) : (
            <span className="text-sm text-gray-700"><i className="fas fa-check-circle text-green-700 mr-1.5" aria-hidden="true"></i>
              Chamado finalizado como <b>solucionado</b>{c.solucionadoEm ? ` em ${dataHora(c.solucionadoEm)}` : ""}.
              {c.papel === "autor" ? " Se o problema voltou ou não foi resolvido, você pode reabrir." : ""}</span>
          )}
          {c.papel === "autor" && (
            <>
              <label htmlFor="ch-reab" className="text-sm font-semibold">Motivo da reabertura (opcional)</label>
              <CaixaTexto id="ch-reab" valor={texto} setValor={setTexto} placeholder="O que ainda falta resolver…"
                onEnviar={() => acao(`/api/chamados/${c.id}/reabrir`, { texto }, "Chamado reaberto", { exigeConteudo: false })} />
              <div className="flex flex-wrap justify-between items-center gap-2">
                <Anexador arquivos={arquivos} setArquivos={setArquivos} compacto />
                <Button disabled={busy} className="h-11 bg-amber-600 hover:bg-amber-700 text-white" data-testid="button-reabrir"
                  onClick={() => acao(`/api/chamados/${c.id}/reabrir`, { texto }, "Chamado reaberto", { exigeConteudo: false })}>
                  <i className="fas fa-rotate-left mr-1.5" aria-hidden="true"></i>Reabrir chamado</Button>
              </div>
            </>
          )}
        </div>
      )}

      {ehDono && c.status === "novo" && (
        <div className="p-4 border-t bg-orange-50 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-orange-900">Este chamado ainda não foi recebido. Ao receber, o solicitante vê “Em atendimento”.</span>
          <Button disabled={busy} className="h-11 bg-orange-700 hover:bg-orange-800 text-white" data-testid="button-receber"
            onClick={() => acao(`/api/chamados/${c.id}/receber`, {}, "Chamado recebido", { exigeConteudo: false })}>Receber chamado</Button>
        </div>
      )}

      {ehDono && c.status !== "novo" && !fechado && (
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
              <CaixaTexto id="ch-resp" valor={texto} setValor={setTexto} placeholder="Escreva a solução ou o encaminhamento…"
                onEnviar={() => acao(`/api/chamados/${c.id}/responder`, { texto }, "Resposta enviada e solicitante avisado")} />
              <Anexador arquivos={arquivos} setArquivos={setArquivos} compacto />
              <span className={`text-xs ${c.aguardando.length ? "text-purple-800 font-semibold" : "text-gray-500"}`}>
                {c.aguardando.length ? `Atenção: ainda aguardando retorno de ${c.aguardando.join(", ")}.` : "“Responder” mantém o chamado aberto. “Responder e finalizar” fecha como solucionado. O solicitante é avisado no celular nos dois casos."}
              </span>
              <div className="flex flex-wrap justify-end items-center gap-2">
                {dicaTeclas}
                <Button disabled={busy || !temConteudo} variant="outline" className="h-11 border-green-700 text-green-800" data-testid="button-responder"
                  onClick={() => acao(`/api/chamados/${c.id}/responder`, { texto }, "Resposta enviada e solicitante avisado")}>Responder</Button>
                <Button disabled={busy} className="h-11 bg-green-700 hover:bg-green-800 text-white" data-testid="button-finalizar"
                  onClick={() => { if (window.confirm(`Finalizar o chamado ${c.codigo} como SOLUCIONADO?\nO solicitante poderá reabrir se precisar.`)) acao(`/api/chamados/${c.id}/responder`, { texto, finalizar: true }, "Chamado finalizado como solucionado", { exigeConteudo: false }); }}>
                  <i className="fas fa-check-circle mr-1.5" aria-hidden="true"></i>Responder e finalizar</Button>
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
              <CaixaTexto id="ch-cons" valor={texto} setValor={setTexto} placeholder="Ex.: tem produção de 900 ml para entregar quinta?"
                onEnviar={() => { if (alvo) acao(`/api/chamados/${c.id}/consultar`, { destinoKey: alvo, texto }, "Consulta enviada"); else toast({ title: "Escolha o setor a consultar" }); }} />
              <Anexador arquivos={arquivos} setArquivos={setArquivos} compacto />
              <div className="flex flex-wrap justify-between items-center gap-2">
                <span className="text-xs text-purple-800">Conversa interna — o solicitante só vê que o chamado foi encaminhado.</span>
                <div className="flex items-center gap-3">
                  {dicaTeclas}
                  <Button disabled={busy || !temConteudo || !alvo} className="h-11 bg-purple-800 hover:bg-purple-900 text-white"
                    onClick={() => acao(`/api/chamados/${c.id}/consultar`, { destinoKey: alvo, texto }, "Consulta enviada")}>Enviar consulta</Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {minhaConsultaPendente && (
        <div className="p-4 border-t bg-purple-50 flex flex-col gap-2">
          <span className="text-sm text-purple-900"><b>{c.destinoNome}</b> pediu sua ajuda neste chamado. Seu retorno vai para {c.destinoNome}, não para o solicitante.</span>
          <label htmlFor="ch-ret" className="text-sm font-semibold">Retorno para {c.destinoNome}</label>
          <CaixaTexto id="ch-ret" valor={texto} setValor={setTexto} placeholder="Escreva a informação pedida…"
            className="px-3 py-2 border border-purple-300 rounded-lg text-sm resize-none bg-white"
            onEnviar={() => acao(`/api/chamados/${c.id}/retorno`, { texto }, `Retorno enviado para ${c.destinoNome}`)} />
          <div className="flex flex-wrap justify-between items-center gap-2">
            <Anexador arquivos={arquivos} setArquivos={setArquivos} compacto />
            <div className="flex items-center gap-3">
              {dicaTeclas}
              <Button disabled={busy || !temConteudo} className="h-11 bg-purple-800 hover:bg-purple-900 text-white" data-testid="button-retorno"
                onClick={() => acao(`/api/chamados/${c.id}/retorno`, { texto }, `Retorno enviado para ${c.destinoNome}`)}>Enviar retorno para {c.destinoNome}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
