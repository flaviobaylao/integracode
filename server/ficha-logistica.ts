// ============================================================================
// FICHA LOGÍSTICA DO PRODUTO (PDF gerado no servidor) — set/2026
// ----------------------------------------------------------------------------
// Complementa a ficha técnica (PDF anexado pela equipe) com o que o cliente de
// rede/distribuidor pede no cadastro de fornecedor: peso e medidas da unidade,
// do fardo e do palete, com o desenho do enfardamento e da paletização e as
// regras de segurança para transporte. Nasce dos campos logísticos do cadastro
// do produto — muda o cadastro, muda a ficha; nada é digitado duas vezes.
//
// Rotas:
//   GET /api/products/:id/ficha-logistica          (logado; ?download=1 baixa)
//   GET /api/public/products/:id/ficha-logistica   (link que a IA manda ao cliente)
// Material de divulgação: não expõe preço, estoque nem nada interno.
// ============================================================================
import type { Express } from "express";
import { jsPDF } from "jspdf";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { calcularLogistica, PALETE_PADRAO, type LogisticaCalculada } from "@shared/logistica-produto";

const AZUL: [number, number, number] = [30, 64, 175];
const CINZA: [number, number, number] = [100, 116, 139];
const CINZA_CLARO: [number, number, number] = [226, 232, 240];
const VERDE: [number, number, number] = [22, 163, 74];

const fmt = (n: number, casas = 1) => n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas });

export const REGRAS_TRANSPORTE = [
  'Garrafas sempre em pé, tampa para cima, no fardo e no palete — nunca deitadas.',
  'Empilhamento em COLUNA: fardo exatamente sobre fardo, garrafa sobre garrafa. Camada cruzada ("amarrada") apoia o peso no ombro da garrafa PET e amassa o produto.',
  'Chapa separadora (papelão ou plástico) entre TODAS as camadas e uma tampa no topo: distribui a carga e evita que o fardo de cima afunde no de baixo.',
  'Carga centralizada no palete, sem beirada (overhang zero); cantoneiras nas 4 quinas antes do filme.',
  'Filme stretch: mínimo 5 voltas no corpo, 2 voltas amarrando a carga ao estrado (a carga não pode deslizar sobre o palete) e 2 voltas no topo.',
  'Respeitar altura máxima de 1,50 m (com estrado) e carga máxima de 1.000 kg por palete; um palete não sobe sobre outro no transporte.',
  'Paletes travados no baú (calços/cintas) para não deslocar em frenagem; produto refrigerado entre -2 °C e 5 °C, baú pré-resfriado antes de carregar.',
  'Palete avariado, com tábua solta ou prego exposto não recebe carga.',
];

