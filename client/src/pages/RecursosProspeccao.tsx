import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SatelliteDish, Save, RefreshCw, Loader2, Image as ImageIcon, Gauge, Users, Check, Camera, ShieldCheck, Info , Phone, MapPin, Search } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";

type Cfg = Record<string, string>;
type Uso = {
  mes: string; preco: number; cota: number; cambio?: number; precoBRL?: number;
  totalRadar: number; totalCobravel: number; cobravelPago: number; custoUSD: number; custoBRL?: number; fichaTotal: number;
  custoRadarUSD?: number; custoFotoUSD?: number;
  fotoTotal?: number; fotoCobravel?: number; fotoCota?: number; fotoPreco?: number; fotoPrecoBRL?: number; fotoPago?: number;
  fichaCobravel?: number; fichaCota?: number;
  notaMin?: number;
  telefoneTotal?: number; telefoneCobravel?: number; telefoneCota?: number; telefonePreco?: number; custoTelefoneUSD?: number; limiteTelefone?: number;
  blindagem?: boolean; margem?: number;
  limites?: { radar: number; foto: number; ficha: number };
  autoOff?: { radar: boolean; foto: boolean; ficha: boolean };
  override?: { radar: boolean; foto: boolean; ficha: boolean };
  porVendedor: { vendedor: string; userId: string | null; radarTotal: number; radarCobravel: number; fotoTotal?: number; fichaTotal: number }[];
};

// Segmentos em português → tipos do Google Places (New). O que fica salvo são os códigos do Google;
// aqui o admin escolhe pelo nome em português.
const SEG_GROUPS: { label: string; codes: string[] }[] = [
  { label: "Padaria / Confeitaria", codes: ["bakery"] },
  { label: "Supermercado / Mercado", codes: ["supermarket", "grocery_store"] },
  { label: "Mercearia / Conveniência", codes: ["convenience_store"] },
  { label: "Restaurante", codes: ["restaurant"] },
  { label: "Lanchonete / Fast-food", codes: ["meal_takeaway", "fast_food_restaurant", "sandwich_shop", "hamburger_restaurant"] },
  { label: "Pizzaria", codes: ["pizza_restaurant"] },
  { label: "Cafeteria", codes: ["cafe", "coffee_shop"] },
  { label: "Sorveteria / Açaí", codes: ["ice_cream_shop"] },
  { label: "Bar", codes: ["bar"] },
  { label: "Escola / Educação", codes: ["school", "primary_school", "secondary_school", "university", "preschool"] },
  { label: "Academia", codes: ["gym", "fitness_center"] },
  { label: "Hotel / Pousada", codes: ["hotel"] },
];

