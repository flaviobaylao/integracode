// ============================================================================
// LINK DE PAGAMENTO NO CARTAO — dialog usado pelas telas do VENDEDOR
// ----------------------------------------------------------------------------
// Regra (Flavio, 25/ago/2026): sempre que o vendedor escolher CARTAO para o
// pagamento de um pedido, o sistema disponibiliza o LINK de pagamento. O link
// leva o cliente ao ambiente de pagamento (Cielo Link & Checkout, MATRIZ) e,
// assim que o pagamento e aprovado, o servidor:
//   1) confirma o pedido ao cliente (WhatsApp);
//   2) marca o badge PAGO no pipeline de faturamento;
//   3) da a baixa do titulo no Contas a Receber ao faturar.
// Nada disso acontece aqui no front — esta tela so cria/mostra/reenvia o link e
// acompanha o estado. A confirmacao e sempre do servidor (webhook da Cielo).
// ============================================================================
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { CreditCard, Copy, ExternalLink, Send, CheckCircle2, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';

interface PaymentLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pedido (sales_card). O VALOR do link e sempre o do pedido, definido no servidor. */
  salesCardId: string | null | undefined;
  customerName?: string | null;
  orderNumber?: string | null;
  /** Somente exibicao enquanto o servidor nao responde. */
  amountHint?: number | null;
  /** Manda o link por WhatsApp assim que ele e criado (padrao: sim). */
  autoSendWhatsapp?: boolean;
}

interface LinkState {
  url: string;
  amount: number;
  token: string;
  reused?: boolean;
  customerPhone?: string | null;
  whatsapp?: { sent: boolean; to?: string; error?: string };
}

