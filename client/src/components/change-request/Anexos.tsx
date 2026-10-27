// =============================================================================
//  📎 Anexos da conversa do report (27/out/2026)
//  - AnexosPicker: botão "Anexar" (imagens e arquivos) + colar imagem (Ctrl+V) no box
//    de resposta, com miniaturas e remover antes de enviar.
//  - AnexosMensagem: mostra os anexos de uma mensagem (miniatura para imagem, link para
//    os demais). O binário vem de GET /api/change-requests/anexo/:id.
//  Imagens grandes são reduzidas no navegador (máx. 1600 px, JPEG) antes do envio.
// =============================================================================
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Paperclip, X, FileText } from "lucide-react";

export type AnexoNovo = { name: string; type: string; size: number; dataUrl: string };
export type AnexoSalvo = { id: string; name: string; mime: string; size: number };

export const ANEXO_ACCEPT = "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip,audio/*,video/mp4,video/quicktime,video/webm";
const MAX_QTD = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export function fmtTamanho(n: number) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function lerComoDataUrl(f: Blob): Promise<string> {
  return new Promise((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result || ""));
    r.onerror = () => erro(r.error);
    r.readAsDataURL(f);
  });
}

// Reduz fotos (máx. 1600 px no maior lado, JPEG 0,82). GIF e arquivos que o navegador não
// decodifica (ex.: HEIC no Windows) seguem como estão.
async function reduzirImagem(f: File): Promise<AnexoNovo> {
  const original = await lerComoDataUrl(f);
  const base = { name: f.name || "imagem.jpg", type: f.type, size: f.size, dataUrl: original };
  if (/gif/i.test(f.type)) return base;
  try {
    const img = await new Promise<HTMLImageElement>((ok, erro) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = erro;
      i.src = original;
    });
    const MAX = 1600;
    const esc = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    if (esc >= 1 && f.size < 1.5 * 1024 * 1024) return base;
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * esc);
    c.height = Math.round(img.naturalHeight * esc);
    const ctx = c.getContext("2d");
    if (!ctx) return base;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.82);
    const size = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
    if (size >= f.size) return base;
    const nome = (f.name || "imagem").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
    return { name: nome, type: "image/jpeg", size, dataUrl };
  } catch {
    return base;
  }
}

/** Converte arquivos escolhidos/colados em anexos prontos para envio. Devolve também avisos. */
export async function prepararAnexos(files: File[], jaTem: number): Promise<{ anexos: AnexoNovo[]; avisos: string[] }> {
  const anexos: AnexoNovo[] = [];
  const avisos: string[] = [];
  for (const f of files) {
    if (jaTem + anexos.length >= MAX_QTD) { avisos.push(`Máximo de ${MAX_QTD} anexos por mensagem.`); break; }
    if (/svg/i.test(f.type)) { avisos.push(`${f.name}: SVG não é aceito.`); continue; }
    const a = f.type.startsWith("image/") ? await reduzirImagem(f) : { name: f.name || "arquivo", type: f.type || "application/octet-stream", size: f.size, dataUrl: await lerComoDataUrl(f) };
    if (a.size > MAX_BYTES) { avisos.push(`${a.name} passa de 10 MB.`); continue; }
    anexos.push(a);
  }
  return { anexos, avisos };
}

/** Arquivos de imagem colados (Ctrl+V) num campo de texto. */
export function arquivosDoColar(e: React.ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean) as File[];
  return files.map((f, idx) => (f.name && f.name !== "image.png") ? f : new File([f], `print-${Date.now()}-${idx + 1}.png`, { type: f.type || "image/png" }));
}

export function AnexosPicker({ value, onAdd, onRemove, disabled, testId }: {
  value: AnexoNovo[];
  onAdd: (files: File[]) => void;
  onRemove: (idx: number) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={disabled || value.length >= MAX_QTD}
        onClick={() => ref.current?.click()} data-testid={testId || "cr-anexar"}
        title="Anexar imagens ou arquivos (até 5, 10 MB cada). Você também pode colar uma imagem (Ctrl+V) no campo de texto.">
        <Paperclip className="h-4 w-4 mr-1" /> Anexar
      </Button>
      <input ref={ref} type="file" multiple accept={ANEXO_ACCEPT} className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ""; if (fs.length) onAdd(fs); }} />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2 w-full">
          {value.map((a, i) => (
            <div key={i} className="relative flex items-center gap-1.5 rounded-md border bg-muted/40 pl-1 pr-6 py-1 text-xs max-w-[220px]">
              {a.type.startsWith("image/")
                ? <img src={a.dataUrl} alt={a.name} className="h-9 w-9 rounded object-cover" />
                : <FileText className="h-5 w-5 text-muted-foreground shrink-0" />}
              <div className="min-w-0">
                <div className="truncate">{a.name}</div>
                <div className="text-[10px] text-muted-foreground">{fmtTamanho(a.size)}</div>
              </div>
              <button type="button" className="absolute top-0.5 right-0.5 rounded p-0.5 hover:bg-muted" onClick={() => onRemove(i)} title="Remover anexo">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function AnexosMensagem({ anexos }: { anexos?: AnexoSalvo[] | null }) {
  const lista = Array.isArray(anexos) ? anexos.filter((a) => a && a.id) : [];
  if (lista.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {lista.map((a) => {
        const url = `/api/change-requests/anexo/${encodeURIComponent(a.id)}`;
        if (String(a.mime || "").startsWith("image/")) {
          return (
            <a key={a.id} href={url} target="_blank" rel="noopener noreferrer" title={a.name}>
              <img src={url} alt={a.name} loading="lazy" className="h-24 max-w-[160px] rounded border object-cover bg-white" />
            </a>
          );
        }
        return (
          <a key={a.id} href={url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded border bg-white/70 dark:bg-black/20 px-1.5 py-1 underline-offset-2 hover:underline max-w-[220px]" title={a.name}>
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{a.name}</span>
            <span className="opacity-70 shrink-0">{fmtTamanho(a.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
