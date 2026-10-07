import { useState } from "react";
import { Copy, Check } from "lucide-react";

/**
 * Botãozinho de copiar (nome do cliente etc.). Copia `text` para a área de
 * transferência e mostra um "check" por ~1,2s. Não depende de toast e não
 * dispara o clique da linha (stopPropagation).
 */
export default function CopyButton({
  text,
  title = "Copiar nome",
  className = "",
}: {
  text?: string | null;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const value = String(text);
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback para contextos sem Clipboard API.
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      } catch {
        /* noop */
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title={title}
      aria-label={title}
      className={`shrink-0 inline-flex align-middle text-muted-foreground hover:text-primary transition-colors ${className}`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
