// client/src/pages/Viagens.tsx
// -----------------------------------------------------------------------------
// VIAGENS COM ADIANTAMENTO (27/out/2026)
// Lista de viagens + detalhe em 4 etapas: Solicitação, Aprovação, Pagamento e
// Prestação de contas (Resumo e despesas | Km por dia). Vendedor vê só as suas;
// Admin/Adm veem todas, aprovam, pagam e encerram. Servidor: /api/viagens/*.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Paperclip, Trash2, ArrowLeft, FileText } from "lucide-react";
import { CIDADES_GO_DF_COORDS as CIDADES_GO_DF } from "@/lib/cidadesGoDfCoords";
import { PIX_TIPOS, PIX_REGRA } from "@/lib/pix";

type Viagem = {
  id: string; numero: number; codigo: string; vendedorId: string; vendedorNome: string; cidade: string; uf: string;
  dataIni: string; dataFim: string; dias: number; noites: number; idaVoltaKm: number; kmPrevisto: number; tarifa: number;
  alimDia: number; hospNoite: number; valorKm: number; valorAlim: number; valorHosp: number; valorOutros: number; valorSugerido: number; vencimento: string | null;
  valorAprovado: number | null; obs: string; status: string; aprovadorNome: string | null; motivoRecusa: string | null;
  kmReal: number | null; valorKmReal: number | null; valorDespesas: number | null; valorReal: number | null; saldo: number | null;
  createdAt: string;
  instancia: string | null; forma: string | null; favorecidoNome: string; favorecidoDoc: string; pixTipo: string; pixChave: string;
  banco: string; agencia: string; conta: string; tipoConta: string; chartAccountId: string | null; payableId: string | null; lancadoNome: string | null;
};
type Detalhe = Viagem & {
  despesas: { id: string; tipo: string; valor: number }[];
  anexos: { id: string; despesaId: string | null; categoria: string; nome: string; mime: string; tamanho: number }[];
  eventos: { autor: string; texto: string; em: string }[];
  kmDias: { dia: string; km: number }[];
  categoriaNome: string | null;
  payable: { id: string; titulo: string; status: string; valor: number; vencimento: string } | null;
};
type Cfg = { admin: boolean; financeiro: boolean; me: { id: string; nome: string; cpf: string }; vendedores: { id: string; nome: string }[]; tarifa: Record<string, number>; alimPadrao: number; hospPadrao: number;
  instancias: string[]; categorias: { id: string; code: string; name: string }[] };
const FORMA_LABEL: Record<string, string> = { pix: "PIX", transferencia: "Transferência bancária", dinheiro: "Dinheiro (Caixinha)" };
const selCls = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
const pagamentoTxt = (v: { forma: string | null; pixTipo: string; pixChave: string; banco: string; agencia: string; conta: string; tipoConta: string }) =>
  v.forma === "pix" ? `PIX${v.pixTipo ? ` (${v.pixTipo})` : ""}: ${v.pixChave}` : v.forma === "transferencia" ? `${v.banco} · ag ${v.agencia} · ${v.tipoConta || "conta"} ${v.conta}` : v.forma === "dinheiro" ? "Dinheiro (Caixinha)" : "—";

