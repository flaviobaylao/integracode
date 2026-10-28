// client/src/pages/Reembolsos.tsx
// -----------------------------------------------------------------------------
// REEMBOLSO DE DESPESAS (28/out/2026) — grupo Chamados.
// Quem pagou algo do próprio bolso (gelo, café, material...) pede o reembolso com
// comprovante e Pix/conta. Etapas: Solicitação → Aprovação (Admin) → Lançamento
// no Contas a Pagar (Financeiro, 1 clique) → Pagamento (quando a conta é baixada).
// O formulário já pede os campos que a Conta a Pagar exige. Servidor: /api/reembolsos/*.
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, ArrowLeft, FileText, Camera, Paperclip } from "lucide-react";

type Reembolso = {
  id: string; numero: number; codigo: string; solicitanteId: string; solicitanteNome: string;
  descricao: string; dataDespesa: string; valor: number; vencimento: string; forma: string; instancia: string | null; chartAccountId: string | null;
  favorecidoNome: string; favorecidoDoc: string; pixTipo: string; pixChave: string; banco: string; agencia: string; conta: string; tipoConta: string;
  obs: string; status: string; aprovadorNome: string | null; autoaprovado?: boolean; valorAprovado: number | null; motivoRecusa: string | null;
  payableId: string | null; lancadoNome: string | null; lancadoEm: string | null; pagoEm: string | null; createdAt: string;
};
type Detalhe = Reembolso & {
  categoriaNome: string | null;
  itens: { id: string; descricao: string; data: string; valor: number }[];
  anexos: { id: string; nome: string; mime: string; tamanho: number }[];
  eventos: { autor: string; texto: string; em: string }[];
  payable: { id: string; titulo: string; status: string; valor: number; vencimento: string } | null;
};
type Cfg = {
  me: { id: string; nome: string; cpf: string }; aprovador: boolean; financeiro: boolean;
  categorias: { id: string; code: string; name: string }[]; instancias: string[];
};

