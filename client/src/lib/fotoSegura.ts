// Preparo de foto no celular antes do upload (10/nov/2026).
//
// A foto é reduzida no próprio navegador (máx. 1280 px, JPEG 72%) para o upload ser leve.
// Em alguns aparelhos (Android com câmera de muitos megapixels ou pouca memória) o canvas
// NÃO consegue desenhar a foto original e devolve um quadro TODO PRETO, sem erro — foi o
// que gerou fotos de troca pretas. Aqui cada tentativa é conferida; se sair preta, tenta
// outro caminho, e no último caso envia a foto original sem reduzir.
//   1) createImageBitmap com redimensionamento (o navegador reduz sem montar a foto inteira)
//   2) <img> + canvas, reduzindo em etapas de 1/2 (menos memória por desenho)
//   3) arquivo original (se couber no limite do servidor)

const LIMITE_ORIGINAL = 9.5 * 1024 * 1024; // servidor aceita até 10 MB

function lerComoDataUrl(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("leitura falhou"));
    r.readAsDataURL(f);
  });
}

function medidas(w: number, h: number, max: number) {
  if (w >= h && w > max) return { w: max, h: Math.round((h * max) / w) };
  if (h > w && h > max) return { w: Math.round((w * max) / h), h: max };
  return { w, h };
}

/** true se o canvas saiu praticamente todo preto (falha silenciosa do aparelho). */
function saiuPreto(c: HTMLCanvasElement): boolean {
  try {
    const t = document.createElement("canvas");
    t.width = 24; t.height = 24;
    const cx = t.getContext("2d");
    if (!cx) return false;
    cx.drawImage(c, 0, 0, 24, 24);
    const d = cx.getImageData(0, 0, 24, 24).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(d[i], d[i + 1], d[i + 2]);
      if (v > max) max = v;
      if (max > 12) return false;
    }
    return true;
  } catch {
    return false; // sem como medir (canvas protegido): não descarta
  }
}

async function viaBitmap(file: File, max: number, q: number): Promise<string | null> {
  if (typeof (window as any).createImageBitmap !== "function") return null;
  try {
    const bruto: ImageBitmap = await createImageBitmap(file);
    const { w, h } = medidas(bruto.width, bruto.height, max);
    bruto.close?.();
    const bmp: ImageBitmap = await (createImageBitmap as any)(file, { resizeWidth: w, resizeHeight: h, resizeQuality: "high", imageOrientation: "from-image" });
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext("2d");
    if (!cx) return null;
    cx.drawImage(bmp, 0, 0);
    bmp.close?.();
    if (saiuPreto(c)) return null;
    return c.toDataURL("image/jpeg", q);
  } catch {
    return null;
  }
}

function carregarImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("imagem inválida"));
    img.src = src;
  });
}

async function viaEtapas(dataUrl: string, max: number, q: number): Promise<string | null> {
  try {
    const img = await carregarImg(dataUrl);
    const alvo = medidas(img.naturalWidth || img.width, img.naturalHeight || img.height, max);
    let src: CanvasImageSource = img;
    let sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
    // reduz pela metade até ficar perto do alvo (cada desenho usa menos memória)
    while (sw / 2 > alvo.w * 1.1) {
      const c = document.createElement("canvas");
      c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
      const cx = c.getContext("2d"); if (!cx) return null;
      cx.drawImage(src, 0, 0, c.width, c.height);
      src = c; sw = c.width; sh = c.height;
    }
    const fim = document.createElement("canvas");
    fim.width = alvo.w; fim.height = alvo.h;
    const fx = fim.getContext("2d"); if (!fx) return null;
    fx.drawImage(src, 0, 0, alvo.w, alvo.h);
    if (saiuPreto(fim)) return null;
    return fim.toDataURL("image/jpeg", q);
  } catch {
    return null;
  }
}

/**
 * Prepara a foto para upload como data URL. Nunca devolve foto preta por falha do
 * aparelho: se as reduções falharem, devolve a original (ou lança erro se ela for grande
 * demais para o servidor).
 */
export async function prepararFotoSegura(file: File, max = 1280, qualidade = 0.72): Promise<string> {
  const a = await viaBitmap(file, max, qualidade);
  if (a) return a;
  const original = await lerComoDataUrl(file);
  const b = await viaEtapas(original, max, qualidade);
  if (b) return b;
  if (file.size <= LIMITE_ORIGINAL) {
    console.warn("[foto] redução falhou neste aparelho — enviando a foto original");
    return original;
  }
  throw new Error("Não foi possível processar a foto neste celular. Tente pela galeria ou com menor resolução da câmera.");
}