const BRL = (n: number | null | undefined) => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const KM = (n: number | null | undefined) => (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const DT = (s: string) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "—");
const STATUS: Record<string, [string, string]> = {
  aguardando: ["Aguardando aprovação", "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
  recusado: ["Recusado", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"],
  aprovado: ["No Financeiro", "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"],
  pago: ["Pago · prestação aberta", "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300"],
  prestado: ["Prestação enviada", "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"],
  encerrado: ["Encerrada", "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"],
};
const ETAPAS = ["Solicitação", "Aprovação", "Pagamento", "Prestação de contas"];
const etapaDe = (s: string) => ({ aguardando: 1, recusado: 0, aprovado: 2, pago: 3, prestado: 3, encerrado: 3 } as Record<string, number>)[s] ?? 0;
const TIPOS = ["Alimentação", "Hospedagem", "Pedágio", "Combustível", "Estacionamento", "Outros"];
const hav = (a: number, b: number, c: number, d: number) => { const R = 6371, t = (x: number) => (x * Math.PI) / 180; const p = t(c - a), q = t(d - b); return 2 * R * Math.asin(Math.sqrt(Math.sin(p / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(q / 2) ** 2)); };
const mediana = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function Pill({ status }: { status: string }) {
  const [l, c] = STATUS[status] || [status, "bg-muted"];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${c}`}>{l}</span>;
}
const Linha = ({ k, v }: { k: string; v: any }) => (
  <div className="flex justify-between gap-3 py-1.5 border-b last:border-0 text-sm"><span className="text-muted-foreground">{k}</span><span className="tabular-nums font-medium text-right">{v}</span></div>
);

async function enviarArquivos(url: string, files: FileList | File[], extra: Record<string, string> = {}) {
  const fd = new FormData();
  Array.from(files).forEach((f) => fd.append("arquivos", f));
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  const r = await fetch(url, { method: "POST", body: fd, credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || "Falha no envio");
  return r.json();
}

export default function Viagens() {
  const { toast } = useToast();
  const erro = (e: any) => toast({ title: "Não foi possível", description: e?.message || String(e), variant: "destructive" });
  const [sel, setSel] = useState<string | null>(() => new URLSearchParams(window.location.search).get("id"));
  const [nova, setNova] = useState(false);
  const { data: cfg } = useQuery<Cfg>({ queryKey: ["/api/viagens/config"], queryFn: () => apiRequest("GET", "/api/viagens/config") });
  const { data: lista = [], isLoading } = useQuery<Viagem[]>({ queryKey: ["/api/viagens"], queryFn: () => apiRequest("GET", "/api/viagens") });
  const recarregar = () => { queryClient.invalidateQueries({ queryKey: ["/api/viagens"] }); if (sel) queryClient.invalidateQueries({ queryKey: ["/api/viagens", sel] }); };

  if (nova && cfg) return <NovaViagem cfg={cfg} onCancel={() => setNova(false)} onOk={(id) => { setNova(false); setSel(id); recarregar(); }} erro={erro} />;
  if (sel && cfg) return <DetalheViagem id={sel} cfg={cfg} onBack={() => { setSel(null); window.history.replaceState(null, "", "/viagens"); }} recarregar={recarregar} erro={erro} />;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <BackToDashboardButton />
      <div className="flex items-end justify-between gap-3 flex-wrap mt-3 mb-4">
        <div>
          <h1 className="text-xl font-bold">Programação de Viagens e Outras Despesas</h1>
          <p className="text-xs text-muted-foreground">Ajuda de custo paga antes da viagem intermunicipal e prestação de contas na volta.</p>
        </div>
        <Button onClick={() => setNova(true)} disabled={!cfg}><Plus className="w-4 h-4 mr-1" /> Nova solicitação</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-6 text-sm text-muted-foreground">Carregando…</div> : lista.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">Nenhuma viagem ainda. Clique em "Nova solicitação" para pedir o adiantamento da próxima viagem.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                  <th className="text-left p-3">Viagem</th><th className="text-left p-3">Vendedor</th><th className="text-left p-3">Destino</th><th className="text-left p-3">Período</th>
                  <th className="text-right p-3">Adiantamento</th><th className="text-right p-3">Saldo</th><th className="text-left p-3">Situação</th>
                </tr></thead>
                <tbody>{lista.map((v) => (
                  <tr key={v.id} className="border-b last:border-0 hover:bg-muted/40 cursor-pointer" onClick={() => setSel(v.id)}>
                    <td className="p-3 font-semibold">{v.codigo}</td><td className="p-3">{v.vendedorNome}</td><td className="p-3">{v.cidade}-{v.uf}</td>
                    <td className="p-3 whitespace-nowrap">{DT(v.dataIni)} a {DT(v.dataFim)}</td>
                    <td className="p-3 text-right tabular-nums">{BRL(v.valorAprovado ?? v.valorSugerido)}</td>
                    <td className={`p-3 text-right tabular-nums ${v.saldo == null ? "text-muted-foreground" : v.saldo > 0 ? "text-amber-700" : v.saldo < 0 ? "text-blue-700" : ""}`}>{v.saldo == null ? "—" : (v.saldo > 0 ? "receber " : v.saldo < 0 ? "devolver " : "") + BRL(Math.abs(v.saldo))}</td>
                    <td className="p-3"><Pill status={v.status} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------- Etapa 1 -------------------------------------
function NovaViagem({ cfg, onCancel, onOk, erro }: { cfg: Cfg; onCancel: () => void; onOk: (id: string) => void; erro: (e: any) => void }) {
  const [vendedorId, setVendedorId] = useState(cfg.me.id);
  const [cidade, setCidade] = useState("");
  const hoje = new Date().toISOString().slice(0, 10);
  const [ini, setIni] = useState(hoje);
  const [fim, setFim] = useState(hoje);
  const [tarifa, setTarifa] = useState<number | null>(null);
  const [alim, setAlim] = useState(cfg.alimPadrao);
  const [hosp, setHosp] = useState(cfg.hospPadrao);
  const [outros, setOutros] = useState(0); // outras despesas (valor total), sempre 0 por padrão
  const [venc, setVenc] = useState<string | null>(null); // "pagar até": segue o início da viagem até ser alterado
  const [obs, setObs] = useState("");
  const [enviando, setEnviando] = useState(false);
  // dados para o Contas a Pagar (como no Reembolso)
  const [instancia, setInstancia] = useState("");
  const [forma, setForma] = useState("pix");
  const nomeVend = (id: string) => id === cfg.me.id ? cfg.me.nome : (cfg.vendedores.find((x) => x.id === id)?.nome || "");
  const [favNome, setFavNome] = useState(cfg.me.nome);
  const [favDoc, setFavDoc] = useState(cfg.me.cpf || "");
  const [pixTipo, setPixTipo] = useState("CPF");
  const [pixChave, setPixChave] = useState("");
  const [banco, setBanco] = useState(""); const [agencia, setAgencia] = useState(""); const [conta, setConta] = useState(""); const [tipoConta, setTipoConta] = useState("Corrente");
  const c = CIDADES_GO_DF.find((x) => x[0] === cidade);
  const { data: est } = useQuery<{ casa: { lat: number; lon: number } | null; historicoIdaVolta: number[] }>({
    queryKey: ["/api/viagens/estimativa", vendedorId, cidade],
    queryFn: () => apiRequest("GET", `/api/viagens/estimativa?vendedorId=${encodeURIComponent(vendedorId)}&cidade=${encodeURIComponent(cidade)}`),
    enabled: !!c,
  });
  useEffect(() => { setTarifa(null); }, [cidade]);
  const calc = useMemo(() => {
    if (!c) return null;
    const dias = Math.max(1, Math.round((Date.parse(fim) - Date.parse(ini)) / 864e5) + 1), noites = dias - 1;
    let idaVolta = 0, fonte = "";
    if (est?.historicoIdaVolta?.length) { idaVolta = mediana(est.historicoIdaVolta); fonte = `mediana de ${est.historicoIdaVolta.length} viagem(ns) anterior(es)`; }
    else { const base = est?.casa || { lat: -16.6864, lon: -49.2643 }; idaVolta = 2 * hav(base.lat, base.lon, c[2], c[3]) * 1.3; fonte = est?.casa ? "estimativa a partir da casa do vendedor" : "estimativa a partir de Goiânia (casa do vendedor não cadastrada)"; }
    const local = dias > 1 ? (dias - 1) * 25 : 0, km = (idaVolta + local) * 1.1;
    const t = tarifa ?? cfg.tarifa[c[1]] ?? 0.65;
    const vKm = km * t, vAl = alim * dias, vHo = hosp * noites, vOu = cfg.admin ? Math.max(0, outros) : 0;
    return { dias, noites, idaVolta, local, km, t, vKm, vAl, vHo, vOu, extras: vAl + vHo + vOu, total: vKm + vAl + vHo + vOu, fonte, uf: c[1] };
  }, [c, ini, fim, est, tarifa, alim, hosp, outros, cfg]);
  const faltando = [
    !instancia && "a empresa",
    !favNome.trim() && "o favorecido",
    forma === "pix" && !pixChave.trim() && "a chave PIX",
    forma === "pix" && !!pixChave.trim() && !PIX_REGRA[pixTipo].valido(pixChave) && `chave PIX válida (${PIX_REGRA[pixTipo].dica})`,
    forma === "transferencia" && (!banco.trim() || !agencia.trim() || !conta.trim()) && "banco, agência e conta",
  ].filter(Boolean) as string[];
  const enviar = async () => {
    if (!c || !calc) return;
    if (faltando.length) { erro(new Error("Falta informar: " + faltando.join(", "))); return; }
    setEnviando(true);
    try {
      const r: any = await apiRequest("POST", "/api/viagens", { vendedorId, cidade: c[0], uf: c[1], dataIni: ini, dataFim: fim, idaVoltaKm: calc.idaVolta, tarifa: calc.t, alimDia: alim, hospNoite: hosp, outros: calc.vOu, vencimento: venc || ini, obs,
        instancia, forma, favorecidoNome: favNome, favorecidoDoc: favDoc, pixTipo, pixChave, banco, agencia, conta, tipoConta });
      onOk(r.id);
    } catch (e) { erro(e); } finally { setEnviando(false); }
  };
  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <button className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3" onClick={onCancel}><ArrowLeft className="w-4 h-4" /> Voltar</button>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-lg">Solicitação</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <label className="grid gap-1 text-sm font-medium">Vendedor
              {cfg.admin ? (
                <select className="rounded-md border bg-background px-2 py-2 text-sm" value={vendedorId} onChange={(e) => { setVendedorId(e.target.value); setFavNome(nomeVend(e.target.value)); if (e.target.value !== cfg.me.id) setFavDoc(""); }}>
                  <option value={cfg.me.id}>{cfg.me.nome} (eu)</option>
                  {cfg.vendedores.filter((v) => v.id !== cfg.me.id).map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
                </select>
              ) : <Input value={cfg.me.nome} disabled />}
            </label>
            <label className="grid gap-1 text-sm font-medium">Destino (GO ou DF)
              <Input list="cidades-go-df" value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Digite a cidade" />
              <datalist id="cidades-go-df">{CIDADES_GO_DF.map((x) => <option key={x[0]} value={x[0]}>{x[1]}</option>)}</datalist>
            </label>
            <label className="grid gap-1 text-sm font-medium">Data de início<Input type="date" value={ini} onChange={(e) => { setIni(e.target.value); if (fim < e.target.value) setFim(e.target.value); }} /></label>
            <label className="grid gap-1 text-sm font-medium">Data de término<Input type="date" value={fim} min={ini} onChange={(e) => setFim(e.target.value < ini ? ini : e.target.value)} /></label>
          </div>
          {cidade && !c && <div className="text-sm text-amber-700">Escolha uma cidade da lista (GO ou DF).</div>}
          {calc && (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Km previsto · {calc.uf}</div>
                  <Linha k={`Ida e volta (${calc.fonte})`} v={`${KM(calc.idaVolta)} km`} />
                  <Linha k={`Rodagem local (${calc.dias > 1 ? `${calc.dias - 1} dia(s) × 25 km` : "bate-volta"})`} v={`${KM(calc.local)} km`} />
                  <Linha k="Total com +10% (regra da Rota do Dia)" v={`${KM(calc.km)} km`} />
                </div>
                <div className="grid gap-2 content-start">
                  <label className="grid gap-1 text-sm font-medium">R$ por km <span className="text-xs font-normal text-muted-foreground">{calc.uf === "DF" ? "DF: R$ 0,75" : "GO: R$ 0,65"} · {cfg.admin ? "editável pelo admin" : "definido pelo admin"}</span>
                    <Input type="number" step="0.01" value={calc.t} disabled={!cfg.admin} onChange={(e) => setTarifa(Number(e.target.value) || 0)} />
                  </label>
                  <Linha k="Km × tarifa" v={BRL(calc.vKm)} />
                  <Linha k="Período" v={`${calc.dias} dia(s) · ${calc.noites} noite(s)`} />
                </div>
              </div>
              {cfg.admin && (
                <div className="rounded-lg border border-dashed border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 p-3 grid gap-3">
                  <div className="text-[11px] uppercase tracking-wide text-amber-800 dark:text-amber-300">Só admin · alimentação, hospedagem e outras despesas</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <label className="grid gap-1 text-sm font-medium">Alimentação por dia <span className="text-xs font-normal text-muted-foreground">sugestão {BRL(cfg.alimPadrao)}</span><Input type="number" step="0.01" value={alim} onChange={(e) => setAlim(Number(e.target.value) || 0)} /></label>
                    <label className="grid gap-1 text-sm font-medium">Hospedagem por noite <span className="text-xs font-normal text-muted-foreground">sugestão {BRL(cfg.hospPadrao)}</span><Input type="number" step="0.01" value={hosp} onChange={(e) => setHosp(Number(e.target.value) || 0)} /></label>
                    <label className="grid gap-1 text-sm font-medium">Outras despesas <span className="text-xs font-normal text-muted-foreground">valor total (pedágio etc.)</span><Input type="number" step="0.01" min="0" value={outros} onChange={(e) => setOutros(Math.max(0, Number(e.target.value) || 0))} data-testid="input-outras-despesas" /></label>
                    <label className="grid gap-1 text-sm font-medium">Total <span className="text-xs font-normal text-muted-foreground">alimentação + hospedagem + outras</span><Input value={BRL(calc.extras)} disabled data-testid="total-extras" /></label>
                  </div>
                </div>
              )}
              <label className="grid gap-1 text-sm font-medium">Observação (opcional)
                <textarea value={obs} onChange={(e) => setObs(e.target.value.slice(0, 2000))} rows={4} maxLength={2000} data-testid="input-obs"
                  placeholder="Ex.: clientes a visitar, motivo da viagem, roteiro…"
                  className="min-h-[96px] resize-y rounded-md border bg-background px-3 py-2 text-sm font-normal" />
                <span className="text-[11px] font-normal text-muted-foreground text-right">{obs.length}/2000 · arraste o canto para ampliar</span>
              </label>
              <div className="flex items-center justify-between rounded-lg bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 flex-wrap gap-2">
                <span className="text-sm">{cfg.admin ? "Adiantamento total" : "Adiantamento de km"}{!cfg.admin && <span className="text-xs text-muted-foreground"> (alimentação e hospedagem são definidas pelo admin na aprovação)</span>}</span>
                <b className="text-2xl tabular-nums">{BRL(cfg.admin ? calc.total : calc.vKm)}</b>
              </div>
              <div className="rounded-lg border p-3 grid gap-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Para o Contas a Pagar · como receber o adiantamento</div>
                <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
                  <label className="grid gap-1 text-sm font-medium">Empresa (instância) *
                    <select className={selCls} value={instancia} onChange={(e) => setInstancia(e.target.value)} data-testid="select-instancia">
                      <option value="">Selecione…</option>{(cfg.instancias || []).map((i) => <option key={i} value={i}>{i}</option>)}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-medium">Favorecido (nome) *<Input value={favNome} onChange={(e) => setFavNome(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm font-medium">CPF/CNPJ do favorecido<Input value={favDoc} onChange={(e) => setFavDoc(e.target.value)} placeholder="000.000.000-00" /></label>
                  <label className="grid gap-1 text-sm font-medium">Pagar até *<Input type="date" value={venc || ini} onChange={(e) => setVenc(e.target.value || null)} data-testid="input-pagar-ate" />
                    <span className="text-[11px] font-normal text-muted-foreground">{!venc || venc === ini ? "início da viagem (pode antecipar ou prorrogar)" : venc < ini ? "antecipado" : "prorrogado — depois do início da viagem"}</span></label>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {Object.entries(FORMA_LABEL).map(([k, l]) => (
                    <button key={k} type="button" onClick={() => setForma(k)} className={`h-10 px-4 rounded-full border text-sm font-semibold ${forma === k ? "bg-green-700 text-white border-green-700" : "bg-white"}`}>{l}</button>
                  ))}
                </div>
                <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
                  {forma === "pix" && (<>
                    <label className="grid gap-1 text-sm font-medium">Tipo de chave PIX
                      <select className={selCls} value={pixTipo} data-testid="select-pix-tipo" onChange={(e) => { const t = e.target.value; setPixTipo(t); setPixChave((k) => PIX_REGRA[t].limpar(k)); }}>{PIX_TIPOS.map((t) => <option key={t}>{t}</option>)}</select>
                    </label>
                    <label className="grid gap-1 text-sm font-medium sm:col-span-1 md:col-span-2">Chave PIX *
                      <Input value={pixChave} inputMode={PIX_REGRA[pixTipo].modo} placeholder={PIX_REGRA[pixTipo].placeholder} data-testid="input-pix-chave"
                        onChange={(e) => setPixChave(PIX_REGRA[pixTipo].limpar(e.target.value))}
                        className={pixChave && !PIX_REGRA[pixTipo].valido(pixChave) ? "border-red-500 focus-visible:ring-red-500" : ""} />
                      <span className={`text-[11px] ${pixChave && !PIX_REGRA[pixTipo].valido(pixChave) ? "font-semibold text-red-600" : "font-normal text-muted-foreground"}`}>
                        {pixChave && !PIX_REGRA[pixTipo].valido(pixChave) ? (pixTipo === "CPF" || pixTipo === "CNPJ" ? `${pixTipo} inválido — confira os números` : "Formato inválido para o tipo escolhido") : PIX_REGRA[pixTipo].dica}
                      </span>
                    </label>
                  </>)}
                  {forma === "transferencia" && (<>
                    <label className="grid gap-1 text-sm font-medium">Banco *<Input value={banco} onChange={(e) => setBanco(e.target.value)} placeholder="Ex.: 001 Banco do Brasil" /></label>
                    <label className="grid gap-1 text-sm font-medium">Tipo de conta<select className={selCls} value={tipoConta} onChange={(e) => setTipoConta(e.target.value)}><option>Corrente</option><option>Poupança</option></select></label>
                    <label className="grid gap-1 text-sm font-medium">Agência *<Input value={agencia} onChange={(e) => setAgencia(e.target.value)} /></label>
                    <label className="grid gap-1 text-sm font-medium">Conta (com dígito) *<Input value={conta} onChange={(e) => setConta(e.target.value)} /></label>
                  </>)}
                  {forma === "dinheiro" && <p className="text-xs text-muted-foreground self-center md:col-span-4">Recebe em dinheiro pela Caixinha.</p>}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <Button onClick={enviar} disabled={enviando} data-testid="button-enviar-viagem">{enviando ? "Enviando…" : "Enviar para aprovação"}</Button>
                {faltando.length > 0 && <span className="text-xs text-muted-foreground">Falta: {faltando.join(", ")}.</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------- Detalhe -------------------------------------
function DetalheViagem({ id, cfg, onBack, recarregar, erro }: { id: string; cfg: Cfg; onBack: () => void; recarregar: () => void; erro: (e: any) => void }) {
  const { toast } = useToast();
  const deChamado = useMemo(() => new URLSearchParams(window.location.search).get("de"), []);
  const { data: v, isLoading } = useQuery<Detalhe>({ queryKey: ["/api/viagens", id], queryFn: () => apiRequest("GET", `/api/viagens/${id}`) });
  const [etapa, setEtapa] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [aba, setAba] = useState<"resumo" | "km">("resumo");
  const [apr, setApr] = useState<{ tarifa: number; alim: number; hosp: number; outros: number; valor: number | null }>({ tarifa: 0, alim: 0, hosp: 0, outros: 0, valor: null });
  const [motivo, setMotivo] = useState("");
  const [confirmar, setConfirmar] = useState<string | null>(null);
  const [lan, setLan] = useState<{ cat: string; venc: string; inst: string }>({ cat: "", venc: "", inst: "" });
  useEffect(() => { if (v) setApr({ tarifa: v.tarifa, alim: v.alimDia, hosp: v.hospNoite, outros: v.valorOutros || 0, valor: null }); }, [v?.id, v?.status]);
  if (isLoading || !v) return <div className="p-6 text-sm text-muted-foreground">Carregando…</div>;
  const atual = etapa ?? etapaDe(v.status);
  const acao = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); toast({ title: ok }); recarregar(); setEtapa(null); setConfirmar(null); } catch (e) { erro(e); } finally { setBusy(false); }
  };
  const souDono = v.vendedorId === cfg.me.id;
  const editPrest = v.status === "pago" && (cfg.admin || souDono);
  const valorApr = apr.valor ?? Math.round((v.kmPrevisto * apr.tarifa + apr.alim * v.dias + apr.hosp * v.noites + apr.outros) * 100) / 100;
  const anexosDe = (did: string | null) => v.anexos.filter((a) => a.despesaId === did && a.categoria !== "pagamento");
  const despComprovadas = v.despesas.filter((d) => anexosDe(d.id).length).reduce((a, d) => a + d.valor, 0);
  const kmPeriodo = v.kmDias.reduce((a, d) => a + d.km, 0);
  const prevReal = kmPeriodo * v.tarifa + despComprovadas;
  const saldoPrev = prevReal - (v.valorAprovado || 0);

  const Anexo = ({ a, podeRemover }: { a: Detalhe["anexos"][0]; podeRemover: boolean }) => (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs max-w-[220px]">
      {a.mime?.startsWith("image/") ? <img src={`/api/viagens/anexos/${a.id}`} alt="" className="w-8 h-8 object-cover rounded" /> : <FileText className="w-4 h-4" />}
      <a href={`/api/viagens/anexos/${a.id}`} target="_blank" rel="noreferrer" className="truncate hover:underline">{a.nome}</a>
      {podeRemover && <button className="text-red-600 ml-1" aria-label="Remover" onClick={() => acao(() => apiRequest("DELETE", `/api/viagens/anexos/${a.id}`), "Anexo removido")}>×</button>}
    </span>
  );

  const Resumo = () => (
    <div className="grid md:grid-cols-2 gap-4">
      <div>
        <Linha k="Vendedor" v={v.vendedorNome} />
        <Linha k="Destino" v={`${v.cidade}-${v.uf}`} />
        <Linha k="Período" v={`${DT(v.dataIni)} a ${DT(v.dataFim)} · ${v.dias} dia(s), ${v.noites} noite(s)`} />
        {v.obs && <Linha k="Observação" v={v.obs} />}
        {v.forma && <Linha k="Receber por" v={pagamentoTxt(v)} />}
        {v.instancia && <Linha k="Empresa" v={v.instancia} />}
      </div>
      <div>
        <Linha k="Km previsto (+10%)" v={`${KM(v.kmPrevisto)} km × ${BRL(v.tarifa)}`} />
        <Linha k="Valor de km" v={BRL(v.valorKm)} />
        {cfg.admin && <Linha k={`Alimentação (${BRL(v.alimDia)}/dia)`} v={BRL(v.valorAlim)} />}
        {cfg.admin && <Linha k={`Hospedagem (${BRL(v.hospNoite)}/noite)`} v={BRL(v.valorHosp)} />}
        {cfg.admin && <Linha k="Outras despesas" v={BRL(v.valorOutros)} />}
        {v.vencimento && <Linha k="Pagar até" v={DT(v.vencimento)} />}
        <Linha k="Sugerido" v={BRL(v.valorSugerido)} />
        {v.valorAprovado != null && <Linha k="Aprovado" v={<b>{BRL(v.valorAprovado)}</b>} />}
      </div>
    </div>
  );

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto grid gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {deChamado && <a href={`/chamados?id=${deChamado}`} data-testid="button-voltar-chamado" className="inline-flex items-center gap-1 h-9 px-3 rounded-lg border border-green-700 text-green-800 text-sm font-semibold hover:bg-green-50"><ArrowLeft className="w-4 h-4" /> Voltar para Chamados</a>}
          <button className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1" onClick={onBack}><ArrowLeft className="w-4 h-4" /> Viagens</button>
        </div>
        <div className="flex items-center gap-2"><b>{v.codigo}</b><Pill status={v.status} /></div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {ETAPAS.map((e, i) => (
          <button key={e} onClick={() => setEtapa(i)} className={`rounded-lg border px-3 py-2 text-left text-sm ${atual === i ? "border-emerald-600 ring-2 ring-emerald-100 dark:ring-emerald-900" : ""}`}>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Etapa {i + 1}</div>
            <div className="font-semibold">{i < etapaDe(v.status) || v.status === "encerrado" || (i === 3 && v.status === "prestado") ? "✓ " : ""}{e}</div>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-lg">{ETAPAS[atual]}</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          {atual === 0 && (<><Resumo />{v.status === "recusado" && <div className="text-sm text-red-700">Recusado por {v.aprovadorNome}{v.motivoRecusa ? `: ${v.motivoRecusa}` : "."} Faça uma nova solicitação com os ajustes.</div>}</>)}

          {atual === 1 && (<>
            <div className="rounded-lg border p-3"><Resumo /></div>
            {v.status === "aguardando" ? (cfg.admin ? (
              <div className="grid gap-3">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <label className="grid gap-1 text-sm font-medium">R$ por km<Input type="number" step="0.01" value={apr.tarifa} onChange={(e) => setApr({ ...apr, tarifa: Number(e.target.value) || 0, valor: null })} /></label>
                  <label className="grid gap-1 text-sm font-medium">Alimentação por dia<Input type="number" step="0.01" value={apr.alim} onChange={(e) => setApr({ ...apr, alim: Number(e.target.value) || 0, valor: null })} /></label>
                  <label className="grid gap-1 text-sm font-medium">Hospedagem por noite<Input type="number" step="0.01" value={apr.hosp} onChange={(e) => setApr({ ...apr, hosp: Number(e.target.value) || 0, valor: null })} /></label>
                  <label className="grid gap-1 text-sm font-medium">Outras despesas<Input type="number" step="0.01" min="0" value={apr.outros} onChange={(e) => setApr({ ...apr, outros: Math.max(0, Number(e.target.value) || 0), valor: null })} /></label>
                  <label className="grid gap-1 text-sm font-medium">Valor aprovado<Input type="number" step="0.01" value={valorApr} onChange={(e) => setApr({ ...apr, valor: Number(e.target.value) || 0 })} /></label>
                </div>
                <div className="flex gap-2 flex-wrap items-center">
                  <Button disabled={busy} onClick={() => acao(() => apiRequest("POST", `/api/viagens/${v.id}/aprovar`, { tarifa: apr.tarifa, alimDia: apr.alim, hospNoite: apr.hosp, outros: apr.outros, valorAprovado: valorApr }), "Aprovado e enviado ao Financeiro")}>Aprovar e enviar ao Financeiro</Button>
                  <Input className="w-72" placeholder="Motivo da recusa (obrigatório)" value={motivo} onChange={(e) => setMotivo(e.target.value)} data-testid="input-motivo-recusa" />
                  <Button variant="outline" className="text-red-700" disabled={busy || motivo.trim().length < 3} onClick={() => acao(() => apiRequest("POST", `/api/viagens/${v.id}/recusar`, { motivo: motivo.trim() }), "Solicitação recusada")}>Recusar</Button>
                </div>
              </div>
            ) : <p className="text-sm text-muted-foreground">Aguardando aprovação de um Admin ou Adm.</p>) : (
              <p className="text-sm">{v.status === "recusado" ? `Recusado por ${v.aprovadorNome}.` : `Aprovado por ${v.aprovadorNome}: ${BRL(v.valorAprovado)}.`}</p>
            )}
          </>)}

          {atual === 2 && (["aprovado", "pago", "prestado", "encerrado"].includes(v.status) ? (<>
            <div className="max-w-xl">
              <Linha k="Favorecido" v={`${v.favorecidoNome}${v.favorecidoDoc ? ` · ${v.favorecidoDoc}` : ""}`} />
              <Linha k="Valor" v={<b>{BRL(v.valorAprovado)}</b>} />
              <Linha k="Receber por" v={pagamentoTxt(v)} />
              <Linha k="Empresa" v={v.instancia || "—"} />
              {cfg.financeiro && v.payable && <Linha k="Categoria DRE" v={v.categoriaNome || "—"} />}
              <Linha k="Aprovado por" v={v.aprovadorNome} />
              <Linha k="Viagem" v={`${v.cidade}-${v.uf} · ${DT(v.dataIni)} a ${DT(v.dataFim)}`} />
              <Linha k="Prazo" v={`Até ${DT(v.vencimento || v.dataIni)}`} />
            </div>
            <div className="flex gap-2 flex-wrap">{v.anexos.filter((a) => a.categoria === "pagamento").map((a) => <Anexo key={a.id} a={a} podeRemover={false} />)}</div>
            {v.payable && (
              <p className="text-sm">✓ Lançado no Contas a Pagar por {v.lancadoNome}: conta <b>{v.payable.titulo}</b>, venc. {DT(v.payable.vencimento)}, {BRL(v.payable.valor)} — situação: <b>{v.payable.status === "paga" ? "paga" : v.payable.status.replace("_", " ")}</b>. A viagem fica paga quando a conta for baixada.
                {cfg.financeiro && <> <a className="underline text-indigo-700" href="/financeiro">Abrir no Financeiro</a></>}</p>
            )}
            {v.status === "aprovado" && !v.payable && cfg.financeiro && v.forma && (
              <div className="grid gap-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
                <div className="grid sm:grid-cols-3 gap-3">
                  <label className="grid gap-1 text-sm font-medium">Categoria (DRE) *
                    <select className={selCls} value={lan.cat} onChange={(e) => setLan({ ...lan, cat: e.target.value })} data-testid="select-categoria-lancar">
                      <option value="">Selecione…</option>{(cfg.categorias || []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
                    </select>
                    {!lan.cat && <span className="text-[11px] font-semibold text-red-600">Obrigatória para lançar no Contas a Pagar</span>}
                  </label>
                  <label className="grid gap-1 text-sm font-medium">Vencimento *<Input type="date" value={lan.venc || v.vencimento || v.dataIni} onChange={(e) => setLan({ ...lan, venc: e.target.value })} /></label>
                  <label className="grid gap-1 text-sm font-medium">Empresa (instância) *
                    <select className={selCls} value={lan.inst || v.instancia || ""} onChange={(e) => setLan({ ...lan, inst: e.target.value })}>
                      {(cfg.instancias || []).map((i) => <option key={i} value={i}>{i}</option>)}
                    </select>
                  </label>
                </div>
                <div className="flex gap-2 items-center flex-wrap">
                  <Button disabled={busy || !lan.cat} className="bg-indigo-700 hover:bg-indigo-800 text-white" data-testid="button-lancar"
                    onClick={() => acao(() => apiRequest("POST", `/api/viagens/${v.id}/lancar`, { chartAccountId: lan.cat, vencimento: lan.venc || v.vencimento || v.dataIni, instancia: lan.inst || v.instancia }), "Lançado no Contas a Pagar")}>
                    Lançar no Contas a Pagar</Button>
                  <span className="text-xs text-muted-foreground">Cria a conta a pagar do adiantamento com os dados de pagamento da solicitação.</span>
                </div>
              </div>
            )}
            {v.status === "aprovado" && !v.payable && (cfg.admin ? (
              <div className="flex gap-2 flex-wrap items-center">
                <label className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer"><Paperclip className="w-4 h-4" /> Anexar comprovante e marcar como pago
                  <input type="file" className="hidden" accept="image/*,.pdf" multiple onChange={(e) => e.target.files?.length && acao(() => enviarArquivos(`/api/viagens/${v.id}/pagar`, e.target.files!), "Pagamento registrado")} />
                </label>
                <Button variant="outline" disabled={busy} onClick={() => acao(() => enviarArquivos(`/api/viagens/${v.id}/pagar`, []), "Pagamento registrado")}>Marcar como pago sem comprovante</Button>
              </div>
            ) : <p className="text-sm text-muted-foreground">Aguardando o pagamento pelo Financeiro.</p>)}
          </>) : <p className="text-sm text-muted-foreground">Aguardando aprovação.</p>)}

          {atual === 3 && (["pago", "prestado", "encerrado"].includes(v.status) ? (<>
            <div className="flex rounded-md border overflow-hidden w-fit">
              {([["resumo", "Resumo e despesas"], ["km", "Km por dia"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setAba(k)} className={`px-3 py-1.5 text-sm ${aba === k ? "bg-emerald-600 text-white" : "hover:bg-muted"}`}>{l}</button>
              ))}
            </div>
            {aba === "km" ? (
              <div className="grid gap-2">
                <p className="text-xs text-muted-foreground">Km da Rota do Dia do vendedor em cada dia da viagem (casa a casa, já com +10%). O detalhe trecho a trecho está no módulo KM, aba Relatório de trechos.</p>
                {v.kmDias.length === 0 ? <p className="text-sm text-muted-foreground">Ainda não há rota registrada no período.</p> : (
                  <table className="text-sm w-full max-w-md"><tbody>
                    {v.kmDias.map((d) => <tr key={d.dia} className="border-b"><td className="py-1.5">{DT(d.dia)}</td><td className="py-1.5 text-right tabular-nums">{KM(d.km)} km</td></tr>)}
                    <tr className="font-bold"><td className="py-1.5">Total</td><td className="py-1.5 text-right tabular-nums">{KM(kmPeriodo)} km</td></tr>
                  </tbody></table>
                )}
              </div>
            ) : (<>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Km real · vem da Rota do Dia</div>
                  <Linha k="Km da viagem" v={`${KM(v.kmReal ?? kmPeriodo)} km`} />
                  <Linha k={`Km × ${BRL(v.tarifa)}`} v={BRL(v.valorKmReal ?? kmPeriodo * v.tarifa)} />
                </div>
                <div className="grid gap-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Despesas · cada uma com comprovante</div>
                  {v.despesas.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma despesa lançada.</p>}
                  {v.despesas.map((d) => (
                    <div key={d.id} className="rounded-md border p-2 grid gap-2">
                      <div className="flex gap-2 items-center">
                        <select className="rounded-md border bg-background px-2 py-1.5 text-sm" defaultValue={d.tipo} disabled={!editPrest} onChange={(e) => acao(() => apiRequest("PATCH", `/api/viagens/despesas/${d.id}`, { tipo: e.target.value }), "Despesa atualizada")}>
                          {TIPOS.map((t) => <option key={t}>{t}</option>)}
                        </select>
                        <Input type="number" step="0.01" className="w-32" defaultValue={d.valor} disabled={!editPrest} onBlur={(e) => Number(e.target.value) !== d.valor && acao(() => apiRequest("PATCH", `/api/viagens/despesas/${d.id}`, { valor: Number(e.target.value) || 0 }), "Despesa atualizada")} />
                        {editPrest && <button className="text-red-600" aria-label="Excluir despesa" onClick={() => acao(() => apiRequest("DELETE", `/api/viagens/despesas/${d.id}`), "Despesa excluída")}><Trash2 className="w-4 h-4" /></button>}
                      </div>
                      <div className="flex gap-1.5 flex-wrap items-center">
                        {anexosDe(d.id).map((a) => <Anexo key={a.id} a={a} podeRemover={editPrest} />)}
                        {editPrest && (
                          <label className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs cursor-pointer"><Paperclip className="w-3.5 h-3.5" /> Anexar comprovante
                            <input type="file" className="hidden" accept="image/*,.pdf" multiple onChange={(e) => e.target.files?.length && acao(() => enviarArquivos(`/api/viagens/${v.id}/anexos`, e.target.files!, { despesaId: d.id }), "Comprovante anexado")} />
                          </label>
                        )}
                      </div>
                      {!anexosDe(d.id).length && d.valor > 0 && <div className="text-xs text-amber-700">Sem comprovante: não entra no reembolso.</div>}
                    </div>
                  ))}
                  {editPrest && <Button variant="outline" size="sm" className="w-fit" disabled={busy} onClick={() => acao(() => apiRequest("POST", `/api/viagens/${v.id}/despesas`, { tipo: "Alimentação", valor: 0 }), "Despesa incluída")}><Plus className="w-4 h-4 mr-1" /> Despesa</Button>}
                </div>
              </div>
              <div className="grid gap-1.5">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Outros anexos e imagens (fotos da viagem, notas, relatórios)</div>
                <div className="flex gap-1.5 flex-wrap items-center">
                  {anexosDe(null).map((a) => <Anexo key={a.id} a={a} podeRemover={editPrest} />)}
                  {editPrest && (
                    <label className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs cursor-pointer"><Paperclip className="w-3.5 h-3.5" /> Anexar fotos ou PDF
                      <input type="file" className="hidden" accept="image/*,.pdf" multiple onChange={(e) => e.target.files?.length && acao(() => enviarArquivos(`/api/viagens/${v.id}/anexos`, e.target.files!), "Anexo incluído")} />
                    </label>
                  )}
                  {!editPrest && !anexosDe(null).length && <span className="text-xs text-muted-foreground">Nenhum.</span>}
                </div>
              </div>
              {(() => {
                const real = v.valorReal ?? prevReal, saldo = v.saldo ?? saldoPrev;
                return (
                  <div className="rounded-lg bg-muted/50 p-3 grid gap-1">
                    <Linha k="Gasto real (km + despesas comprovadas)" v={BRL(real)} />
                    <Linha k="Adiantado" v={`− ${BRL(v.valorAprovado)}`} />
                    <div className="flex justify-between items-baseline pt-1"><span className="text-sm">{saldo > 0.009 ? "A receber pelo vendedor" : saldo < -0.009 ? "A devolver pelo vendedor" : "Sem diferença"}{v.status === "pago" ? " (prévia)" : ""}</span>
                      <b className={`text-2xl tabular-nums ${saldo > 0.009 ? "text-amber-700" : saldo < -0.009 ? "text-blue-700" : "text-emerald-700"}`}>{BRL(Math.abs(saldo))}</b></div>
                  </div>
                );
              })()}
              <div className="flex gap-2 flex-wrap items-center">
                {editPrest && (confirmar === "prestar"
                  ? <><span className="text-sm">Enviar a prestação? Depois disso só um admin reabre.</span><Button disabled={busy} onClick={() => acao(() => apiRequest("POST", `/api/viagens/${v.id}/prestacao`), "Prestação de contas enviada")}>Confirmar envio</Button><Button variant="outline" onClick={() => setConfirmar(null)}>Cancelar</Button></>
                  : <Button onClick={() => setConfirmar("prestar")}>Enviar prestação de contas</Button>)}
                {v.status === "prestado" && cfg.admin && <>
                  <Button disabled={busy} onClick={() => acao(() => apiRequest("POST", `/api/viagens/${v.id}/encerrar`), "Viagem encerrada")}>Conferido · encerrar viagem</Button>
                  <Button variant="outline" disabled={busy} onClick={() => acao(() => apiRequest("POST", `/api/viagens/${v.id}/reabrir`), "Prestação reaberta")}>Reabrir para ajuste</Button>
                </>}
              </div>
            </>)}
          </>) : <p className="text-sm text-muted-foreground">Libera depois do pagamento.</p>)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Histórico</CardTitle></CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          {v.eventos.map((e, i) => (
            <div key={i} className="grid grid-cols-[auto_1fr] gap-3"><span className="text-xs text-muted-foreground tabular-nums">{new Date(e.em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span><span><b>{e.autor}</b> · {e.texto}</span></div>
          ))}
          <p className="text-xs text-muted-foreground mt-1">Cada etapa também abre um chamado no módulo Chamados (aprovação para Flávio e Cinthia, pagamento para Lanucy).</p>
        </CardContent>
      </Card>
    </div>
  );
}
