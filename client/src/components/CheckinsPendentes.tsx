// Aviso de check-ins guardados no aparelho e ainda não enviados (fila offline).
// Em iOS não existe envio com o app fechado, então o vendedor precisa VER que há
// pendência antes de fechar o app. No Android some sozinho, em segundo plano.
import { useEffect, useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";
import { assinarPendencias, iniciarFilaCheckins, enviarPendentes } from "@/lib/offlineCheckins";

export default function CheckinsPendentes() {
  const [n, setN] = useState(0);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    iniciarFilaCheckins();
    return assinarPendencias(setN);
  }, []);

  if (n <= 0) return null;

  const tentarAgora = async () => {
    setEnviando(true);
    try { await enviarPendentes(); } finally { setEnviando(false); }
  };

  return (
    <button
      type="button"
      onClick={tentarAgora}
      className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 shadow-lg dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
      style={{ bottom: `calc(16px + env(safe-area-inset-bottom, 0px))` }}
      title="Check-ins salvos no aparelho, aguardando internet. Toque para tentar enviar agora."
    >
      {enviando ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudOff className="w-4 h-4" />}
      {n === 1 ? "1 check-in aguardando envio" : `${n} check-ins aguardando envio`}
    </button>
  );
}
