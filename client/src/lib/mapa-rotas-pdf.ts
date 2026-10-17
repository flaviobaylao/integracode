// ============================================================================
// MAPA DAS ENTREGAS DO DIA — imagem estática para o romaneio (PDF)
// ----------------------------------------------------------------------------
// Monta, num <canvas>, as telhas do OpenStreetMap que cobrem TODAS as entregas
// do dia (todos os entregadores) e desenha por cima, com uma cor por
// entregador: a base (S), as paradas numeradas e a linha da rota. A rota do
// entregador dono do romaneio sai em destaque (linha grossa); as demais ficam
// mais leves, só para ele enxergar o dia inteiro.
//
// As telhas são baixadas uma única vez (prepararMapaDoDia) e reaproveitadas para
// cada romaneio (desenharMapaDoDia é síncrona). Se as telhas não carregarem
// (sem internet, bloqueio), o mapa sai com fundo neutro — os pontos e rotas
// continuam corretos.
// ============================================================================

export interface PontoMapa { lat: number; lng: number; ordem?: number | string; rotulo?: string }
export interface RotaMapa {
  nome: string;
  cor: string;
  base?: { lat: number; lng: number } | null;
  paradas: PontoMapa[];
}

// Mesma paleta do pop-up de roteirização (Okabe-Ito, sem o amarelo).
export const CORES_ROTAS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#56B4E9', '#6A3D9A', '#A6761D', '#333333'];

const TILE = 256;
const LARGURA = 1600; // px (≈ 186 mm a ~8,6 px/mm)
const ALTURA = 1100;

function lng2x(lng: number, z: number) { return ((lng + 180) / 360) * TILE * Math.pow(2, z); }
function lat2y(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * Math.pow(2, z);
}

export interface MapaBase {
  canvas: HTMLCanvasElement;
  z: number;
  x0: number; // pixel global da borda esquerda
  y0: number; // pixel global da borda superior
  w: number;
  h: number;
}

function carregarTelha(url: string, timeoutMs = 6000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}

/** Baixa as telhas que cobrem todas as rotas. Devolve null se não houver pontos. */
export async function prepararMapaDoDia(rotas: RotaMapa[]): Promise<MapaBase | null> {
  const pts: Array<{ lat: number; lng: number }> = [];
  for (const r of rotas) {
    if (r.base && Number.isFinite(r.base.lat) && Number.isFinite(r.base.lng)) pts.push(r.base);
    for (const p of r.paradas) if (Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat !== 0) pts.push(p);
  }
  if (!pts.length || typeof document === 'undefined') return null;

  const minLat = Math.min(...pts.map((p) => p.lat));
  const maxLat = Math.max(...pts.map((p) => p.lat));
  const minLng = Math.min(...pts.map((p) => p.lng));
  const maxLng = Math.max(...pts.map((p) => p.lng));

  // Maior zoom em que tudo cabe com folga de 70 px de cada lado.
  const pad = 70;
  let z = 16;
  for (; z > 3; z--) {
    const w = lng2x(maxLng, z) - lng2x(minLng, z);
    const h = lat2y(minLat, z) - lat2y(maxLat, z);
    if (w <= LARGURA - 2 * pad && h <= ALTURA - 2 * pad) break;
  }
  const cx = (lng2x(minLng, z) + lng2x(maxLng, z)) / 2;
  const cy = (lat2y(maxLat, z) + lat2y(minLat, z)) / 2;
  const x0 = cx - LARGURA / 2;
  const y0 = cy - ALTURA / 2;

  const canvas = document.createElement('canvas');
  canvas.width = LARGURA;
  canvas.height = ALTURA;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#eef0eb';
  ctx.fillRect(0, 0, LARGURA, ALTURA);

  const tx0 = Math.floor(x0 / TILE);
  const ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.floor((x0 + LARGURA) / TILE);
  const ty1 = Math.floor((y0 + ALTURA) / TILE);
  const max = Math.pow(2, z);
  const subs = ['a', 'b', 'c'];
  const jobs: Array<Promise<void>> = [];
  let k = 0;
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= max) continue;
      const wx = ((tx % max) + max) % max;
      const url = `https://${subs[k++ % 3]}.tile.openstreetmap.org/${z}/${wx}/${ty}.png`;
      jobs.push(carregarTelha(url).then((img) => {
        if (!img) return;
        try { ctx.drawImage(img, tx * TILE - x0, ty * TILE - y0, TILE, TILE); } catch { /* telha sem CORS */ }
      }));
    }
  }
  await Promise.all(jobs);
  // Clareia as telhas para as rotas coloridas se destacarem na impressão.
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(0, 0, LARGURA, ALTURA);
  return { canvas, z, x0, y0, w: LARGURA, h: ALTURA };
}

function circulo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, cor: string, texto: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = cor;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(r * 1.05)}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(texto, x, y + 1);
  ctx.globalAlpha = 1;
}

/**
 * Desenha as rotas sobre o mapa base. `destaque` = índice da rota do romaneio
 * (as outras ficam em segundo plano); -1 = todas iguais. Retorna um JPEG em dataURL.
 */
export function desenharMapaDoDia(base: MapaBase, rotas: RotaMapa[], destaque = -1): string {
  const c = document.createElement('canvas');
  c.width = base.w;
  c.height = base.h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(base.canvas, 0, 0);
  const px = (lat: number, lng: number): [number, number] => [lng2x(lng, base.z) - base.x0, lat2y(lat, base.z) - base.y0];

  const ordemDesenho = rotas.map((_, i) => i).sort((a, b) => (a === destaque ? 1 : 0) - (b === destaque ? 1 : 0));
  for (const i of ordemDesenho) {
    const r = rotas[i];
    const foco = destaque < 0 || i === destaque;
    const alpha = foco ? 1 : 0.55;
    const pts = r.paradas.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat !== 0);
    const linha: Array<[number, number]> = [];
    if (r.base) linha.push(px(r.base.lat, r.base.lng));
    for (const p of pts) linha.push(px(p.lat, p.lng));
    if (r.base) linha.push(px(r.base.lat, r.base.lng));

    if (linha.length > 1) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = r.cor;
      ctx.lineWidth = foco ? 7 : 4;
      ctx.lineJoin = 'round';
      ctx.setLineDash(foco ? [] : [14, 10]);
      ctx.beginPath();
      linha.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    if (r.base) {
      const [x, y] = px(r.base.lat, r.base.lng);
      circulo(ctx, x, y, 22, r.cor, 'S', alpha);
    }
    pts.forEach((p, j) => {
      const [x, y] = px(p.lat, p.lng);
      circulo(ctx, x, y, foco ? 19 : 15, r.cor, String(p.ordem ?? j + 1), alpha);
    });
  }

  ctx.font = '18px Helvetica, Arial, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('© OpenStreetMap', base.w - 10, base.h - 8);
  return c.toDataURL('image/jpeg', 0.85);
}