// Busca o produto com os campos logísticos, em SQL cru para não depender de o
// schema drizzle já ter as colunas no banco (o ALTER roda no boot, mas se ele
// falhar a ficha avisa em vez de derrubar a rota).
export async function carregarProdutoLogistica(id: string): Promise<any | null> {
  const r: any = await db.execute(sql`
    SELECT id, name, description, ncm, is_active, internal_only,
           peso_bruto_g, peso_embalagem_g, diametro_cm, altura_cm,
           fardo_filas, fardo_por_fila, fardo_filme_g,
           palet_fardos_camada, palet_camadas, palet_tipo
    FROM products WHERE id = ${id}`);
  const row = r.rows?.[0];
  if (!row) return null;
  return {
    id: row.id, name: row.name, description: row.description, ncm: row.ncm,
    isActive: row.is_active, internalOnly: row.internal_only,
    pesoBrutoG: row.peso_bruto_g, pesoEmbalagemG: row.peso_embalagem_g,
    diametroCm: row.diametro_cm, alturaCm: row.altura_cm,
    fardoFilas: row.fardo_filas, fardoPorFila: row.fardo_por_fila, fardoFilmeG: row.fardo_filme_g,
    paletFardosCamada: row.palet_fardos_camada, paletCamadas: row.palet_camadas, paletTipo: row.palet_tipo,
  };
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------
function titulo(doc: any, texto: string, y: number): number {
  doc.setFillColor(...AZUL);
  doc.rect(15, y, 180, 6, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(texto, 17.5, y + 4.3);
  doc.setTextColor(0, 0, 0);
  return y + 8;
}

function tabela(doc: any, linhas: [string, string][], x: number, y: number, w: number): number {
  doc.setFontSize(8.5);
  const alt = 5.0;
  linhas.forEach(([k, v], i) => {
    if (i % 2 === 0) { doc.setFillColor(248, 250, 252); doc.rect(x, y, w, alt, 'F'); }
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...CINZA);
    doc.text(k, x + 2, y + 3.9);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
    doc.text(v, x + w - 2, y + 3.9, { align: 'right' });
    y += alt;
  });
  doc.setTextColor(0, 0, 0);
  return y;
}

// Fardo visto de cima: círculos = garrafas; retângulo = filme.
function desenharFardo(doc: any, lg: LogisticaCalculada, x: number, y: number, maxW: number, maxH: number) {
  const { porFila, filas, compCm, largCm } = lg.fardo;
  if (!porFila || !filas) return;
  const esc = Math.min(maxW / compCm, maxH / largCm);
  const w = compCm * esc, h = largCm * esc, r = (lg.unidade.diametroCm * esc) / 2;
  const ox = x + (maxW - w) / 2, oy = y + (maxH - h) / 2;
  doc.setDrawColor(...AZUL); doc.setLineWidth(0.5);
  doc.setFillColor(239, 246, 255); doc.roundedRect(ox, oy, w, h, 1.2, 1.2, 'FD');
  doc.setFillColor(255, 255, 255); doc.setDrawColor(...CINZA); doc.setLineWidth(0.3);
  for (let i = 0; i < porFila; i++) for (let j = 0; j < filas; j++) {
    const cx = ox + r + i * 2 * r, cy = oy + r + j * 2 * r;
    doc.circle(cx, cy, r, 'FD');
    doc.setFillColor(...CINZA_CLARO); doc.circle(cx, cy, r * 0.35, 'F'); doc.setFillColor(255, 255, 255);
  }
  doc.setFontSize(7); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'normal');
  doc.text(`${fmt(compCm)} cm`, ox + w / 2, oy + h + 3.5, { align: 'center' });
  doc.text(`${fmt(largCm)} cm`, ox - 1.5, oy + h / 2, { align: 'right', angle: 90 });
  doc.setTextColor(0, 0, 0);
}

// Camada do palete vista de cima: retângulos = fardos (cor diferente para o girado).
function desenharCamada(doc: any, lg: LogisticaCalculada, x: number, y: number, maxW: number) {
  const P = PALETE_PADRAO.compCm, Q = PALETE_PADRAO.largCm;
  const esc = maxW / P;
  const w = P * esc, h = Q * esc;
  // estrado
  doc.setDrawColor(120, 83, 40); doc.setLineWidth(0.5); doc.setFillColor(254, 243, 199);
  doc.rect(x, y, w, h, 'FD');
  doc.setDrawColor(200, 160, 90); doc.setLineWidth(0.2);
  for (let i = 1; i < 7; i++) doc.line(x, y + (h / 7) * i, x + w, y + (h / 7) * i);
  // fardos
  doc.setLineWidth(0.3);
  for (const r of lg.palete.arranjo.posicoes) {
    if (r.girado) { doc.setFillColor(191, 219, 254); doc.setDrawColor(...AZUL); }
    else { doc.setFillColor(219, 234, 254); doc.setDrawColor(...AZUL); }
    doc.rect(x + r.x * esc, y + r.y * esc, r.w * esc, r.h * esc, 'FD');
  }
  doc.setFontSize(7); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'normal');
  doc.text(`${P} cm`, x + w / 2, y + h + 3.5, { align: 'center' });
  doc.text(`${Q} cm`, x - 1.5, y + h / 2, { align: 'right', angle: 90 });
  doc.setTextColor(0, 0, 0);
  return h;
}

