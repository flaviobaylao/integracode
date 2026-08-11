// ============================================================================
// CENTRAL DE MARKETING — buraco 2: o fio de atribuição
// ----------------------------------------------------------------------------
// Esta é a primeira tela da Central. Ela responde a pergunta que o INTEGRA nunca
// conseguiu responder: QUANTO CADA CAMPANHA VENDEU — em reais de sales_card, não
// em "resultado" do gerenciador de anúncios.
//
// Duas seções:
//   • Atribuição — cobertura do fio, receita por campanha, cliques por link
//   • Campanhas & Links — cria a campanha (código) e o link curto /r/<slug>
//
// As próximas seções da Central (Aprovações, Calendário, Criativos, Réguas)
// entram aqui nos buracos seguintes.
// ============================================================================
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

const ROXO = "#8b5cf6";

async function apiGet(url: string) {
  const r = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error("Erro ao carregar (" + r.status + ")");
  return r.json();
}
async function apiPost(url: string, body: any) {
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "Erro ao salvar (" + r.status + ")");
  return j;
}

const brl = (v: any) =>
  "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: any) => Number(v || 0).toLocaleString("pt-BR");

export default function Marketing() {
  const [dias, setDias] = useState(30);
  const { toast } = useToast();

  const rel = useQuery<any>({
    queryKey: ["/api/mkt/atribuicao", dias],
    queryFn: () => apiGet("/api/mkt/atribuicao?dias=" + dias),
  });
  const camps = useQuery<any>({
    queryKey: ["/api/mkt/campanhas"],
    queryFn: () => apiGet("/api/mkt/campanhas"),
  });

  // ── formulário de campanha ──
  const [cCodigo, setCCodigo] = useState("");
  const [cNome, setCNome] = useState("");
  const [cCanal, setCCanal] = useState("instagram");
  const [cObjetivo, setCObjetivo] = useState("aquisicao_b2b");
  const [cVerba, setCVerba] = useState("");
  const [salvandoC, setSalvandoC] = useState(false);

  const salvarCampanha = async () => {
    if (!cCodigo.trim() || !cNome.trim()) {
      toast({ title: "Faltou preencher", description: "Código e nome são obrigatórios.", variant: "destructive" });
      return;
    }
    setSalvandoC(true);
    try {
      await apiPost("/api/mkt/campanhas", {
        codigo: cCodigo, nome: cNome, canal: cCanal, objetivo: cObjetivo,
        verba: cVerba === "" ? null : Number(cVerba),
      });
      toast({ title: "Campanha salva", description: `Código ${cCodigo.toUpperCase()} pronto para usar em link e cupom.` });
      setCCodigo(""); setCNome(""); setCVerba("");
      camps.refetch(); rel.refetch();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally { setSalvandoC(false); }
  };

  // ── formulário de link ──
  const [lSlug, setLSlug] = useState("");
  const [lDestino, setLDestino] = useState("/shop");
  const [lCampanha, setLCampanha] = useState("");
  const [lMedium, setLMedium] = useState("organic");
  const [lSource, setLSource] = useState("instagram");
  const [salvandoL, setSalvandoL] = useState(false);
  const [ultimoLink, setUltimoLink] = useState("");

  const salvarLink = async () => {
    if (!lSlug.trim()) {
      toast({ title: "Faltou o apelido", description: "O apelido vira o /r/<apelido> que vai no post.", variant: "destructive" });
      return;
    }
    setSalvandoL(true);
    try {
      const r = await apiPost("/api/mkt/links", {
        slug: lSlug, destino: lDestino || "/shop", campanha_codigo: lCampanha || null,
        utm_source: lSource, utm_medium: lMedium,
      });
      setUltimoLink(r.url || "");
      toast({ title: "Link criado", description: r.url });
      setLSlug("");
      rel.refetch();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally { setSalvandoL(false); }
  };

  const d = rel.data;
  const cob = d?.cobertura || { pedidos_hotsite: 0, com_campanha: 0, com_utm: 0 };
  const pctCobertura = Number(cob.pedidos_hotsite) > 0
    ? Math.round((Number(cob.com_campanha) / Number(cob.pedidos_hotsite)) * 100)
    : 0;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <BackToDashboardButton />

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg grid place-items-center" style={{ background: ROXO + "26" }}>
          <i className="fas fa-bullseye" style={{ color: ROXO }} />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">Central de Marketing</h1>
          <p className="text-xs text-muted-foreground">Fio de atribuição — quanto cada campanha vendeu de verdade</p>
        </div>
        <div className="ml-auto flex gap-2">
          {[7, 30, 90].map((x) => (
            <Button key={x} size="sm" variant={dias === x ? "default" : "outline"} onClick={() => setDias(x)}>
              {x} dias
            </Button>
          ))}
        </div>
      </div>

      {/* ── termômetro do fio ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <i className="fas fa-link text-muted-foreground" /> Cobertura do fio
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            De cada 10 pedidos que entram pela loja, quantos sabemos de onde vieram. Enquanto isso estiver baixo,
            é sinal de que os links do post não estão passando por <code>/r/</code>.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(cob.pedidos_hotsite)}</div>
              <div className="text-xs text-muted-foreground mt-1">pedidos da loja no período</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(cob.com_campanha)}</div>
              <div className="text-xs text-muted-foreground mt-1">com campanha identificada</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold" style={{ color: pctCobertura >= 50 ? "#0f9d6e" : undefined }}>
                {pctCobertura}%
              </div>
              <div className="text-xs text-muted-foreground mt-1">de cobertura</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(d?.links?.length || 0)}</div>
              <div className="text-xs text-muted-foreground mt-1">links curtos criados</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── receita por campanha ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <i className="fas fa-sack-dollar text-muted-foreground" /> Receita por campanha
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rel.isLoading && <p className="text-sm text-muted-foreground">Carregando...</p>}
          {rel.error && <p className="text-sm text-red-600">{(rel.error as any).message}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2">Campanha</th>
                  <th className="text-left">Canal</th>
                  <th className="text-right">Cliques</th>
                  <th className="text-right">Pedidos</th>
                  <th className="text-right">Clientes</th>
                  <th className="text-right">Verba</th>
                  <th className="text-right">Receita</th>
                  <th className="text-right">Retorno</th>
                </tr>
              </thead>
              <tbody>
                {(d?.campanhas || []).length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-muted-foreground text-xs">
                      Nenhuma campanha ainda. Crie uma abaixo e gere o link curto para usar no post.
                    </td>
                  </tr>
                )}
                {(d?.campanhas || []).map((c: any) => {
                  const verba = Number(c.verba || 0);
                  const receita = Number(c.receita || 0);
                  const roi = verba > 0 ? receita / verba : null;
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-2">
                        <span className="font-medium">{c.codigo}</span>
                        <span className="text-muted-foreground text-xs block">{c.nome}</span>
                      </td>
                      <td className="text-xs">{c.canal || "—"}</td>
                      <td className="text-right">{num(c.cliques)}</td>
                      <td className="text-right">{num(c.pedidos)}</td>
                      <td className="text-right">{num(c.clientes)}</td>
                      <td className="text-right">{verba ? brl(verba) : "—"}</td>
                      <td className="text-right font-semibold">{brl(receita)}</td>
                      <td className="text-right">
                        {roi == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <Badge variant={roi >= 1 ? "default" : "secondary"}>{roi.toFixed(2)}×</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(d?.semCadastro || []).length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-1">
                Receita com código de campanha que ainda não foi cadastrado
              </p>
              <p className="text-[11px] text-amber-700 dark:text-amber-400 mb-2">
                O pedido guardou o código, então nada se perdeu. Cadastre a campanha com esse mesmo código e ela
                entra na tabela de cima automaticamente.
              </p>
              <div className="flex flex-wrap gap-2">
                {(d.semCadastro || []).map((s: any) => (
                  <span key={s.codigo} className="text-xs bg-white dark:bg-black/20 border rounded px-2 py-1">
                    <b>{s.codigo}</b> · {num(s.pedidos)} pedido(s) · {brl(s.receita)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── criar campanha + link ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <i className="fas fa-flag text-muted-foreground" /> Nova campanha
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              O <b>código</b> é o que costura tudo: entra no link, pode virar cupom e aparece no pedido.
              Padrão sugerido: canal + mês. Ex.: <code>IG0825</code>.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Código</Label>
                <Input value={cCodigo} onChange={(e) => setCCodigo(e.target.value.toUpperCase())} placeholder="IG0825" />
              </div>
              <div>
                <Label className="text-sm">Verba do mês (R$)</Label>
                <Input type="number" step="0.01" value={cVerba} onChange={(e) => setCVerba(e.target.value)} placeholder="opcional" />
              </div>
            </div>
            <div>
              <Label className="text-sm">Nome</Label>
              <Input value={cNome} onChange={(e) => setCNome(e.target.value)} placeholder="Tabela de revenda — agosto" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Canal</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={cCanal} onChange={(e) => setCCanal(e.target.value)}>
                  {["instagram", "facebook", "whatsapp", "google", "offline"].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-sm">Objetivo</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={cObjetivo} onChange={(e) => setCObjetivo(e.target.value)}>
                  <option value="aquisicao_b2b">Aquisição B2B (revenda)</option>
                  <option value="b2c">Venda B2C (loja)</option>
                  <option value="reativacao">Reativação</option>
                  <option value="mix">Ampliar mix</option>
                </select>
              </div>
            </div>
            <Button onClick={salvarCampanha} disabled={salvandoC}>
              {salvandoC ? "Salvando..." : "Salvar campanha"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <i className="fas fa-scissors text-muted-foreground" /> Novo link curto
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              É este link que vai na bio, no story e na legenda. Ele registra o clique e entrega o cliente
              no destino já carimbado com a campanha.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Apelido (vira /r/apelido)</Label>
                <Input value={lSlug} onChange={(e) => setLSlug(e.target.value)} placeholder="tabela-ago" />
              </div>
              <div>
                <Label className="text-sm">Campanha</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={lCampanha} onChange={(e) => setLCampanha(e.target.value)}>
                  <option value="">— sem campanha —</option>
                  {(camps.data?.campanhas || []).map((c: any) => (
                    <option key={c.id} value={c.codigo}>{c.codigo} — {c.nome}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <Label className="text-sm">Destino</Label>
              <Input value={lDestino} onChange={(e) => setLDestino(e.target.value)} placeholder="/shop" />
              <p className="text-[11px] text-muted-foreground mt-1">
                Caminho do próprio site (começando com <code>/</code>) ou endereço completo com https://.
                Qualquer outra coisa cai na loja.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Origem (utm_source)</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={lSource} onChange={(e) => setLSource(e.target.value)}>
                  {["instagram", "facebook", "whatsapp", "google", "bio", "offline"].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-sm">Tipo (utm_medium)</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={lMedium} onChange={(e) => setLMedium(e.target.value)}>
                  <option value="organic">orgânico</option>
                  <option value="paid">pago</option>
                  <option value="bio">bio</option>
                  <option value="story">story</option>
                </select>
              </div>
            </div>
            <Button onClick={salvarLink} disabled={salvandoL}>
              {salvandoL ? "Criando..." : "Criar link"}
            </Button>
            {ultimoLink && (
              <div className="rounded-lg border bg-muted/40 p-3 flex items-center gap-2">
                <code className="text-xs flex-1 break-all">{ultimoLink}</code>
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(ultimoLink); toast({ title: "Copiado" }); }}>
                  Copiar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── links e cliques ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <i className="fas fa-mouse-pointer text-muted-foreground" /> Links e cliques
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2">Link</th>
                  <th className="text-left">Campanha</th>
                  <th className="text-left">Destino</th>
                  <th className="text-right">Cliques no período</th>
                  <th className="text-right">Cliques total</th>
                  <th className="text-center">Ativo</th>
                </tr>
              </thead>
              <tbody>
                {(d?.links || []).length === 0 && (
                  <tr><td colSpan={6} className="py-4 text-center text-muted-foreground text-xs">Nenhum link ainda.</td></tr>
                )}
                {(d?.links || []).map((l: any) => (
                  <tr key={l.slug} className="border-b last:border-0">
                    <td className="py-2"><code className="text-xs">/r/{l.slug}</code></td>
                    <td className="text-xs">{l.campanha || "—"}</td>
                    <td className="text-xs text-muted-foreground max-w-[280px] truncate">{l.destino}</td>
                    <td className="text-right font-semibold">{num(l.cliques_janela)}</td>
                    <td className="text-right">{num(l.cliques)}</td>
                    <td className="text-center">
                      {l.ativo ? <Badge variant="default">sim</Badge> : <Badge variant="secondary">não</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
