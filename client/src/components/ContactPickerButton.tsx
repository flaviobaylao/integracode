import { useEffect, useMemo, useRef, useState } from "react";
import { BookUser, MessageCircle, Search, Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

/**
 * 📇 BUSCAR CONTATO (nov/2026) — botão ao lado de Telefone + Responsável.
 *  • Android (Chrome/Samsung): abre a AGENDA do celular (Contact Picker). Só o contato escolhido
 *    vem para o Integra; o celular pede a permissão na hora.
 *  • iPhone: o Safari tem o recurso desligado por padrão → mostra o passo a passo para habilitar.
 *  • Computador: "Buscar no WhatsApp" — conversas guardadas, agenda do Integra e Umbler.
 * Devolve { nome, telefone } formatado em onPick. Nunca grava nada sozinho.
 */
export type ContatoEscolhido = { nome: string; telefone: string };

const fmtTel = (v: any): string => {
  let d = String(v ?? "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  return String(v ?? "").trim();
};

function plataforma() {
  if (typeof navigator === "undefined") return { picker: false, ios: false, mobile: false };
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
  const mobile = ios || /Android|Mobile/i.test(ua);
  const picker = !!((navigator as any).contacts && typeof (navigator as any).contacts.select === "function");
  return { picker, ios, mobile };
}

export default function ContactPickerButton({
  onPick,
  size = "sm",
  className = "",
  label,
}: {
  onPick: (c: ContatoEscolhido) => void;
  size?: "sm" | "default";
  className?: string;
  label?: string;
}) {
  const { toast } = useToast();
  const p = useMemo(plataforma, []);
  const [ajudaIOS, setAjudaIOS] = useState(false);
  const [escolherNumero, setEscolherNumero] = useState<{ nome: string; tels: string[] } | null>(null);
  const [buscaAberta, setBuscaAberta] = useState(false);

  const abrirAgenda = async () => {
    try {
      const sel: any[] = await (navigator as any).contacts.select(["name", "tel"], { multiple: false });
      if (!sel || !sel.length) return; // cancelou
      const c = sel[0] || {};
      const nome = String((Array.isArray(c.name) ? c.name[0] : c.name) || "").trim();
      const tels = Array.from(new Set(((c.tel || []) as string[]).map((t) => String(t || "").trim()).filter(Boolean)));
      if (!tels.length) {
        toast({ title: "Contato sem telefone", description: "Escolha um contato que tenha número.", variant: "destructive" });
        return;
      }
      if (tels.length > 1) { setEscolherNumero({ nome, tels }); return; }
      onPick({ nome, telefone: fmtTel(tels[0]) });
    } catch (e: any) {
      toast({ title: "Não foi possível abrir a agenda", description: e?.message || "Permissão negada ou recurso indisponível.", variant: "destructive" });
    }
  };

  const clique = () => {
    if (p.picker) return void abrirAgenda();
    if (p.ios) return setAjudaIOS(true);
    setBuscaAberta(true);
  };

  const mostraAgenda = p.picker || p.ios;
  const texto = label || (mostraAgenda ? "Agenda" : "Buscar no WhatsApp");
  const Icone = mostraAgenda ? BookUser : MessageCircle;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        className={`gap-1 ${className}`}
        onClick={clique}
        title={mostraAgenda ? "Buscar nome e telefone na agenda do celular" : "Buscar nome e telefone nas conversas de WhatsApp (Umbler)"}
        data-testid="button-buscar-contato"
      >
        <Icone className="h-4 w-4" /> {texto}
      </Button>

      {/* iPhone: passo a passo para habilitar a agenda no Safari */}
      <Dialog open={ajudaIOS} onOpenChange={setAjudaIOS}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Smartphone className="h-5 w-5" /> Habilitar a agenda no iPhone</DialogTitle>
            <DialogDescription>
              No iPhone, o acesso à agenda pelo navegador vem desligado. Faça uma vez:
            </DialogDescription>
          </DialogHeader>
          <ol className="list-decimal pl-5 space-y-2 text-sm">
            <li>Abra <b>Ajustes</b> → <b>Apps</b> → <b>Safari</b> → <b>Avançado</b> → <b>Feature Flags</b>.<br /><span className="text-muted-foreground text-xs">(Em versões mais antigas do iOS: Ajustes → Safari → Avançado → Recursos Experimentais.)</span></li>
            <li>Ative <b>Contact Picker API</b>.</li>
            <li>Volte ao Integra <b>pelo Safari</b> e toque de novo em <b>Agenda</b>.</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Funciona só no Safari (o Chrome do iPhone não usa esse ajuste). É um recurso experimental da Apple e pode mudar
            numa atualização do iOS — o preenchimento manual continua disponível.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => { setAjudaIOS(false); setBuscaAberta(true); }}>
              <MessageCircle className="h-4 w-4 mr-1" /> Buscar no WhatsApp
            </Button>
            <Button type="button" onClick={() => setAjudaIOS(false)}>Entendi</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Contato com mais de um número: escolhe qual usar */}
      <Dialog open={!!escolherNumero} onOpenChange={(o) => { if (!o) setEscolherNumero(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Qual número usar?</DialogTitle>
            <DialogDescription>{escolherNumero?.nome || "Contato"} tem mais de um telefone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {(escolherNumero?.tels || []).map((t) => (
              <Button key={t} type="button" variant="outline" className="w-full justify-start"
                onClick={() => { const n = escolherNumero!.nome; setEscolherNumero(null); onPick({ nome: n, telefone: fmtTel(t) }); }}>
                {fmtTel(t)}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <BuscaWhatsApp
        open={buscaAberta}
        onClose={() => setBuscaAberta(false)}
        onPick={(c) => { setBuscaAberta(false); onPick(c); }}
      />
    </>
  );
}

function BuscaWhatsApp({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (c: ContatoEscolhido) => void }) {
  const [q, setQ] = useState("");
  const [itens, setItens] = useState<Array<{ telefone: string; responsavel: string; empresa: string; origem: string }>>([]);
  const [carregando, setCarregando] = useState(false);
  const [buscou, setBuscou] = useState(false);
  const seq = useRef(0);

  useEffect(() => { if (!open) { setQ(""); setItens([]); setBuscou(false); } }, [open]);

  useEffect(() => {
    if (!open) return;
    const termo = q.trim();
    const d = termo.replace(/\D/g, "");
    if (d.length < 4 && termo.length < 3) { setItens([]); setBuscou(false); return; }
    const meu = ++seq.current;
    const t = setTimeout(async () => {
      setCarregando(true);
      try {
        const r: any = await apiRequest("GET", `/api/contatos-whatsapp?q=${encodeURIComponent(termo)}`);
        if (meu === seq.current) { setItens(Array.isArray(r?.itens) ? r.itens : []); setBuscou(true); }
      } catch { if (meu === seq.current) { setItens([]); setBuscou(true); } }
      finally { if (meu === seq.current) setCarregando(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [q, open]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MessageCircle className="h-5 w-5 text-green-600" /> Buscar no WhatsApp</DialogTitle>
          <DialogDescription>
            Procura nas conversas de WhatsApp da Honest (Umbler) e na agenda do Integra. Digite parte do nome ou do número.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: Maria, Padaria Sol ou 62 99999" className="pl-9" data-testid="input-busca-whatsapp" />
        </div>
        <div className="max-h-80 overflow-y-auto divide-y">
          {carregando && <div className="flex items-center gap-2 text-sm text-muted-foreground py-3"><Loader2 className="h-4 w-4 animate-spin" /> Buscando…</div>}
          {!carregando && buscou && itens.length === 0 && <div className="text-sm text-muted-foreground py-3">Nada encontrado. Preencha manualmente.</div>}
          {!carregando && itens.map((it) => (
            <button key={it.telefone} type="button" className="w-full text-left py-2 px-1 hover:bg-muted/60 rounded"
              onClick={() => onPick({ nome: it.responsavel || "", telefone: fmtTel(it.telefone) })}
              data-testid={`item-busca-whatsapp-${it.telefone}`}>
              <div className="text-sm font-medium">{fmtTel(it.telefone)}{it.responsavel ? <span className="ml-2">· {it.responsavel}</span> : null}</div>
              <div className="text-xs text-muted-foreground">{it.empresa ? `${it.empresa} · ` : ""}{it.origem}{!it.responsavel ? " · sem nome de pessoa (preencha o responsável)" : ""}</div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
