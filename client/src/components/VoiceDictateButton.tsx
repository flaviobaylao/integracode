// =============================================================================
//  INTEGRA 2.0 — Ditado por voz CONFIÁVEL (áudio → texto)
//  Grava o microfone com MediaRecorder e transcreve no servidor (Whisper via
//  /api/change-requests/transcribe). Funciona em QUALQUER navegador com micro-
//  fone — inclusive iPhone/Safari, onde a Web Speech API (usada antes em vários
//  campos) simplesmente não existe e o "Gravar áudio" não gerava texto nenhum.
//  Uso do hook:
//    const voz = useVoiceToText({ onError, onEmpty });
//    voz.toggle((txt) => setCampo((p) => (p ? p.trim() + " " : "") + txt));
//  Uso do botão pronto:
//    <VoiceDictateButton onText={(txt) => setCampo((p) => (p ? p.trim() + " " : "") + txt)} />
// =============================================================================
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Square, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function useVoiceToText(opts?: { onError?: (msg: string) => void; onEmpty?: () => void }) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cbRef = useRef<(t: string) => void>(() => {});

  const start = async (onText: (t: string) => void) => {
    cbRef.current = onText;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        try { stream.getTracks().forEach((tk) => tk.stop()); } catch {}
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        const dataUrl: string = await new Promise((res) => {
          const rd = new FileReader();
          rd.onloadend = () => res(String(rd.result));
          rd.readAsDataURL(blob);
        });
        setTranscribing(true);
        try {
          const resp = await apiRequest("POST", "/api/change-requests/transcribe", { audio: dataUrl });
          const txt = resp && resp.text ? String(resp.text).trim() : "";
          if (txt) cbRef.current(txt);
          else opts?.onEmpty?.();
        } catch (e: any) {
          opts?.onError?.(e?.message || "Falha na transcrição.");
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      mrRef.current = mr;
      setRecording(true);
    } catch (e: any) {
      opts?.onError?.(e?.message || "Não foi possível acessar o microfone.");
    }
  };

  const stop = () => { try { mrRef.current?.stop(); } catch {} setRecording(false); };
  const toggle = (onText: (t: string) => void) => { if (recording) stop(); else start(onText); };

  return { recording, transcribing, start, stop, toggle };
}

export function VoiceDictateButton({
  onText,
  label = "Gravar áudio",
  size = "sm",
  className,
  disabled,
  testId,
}: {
  onText: (t: string) => void;
  label?: string;
  size?: "sm" | "default" | "lg" | "icon";
  className?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const { toast } = useToast();
  const voz = useVoiceToText({
    onError: (m) => toast({ title: "Falha na transcrição", description: m, variant: "destructive" }),
    onEmpty: () => toast({ title: "Nada transcrito", description: "Não consegui entender o áudio. Tente de novo." }),
  });
  return (
    <span className="inline-flex items-center gap-2">
      {!voz.recording ? (
        <Button
          type="button"
          size={size as any}
          variant="outline"
          className={`gap-1 ${className || ""}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); voz.start(onText); }}
          disabled={disabled || voz.transcribing}
          data-testid={testId}
        >
          {voz.transcribing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
          {voz.transcribing ? "transcrevendo…" : label}
        </Button>
      ) : (
        <Button
          type="button"
          size={size as any}
          variant="destructive"
          className="gap-1"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); voz.stop(); }}
        >
          <Square className="h-3.5 w-3.5" /> Parar
        </Button>
      )}
      {voz.recording && <span className="text-xs text-red-600 animate-pulse">gravando…</span>}
    </span>
  );
}
