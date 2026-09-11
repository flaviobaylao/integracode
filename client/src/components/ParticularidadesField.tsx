import { useVoiceToText } from "@/components/VoiceDictateButton";

// Campo de texto livre para PARTICULARIDADES do cliente, com ditado por voz
// (áudio → texto) via MediaRecorder + Whisper no servidor. Funciona em QUALQUER
// navegador com microfone — inclusive iPhone/Safari, onde a Web Speech API (usada
// antes) não existe e o botão de ditar não gerava texto nenhum. (set/2026)
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
  const voz = useVoiceToText();
  const append = (t: string) => onChange((value ? value.trim() + " " : "") + t);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
        <button
          type="button"
          onClick={() => voz.toggle(append)}
          disabled={voz.transcribing}
          data-testid="btn-ditar-particularidades"
          className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors disabled:opacity-60 ${
            voz.recording
              ? "bg-red-50 border-red-300 text-red-700 animate-pulse"
              : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          }`}
          title={voz.recording ? "Parar gravação" : "Falar para transcrever (pt-BR)"}
        >
          {voz.transcribing ? "Transcrevendo…" : voz.recording ? "● Gravando… (clique para parar)" : "🎤 Ditar"}
        </button>
      </div>
      <textarea
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        data-testid="textarea-particularidades"
        placeholder="Anote particularidades do cliente (horário de entrega, preferências, contato, forma de acesso, etc.). Toque em 🎤 Ditar para transcrever por voz."
        className="w-full px-3 py-2 border rounded-md text-sm bg-white dark:bg-gray-800 dark:border-gray-700"
      />
    </div>
  );
}
