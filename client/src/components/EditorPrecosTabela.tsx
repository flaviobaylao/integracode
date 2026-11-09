// ============================================================================
// EDITOR DE PREÇOS DA TABELA — Marketing de Vendas (09/nov/2026)
// ---------------------------------------------------------------------------
// As tabelas de preços da Honest são artes 2160×2700 com o mesmo desenho
// (8 sabores em 2 colunas × 4 linhas, 350 ml e 900 ml, barra de pedido mínimo
// embaixo). Em vez de pedir uma arte nova a cada mudança de preço, o admin
// digita os valores aqui e o navegador reescreve SÓ os números por cima da
// imagem atual: cobre a área do preço com a cor da caixinha e escreve o valor
// novo em Poppins Bold, alinhado à direita, na mesma linha de base. A barra de
// pedido mínimo é redesenhada inteira. Fotos, sabores e rodapé ficam intactos.
//
// As coordenadas foram medidas nas 4 artes oficiais (PJ GYN, PJ IND/SERV,
// PJ BSB, PF GYN) e batem pixel a pixel entre elas. Arte com outro tamanho
// não é editável aqui — o editor avisa e não salva.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

export const MODELO_TABELA_ID = "tabela_honest_v1";

const M = {
  largura: 2160,
  altura: 2700,
  colunas: [{ xl: 545, xr: 1024 }, { xl: 1565, xr: 2044 }],
  linha0: 668,       // topo da caixinha 350 ml do 1º sabor
  passoLinha: 472,   // distância entre sabores na mesma coluna
  passo900: 136,     // da caixinha 350 ml para a 900 ml
  alturaCaixa: 117,
  corCaixa: "#F4F7EF",
  corTexto: "#1C4028",
  preco: { fonte: 55, baseline: 79, margemDireita: 34, inicioCobertura: 180, larguraMax: 270 },
  barra: { x0: 140, y0: 2428, x1: 2020, y1: 2540, raio: 40, baseline: 2501, centroX: 1080, fonte: 51.5, cor: "#1C4028" },
};

export const SABORES_TABELA: { chave: string; nome: string; col: number; linha: number }[] = [
  { chave: "limonada", nome: "Limonada", col: 0, linha: 0 },
  { chave: "acerola", nome: "Acerola", col: 1, linha: 0 },
  { chave: "maracuja", nome: "Maracujá", col: 0, linha: 1 },
  { chave: "morango_limao", nome: "Morango com Limão", col: 1, linha: 1 },
  { chave: "morango_maracuja", nome: "Morango com Maracujá", col: 0, linha: 2 },
  { chave: "frutas_vermelhas", nome: "Frutas Vermelhas", col: 1, linha: 2 },
  { chave: "pink_lemonade", nome: "Pink Lemonade", col: 0, linha: 3 },
  { chave: "uva", nome: "Uva", col: 1, linha: 3 },
];

export type DadosTabela = {
  modelo: string;
  pedidoMinimo: number;
  precos: Record<string, { p350: number; p900: number }>;
};

const FONTE = "PoppinsTabela";
let fonteCarregada: Promise<void> | null = null;
function carregarFonte(): Promise<void> {
  if (!fonteCarregada) {
    const ff = new FontFace(FONTE, "url(/fonts/Poppins-Bold.ttf)", { weight: "700" });
    fonteCarregada = ff.load().then((f) => { (document as any).fonts.add(f); }).catch((e) => {
      fonteCarregada = null;
      throw e;
    });
  }
  return fonteCarregada;
}

export const moeda = (v: number) =>
  "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "4,80" / "4.80" / "R$ 4,80" -> 4.8 ; vazio/ inválido -> NaN
