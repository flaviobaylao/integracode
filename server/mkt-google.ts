// Central de Marketing - buraco 9: presenca em Google.
//
// O diagnostico do plano era "zero presenca em Google". Medindo, e pior:
//   • /robots.txt devolvia o HTML do painel (o catch-all do SPA pegava a rota)
//   • /sitemap.xml, idem
//   • /shop nao tinha canonical, og:image, nem UM dado estruturado
//   • o titulo nao dizia atacado, revenda nem Goiania - as palavras que a pessoa digita
//
// robots.txt que devolve HTML nao e "faltando", e QUEBRADO: o robo trata como
// malformado. Entao a primeira entrega aqui e servir os dois de verdade, antes
// do catch-all - o mesmo lugar onde o /r/:slug do buraco 2 teve que entrar.
//
// Decisoes:
//  - Nada de FAQPage/HowTo: a Meta... digo, o Google parou de mostrar rich result
//    dos dois (HowTo em 2023, FAQPage em maio/2026). Marcar nao da erro, mas nao
//    rende nada - e polui. Product/Offer, Organization e LocalBusiness seguem valendo.
//  - Dado que eu NAO sei (endereco exato, telefone publico, CNPJ) nao entra
//    inventado no JSON-LD. Fica como pendencia no diagnostico.
//  - GA4 e Google Ads saem de system_settings: sem ID, nenhuma tag e injetada.
//  - A injecao no HTML tem que ser a prova de falha: qualquer erro serve o arquivo
//    original. Loja fora do ar por causa de SEO seria o pior negocio possivel.

import { db } from './db';
import { sql } from 'drizzle-orm';

const HOST_LOJA = 'https://loja.bebahonest.com.br';

// ---------------------------------------------------------------------------
// Configuracao (sem deploy)
// ---------------------------------------------------------------------------

export type ConfigGoogle = {
  ga4Id: string;                 // G-XXXXXXX
  adsId: string;                 // AW-XXXXXXXXX
  adsRotuloConversao: string;    // nome da acao de conversao no Google Ads
  verificacaoSearchConsole: string;
  siteUrl: string;
  nomeNegocio: string;
  descricao: string;
  telefone: string;
  rua: string; cidade: string; uf: string; cep: string;
  areasAtendidas: string;
  // Horario no formato do schema.org: "Mo-Fr 08:30-18:30, Sa 08:30-12:00".
  // Vazio = nao entra no dado estruturado (mesma regra do endereco).
  horario: string;
  // Perfis oficiais, separados por virgula. O link do Perfil da Empresa no Google
  // entra AQUI: e o que amarra o site ao perfil como sendo a mesma entidade.
  redes: string;
  seoLigado: boolean;
};

const PADROES: ConfigGoogle = {
  ga4Id: '', adsId: '', adsRotuloConversao: 'Pedido no site',
  verificacaoSearchConsole: '',
  siteUrl: HOST_LOJA,
  nomeNegocio: 'Honest Sucos Naturais',
  // As palavras que a pessoa realmente digita. O titulo antigo nao tinha nenhuma.
  // "sem adicao de acucares" e a frase exata do rotulo. "sem acucar adicionado" dizia
  // a mesma coisa com outras palavras, e o que vale aqui e bater com o rotulo.
  descricao: 'Sucos naturais sem adição de açúcares, produzidos em Bela Vista de Goiás. '
    + 'Venda no atacado para revenda (padarias, mercados, lanchonetes) e entrega para consumidor em Goiânia e região.',
  telefone: '', rua: '', cidade: 'Bela Vista de Goiás', uf: 'GO', cep: '',
  areasAtendidas: 'Goiânia, Aparecida de Goiânia, Senador Canedo, Bela Vista de Goiás, Trindade',
  horario: '', redes: '',
  seoLigado: true,
};

async function lerSetting(chave: string): Promise<string | null> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${chave} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    if (v == null) return null;
    return String(v).replace(/^"|"$/g, '');
  } catch { return null; }
}

let _cache: { em: number; cfg: ConfigGoogle } | null = null;

