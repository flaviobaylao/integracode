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
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  // Buraco 3: funil do canal pago (Click-to-WhatsApp/Instagram) + fila do CAPI
  const ctwa = useQuery<any>({
    queryKey: ["/api/mkt/ctwa", dias],
    queryFn: () => apiGet("/api/mkt/ctwa?dias=" + dias),
  });
  // Buraco 4: cartão de marca + revisor de texto
  const marca = useQuery<any>({ queryKey: ["/api/mkt/marca"], queryFn: () => apiGet("/api/mkt/marca") });
  const [textoRevisar, setTextoRevisar] = useState("");
  const [canalRevisar, setCanalRevisar] = useState("instagram");
  const [exigirCodigo, setExigirCodigo] = useState(true);
  const [revisao, setRevisao] = useState<any>(null);
  const [revisando, setRevisando] = useState(false);
  const revisar = async () => {
    if (!textoRevisar.trim()) return;
    setRevisando(true);
    try {
      setRevisao(await apiPost("/api/mkt/marca/revisar", {
        texto: textoRevisar, canal: canalRevisar, exigirCodigo,
        categoria: canalRevisar === "whatsapp" ? "UTILITY" : undefined,
      }));
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally { setRevisando(false); }
  };

  // Buraco 8: régua de recompra sobre a base própria
  const rec = useQuery<any>({ queryKey: ["/api/mkt/recompra"], queryFn: () => apiGet("/api/mkt/recompra") });
  const [reguaAlvo, setReguaAlvo] = useState("");
  const [limiteLote, setLimiteLote] = useState("");
  const [lote, setLote] = useState<any>(null);
  const [montando, setMontando] = useState(false);
  const [liberando, setLiberando] = useState(false);

  const montarLote = async () => {
    setMontando(true); setLote(null);
    try {
      const r = await apiPost("/api/mkt/recompra/lote", {
        regua: reguaAlvo || undefined,
        limite: limiteLote === "" ? undefined : Number(limiteLote),
      });
      setLote(r);
      toast({
        title: "Lote montado — nada foi enviado",
        description: `${r.total} mensagens · custo ${brl(r.custoEstimado)} · receita esperada ${brl(r.receitaEsperada)}`,
      });
      rec.refetch();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally { setMontando(false); }
  };

  const liberarLote = async () => {
    if (!lote?.loteId) return;
    setLiberando(true);
    try {
      const r = await apiPost("/api/mkt/recompra/lote/" + lote.loteId + "/liberar", {});
      const enf = r.resultado?.enfileirado || 0;
      toast({
        title: enf ? `${enf} mensagens entraram na fila do 1841` : "Nada entrou na fila",
        description: enf
          ? "A fila do 1841 ainda aplica as travas dela (modo, teto diário, horário)."
          : "Confira se o caso de uso 'recompra' e o template estão ligados no painel do 1841.",
      });
      setLote(null); rec.refetch();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally { setLiberando(false); }
  };

  const descartarLote = async () => {
    if (!lote?.loteId) return;
    try { await apiPost("/api/mkt/recompra/lote/" + lote.loteId + "/descartar", {}); setLote(null); rec.refetch();
      toast({ title: "Lote descartado" }); } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  };

  const [mudandoModo, setMudandoModo] = useState(false);
  const trocarModoCapi = async (modo: string) => {
    setMudandoModo(true);
    try {
      await apiPost("/api/mkt/ctwa/modo", { modo });
      toast({
        title: "Modo do CAPI: " + modo,
        description: modo === "on"
          ? "Os eventos passam a ser enviados para a Meta."
          : modo === "test"
            ? "Os eventos são montados e gravados, mas NÃO saem. Confira o payload antes de ligar."
            : "Nada é enviado para a Meta.",
      });
      ctwa.refetch();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally { setMudandoModo(false); }
  };

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

      {/* ── cartão de marca + revisor (buraco 4) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <i className="fas fa-feather-pointed text-muted-foreground" /> Cartão de marca
            {marca.data?.marca?.versao && <Badge variant="secondary">v{marca.data.marca.versao}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            A fonte única de como a Honest fala e do que ela nunca diz. É este cartão que entra no prompt de todo
            agente que escreve — sem ele, cada peça sai com um tom, e a IA amplifica a inconsistência.
            Mudou o tom? <b>Nasce uma versão nova</b>: as peças antigas guardam a versão que usaram.
          </p>

          {marca.data?.marca && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border p-3">
                <div className="text-xs font-semibold text-muted-foreground mb-1">POSICIONAMENTO</div>
                <p className="text-sm">{marca.data.marca.posicionamento}</p>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs font-semibold text-muted-foreground mb-1">TOM</div>
                <p className="text-sm">{marca.data.marca.tom}</p>
              </div>
            </div>
          )}

          {(marca.data?.marca?.pilares || []).length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {(marca.data.marca.pilares || []).map((p: any, i: number) => (
                <div key={i} className="rounded-lg border p-3">
                  <div className="text-sm font-semibold" style={{ color: ROXO }}>{p.nome}</div>
                  <p className="text-xs text-muted-foreground mt-1">{p.ideia}</p>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border p-3 space-y-3">
            <div className="text-sm font-semibold">Revisor — cole um texto e veja o veredito</div>
            <p className="text-[11px] text-muted-foreground">
              É o mesmo revisor que vai barrar peça de IA nos próximos buracos. Já funciona avulso.
            </p>
            <Textarea rows={4} value={textoRevisar} onChange={(e) => setTextoRevisar(e.target.value)}
                      placeholder="Cole aqui a legenda, o template ou o texto do anúncio..." />
            <div className="flex flex-wrap items-center gap-3">
              <select className="border rounded-md h-9 px-2 bg-background text-sm" value={canalRevisar}
                      onChange={(e) => setCanalRevisar(e.target.value)}>
                {["instagram", "whatsapp", "google", "hotsite"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={exigirCodigo} onChange={(e) => setExigirCodigo(e.target.checked)} />
                exigir código de atribuição
              </label>
              <Button size="sm" onClick={revisar} disabled={revisando}>{revisando ? "Revisando..." : "Revisar"}</Button>
            </div>

            {revisao && (
              <div className="rounded-lg border-2 p-3" style={{
                borderColor: revisao.veredito === "bloqueado" ? "#cf3b47" : revisao.veredito === "ajuste" ? "#c2820b" : "#0f9d6e",
              }}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={revisao.veredito === "bloqueado" ? "destructive" : "default"}>
                    {revisao.veredito === "bloqueado" ? "BLOQUEADO" : revisao.veredito === "ajuste" ? "AJUSTE" : "APROVADO"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">conferido contra o cartão v{revisao.versaoMarca}</span>
                </div>
                {(revisao.achados || []).length === 0 && (
                  <p className="text-xs text-muted-foreground">Nenhum problema encontrado.</p>
                )}
                <ul className="space-y-1">
                  {(revisao.achados || []).map((a: any, i: number) => (
                    <li key={i} className="text-xs">
                      <b style={{
                        color: a.gravidade === "bloqueio" ? "#cf3b47" : a.gravidade === "atencao" ? "#c2820b" : undefined,
                      }}>{a.regra}</b>
                      {a.trecho && <code className="mx-1 text-[11px]">{a.trecho}</code>}
                      — {a.explicacao}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <details className="rounded-lg border p-3">
            <summary className="text-sm font-semibold cursor-pointer">Palavras proibidas e palavras que exigem conferência</summary>
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-xs font-semibold text-red-600 mb-1">Bloqueiam a peça</div>
                <div className="flex flex-wrap gap-1">
                  {(marca.data?.marca?.termos_bloqueados || []).map((t: string) => (
                    <span key={t} className="text-[11px] bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 rounded px-2 py-0.5">{t}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-amber-600 mb-1">Precisam bater com o rótulo</div>
                <div className="flex flex-wrap gap-1">
                  {(marca.data?.marca?.termos_atencao || []).map((t: string) => (
                    <span key={t} className="text-[11px] bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 rounded px-2 py-0.5">{t}</span>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Os termos são tratados como <b>radical</b> e casados no início da palavra: <code>emagrec</code> pega
                emagrece, emagrecer e emagreça de uma vez, e <code>cura</code> não dispara dentro de "procura".
              </p>
            </div>
          </details>
        </CardContent>
      </Card>

      {/* ── régua de recompra sobre a base própria (buraco 8) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <i className="fas fa-rotate-right text-muted-foreground" /> Régua de recompra (base própria)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Fala com quem <b>já é cliente</b>, na hora certa: três dias antes do estoque dele acabar, e não um mês
            depois que ele comprou do concorrente. Mensagem <i>utility</i> no 1841 sai por ~R$ 0,04. Não depende da
            Meta, de App Review nem de verba de mídia.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(rec.data?.base?.clientes)}</div>
              <div className="text-xs text-muted-foreground mt-1">clientes com histórico</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(rec.data?.base?.comCicloConfiavel)}</div>
              <div className="text-xs text-muted-foreground mt-1">com ciclo de compra confiável</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{rec.data?.base?.cicloMedianoDias ?? "—"}</div>
              <div className="text-xs text-muted-foreground mt-1">dias — ciclo mediano da base</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold" style={{ color: ROXO }}>{num(rec.data?.totalCandidatos)}</div>
              <div className="text-xs text-muted-foreground mt-1">clientes para falar HOJE</div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2">Régua</th>
                  <th className="text-left">Quando dispara</th>
                  <th className="text-right">Candidatos hoje</th>
                  <th className="text-left">Template</th>
                </tr>
              </thead>
              <tbody>
                {(rec.data?.candidatosHoje || []).map((r: any) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 font-medium">{r.nome}</td>
                    <td className="text-xs text-muted-foreground">{r.descricao}</td>
                    <td className="text-right font-semibold">{num(r.candidatos)}</td>
                    <td><code className="text-[11px]">{r.template}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label className="text-sm">Régua</Label>
                <select className="w-full border rounded-md h-9 px-2 bg-background text-sm min-w-[200px]"
                        value={reguaAlvo} onChange={(e) => setReguaAlvo(e.target.value)}>
                  <option value="">todas</option>
                  {(rec.data?.candidatosHoje || []).map((r: any) => (
                    <option key={r.id} value={r.id}>{r.nome} ({r.candidatos})</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-sm">Máximo no lote</Label>
                <Input className="w-32" type="number" value={limiteLote}
                       onChange={(e) => setLimiteLote(e.target.value)}
                       placeholder={rec.data?.parametros?.mkt_recompra_lote_max || "80"} />
              </div>
              <Button onClick={montarLote} disabled={montando}>
                {montando ? "Montando..." : "Montar lote (não envia)"}
              </Button>
            </div>

            {lote && (
              <div className="rounded-lg border-2 p-3" style={{ borderColor: ROXO }}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                  <div><div className="text-xl font-bold">{num(lote.total)}</div><div className="text-xs text-muted-foreground">mensagens</div></div>
                  <div><div className="text-xl font-bold">{brl(lote.custoEstimado)}</div><div className="text-xs text-muted-foreground">custo estimado</div></div>
                  <div><div className="text-xl font-bold" style={{ color: "#0f9d6e" }}>{brl(lote.receitaEsperada)}</div><div className="text-xs text-muted-foreground">receita esperada</div></div>
                  <div><div className="text-xl font-bold">{num(lote.bloqueados)}</div><div className="text-xs text-muted-foreground">bloqueados (opt-out, dívida, frequência)</div></div>
                </div>
                {(lote.porRegua || []).length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {(lote.porRegua || []).map((p: any) => (
                      <span key={p.regua} className="text-xs bg-muted rounded px-2 py-1">
                        {p.nome}: <b>{num(p.total)}</b> · {brl(p.receita)}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground mb-3">
                  Analisou {num(lote.baseAnalisada)} clientes. <b>Nada foi enviado ainda.</b> Ao liberar, as mensagens
                  entram na fila do 1841 — que ainda aplica modo, teto diário, ritmo por minuto e horário comercial.
                </p>
                <div className="flex gap-2">
                  <Button onClick={liberarLote} disabled={liberando || !lote.total}>
                    {liberando ? "Liberando..." : `Liberar ${lote.total} mensagens`}
                  </Button>
                  <Button variant="outline" onClick={descartarLote}>Descartar</Button>
                </div>
              </div>
            )}
          </div>

          {(rec.data?.resultado || []).length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">O que a régua rendeu (pedidos em até 14 dias do toque)</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left py-2">Régua</th>
                      <th className="text-right">Enviados</th>
                      <th className="text-right">Pedidos</th>
                      <th className="text-right">Custo</th>
                      <th className="text-right">Receita</th>
                      <th className="text-right">Retorno</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rec.data.resultado || []).map((r: any) => {
                      const custo = Number(r.custo || 0), receita = Number(r.receita || 0);
                      return (
                        <tr key={r.regua} className="border-b last:border-0">
                          <td className="py-2">{rec.data.candidatosHoje?.find((x: any) => x.id === r.regua)?.nome || r.regua}</td>
                          <td className="text-right">{num(r.enviados)}</td>
                          <td className="text-right">{num(r.pedidos)}</td>
                          <td className="text-right">{brl(custo)}</td>
                          <td className="text-right font-semibold">{brl(receita)}</td>
                          <td className="text-right">
                            {custo > 0 ? <Badge variant="default">{(receita / custo).toFixed(0)}×</Badge> : <span className="text-muted-foreground">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── canal pago: CTWA + CAPI (buraco 3) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <i className="fas fa-bullhorn text-muted-foreground" /> Anúncio pago (Click-to-WhatsApp / Instagram)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Conversa que nasce de anúncio carrega o <code>ctwa_clid</code> da Meta. Quando ela vira pedido, o
            evento volta para a Meta com o valor — e o algoritmo passa a otimizar por <b>quem compra</b>, não por
            quem clica. É o item de maior retorno do plano.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(ctwa.data?.funil?.conversas)}</div>
              <div className="text-xs text-muted-foreground mt-1">conversas vindas de anúncio</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(ctwa.data?.funil?.pedidos)}</div>
              <div className="text-xs text-muted-foreground mt-1">viraram pedido</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{brl(ctwa.data?.funil?.receita)}</div>
              <div className="text-xs text-muted-foreground mt-1">receita do canal pago</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-2xl font-bold">{num(ctwa.data?.funil?.anuncios_distintos)}</div>
              <div className="text-xs text-muted-foreground mt-1">anúncios distintos</div>
            </div>
          </div>

          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">Devolver eventos para a Meta (CAPI)</span>
              <Badge variant={ctwa.data?.modo === "on" ? "default" : "secondary"}>
                {ctwa.data?.modo === "on" ? "ligado" : ctwa.data?.modo === "test" ? "modo teste" : "desligado"}
              </Badge>
              <span className="ml-auto flex gap-2">
                {["off", "test", "on"].map((m) => (
                  <Button key={m} size="sm" variant={ctwa.data?.modo === m ? "default" : "outline"}
                          disabled={mudandoModo} onClick={() => trocarModoCapi(m)}>
                    {m === "off" ? "Desligar" : m === "test" ? "Modo teste" : "Ligar"}
                  </Button>
                ))}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>Pixel: {ctwa.data?.credenciais?.pixel ? "✓ configurado" : "✗ falta META_PIXEL_ID"}</span>
              <span>Token: {ctwa.data?.credenciais?.token ? "✓ configurado" : "✗ falta META_CAPI_TOKEN"}</span>
            </div>
            {(ctwa.data?.capi || []).length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {(ctwa.data.capi || []).map((c: any, i: number) => (
                  <span key={i} className="text-xs bg-muted rounded px-2 py-1">
                    {c.event_name} · {c.status}: <b>{num(c.total)}</b>
                  </span>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Em <b>modo teste</b> o evento é montado e gravado, mas não sai — dá para conferir o payload antes de
              ligar de verdade. Ligar exige <code>META_PIXEL_ID</code> e <code>META_CAPI_TOKEN</code> no Railway.
            </p>
          </div>

          {(ctwa.data?.porAnuncio || []).length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left py-2">Anúncio</th>
                    <th className="text-right">Conversas</th>
                    <th className="text-right">Pedidos</th>
                    <th className="text-right">Receita</th>
                  </tr>
                </thead>
                <tbody>
                  {(ctwa.data.porAnuncio || []).map((a: any) => (
                    <tr key={a.anuncio} className="border-b last:border-0">
                      <td className="py-2"><code className="text-xs">{a.anuncio}</code></td>
                      <td className="text-right">{num(a.conversas)}</td>
                      <td className="text-right">{num(a.pedidos)}</td>
                      <td className="text-right font-semibold">{brl(a.receita)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── biblioteca de criativos (buraco 5) ── */}
      <SecaoCriativos />

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

// ============================================================================
// BURACO 5 — Biblioteca de criativos com tags
// ----------------------------------------------------------------------------
// A pergunta que esta seção existe para responder: QUAL GANCHO VENDE MAIS.
// Por isso ela não é uma galeria de fotos — é foto + tag + uso + receita.
// E quando a amostra não sustenta conclusão, ela diz isso na cara, em vez de
// mostrar um ranking que parece resposta.
// ============================================================================
function SecaoCriativos() {
  const { toast } = useToast();
  const [eixo, setEixo] = useState("gancho");
  const [filtro, setFiltro] = useState<any>({ soElegiveis: false });
  const [importando, setImportando] = useState(false);
  const [novaUrl, setNovaUrl] = useState("");
  const [novoTitulo, setNovoTitulo] = useState("");
  const [novoGancho, setNovoGancho] = useState("");
  const [novoCenario, setNovoCenario] = useState("");
  const [novoPublico, setNovoPublico] = useState("");
  const [novaOrigem, setNovaOrigem] = useState("foto_real");
  const [salvando, setSalvando] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const [subindo, setSubindo] = useState(false);
  const [recortes, setRecortes] = useState<string[]>(["feed_4x5"]);
  const [logSubida, setLogSubida] = useState<{ texto: string; erro?: boolean }[]>([]);
  const inputArquivo = useRef<HTMLInputElement>(null);

  const pan = useQuery<any>({
    queryKey: ["/api/mkt/assets/panorama"],
    queryFn: () => apiGet("/api/mkt/assets/panorama"),
  });
  const qs = new URLSearchParams(
    Object.entries(filtro).filter(([, v]) => v !== "" && v !== undefined && v !== false) as any
  ).toString();
  const lista = useQuery<any>({
    queryKey: ["/api/mkt/assets", qs],
    queryFn: () => apiGet("/api/mkt/assets" + (qs ? "?" + qs : "")),
  });
  const desemp = useQuery<any>({
    queryKey: ["/api/mkt/assets/desempenho", eixo],
    queryFn: () => apiGet("/api/mkt/assets/desempenho?eixo=" + eixo + "&dias=90"),
  });
  const lac = useQuery<any>({
    queryKey: ["/api/mkt/assets/lacunas"],
    queryFn: () => apiGet("/api/mkt/assets/lacunas"),
  });

  const vocab = pan.data?.vocabulario || {};
  const recarregar = () => { pan.refetch(); lista.refetch(); desemp.refetch(); lac.refetch(); };

  async function importar() {
    setImportando(true);
    try {
      const r = await apiPost("/api/mkt/assets/importar", {});
      toast({
        title: "Catálogo lido",
        description:
          r.encontradas + " foto(s) em " + r.produtos + " produto(s) · " +
          r.novas + " nova(s) · " + r.duplicadas + " já existia(m)",
      });
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setImportando(false);
  }

  async function cadastrar() {
    if (!novaUrl.trim()) return;
    setSalvando(true);
    try {
      const r = await apiPost("/api/mkt/assets", {
        url: novaUrl.trim(),
        titulo: novoTitulo.trim() || null,
        origem: novaOrigem,
        direitosOk: true,
        tags: {
          gancho: novoGancho ? [novoGancho] : [],
          cenario: novoCenario ? [novoCenario] : [],
          publico: novoPublico ? [novoPublico] : [],
        },
      });
      if (r.recusadas?.length) {
        toast({ title: "Tag fora do vocabulário", description: r.recusadas.map((x: any) => x.valor).join(", "), variant: "destructive" });
      }
      toast({
        title: r.duplicado ? "Já existia — tags somadas" : "Criativo cadastrado",
        description: "formato: " + (r.formato || "desconhecido"),
      });
      setNovaUrl(""); setNovoTitulo("");
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setSalvando(false);
  }

  // ── subida de foto ────────────────────────────────────────────────────────
  // Foto de celular tem 4-8 MB e o /api/upload-image corta em 5 MB. Além do
  // limite, a imagem acaba em base64 no Postgres — mandar o arquivo cru
  // engordaria o banco à toa. Reduzir aqui resolve os dois de uma vez.
  const LADO_MAXIMO = 1600;
  const PROPORCAO: Record<string, number> = {
    feed_4x5: 0.8, story_9x16: 0.5625, "paisagem_1.91x1": 1.91,
  };

  async function lerImagem(file: File): Promise<ImageBitmap | HTMLImageElement> {
    // from-image respeita a rotação do EXIF — sem isso, foto de celular sobe deitada.
    try { return await createImageBitmap(file, { imageOrientation: "from-image" } as any); }
    catch {
      return await new Promise((ok, err) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = err;
        img.src = URL.createObjectURL(file);
      });
    }
  }

  function desenhar(src: any, lw: number, lh: number, sx: number, sy: number, sw: number, sh: number): Promise<Blob | null> {
    const c = document.createElement("canvas");
    c.width = lw; c.height = lh;
    c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, lw, lh);
    return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
  }

  async function reduzir(src: any): Promise<Blob | null> {
    const w = src.width, h = src.height;
    const escala = Math.min(1, LADO_MAXIMO / Math.max(w, h));
    return desenhar(src, Math.round(w * escala), Math.round(h * escala), 0, 0, w, h);
  }

  /** Recorte centralizado na proporção pedida — nunca deforma, sempre corta. */
  async function recortar(src: any, proporcao: number): Promise<Blob | null> {
    const w = src.width, h = src.height;
    let sw = w, sh = Math.round(w / proporcao);
    if (sh > h) { sh = h; sw = Math.round(h * proporcao); }
    const sx = Math.round((w - sw) / 2), sy = Math.round((h - sh) / 2);
    const escala = Math.min(1, LADO_MAXIMO / Math.max(sw, sh));
    return desenhar(src, Math.round(sw * escala), Math.round(sh * escala), sx, sy, sw, sh);
  }

  async function subirBlob(blob: Blob, nome: string): Promise<string> {
    const fd = new FormData();
    fd.append("image", new File([blob], nome, { type: "image/jpeg" }));
    const r = await fetch("/api/upload-image", { method: "POST", credentials: "include", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.message || "falha ao subir (" + r.status + ")");
    return j.url;
  }

  const tagsDoLote = () => ({
    gancho: novoGancho ? [novoGancho] : [],
    cenario: novoCenario ? [novoCenario] : [],
    publico: novoPublico ? [novoPublico] : [],
  });

  async function enviarArquivos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setSubindo(true);
    setLogSubida([]);
    const registra = (texto: string, erro?: boolean) => setLogSubida((l) => [...l, { texto, erro }]);
    let novos = 0;

    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) { registra(file.name + ": não é imagem", true); continue; }
      try {
        const src = await lerImagem(file);
        const base = await reduzir(src);
        if (!base) throw new Error("não consegui processar a imagem");

        const url = await subirBlob(base, file.name);
        const r = await apiPost("/api/mkt/assets", {
          url, titulo: (novoTitulo.trim() || file.name.replace(/\.[^.]+$/, "")).slice(0, 120),
          origem: "foto_real", direitosOk: true, tags: tagsDoLote(),
        });
        if (r.duplicado) registra(file.name + ": já estava na biblioteca — tags somadas");
        else { novos++; registra(file.name + ": entrou como " + r.formato + " (" + r.largura + "x" + r.altura + ")"); }

        // Recortes: é o que a biblioteca apontou como faltando para anunciar.
        for (const f of recortes) {
          const p = PROPORCAO[f];
          if (!p) continue;
          const blob = await recortar(src, p);
          if (!blob) continue;
          const urlR = await subirBlob(blob, f + "-" + file.name);
          const rr = await apiPost("/api/mkt/assets", {
            url: urlR,
            titulo: ((novoTitulo.trim() || file.name.replace(/\.[^.]+$/, "")) + " (" + f + ")").slice(0, 120),
            origem: "ia_moldura", direitosOk: true, tags: tagsDoLote(),
          });
          if (!rr.duplicado) novos++;
          registra("   ↳ recorte " + f + ": " + (rr.duplicado ? "já existia" : "criado"));
        }
      } catch (e: any) {
        registra(file.name + ": " + (e?.message || "erro"), true);
      }
    }

    setSubindo(false);
    if (novos) toast({ title: novos + " criativo(s) na biblioteca", description: "Confira as tags no acervo abaixo." });
    recarregar();
  }

  async function marcarUso(id: number) {
    try {
      const r = await apiPost("/api/mkt/assets/" + id + "/uso", { canal: "instagram" });
      if (r.motivo) { toast({ title: "Não pode ir ao ar", description: r.motivo, variant: "destructive" }); return; }
      toast({ title: "Uso registrado", description: "Entra no descanso e passa a contar no desempenho." });
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }

  async function remover(a: any) {
    const nome = a.titulo || a.produto_nome || ("criativo " + a.id);
    if (!window.confirm('Apagar "' + nome + '" da biblioteca?')) return;
    try {
      let r = await (await fetch("/api/mkt/assets/" + a.id, { method: "DELETE", credentials: "include" })).json();
      if (!r.ok && r.usos) {
        // Já foi ao ar: apagar tira do histórico de desempenho. Pergunta de novo.
        if (!window.confirm(r.erro + ". Apagar mesmo assim?")) return;
        r = await (await fetch("/api/mkt/assets/" + a.id + "?confirmar=true", { method: "DELETE", credentials: "include" })).json();
      }
      if (!r.ok) { toast({ title: "Não deu para apagar", description: r.erro, variant: "destructive" }); return; }
      toast({ title: "Apagado", description: nome });
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }

  async function alternarDireitos(a: any) {
    try {
      await fetch("/api/mkt/assets/" + a.id, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direitosOk: !a.direitos_ok }),
      });
      recarregar();
    } catch { /* silencioso: a tela recarrega e mostra o estado real */ }
  }

  const p = pan.data || {};
  const d = desemp.data || {};
  const L = lac.data || {};

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <i className="fas fa-images text-muted-foreground" /> Biblioteca de criativos
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-xs text-muted-foreground">
          Sem isto é impossível saber que <b>gancho de margem</b> vende mais que <b>gancho de sabor</b>.
          Cada criativo carrega tag, e cada uso aponta para uma campanha — a receita volta pelo fio de
          atribuição e cai na tag. Só há conclusão com amostra: abaixo de {p.amostraMinima || 3} usos, ou
          quando o mesmo criativo dividiu campanha com outro gancho, a tela avisa em vez de ranquear.
        </p>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ["No acervo", num(p.total), ""],
            ["Liberados", num(p.liberados), "direitos conferidos"],
            ["Prontos hoje", num(p.elegiveis), "fora do descanso de " + (p.diasDescanso || 21) + "d"],
            ["Nunca usados", num(p.nunca_usados), ""],
            ["Usos registrados", num(p.usos_totais), ""],
          ].map(([t, v, s]: any) => (
            <div key={t} className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{t}</div>
              <div className="text-xl font-semibold">{v}</div>
              {s ? <div className="text-[10px] text-muted-foreground">{s}</div> : null}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" onClick={importar} disabled={importando}>
            <i className="fas fa-download mr-2" />
            {importando ? "Lendo o catálogo…" : "Trazer as fotos do catálogo"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Lê as fotos que já estão nos produtos ativos. Foto repetida em vários produtos vira um criativo só.
          </span>
        </div>

        {/* ── desempenho por tag: o motivo da seção existir ── */}
        <div className="rounded-lg border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">O que vende mais</span>
            {["gancho", "cenario", "publico", "produto"].map((e) => (
              <Button key={e} size="sm" variant={eixo === e ? "default" : "outline"} onClick={() => setEixo(e)}>
                {e}
              </Button>
            ))}
            <span className="text-[11px] text-muted-foreground ml-auto">últimos 90 dias</span>
          </div>
          {d.recado && (
            <div className="text-xs rounded-md bg-muted/60 px-3 py-2">
              <i className="fas fa-circle-info mr-2 text-muted-foreground" />{d.recado}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left py-1">{eixo}</th>
                  <th className="text-right">Criativos</th>
                  <th className="text-right">Usos</th>
                  <th className="text-right">Pedidos</th>
                  <th className="text-right">Receita</th>
                  <th className="text-right">Por uso</th>
                  <th className="text-left pl-3">Dá para concluir?</th>
                </tr>
              </thead>
              <tbody>
                {(d.linhas || []).length === 0 && (
                  <tr><td colSpan={7} className="py-4 text-center text-muted-foreground text-xs">
                    Nenhum uso de criativo registrado ainda.
                  </td></tr>
                )}
                {(d.linhas || []).map((l: any) => (
                  <tr key={l.valor} className="border-b last:border-0">
                    <td className="py-2 font-medium">{l.valor}</td>
                    <td className="text-right">{num(l.criativos)}</td>
                    <td className="text-right">{num(l.usos)}</td>
                    <td className="text-right">{num(l.pedidos)}</td>
                    <td className="text-right font-semibold">{brl(l.receita)}</td>
                    <td className="text-right">{brl(l.receitaPorUso)}</td>
                    <td className="pl-3">
                      {l.confiavel
                        ? <Badge variant="default">sim</Badge>
                        : <Badge variant="secondary">ainda não</Badge>}
                      <div className="text-[10px] text-muted-foreground">{l.observacao}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── o que falta fotografar ── */}
        <div className="rounded-lg border p-3 space-y-2">
          <div className="text-sm font-semibold">O que falta fotografar</div>
          <p className="text-[11px] text-muted-foreground">
            Quando falta material, a Central entrega roteiro de captação — nunca inventa a cena.
          </p>
          {(L.roteiro || []).length === 0 ? (
            <div className="text-xs text-muted-foreground">Sem lacuna apontada.</div>
          ) : (
            <ul className="text-xs space-y-1 list-disc pl-5">
              {(L.roteiro || []).map((r: string, i: number) => <li key={i}>{r}</li>)}
            </ul>
          )}
          <div className="flex gap-4 text-[11px] text-muted-foreground pt-1">
            <span>sem direitos conferidos: <b>{num(L.semDireitos)}</b></span>
            <span>sem tag de gancho/público: <b>{num(L.semTag)}</b></span>
            <span>sem dimensão lida: <b>{num(L.semDimensao)}</b></span>
          </div>
        </div>

        {/* ── subir foto do computador/celular ── */}
        <div className="rounded-lg border p-3 space-y-3">
          <div className="text-sm font-semibold">Subir fotos</div>
          <p className="text-[11px] text-muted-foreground">
            Escolha várias de uma vez. Cada foto é reduzida aqui no navegador antes de subir
            (o limite do sistema é 5 MB e foto de celular passa disso), e o gancho/cenário/público
            escolhidos abaixo valem para todas do lote.
          </p>

          <div
            onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
            onDragLeave={() => setArrastando(false)}
            onDrop={(e) => { e.preventDefault(); setArrastando(false); enviarArquivos(e.dataTransfer.files); }}
            className={"rounded-lg border-2 border-dashed p-6 text-center " + (arrastando ? "bg-muted" : "")}
          >
            <i className="fas fa-camera text-2xl text-muted-foreground" />
            <div className="text-sm mt-2">Arraste as fotos aqui</div>
            <div className="text-[11px] text-muted-foreground mb-3">ou</div>
            <input ref={inputArquivo} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { enviarArquivos(e.target.files); e.currentTarget.value = ""; }} />
            <Button size="sm" variant="outline" disabled={subindo}
              onClick={() => inputArquivo.current?.click()}>
              {subindo ? "Subindo…" : "Escolher arquivos"}
            </Button>
          </div>

          <div className="flex flex-wrap gap-3 items-center text-xs">
            <span className="text-muted-foreground">Gerar também recorte em:</span>
            {(["feed_4x5", "story_9x16", "paisagem_1.91x1"] as const).map((f) => (
              <label key={f} className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={recortes.includes(f)}
                  onChange={() => setRecortes(recortes.includes(f) ? recortes.filter(x => x !== f) : [...recortes, f])} />
                {f}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            O recorte é <b>centralizado</b> e entra como <code>ia_moldura</code> — corte de foto real, que a regra da casa
            permite. O que a IA nunca faz é inventar a cena.
          </p>

          {logSubida.length > 0 && (
            <ul className="text-[11px] space-y-1 max-h-40 overflow-y-auto">
              {logSubida.map((l, i) => (
                <li key={i} className={l.erro ? "text-destructive" : "text-muted-foreground"}>
                  <i className={"fas mr-1 " + (l.erro ? "fa-xmark" : "fa-check")} />{l.texto}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── cadastro avulso ── */}
        <div className="rounded-lg border p-3 space-y-3">
          <div className="text-sm font-semibold">Cadastrar um criativo por endereço</div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Endereço da imagem</Label>
              <Input value={novaUrl} onChange={(e) => setNovaUrl(e.target.value)}
                placeholder="/api/photo-media/123  ou  /shop/images/amora.jpg" />
            </div>
            <div>
              <Label className="text-xs">Título</Label>
              <Input value={novoTitulo} onChange={(e) => setNovoTitulo(e.target.value)} placeholder="Prateleira da padaria" />
            </div>
          </div>
          <div className="grid md:grid-cols-4 gap-3">
            {[
              ["Gancho", novoGancho, setNovoGancho, vocab.gancho || []],
              ["Cenário", novoCenario, setNovoCenario, vocab.cenario || []],
              ["Público", novoPublico, setNovoPublico, vocab.publico || []],
              ["Origem", novaOrigem, setNovaOrigem, vocab.origem || []],
            ].map(([rot, val, set, ops]: any) => (
              <div key={rot}>
                <Label className="text-xs">{rot}</Label>
                <select className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                  value={val} onChange={(e) => set(e.target.value)}>
                  <option value="">—</option>
                  {ops.map((o: string) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            ))}
          </div>
          <Button size="sm" onClick={cadastrar} disabled={salvando || !novaUrl.trim()}>
            {salvando ? "Salvando…" : "Cadastrar"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Peça gerada por IA nasce <b>bloqueada</b> mesmo aqui: só vai ao ar depois de você liberar os direitos na lista.
          </p>
        </div>

        {/* ── acervo ── */}
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-sm font-semibold">Acervo</span>
            <select className="h-8 rounded-md border bg-background px-2 text-xs"
              value={filtro.gancho || ""} onChange={(e) => setFiltro({ ...filtro, gancho: e.target.value })}>
              <option value="">todo gancho</option>
              {(vocab.gancho || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select className="h-8 rounded-md border bg-background px-2 text-xs"
              value={filtro.publico || ""} onChange={(e) => setFiltro({ ...filtro, publico: e.target.value })}>
              <option value="">todo público</option>
              {(vocab.publico || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select className="h-8 rounded-md border bg-background px-2 text-xs"
              value={filtro.formato || ""} onChange={(e) => setFiltro({ ...filtro, formato: e.target.value })}>
              <option value="">todo formato</option>
              {(p.porFormato || []).map((f: any) => <option key={f.formato} value={f.formato}>{f.formato} ({f.n})</option>)}
            </select>
            <Button size="sm" variant={filtro.soElegiveis ? "default" : "outline"}
              onClick={() => setFiltro({ ...filtro, soElegiveis: !filtro.soElegiveis })}>
              só os prontos para hoje
            </Button>
          </div>

          {lista.isLoading && <div className="text-xs text-muted-foreground">Carregando…</div>}
          {lista.error && <div className="text-xs text-destructive">{String((lista.error as any).message)}</div>}
          {!lista.isLoading && (lista.data || []).length === 0 && (
            <div className="text-xs text-muted-foreground py-4 text-center">
              Biblioteca vazia com esse filtro. Comece por “Trazer as fotos do catálogo”.
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {(lista.data || []).map((a: any) => (
              <div key={a.id} className="rounded-lg border overflow-hidden flex flex-col">
                <div className="aspect-square bg-muted flex items-center justify-center overflow-hidden">
                  {a.url
                    ? <img src={a.url} alt={a.titulo || ""} className="w-full h-full object-cover" loading="lazy" />
                    : <i className="fas fa-image text-2xl text-muted-foreground" />}
                </div>
                <div className="p-2 space-y-1 flex-1 flex flex-col">
                  <div className="text-[11px] font-medium truncate" title={a.titulo || a.produto_nome || ""}>
                    {a.titulo || a.produto_nome || "sem título"}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline" className="text-[9px] px-1 py-0">{a.formato}</Badge>
                    {(a.tags?.gancho || []).slice(0, 2).map((g: string) => (
                      <Badge key={g} className="text-[9px] px-1 py-0" style={{ background: ROXO }}>{g}</Badge>
                    ))}
                    {a.origem === "ia_gerado" && <Badge variant="destructive" className="text-[9px] px-1 py-0">IA</Badge>}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {num(a.usos)} uso(s)
                    {a.dias_de_descanso ? " · descansando " + a.dias_de_descanso + "d" : ""}
                  </div>
                  <div className="mt-auto flex gap-1 pt-1">
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2 flex-1"
                      onClick={() => alternarDireitos(a)}>
                      {a.direitos_ok ? "liberado" : "liberar"}
                    </Button>
                    <Button size="sm" className="h-6 text-[10px] px-2 flex-1"
                      disabled={!a.elegivel} onClick={() => marcarUso(a.id)}>
                      usei
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1" title="apagar"
                      onClick={() => remover(a)}>
                      <i className="fas fa-trash text-[10px] text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
