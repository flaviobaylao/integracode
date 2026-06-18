import { useState, useEffect } from 'react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = 'pwa_install_dismissed_at';
const DISMISS_TTL_DAYS = 7;

export default function PWAInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Don't show if already dismissed recently
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      const daysSince = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24);
      if (daysSince < DISMISS_TTL_DAYS) return;
    }

    // Don't show if already installed (standalone mode)
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if ((window.navigator as any).standalone === true) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShow(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShow(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 md:left-auto md:right-6 md:w-80 animate-in slide-in-from-bottom-4 duration-300">
      <div className="bg-card border border-border rounded-2xl shadow-xl p-4 flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-honest-green/10 flex items-center justify-center shrink-0">
          <img src="/icons/icon.svg" alt="Integra" className="w-7 h-7" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-foreground">Instalar o Integra</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            Acesso rápido, funciona offline e sem abrir o navegador.
          </p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleInstall}
              className="flex-1 bg-honest-green text-white text-xs font-semibold py-1.5 px-3 rounded-lg hover:bg-honest-green/90 transition-colors"
            >
              Instalar
            </button>
            <button
              onClick={handleDismiss}
              className="flex-1 bg-muted text-muted-foreground text-xs font-medium py-1.5 px-3 rounded-lg hover:bg-muted/80 transition-colors"
            >
              Agora não
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-0.5"
          aria-label="Fechar"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
