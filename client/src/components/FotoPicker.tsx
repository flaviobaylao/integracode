import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Camera, ImageUp } from "lucide-react";

/**
 * 📷 Seletor de foto com DUAS opções (mobile e desktop):
 *  - "Câmera": input com capture="environment" → abre a câmera traseira na hora.
 *  - "Galeria / arquivo": input SEM capture → no celular abre a galeria/arquivos (upload).
 * Um único <input capture> no celular só abre a câmera, por isso os dois botões.
 */
export default function FotoPicker({
  onFile,
  disabled,
  testId = "foto",
  className = "",
  cameraLabel = "Câmera",
  galeriaLabel = "Galeria / arquivo",
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
  cameraLabel?: string;
  galeriaLabel?: string;
}) {
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // permite escolher o mesmo arquivo de novo
    if (f) onFile(f);
  };
  return (
    <div className={`grid grid-cols-2 gap-2 ${className}`}>
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handle} data-testid={`input-${testId}-camera`} />
      <input ref={galRef} type="file" accept="image/*" className="hidden" onChange={handle} data-testid={`input-${testId}-galeria`} />
      <Button type="button" variant="outline" disabled={disabled} onClick={(e) => { e.stopPropagation(); camRef.current?.click(); }} data-testid={`button-${testId}-camera`}>
        <Camera className="h-4 w-4 mr-1.5" /> {cameraLabel}
      </Button>
      <Button type="button" variant="outline" disabled={disabled} onClick={(e) => { e.stopPropagation(); galRef.current?.click(); }} data-testid={`button-${testId}-galeria`}>
        <ImageUp className="h-4 w-4 mr-1.5" /> {galeriaLabel}
      </Button>
    </div>
  );
}

/** Reduz a foto (lado maior 1280px, JPEG 0.8) e devolve data URL. Em caso de falha devolve a original. */
export function fotoParaDataUrl(file: File, max = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler a foto."));
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.width, h = img.height;
          if (w > max || h > max) { const sc = Math.min(max / w, max / h); w = Math.round(w * sc); h = Math.round(h * sc); }
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(src);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        } catch { resolve(src); }
      };
      img.onerror = () => resolve(src);
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}
