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

      {/* ── Fase 0: os riscos abertos, antes de tudo ── */}
      <Fase0 />

      {/* ── fila de aprovação (buraco 6) — vem primeira porque é a ação do dia ── */}
      <FilaAprovacao />

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

      {/* ── presença em Google (buraco 9) ── */}
      <PresencaGoogle />

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

// ============================================================================
// BURACO 6 — Fila de aprovação
// ----------------------------------------------------------------------------
// A regra 3 do plano é requisito, não detalhe: "aprovar duas semanas de conteúdo
// tem que caber em 5 minutos no celular". Por isso:
//   • cartão empilhado, alvo de toque grande, nada de tabela larga
//   • seleção múltipla e barra fixa embaixo, ao alcance do polegar
//   • "aprovar tudo exceto as marcadas" — o gesto de quem confia no revisor
//   • peça que o revisor bloqueou NÃO passa de raspão: exige assumir por escrito
// ============================================================================
function FilaAprovacao() {
  const { toast } = useToast();
  const [sel, setSel] = useState<string[]>([]);
  const [comentario, setComentario] = useState("");
  const [assumir, setAssumir] = useState(false);
  const [agindo, setAgindo] = useState(false);
  const [abertos, setAbertos] = useState<string[]>([]);

  const q = useQuery<any>({ queryKey: ["/api/mkt/fila-aprovacao"], queryFn: () => apiGet("/api/mkt/fila-aprovacao") });
  const pan = useQuery<any>({ queryKey: ["/api/mkt/esteira/panorama"], queryFn: () => apiGet("/api/mkt/esteira/panorama") });

  const pecas: any[] = q.data?.pecas || [];
  const p = pan.data || {};
  const recarregar = () => { q.refetch(); pan.refetch(); setSel([]); setComentario(""); setAssumir(false); };
  const alternar = (id: string) => setSel(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const abrir = (id: string) => setAbertos(abertos.includes(id) ? abertos.filter(x => x !== id) : [...abertos, id]);

  async function decidir(decisao: "aprovar" | "reprovar" | "devolver", ids?: string[]) {
    const alvo = ids || sel;
    if (!alvo.length) return;
    if (decisao !== "aprovar" && !comentario.trim()) {
      toast({ title: "Escreva o motivo", description: "Devolver sem dizer o que está errado joga o problema de volta sem informação.", variant: "destructive" });
      return;
    }
    setAgindo(true);
    try {
      const r = await apiPost("/api/mkt/pieces/decisao", { ids: alvo, decisao, comentario: comentario || null, assumirBloqueio: assumir });
      const recusadas = (r.itens || []).filter((i: any) => !i.ok);
      toast({
        title: r.aplicados + " peça(s) " + (decisao === "aprovar" ? "aprovada(s)" : decisao === "reprovar" ? "reprovada(s)" : "devolvida(s)"),
        description: recusadas.length ? recusadas.length + " não passaram: " + recusadas[0].motivo : "Tudo certo.",
        variant: recusadas.length ? "destructive" : undefined,
      });
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setAgindo(false);
  }

  async function aprovarExceto() {
    setAgindo(true);
    try {
      const r = await apiPost("/api/mkt/pieces/aprovar-exceto", { excecoes: sel, assumirBloqueio: assumir });
      const recusadas = (r.itens || []).filter((i: any) => !i.ok);
      toast({
        title: r.aplicados + " peça(s) aprovada(s)",
        description: recusadas.length ? recusadas.length + " ficaram na fila: " + recusadas[0].motivo : "A fila ficou só com o que você marcou.",
      });
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setAgindo(false);
  }

  async function publicar(id: string) {
    try {
      const r = await apiPost("/api/mkt/pieces/" + id + "/publicada", {});
      toast({
        title: r.ok ? "Marcada como publicada" : "Não deu",
        description: r.ok ? (r.usosRegistrados || 0) + " criativo(s) passaram a contar no desempenho" : r.erro,
        variant: r.ok ? undefined : "destructive",
      });
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }

  const temBloqueadaSelecionada = pecas.some(x => sel.includes(x.id) && x.precisaAtencao);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <i className="fas fa-circle-check text-muted-foreground" /> Fila de aprovação
          {q.data?.total > 0 && (
            <Badge className="ml-1" style={{ background: ROXO }}>{q.data.total}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Nada vai ao ar sem você. O revisor de marca lê cada peça antes de chegar aqui — e o que
          ele bloqueou <b>não passa no “aprovar tudo”</b>: exige você assumir. Feita para o celular:
          aprovar duas semanas de conteúdo tem que caber em cinco minutos.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ["Esperando você", num(p.na_fila), p.escaladas > 0 ? p.escaladas + " escalada(s)" : ""],
            ["Publicadas", num(p.publicadas), "últimos " + (p.dias || 30) + " dias"],
            ["Barradas pelo revisor", num(p.bloqueadas), "voltaram para ajuste"],
            ["Espera média", (p.horasMediasAteDecisao ?? 0) + "h", "da criação até sua decisão"],
          ].map(([t, v, s]: any) => (
            <div key={t} className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{t}</div>
              <div className="text-xl font-semibold">{v}</div>
              {s ? <div className="text-[10px] text-muted-foreground">{s}</div> : null}
            </div>
          ))}
        </div>

        {q.isLoading && <div className="text-xs text-muted-foreground">Carregando…</div>}
        {q.error && <div className="text-xs text-destructive">{String((q.error as any).message)}</div>}

        {!q.isLoading && pecas.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <i className="fas fa-mug-hot text-2xl block mb-2" />
            Nada esperando por você.
          </div>
        )}

        {pecas.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2 items-center text-xs">
              <Button size="sm" variant="outline" onClick={() => setSel(pecas.map(x => x.id))}>marcar todas</Button>
              <Button size="sm" variant="outline" onClick={() => setSel([])}>limpar</Button>
              <span className="text-muted-foreground">{sel.length} marcada(s)</span>
            </div>

            <div className="space-y-3">
              {pecas.map((x) => {
                const marcada = sel.includes(x.id);
                const aberto = abertos.includes(x.id);
                return (
                  <div key={x.id}
                    className={"rounded-lg border p-3 " + (marcada ? "ring-2" : "") + (x.precisaAtencao ? " border-destructive/50" : "")}
                    style={marcada ? { borderColor: ROXO } : undefined}>
                    <div className="flex gap-3">
                      <label className="flex items-start pt-1 cursor-pointer">
                        <input type="checkbox" className="w-5 h-5" checked={marcada} onChange={() => alternar(x.id)} />
                      </label>
                      {x.miniaturas?.[0] && (
                        <img src={x.miniaturas[0]} alt="" className="w-16 h-16 rounded object-cover shrink-0" loading="lazy" />
                      )}
                      <div className="min-w-0 flex-1" onClick={() => abrir(x.id)}>
                        <div className="flex flex-wrap gap-1 items-center mb-1">
                          <Badge variant="outline" className="text-[10px] px-1 py-0">{x.canal}</Badge>
                          {x.gancho && <Badge className="text-[10px] px-1 py-0" style={{ background: ROXO }}>{x.gancho}</Badge>}
                          {x.campanha_codigo && <Badge variant="secondary" className="text-[10px] px-1 py-0">{x.campanha_codigo}</Badge>}
                          {x.origem === "agente" && <Badge variant="outline" className="text-[10px] px-1 py-0">IA</Badge>}
                          {x.escalado && <Badge variant="destructive" className="text-[10px] px-1 py-0">escalada</Badge>}
                        </div>
                        <div className="text-sm leading-snug">
                          {aberto ? x.copy : x.previa}{!aberto && String(x.copy || "").length > 180 ? "…" : ""}
                        </div>
                        {x.bloqueios?.length > 0 && (
                          <div className="mt-2 text-[11px] text-destructive">
                            <i className="fas fa-triangle-exclamation mr-1" />
                            {x.bloqueios.join(" · ")}
                          </div>
                        )}
                        {x.avisos?.length > 0 && (
                          <div className="mt-1 text-[11px] text-amber-600">confira: {x.avisos.join(" · ")}</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 border-t pt-3">
              <Textarea rows={2} value={comentario} onChange={(e) => setComentario(e.target.value)}
                placeholder="Motivo (obrigatório para devolver ou reprovar) — ex.: trocar a foto pela da prateleira" />
              {temBloqueadaSelecionada && (
                <label className="flex items-center gap-2 text-xs cursor-pointer rounded-md bg-destructive/10 p-2">
                  <input type="checkbox" className="w-4 h-4" checked={assumir} onChange={(e) => setAssumir(e.target.checked)} />
                  <span>Assumo o bloqueio do revisor nas peças marcadas — fica registrado no meu nome</span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button className="flex-1 min-w-[120px] h-11" disabled={agindo || !sel.length} onClick={() => decidir("aprovar")}>
                  <i className="fas fa-check mr-2" />Aprovar {sel.length || ""}
                </Button>
                <Button variant="outline" className="flex-1 min-w-[120px] h-11" disabled={agindo || !sel.length} onClick={() => decidir("devolver")}>
                  <i className="fas fa-rotate-left mr-2" />Devolver
                </Button>
                <Button variant="ghost" className="h-11" disabled={agindo || !sel.length} onClick={() => decidir("reprovar")}>
                  Reprovar
                </Button>
              </div>
              <Button variant="secondary" className="w-full h-11" disabled={agindo} onClick={aprovarExceto}>
                Aprovar tudo {sel.length ? "exceto as " + sel.length + " marcadas" : "que está na fila"}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Marcar e usar “aprovar tudo exceto” é o caminho rápido: você olha só o que quer segurar.
              </p>
            </div>
          </>
        )}

        <NovaPeca aoCriar={recarregar} publicar={publicar} />
      </CardContent>
    </Card>
  );
}

// Existe para a esteira poder ser usada hoje: os agentes que escrevem (bloco CRIAR)
// entram nos próximos passos e vão criar peça pela mesma rota.
function NovaPeca({ aoCriar, publicar }: { aoCriar: () => void; publicar: (id: string) => void }) {
  const { toast } = useToast();
  const [aberto, setAberto] = useState(false);
  const [canal, setCanal] = useState("instagram");
  const [gancho, setGancho] = useState("");
  const [campanhaId, setCampanhaId] = useState("");
  const [copy, setCopy] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  const camps = useQuery<any>({ queryKey: ["/api/mkt/campanhas"], queryFn: () => apiGet("/api/mkt/campanhas") });
  const assets = useQuery<any>({ queryKey: ["/api/mkt/assets", "peca"], queryFn: () => apiGet("/api/mkt/assets?soElegiveis=true&limite=24") });
  const pan = useQuery<any>({ queryKey: ["/api/mkt/assets/panorama", "peca"], queryFn: () => apiGet("/api/mkt/assets/panorama") });

  const aprovadas = useQuery<any>({ queryKey: ["/api/mkt/esteira/panorama", "aprovadas"], queryFn: () => apiGet("/api/mkt/esteira/panorama") });
  const nAprovadas = (aprovadas.data?.porEstado || []).find((e: any) => e.estado === "aprovado")?.n || 0;

  async function criar() {
    if (!copy.trim()) return;
    setSalvando(true);
    try {
      const r = await apiPost("/api/mkt/pieces", {
        canal, gancho: gancho || null, campanhaId: campanhaId || null, copy, assetIds,
      });
      if (!r.ok) throw new Error(r.erro || "não deu para criar");
      const rev = await apiPost("/api/mkt/pieces/" + r.id + "/revisar", {});
      toast({
        title: rev.veredito === "bloqueado"
          ? (rev.escalado ? "Bloqueada — e escalada para você decidir" : "Bloqueada pelo revisor")
          : "Peça na fila de aprovação",
        description: rev.veredito === "bloqueado"
          ? (rev.achados || []).filter((a: any) => a.gravidade === "bloqueio").map((a: any) => a.regra).join(" · ")
          : "Passou no revisor de marca.",
        variant: rev.veredito === "bloqueado" ? "destructive" : undefined,
      });
      setCopy(""); setAssetIds([]);
      aoCriar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setSalvando(false);
  }

  if (!aberto) {
    return (
      <div className="flex flex-wrap gap-2 items-center border-t pt-3">
        <Button size="sm" variant="outline" onClick={() => setAberto(true)}>
          <i className="fas fa-plus mr-2" />Nova peça
        </Button>
        {nAprovadas > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {nAprovadas} peça(s) aprovada(s) esperando você postar — marque como publicada depois para o criativo contar no desempenho.
          </span>
        )}
      </div>
    );
  }

  const vocab = pan.data?.vocabulario || {};
  const lista: any[] = assets.data || [];
  const campanhas: any[] = camps.data?.campanhas || camps.data || [];

  return (
    <div className="border-t pt-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold">Nova peça</div>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAberto(false)}>fechar</Button>
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs">Canal</Label>
          <select className="w-full h-9 rounded-md border bg-background px-2 text-sm" value={canal} onChange={(e) => setCanal(e.target.value)}>
            {["instagram", "facebook", "whatsapp", "google", "hotsite"].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <Label className="text-xs">Gancho</Label>
          <select className="w-full h-9 rounded-md border bg-background px-2 text-sm" value={gancho} onChange={(e) => setGancho(e.target.value)}>
            <option value="">—</option>
            {(vocab.gancho || []).map((g: string) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <Label className="text-xs">Campanha</Label>
          <select className="w-full h-9 rounded-md border bg-background px-2 text-sm" value={campanhaId} onChange={(e) => setCampanhaId(e.target.value)}>
            <option value="">sem campanha (orgânico)</option>
            {campanhas.map((c: any) => <option key={c.id} value={c.id}>{c.codigo}</option>)}
          </select>
        </div>
      </div>
      <div>
        <Label className="text-xs">Texto</Label>
        <Textarea rows={4} value={copy} onChange={(e) => setCopy(e.target.value)}
          placeholder="Escreva a peça. Com campanha escolhida, o revisor exige o código de atribuição (/r/slug, cupom ou palavra-chave)." />
      </div>
      {lista.length > 0 && (
        <div>
          <Label className="text-xs">Criativo (opcional) — só os prontos para hoje</Label>
          <div className="flex gap-2 overflow-x-auto pb-1 mt-1">
            {lista.map((a: any) => (
              <button key={a.id} type="button"
                onClick={() => setAssetIds(assetIds.includes(String(a.id)) ? assetIds.filter(x => x !== String(a.id)) : [...assetIds, String(a.id)])}
                className={"shrink-0 w-16 h-16 rounded overflow-hidden border-2 " + (assetIds.includes(String(a.id)) ? "" : "border-transparent")}
                style={assetIds.includes(String(a.id)) ? { borderColor: ROXO } : undefined}>
                {a.url ? <img src={a.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                       : <i className="fas fa-image text-muted-foreground" />}
              </button>
            ))}
          </div>
        </div>
      )}
      <Button size="sm" disabled={salvando || !copy.trim()} onClick={criar}>
        {salvando ? "Enviando…" : "Criar e mandar para o revisor"}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        A peça passa pelo revisor de marca antes de chegar na fila. Bloqueada duas vezes, ela sobe
        escalada para você decidir — em vez de ficar em looping queimando token.
      </p>
      <PecasAprovadas publicar={publicar} />
    </div>
  );
}

function PecasAprovadas({ publicar }: { publicar: (id: string) => void }) {
  // Enquanto o App Review da Meta não sai, quem posta é você — e marcar aqui é o
  // que faz o criativo contar uso e entrar no desempenho por gancho.
  const q = useQuery<any>({ queryKey: ["/api/mkt/pieces", "aprovado"], queryFn: () => apiGet("/api/mkt/pieces?estado=aprovado") });
  const lista: any[] = q.data || [];
  if (!lista.length) return null;
  return (
    <div className="border-t pt-3 space-y-2">
      <div className="text-sm font-semibold">Aprovadas, esperando ir ao ar</div>
      <p className="text-[11px] text-muted-foreground">
        Enquanto o App Review da Meta não sai, quem posta é você. Depois de postar, marque aqui —
        é isso que põe o criativo em descanso e faz ele contar no desempenho por gancho.
      </p>
      {lista.map((x: any) => (
        <div key={x.id} className="flex gap-3 items-center rounded-lg border p-2">
          {x.miniaturas?.[0]
            ? <img src={x.miniaturas[0]} alt="" className="w-12 h-12 rounded object-cover shrink-0" loading="lazy" />
            : <div className="w-12 h-12 rounded bg-muted grid place-items-center shrink-0"><i className="fas fa-image text-muted-foreground text-xs" /></div>}
          <div className="min-w-0 flex-1">
            <div className="flex gap-1 flex-wrap mb-0.5">
              <Badge variant="outline" className="text-[10px] px-1 py-0">{x.canal}</Badge>
              {x.campanha_codigo && <Badge variant="secondary" className="text-[10px] px-1 py-0">{x.campanha_codigo}</Badge>}
            </div>
            <div className="text-xs truncate">{x.previa}</div>
          </div>
          <Button size="sm" className="h-9 shrink-0" onClick={() => publicar(x.id)}>postei</Button>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// BURACO 9 — Presença em Google
// ----------------------------------------------------------------------------
// O diagnóstico do plano era "zero presença". Medindo, era pior: robots.txt e
// sitemap.xml respondiam o HTML do painel — e robots que devolve HTML não é
// "faltando", é quebrado. Esta seção mostra o que já está de pé, o que só o
// Flavio pode resolver, e devolve as vendas de clique do Google para o Ads.
// ============================================================================
function PresencaGoogle() {
  const { toast } = useToast();
  const [salvando, setSalvando] = useState(false);
  const [form, setForm] = useState<any>(null);
  const [verPrevia, setVerPrevia] = useState(false);

  const q = useQuery<any>({ queryKey: ["/api/mkt/google"], queryFn: () => apiGet("/api/mkt/google") });
  const previa = useQuery<any>({
    queryKey: ["/api/mkt/google/previa"], queryFn: () => apiGet("/api/mkt/google/previa"), enabled: verPrevia,
  });

  const cfg = form ?? q.data?.config ?? {};
  const d = q.data?.diagnostico || {};
  const set = (k: string, v: any) => setForm({ ...(form ?? q.data?.config ?? {}), [k]: v });

  async function salvar() {
    setSalvando(true);
    try {
      const r = await apiPost("/api/mkt/google", form || {});
      if (!r.ok) throw new Error(r.erro || "não deu para salvar");
      toast({ title: "Salvo", description: "Vale na próxima vez que o Google visitar o site — sem deploy." });
      setForm(null); q.refetch(); if (verPrevia) previa.refetch();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setSalvando(false);
  }

  const COR: Record<string, string> = { ok: "#16a34a", atencao: "#d97706", falta: "#dc2626" };
  const ICONE: Record<string, string> = { ok: "fa-check", atencao: "fa-triangle-exclamation", falta: "fa-xmark" };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <i className="fab fa-google text-muted-foreground" /> Presença em Google
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          Quem procura <b>“suco natural atacado Goiânia”</b> não achava a Honest. O que dependia só de
          código já está no ar; o resto precisa de contas que só você abre — está marcado abaixo.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ["Já de pé", num(d.prontos), "resolvidos pelo sistema"],
            ["Faltando", num(d.pendentes), "a maioria depende de você"],
            ["Medindo", d.medindo ? "sim" : "não", d.medindo ? "GA4/Ads ligados" : "sem GA4 nem Ads"],
            ["Pedidos do Google", num(d.conversoes?.comGclid), "de " + num(d.conversoes?.totalPedidos) + " no período"],
          ].map(([t, v, s]: any) => (
            <div key={t} className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{t}</div>
              <div className="text-xl font-semibold">{v}</div>
              <div className="text-[10px] text-muted-foreground">{s}</div>
            </div>
          ))}
        </div>

        <div className="space-y-1">
          {(d.itens || []).map((i: any) => (
            <div key={i.item} className="flex gap-2 items-start rounded-md border p-2">
              <i className={"fas " + ICONE[i.estado] + " mt-0.5 text-xs"} style={{ color: COR[i.estado] }} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium flex items-center gap-2">
                  {i.item}
                  {i.quemResolve === "voce" && <Badge variant="secondary" className="text-[9px] px-1 py-0">com você</Badge>}
                </div>
                <div className="text-[11px] text-muted-foreground">{i.detalhe}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <div className="text-sm font-semibold">Colar os códigos (sem deploy)</div>
          <div className="grid md:grid-cols-3 gap-3">
            {[
              ["ga4Id", "Google Analytics 4", "G-XXXXXXX"],
              ["adsId", "Google Ads", "AW-000000000"],
              ["verificacaoSearchConsole", "Search Console", "código da meta tag"],
            ].map(([k, rot, ph]: any) => (
              <div key={k}>
                <Label className="text-xs">{rot}</Label>
                <Input value={cfg[k] || ""} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            {[
              ["rua", "Endereço", "Rua, número"],
              ["cep", "CEP", "00000-000"],
              ["telefone", "Telefone público", "+55 62 ..."],
            ].map(([k, rot, ph]: any) => (
              <div key={k}>
                <Label className="text-xs">{rot}</Label>
                <Input value={cfg[k] || ""} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Endereço em branco fica <b>fora</b> do dado estruturado de propósito: endereço inventado é pior
            que endereço nenhum, porque o Google cruza com o Perfil da Empresa e desconfia do resto.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={salvar} disabled={salvando || !form}>
              {salvando ? "Salvando…" : "Salvar"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setVerPrevia(!verPrevia)}>
              {verPrevia ? "esconder" : "ver o que o Google recebe"}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/api/mkt/google/conversoes.csv?dias=90" download>
                <i className="fas fa-file-csv mr-2" />Baixar conversões para o Ads
              </a>
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {d.conversoes?.recado}
          </p>
        </div>

        {verPrevia && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-semibold">O que o robô do Google recebe</div>
            {previa.isLoading && <div className="text-xs text-muted-foreground">Carregando…</div>}
            {previa.data && (
              <>
                <div className="text-[11px] text-muted-foreground">robots.txt</div>
                <pre className="text-[10px] bg-muted/60 rounded p-2 overflow-x-auto">{previa.data.robots}</pre>
                <div className="text-[11px] text-muted-foreground">
                  sitemap.xml — <b>{previa.data.sitemapUrls}</b> endereço(s)
                </div>
                <pre className="text-[10px] bg-muted/60 rounded p-2 overflow-x-auto max-h-40">{previa.data.sitemapInicio}</pre>
                <div className="text-[11px] text-muted-foreground">dado estruturado</div>
                <pre className="text-[10px] bg-muted/60 rounded p-2 overflow-x-auto max-h-60">{JSON.stringify(previa.data.jsonLd, null, 2)}</pre>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// FASE 0 — os riscos que o plano manda fechar ANTES de jogar tráfego
// ----------------------------------------------------------------------------
// "Nada da Central sobe antes da Fase 0 fechar esses cinco itens." Oito buracos
// subiram e ela nunca tinha sido feita. Esta seção mostra o estado MEDIDO de cada
// um — não o que o plano supunha.
// ============================================================================
function Fase0() {
  const { toast } = useToast();
  const [teto, setTeto] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const q = useQuery<any>({ queryKey: ["/api/mkt/fase0"], queryFn: () => apiGet("/api/mkt/fase0") });
  const barrados = useQuery<any>({ queryKey: ["/api/mkt/fase0/pix-barrados"], queryFn: () => apiGet("/api/mkt/fase0/pix-barrados") });
  const dist = useQuery<any>({ queryKey: ["/api/mkt/fase0/distribuicao"], queryFn: () => apiGet("/api/mkt/fase0/distribuicao?dias=180") });
  const d = q.data || {};
  const abertos = (d.itens || []).filter((i: any) => i.estado !== "fechado");

  async function salvar() {
    setSalvando(true);
    try {
      const r = await apiPost("/api/mkt/fase0", { tetoPix: Number(teto) });
      if (!r.ok) throw new Error(r.erro || "não deu");
      toast({ title: "Teto salvo", description: "Vale na próxima cobrança, sem deploy." });
      setTeto(null); q.refetch();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setSalvando(false);
  }

  async function limpar() {
    try {
      const r = await apiPost("/api/mkt/fase0/limpar-pausas", {});
      toast({ title: (r.apagadas || 0) + " pausa(s) vencida(s) limpas" });
      q.refetch();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }

  const COR: Record<string, string> = { fechado: "#16a34a", atencao: "#d97706", aberto: "#dc2626" };
  const ICONE: Record<string, string> = { fechado: "fa-check", atencao: "fa-triangle-exclamation", aberto: "fa-xmark" };

  return (
    <Card className={abertos.length ? "border-destructive/40" : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <i className="fas fa-shield-halved text-muted-foreground" /> Fase 0 — antes de jogar tráfego
          {abertos.length > 0 && <Badge variant="destructive">{abertos.length} aberto(s)</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          O plano diz: <b>“nada da Central sobe antes da Fase 0 fechar esses cinco itens”</b>. Oito buracos
          subiram e ela nunca foi feita. Aqui está o estado <b>medido</b> de cada um — dois estavam piores
          do que o plano dizia, e um já estava resolvido.
        </p>

        <div className="space-y-1">
          {(d.itens || []).map((i: any) => (
            <div key={i.risco} className="flex gap-2 items-start rounded-md border p-2">
              <i className={"fas " + ICONE[i.estado] + " mt-0.5 text-xs"} style={{ color: COR[i.estado] }} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{i.risco}</div>
                <div className="text-[11px] text-muted-foreground">{i.detalhe}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="grid md:grid-cols-3 gap-3 items-end">
          <div>
            <Label className="text-xs">Teto do PIX que a IA pode gerar sozinha</Label>
            <Input value={teto ?? (d.tetoPix ?? "")} onChange={(e) => setTeto(e.target.value)} placeholder="300" />
          </div>
          <Button size="sm" onClick={salvar} disabled={salvando || teto === null}>
            {salvando ? "Salvando…" : "Salvar teto"}
          </Button>
          {d.pausasVencidas > 0 && (
            <Button size="sm" variant="outline" onClick={limpar}>
              Limpar {d.pausasVencidas} pausa(s) vencida(s)
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Acima do teto a IA <b>não gera a cobrança</b>: registra e passa para uma pessoa. Zero desliga a trava
          — não recomendado no piloto.
        </p>

        {/* O teto certo não é palpite: é a distribuição real dos pedidos. */}
        {dist.data && dist.data.n > 0 && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-semibold">Onde ficam os seus pedidos</div>
            <p className="text-[11px] text-muted-foreground">{dist.data.recado}</p>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {[["mínimo", dist.data.min], ["metade até", dist.data.p50], ["75% até", dist.data.p75],
                ["90% até", dist.data.p90], ["95% até", dist.data.p95], ["maior", dist.data.max]].map(([t, v]: any) => (
                <div key={t} className="rounded border p-2">
                  <div className="text-[10px] text-muted-foreground">{t}</div>
                  <div className="text-sm font-semibold">{brl(v)}</div>
                </div>
              ))}
            </div>
            <div className="text-[11px] text-muted-foreground pt-1">
              Quantos pedidos iriam para uma pessoa com cada teto — clique para usar:
            </div>
            <div className="flex flex-wrap gap-2">
              {(dist.data.simulacao || []).map((sm: any) => (
                <Button key={sm.teto} size="sm"
                  variant={Number(teto ?? d.tetoPix) === sm.teto ? "default" : "outline"}
                  className="h-auto py-1 px-2 flex-col items-start"
                  onClick={() => setTeto(String(sm.teto))}>
                  <span className="text-[11px] font-semibold">{brl(sm.teto)}</span>
                  <span className="text-[9px] opacity-70">{sm.percentual}% para humano</span>
                </Button>
              ))}
            </div>
            {dist.data.porFonte?.pipeline && (
              <div className="rounded-md bg-muted/60 p-2 text-[11px] space-y-1">
                <div className="font-semibold">O ticket de revenda é de outra ordem</div>
                <div className="text-muted-foreground">
                  Pedidos do pipeline ({num(dist.data.porFonte.pipeline.n)} em 180 dias): metade até{" "}
                  <b>{brl(dist.data.porFonte.pipeline.p50)}</b>, 90% até <b>{brl(dist.data.porFonte.pipeline.p90)}</b>,
                  maior <b>{brl(dist.data.porFonte.pipeline.max)}</b>.
                  {dist.data.porFonte.ia && <> Pedidos da IA ({num(dist.data.porFonte.ia.n)}): metade até{" "}
                  <b>{brl(dist.data.porFonte.ia.p50)}</b>, maior <b>{brl(dist.data.porFonte.ia.max)}</b>.</>}
                </div>
              </div>
            )}
            {dist.data.alerta && (
              <p className="text-[11px] text-amber-600">
                <i className="fas fa-triangle-exclamation mr-1" />{dist.data.alerta}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Sugestão: <b>{brl(dist.data.sugestao)}</b> — deixa cerca de 1 em cada 10 pedidos indo para uma
              pessoa. É o suficiente para pegar o pedido fora do padrão sem a trava virar gargalo.
              {dist.data.fonte === "pipeline" && " (Calculado sobre os pedidos do pipeline, porque a IA ainda não registrou volume próprio.)"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              O teto não existe para revisar pedido normal — existe para pegar <b>erro de leitura</b>: a IA
              entender 100 caixas onde eram 10. Então ele deve ficar acima do maior pedido que você considera
              rotineiro, e bem abaixo do que seria obviamente errado.
            </p>
          </div>
        )}

        {(barrados.data || []).length > 0 && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-semibold">Cobranças que ficaram esperando uma pessoa</div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b">
                <tr><th className="text-left py-1">Pedido</th><th className="text-right">Valor</th><th className="text-right">Teto</th><th className="text-left pl-3">Quando</th></tr>
              </thead>
              <tbody>
                {(barrados.data || []).slice(0, 10).map((b: any) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className="py-1">{b.pedido || "—"}</td>
                    <td className="text-right font-semibold">{brl(b.valor)}</td>
                    <td className="text-right text-muted-foreground">{brl(b.teto)}</td>
                    <td className="pl-3 text-muted-foreground">{new Date(b.criado_em).toLocaleString("pt-BR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
