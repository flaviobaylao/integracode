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
import { SatelliteDish, Save, RefreshCw, Loader2, Image as ImageIcon, DollarSign, Gauge, Users } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";

type Cfg = Record<string, string>;
type Uso = {
  mes: string; preco: number; cota: number;
  totalRadar: number; totalCobravel: number; cobravelPago: number; custoUSD: number; fichaTotal: number;
  porVendedor: { vendedor: string; userId: string | null; radarTotal: number; radarCobravel: number; fichaTotal: number }[];
};

export default function RecursosProspeccao() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [uso, setUso] = useState<Uso | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [usoLoading, setUsoLoading] = useState(false);

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

  useEffect(() => { carregarCfg(); carregarUso(); }, [carregarCfg, carregarUso]);

  const set = (k: string, v: string) => setCfg((c) => ({ ...(c || {}), [k]: v }));
  const bool = (k: string) => String(cfg?.[k]) === "true";

  const salvar = useCallback(async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const d: any = await apiRequest("POST", "/api/admin/recursos", cfg);
      if (d && d.ok) { setCfg(d.config); toast({ title: "Configuração salva" }); }
      else toast({ title: "Não foi possível salvar", description: (d && d.message) || "", variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Erro ao salvar", description: String(e?.message || e), variant: "destructive" });
    } finally { setSaving(false); }
  }, [cfg, toast]);

  const custoBRL = uso ? uso.custoUSD * 5 : 0; // referência ~R$5/US$ (editável na sua planilha)
  const cotaPct = uso && uso.cota > 0 ? Math.min(100, Math.round((uso.totalCobravel / uso.cota) * 100)) : 0;

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
            <CardHeader><CardTitle className="text-base">Ativar recursos</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 border rounded-lg p-3">
                <div className="flex items-start gap-3">
                  <SatelliteDish className="h-5 w-5 text-emerald-600 mt-0.5" />
                  <div>
                    <div className="font-medium">Radar de novos pontos</div>
                    <div className="text-xs text-muted-foreground">Mostra estabelecimentos por perto que ainda não estão no Integra (Google Places). Cobra por busca.</div>
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
                  </div>
                </div>
                <Switch checked={bool("ficha_google_enabled")} onCheckedChange={(v) => set("ficha_google_enabled", v ? "true" : "false")} data-testid="switch-ficha" />
              </div>
            </CardContent>
          </Card>

          {/* Configuração do radar */}
          <Card>
            <CardHeader><CardTitle className="text-base">Configuração do radar</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><Label className="text-xs">Raio (m)</Label><Input type="number" value={cfg.radar_raio || ""} onChange={(e) => set("radar_raio", e.target.value)} /></div>
                <div><Label className="text-xs">Cache por região (min)</Label><Input type="number" value={cfg.radar_cache_ttl_min || ""} onChange={(e) => set("radar_cache_ttl_min", e.target.value)} /></div>
                <div><Label className="text-xs">Cota grátis / mês</Label><Input type="number" value={cfg.radar_cota_gratis || ""} onChange={(e) => set("radar_cota_gratis", e.target.value)} /></div>
                <div><Label className="text-xs">Preço US$ / 1.000</Label><Input type="number" step="0.01" value={cfg.radar_preco_mil || ""} onChange={(e) => set("radar_preco_mil", e.target.value)} /></div>
              </div>
              <div>
                <Label className="text-xs">Segmentos buscados (tipos do Google, separados por vírgula)</Label>
                <Textarea rows={3} value={cfg.radar_segmentos || ""} onChange={(e) => set("radar_segmentos", e.target.value)} className="font-mono text-xs" />
                <p className="text-[11px] text-muted-foreground mt-1">Padrão: segmentos que já são clientes Honest (padaria, mercado, restaurante, lanchonete, cafeteria, escolas, academias).</p>
              </div>
              <Button onClick={salvar} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
                {saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Salvando…</> : <><Save className="h-4 w-4 mr-2" /> Salvar configuração</>}
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
                      <div className="text-xs text-muted-foreground flex items-center gap-1"><DollarSign className="h-3.5 w-3.5" /> Cobráveis (após cache)</div>
                      <div className="text-2xl font-bold">{uso.totalCobravel}</div>
                    </div>
                    <div className="border rounded-lg p-3">
                      <div className="text-xs text-muted-foreground">Acima da cota grátis</div>
                      <div className="text-2xl font-bold">{uso.cobravelPago}</div>
                    </div>
                    <div className={`border rounded-lg p-3 ${uso.custoUSD > 0 ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30" : "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30"}`}>
                      <div className="text-xs text-muted-foreground">Custo estimado</div>
                      <div className="text-2xl font-bold">{uso.custoUSD > 0 ? `US$ ${uso.custoUSD.toFixed(2)}` : "R$ 0,00"}</div>
                      {uso.custoUSD > 0 && <div className="text-[11px] text-muted-foreground">≈ R$ {custoBRL.toFixed(2)}</div>}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                      <span>Cota grátis do mês</span>
                      <span>{uso.totalCobravel} / {uso.cota}</span>
                    </div>
                    <Progress value={cotaPct} className="h-2" />
                    {uso.custoUSD === 0 && <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">Dentro da cota grátis — sem custo este mês.</p>}
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
