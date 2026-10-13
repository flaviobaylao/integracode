import { useState, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  MapPin, Navigation, Loader2, ArrowLeft, Phone, User, Crosshair,
  Store, Target, XCircle, Ban, HelpCircle, RefreshCw, Plus, Check, Camera, Search, X,
  MessageCircle, Receipt,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import HistoricoOcorrencias from "@/components/HistoricoOcorrencias";

// Último pedido implantado (Pipeline de Faturamento) — vem só nos cards de CLIENTE.
type UltimoPedido = {
  data: string | null;
  valor: number | null;
  numeroTipo: "NF" | "Pedido" | null; // faturado → NF; senão nº do pedido
  numero: string | null;
  etapa: string;
} | null;

type DadosCliente = {
  whatsapp?: string | null;        // só dígitos, com 55
  whatsConfirmado?: boolean;       // número atual confirmado pelo link do WhatsApp
  ultimoPedido?: UltimoPedido;
};

type ResultadoConsulta = DadosCliente & {
  tipo: "lead" | "cliente";
  id: string;
  nome: string;
  distancia: number;
  status: string;
  statusLabel: string;
  ativo: boolean;
  descartado: boolean;
  responsavelLabel: string;
  responsavel: string | null;
  bairro: string | null;
  cidade: string | null;
  telefone: string | null;
  contato: string | null;
  ocorrencias?: number;
  atrasado?: boolean;
  diasAtraso?: number;
  lat: number;
  lng: number;
};

type NovoPonto = {
  nome: string;
  categoria: string;
  tipo: string;
  match?: string;
  distancia: number | null;
  endereco: string;
  businessStatus: string;
  jaVisitado?: boolean;
  disponivel?: boolean; // lead de Novos Pontos liberado (sem vendedor) — qualquer vendedor pode pegar
  leadId?: string | null;
  lat: number;
  lng: number;
  placeId: string;
};

type FotoMatch = DadosCliente & {
  tipo: string;
  id?: string | null;
  nome: string;
  endereco: string;
  bairro: string;
  telefone: string;
  ativo: boolean;
  descartado?: boolean;
  ocorrencias?: number;
  atrasado?: boolean;
  diasAtraso?: number;
  score: number;
};

type Fase = "idle" | "localizando" | "buscando" | "pronto" | "erro";
type NovosFase = "idle" | "buscando" | "pronto" | "erro" | "disabled";
type FotoFase = "idle" | "lendo" | "pronto" | "erro" | "disabled";

const RAIO_PADRAO = 100;
const RAIO_INTERNO = 300; // interno (telemarketing/administrativo) consulta a região do cliente de referência em 300 m

type ClienteRef = {
  id: string;
  nome: string;
  bairro: string | null;
  cidade: string | null;
  lat: number;
  lng: number;
};

function estiloCenario(r: ResultadoConsulta) {
  if (r.tipo === "cliente") {
    return r.ativo
      ? { barra: "border-l-emerald-500", icone: <Store className="h-5 w-5 text-emerald-600" />, tag: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" }
      : { barra: "border-l-slate-400", icone: <Store className="h-5 w-5 text-slate-500" />, tag: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200" };
  }
  if (r.descartado) {
    return { barra: "border-l-gray-400", icone: <Ban className="h-5 w-5 text-gray-500" />, tag: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200" };
  }
  if (r.responsavel) {
    return { barra: "border-l-blue-500", icone: <Target className="h-5 w-5 text-blue-600" />, tag: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" };
  }
  return { barra: "border-l-amber-500", icone: <Target className="h-5 w-5 text-amber-600" />, tag: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" };
}

function estiloFoto(tipo: string, descartado?: boolean) {
  if (tipo === "cliente") return { barra: "border-l-emerald-500", icone: <Store className="h-5 w-5 text-emerald-600" />, rotulo: "Cliente ativo", tag: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" };
  if (tipo === "cliente_inativo") return { barra: "border-l-slate-400", icone: <Store className="h-5 w-5 text-slate-500" />, rotulo: "Cliente inativado", tag: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200" };
  if (descartado) return { barra: "border-l-gray-400", icone: <Ban className="h-5 w-5 text-gray-500" />, rotulo: "Lead já visitado — não convertido", tag: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200" };
  return { barra: "border-l-blue-500", icone: <Target className="h-5 w-5 text-blue-600" />, rotulo: "Lead em prospecção", tag: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" };
}

function fmtTelefone(t: string | null | undefined): string {
  let d = String(t || "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(t || "");
}

function fmtDataBR(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

const fmtBRL = (v: number | null | undefined) =>
  v == null || !isFinite(Number(v)) ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Separa o campo telefone em números válidos (com DDD). O cadastro às vezes guarda mais de um
// número no mesmo campo ("62 9999-9999 / 62 3333-3333") — cada um vira um link próprio.
function numerosTelefone(t: string | null | undefined): string[] {
  return String(t || "").split(/[\/,;|]|\s+e\s+/i)
    .map((p) => { let d = p.replace(/\D/g, ""); if (d.startsWith("55") && d.length >= 12) d = d.slice(2); return d; })
    .filter((d) => d.length === 10 || d.length === 11);
}

// Telefone clicável: tocar ABRE A CONVERSA NO WHATSAPP com o cliente/lead (um link por número).
// Só cai para "ligar" quando o número não tem DDD (não dá para montar o link do WhatsApp).
function TelefoneWhats({ telefone, contato, confirmado }: { telefone: string; contato?: string | null; confirmado?: boolean }) {
  const nums = numerosTelefone(telefone);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {nums.length > 0 ? (
        nums.map((d) => (
          <a key={d} href={`https://wa.me/55${d}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-green-700 dark:text-green-400 font-medium hover:underline" data-testid="link-whatsapp">
            <MessageCircle className="h-3.5 w-3.5" /> {fmtTelefone(d)}
          </a>
        ))
      ) : (
        <a href={`tel:${String(telefone).replace(/\D/g, "")}`} className="inline-flex items-center gap-1.5 text-blue-600 hover:underline"><Phone className="h-3.5 w-3.5" /> {telefone}</a>
      )}
      {confirmado && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">✓ confirmado</span>}
      {contato && <span className="text-muted-foreground">· {contato}</span>}
      {nums.length > 0 && <a href={`tel:${nums[0]}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline" aria-label="Ligar"><Phone className="h-3 w-3" /> ligar</a>}
    </div>
  );
}

// Bloco do card de CLIENTE: WhatsApp (abre a conversa) + último pedido implantado (data, valor, nº/NF).
function InfoCliente({ telefone, contato, whatsapp, whatsConfirmado, ultimoPedido }: DadosCliente & { telefone?: string | null; contato?: string | null }) {
  const p = ultimoPedido;
  return (
    <div className="space-y-1">
      {telefone ? (
        <TelefoneWhats telefone={telefone} contato={contato} confirmado={whatsConfirmado} />
      ) : (
        <div className="flex items-center gap-1.5 text-muted-foreground"><MessageCircle className="h-3.5 w-3.5" /> Sem telefone cadastrado</div>
      )}
      <div className="flex items-start gap-1.5" data-testid="ultimo-pedido-cliente">
        <Receipt className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        {p ? (
          <span>
            Último pedido: <span className="text-foreground font-medium">{fmtDataBR(p.data)}</span>
            {" · "}<span className="text-foreground font-medium">{fmtBRL(p.valor)}</span>
            {p.numero && <>{" · "}<span className="text-foreground font-medium">{p.numeroTipo === "NF" ? "NF" : "Pedido nº"} {p.numero}</span></>}
            {p.etapa && <span className="text-muted-foreground"> ({p.etapa})</span>}
          </span>
        ) : (
          <span>Nenhum pedido implantado</span>
        )}
      </div>
    </div>
  );
}

// Reduz a foto no próprio aparelho antes de enviar (OCR funciona bem com ~1600px).
async function fileParaBase64Reduzido(file: File, maxDim = 1600, quality = 0.8): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("img"));
      im.src = dataUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
    if (scale >= 1) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}

export default function ConsultaLocal() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [fase, setFase] = useState<Fase>("idle");
  const [resultados, setResultados] = useState<ResultadoConsulta[]>([]);
  const [raioUsado, setRaioUsado] = useState<number>(RAIO_PADRAO);
  const [coords, setCoords] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [erroMsg, setErroMsg] = useState<string>("");

  // ----- aba "Novos pontos" (radar de prospecção) -----
  const [aba, setAba] = useState<"integra" | "novos">("integra");
  const [novos, setNovos] = useState<NovoPonto[]>([]);
  const [novosFase, setNovosFase] = useState<NovosFase>("idle");
  const [novosMsg, setNovosMsg] = useState<string>("");
  const [novosRaio, setNovosRaio] = useState<number>(300);
  const [cadastrados, setCadastrados] = useState<Record<string, "ok" | "loading">>({});
  // Resgate de leads descartados (não convertidos) direto da consulta — chave = leadId.
  // Estados: "resgatando" → "resgatado" (habilita Gravar) → "gravando" → "gravado".
  const [resgate, setResgate] = useState<Record<string, "resgatando" | "resgatado" | "gravando" | "gravado">>({});

  // ----- interno (telemarketing/administrativo): consulta pela região de um CLIENTE DE REFERÊNCIA -----
  const isInterno = ((user as any)?.role === "telemarketing" || (user as any)?.role === "administrative");
  const [clienteBusca, setClienteBusca] = useState<string>("");
  const [clienteResultados, setClienteResultados] = useState<ClienteRef[]>([]);
  const [clienteBuscando, setClienteBuscando] = useState<boolean>(false);
  const [clienteRef, setClienteRef] = useState<ClienteRef | null>(null);
  const buscaDebounce = useRef<any>(null);

  // ----- busca por foto -----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fotoFase, setFotoFase] = useState<FotoFase>("idle");
  const [fotoMsg, setFotoMsg] = useState<string>("");
  const [fotoTexto, setFotoTexto] = useState<string>("");
  const [fotoEncontrados, setFotoEncontrados] = useState<FotoMatch[]>([]);

  const buscar = useCallback(async (lat: number, lng: number, raio: number) => {
    setFase("buscando");
    try {
      const data: any = await apiRequest("POST", "/api/consulta-local", { lat, lng, raio });
      if (data && data.ok) {
        setResultados(Array.isArray(data.resultados) ? data.resultados : []);
        setRaioUsado(data.raio || raio);
        setFase("pronto");
      } else {
        setErroMsg((data && data.message) || "Não foi possível consultar agora.");
        setFase("erro");
      }
    } catch (e: any) {
      setErroMsg(String((e && e.message) || e));
      setFase("erro");
    }
  }, []);

  // Busca de clientes por nome (interno) — retorna só os que têm coordenadas.
  const buscarClientes = useCallback((termo: string) => {
    setClienteBusca(termo);
    setClienteRef(null);
    if (buscaDebounce.current) clearTimeout(buscaDebounce.current);
    const q = termo.trim();
    if (q.length < 2) { setClienteResultados([]); setClienteBuscando(false); return; }
    setClienteBuscando(true);
    buscaDebounce.current = setTimeout(async () => {
      try {
        const data: any = await apiRequest("GET", `/api/customers/busca-coord?q=${encodeURIComponent(q)}`);
        setClienteResultados(Array.isArray(data?.resultados) ? data.resultados : []);
      } catch {
        setClienteResultados([]);
      } finally {
        setClienteBuscando(false);
      }
    }, 320);
  }, []);

  const selecionarCliente = useCallback((c: ClienteRef) => {
    setClienteRef(c);
    setClienteBusca(c.nome);
    setClienteResultados([]);
  }, []);

  const consultar = useCallback(() => {
    setErroMsg("");
    setResultados([]);
    setAba("integra");
    setNovos([]);
    setNovosFase("idle");
    setCadastrados({});
    // Interno: usa as coordenadas do CLIENTE DE REFERÊNCIA (raio 300 m), sem GPS do aparelho.
    if (isInterno) {
      if (!clienteRef) {
        setErroMsg("Escolha um cliente de referência para consultar a região dele.");
        setFase("erro");
        return;
      }
      setCoords({ lat: clienteRef.lat, lng: clienteRef.lng, acc: 0 });
      buscar(clienteRef.lat, clienteRef.lng, RAIO_INTERNO);
      return;
    }
    if (!("geolocation" in navigator)) {
      setErroMsg("Este aparelho não permite usar a localização.");
      setFase("erro");
      return;
    }
    setFase("localizando");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setCoords({ lat: latitude, lng: longitude, acc: Math.round(accuracy || 0) });
        buscar(latitude, longitude, RAIO_PADRAO);
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "Permissão de localização negada. Toque no cadeado da barra de endereço e permita a localização para este site."
            : err.code === err.POSITION_UNAVAILABLE
            ? "Não foi possível obter sua localização. Verifique o GPS e tente novamente."
            : "Tempo esgotado ao obter a localização. Tente novamente.";
        setErroMsg(msg);
        setFase("erro");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }, [buscar, isInterno, clienteRef]);

  const ampliar = useCallback(
    (raio: number) => {
      if (!coords) return;
      buscar(coords.lat, coords.lng, raio);
    },
    [coords, buscar]
  );

  const buscarNovos = useCallback(async (raio?: number) => {
    if (!coords) return;
    setNovosFase("buscando");
    setNovosMsg("");
    try {
      const payload: any = { lat: coords.lat, lng: coords.lng };
      if (raio) payload.raio = raio;
      const data: any = await apiRequest("POST", "/api/radar/nearby", payload);
      if (data && data.ok) {
        setNovos(Array.isArray(data.resultados) ? data.resultados : []);
        setNovosRaio(Number(data.raio) || raio || 300);
        setNovosFase("pronto");
      } else if (data && data.disabled) {
        setNovosFase("disabled");
        setNovosMsg(data.message || "Recurso desativado pelo administrador.");
      } else {
        setNovosFase("erro");
        setNovosMsg((data && data.message) || "Não foi possível buscar novos pontos.");
      }
    } catch (e: any) {
      setNovosFase("erro");
      setNovosMsg(String((e && e.message) || e));
    }
  }, [coords]);

  const trocarAba = useCallback((a: "integra" | "novos") => {
    setAba(a);
    if (a === "novos" && novosFase === "idle") buscarNovos();
  }, [novosFase, buscarNovos]);

  const cadastrarLead = useCallback(async (p: NovoPonto) => {
    setCadastrados((m) => ({ ...m, [p.placeId]: "loading" }));
    try {
      const payload: any = {
        fantasyName: p.nome,
        latitude: String(p.lat),
        longitude: String(p.lng),
        temperature: "cold",
        // entra na Rota do Dia (não na rota de prospecção) e já agenda o retorno
        routeType: "dia",
        status: "scheduled", // servidor agenda o próximo contato para hoje + 7 dias
        assignedTo: (user as any)?.id, // registrado no nome do vendedor logado
        origin: "radar", // regra: renova só 1 ciclo; sem atendimento após a renovação → lead é liberado
        observation: "Prospecção via radar" + (p.categoria ? ` · ${p.categoria}` : ""),
      };
      const res: any = await apiRequest("POST", "/api/leads", payload);
      if (res && (res.id || res.ok !== false)) {
        setCadastrados((m) => ({ ...m, [p.placeId]: "ok" }));
        toast({ title: "Lead registrado", description: `${p.nome} · na sua rota em 7 dias. Sem atendimento, dá p/ renovar só mais 1 vez — depois ele é liberado.` });
      } else {
        setCadastrados((m) => { const n = { ...m }; delete n[p.placeId]; return n; });
        toast({ title: "Não foi possível cadastrar", description: (res && res.message) || "", variant: "destructive" });
      }
    } catch (e: any) {
      setCadastrados((m) => { const n = { ...m }; delete n[p.placeId]; return n; });
      toast({ title: "Erro ao cadastrar", description: String((e && e.message) || e), variant: "destructive" });
    }
  }, [toast, user]);

  // Resgatar um lead descartado (não convertido): volta à condição de lead novo.
  const resgatarLead = useCallback(async (leadId: string) => {
    if (!leadId) return;
    setResgate((m) => ({ ...m, [leadId]: "resgatando" }));
    try {
      const res: any = await apiRequest("POST", `/api/leads/${leadId}/desfecho`, { acao: "resgatar" });
      if (res && res.status === "scheduled") {
        setResgate((m) => ({ ...m, [leadId]: "resgatado" }));
        toast({ title: "Lead resgatado", description: "Voltou à condição de lead novo. Agora grave como lead." });
      } else {
        setResgate((m) => { const n = { ...m }; delete n[leadId]; return n; });
        toast({ title: "Não foi possível resgatar", description: (res && res.message) || "", variant: "destructive" });
      }
    } catch (e: any) {
      setResgate((m) => { const n = { ...m }; delete n[leadId]; return n; });
      toast({ title: "Erro ao resgatar", description: String((e && e.message) || e), variant: "destructive" });
    }
  }, [toast]);

  // Gravar como Lead (após resgatar): assume no nome do vendedor e entra na rota do dia.
  const gravarLead = useCallback(async (leadId: string) => {
    if (!leadId) return;
    setResgate((m) => ({ ...m, [leadId]: "gravando" }));
    try {
      const res: any = await apiRequest("POST", `/api/leads/${leadId}/desfecho`, { acao: "gravar_lead" });
      if (res && res.status === "scheduled") {
        setResgate((m) => ({ ...m, [leadId]: "gravado" }));
        toast({ title: "Gravado como lead", description: "Entrou na sua rota do dia." });
      } else {
        setResgate((m) => ({ ...m, [leadId]: "resgatado" }));
        toast({ title: "Não foi possível gravar", description: (res && res.message) || "", variant: "destructive" });
      }
    } catch (e: any) {
      setResgate((m) => ({ ...m, [leadId]: "resgatado" }));
      toast({ title: "Erro ao gravar", description: String((e && e.message) || e), variant: "destructive" });
    }
  }, [toast]);

  const onFotoEscolhida = useCallback(async (file: File | null) => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    setFotoFase("lendo");
    setFotoMsg("");
    setFotoTexto("");
    setFotoEncontrados([]);
    try {
      const b64 = await fileParaBase64Reduzido(file);
      const data: any = await apiRequest("POST", "/api/consulta-local/foto", { imageBase64: b64 });
      if (data && data.ok) {
        setFotoTexto(String(data.texto || ""));
        setFotoEncontrados(Array.isArray(data.encontrados) ? data.encontrados : []);
        setFotoFase("pronto");
      } else if (data && data.disabled) {
        setFotoFase("disabled");
        setFotoMsg(data.message || "Busca por foto desativada pelo administrador.");
      } else {
        setFotoFase("erro");
        setFotoMsg((data && data.message) || "Não foi possível ler a foto.");
      }
    } catch (e: any) {
      setFotoFase("erro");
      setFotoMsg(String((e && e.message) || e));
    }
  }, []);

  // Bloco de ações para um lead já visitado e não convertido (Resgatar → Gravar como Lead).
  const renderResgate = (leadId: string | null | undefined) => {
    if (!leadId) return null;
    const st = resgate[leadId];
    if (st === "gravado") {
      return (
        <>
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> Na sua rota (7 dias)</span>
          <Button size="sm" variant="outline" className="border-emerald-400 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30" onClick={() => navigate("/rota-do-dia")} data-testid="button-voltar-rota">
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar para Rota
          </Button>
        </>
      );
    }
    if (st === "resgatado" || st === "gravando") {
      return (
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={st === "gravando"} onClick={() => gravarLead(leadId)} data-testid="button-gravar-lead">
          {st === "gravando" ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Gravando…</> : <><Plus className="h-4 w-4 mr-1.5" /> Gravar como Lead</>}
        </Button>
      );
    }
    return (
      <Button size="sm" variant="outline" className="border-emerald-400 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30" disabled={st === "resgatando"} onClick={() => resgatarLead(leadId)} data-testid="button-resgatar">
        {st === "resgatando" ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Resgatando…</> : <><RefreshCw className="h-4 w-4 mr-1.5" /> Resgatar</>}
      </Button>
    );
  };

  // Lead disponível (liberado, sem vendedor): "Pegar lead" → fica no nome de quem pegou, rota do dia, 7 dias.
  const renderPegar = (leadId: string | null | undefined) => {
    if (!leadId) return null;
    const st = resgate[leadId];
    if (st === "gravado") return renderResgate(leadId);
    return (
      <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={st === "gravando"} onClick={() => gravarLead(leadId)} data-testid="button-pegar-lead">
        {st === "gravando" ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Pegando…</> : <><Plus className="h-4 w-4 mr-1.5" /> Pegar lead</>}
      </Button>
    );
  };

  const carregando = fase === "localizando" || fase === "buscando";
  const primeiraLinha = (fotoTexto || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Cabeçalho */}
      <div className="sticky top-0 z-10 bg-gradient-to-r from-emerald-600 to-green-600 text-white shadow-md">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate("/")} className="p-2 -ml-2 rounded-full hover:bg-white/15 transition" aria-label="Voltar" data-testid="button-voltar">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2 font-semibold leading-tight">
              <Crosshair className="h-5 w-5" /> Consulta no local
            </div>
            <div className="text-xs text-white/80">Este ponto já está no Integra?</div>
          </div>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-5 space-y-4">
        {/* Interno (telemarketing/administrativo): escolher um CLIENTE DE REFERÊNCIA para consultar a região dele */}
        {isInterno && (
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5"><User className="h-4 w-4 text-emerald-600" /> Cliente de referência</label>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={clienteBusca}
                onChange={(e) => buscarClientes(e.target.value)}
                placeholder="Buscar cliente por nome…"
                className="w-full h-12 pl-9 pr-9 rounded-lg border bg-white dark:bg-gray-950 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                data-testid="input-cliente-ref"
              />
              {clienteBusca && (
                <button type="button" onClick={() => { setClienteBusca(""); setClienteRef(null); setClienteResultados([]); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Limpar"><X className="h-4 w-4" /></button>
              )}
              {!clienteRef && (clienteBuscando || clienteResultados.length > 0 || clienteBusca.trim().length >= 2) && (
                <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border bg-white dark:bg-gray-950 shadow-lg">
                  {clienteBuscando ? (
                    <div className="px-3 py-3 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Buscando…</div>
                  ) : clienteResultados.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-muted-foreground">Nenhum cliente com localização encontrado.</div>
                  ) : (
                    clienteResultados.map((c) => (
                      <button key={c.id} type="button" onClick={() => selecionarCliente(c)} className="w-full text-left px-3 py-2.5 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 border-b last:border-0" data-testid="option-cliente-ref">
                        <div className="font-medium text-sm leading-tight break-words">{c.nome}</div>
                        {(c.bairro || c.cidade) && <div className="text-xs text-muted-foreground">{[c.bairro, c.cidade].filter(Boolean).join(" · ")}</div>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            {clienteRef && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0" /> Região de <strong className="break-words">{clienteRef.nome}</strong> · raio {RAIO_INTERNO} m</p>
            )}
          </div>
        )}

        {/* Botão principal */}
        <Button onClick={consultar} disabled={carregando || (isInterno && !clienteRef)} className="w-full h-14 text-base bg-emerald-600 hover:bg-emerald-700" data-testid="button-consultar">
          {fase === "localizando" ? (
            <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Obtendo sua localização…</>
          ) : fase === "buscando" ? (
            <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Consultando…</>
          ) : (
            <><Navigation className="h-5 w-5 mr-2" /> {isInterno ? "Consultar região do cliente" : "Consultar este local"}</>
          )}
        </Button>

        {/* Busca por foto — só vendedor externo (em campo) */}
        {!isInterno && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => onFotoEscolhida(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
              data-testid="input-foto"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={fotoFase === "lendo"}
              variant="outline"
              className="w-full h-12 border-emerald-300 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
              data-testid="button-foto"
            >
              {fotoFase === "lendo" ? (
                <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Lendo a foto…</>
              ) : (
                <><Camera className="h-5 w-5 mr-2" /> Buscar por foto (fachada)</>
              )}
            </Button>
          </>
        )}

        {coords && fase !== "erro" && (
          <p className="text-center text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 inline mr-1" />
            {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
            {coords.acc ? ` · precisão ~${coords.acc} m` : ""}
          </p>
        )}

        {/* ======== RESULTADO DA FOTO ======== */}
        {fotoFase === "disabled" && (
          <Card className="border-l-4 border-l-slate-400"><CardContent className="py-5 text-sm text-center text-muted-foreground"><Ban className="h-7 w-7 mx-auto mb-2 text-slate-400" />{fotoMsg}</CardContent></Card>
        )}
        {fotoFase === "erro" && (
          <Card className="border-l-4 border-l-red-500"><CardContent className="py-5 text-sm space-y-3"><div className="flex items-start gap-2 text-red-600 dark:text-red-400"><XCircle className="h-5 w-5 shrink-0 mt-0.5" /><span>{fotoMsg}</span></div><Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="w-full"><Camera className="h-4 w-4 mr-2" /> Tentar outra foto</Button></CardContent></Card>
        )}
        {fotoFase === "pronto" && (
          <div className="space-y-3">
            {primeiraLinha && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Camera className="h-3.5 w-3.5" /> Lido da foto: <span className="font-medium text-foreground break-words">{primeiraLinha}</span></p>
            )}
            {fotoEncontrados.length === 0 ? (
              <Card className="border-l-4 border-l-amber-500">
                <CardContent className="py-6 text-center text-sm space-y-2">
                  <HelpCircle className="h-9 w-9 mx-auto text-amber-500" />
                  <p className="font-medium">Nenhum cadastro encontrado</p>
                  <p className="text-muted-foreground">Não achei esse nome nos leads/clientes do Integra. Pode ser um ponto novo — confira pela aba <strong>Novos pontos</strong> ou cadastre como lead.</p>
                </CardContent>
              </Card>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{fotoEncontrados.length} cadastro{fotoEncontrados.length > 1 ? "s" : ""} com esse nome no Integra</p>
                {fotoEncontrados.map((m, i) => {
                  const est = estiloFoto(m.tipo, m.descartado);
                  return (
                    <Card key={`${m.tipo}-${i}-${m.nome}`} className={`border-l-4 ${est.barra}`} data-testid="card-foto-match">
                      <CardContent className="py-4 space-y-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <div className="shrink-0 mt-0.5">{est.icone}</div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-semibold leading-tight break-words">{m.nome}</span>
                              {m.tipo === "lead" && m.id && ((m.ocorrencias || 0) > 0 || m.atrasado) && (
                                <HistoricoOcorrencias leadId={m.id} nome={m.nome} atrasado={m.atrasado} diasAtraso={m.diasAtraso} />
                              )}
                            </div>
                            <span className={`inline-block mt-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${est.tag}`}>{est.rotulo}</span>
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-1 pl-7">
                          {(m.bairro || m.endereco) && (
                            <div className="flex items-start gap-1.5"><MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span>{[m.endereco, m.bairro].filter(Boolean).join(" · ")}</span></div>
                          )}
                          {m.tipo === "cliente" || m.tipo === "cliente_inativo" ? (
                            <InfoCliente telefone={m.telefone} whatsapp={m.whatsapp} whatsConfirmado={m.whatsConfirmado} ultimoPedido={m.ultimoPedido} />
                          ) : m.telefone && (
                            <TelefoneWhats telefone={m.telefone} />
                          )}
                        </div>
                        {m.tipo === "lead" && m.descartado && m.id && (
                          <div className="pl-7 pt-1">{renderResgate(m.id)}</div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
                <p className="text-[11px] text-center text-muted-foreground pt-1">Comparação pelo nome lido na fachada. Confirme o endereço antes de concluir.</p>
              </>
            )}
          </div>
        )}

        {/* Estado inicial */}
        {fase === "idle" && (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-sm text-muted-foreground space-y-2">
              <Crosshair className="h-10 w-10 mx-auto text-emerald-500/70" />
              {isInterno ? (
                <>
                  <p>Busque um <strong>cliente de referência</strong> e toque em <strong>Consultar região do cliente</strong>.</p>
                  <p>Mostramos leads e clientes do Integra num raio de {RAIO_INTERNO} m do cliente escolhido, e em <strong>Novos pontos</strong> os potenciais leads da região.</p>
                </>
              ) : (
                <>
                  <p>Pare em frente ao estabelecimento e toque em <strong>Consultar este local</strong>.</p>
                  <p>Buscamos leads e clientes num raio de {RAIO_PADRAO} m da sua posição.</p>
                  <p className="pt-1">Ou use <strong>Buscar por foto</strong> para conferir pelo nome da fachada.</p>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Erro */}
        {fase === "erro" && (
          <Card className="border-l-4 border-l-red-500">
            <CardContent className="py-5 text-sm space-y-3">
              <div className="flex items-start gap-2 text-red-600 dark:text-red-400">
                <XCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <span>{erroMsg}</span>
              </div>
              <Button variant="outline" size="sm" onClick={consultar} className="w-full">
                <RefreshCw className="h-4 w-4 mr-2" /> Tentar de novo
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Abas (aparecem depois da consulta) */}
        {fase === "pronto" && (
          <div className="flex bg-gray-200 dark:bg-gray-800 rounded-xl p-1 gap-1">
            <button
              onClick={() => trocarAba("integra")}
              className={`flex-1 text-sm font-semibold py-2 rounded-lg transition ${aba === "integra" ? "bg-white dark:bg-gray-950 shadow text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-300"}`}
              data-testid="tab-integra"
            >
              No Integra · {resultados.length}
            </button>
            <button
              onClick={() => trocarAba("novos")}
              className={`flex-1 text-sm font-semibold py-2 rounded-lg transition ${aba === "novos" ? "bg-white dark:bg-gray-950 shadow text-amber-700 dark:text-amber-300" : "text-gray-600 dark:text-gray-300"}`}
              data-testid="tab-novos"
            >
              Novos pontos{novosFase === "pronto" ? ` · ${novos.length}` : ""}
            </button>
          </div>
        )}

        {/* ======== ABA: NO INTEGRA ======== */}
        {fase === "pronto" && aba === "integra" && (
          <>
            {resultados.length === 0 ? (
              <Card className="border-l-4 border-l-slate-400">
                <CardContent className="py-8 text-center text-sm space-y-2">
                  <HelpCircle className="h-10 w-10 mx-auto text-slate-400" />
                  <p className="font-medium">Nenhum cadastro em até {raioUsado} m</p>
                  <p className="text-muted-foreground">Este ponto não parece estar no Integra. Veja a aba <strong>Novos pontos</strong> ou amplie o raio.</p>
                  <div className="flex gap-2 justify-center pt-2">
                    {raioUsado < 300 && <Button variant="outline" size="sm" onClick={() => ampliar(300)}>Ampliar para 300 m</Button>}
                    {raioUsado < 500 && raioUsado >= 300 && <Button variant="outline" size="sm" onClick={() => ampliar(500)}>Ampliar para 500 m</Button>}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">{resultados.length} cadastro{resultados.length > 1 ? "s" : ""} em até {raioUsado} m · do mais próximo</p>
                {resultados.map((r) => {
                  const est = estiloCenario(r);
                  return (
                    <Card key={`${r.tipo}-${r.id}`} className={`border-l-4 ${est.barra}`} data-testid={`card-resultado-${r.tipo}`}>
                      <CardContent className="py-4 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 min-w-0">
                            <div className="shrink-0 mt-0.5">{est.icone}</div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-semibold leading-tight break-words">{r.nome}</span>
                                {r.tipo === "lead" && r.id && ((r.ocorrencias || 0) > 0 || r.atrasado) && (
                                  <HistoricoOcorrencias leadId={r.id} nome={r.nome} atrasado={r.atrasado} diasAtraso={r.diasAtraso} />
                                )}
                              </div>
                              <span className={`inline-block mt-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${est.tag}`}>{r.tipo === "lead" && r.descartado ? "Lead já visitado — não convertido" : r.statusLabel}</span>
                            </div>
                          </div>
                          <Badge variant="secondary" className="shrink-0 whitespace-nowrap">{r.distancia} m</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-1 pl-7">
                          <div className="flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5" />
                            <span>{r.responsavelLabel}: <span className="text-foreground font-medium">{r.responsavel || "não atribuído"}</span></span>
                          </div>
                          {(r.bairro || r.cidade) && (
                            <div className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /><span>{[r.bairro, r.cidade].filter(Boolean).join(" · ")}</span></div>
                          )}
                          {r.tipo === "cliente" ? (
                            <InfoCliente telefone={r.telefone} contato={r.contato} whatsapp={r.whatsapp} whatsConfirmado={r.whatsConfirmado} ultimoPedido={r.ultimoPedido} />
                          ) : r.telefone && (
                            <TelefoneWhats telefone={r.telefone} contato={r.contato} />
                          )}
                        </div>
                        <div className="pl-7 pt-1 flex items-center gap-3 flex-wrap">
                          {r.tipo === "lead" && r.descartado && renderResgate(r.id)}
                          <a href={`https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`} target="_blank" rel="noreferrer" className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"><Navigation className="h-3.5 w-3.5" /> Ver no mapa</a>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                {raioUsado < 500 && (
                  <div className="flex justify-center pt-1">
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => ampliar(raioUsado < 300 ? 300 : 500)}>Ampliar busca para {raioUsado < 300 ? 300 : 500} m</Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ======== ABA: NOVOS PONTOS (radar) ======== */}
        {fase === "pronto" && aba === "novos" && (
          <div className="space-y-3">
            {novosFase === "buscando" && (
              <Card><CardContent className="py-8 text-center text-sm text-muted-foreground"><Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" /> Buscando estabelecimentos por perto…</CardContent></Card>
            )}
            {novosFase === "disabled" && (
              <Card className="border-l-4 border-l-slate-400"><CardContent className="py-6 text-sm text-center text-muted-foreground"><Ban className="h-8 w-8 mx-auto mb-2 text-slate-400" />{novosMsg}</CardContent></Card>
            )}
            {novosFase === "erro" && (
              <Card className="border-l-4 border-l-red-500"><CardContent className="py-5 text-sm space-y-3"><div className="flex items-start gap-2 text-red-600 dark:text-red-400"><XCircle className="h-5 w-5 shrink-0 mt-0.5" /><span>{novosMsg}</span></div><Button variant="outline" size="sm" onClick={() => buscarNovos()} className="w-full"><RefreshCw className="h-4 w-4 mr-2" /> Tentar de novo</Button></CardContent></Card>
            )}
            {novosFase === "pronto" && novos.length === 0 && (
              <Card className="border-l-4 border-l-slate-400"><CardContent className="py-8 text-center text-sm space-y-3"><HelpCircle className="h-10 w-10 mx-auto text-slate-400" /><p className="font-medium">Nenhum ponto novo em {novosRaio} m</p><p className="text-muted-foreground">Tudo por perto já está no Integra, ou não há estabelecimentos dos segmentos buscados.</p>{novosRaio < 500 && <Button variant="outline" size="sm" onClick={() => buscarNovos(500)} className="mt-1"><Crosshair className="h-4 w-4 mr-2" /> Ampliar raio para 500 m</Button>}</CardContent></Card>
            )}
            {novosFase === "pronto" && novos.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">{novos.length} estabelecimento{novos.length > 1 ? "s" : ""} em até {novosRaio} m · ainda não cadastrado{novos.length > 1 ? "s" : ""}</p>
                {novos.map((p) => {
                  const st = cadastrados[p.placeId];
                  return (
                    <Card key={p.placeId || p.nome} className={`border-l-4 ${p.disponivel ? "border-l-blue-500" : p.jaVisitado ? "border-l-gray-400" : "border-l-amber-500"}`} data-testid="card-novo-ponto">
                      <CardContent className="py-4 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 min-w-0">
                            {p.disponivel ? <Target className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" /> : p.jaVisitado ? <Ban className="h-5 w-5 text-gray-500 shrink-0 mt-0.5" /> : <MapPin className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />}
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-semibold leading-tight break-words">{p.nome}</span>
                                {(p.jaVisitado || p.disponivel) && p.leadId && (
                                  <HistoricoOcorrencias leadId={p.leadId} nome={p.nome} />
                                )}
                              </div>
                              <div className="mt-1 flex items-center gap-2 flex-wrap">
                                {p.categoria && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{p.categoria}</span>}
                                {p.disponivel ? (
                                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">Lead disponível — sem vendedor</span>
                                ) : p.jaVisitado ? (
                                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200">Lead já visitado — não convertido</span>
                                ) : (
                                  <span className="text-[9px] font-bold tracking-wide text-white bg-amber-500 px-1.5 py-0.5 rounded-full">NOVO</span>
                                )}
                                {p.match === "secundario" && <span className="text-[9px] font-semibold text-slate-600 dark:text-slate-300 bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 rounded-full">tipo secundário</span>}
                              </div>
                            </div>
                          </div>
                          {p.distancia != null && <Badge variant="secondary" className="shrink-0 whitespace-nowrap">{p.distancia} m</Badge>}
                        </div>
                        {p.endereco && <div className="text-xs text-muted-foreground pl-7 flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{p.endereco}</div>}
                        <div className="pl-7 pt-1 flex items-center gap-3 flex-wrap">
                          {p.disponivel ? (
                            renderPegar(p.leadId)
                          ) : p.jaVisitado ? (
                            renderResgate(p.leadId)
                          ) : st === "ok" ? (
                            <>
                              <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> Na sua rota (7 dias)</span>
                              <Button size="sm" variant="outline" className="border-emerald-400 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30" onClick={() => navigate("/rota-do-dia")} data-testid="button-voltar-rota">
                                <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar para Rota
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={st === "loading"} onClick={() => cadastrarLead(p)} data-testid="button-cadastrar-lead">
                              {st === "loading" ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Registrando…</> : <><Plus className="h-4 w-4 mr-1.5" /> Registrar lead</>}
                            </Button>
                          )}
                          <a href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"><Navigation className="h-3.5 w-3.5" /> Mapa</a>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                {novosRaio < 500 && (
                  <div className="flex justify-center pt-1">
                    <Button variant="outline" size="sm" onClick={() => buscarNovos(500)} data-testid="button-ampliar-raio"><Crosshair className="h-4 w-4 mr-2" /> Ampliar raio para 500 m</Button>
                  </div>
                )}
                <p className="text-[11px] text-center text-muted-foreground pt-1">Pontos do Google Places que ainda não estão no Integra (tipo primário primeiro, depois secundário). Nome e local são aproximados — edite depois se precisar.</p>
              </>
            )}
          </div>
        )}

        {/* Legenda (só na aba Integra) */}
        {(fase === "idle" || (fase === "pronto" && aba === "integra")) && (
          <div className="pt-2 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Cliente ativo</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-400" /> Cliente inativado</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-blue-500" /> Lead em prospecção</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Lead sem atendente</span>
          </div>
        )}
      </div>
    </div>
  );
}