const BRL = (n: number | null | undefined) => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const DT = (s: string) => (s ? String(s).slice(0, 10).split("-").reverse().join("/") : "—");
const hoje = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const maisDias = (n: number) => { const d = new Date(hoje() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const STATUS: Record<string, [string, string]> = {
  aguardando: ["Aguardando aprovação", "bg-amber-100 text-amber-800"],
  recusado: ["Recusado", "bg-red-100 text-red-800"],
  cancelado: ["Cancelado", "bg-gray-200 text-gray-700"],
  aprovado: ["Aprovado · no Financeiro", "bg-blue-100 text-blue-800"],
  lancado: ["Lançado no Contas a Pagar", "bg-indigo-100 text-indigo-800"],
  pago: ["Pago", "bg-emerald-100 text-emerald-800"],
};
const ETAPAS = ["Solicitação", "Aprovação", "Contas a Pagar", "Pagamento"];
const etapaDe = (s: string) => ({ aguardando: 1, recusado: 1, cancelado: 0, aprovado: 2, lancado: 3, pago: 3 } as Record<string, number>)[s] ?? 0;
const FORMA_LABEL: Record<string, string> = { pix: "PIX", transferencia: "Transferência bancária", dinheiro: "Dinheiro (Caixinha)" };
const PIX_TIPOS = ["CPF", "CNPJ", "Celular", "E-mail", "Aleatória"];
// Chave PIX conforme o tipo: só aceita os caracteres do tipo e valida o formato.
const so = (v: string) => v.replace(/\D/g, "");
const cpfOk = (d: string) => {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
};
const cnpjOk = (d: string) => {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (n: number) => { const p = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
};
const PIX_REGRA: Record<string, { limpar: (v: string) => string; valido: (v: string) => boolean; dica: string; placeholder: string; max: number; modo: "numeric" | "email" | "text" }> = {
  "CPF": { limpar: (v) => so(v).slice(0, 11), valido: cpfOk, dica: "11 números, sem pontos e traço", placeholder: "12345678909", max: 11, modo: "numeric" },
  "CNPJ": { limpar: (v) => so(v).slice(0, 14), valido: cnpjOk, dica: "14 números, sem pontos, barra e traço", placeholder: "12345678000190", max: 14, modo: "numeric" },
  "Celular": { limpar: (v) => so(v).slice(0, 11), valido: (v) => /^\d{2}9\d{8}$/.test(v), dica: "DDD + número: 11 números, sem espaço ou traço", placeholder: "62999998888", max: 11, modo: "numeric" },
  "E-mail": { limpar: (v) => v.replace(/\s/g, "").toLowerCase().slice(0, 77), valido: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), dica: "Precisa ter @ (ex.: nome@empresa.com.br)", placeholder: "nome@empresa.com.br", max: 77, modo: "email" },
  "Aleatória": { limpar: (v) => v.replace(/[^0-9a-fA-F-]/g, "").toLowerCase().slice(0, 36), valido: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v), dica: "Chave de 32 letras/números com traços (como aparece no app do banco)", placeholder: "123e4567-e89b-12d3-a456-426614174000", max: 36, modo: "text" },
};

function Pill({ status }: { status: string }) {
  const [l, c] = STATUS[status] || [status, "bg-muted"];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${c}`}>{l}</span>;
}
const Linha = ({ k, v }: { k: string; v: any }) => (
  <div className="flex justify-between gap-3 py-1.5 border-b last:border-0 text-sm"><span className="text-muted-foreground">{k}</span><span className="tabular-nums font-medium text-right break-all">{v}</span></div>
);
const Campo = ({ label, obrig, children, dica }: { label: string; obrig?: boolean; children: any; dica?: string }) => (
  <label className="grid gap-1 text-sm font-medium">
    <span>{label}{obrig && <span className="text-red-600"> *</span>}</span>
    {children}
    {dica && <span className="text-[11px] font-normal text-muted-foreground">{dica}</span>}
  </label>
);
const selCls = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

async function reduzirImagem(f: File): Promise<File> {
  try {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(f.type) || f.size < 600 * 1024) return f;
    const bmp = await (window as any).createImageBitmap(f, { imageOrientation: "from-image" });
    const esc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * esc), h = Math.round(bmp.height * esc);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d"); if (!ctx) return f;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
    const blob: Blob | null = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.82));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg", { type: "image/jpeg", lastModified: Date.now() });
  } catch { return f; }
}

export default function Reembolsos() {
  const { toast } = useToast();
  const erro = (e: any) => toast({ title: "Não foi possível", description: e?.message || String(e), variant: "destructive" });
  const [sel, setSel] = useState<string | null>(() => new URLSearchParams(window.location.search).get("id"));
  const [nova, setNova] = useState(false);
  const [filtro, setFiltro] = useState<"todos" | "pendentes" | "meus">("todos");
  const { data: cfg } = useQuery<Cfg>({ queryKey: ["/api/reembolsos/config"], queryFn: () => apiRequest("GET", "/api/reembolsos/config") });
  const { data: lista = [], isLoading } = useQuery<Reembolso[]>({ queryKey: ["/api/reembolsos"], queryFn: () => apiRequest("GET", "/api/reembolsos"), refetchInterval: 60000 });
  const recarregar = () => { queryClient.invalidateQueries({ queryKey: ["/api/reembolsos"] }); };

  if (nova && cfg) return <NovoReembolso cfg={cfg} onCancel={() => setNova(false)} onOk={(id) => { setNova(false); setSel(id); recarregar(); }} erro={erro} />;
  if (sel && cfg) return <DetalheReembolso id={sel} cfg={cfg} onBack={() => { setSel(null); window.history.replaceState(null, "", "/reembolsos"); }} recarregar={recarregar} erro={erro} />;

  const minhaVez = (r: Reembolso) => (cfg?.aprovador && r.status === "aguardando" && r.solicitanteId !== cfg.me.id) || (cfg?.financeiro && r.status === "aprovado");
  const vis = lista.filter((r) => filtro === "todos" ? true : filtro === "meus" ? r.solicitanteId === cfg?.me.id : minhaVez(r));
  const pendentes = lista.filter(minhaVez).length;
  const gestor = cfg?.aprovador || cfg?.financeiro;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <BackToDashboardButton />
      <div className="flex items-end justify-between gap-3 flex-wrap mt-3 mb-4">
        <div>
          <h1 className="text-xl font-bold">Reembolso de Despesas</h1>
          <p className="text-xs text-muted-foreground">Pagou algo do seu bolso para a empresa (gelo, café, material…)? Peça o reembolso com o comprovante.</p>
        </div>
        <Button onClick={() => setNova(true)} disabled={!cfg} data-testid="button-novo-reembolso"><Plus className="w-4 h-4 mr-1" /> Pedir reembolso</Button>
      </div>
      {gestor && (
        <div className="flex gap-2 mb-3 flex-wrap">
          {([["todos", "Todos"], ["pendentes", `Pendentes comigo${pendentes ? ` (${pendentes})` : ""}`], ["meus", "Meus pedidos"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFiltro(k)} className={`h-9 px-4 rounded-full border text-sm font-semibold ${filtro === k ? "bg-gray-900 text-white border-gray-900" : "bg-white"}`}>{l}</button>
          ))}
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-6 text-sm text-muted-foreground">Carregando…</div> : vis.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">Nenhum reembolso aqui. Clique em "Pedir reembolso" para enviar um comprovante.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                  <th className="text-left p-3">Pedido</th><th className="text-left p-3">Solicitante</th><th className="text-left p-3">Descrição</th>
                  <th className="text-left p-3">Pagar até</th><th className="text-right p-3">Valor</th><th className="text-left p-3">Situação</th>
                </tr></thead>
                <tbody>{vis.map((r) => (
                  <tr key={r.id} className={`border-b last:border-0 hover:bg-muted/40 cursor-pointer ${minhaVez(r) ? "bg-amber-50" : ""}`} onClick={() => setSel(r.id)} data-testid={`reembolso-${r.codigo}`}>
                    <td className="p-3 font-semibold whitespace-nowrap">{r.codigo}</td>
                    <td className="p-3 whitespace-nowrap">{r.solicitanteNome}</td>
                    <td className="p-3 max-w-[320px] truncate">{r.descricao}</td>
                    <td className="p-3 whitespace-nowrap">{DT(r.vencimento)}</td>
                    <td className="p-3 text-right tabular-nums">{BRL(r.valorAprovado ?? r.valor)}</td>
                    <td className="p-3"><Pill status={r.status} />{r.autoaprovado && <span className="ml-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-900" title="Aprovado pelo próprio solicitante">auto</span>}</td>
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

// ------------------------------- Solicitação ---------------------------------
type Item = { descricao: string; data: string; valor: string };
function NovoReembolso({ cfg, onCancel, onOk, erro }: { cfg: Cfg; onCancel: () => void; onOk: (id: string) => void; erro: (e: any) => void }) {
  const [itens, setItens] = useState<Item[]>([{ descricao: "", data: hoje(), valor: "" }]);
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [preparando, setPreparando] = useState(false);
  const [instancia, setInstancia] = useState("");
  const [vencimento, setVencimento] = useState(maisDias(3));
  const [forma, setForma] = useState("pix");
  const [favNome, setFavNome] = useState(cfg.me.nome);
  const [favDoc, setFavDoc] = useState(cfg.me.cpf || "");
  const [pixTipo, setPixTipo] = useState("CPF");
  const [pixChave, setPixChave] = useState("");
  const [banco, setBanco] = useState(""); const [agencia, setAgencia] = useState(""); const [conta, setConta] = useState(""); const [tipoConta, setTipoConta] = useState("Corrente");
  const [obs, setObs] = useState("");
  const [enviando, setEnviando] = useState(false);
  const refArq = useRef<HTMLInputElement>(null), refCam = useRef<HTMLInputElement>(null);
  const total = useMemo(() => itens.reduce((a, i) => a + (Number(String(i.valor).replace(",", ".")) || 0), 0), [itens]);
  const setItem = (k: number, p: Partial<Item>) => setItens(itens.map((x, i) => (i === k ? { ...x, ...p } : x)));

  const adicionarArquivos = async (fl: FileList | null) => {
    if (!fl?.length) return;
    setPreparando(true);
    try {
      const novos: File[] = [];
      for (const f of Array.from(fl)) {
        const g = await reduzirImagem(f);
        if (g.size > 15 * 1024 * 1024) { erro(new Error(`${f.name} passa de 15 MB`)); continue; }
        novos.push(g);
      }
      setArquivos((a) => [...a, ...novos].slice(0, 10));
    } finally { setPreparando(false); }
  };

  const faltando = [
    itens.some((i) => !i.descricao.trim() || !(Number(String(i.valor).replace(",", ".")) > 0)) && "o que foi comprado e o valor",
    !arquivos.length && "o comprovante",
    !instancia && "a empresa",
    !vencimento && "a data para pagamento",
    !favNome.trim() && "o favorecido",
    forma === "pix" && !pixChave.trim() && "a chave PIX",
    forma === "pix" && !!pixChave.trim() && !PIX_REGRA[pixTipo].valido(pixChave) && `chave PIX válida (${PIX_REGRA[pixTipo].dica})`,
    forma === "transferencia" && (!banco.trim() || !agencia.trim() || !conta.trim()) && "banco, agência e conta",
  ].filter(Boolean) as string[];

  const enviar = async () => {
    if (faltando.length) { erro(new Error("Falta informar: " + faltando.join(", "))); return; }
    setEnviando(true);
    try {
      const fd = new FormData();
      fd.append("dados", JSON.stringify({
        itens: itens.map((i) => ({ ...i, valor: String(i.valor).replace(",", ".") })), instancia, vencimento, forma,
        favorecidoNome: favNome, favorecidoDoc: favDoc, pixTipo, pixChave, banco, agencia, conta, tipoConta, obs,
      }));
      arquivos.forEach((f) => fd.append("arquivos", f));
      const r = await fetch("/api/reembolsos", { method: "POST", body: fd, credentials: "include" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.message || (r.status >= 500 ? "O servidor demorou para responder. Tente de novo." : `Erro ${r.status}`));
      onOk(j.id);
    } catch (e) { erro(e); } finally { setEnviando(false); }
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto grid gap-4">
      <button className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 w-fit" onClick={onCancel}><ArrowLeft className="w-4 h-4" /> Reembolsos</button>
      <h1 className="text-xl font-bold">Pedir reembolso</h1>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">1. O que você comprou</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {itens.map((it, k) => (
            <div key={k} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-12 sm:col-span-6"><Campo label={k === 0 ? "Descrição" : ""} obrig={k === 0}><Input value={it.descricao} onChange={(e) => setItem(k, { descricao: e.target.value })} placeholder="Ex.: 2 sacos de gelo" /></Campo></div>
              <div className="col-span-5 sm:col-span-3"><Campo label={k === 0 ? "Data da compra" : ""}><Input type="date" value={it.data} max={hoje()} onChange={(e) => setItem(k, { data: e.target.value })} /></Campo></div>
              <div className="col-span-5 sm:col-span-2"><Campo label={k === 0 ? "Valor (R$)" : ""} obrig={k === 0}><Input inputMode="decimal" value={it.valor} onChange={(e) => setItem(k, { valor: e.target.value })} placeholder="0,00" /></Campo></div>
              <div className="col-span-2 sm:col-span-1 flex justify-end">
                {itens.length > 1 && <button className="h-10 w-10 grid place-items-center text-red-600" aria-label="Remover item" onClick={() => setItens(itens.filter((_, i) => i !== k))}><Trash2 className="w-4 h-4" /></button>}
              </div>
            </div>
          ))}
          <div className="flex justify-between items-center">
            <Button variant="outline" size="sm" onClick={() => setItens([...itens, { descricao: "", data: hoje(), valor: "" }])}><Plus className="w-4 h-4 mr-1" /> Outro item</Button>
            <span className="text-sm">Total: <b className="text-base">{BRL(total)}</b></span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">2. Comprovante <span className="text-red-600">*</span></CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => refCam.current?.click()} disabled={preparando}><Camera className="w-4 h-4 mr-1" /> Tirar foto</Button>
            <Button variant="outline" onClick={() => refArq.current?.click()} disabled={preparando}><Paperclip className="w-4 h-4 mr-1" /> Anexar arquivo</Button>
            <input ref={refCam} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { adicionarArquivos(e.target.files); e.target.value = ""; }} />
            <input ref={refArq} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={(e) => { adicionarArquivos(e.target.files); e.target.value = ""; }} />
            {preparando && <span className="text-sm text-muted-foreground self-center">Preparando foto…</span>}
          </div>
          {arquivos.length > 0 ? (
            <div className="flex gap-2 flex-wrap">{arquivos.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs max-w-[240px]">
                {f.type.startsWith("image/") ? <img src={URL.createObjectURL(f)} alt="" className="w-8 h-8 object-cover rounded" /> : <FileText className="w-4 h-4" />}
                <span className="truncate">{f.name}</span>
                <button className="text-red-600 ml-1" aria-label="Remover" onClick={() => setArquivos(arquivos.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}</div>
          ) : <p className="text-xs text-muted-foreground">Foto da nota fiscal, cupom ou recibo. Obrigatório.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">3. Para o Contas a Pagar</CardTitle></CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
          <Campo label="Empresa (instância)" obrig>
            <select className={selCls} value={instancia} onChange={(e) => setInstancia(e.target.value)} data-testid="select-instancia">
              <option value="">Selecione…</option>{cfg.instancias.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Campo>
          <Campo label="Pagar até (vencimento)" obrig><Input type="date" value={vencimento} min={hoje()} onChange={(e) => setVencimento(e.target.value)} /></Campo>
          <Campo label="Observação"><Input value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Opcional" /></Campo>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">4. Como você quer receber</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex gap-2 flex-wrap">
            {Object.entries(FORMA_LABEL).map(([k, l]) => (
              <button key={k} onClick={() => setForma(k)} className={`h-10 px-4 rounded-full border text-sm font-semibold ${forma === k ? "bg-green-700 text-white border-green-700" : "bg-white"}`}>{l}</button>
            ))}
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Campo label="Favorecido (nome)" obrig><Input value={favNome} onChange={(e) => setFavNome(e.target.value)} /></Campo>
            <Campo label="CPF/CNPJ do favorecido"><Input value={favDoc} onChange={(e) => setFavDoc(e.target.value)} placeholder="000.000.000-00" /></Campo>
            {forma === "pix" && (<>
              <Campo label="Tipo de chave PIX"><select className={selCls} value={pixTipo} data-testid="select-pix-tipo" onChange={(e) => { const t = e.target.value; setPixTipo(t); setPixChave((k) => PIX_REGRA[t].limpar(k)); }}>{PIX_TIPOS.map((t) => <option key={t}>{t}</option>)}</select></Campo>
              <Campo label="Chave PIX" obrig dica={PIX_REGRA[pixTipo].dica}>
                <Input value={pixChave} inputMode={PIX_REGRA[pixTipo].modo} placeholder={PIX_REGRA[pixTipo].placeholder} data-testid="input-pix-chave"
                  onChange={(e) => setPixChave(PIX_REGRA[pixTipo].limpar(e.target.value))}
                  className={pixChave && !PIX_REGRA[pixTipo].valido(pixChave) ? "border-red-500 focus-visible:ring-red-500" : ""} />
                {pixChave && !PIX_REGRA[pixTipo].valido(pixChave) && <span className="text-[11px] font-semibold text-red-600">{pixTipo === "CPF" || pixTipo === "CNPJ" ? `${pixTipo} inválido — confira os números` : "Formato inválido para o tipo escolhido"}</span>}
              </Campo>
            </>)}
            {forma === "transferencia" && (<>
              <Campo label="Banco" obrig><Input value={banco} onChange={(e) => setBanco(e.target.value)} placeholder="Ex.: 001 Banco do Brasil" /></Campo>
              <Campo label="Tipo de conta"><select className={selCls} value={tipoConta} onChange={(e) => setTipoConta(e.target.value)}><option>Corrente</option><option>Poupança</option></select></Campo>
              <Campo label="Agência" obrig><Input value={agencia} onChange={(e) => setAgencia(e.target.value)} /></Campo>
              <Campo label="Conta (com dígito)" obrig><Input value={conta} onChange={(e) => setConta(e.target.value)} /></Campo>
            </>)}
          </div>
          {forma === "dinheiro" && <p className="text-xs text-muted-foreground">Você recebe em dinheiro pela Caixinha.</p>}
        </CardContent>
      </Card>

      <div className="flex justify-between items-center gap-3 flex-wrap">
        <span className="text-xs text-muted-foreground">{faltando.length ? `Falta: ${faltando.join(", ")}.` : "Tudo certo. Vai para aprovação de um Admin (Flávio, Elbber ou Cinthia)."}</span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel}>Cancelar</Button>
          <Button onClick={enviar} disabled={enviando || preparando} data-testid="button-enviar-reembolso">{enviando ? "Enviando…" : `Enviar pedido de ${BRL(total)}`}</Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------- Detalhe -------------------------------------
function DetalheReembolso({ id, cfg, onBack, recarregar, erro }: { id: string; cfg: Cfg; onBack: () => void; recarregar: () => void; erro: (e: any) => void }) {
  const { toast } = useToast();
  const { data: r, isLoading, refetch } = useQuery<Detalhe>({ queryKey: ["/api/reembolsos", id], queryFn: () => apiRequest("GET", `/api/reembolsos/${id}`) });
  const [etapa, setEtapa] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [aj, setAj] = useState<{ valor?: string; categoria?: string; vencimento?: string; instancia?: string }>({});
  const [motivo, setMotivo] = useState("");
  if (isLoading || !r) return <div className="p-6 text-sm text-muted-foreground">Carregando…</div>;
  const atual = etapa ?? etapaDe(r.status);
  const acao = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); toast({ title: ok }); recarregar(); await refetch(); setEtapa(null); setAj({}); } catch (e) { erro(e); } finally { setBusy(false); }
  };
  const souSolicitante = r.solicitanteId === cfg.me.id;
  const val = aj.valor ?? String(r.valorAprovado ?? r.valor);
  const cat = aj.categoria ?? (r.chartAccountId || "");
  const venc = aj.vencimento ?? r.vencimento;
  const inst = aj.instancia ?? (r.instancia || "");
  const pagamento = r.forma === "pix" ? `PIX${r.pixTipo ? ` (${r.pixTipo})` : ""}: ${r.pixChave}` : r.forma === "transferencia" ? `${r.banco} · ag ${r.agencia} · ${r.tipoConta || "conta"} ${r.conta}` : "Dinheiro (Caixinha)";

  const Ajustes = ({ comValor, comCategoria }: { comValor: boolean; comCategoria: boolean }) => ( // chamado como função (não <Ajustes/>) para não perder o foco ao digitar
    <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
      {comValor && <Campo label="Valor aprovado (R$)"><Input inputMode="decimal" value={val} onChange={(e) => setAj({ ...aj, valor: e.target.value })} /></Campo>}
      {comCategoria && <Campo label="Categoria (DRE)" obrig>
        <select className={selCls} value={cat} data-testid="select-categoria-lancar" onChange={(e) => setAj({ ...aj, categoria: e.target.value })}>
          <option value="">Selecione…</option>{cfg.categorias.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
        </select>
        {!cat && <span className="text-[11px] font-semibold text-red-600">Obrigatória para lançar no Contas a Pagar</span>}
      </Campo>}
      <Campo label="Vencimento" obrig><Input type="date" value={venc} onChange={(e) => setAj({ ...aj, vencimento: e.target.value })} /></Campo>
      <Campo label="Empresa (instância)" obrig>
        <select className={selCls} value={inst} onChange={(e) => setAj({ ...aj, instancia: e.target.value })}>
          {cfg.instancias.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
      </Campo>
    </div>
  );

  const Resumo = () => (
    <div className="grid md:grid-cols-2 gap-4">
      <div>
        <Linha k="Solicitante" v={r.solicitanteNome} />
        {r.itens.map((i) => <Linha key={i.id} k={`${i.descricao}${i.data ? ` · ${DT(i.data)}` : ""}`} v={BRL(i.valor)} />)}
        <Linha k="Total pedido" v={<b>{BRL(r.valor)}</b>} />
        {r.valorAprovado != null && <Linha k="Aprovado" v={<b>{BRL(r.valorAprovado)}</b>} />}
        {r.obs && <Linha k="Observação" v={r.obs} />}
      </div>
      <div>
        <Linha k="Favorecido" v={`${r.favorecidoNome}${r.favorecidoDoc ? ` · ${r.favorecidoDoc}` : ""}`} />
        <Linha k="Receber por" v={pagamento} />
        <Linha k="Pagar até" v={DT(r.vencimento)} />
        <Linha k="Empresa" v={r.instancia || "—"} />
        {cfg.financeiro && <Linha k="Categoria DRE" v={r.categoriaNome || "a definir no lançamento"} />}
      </div>
    </div>
  );
  const Comprovantes = () => (
    <div className="flex gap-2 flex-wrap">{r.anexos.map((a) => (
      <a key={a.id} href={`/api/reembolsos/anexos/${a.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs max-w-[240px] hover:underline">
        {a.mime?.startsWith("image/") ? <img src={`/api/reembolsos/anexos/${a.id}`} alt="" className="w-10 h-10 object-cover rounded" /> : <FileText className="w-4 h-4" />}
        <span className="truncate">{a.nome}</span>
      </a>
    ))}</div>
  );

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto grid gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1" onClick={onBack}><ArrowLeft className="w-4 h-4" /> Reembolsos</button>
        <div className="flex items-center gap-2"><b>{r.codigo}</b><Pill status={r.status} />{r.autoaprovado && <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-amber-100 text-amber-900">⚠ Autoaprovado</span>}</div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {ETAPAS.map((e, i) => (
          <button key={e} onClick={() => setEtapa(i)} className={`rounded-lg border px-3 py-2 text-left text-sm ${atual === i ? "border-emerald-600 ring-2 ring-emerald-100" : ""}`}>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Etapa {i + 1}</div>
            <div className="font-semibold">{i < etapaDe(r.status) || r.status === "pago" ? "✓ " : ""}{e}</div>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-lg">{ETAPAS[atual]}</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          {atual === 0 && (<>
            <Resumo /><Comprovantes />
            {r.status === "cancelado" && <p className="text-sm text-gray-700">Pedido cancelado pelo solicitante.</p>}
            {souSolicitante && r.status === "aguardando" && (
              <div><Button variant="outline" className="text-red-700" disabled={busy} onClick={() => { if (window.confirm(`Cancelar o pedido ${r.codigo}?`)) acao(() => apiRequest("POST", `/api/reembolsos/${r.id}/cancelar`), "Pedido cancelado"); }}>Cancelar pedido</Button></div>
            )}
          </>)}

          {atual === 1 && (<>
            <div className="rounded-lg border p-3"><Resumo /></div>
            <Comprovantes />
            {r.status === "aguardando" ? (cfg.aprovador ? (
              <div className="grid gap-3">
                {Ajustes({ comValor: true, comCategoria: false })}
                {souSolicitante && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">Este pedido é seu. Você pode aprovar, mas a aprovação fica registrada como <b>autoaprovação</b> no histórico e na auditoria.</p>}
                <div className="flex gap-2 flex-wrap items-center">
                  <Button disabled={busy} data-testid="button-aprovar" onClick={() => { if (souSolicitante && !window.confirm(`Autoaprovar o seu próprio pedido ${r.codigo}?\nFica registrado como AUTOAPROVADO para auditoria.`)) return; acao(() => apiRequest("POST", `/api/reembolsos/${r.id}/aprovar`, { valorAprovado: String(val).replace(",", "."), vencimento: venc, instancia: inst }), "Aprovado e enviado ao Financeiro"); }}>{souSolicitante ? "Autoaprovar e enviar ao Financeiro" : "Aprovar e enviar ao Financeiro"}</Button>
                </div>
                <div className="grid gap-2 rounded-lg border border-red-200 bg-red-50/40 p-3">
                  <Campo label="Motivo da recusa" obrig dica="Obrigatório para recusar. O solicitante vê este motivo.">
                    <textarea className="min-h-[64px] rounded-md border bg-background px-3 py-2 text-sm" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: comprovante ilegível, compra não autorizada…" data-testid="input-motivo-recusa" />
                  </Campo>
                  <div><Button variant="outline" className="text-red-700 border-red-300" disabled={busy || !motivo.trim()} data-testid="button-recusar"
                    onClick={() => acao(() => apiRequest("POST", `/api/reembolsos/${r.id}/recusar`, { motivo: motivo.trim() }), "Pedido recusado")}>Recusar pedido</Button></div>
                </div>
              </div>
            ) : <p className="text-sm text-muted-foreground">Aguardando aprovação de um Admin (Flávio, Elbber ou Cinthia).</p>) : (
              <p className="text-sm">{r.status === "recusado" ? <span className="text-red-700">Recusado por {r.aprovadorNome}{r.motivoRecusa ? `: ${r.motivoRecusa}` : "."}</span> : r.status === "cancelado" ? "Pedido cancelado." : <>Aprovado por {r.aprovadorNome}: {BRL(r.valorAprovado)}.{r.autoaprovado && <span className="ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-bold bg-amber-100 text-amber-900">⚠ Autoaprovado</span>}</>}</p>
            )}
          </>)}

          {atual === 2 && (["aprovado", "lancado", "pago"].includes(r.status) ? (<>
            <div className="max-w-xl">
              <Linha k="Fornecedor (favorecido)" v={r.favorecidoNome} />
              <Linha k="CPF/CNPJ" v={r.favorecidoDoc || "—"} />
              <Linha k="Título" v={r.codigo} />
              <Linha k="Emissão (data da despesa)" v={DT(r.dataDespesa)} />
              <Linha k="Valor" v={<b>{BRL(r.valorAprovado ?? r.valor)}</b>} />
              <Linha k="Forma de pagamento" v={FORMA_LABEL[r.forma] || r.forma} />
              <Linha k="Dados para pagar" v={pagamento} />
              <Linha k="Comprovantes" v={`${r.anexos.length} (vão anexados à conta)`} />
            </div>
            {r.status === "aprovado" && (cfg.financeiro ? (
              <div className="grid gap-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
                {Ajustes({ comValor: false, comCategoria: true })}
                <div className="flex gap-2 items-center flex-wrap">
                  <Button disabled={busy || !cat} className="bg-indigo-700 hover:bg-indigo-800 text-white" data-testid="button-lancar"
                    onClick={() => acao(() => apiRequest("POST", `/api/reembolsos/${r.id}/lancar`, { chartAccountId: cat, vencimento: venc, instancia: inst }), "Lançado no Contas a Pagar")}>
                    Lançar no Contas a Pagar</Button>
                  <span className="text-xs text-muted-foreground">Cria a conta a pagar com estes dados e anexa os comprovantes.</span>
                </div>
              </div>
            ) : <p className="text-sm text-muted-foreground">Aguardando o Financeiro lançar no Contas a Pagar.</p>)}
            {r.payable && (
              <p className="text-sm">✓ Lançado por {r.lancadoNome} · conta a pagar <b>{r.payable.titulo}</b>, venc. {DT(r.payable.vencimento)}, {BRL(r.payable.valor)} — situação: <b>{r.payable.status === "paga" ? "paga" : r.payable.status.replace("_", " ")}</b>.
                {cfg.financeiro && <> <a className="underline text-indigo-700" href="/financeiro">Abrir no Financeiro</a></>}</p>
            )}
          </>) : <p className="text-sm text-muted-foreground">Disponível depois da aprovação.</p>)}

          {atual === 3 && (
            r.status === "pago" ? <p className="text-sm text-emerald-700 font-semibold">✓ Reembolso pago{r.pagoEm ? ` em ${new Date(r.pagoEm).toLocaleDateString("pt-BR")}` : ""}.</p>
              : r.status === "lancado" ? <p className="text-sm text-muted-foreground">Lançado no Contas a Pagar. Fica como pago automaticamente quando o Financeiro der baixa na conta.</p>
                : <p className="text-sm text-muted-foreground">Disponível depois do lançamento no Contas a Pagar.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Histórico</CardTitle></CardHeader>
        <CardContent className="grid gap-1.5">
          {r.eventos.map((e, i) => (
            <div key={i} className="text-sm"><span className="text-muted-foreground">{new Date(String(e.em).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(e.em)) ? "" : "Z")).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span> · <b>{e.autor}</b>: {e.texto}</div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
