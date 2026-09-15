// Selo de canal: por onde a acao fala com o mundo. Mesmas cores/rotulos do servidor (mkt-canal.ts).
export const CANAL_COR: Record<string, string> = { whatsapp: "#16a34a", instagram: "#db2777", facebook: "#2563eb", google: "#ea580c", loja: "#0891b2", presencial: "#7c3aed", integra: "#6b7280" };
export const CANAL_NOME: Record<string, string> = { whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", google: "Google", loja: "Loja online", presencial: "Visita presencial", integra: "Só no Integra" };
export const CANAL_EMOJI: Record<string, string> = { whatsapp: "💬", instagram: "📸", facebook: "📘", google: "🔎", loja: "🛒", presencial: "🚗", integra: "⚙️" };

export function CanalBadge({ canal, via, quem, grande }: { canal?: string; via?: string | null; quem?: string; grande?: boolean }) {
  if (!canal) return null;
  const cor = CANAL_COR[canal] || "#6b7280";
  return (
    <span title={quem || ""} className={"inline-flex items-center gap-1 rounded-full border font-semibold " + (grande ? "px-2.5 py-0.5 text-xs" : "px-2 py-0 text-[11px]")}
      style={{ borderColor: cor, color: "#fff", background: cor }}>
      {CANAL_EMOJI[canal]} {CANAL_NOME[canal] || canal}
      {via && <span className="opacity-90 font-normal">+ {CANAL_NOME[via] || via}</span>}
    </span>
  );
}

/** Legenda fixa: o que cada cor significa. */
export function CanalLegenda() {
  return (
    <div className="flex flex-wrap gap-1 text-[11px] text-muted-foreground items-center">
      <span>Canais:</span>
      {(["whatsapp", "instagram", "facebook", "google", "loja", "presencial", "integra"] as const).map(c => <CanalBadge key={c} canal={c} />)}
    </div>
  );
}