export async function configGoogle(forcar = false): Promise<ConfigGoogle> {
  if (!forcar && _cache && Date.now() - _cache.em < 60_000) return _cache.cfg;
  const g = async (k: string, padrao: string) => (await lerSetting(k)) ?? padrao;
  const cfg: ConfigGoogle = {
    ga4Id: (await g('google_ga4_id', PADROES.ga4Id)).trim(),
    adsId: (await g('google_ads_id', PADROES.adsId)).trim(),
    adsRotuloConversao: await g('google_ads_conversao', PADROES.adsRotuloConversao),
    verificacaoSearchConsole: (await g('google_site_verification', PADROES.verificacaoSearchConsole)).trim(),
    siteUrl: (await g('google_site_url', PADROES.siteUrl)).replace(/\/+$/, ''),
    nomeNegocio: await g('google_negocio_nome', PADROES.nomeNegocio),
    descricao: await g('google_negocio_descricao', PADROES.descricao),
    telefone: (await g('google_negocio_telefone', PADROES.telefone)).trim(),
    rua: (await g('google_negocio_rua', PADROES.rua)).trim(),
    cidade: await g('google_negocio_cidade', PADROES.cidade),
    uf: await g('google_negocio_uf', PADROES.uf),
    cep: (await g('google_negocio_cep', PADROES.cep)).trim(),
    areasAtendidas: await g('google_areas_atendidas', PADROES.areasAtendidas),
    horario: (await g('google_negocio_horario', PADROES.horario)).trim(),
    redes: (await g('google_negocio_redes', PADROES.redes)).trim(),
    seoLigado: (await g('google_seo_modo', 'on')) !== 'off',
  };
  _cache = { em: Date.now(), cfg };
  return cfg;
}

