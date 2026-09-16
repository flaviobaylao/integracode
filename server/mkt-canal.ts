// ============================================================================
// CENTRAL DE MARKETING — CANAL DE CADA ACAO (regra unica)
// ----------------------------------------------------------------------------
// Toda acao da Caixa passa por AQUI para dizer, em uma palavra, por onde ela
// fala com o mundo: WhatsApp, Instagram, Facebook, Google, loja, visita
// presencial ou so dentro do Integra. A tela, o resumo do WhatsApp e o
// analista usam a mesma funcao — nunca reinventar por tipo em cada lugar.
// ============================================================================
export type Canal = 'whatsapp' | 'instagram' | 'facebook' | 'google' | 'loja' | 'presencial' | 'integra';

export const CANAL_ROTULO: Record<Canal, string> = {
  whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', google: 'Google',
  loja: 'Loja online', presencial: 'Visita presencial', integra: 'Só no Integra',
};
export const CANAL_EMOJI: Record<Canal, string> = {
  whatsapp: '💬', instagram: '📸', facebook: '📘', google: '🔎', loja: '🛒', presencial: '🚗', integra: '⚙️',
};
export const CANAL_COR: Record<Canal, string> = {
  whatsapp: '#16a34a', instagram: '#db2777', facebook: '#2563eb', google: '#ea580c', loja: '#0891b2', presencial: '#7c3aed', integra: '#6b7280',
};

function normaliza(c: any): Canal | null {
  const s = String(c || '').toLowerCase();
  if (!s) return null;
  if (s.includes('whats') || s.includes('1841') || s.includes('2630')) return 'whatsapp';
  if (s.includes('insta')) return 'instagram';
  if (s.includes('face') || s.includes('meta')) return 'facebook';
  if (s.includes('google') || s.includes('ads') && !s.includes('meta')) return 'google';
  if (s.includes('loja') || s.includes('hotsite') || s.includes('shop')) return 'loja';
  return null;
}

/** Canal principal e, quando houver, o secundario (ex.: cupom criado na loja e avisado no WhatsApp). */
export function canalDaAcao(a: { tipo?: string; parametros?: any; publico?: any; canal?: string }): { canal: Canal; via?: Canal; quem: string } {
  const p = a.parametros || {};
  switch (String(a.tipo || '')) {
    case 'regua':   return { canal: 'whatsapp', quem: 'mensagem UTILITY para o cliente pelo número oficial 1841' };
    case 'alerta':  return { canal: 'whatsapp', quem: 'aviso interno para o vendedor/gestor (nenhum cliente recebe)' };
    case 'visita':  return { canal: 'presencial', via: 'whatsapp', quem: 'entra na agenda do vendedor; ele recebe aviso no WhatsApp' };
    case 'cupom':   return { canal: 'loja', via: 'whatsapp', quem: 'cupom criado na loja; o código vai na sugestão da régua' };
    case 'peca':    return { canal: normaliza(p.canal) || 'instagram', quem: 'peça de conteúdo — passa pela fila de aprovação antes de ir ao ar' };
    case 'campanha': return { canal: normaliza(p.canal) || 'whatsapp', quem: 'campanha + link rastreável (/r/…)' };
    case 'anuncio': { const c = normaliza(p.canal || p.plataforma); return { canal: c === 'google' ? 'google' : c === 'facebook' ? 'facebook' : 'instagram', quem: 'anúncio pago (verba)' }; }
    case 'sistema': return { canal: 'integra', quem: 'ajuste de parâmetro/política/prompt dentro do Integra' };
    default: return { canal: normaliza(a.canal) || 'integra', quem: '' };
  }
}

/** Para pecas (mkt_pieces.canal) e posts. */
export function canalDaPeca(canal: any): Canal { return normaliza(canal) || 'instagram'; }
