// Abre o atendimento no UMBLER TALK (canal oficial) para um telefone, no mesmo padrão da Rota do Dia:
// leva o número (com 55) na busca do Umbler e copia para a área de transferência — se o Umbler não
// cair direto no contato pelo parâmetro, é só colar na busca. Reaproveita a mesma aba do Umbler.

export function numeroUmbler(phone: string | null | undefined): string {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits && !digits.startsWith("55") && (digits.length === 10 || digits.length === 11) ? "55" + digits : digits;
}

export function urlUmbler(phone: string | null | undefined): string {
  const n = numeroUmbler(phone);
  return n ? `https://app-utalk.umbler.com/?search=${encodeURIComponent(n)}` : "https://app-utalk.umbler.com/";
}

export async function abrirNoUmbler(phone: string | null | undefined, toast?: (t: { title: string; description?: string }) => void) {
  const n = numeroUmbler(phone);
  try { if (n && (navigator as any).clipboard) await (navigator as any).clipboard.writeText(n); } catch { /* sem permissão: segue */ }
  window.open(urlUmbler(phone), "umbler-central-atendimento");
  toast?.({ title: "Umbler aberto", description: n ? "Número copiado — se não abrir direto no contato, cole na busca do Umbler." : "Localize o contato pela busca do Umbler." });
}