const brl = (n: number) => `R$ ${(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (n: number) => `US$ ${(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function RecursosProspeccao() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [uso, setUso] = useState<Uso | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [usoLoading, setUsoLoading] = useState(false);
  const [avancado, setAvancado] = useState(false);
  const [infoCobranca, setInfoCobranca] = useState(false);
  // 🏘️ Bairros / setores (filtro do radar) — lista vinda dos cadastros de clientes e leads
  const [bairros, setBairros] = useState<{ chave: string; nome: string; clientes: number; leads: number }[]>([]);
  const [bairroBusca, setBairroBusca] = useState("");
  const [bairrosTodos, setBairrosTodos] = useState(false);

  const carregarCfg = useCallback(async () => {
    setLoading(true);
    try {
      const d: any = await apiRequest("GET", "/api/admin/recursos");
      if (d && d.ok) setCfg(d.config);
    } catch (e: any) {
      toast({ title: "Erro ao carregar", description: String(e?.message || e), variant: "destructive" });
    } finally { setLoading(false); }
  }, [toast]);

  const carregarUso = useCallback(async () => {
    setUsoLoading(true);
    try {
      const d: any = await apiRequest("GET", "/api/admin/recursos/uso");
      if (d && d.ok) setUso(d);
    } catch (e: any) {
      toast({ title: "Erro ao carregar uso", description: String(e?.message || e), variant: "destructive" });
    } finally { setUsoLoading(false); }
  }, [toast]);

  const carregarBairros = useCallback(async () => {
    try {
      const d: any = await apiRequest("GET", "/api/admin/recursos/bairros");
      if (d && d.ok && Array.isArray(d.bairros)) setBairros(d.bairros);
    } catch (_e) { /* lista é complementar */ }
  }, []);

  useEffect(() => { carregarCfg(); carregarUso(); carregarBairros(); }, [carregarCfg, carregarUso, carregarBairros]);

  const set = (k: string, v: string) => setCfg((c) => ({ ...(c || {}), [k]: v }));
  const bool = (k: string) => String(cfg?.[k]) === "true";

  const salvar = useCallback(async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const d: any = await apiRequest("POST", "/api/admin/recursos", cfg);
      if (d && d.ok) { setCfg(d.config); toast({ title: "Configuração salva" }); carregarUso(); }
      else toast({ title: "Não foi possível salvar", description: (d && d.message) || "", variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Erro ao salvar", description: String(e?.message || e), variant: "destructive" });
    } finally { setSaving(false); }
  }, [cfg, toast, carregarUso]);

  // --- seletor de segmentos ---
  const selectedCodes = new Set((cfg?.radar_segmentos || "").split(",").map((s) => s.trim()).filter(Boolean));
  const grupoAtivo = (g: { codes: string[] }) => g.codes.every((c) => selectedCodes.has(c));
  const toggleGrupo = (g: { codes: string[] }) => {
    const next = new Set(selectedCodes);
    if (grupoAtivo(g)) g.codes.forEach((c) => next.delete(c));
    else g.codes.forEach((c) => next.add(c));
    set("radar_segmentos", Array.from(next).join(","));
  };
  // --- seletor de bairros / setores (vazio = todos) ---
  const bairrosSel = (cfg?.radar_bairros || "").split("|").map((s) => s.trim()).filter(Boolean);
  const bairrosSelSet = new Set(bairrosSel);
  const toggleBairro = (chave: string) => {
    const next = new Set(bairrosSelSet);
    if (next.has(chave)) next.delete(chave); else next.add(chave);
    set("radar_bairros", Array.from(next).join("|"));
  };
  const semAcento = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const nomeBairro = (chave: string) => bairros.find((b) => b.chave === chave)?.nome || chave;
  const bairrosFiltrados = (() => {
    const q = semAcento(bairroBusca.trim());
    const base = q ? bairros.filter((b) => semAcento(b.nome).includes(q) || b.chave.includes(q)) : bairros;
    const naoSel = base.filter((b) => !bairrosSelSet.has(b.chave));
    return q || bairrosTodos ? naoSel : naoSel.slice(0, 30);
  })();

  // códigos que o admin digitou manualmente e não pertencem a nenhum grupo conhecido
  const codesConhecidos = new Set(SEG_GROUPS.flatMap((g) => g.codes));
  const extras = Array.from(selectedCodes).filter((c) => !codesConhecidos.has(c));

  const cambio = (uso?.cambio ?? Number(cfg?.radar_cambio)) || 5.2;
  const custoBRL = uso ? (uso.custoBRL ?? uso.custoUSD * cambio) : 0;
  const precoBRL = uso ? (uso.precoBRL ?? uso.preco * cambio) : 0;
  const cotaPct = uso && uso.cota > 0 ? Math.min(100, Math.round((uso.totalCobravel / uso.cota) * 100)) : 0;
  const fotoAtivo = bool("foto_enabled");
  const fotoCotaN = uso?.fotoCota ?? Number(cfg?.foto_cota_gratis) ?? 1000;
  const fotoTotalN = uso?.fotoTotal ?? 0;
  const fotoCobravelN = uso?.fotoCobravel ?? 0;
  const fotoPct = uso && fotoCotaN > 0 ? Math.min(100, Math.round((fotoCobravelN / fotoCotaN) * 100)) : 0;
  const custoFotoBRL = uso ? ((uso.custoFotoUSD ?? 0) * cambio) : 0;
  const fichaAtivo = bool("ficha_google_enabled");
  const fichaCotaN = uso?.fichaCota ?? Number(cfg?.ficha_cota_gratis) ?? 1000;
  const fichaCobravelN = uso?.fichaCobravel ?? uso?.fichaTotal ?? 0;
  const fichaPct = uso && fichaCotaN > 0 ? Math.min(100, Math.round((fichaCobravelN / fichaCotaN) * 100)) : 0;
  const telCotaN = uso?.telefoneCota ?? (Number(cfg?.telefone_cota_gratis) || 1000);
  const telTotalN = uso?.telefoneTotal ?? 0;
  const telCobravelN = uso?.telefoneCobravel ?? 0;
  const telPct = uso && telCotaN > 0 ? Math.min(100, Math.round((telCobravelN / telCotaN) * 100)) : 0;
  const custoTelBRL = uso ? ((uso.custoTelefoneUSD ?? 0) * cambio) : 0;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center text-white shadow">
            <SatelliteDish className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Recursos de Prospecção</h1>
            <p className="text-sm text-muted-foreground">Ligue/desligue os recursos do Google e acompanhe uso e custo por vendedor.</p>
          </div>
        </div>
        <BackToDashboardButton />
      </div>

      {loading || !cfg ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground"><Loader2 className="h-6 w-6 mx-auto animate-spin" /></CardContent></Card>
      ) : (
        <>
          {/* Liga/Desliga */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                Ativar recursos
                <button type="button" onClick={() => setInfoCobranca((v) => !v)} className="text-muted-foreground hover:text-emerald-600 transition" aria-label="Como é cobrado" data-testid="btn-info-cobranca">
                  <Info className="h-4 w-4" />
                </button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {infoCobranca && (
                <div className="text-[11px] leading-relaxed rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 p-3 space-y-1.5">
                  <div className="font-semibold text-foreground text-xs">Como o Google cobra</div>
                  <div><strong>Radar</strong> — por <strong>busca</strong>: cada vez que o vendedor consulta o GPS e a busca chama o Google conta 1 (e já traz até 20 locais de uma vez). Buscas repetidas na mesma região saem do cache e <strong>não</strong> contam. US$ 32 / 1.000 · 5.000 grátis/mês.</div>
                  <div><strong>Busca por foto</strong> — por <strong>foto</strong>: cada imagem lida (OCR) conta 1. US$ 1,50 / 1.000 · 1.000 grátis/mês.</div>
                  <div><strong>Ficha Google</strong> — por <strong>lead</strong>: cada lead que recebe os dados do Google conta 1. US$ 32 / 1.000 · 1.000 grátis/mês.</div>
                  <div><strong>Telefone dos Novos pontos</strong> — por <strong>toque em "Ver telefone"</strong>: só conta quando o vendedor pede o número de um ponto; o mesmo ponto fica guardado e não é cobrado de novo. US$ 20 / 1.000 · 1.000 grátis/mês.</div>
                  <div className="text-muted-foreground pt-1">Os valores em R$ usam o câmbio configurado abaixo. A <strong>blindagem de custo</strong> desliga cada recurso antes de passar da cota grátis, então no uso normal o custo fica em R$ 0,00.</div>
                </div>
              )}
              <div className="flex items-center justify-between gap-4 border rounded-lg p-3">
                <div className="flex items-start gap-3">
                  <SatelliteDish className="h-5 w-5 text-emerald-600 mt-0.5" />
                  <div>
                    <div className="font-medium">Radar de novos pontos</div>
                    <div className="text-xs text-muted-foreground">Mostra estabelecimentos por perto que ainda não estão no Integra (Google Places). Cobra por busca.</div>
                    {uso?.autoOff?.radar && <div className="text-[11px] font-medium text-amber-700 dark:text-amber-400 mt-1">⚠ Desligado automaticamente — limite do mês atingido. Religa dia 1º ou ligue aqui.</div>}
                    {uso?.override?.radar && <div className="text-[11px] text-blue-700 dark:text-blue-400 mt-1">Ligado manualmente acima da cota — pode gerar custo este mês.</div>}
                  </div>
                </div>
                <Switch checked={bool("radar_enabled")} onCheckedChange={(v) => set("radar_enabled", v ? "true" : "false")} data-testid="switch-radar" />
              </div>
              <div className="flex items-center justify-between gap-4 border rounded-lg p-3">
                <div className="flex items-start gap-3">
                  <ImageIcon className="h-5 w-5 text-emerald-600 mt-0.5" />
                  <div>
                    <div className="font-medium">Ficha Google dos leads</div>
                    <div className="text-xs text-muted-foreground">Coleta nota, categoria e horário do Google para os leads (em Gestão de Leads). Cobra por lead coletado.</div>
                    {uso?.autoOff?.ficha && <div className="text-[11px] font-medium text-amber-700 dark:text-amber-400 mt-1">⚠ Desligada automaticamente — limite do mês atingido. Religa dia 1º ou ligue aqui.</div>}
                    {uso?.override?.ficha && <div className="text-[11px] text-blue-700 dark:text-blue-400 mt-1">Ligada manualmente acima da cota — pode gerar custo este mês.</div>}
                  </div>
                </div>
                <Switch checked={bool("ficha_google_enabled")} onCheckedChange={(v) => set("ficha_google_enabled", v ? "true" : "false")} data-testid="switch-ficha" />
              </div>
              <div className="flex items-center justify-between gap-4 border rounded-lg p-3">
                <div className="flex items-start gap-3">
                  <Camera className="h-5 w-5 text-emerald-600 mt-0.5" />
                  <div>
                    <div className="font-medium">Busca por foto (fachada)</div>
                    <div className="text-xs text-muted-foreground">O vendedor fotografa a fachada e o sistema lê o nome (OCR do Google) e confere se já é cliente/lead. Cobra por foto.</div>
                    <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">Requer a "Cloud Vision API" ativada no Google Cloud. Enquanto não estiver ativada, deixe desligado.</div>
                    {uso?.autoOff?.foto && <div className="text-[11px] font-medium text-amber-700 dark:text-amber-400 mt-1">⚠ Desligada automaticamente — limite do mês atingido. Religa dia 1º ou ligue aqui.</div>}
                    {uso?.override?.foto && <div className="text-[11px] text-blue-700 dark:text-blue-400 mt-1">Ligada manualmente acima da cota — pode gerar custo este mês.</div>}
                  </div>
                </div>
                <Switch checked={bool("foto_enabled")} onCheckedChange={(v) => set("foto_enabled", v ? "true" : "false")} data-testid="switch-foto" />
              </div>
            </CardContent>
          </Card>

          {/* Configuração do radar */}
          <Card>
            <CardHeader><CardTitle className="text-base">Configuração do radar</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><Label className="text-xs">Raio (m)</Label><Input type="number" value={cfg.radar_raio || ""} onChange={(e) => set("radar_raio", e.target.value)} /></div>
                <div><Label className="text-xs">Cache por região (min)</Label><Input type="number" value={cfg.radar_cache_ttl_min || ""} onChange={(e) => set("radar_cache_ttl_min", e.target.value)} /></div>
                <div><Label className="text-xs">Cota grátis / mês</Label><Input type="number" value={cfg.radar_cota_gratis || ""} onChange={(e) => set("radar_cota_gratis", e.target.value)} /></div>
                <div>
                  <Label className="text-xs">Câmbio US$ → R$</Label>
                  <Input type="number" step="0.01" value={cfg.radar_cambio || ""} onChange={(e) => set("radar_cambio", e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs">Preço radar US$ / 1.000</Label>
                  <Input type="number" step="0.01" value={cfg.radar_preco_mil || ""} onChange={(e) => set("radar_preco_mil", e.target.value)} />
                  <p className="text-[11px] text-muted-foreground mt-1">≈ {brl((Number(cfg.radar_preco_mil) || 0) * (Number(cfg.radar_cambio) || 5.2))} / 1.000</p>
                </div>
                <div>
                  <Label className="text-xs">Preço foto US$ / 1.000</Label>
                  <Input type="number" step="0.01" value={cfg.foto_preco_mil || ""} onChange={(e) => set("foto_preco_mil", e.target.value)} />
                  <p className="text-[11px] text-muted-foreground mt-1">≈ {brl((Number(cfg.foto_preco_mil) || 0) * (Number(cfg.radar_cambio) || 5.2))} / 1.000</p>
                </div>
                <div>
                  <Label className="text-xs">Cota foto grátis / mês</Label>
                  <Input type="number" value={cfg.foto_cota_gratis || ""} onChange={(e) => set("foto_cota_gratis", e.target.value)} />
                </div>
              </div>

              {/* Segmentos em português */}
              <div>
                <Label className="text-xs">Segmentos buscados</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">Toque para ligar/desligar. Vêm marcados os segmentos que já são clientes Honest.</p>
                <div className="flex flex-wrap gap-2">
                  {SEG_GROUPS.map((g) => {
                    const on = grupoAtivo(g);
                    return (
                      <button
                        key={g.label}
                        type="button"
                        onClick={() => toggleGrupo(g)}
                        data-testid={`seg-${g.label}`}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${on
                          ? "bg-emerald-600 border-emerald-600 text-white"
                          : "bg-background border-input text-muted-foreground hover:border-emerald-400"}`}
                      >
                        {on && <Check className="h-3.5 w-3.5" />}
                        {g.label}
                      </button>
                    );
                  })}
                </div>

                <button type="button" onClick={() => setAvancado((v) => !v)} className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-3 underline">
                  {avancado ? "Ocultar códigos do Google" : "Editar códigos do Google (avançado)"}
                </button>
                {avancado && (
                  <div className="mt-2">
                    <Textarea rows={3} value={cfg.radar_segmentos || ""} onChange={(e) => set("radar_segmentos", e.target.value)} className="font-mono text-xs" />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Estes são os tipos técnicos enviados ao Google (em inglês). O seletor acima edita este campo automaticamente.
                      {extras.length > 0 && <> Códigos extras digitados por você: <span className="font-mono">{extras.join(", ")}</span>.</>}
                    </p>
                  </div>
                )}
              </div>

              {/* 🏘️ Região: bairros / setores */}
              <div data-testid="radar-bairros">
                <Label className="text-xs flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> Região: bairros / setores</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">
                  {bairrosSel.length === 0
                    ? "Nenhum marcado = o radar mostra pontos de todos os bairros."
                    : `Mostrando só pontos de ${bairrosSel.length} bairro${bairrosSel.length > 1 ? "s" : ""}/setor${bairrosSel.length > 1 ? "es" : ""}. A busca no Google continua sendo cobrada igual; o filtro só esconde os demais.`}
                  {" "}O número ao lado é a quantidade de clientes ativos no bairro.
                </p>
                {bairrosSel.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {bairrosSel.map((ch) => (
                      <button key={ch} type="button" onClick={() => toggleBairro(ch)} data-testid={`bairro-sel-${ch}`}
                        className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm bg-emerald-600 border-emerald-600 text-white">
                        <Check className="h-3.5 w-3.5" /> {nomeBairro(ch)}
                      </button>
                    ))}
                    <button type="button" onClick={() => set("radar_bairros", "")} className="text-[11px] text-red-600 underline px-1" data-testid="bairros-limpar">
                      Limpar (todos os bairros)
                    </button>
                  </div>
                )}
                <div className="relative mb-2 max-w-sm">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input value={bairroBusca} onChange={(e) => setBairroBusca(e.target.value)} placeholder="Buscar bairro ou setor…" className="pl-8 h-9 text-sm" data-testid="bairros-busca" />
                </div>
                <div className="flex flex-wrap gap-2">
                  {bairrosFiltrados.map((b) => (
                    <button key={b.chave} type="button" onClick={() => toggleBairro(b.chave)} data-testid={`bairro-${b.chave}`}
                      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm bg-background border-input text-muted-foreground hover:border-emerald-400">
                      {b.nome}<span className="text-[10px] opacity-70">{b.clientes}</span>
                    </button>
                  ))}
                  {bairros.length === 0 && <span className="text-[11px] text-muted-foreground">Carregando bairros…</span>}
                </div>
                {!bairroBusca && bairros.length - bairrosSel.length > 30 && (
                  <button type="button" onClick={() => setBairrosTodos((v) => !v)} className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-2 underline">
                    {bairrosTodos ? "Mostrar só os principais" : `Mostrar todos (${bairros.length})`}
                  </button>
                )}
              </div>

              {/* ⭐ Avaliação mínima no Google */}
              <div data-testid="radar-nota-min">
                <Label className="text-xs">Avaliação mínima no Google</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="text" inputMode="decimal"
                    value={(cfg.radar_nota_min || "").replace(".", ",")}
                    onChange={(e) => set("radar_nota_min", e.target.value.replace(/[^0-9.,]/g, "").replace(",", ".").slice(0, 4))}
                    onBlur={(e) => {
                      const v = e.target.value.replace(",", ".");
                      if (!v) return set("radar_nota_min", "");
                      const n = Number(v);
                      set("radar_nota_min", isFinite(n) ? String(Math.round(Math.min(5, Math.max(1, n)) * 10) / 10) : "");
                    }}
                    placeholder="sem filtro"
                    className="w-32"
                    data-testid="input-nota-min"
                  />
                  <span className="text-sm text-muted-foreground">★ ou mais (1 a 5)</span>
                  {cfg.radar_nota_min && (
                    <button type="button" onClick={() => set("radar_nota_min", "")} className="text-[11px] text-red-600 underline" data-testid="nota-min-limpar">Tirar filtro</button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Vazio = mostra todos. Com nota mínima, os Novos pontos só listam quem tem essa nota ou mais (sem nota não aparece) e o card mostra a nota.
                  <span className="text-amber-700 dark:text-amber-400"> Custo: pedir a nota muda a busca do Google para a faixa Enterprise (US$ 35 / 1.000, 1.000 grátis/mês, em vez de US$ 32 e 5.000 grátis). A blindagem passa a desligar o radar ao chegar em 1.000 buscas no mês.</span>
                </p>
              </div>

              <Button onClick={salvar} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
                {saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Salvando…</> : <><Save className="h-4 w-4 mr-2" /> Salvar configuração</>}
              </Button>
            </CardContent>
          </Card>

          {/* Blindagem de custo */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Blindagem de custo</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 border rounded-lg p-3">
                <div>
                  <div className="font-medium">Desligar sozinho perto da cota grátis</div>
                  <div className="text-xs text-muted-foreground">Cada recurso fica ligado até a margem antes de esgotar a cota grátis do mês e <strong>desliga sozinho</strong>. Religa automaticamente no dia 1º (renovação) ou quando o admin reativar aqui.</div>
                </div>
                <Switch checked={bool("auto_off_enabled")} onCheckedChange={(v) => set("auto_off_enabled", v ? "true" : "false")} data-testid="switch-blindagem" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs">Margem de segurança</Label>
                  <Input type="number" value={cfg.auto_off_margem || ""} onChange={(e) => set("auto_off_margem", e.target.value)} />
                  <p className="text-[11px] text-muted-foreground mt-1">desliga N antes do fim da cota</p>
                </div>
                <div>
                  <Label className="text-xs">Cota grátis ficha / mês</Label>
                  <Input type="number" value={cfg.ficha_cota_gratis || ""} onChange={(e) => set("ficha_cota_gratis", e.target.value)} />
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground space-y-0.5 border rounded-lg p-3 bg-muted/30">
                <div className="font-medium text-foreground mb-1">Desliga automaticamente ao atingir (cota − margem):</div>
                <div>• Radar: <span className="font-semibold text-foreground">{Math.max(0, (Number(cfg.radar_cota_gratis) || 5000) - (Number(cfg.auto_off_margem) || 0))}</span> buscas/mês</div>
                <div>• Busca por foto: <span className="font-semibold text-foreground">{Math.max(0, (Number(cfg.foto_cota_gratis) || 1000) - (Number(cfg.auto_off_margem) || 0))}</span> fotos/mês</div>
                <div>• Ficha Google: <span className="font-semibold text-foreground">{Math.max(0, (Number(cfg.ficha_cota_gratis) || 1000) - (Number(cfg.auto_off_margem) || 0))}</span> consultas/mês</div>
                <div>• Telefone dos Novos pontos: <span className="font-semibold text-foreground">{Math.max(0, (Number(cfg.telefone_cota_gratis) || 1000) - (Number(cfg.auto_off_margem) || 0))}</span> consultas/mês (o botão "Ver telefone" para até o dia 1º)</div>
              </div>
              <Button onClick={salvar} disabled={saving} variant="outline">
                {saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Salvando…</> : <><Save className="h-4 w-4 mr-2" /> Salvar</>}
              </Button>
            </CardContent>
          </Card>

          {/* Uso e custo */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Uso e custo do radar · mês {uso?.mes || ""}</CardTitle>
              <Button variant="outline" size="sm" onClick={carregarUso} disabled={usoLoading}>
                {usoLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {!uso ? (
                <div className="py-6 text-center text-muted-foreground text-sm"><Loader2 className="h-5 w-5 mx-auto animate-spin" /></div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="border rounded-lg p-3">
                      <div className="text-xs text-muted-foreground flex items-center gap-1"><Gauge className="h-3.5 w-3.5" /> Buscas no mês</div>
                      <div className="text-2xl font-bold">{uso.totalRadar}</div>
                    </div>
                    <div className="border rounded-lg p-3">
                      <div className="text-xs text-muted-foreground">Cobráveis (após cache)</div>
                      <div className="text-2xl font-bold">{uso.totalCobravel}</div>
                    </div>
                    <div className="border rounded-lg p-3">
                      <div className="text-xs text-muted-foreground">Acima da cota grátis</div>
                      <div className="text-2xl font-bold">{uso.cobravelPago}</div>
                    </div>
                    <div className={`border rounded-lg p-3 ${custoBRL > 0 ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30" : "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30"}`}>
                      <div className="text-xs text-muted-foreground">Custo estimado</div>
                      <div className="text-2xl font-bold">{brl(custoBRL)}</div>
                      {custoBRL > 0 && <div className="text-[11px] text-muted-foreground">≈ {usd(uso.custoUSD)} · câmbio {cambio.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                      <span>Cota grátis do radar</span>
                      <span>{uso.totalCobravel} / {uso.cota}</span>
                    </div>
                    <Progress value={cotaPct} className="h-2" />
                    {custoBRL === 0 && <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">Dentro da cota grátis — sem custo este mês. As cotas zeram todo dia 1º.</p>}
                  </div>

                  <div className="border-t pt-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted-foreground flex items-center gap-1.5"><Camera className="h-3.5 w-3.5" /> Busca por foto {fotoAtivo ? "" : "(desligada)"}</span>
                      <span className="text-muted-foreground">{fotoTotalN} foto{fotoTotalN === 1 ? "" : "s"} · {fotoCobravelN} / {fotoCotaN} grátis · {custoFotoBRL > 0 ? brl(custoFotoBRL) : "R$ 0,00"}</span>
                    </div>
                    <Progress value={fotoPct} className="h-2" />
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted-foreground flex items-center gap-1.5"><ImageIcon className="h-3.5 w-3.5" /> Ficha Google {fichaAtivo ? "" : "(desligada)"}</span>
                      <span className="text-muted-foreground">{fichaCobravelN} / {fichaCotaN} grátis</span>
                    </div>
                    <Progress value={fichaPct} className="h-2" />
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted-foreground flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> Telefone dos Novos pontos</span>
                      <span className="text-muted-foreground">{telTotalN} consulta{telTotalN === 1 ? "" : "s"} · {telCobravelN} / {telCotaN} grátis · {custoTelBRL > 0 ? brl(custoTelBRL) : "R$ 0,00"}</span>
                    </div>
                    <Progress value={telPct} className="h-2" />
                  </div>

                  <div>
                    <div className="text-sm font-semibold flex items-center gap-1.5 mb-2"><Users className="h-4 w-4" /> Por vendedor</div>
                    {uso.porVendedor.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-3">Nenhuma busca registrada neste mês.</p>
                    ) : (
                      <div className="border rounded-lg overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Vendedor</TableHead>
                              <TableHead className="text-right">Buscas</TableHead>
                              <TableHead className="text-right">Cobráveis</TableHead>
                              <TableHead className="text-right">Fotos</TableHead>
                              <TableHead className="text-right">Ficha Google</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {uso.porVendedor.map((v, i) => (
                              <TableRow key={v.userId || v.vendedor || i}>
                                <TableCell className="font-medium">{v.vendedor}</TableCell>
                                <TableCell className="text-right">{v.radarTotal}</TableCell>
                                <TableCell className="text-right">
                                  <Badge variant={v.radarCobravel > 0 ? "secondary" : "outline"}>{v.radarCobravel}</Badge>
                                </TableCell>
                                <TableCell className="text-right">{v.fotoTotal ?? 0}</TableCell>
                                <TableCell className="text-right">{v.fichaTotal}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-2">"Cobráveis" = buscas que chamaram o Google (as repetidas na mesma região saem do cache e não contam). O custo é coletivo: só passa a cobrar quando o total de cobráveis do mês ultrapassa a cota grátis.</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
