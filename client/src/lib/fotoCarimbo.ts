// Carimba data/hora/usuário (e um rótulo) na própria imagem antes do upload,
// via canvas. A foto vira prova por si só — impressa, exportada ou fora do
// sistema — e o servidor ainda grava taken_at = now() por cima.
// Redimensiona para no máximo 1600px no maior lado e exporta JPEG (qualidade
// 0.85): foto de celular de 4–8MB vira ~300–600KB no banco.
export async function carimbarFoto(file: File, linhas: string[]): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Não foi possível ler a imagem'));
      i.src = url;
    });
    const MAX = 1600;
    const escala = Math.min(1, MAX / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * escala));
    const h = Math.max(1, Math.round(img.height * escala));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas indisponível');
    ctx.drawImage(img, 0, 0, w, h);

    const fonte = Math.max(14, Math.round(w / 45));
    const pad = Math.round(fonte * 0.6);
    const alturaLinha = Math.round(fonte * 1.35);
    const alturaBarra = pad * 2 + alturaLinha * linhas.length;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, h - alturaBarra, w, alturaBarra);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${fonte}px Arial, Helvetica, sans-serif`;
    ctx.textBaseline = 'top';
    linhas.forEach((l, i) => ctx.fillText(l, pad, h - alturaBarra + pad + i * alturaLinha, w - pad * 2));

    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Falha ao gerar a imagem');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const agoraBR = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