export function lerValor(s: string): number {
  const t = String(s || "").replace(/[^\d,.-]/g, "");
  if (!t) return NaN;
  const norm = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  const n = Number(norm);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
const paraCampo = (n?: number) => (Number.isFinite(n as number) ? (n as number).toFixed(2).replace(".", ",") : "");

function desenhar(ctx: CanvasRenderingContext2D, base: CanvasImageSource, d: DadosTabela) {
  ctx.drawImage(base, 0, 0, M.largura, M.altura);
  ctx.textBaseline = "alphabetic";
  for (const s of SABORES_TABELA) {
    const col = M.colunas[s.col];
    const p = d.precos[s.chave];
    [p?.p350, p?.p900].forEach((valor, k) => {
      const topo = M.linha0 + s.linha * M.passoLinha + k * M.passo900;
      ctx.fillStyle = M.corCaixa;
      ctx.fillRect(col.xl + M.preco.inicioCobertura, topo + 10, col.xr - 14 - (col.xl + M.preco.inicioCobertura), M.alturaCaixa - 20);
      if (!Number.isFinite(valor as number)) return;
      const txt = moeda(valor as number);
      let tam = M.preco.fonte;
      ctx.font = `700 ${tam}px ${FONTE}`;
      while (ctx.measureText(txt).width > M.preco.larguraMax && tam > 36) {
        tam -= 1;
        ctx.font = `700 ${tam}px ${FONTE}`;
      }
      ctx.fillStyle = M.corTexto;
      ctx.textAlign = "right";
      ctx.fillText(txt, col.xr - M.preco.margemDireita, topo + M.preco.baseline);
    });
  }
  const b = M.barra;
  ctx.fillStyle = b.cor;
  ctx.beginPath();
  (ctx as any).roundRect ? (ctx as any).roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, b.raio) : ctx.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.font = `700 ${b.fonte}px ${FONTE}`;
  ctx.fillText(`Pedido mínimo ${moeda(d.pedidoMinimo)}`, b.centroX, b.baseline);
}

type Props = {
  material: { id: string; titulo: string; url: string; fileName: string; dados?: any } | null;
  onClose: () => void;
  onSalvo: () => void;
};