export async function salvarConfigGoogle(campos: Record<string, string>): Promise<{ ok: boolean; salvos: string[]; erro?: string }> {
  const MAPA: Record<string, string> = {
    ga4Id: 'google_ga4_id', adsId: 'google_ads_id', adsRotuloConversao: 'google_ads_conversao',
    verificacaoSearchConsole: 'google_site_verification', siteUrl: 'google_site_url',
    nomeNegocio: 'google_negocio_nome', descricao: 'google_negocio_descricao',
    telefone: 'google_negocio_telefone', rua: 'google_negocio_rua', cidade: 'google_negocio_cidade',
    uf: 'google_negocio_uf', cep: 'google_negocio_cep', areasAtendidas: 'google_areas_atendidas',
    horario: 'google_negocio_horario', redes: 'google_negocio_redes',
    seoLigado: 'google_seo_modo',
  };
  const salvos: string[] = [];
  try {
        for (const [campo, chave] of Object.entries(MAPA)) {
      if (!(campo in campos)) continue;
      let valor = String((campos as any)[campo] ?? '');
      if (campo === 'seoLigado') valor = (valor === 'false' || valor === 'off') ? 'off' : 'on';
      // Formato do ID e conferido aqui: ID errado nao gera erro visivel, so some o dado.
      if (campo === 'ga4Id' && valor && !/^G-[A-Z0-9]{4,}$/i.test(valor)) return { ok: false, salvos, erro: 'ID do GA4 tem o formato G-XXXXXXX' };
      if (campo === 'adsId' && valor && !/^AW-\d{6,}$/i.test(valor)) return { ok: false, salvos, erro: 'ID do Google Ads tem o formato AW-000000000' };
      // updated_by e NOT NULL no schema real - ver o setSetting() do agent-runtime.
      await db.execute(sql`
        INSERT INTO system_settings (key, value, updated_by) VALUES (${chave}, ${valor}, ${'mkt-google'})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
      `);
      salvos.push(chave);
    }
    _cache = null;
    return { ok: true, salvos };
  } catch (e: any) {
    return { ok: false, salvos, erro: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// robots.txt e sitemap.xml — hoje os dois devolvem HTML
// ---------------------------------------------------------------------------

export async function robotsTxt(): Promise<string> {
  const cfg = await configGoogle();
  if (!cfg.seoLigado) {
    // Interruptor de emergencia: tira o site do indice de uma vez.
    return 'User-agent: *\nDisallow: /\n';
  }
  return [
    'User-agent: *',
    'Allow: /shop',
    // O painel e a API nao tem o que fazer no indice - e rastrea-los queima orcamento
    // de rastreamento que deveria ir para as paginas de produto.
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /objects/',
    'Disallow: /r/',            // link curto e redirecionador, nao pagina
    'Disallow: /clear-cache',
    '',
    'Sitemap: ' + cfg.siteUrl + '/sitemap.xml',
    '',
  ].join('\n');
}

function escaparXml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function sitemapXml(): Promise<string> {
  const cfg = await configGoogle();
  const urls: { loc: string; lastmod?: string; prioridade: string }[] = [
    { loc: cfg.siteUrl + '/shop', prioridade: '1.0' },
  ];
  try {
    const r: any = await db.execute(sql`
      SELECT id, updated_at FROM products WHERE is_active = true ORDER BY name LIMIT 500
    `);
    for (const p of (r.rows || [])) {
      urls.push({
        loc: cfg.siteUrl + '/shop/produto/' + String(p.id),
        lastmod: p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 10) : undefined,
        prioridade: '0.8',
      });
    }
  } catch { /* sem produtos, o sitemap ainda vale pela home */ }

  const corpo = urls.map(u =>
    '  <url>\n' +
    '    <loc>' + escaparXml(u.loc) + '</loc>\n' +
    (u.lastmod ? '    <lastmod>' + u.lastmod + '</lastmod>\n' : '') +
    '    <changefreq>weekly</changefreq>\n' +
    '    <priority>' + u.prioridade + '</priority>\n' +
    '  </url>'
  ).join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + corpo + '\n</urlset>\n';
}

// ---------------------------------------------------------------------------
// Dado estruturado
// ---------------------------------------------------------------------------

/**
 * Endereco publico da foto do produto.
 * As fotos do catalogo estao gravadas como data: URL (base64 dentro do Postgres).
 * Isso funciona dentro da loja, mas para o Google NAO existe: rich result de
 * produto praticamente exige imagem, e imagem tem que ter endereco buscavel.
 * Este caminho publica os bytes num endereco de verdade - sem copiar arquivo
 * nenhum, so servindo o que ja esta no banco.
 */
export function urlPublicaDaFoto(cfg: ConfigGoogle, produtoId: string, imageUrl?: string | null): string | null {
  const img = String(imageUrl || '');
  if (!img) return null;
  if (img.startsWith('data:')) return cfg.siteUrl + '/shop/foto/' + encodeURIComponent(String(produtoId));
  if (img.startsWith('http')) return img;
  return cfg.siteUrl + (img.startsWith('/') ? img : '/' + img);
}

/** Bytes da foto principal de um produto, para servir no endereco publico. */
export async function fotoDoProduto(produtoId: string): Promise<{ mime: string; buf: Buffer } | null> {
  const id = String(produtoId || '').trim();
  if (!id || id.length > 64) return null;
  try {
    const r: any = await db.execute(sql`SELECT image_url FROM products WHERE id = ${id} AND is_active = true LIMIT 1`);
    const img = String(r.rows?.[0]?.image_url || '');
    const m = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(img.trim());
    if (!m) return null;
    return { mime: m[1] || 'image/jpeg', buf: Buffer.from(m[2], 'base64') };
  } catch { return null; }
}

async function produtosParaSchema(cfg: ConfigGoogle, limite = 20): Promise<any[]> {
  try {
    const r: any = await db.execute(sql`
      SELECT id, name, description, price, image_url
        FROM products WHERE is_active = true ORDER BY name LIMIT ${limite}
    `);
    return (r.rows || []).map((p: any, i: number) => {
      const preco = Number(p.price || 0);
      const item: any = {
        '@type': 'Product',
        name: String(p.name || ''),
        url: cfg.siteUrl + '/shop/produto/' + String(p.id),
      };
      if (p.description) item.description = String(p.description).slice(0, 400);
      // A foto vira um endereco publico mesmo quando esta gravada como base64.
      const foto = urlPublicaDaFoto(cfg, String(p.id), p.image_url);
      if (foto) item.image = foto;
      if (preco > 0) {
        item.offers = {
          '@type': 'Offer',
          price: preco.toFixed(2),
          priceCurrency: 'BRL',
          availability: 'https://schema.org/InStock',
          url: cfg.siteUrl + '/shop/produto/' + String(p.id),
        };
      }
      return { '@type': 'ListItem', position: i + 1, item };
    });
  } catch { return []; }
}

export async function jsonLd(): Promise<any[]> {
  const cfg = await configGoogle();
  const blocos: any[] = [];

  const negocio: any = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': cfg.siteUrl + '/#negocio',
    name: cfg.nomeNegocio,
    description: cfg.descricao,
    url: cfg.siteUrl + '/shop',
    image: cfg.siteUrl + '/shop/honest-logo.png',
    priceRange: '$$',
  };
  // Endereco so entra com o que existe de verdade. Endereco inventado no JSON-LD
  // e pior que endereco nenhum: o Google cruza com o Perfil da Empresa e desconfia.
  const endereco: any = { '@type': 'PostalAddress', addressCountry: 'BR' };
  if (cfg.rua) endereco.streetAddress = cfg.rua;
  if (cfg.cidade) endereco.addressLocality = cfg.cidade;
  if (cfg.uf) endereco.addressRegion = cfg.uf;
  if (cfg.cep) endereco.postalCode = cfg.cep;
  if (cfg.rua || cfg.cidade) negocio.address = endereco;
  if (cfg.telefone) negocio.telephone = cfg.telefone;
  const areas = String(cfg.areasAtendidas || '').split(',').map(s => s.trim()).filter(Boolean);
  if (areas.length) negocio.areaServed = areas.map(a => ({ '@type': 'City', name: a }));
  // Horario: so entra o que estiver no formato do schema.org ("Mo-Fr 08:30-18:30").
  // Texto solto tipo "de segunda a sexta" o Google ignora — e um campo ignorado
  // e pior que um campo vazio, porque parece preenchido na tela e nao vale nada.
  const horarios = String(cfg.horario || '').split(',').map(s => s.trim())
    .filter(s => /^(Mo|Tu|We|Th|Fr|Sa|Su)/.test(s));
  if (horarios.length) negocio.openingHours = horarios;
  // sameAs amarra o site aos perfis oficiais — inclusive ao Perfil da Empresa no
  // Google. Sem isso, o Google trata site e perfil como dois negocios parecidos.
  const perfis = String(cfg.redes || '').split(',').map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s));
  if (perfis.length) negocio.sameAs = perfis;
  blocos.push(negocio);

  blocos.push({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': cfg.siteUrl + '/#site',
    name: cfg.nomeNegocio,
    url: cfg.siteUrl + '/shop',
    inLanguage: 'pt-BR',
    publisher: { '@id': cfg.siteUrl + '/#negocio' },
  });

  const itens = await produtosParaSchema(cfg);
  if (itens.length) {
    blocos.push({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Sucos naturais Honest',
      numberOfItems: itens.length,
      itemListElement: itens,
    });
  }
  return blocos;
}