function brl(v: any): string {
  const n = Number(v);
  return isNaN(n) ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function PaymentLinkDialog({
  open,
  onOpenChange,
  salesCardId,
  customerName,
  orderNumber,
  amountHint,
  autoSendWhatsapp = true,
}: PaymentLinkDialogProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pago, setPago] = useState(false);
  const [reenviando, setReenviando] = useState(false);
  const criadoRef = useRef<string | null>(null);

  // ----------------------------------------------------------- criar o link
  useEffect(() => {
    if (!open || !salesCardId) return;
    if (criadoRef.current === salesCardId) return; // nao recria ao reabrir o mesmo pedido
    criadoRef.current = salesCardId;
    setLoading(true);
    setErro(null);
    setLink(null);
    setQr(null);
    setPago(false);

    (async () => {
      try {
        const resp = await fetch('/api/payment-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            salesCardId,
            channel: 'vendedor',
            sendWhatsapp: !!autoSendWhatsapp,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.url) {
          // "pedido ja pago" nao e erro: e o estado final desejado.
          if (String(data?.message || '').toLowerCase().includes('ja pago')) {
            setPago(true);
            setErro(null);
          } else {
            setErro(data?.message || `Nao foi possivel gerar o link (HTTP ${resp.status}).`);
          }
          return;
        }
        setLink(data as LinkState);
        try {
          setQr(await QRCode.toDataURL(data.url, { width: 320, margin: 1 }));
        } catch { /* QR e conveniencia; o link continua valendo */ }
        if (data.whatsapp && !data.whatsapp.sent) {
          toast({
            title: 'Link gerado, mas nao enviado por WhatsApp',
            description: data.whatsapp.error || 'Mostre o QR Code ou copie o link para o cliente.',
          });
        }
      } catch (e: any) {
        setErro(e?.message || 'Falha de rede ao gerar o link.');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, salesCardId, autoSendWhatsapp, toast]);

  // Ao fechar, libera para gerar de novo numa proxima abertura de outro pedido.
  useEffect(() => { if (!open) criadoRef.current = null; }, [open]);

  // ------------------------------------------- acompanhar ate o pagamento
  useEffect(() => {
    if (!open || !salesCardId || pago) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/payment-links/order/${salesCardId}`, { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (d?.paid) {
          setPago(true);
          toast({
            title: 'Pagamento aprovado!',
            description: 'O pedido foi confirmado ao cliente e ja consta como PAGO no pipeline.',
          });
        }
      } catch { /* poll silencioso */ }
    }, 6000);
    return () => clearInterval(t);
  }, [open, salesCardId, pago, toast]);

  const copiar = async () => {
    if (!link?.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast({ title: 'Link copiado', description: 'Cole na conversa com o cliente.' });
    } catch {
      toast({ title: 'Nao consegui copiar', description: link.url, variant: 'destructive' });
    }
  };

  const reenviar = async () => {
    if (!link?.token) return;
    setReenviando(true);
    try {
      const r = await fetch(`/api/payment-links/${link.token}/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.sent) toast({ title: 'Link reenviado', description: `WhatsApp para ${d.to}` });
      else toast({ title: 'Nao foi possivel reenviar', description: d?.message || d?.error || 'Tente copiar o link.', variant: 'destructive' });
    } catch (e: any) {
      toast({ title: 'Falha ao reenviar', description: e?.message || '', variant: 'destructive' });
    } finally {
      setReenviando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-payment-link">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-blue-600" />
            Pagamento no cartao
          </DialogTitle>
          <DialogDescription>
            {customerName ? `${customerName} — ` : ''}
            {orderNumber ? `pedido ${orderNumber}` : 'link de pagamento do pedido'}
          </DialogDescription>
        </DialogHeader>

        {/* ------------------------------------------------------ PAGO */}
        {pago && (
          <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-center" data-testid="pay-link-paid">
            <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
            <p className="mt-2 font-semibold text-green-800">Pagamento aprovado</p>
            <p className="mt-1 text-sm text-green-700">
              O pedido foi confirmado ao cliente, o badge <strong>PAGO</strong> ja aparece no pipeline e
              o titulo nasce quitado no Contas a Receber ao faturar.
            </p>
            <Button className="mt-4 w-full" onClick={() => onOpenChange(false)}>Fechar</Button>
          </div>
        )}

        {/* --------------------------------------------------- CARREGANDO */}
        {!pago && loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Gerando o link na Cielo...
          </div>
        )}

        {/* --------------------------------------------------------- ERRO */}
        {!pago && !loading && erro && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid="pay-link-error">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div className="text-sm text-amber-800">
                <p className="font-medium">Nao foi possivel gerar o link</p>
                <p className="mt-1">{erro}</p>
                <p className="mt-2 text-xs">
                  O pedido continua salvo. Voce pode gerar o link depois pelo card do pedido no
                  Pipeline de Faturamento.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => { criadoRef.current = null; onOpenChange(false); }}
            >
              Fechar
            </Button>
          </div>
        )}

        {/* ---------------------------------------------------------- LINK */}
        {!pago && !loading && link && (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted p-3 text-center">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Valor do pedido</p>
              <p className="text-2xl font-bold" data-testid="pay-link-amount">{brl(link.amount ?? amountHint)}</p>
              <p className="text-xs text-muted-foreground">cartao de credito, a vista (1x)</p>
            </div>

            {qr && (
              <div className="flex flex-col items-center gap-1">
                <img src={qr} alt="QR Code do link de pagamento" className="h-44 w-44 rounded border bg-white p-1" data-testid="pay-link-qr" />
                <p className="text-xs text-muted-foreground">o cliente aponta a camera para pagar</p>
              </div>
            )}

            <div className="break-all rounded border bg-background p-2 text-xs" data-testid="pay-link-url">{link.url}</div>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={copiar} data-testid="button-copy-link">
                <Copy className="mr-2 h-4 w-4" /> Copiar
              </Button>
              <Button variant="outline" onClick={() => window.open(link.url, '_blank', 'noopener')} data-testid="button-open-link">
                <ExternalLink className="mr-2 h-4 w-4" /> Abrir
              </Button>
            </div>

            <div className="flex items-center justify-between rounded border p-2 text-xs">
              <span className="flex items-center gap-1">
                {link.whatsapp?.sent ? (
                  <><Send className="h-3.5 w-3.5 text-green-600" /> enviado para {link.whatsapp.to}</>
                ) : (
                  <><AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> {link.whatsapp?.error || 'nao enviado por WhatsApp'}</>
                )}
              </span>
              <Button size="sm" variant="ghost" onClick={reenviar} disabled={reenviando} data-testid="button-resend-link">
                {reenviando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                <span className="ml-1">Reenviar</span>
              </Button>
            </div>

            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Aguardando o pagamento — esta tela confirma sozinha
              {link.reused && <Badge variant="outline" className="ml-1">link ja existente</Badge>}
            </div>

            <Button variant="secondary" className="w-full" onClick={() => onOpenChange(false)}>
              Fechar (o link continua valido)
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