// Palete visto de lado: estrado + camadas empilhadas em coluna, com separadores.
function desenharLateral(doc: any, lg: LogisticaCalculada, x: number, y: number, maxW: number, maxH: number) {
  const P = PALETE_PADRAO.compCm;
  const altTotal = Math.max(lg.palete.alturaTotalCm, 40);
  const esc = Math.min(maxW / P, maxH / altTotal);
  const w = P * esc;
  const base = y + maxH; // linha do chão
  // estrado
  const hb = PALETE_PADRAO.baseCm * esc;
  doc.setDrawColor(120, 83, 40); doc.setLineWidth(0.4); doc.setFillColor(254, 243, 199);
  doc.rect(x, base - hb, w, hb, 'FD');
  doc.setFillColor(217, 180, 120);
  for (const fx of [0.04, 0.47, 0.9]) doc.rect(x + w * fx, base - hb + 1, w * 0.06, hb - 2, 'F');
  // camadas
  const hc = lg.fardo.altCm * esc;
  const largCarga = Math.max(...lg.palete.arranjo.posicoes.map(r => r.x + r.w), 0) - Math.min(...lg.palete.arranjo.posicoes.map(r => r.x), 0);
  const cx = x + ((P - largCarga) / 2) * esc, cw = largCarga * esc;
  // colunas de fardos ao longo do comprimento (para o desenho lateral basta o padrão da 1ª fila)
  const primeiraFila = lg.palete.arranjo.posicoes.filter(r => Math.abs(r.y - Math.min(...lg.palete.arranjo.posicoes.map(p => p.y))) < 0.01);
  for (let c = 0; c < lg.palete.camadas; c++) {
    const yTop = base - hb - hc * (c + 1);
    for (const r of primeiraFila) {
      doc.setFillColor(c % 2 ? 219 : 191, c % 2 ? 234 : 219, 254); doc.setDrawColor(...AZUL); doc.setLineWidth(0.25);
      doc.rect(x + r.x * esc, yTop, r.w * esc, hc, 'FD');
    }
    // separador entre camadas
    doc.setDrawColor(120, 83, 40); doc.setLineWidth(0.5);
    doc.line(cx, yTop + hc, cx + cw, yTop + hc);
  }
  // tampa
  if (lg.palete.camadas) {
    const yTopo = base - hb - hc * lg.palete.camadas;
    doc.setDrawColor(120, 83, 40); doc.setLineWidth(0.6); doc.line(cx, yTopo, cx + cw, yTopo);
    // cota de altura
    doc.setDrawColor(...CINZA); doc.setLineWidth(0.2);
    doc.line(x + w + 3, base, x + w + 3, yTopo);
    doc.line(x + w + 1.5, base, x + w + 4.5, base); doc.line(x + w + 1.5, yTopo, x + w + 4.5, yTopo);
    doc.setFontSize(7); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'normal');
    doc.text(`${fmt(lg.palete.alturaTotalCm)} cm`, x + w + 5, (base + yTopo) / 2 + 1);
    doc.text(`${lg.palete.camadas} camadas`, x + w / 2, base + 3.5, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }
}

