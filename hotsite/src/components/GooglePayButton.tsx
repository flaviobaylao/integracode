import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';

declare global {
  interface Window { google?: any; }
}

type GPConfig = {
  enabled: boolean;
  environment: 'TEST' | 'PRODUCTION';
  merchantId: string;         // Merchant ID do Google Pay (Business Console)
  merchantName: string;
  gateway: string;            // 'cielo'
  gatewayMerchantId: string;  // Merchant ID da Cielo
  allowedCardNetworks: string[];
  allowedAuthMethods: string[];
};

function cardPaymentMethod(gp: GPConfig) {
  return {
    type: 'CARD',
    parameters: {
      allowedAuthMethods: gp.allowedAuthMethods,
      allowedCardNetworks: gp.allowedCardNetworks,
    },
    tokenizationSpecification: {
      type: 'PAYMENT_GATEWAY',
      parameters: { gateway: gp.gateway, gatewayMerchantId: gp.gatewayMerchantId },
    },
  };
}

function loadPayJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = 'https://pay.google.com/gp/p/js/pay.js';
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('pay.js'));
    document.head.appendChild(s);
  });
}

// Botao Google Pay (loja): so aparece quando o backend informa googlePay.enabled
// (Cielo configurada + Merchant ID do Google definido). Em aprovacao, manda o token
// para /orders/card/pay-googlepay, que repassa para a Cielo (mesma conta do cartao).
export function GooglePayButton({ order, onSuccess, onError }: {
  order: any;
  onSuccess: (r: any) => void;
  onError: (msg: string) => void;
}) {
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cfgRef = useRef<GPConfig | null>(null);
  const clientRef = useRef<any>(null);
  const payRef = useRef<() => void>(() => {});

  const doPay = async () => {
    const gp = cfgRef.current;
    const client = clientRef.current;
    if (!gp || !client || processing) return;
    setProcessing(true);
    try {
      const request = {
        apiVersion: 2,
        apiVersionMinor: 0,
        allowedPaymentMethods: [cardPaymentMethod(gp)],
        merchantInfo: { merchantId: gp.merchantId, merchantName: gp.merchantName },
        transactionInfo: {
          totalPriceStatus: 'FINAL',
          totalPrice: (Number(order?.totalAmount) || 0).toFixed(2),
          currencyCode: 'BRL',
          countryCode: 'BR',
        },
      };
      const paymentData = await client.loadPaymentData(request);
      const token = paymentData?.paymentMethodData?.tokenizationData?.token;
      if (!token) throw new Error('Token do Google Pay ausente');
      const r = await api.payGooglePay(order, token);
      onSuccess(r);
    } catch (e: any) {
      const code = String(e?.statusCode || e?.statusMessage || '').toUpperCase();
      if (code.includes('CANCEL')) { /* usuario cancelou — sem erro */ }
      else onError(e?.message || 'Pagamento Google Pay nao autorizado.');
    } finally {
      setProcessing(false);
    }
  };
  payRef.current = doPay;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg: any = await api.getCardConfig();
        const gp: GPConfig | undefined = cfg?.googlePay;
        if (!gp || !gp.enabled || !gp.merchantId || !gp.gatewayMerchantId) return;
        cfgRef.current = gp;
        await loadPayJs();
        if (cancelled || !window.google?.payments?.api) return;
        const client = new window.google.payments.api.PaymentsClient({ environment: gp.environment });
        clientRef.current = client;
        const rtp = await client.isReadyToPay({
          apiVersion: 2,
          apiVersionMinor: 0,
          allowedPaymentMethods: [cardPaymentMethod(gp)],
        });
        if (cancelled || !rtp?.result) return;
        setReady(true);
        setTimeout(() => {
          if (containerRef.current && containerRef.current.childElementCount === 0) {
            const button = client.createButton({
              onClick: () => payRef.current(),
              buttonType: 'pay',
              buttonSizeMode: 'fill',
              buttonColor: 'black',
              buttonLocale: 'pt',
            });
            containerRef.current.appendChild(button);
          }
        }, 0);
      } catch { /* se algo falhar, o botao simplesmente nao aparece */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return null;
  return (
    <div className="mb-4">
      <div ref={containerRef} style={{ minHeight: 48 }} />
      {processing && <p className="text-[11px] text-gray-400 text-center mt-1">Processando Google Pay...</p>}
      <div className="flex items-center gap-2 my-3">
        <div className="h-px bg-gray-200 flex-1" />
        <span className="text-[11px] text-gray-400">ou pague com cartao</span>
        <div className="h-px bg-gray-200 flex-1" />
      </div>
    </div>
  );
}