export default function EditorPrecosTabela({ material, onClose, onSalvo }: Props) {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<ImageBitmap | null>(null);
  const [erroBase, setErroBase] = useState<string | null>(null);
  const [campos, setCampos] = useState<Record<string, { p350: string; p900: string }>>({});
  const [minimo, setMinimo] = useState("");
  const [salvando, setSalvando] = useState(false);

  // carrega a arte atual + fonte e preenche os campos com os valores guardados
  useEffect(() => {
    if (!material) return;
    let vivo = true;
    setBase(null); setErroBase(null);
    const d: DadosTabela | null = material.dados?.modelo === MODELO_TABELA_ID ? material.dados : null;
    const c: Record<string, { p350: string; p900: string }> = {};
    for (const s of SABORES_TABELA) {
      c[s.chave] = { p350: paraCampo(d?.precos?.[s.chave]?.p350), p900: paraCampo(d?.precos?.[s.chave]?.p900) };
    }
    setCampos(c);
    setMinimo(paraCampo(d?.pedidoMinimo));
    (async () => {
      try {
        await carregarFonte();
        const r = await fetch(material.url, { credentials: "include", cache: "no-store" });
        const bmp = await createImageBitmap(await r.blob());
        if (!vivo) return;
        if (bmp.width !== M.largura || bmp.height !== M.altura) {
          setErroBase(`Esta arte tem ${bmp.width}×${bmp.height}. A edição de preços só funciona no modelo padrão das tabelas Honest (${M.largura}×${M.altura}). Para esta, use “Nova versão”.`);
        }
        setBase(bmp);
      } catch (e: any) {
        if (vivo) setErroBase("Não consegui carregar a arte ou a fonte: " + (e?.message || e));
      }
    })();
    return () => { vivo = false; };
  }, [material?.id]);

  const dados: DadosTabela | null = useMemo(() => {
    const precos: DadosTabela["precos"] = {};
    for (const s of SABORES_TABELA) {
      const v = campos[s.chave];
      if (!v) return null;
      precos[s.chave] = { p350: lerValor(v.p350), p900: lerValor(v.p900) };
    }
    return { modelo: MODELO_TABELA_ID, pedidoMinimo: lerValor(minimo), precos };
  }, [campos, minimo]);

  const faltando = useMemo(() => {
    if (!dados) return ["preços"];
    const f: string[] = [];
    for (const s of SABORES_TABELA) {
      const p = dados.precos[s.chave];
      if (!(p.p350 > 0)) f.push(`${s.nome} 350 ml`);
      if (!(p.p900 > 0)) f.push(`${s.nome} 900 ml`);
    }
    if (!(dados.pedidoMinimo >= 0) || !Number.isFinite(dados.pedidoMinimo)) f.push("pedido mínimo");
    return f;
  }, [dados]);

  // pré-visualização ao vivo
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !base || erroBase || !dados) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    desenhar(ctx, base, { ...dados, pedidoMinimo: Number.isFinite(dados.pedidoMinimo) ? dados.pedidoMinimo : 0 });
  }, [base, dados, erroBase]);

  async function salvar() {
    if (!material || !dados || !canvasRef.current) return;
    if (faltando.length) {
      toast({ title: "Faltam valores", description: faltando.slice(0, 4).join(", ") + (faltando.length > 4 ? "…" : ""), variant: "destructive" });
      return;
    }
    setSalvando(true);
    try {
      const blob: Blob | null = await new Promise((ok) => canvasRef.current!.toBlob(ok, "image/png"));
      if (!blob) throw new Error("Falha ao gerar a imagem");
      const nome = (material.fileName || "tabela.png").replace(/\.[^.]+$/, "") + ".png";
      const fd = new FormData();
      fd.append("arquivo", new File([blob], nome, { type: "image/png" }));
      fd.append("dados", JSON.stringify(dados));
      const r = await fetch(`/api/marketing-vendas/${material.id}/precos`, { method: "PUT", body: fd, credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || "Falha ao salvar");
      toast({ title: "Tabela atualizada", description: "A equipe já vê os preços novos." });
      onSalvo();
      onClose();
    } catch (e: any) {
      toast({ title: "Não salvou", description: e?.message, variant: "destructive" });
    } finally { setSalvando(false); }
  }

  const setCampo = (chave: string, k: "p350" | "p900", v: string) =>
    setCampos((c) => ({ ...c, [chave]: { ...c[chave], [k]: v } }));

  return (
    <Dialog open={!!material} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl w-[96vw] max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Editar preços — {material?.titulo}</DialogTitle></DialogHeader>
        <div className="grid md:grid-cols-[1fr_1.1fr] gap-4">
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_90px_90px] gap-2 text-xs font-semibold text-muted-foreground">
              <span>Sabor</span><span className="text-right">350 ml</span><span className="text-right">900 ml</span>
            </div>
            {SABORES_TABELA.map((s) => (
              <div key={s.chave} className="grid grid-cols-[1fr_90px_90px] gap-2 items-center">
                <span className="text-sm">{s.nome}</span>
                <Input inputMode="decimal" className="h-8 text-right" value={campos[s.chave]?.p350 || ""}
                  onChange={(e) => setCampo(s.chave, "p350", e.target.value)} placeholder="0,00" data-testid={`preco-${s.chave}-350`} />
                <Input inputMode="decimal" className="h-8 text-right" value={campos[s.chave]?.p900 || ""}
                  onChange={(e) => setCampo(s.chave, "p900", e.target.value)} placeholder="0,00" data-testid={`preco-${s.chave}-900`} />
              </div>
            ))}
            <div className="grid grid-cols-[1fr_188px] gap-2 items-center pt-2 border-t">
              <Label className="text-sm font-semibold">Pedido mínimo (R$)</Label>
              <Input inputMode="decimal" className="h-8 text-right" value={minimo} onChange={(e) => setMinimo(e.target.value)}
                placeholder="200,00" data-testid="preco-pedido-minimo" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Só os números e a barra de pedido mínimo mudam; fotos e sabores ficam como estão. A versão anterior é substituída para toda a equipe.
            </p>
            {faltando.length > 0 && !erroBase && (
              <p className="text-[11px] text-amber-700">Falta preencher: {faltando.slice(0, 6).join(", ")}{faltando.length > 6 ? "…" : ""}</p>
            )}
          </div>
          <div>
            {erroBase ? (
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">{erroBase}</div>
            ) : !base ? (
              <div className="text-sm text-muted-foreground p-6 text-center">Carregando a arte...</div>
            ) : (
              <canvas ref={canvasRef} width={M.largura} height={M.altura} className="w-full h-auto rounded border" />
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={salvar} disabled={salvando || !!erroBase || !base} data-testid="preco-salvar">
            {salvando ? "Salvando..." : "Salvar e publicar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