export function montarFichaLogisticaPdf(produto: any, emitente?: { nome?: string; cnpj?: string }): Buffer {
  const lg = calcularLogistica(produto);
  const doc: any = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const hoje = new Date().toLocaleDateString('pt-BR');

  // Cabeçalho
  doc.setFillColor(...AZUL); doc.rect(0, 0, 210, 22, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('FICHA LOGÍSTICA', 15, 10);
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  doc.text(emitente?.nome || 'Honest Sucos Naturais', 15, 16.5);
  doc.text(`Emitida em ${hoje}`, 195, 10, { align: 'right' });
  if (emitente?.cnpj) doc.text(`CNPJ ${emitente.cnpj}`, 195, 16.5, { align: 'right' });
  doc.setTextColor(0, 0, 0);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(String(produto.name || 'Produto'), 15, 31);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...CINZA);
  const sub = [produto.description, produto.ncm ? `NCM ${produto.ncm}` : ''].filter(Boolean).join('  ·  ');
  if (sub) doc.text(String(sub).slice(0, 120), 15, 36);
  doc.setTextColor(0, 0, 0);

  let y = 41;
  if (!lg) {
    doc.setFontSize(10);
    doc.text('Este produto ainda não tem peso e medidas cadastrados. Preencha a seção "Logística" em Produtos > Editar Produto.', 15, y + 6, { maxWidth: 180 });
    return Buffer.from(doc.output('arraybuffer'));
  }

  // 1. Unidade + Fardo (lado a lado)
  y = titulo(doc, '1. UNIDADE DE VENDA E FARDO (EMBALAGEM MASTER)', y);
  const u = lg.unidade, f = lg.fardo;
  const yTab = tabela(doc, [
    ['Peso bruto da unidade (cheia)', `${fmt(u.pesoBrutoG)} g`],
    ['Peso da embalagem (garrafa PET)', `${fmt(u.pesoEmbalagemG)} g`],
    ['Peso líquido da unidade', `${fmt(u.pesoLiquidoG)} g`],
    ['Garrafa (Ø × altura)', `${fmt(u.diametroCm)} × ${fmt(u.alturaCm)} cm`],
    ['Unidades por fardo', f.unidades ? `${f.unidades} (${f.filas} filas × ${f.porFila})` : '—'],
    ['Fardo (C × L × A)', f.unidades ? `${fmt(f.compCm)} × ${fmt(f.largCm)} × ${fmt(f.altCm)} cm` : '—'],
    ['Peso bruto do fardo', f.unidades ? `${fmt(f.pesoBrutoKg, 3)} kg` : '—'],
    ['Peso líquido do fardo', f.unidades ? `${fmt(f.pesoLiquidoKg, 3)} kg` : '—'],
    ['Filme termoencolhível', `${fmt(f.filmeG)} g por fardo`],
  ], 15, y, 110);
  doc.setFontSize(7.5); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'bold');
  doc.text('FARDO — VISTA DE CIMA', 165, y + 2, { align: 'center' });
  doc.setTextColor(0, 0, 0);
  desenharFardo(doc, lg, 133, y + 5, 64, yTab - y - 12);
  y = yTab + 5;

  // 2. Palete
  y = titulo(doc, `2. PALETIZAÇÃO — PALETE ${lg.palete.tipo.toUpperCase()}`, y);
  const p = lg.palete;
  if (!p.fardos) {
    doc.setFontSize(9); doc.text('Paletização não definida para este produto (fardos por camada / camadas em branco).', 15, y + 4);
    y += 10;
  } else {
    const yTab2 = tabela(doc, [
      ['Arranjo da camada', `${p.fardosPorCamada} fardos (${p.arranjo.descricao})`],
      ['Ocupação da camada', `${fmt(p.ocupacaoPct)} %`],
      ['Camadas (empilhamento em coluna)', `${p.camadas}`],
      ['Fardos por palete', `${p.fardos}`],
      ['Unidades por palete', `${p.unidades}`],
      ['Altura da carga / total com estrado', `${fmt(p.alturaCargaCm)} / ${fmt(p.alturaTotalCm)} cm`],
      ['Peso da carga / total com palete', `${fmt(p.pesoCargaKg)} / ${fmt(p.pesoTotalKg)} kg`],
      ['Limites de segurança', `até ${PALETE_PADRAO.alturaMaxCm} cm de altura e ${PALETE_PADRAO.pesoMaxKg} kg de carga`],
    ], 15, y, 92);
    for (const a of p.alertas) {
      doc.setFontSize(8); doc.setTextColor(180, 83, 9); doc.setFont('helvetica', 'bold');
      doc.text('ATENCAO: ' + a, 15, (y = (y > yTab2 ? y : yTab2) + 4), { maxWidth: 92 });
      doc.setTextColor(0, 0, 0);
    }
    // desenhos: camada (cima) e lateral
    doc.setFontSize(7.5); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'bold');
    doc.text('CAMADA — VISTA DE CIMA', 154, y + 2, { align: 'center' });
    doc.setTextColor(0, 0, 0);
    const hCam = desenharCamada(doc, lg, 122, y + 5, 64);
    let yLat = y + 5 + hCam + 8;
    doc.setFontSize(7.5); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'bold');
    doc.text('PALETE — VISTA LATERAL', 154, yLat, { align: 'center' });
    doc.setTextColor(0, 0, 0);
    desenharLateral(doc, lg, 122, yLat + 2, 56, 38);
    y = Math.max(yTab2 + 4, yLat + 46);
  }

  // 3. Regras de segurança
  y = titulo(doc, '3. ENFARDAMENTO E TRANSPORTE — REGRAS DE SEGURANÇA', y);
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  for (const regra of REGRAS_TRANSPORTE) {
    if (y > 282) { doc.addPage(); y = 20; }
    doc.setFillColor(...VERDE); doc.circle(17.5, y + 1.6, 0.9, 'F');
    const linhas = doc.splitTextToSize(regra, 172);
    doc.text(linhas, 20.5, y + 2.6);
    y += 3.4 * linhas.length + 1.2;
  }

  // Rodapé
  const paginas = doc.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i);
    doc.setFontSize(7); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'normal');
    doc.text('Ficha gerada pelo Integra a partir do cadastro do produto. Pesos médios de produção; conservar refrigerado (-2 °C a 5 °C).', 15, 291);
    doc.text(`${i}/${paginas}`, 195, 291, { align: 'right' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}

// Texto para os agentes de IA (consultar_ficha_tecnica) e para o hotsite.
export function textoLogistica(produto: any): string {
  const lg = calcularLogistica(produto);
  if (!lg) return '';
  const u = lg.unidade, f = lg.fardo, p = lg.palete;
  const partes = [
    `Peso da unidade: ${fmt(u.pesoBrutoG)} g bruto / ${fmt(u.pesoLiquidoG)} g líquido; garrafa PET ${fmt(u.pesoEmbalagemG)} g, Ø ${fmt(u.diametroCm)} cm × ${fmt(u.alturaCm)} cm de altura.`,
  ];
  if (f.unidades) partes.push(`Fardo (embalagem master): ${f.unidades} unidades (${f.filas} filas × ${f.porFila}), ${fmt(f.compCm)} × ${fmt(f.largCm)} × ${fmt(f.altCm)} cm, ${fmt(f.pesoBrutoKg, 3)} kg bruto / ${fmt(f.pesoLiquidoKg, 3)} kg líquido.`);
  if (p.fardos) partes.push(`Palete ${p.tipo}: ${p.fardosPorCamada} fardos por camada (${p.arranjo.descricao}) × ${p.camadas} camadas = ${p.fardos} fardos / ${p.unidades} unidades; ${fmt(p.alturaTotalCm)} cm de altura e ${fmt(p.pesoTotalKg)} kg com o palete.`);
  return partes.join(' ');
}

export function registerFichaLogisticaRoutes(app: Express) {
  const servir = async (req: any, res: any) => {
    try {
      const produto = await carregarProdutoLogistica(String(req.params.id));
      if (!produto || produto.internalOnly) return res.status(404).json({ message: "Produto não encontrado" });
      const pdf = montarFichaLogisticaPdf(produto);
      const nome = `Ficha_Logistica_${String(produto.name || 'produto').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60)}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(pdf.length));
      res.setHeader("Content-Disposition", `${req.query?.download ? 'attachment' : 'inline'}; filename="${nome}"`);
      res.setHeader("Cache-Control", "private, max-age=60");
      res.end(pdf);
    } catch (e: any) {
      console.error("[FICHA-LOGISTICA]", e?.message || e);
      res.status(500).json({ message: "Falha ao gerar a ficha logística" });
    }
  };
  app.get("/api/products/:id/ficha-logistica", authenticateUser, servir);
  app.get("/api/public/products/:id/ficha-logistica", servir);
}