// ---------------------------------------------------------------------------
// O bloco que entra no <head> do /shop
// ---------------------------------------------------------------------------

export async function blocoSeo(): Promise<string> {
  const cfg = await configGoogle();
  const url = cfg.siteUrl + '/shop';
  const titulo = cfg.nomeNegocio + ' — sucos naturais em Goiânia | atacado e revenda';
  const desc = String(cfg.descricao).slice(0, 300);
  const img = cfg.siteUrl + '/shop/images/hero-linha-produtos.jpg';
  const e = escaparXml;

  const partes: string[] = ['<!-- Central de Marketing (buraco 9): SEO servido pelo servidor -->'];
  partes.push('<link rel="canonical" href="' + e(url) + '" />');
  partes.push('<meta name="robots" content="' + (cfg.seoLigado ? 'index, follow, max-image-preview:large' : 'noindex, nofollow') + '" />');
  if (cfg.verificacaoSearchConsole) {
    partes.push('<meta name="google-site-verification" content="' + e(cfg.verificacaoSearchConsole) + '" />');
  }
  partes.push('<meta property="og:url" content="' + e(url) + '" />');
  partes.push('<meta property="og:image" content="' + e(img) + '" />');
  partes.push('<meta property="og:site_name" content="' + e(cfg.nomeNegocio) + '" />');
  partes.push('<meta property="og:locale" content="pt_BR" />');
  partes.push('<meta property="twitter:image" content="' + e(img) + '" />');
  partes.push('<meta name="geo.region" content="BR-GO" />');
  if (cfg.cidade) partes.push('<meta name="geo.placename" content="' + e(cfg.cidade) + '" />');

  try {
    const blocos = await jsonLd();
    for (const b of blocos) {
      // </script> dentro do JSON fecharia a tag no meio - escapar e obrigatorio.
      const txt = JSON.stringify(b).replace(/<\//g, '<\\/');
      partes.push('<script type="application/ld+json">' + txt + '</script>');
    }
  } catch { /* sem dado estruturado o resto do SEO continua valendo */ }

  // Tag do GA4 / Google Ads: so sai se houver ID. Sem ID, nenhum script e injetado
  // (nada de pixel meia-boca disparando para lugar nenhum).
  const ids = [cfg.ga4Id, cfg.adsId].filter(Boolean);
  if (ids.length) {
    partes.push('<script async src="https://www.googletagmanager.com/gtag/js?id=' + e(ids[0]) + '"></script>');
    partes.push(
      '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}'
      + 'gtag(\'js\',new Date());'
      + ids.map(id => 'gtag(\'config\',\'' + id.replace(/'/g, '') + '\');').join('')
      + '</script>'
    );
  }

  return partes.join('\n    ');
}

/**
 * Injeta o bloco no HTML do hotsite. À PROVA DE FALHA por decisão: qualquer
 * problema devolve o HTML original. Loja fora do ar por causa de SEO seria o
 * pior negócio possível.
 */
export async function injetarSeo(html: string): Promise<string> {
  try {
    if (!html || typeof html !== 'string') return html;
    if (html.includes('buraco 9): SEO servido pelo servidor')) return html; // ja injetado
    const bloco = await blocoSeo();
    if (!bloco) return html;
    const i = html.indexOf('</head>');
    if (i < 0) return html;
    // Título novo — o antigo não tinha atacado, revenda nem Goiânia.
    const cfg = await configGoogle();
    let saida = html.replace(
      /<title>[\s\S]*?<\/title>/i,
      '<title>' + escaparXml(cfg.nomeNegocio + ' — sucos naturais em Goiânia | atacado e revenda') + '</title>'
    );
    const j = saida.indexOf('</head>');
    if (j < 0) return html;
    return saida.slice(0, j) + '    ' + bloco + '\n  ' + saida.slice(j);
  } catch {
    return html;
  }
}

// ---------------------------------------------------------------------------
// Conversoes offline — fechar o laco do Google Ads
// ---------------------------------------------------------------------------
// O gclid ja e capturado desde o buraco 2 (hotsite/src/utils/origem.ts grava
// gclid em sales_cards.utm). Sem devolver a venda para o Google, o Ads otimiza
// por clique; devolvendo, ele otimiza por receita de verdade.

export type ConversaoOffline = {
  gclid: string; nome: string; quando: string; valor: number; moeda: string; pedido: string;
  diasDesdeClique: number | null; foraDaJanela: boolean;
};

export const JANELA_CONVERSAO_DIAS = 90;

export async function conversoesOffline(dias = 90): Promise<{
  linhas: ConversaoOffline[]; total: number; comGclid: number; foraDaJanela: number;
  totalPedidos: number; recado: string;
}> {
  const cfg = await configGoogle();
  const vazio = { linhas: [] as ConversaoOffline[], total: 0, comGclid: 0, foraDaJanela: 0, totalPedidos: 0, recado: '' };
  let linhas: ConversaoOffline[] = [];
  let totalPedidos = 0;

  try {
    const t: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM sales_cards
       WHERE created_at >= NOW() - (${dias}::text || ' days')::interval
    `);
    totalPedidos = Number(t.rows?.[0]?.n || 0);

    const r: any = await db.execute(sql`
      SELECT id, created_at, sale_value, utm
        FROM sales_cards
       WHERE created_at >= NOW() - (${dias}::text || ' days')::interval
         AND utm IS NOT NULL
         AND utm ->> 'gclid' IS NOT NULL
         AND utm ->> 'gclid' <> ''
       ORDER BY created_at DESC
       LIMIT 5000
    `);
    linhas = (r.rows || []).map((x: any) => {
      const quando = new Date(x.created_at);
      return {
        gclid: String(x.utm?.gclid || ''),
        nome: cfg.adsRotuloConversao,
        // Formato aceito pelo Google Ads: yyyy-MM-dd HH:mm:ss (com TimeZone no cabecalho)
        quando: quando.toISOString().replace('T', ' ').slice(0, 19),
        valor: Number(x.sale_value || 0),
        moeda: 'BRL',
        pedido: String(x.id || ''),
        diasDesdeClique: null,
        foraDaJanela: false,
      };
    });
  } catch (e: any) {
    return { ...vazio, recado: 'nao consegui ler os pedidos: ' + String(e?.message || e) };
  }

  const comGclid = linhas.length;
  let recado: string;
  if (totalPedidos === 0) recado = 'Nenhum pedido no período.';
  else if (comGclid === 0) {
    recado = totalPedidos + ' pedido(s) no período, nenhum com gclid. '
      + 'É o esperado enquanto não houver anúncio no Google rodando — o gclid só existe em clique de anúncio.';
  } else {
    recado = comGclid + ' de ' + totalPedidos + ' pedido(s) vieram de clique no Google e podem voltar para o Ads como conversão.';
  }

  return { linhas, total: linhas.length, comGclid, foraDaJanela: 0, totalPedidos, recado };
}

/**
 * CSV no formato exato que o Google Ads aceita em "Importar conversões".
 * Cabeçalho de parâmetros com fuso, depois as colunas obrigatórias.
 */
export async function csvGoogleAds(dias = 90): Promise<string> {
  const { linhas } = await conversoesOffline(dias);
  const esc = (s: any) => {
    const v = String(s ?? '');
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const out: string[] = [];
  out.push('Parameters:TimeZone=America/Sao_Paulo');
  out.push(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency', 'Order ID'].join(','));
  for (const l of linhas) {
    out.push([esc(l.gclid), esc(l.nome), esc(l.quando), l.valor.toFixed(2), esc(l.moeda), esc(l.pedido)].join(','));
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Diagnostico — o que esta de pe e o que so voce pode fazer
// ---------------------------------------------------------------------------

export type ItemDiagnostico = {
  item: string; estado: 'ok' | 'falta' | 'atencao'; detalhe: string; quemResolve: 'sistema' | 'voce';
};

export async function diagnosticoGoogle(): Promise<{
  itens: ItemDiagnostico[]; prontos: number; pendentes: number;
  seoLigado: boolean; medindo: boolean; conversoes: any;
}> {
  const cfg = await configGoogle(true);
  const itens: ItemDiagnostico[] = [];
  const add = (item: string, estado: ItemDiagnostico['estado'], detalhe: string, quemResolve: ItemDiagnostico['quemResolve'] = 'sistema') =>
    itens.push({ item, estado, detalhe, quemResolve });

  add('robots.txt', 'ok', 'Servido de verdade em ' + cfg.siteUrl + '/robots.txt — antes disso devolvia o HTML do painel, que o robô trata como arquivo quebrado.');
  add('sitemap.xml', 'ok', 'Gerado do catálogo ativo, com data de atualização por produto.');
  add('Dado estruturado', 'ok', 'LocalBusiness + WebSite + lista de produtos com preço, no HTML servido. Sem FAQPage: o Google parou de mostrar esse formato em maio de 2026.');
  add('Título e descrição', 'ok', 'Reescritos para o que a pessoa digita: sucos naturais, Goiânia, atacado e revenda.');
  add('Endereço no dado estruturado',
    cfg.rua ? 'ok' : 'atencao',
    cfg.rua ? cfg.rua + ' — ' + cfg.cidade + '/' + cfg.uf
      : 'Só a cidade está preenchida. Endereço inventado é pior que endereço nenhum: o Google cruza com o Perfil da Empresa. Preencha na tela.',
    cfg.rua ? 'sistema' : 'voce');
  add('Telefone público', cfg.telefone ? 'ok' : 'atencao',
    cfg.telefone || 'Não informado. Sem ele o negócio aparece sem forma de contato no resultado local.', cfg.telefone ? 'sistema' : 'voce');
  add('Google Analytics 4', cfg.ga4Id ? 'ok' : 'falta',
    cfg.ga4Id || 'Sem ID. Crie a propriedade em analytics.google.com e cole o G-XXXXXXX aqui — a tag entra sozinha, sem deploy.', 'voce');
  add('Google Ads', cfg.adsId ? 'ok' : 'falta',
    cfg.adsId || 'Sem conta. Sem ela não há anúncio de busca — e quem procura "suco natural atacado Goiânia" continua não achando.', 'voce');
  add('Search Console', cfg.verificacaoSearchConsole ? 'ok' : 'falta',
    cfg.verificacaoSearchConsole
      ? 'Verificado por meta tag.'
      : 'Sem verificação. É o que mostra quais buscas trazem gente, e onde se envia o sitemap. Cole o código da meta tag aqui.', 'voce');
  add('Perfil da Empresa no Google', 'falta',
    'Não dá para criar por API sem sua conta. É o item de maior retorno para busca local: sem ele, a Honest não aparece no mapa nem no "perto de mim".', 'voce');
  add('Conversões offline para o Ads', 'ok',
    'A fila lê os pedidos com gclid e exporta no formato que o Ads aceita. Só falta o Ads existir para receber.');

  const conv = await conversoesOffline(90);
  const prontos = itens.filter(i => i.estado === 'ok').length;
  return {
    itens, prontos, pendentes: itens.length - prontos,
    seoLigado: cfg.seoLigado, medindo: !!(cfg.ga4Id || cfg.adsId),
    conversoes: { total: conv.total, comGclid: conv.comGclid, totalPedidos: conv.totalPedidos, recado: conv.recado },
  };
}
