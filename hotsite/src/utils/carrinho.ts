// ============================================================================
// CARRINHOS DA LOJA — o lado da loja (02/nov/2026)
// ----------------------------------------------------------------------------
// Conta ao Integra (server/carrinho-loja.ts) o que está acontecendo nesta visita:
// itens no carrinho, etapa (vitrine, carrinho, checkout, PIX, cartão) e — só a
// partir do momento em que o cliente digita o WhatsApp no checkout — o contato.
// Com isso a equipe vê quem está na loja agora e quem largou o carrinho, e o
// Integra manda ao cliente o link que devolve o carrinho (?carrinho=<token>).
//
// Mesmas regras do pixel.ts: nada aqui pode derrubar a loja (tudo em try/catch,
// erros engolidos) e nada de CPF/endereço sai daqui.
// ============================================================================
import { obterOrigem } from './origem';

const CHAVE_SESSAO = 'honest-sessao-carrinho';
type ItemCompacto = { id: string; n: string; p: number; q: number };
type Contato = { nome?: string; telefone?: string; email?: string };

export type EtapaLoja = 'catalogo' | 'carrinho' | 'checkout' | 'pix' | 'cartao' | 'sucesso';

function novaSessao(): string {
  const r = (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? (globalThis.crypto as any).randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
  return 'hs_' + r;
}

export function sessaoCarrinho(): string {
  try {
    let s = localStorage.getItem(CHAVE_SESSAO);
    if (!s || s.length < 12) { s = novaSessao(); localStorage.setItem(CHAVE_SESSAO, s); }
    return s;
  } catch { return novaSessao(); }
}

/** Depois de um pedido concluído, a próxima compra é um carrinho novo. */
export function renovarSessaoCarrinho(): void {
  try { localStorage.setItem(CHAVE_SESSAO, novaSessao()); } catch { /* ok */ }
}

let ultimoEstado: { itens: ItemCompacto[]; etapa: EtapaLoja; tipoCliente?: string | null; tabela?: string | null } = { itens: [], etapa: 'catalogo' };
let contato: Contato = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function enviar(presenca = false): void {
  try {
    const o = obterOrigem();
    const body = JSON.stringify({
      sessaoId: sessaoCarrinho(),
      presenca,
      itens: ultimoEstado.itens,
      etapa: ultimoEstado.etapa,
      tipoCliente: ultimoEstado.tipoCliente || null,
      tabela: ultimoEstado.tabela || null,
      contato: contato.telefone ? contato : undefined,
      utm: o?.utm || undefined,
    });
    fetch('/api/public/carrinho/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* nunca quebra a loja */ }
}

/** Chamado a cada mudança de carrinho/etapa. Agrupa rajadas (1,5 s). */
export function sincronizarCarrinho(estado: { itens: Array<{ id: string; name: string; price: number; quantity: number }>; etapa: EtapaLoja; tipoCliente?: string | null; tabela?: string | null }): void {
  try {
    ultimoEstado = {
      itens: (estado.itens || []).map((i) => ({ id: String(i.id), n: String(i.name || ''), p: Number(i.price) || 0, q: Number(i.quantity) || 0 })),
      etapa: estado.etapa,
      tipoCliente: estado.tipoCliente,
      tabela: estado.tabela,
    };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => enviar(false), 1500);
  } catch { /* ok */ }
}

/** Chamado pelo checkout quando o WhatsApp digitado já é válido. */
export function informarContato(c: Contato): void {
  try {
    const tel = String(c.telefone || '').replace(/\D/g, '');
    if (tel.length < 10) return;
    const novo = { nome: (c.nome || '').trim(), telefone: tel, email: (c.email || '').trim() };
    if (novo.telefone === contato.telefone && novo.nome === contato.nome && novo.email === contato.email) return;
    contato = novo;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => enviar(false), 800);
  } catch { /* ok */ }
}

/** "Estou aqui" a cada 60 s com a aba visível — é o que alimenta o "na loja agora". */
export function iniciarPresenca(): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  try {
    enviar(true);
    id = setInterval(() => {
      try { if (document.visibilityState === 'visible') enviar(true); } catch { /* ok */ }
    }, 60_000);
  } catch { /* ok */ }
  return () => { if (id) clearInterval(id); };
}

/** Pedido concluído: avisa o Integra e começa uma sessão nova. */
export function marcarConvertido(pedidoNumero: string): void {
  try {
    const sessaoId = sessaoCarrinho();
    fetch('/api/public/carrinho/convertido', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessaoId, pedidoNumero }), keepalive: true,
    }).catch(() => {});
    renovarSessaoCarrinho();
    contato = {};
  } catch { /* ok */ }
}

/** Link da mensagem de recuperação (?carrinho=<token>): devolve os itens guardados. */
export async function buscarCarrinhoSalvo(token: string): Promise<ItemCompacto[] | null> {
  try {
    const t = token.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!t) return null;
    const r = await fetch(`/api/public/carrinho/${encodeURIComponent(t)}`);
    if (!r.ok) return null;
    const d = await r.json();
    // Continua a MESMA sessão do carrinho original: a compra que vier daqui conta como recuperada.
    if (d?.sessaoId && /^[a-zA-Z0-9_-]{12,64}$/.test(d.sessaoId)) {
      try { localStorage.setItem(CHAVE_SESSAO, d.sessaoId); } catch { /* ok */ }
    }
    return Array.isArray(d?.itens) ? d.itens : null;
  } catch { return null; }
}
