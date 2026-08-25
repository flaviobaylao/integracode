import { useEffect, useRef, useState } from "react";

// Campo de texto livre para PARTICULARIDADES do cliente, com ditado por voz
// (transcrição de fala → texto) usando a Web Speech API do navegador (pt-BR).
// Funciona no Chrome/Edge; onde não houver suporte, o botão some e o usuário
// digita normalmente. Não depende de backend para transcrever.
export default function ParticularidadesField({
  value,
  onChange,
  label = "Particularidades do cliente",
  rows = 4,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  rows?: number;
}) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recRef = useRef<any>(null);
  const baseRef = useRef<string>("");

  useEffect(() => {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    const rec = new SR();
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let finalTxt = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalTxt += t;
        else interim += t;
      }
      if (finalTxt) {
        const prev = baseRef.current.replace(/\s*$/, "");
        baseRef.current = (prev ? prev + " " : "") + finalTxt.trim();
        onChange(baseRef.current);
      } else if (interim) {
        onChange((baseRef.current ? baseRef.current + " " : "") + interim);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    return () => {
      try {
        rec.stop();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) {
      try {
        rec.stop();
      } catch {}
      setListening(false);
      return;
    }
    baseRef.current = value || "";
    try {
      rec.start();
      setListening(true);
    } catch {}
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
        {supported && (
          <button
            type="button"
            onClick={toggle}
            data-testid="btn-ditar-particularidades"
            className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors ${
              listening
                ? "bg-red-50 border-red-300 text-red-700 animate-pulse"
                : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            }`}
            title={listening ? "Parar gravação" : "Falar para transcrever (pt-BR)"}
          >
            {listening ? "● Gravando… (clique para parar)" : "🎤 Ditar"}
          </button>
        )}
      </div>
      <textarea
        value={value || ""}
        onChange={(e) => {
          baseRef.current = e.target.value;
          onChange(e.target.value);
        }}
        rows={rows}
        data-testid="textarea-particularidades"
        placeholder="Anote particularidades do cliente (horário de entrega, preferências, contato, forma de acesso, etc.). Toque em 🎤 Ditar para transcrever por voz."
        className="w-full px-3 py-2 border rounded-md text-sm bg-white dark:bg-gray-800 dark:border-gray-700"
      />
      {!supported && (
        <p className="text-[11px] text-gray-400 mt-1">
          Ditado por voz não é suportado neste navegador — digite o texto normalmente.
        </p>
      )}
    </div>
  );
}
