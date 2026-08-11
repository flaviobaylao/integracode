// ============================================================================
// CENTRAL DE MARKETING — buraco 2: a ponta do fio no hotsite
// ----------------------------------------------------------------------------
// Quem chega por /r/<slug> cai aqui com ?utm_*&cid=... na URL. Este módulo:
//   1. lê os parâmetros na primeira carga
//   2. guarda em sessionStorage (sobrevive à navegação do carrinho/checkout)
//   3. devolve o bloco pronto para ir junto do pedido
//
// Regra de precedência: UTM NOVO SOBRESCREVE o guardado. Se a pessoa voltou pelo
// link de outra campanha, é a campanha nova que trouxe a venda — não a de ontem.
// Sem parâmetro na URL, o que já estava guardado é mantido (a navegação interna
// do hotsite não pode apagar a origem).
//
// Nada aqui identifica pessoa: só de onde veio o clique.
// ============================================================================

const CHAVE = 'honest_origem';

const CAMPOS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'gclid',   // Google Ads
  'fbclid',  // Meta
] as const;

export type Origem = { utm: Record<string, string>; cid: string | null };

function lerDaUrl(): Origem | null {
  try {
    const q = new URLSearchParams(window.location.search);
    const utm: Record<string, string> = {};
    for (const c of CAMPOS) {
      const v = q.get(c);
      if (v && v.trim()) utm[c] = v.trim().slice(0, 200);
    }
    const cid = (q.get('cid') || '').trim().toUpperCase().slice(0, 60) || null;
    if (!cid && !Object.keys(utm).length) return null;

    // Contexto que ajuda a depurar atribuição sem custo nenhum
    utm.landing = (window.location.pathname + window.location.search).slice(0, 200);
    if (document.referrer) utm.referrer = document.referrer.slice(0, 200);
    return { utm, cid };
  } catch { return null; }
}

/** Chame uma vez na carga do app. Guarda a origem e limpa a URL. */
export function capturarOrigem(): Origem | null {
  const daUrl = lerDaUrl();
  if (daUrl) {
    try { sessionStorage.setItem(CHAVE, JSON.stringify(daUrl)); } catch {}
    // Tira os utm_* da barra de endereço para o cliente não compartilhar um link
    // sujo (e para não recontar clique num F5). A origem já está guardada.
    try {
      const u = new URL(window.location.href);
      let mexeu = false;
      for (const c of [...CAMPOS, 'cid']) if (u.searchParams.has(c)) { u.searchParams.delete(c); mexeu = true; }
      if (mexeu) window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    } catch {}
    return daUrl;
  }
  return obterOrigem();
}

/** Origem guardada nesta sessão (ou null se a pessoa entrou direto). */
export function obterOrigem(): Origem | null {
  try {
    const raw = sessionStorage.getItem(CHAVE);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && (o.cid || (o.utm && Object.keys(o.utm).length))) return o;
    return null;
  } catch { return null; }
}

/**
 * Bloco pronto para espalhar no objeto do pedido.
 * Sem origem, devolve {} — o pedido sai exatamente como sai hoje.
 */
export function origemDoPedido(): { utm?: Record<string, string>; cid?: string } {
  const o = obterOrigem();
  if (!o) return {};
  const out: { utm?: Record<string, string>; cid?: string } = {};
  if (o.utm && Object.keys(o.utm).length) out.utm = o.utm;
  if (o.cid) out.cid = o.cid;
  return out;
}
