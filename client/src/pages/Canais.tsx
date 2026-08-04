// ============================================================================
// INTEGRA 2.0 — CANAIS DE VENDA (04/ago/2026)
// Pagina unica com os modulos HOTSITE e INSTAGRAM. Cada modulo reune, em abas,
// a gestao que ate agora estava espalhada pelo sistema (ou so existia por API):
//   Hotsite   : Pedidos · Tabela de Precos · Configuracoes
//   Instagram : Pedidos · Regras da IA · Metricas
// As telas Pedidos do Site e Tabela de Precos sao REAPROVEITADAS (mesmos
// componentes de sempre) — nada foi reescrito.
// Cadastro de cliente dos dois canais: SOMENTE INTEGRA 2.0 (sem Omie).
// ============================================================================
import { useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import HotsiteOrders from "@/pages/HotsiteOrders";
import HotsitePricing from "@/pages/HotsitePricing";
import {
  Globe, Instagram, ShoppingBag, Tags, Settings, Bot, BarChart3,
  Loader2, Save, CheckCircle2, XCircle, AlertTriangle, Database,
} from "lucide-react";

const brl = (v: any) =>
  (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// ---------------------------------------------------------------- resumo
function CartaoResumo({ canal, dados }: { canal: "hotsite" | "instagram"; dados: any }) {
  const d = dados || {};
  const itens = [
    { rotulo: "Hoje", valor: d.hoje ?? 0 },
    { rotulo: "7 dias", valor: d.sete_dias ?? 0 },
    { rotulo: "30 dias", valor: d.trinta_dias ?? 0 },
    { rotulo: "Total", valor: d.total ?? 0 },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      {itens.map((i) => (
        <div key={i.rotulo} className="rounded-lg border bg-white p-3">
          <div className="text-xs text-gray-500">{i.rotulo}</div>
          <div className="text-xl font-bold text-gray-900">{i.valor}</div>
        </div>
      ))}
      <div className="rounded-lg border bg-white p-3">
        <div className="text-xs text-gray-500">Valor 30 dias</div>
        <div className="text-xl font-bold text-gray-900">{brl(d.valor_30d)}</div>
      </div>
      <div className={`rounded-lg border p-3 ${(d.fora_do_pipeline ?? 0) > 0 ? "bg-amber-50 border-amber-300" : "bg-white"}`}>
        <div className="text-xs text-gray-500">Fora do pipeline</div>
        <div className={`text-xl font-bold ${(d.fora_do_pipeline ?? 0) > 0 ? "text-amber-700" : "text-gray-900"}`}>
          {d.fora_do_pipeline ?? 0}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------- pedidos (tabela simples)
function PedidosDoCanal({ canal }: { canal: "hotsite" | "instagram" }) {
  const { data, isLoading } = useQuery<any>({ queryKey: [`/api/canais/pedidos?canal=${canal}`] });
  const pedidos: any[] = data?.pedidos || [];

  if (isLoading) {
    return <div className="flex items-center gap-2 p-6 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando pedidos…</div>;
  }
  if (!pedidos.length) {
    return <div className="p-6 text-gray-500">Nenhum pedido deste canal ainda.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50">
            <th className="text-left py-2 px-3 font-semibold">Pedido</th>
            <th className="text-left py-2 px-3 font-semibold">Data</th>
            <th className="text-left py-2 px-3 font-semibold">Cliente</th>
            <th className="text-left py-2 px-3 font-semibold">Valor</th>
            <th className="text-left py-2 px-3 font-semibold">Pagamento</th>
            <th className="text-left py-2 px-3 font-semibold">Situação</th>
          </tr>
        </thead>
        <tbody>
          {pedidos.map((p) => (
            <tr key={p.id} className="border-b hover:bg-gray-50">
              <td className="py-2 px-3 font-mono text-xs">{p.numero || p.pipeline_numero || "—"}</td>
              <td className="py-2 px-3">{p.created_at ? new Date(p.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}</td>
              <td className="py-2 px-3">{p.cliente_fantasia || p.cliente || "—"}</td>
              <td className="py-2 px-3">{p.sale_value ? brl(p.sale_value) : "—"}</td>
              <td className="py-2 px-3">{p.payment_method || "—"}</td>
              <td className="py-2 px-3">
                {p.bloqueado ? (
                  <Badge variant="outline" className="border-red-300 text-red-700 bg-red-50">Bloqueado</Badge>
                ) : p.pipeline_id ? (
                  <Badge variant="outline" className="border-green-300 text-green-700 bg-green-50">{p.etapa || "no pipeline"}</Badge>
                ) : (
                  <Badge variant="outline" className="border-amber-300 text-amber-700 bg-amber-50">fora do pipeline</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------- bloco "onde vai o cadastro"
function DestinoCadastro({ texto }: { texto: string }) {
  return (
    <Card className="border-green-200 bg-green-50/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4 text-green-700" />
          Destino do cadastro de clientes
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-gray-700 space-y-1">
        <div className="flex items-center gap-2 font-semibold text-green-800">
          <CheckCircle2 className="h-4 w-4" /> INTEGRA 2.0
        </div>
        <div className="flex items-center gap-2 text-gray-600">
          <XCircle className="h-4 w-4 text-gray-400" /> Omie — não recebe cadastro deste canal
        </div>
        <p className="text-xs text-gray-500 pt-1">{texto}</p>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------- configuracoes do hotsite
function ConfigHotsite() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/canais/hotsite/config"] });
  const { data: pag } = useQuery<any>({ queryKey: ["/api/canais/hotsite/pagamentos"] });
  const [rascunho, setRascunho] = useState<any>(null);

  const salvar = useMutation({
    mutationFn: async (body: any) => apiRequest("POST", "/api/canais/hotsite/config", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/canais/hotsite/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/canais/hotsite/pagamentos"] });
      setRascunho(null);
      toast({ title: "Configuração salva", description: "As regras do canal Hotsite foram atualizadas." });
    },
    onError: (e: any) => toast({ title: "Não consegui salvar", description: String(e?.message || e), variant: "destructive" }),
  });

  if (isLoading) return <div className="flex items-center gap-2 p-6 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>;

  const cfg = data || {};
  const novo = { ...(cfg.clienteNovo || {}), ...(rascunho || {}) };
  const cartao = pag?.cartao || {};

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Meios de pagamento da loja</CardTitle>
          <CardDescription>O que o cliente vê no checkout, e se o gateway está de fato respondendo.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="font-medium">Cartão de crédito/débito</div>
              <div className="text-sm text-gray-500">Aparece no checkout de pessoa física quando ligado.</div>
              {cartao.gatewayOk === false && (
                <div className="mt-2 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>A Cielo está recusando as transações — <span className="font-mono">{cartao.gatewayMensagem}</span>. Com o cartão ligado, o cliente não consegue pagar e o pedido não chega a existir.</span>
                </div>
              )}
              {cartao.gatewayOk === true && (
                <div className="mt-2 flex items-center gap-2 text-sm text-green-700">
                  <CheckCircle2 className="h-4 w-4" /> Gateway respondendo ({cartao.ambiente}).
                </div>
              )}
            </div>
            <Switch
              checked={!!cfg.cartaoAtivo}
              onCheckedChange={(v) => salvar.mutate({ cartaoAtivo: v })}
              disabled={salvar.isPending}
            />
          </div>
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border p-3">
              <div className="font-medium">PIX</div>
              <div className="text-gray-500">{pag?.pix?.observacao || "—"}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="font-medium">Boleto</div>
              <div className="text-gray-500">{pag?.boleto?.observacao || "—"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Padrões do cliente novo</CardTitle>
          <CardDescription>
            Aplicados quando alguém compra na loja sem cadastro. Cliente que já existe mantém rota, periodicidade e vendedor dele.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <Label>Rota</Label>
              <Input value={novo.rota ?? ""} onChange={(e) => setRascunho({ ...(rascunho || {}), rota: e.target.value })} />
            </div>
            <div>
              <Label>Dia da rota</Label>
              <select
                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={novo.dia ?? "Dom"}
                onChange={(e) => setRascunho({ ...(rascunho || {}), dia: e.target.value })}
              >
                {(cfg.opcoes?.dias || []).map((d: string) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <Label>Periodicidade</Label>
              <select
                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={novo.periodicidade ?? "mensal"}
                onChange={(e) => setRascunho({ ...(rascunho || {}), periodicidade: e.target.value })}
              >
                {(cfg.opcoes?.periodicidades || []).map((p: string) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <Label>Vendedor padrão (id do usuário)</Label>
              <Input
                value={novo.vendedorId ?? ""}
                placeholder="vazio = Flávio (padrão do sistema)"
                onChange={(e) => setRascunho({ ...(rascunho || {}), vendedorId: e.target.value })}
              />
              {novo.vendedorNome && <p className="text-xs text-gray-500 mt-1">Atual: {novo.vendedorNome}</p>}
            </div>
          </div>
          <Button onClick={() => salvar.mutate(rascunho || {})} disabled={!rascunho || salvar.isPending}>
            {salvar.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Salvar padrões
          </Button>
        </CardContent>
      </Card>

      <DestinoCadastro texto={cfg.cadastro?.observacao || ""} />
    </div>
  );
}

// ------------------------------------------------- regras da IA (instagram)
function ConfigInstagram() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/canais/instagram/config"] });
  const [rascunho, setRascunho] = useState<any>(null);

  const salvar = useMutation({
    mutationFn: async (body: any) => apiRequest("POST", "/api/canais/instagram/config", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/canais/instagram/config"] });
      setRascunho(null);
      toast({ title: "Configuração salva", description: "As regras do canal Instagram foram atualizadas." });
    },
    onError: (e: any) => toast({ title: "Não consegui salvar", description: String(e?.message || e), variant: "destructive" }),
  });

  if (isLoading) return <div className="flex items-center gap-2 p-6 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>;

  const cfg = data || {};
  const ia = cfg.ia || {};
  const novo = { ...(cfg.clienteNovo || {}), ...(rascunho || {}) };

  const linha = (titulo: string, desc: string, campo: string, valor: boolean) => (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div>
        <div className="font-medium">{titulo}</div>
        <div className="text-sm text-gray-500">{desc}</div>
      </div>
      <Switch checked={valor} onCheckedChange={(v) => salvar.mutate({ [campo]: v })} disabled={salvar.isPending} />
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Regras da IA no canal</CardTitle>
          <CardDescription>
            Motor dos agentes: <span className="font-mono">{ia.motor}</span>. Com o motor desligado, nada abaixo tem efeito.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {linha("IA atende sozinha (front line)", "A IA responde primeiro e trava o atendente enquanto conduz.", "frontLine", !!ia.frontLine)}
          {linha("Avisar o atendente por WhatsApp", "Manda mensagem ao dono da carteira quando a IA passa a vez.", "notificaWhatsapp", !!ia.notificaWhatsapp)}
          {linha("Trava também para admin", "Se ligado, nem admin escreve por cima da IA.", "travaAdmin", !!ia.travaAdmin)}
          <div className="rounded-lg border p-3">
            <Label>Minutos para o dono responder antes de perder a vez</Label>
            <div className="flex gap-2 mt-1">
              <Input
                type="number"
                min={1}
                max={120}
                className="w-32"
                value={rascunho?.handoffMin ?? ia.handoffMin ?? 5}
                onChange={(e) => setRascunho({ ...(rascunho || {}), handoffMin: e.target.value })}
              />
              <Button
                variant="outline"
                onClick={() => salvar.mutate({ handoffMin: rascunho?.handoffMin })}
                disabled={rascunho?.handoffMin === undefined || salvar.isPending}
              >
                Salvar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Cliente novo cadastrado pela IA</CardTitle>
          <CardDescription>{cfg.clienteNovo?.observacao}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Carteira padrão (id do usuário)</Label>
            <Input
              value={novo.carteiraPadraoId ?? ""}
              onChange={(e) => setRascunho({ ...(rascunho || {}), carteiraPadraoId: e.target.value })}
            />
            {novo.carteiraPadraoNome && <p className="text-xs text-gray-500 mt-1">Atual: {novo.carteiraPadraoNome}</p>}
          </div>
          <Button
            onClick={() => salvar.mutate({ carteiraPadraoId: rascunho?.carteiraPadraoId })}
            disabled={!rascunho?.carteiraPadraoId || salvar.isPending}
          >
            {salvar.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Salvar carteira
          </Button>
        </CardContent>
      </Card>

      <DestinoCadastro texto={cfg.cadastro?.observacao || ""} />
    </div>
  );
}

// ------------------------------------------------- metricas do instagram
function MetricasInstagram({ resumo }: { resumo: any }) {
  const d = resumo || {};
  return (
    <div className="space-y-4">
      <CartaoResumo canal="instagram" dados={d} />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Leitura</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-700 space-y-2">
          <p>
            {(d.total ?? 0)} pedido(s) já entraram por este canal, {(d.trinta_dias ?? 0)} nos últimos 30 dias,
            somando {brl(d.valor_30d)}.
          </p>
          {(d.fora_do_pipeline ?? 0) > 0 && (
            <p className="text-amber-700">
              {d.fora_do_pipeline} pedido(s) com valor registrado ainda não chegaram ao pipeline de faturamento.
            </p>
          )}
          {(d.bloqueados ?? 0) > 0 && (
            <p className="text-red-700">{d.bloqueados} pedido(s) do canal estão na coluna Bloqueados.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- pagina
export default function Canais() {
  const { data: resumo } = useQuery<any>({ queryKey: ["/api/canais/resumo"] });
  const hot = resumo?.canais?.hotsite;
  const insta = resumo?.canais?.instagram;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <Globe className="h-8 w-8 text-orange-600" />
            Canais
          </h1>
          <p className="text-gray-600 mt-1">
            Gestão dos canais digitais de venda. Cadastro de clientes destes canais fica somente no INTEGRA 2.0.
          </p>
        </div>
        <BackToDashboardButton />
      </div>

      <Tabs defaultValue="hotsite" className="space-y-4">
        <TabsList>
          <TabsTrigger value="hotsite" className="flex items-center gap-2">
            <Globe className="h-4 w-4" /> Hotsite
            {(hot?.hoje ?? 0) > 0 && <Badge variant="secondary">{hot.hoje} hoje</Badge>}
          </TabsTrigger>
          <TabsTrigger value="instagram" className="flex items-center gap-2">
            <Instagram className="h-4 w-4" /> Instagram
            {(insta?.hoje ?? 0) > 0 && <Badge variant="secondary">{insta.hoje} hoje</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------- HOTSITE ------------------------------- */}
        <TabsContent value="hotsite" className="space-y-4">
          <CartaoResumo canal="hotsite" dados={hot} />
          <Tabs defaultValue="pedidos" className="space-y-4">
            <TabsList>
              <TabsTrigger value="pedidos" className="flex items-center gap-2"><ShoppingBag className="h-4 w-4" /> Pedidos</TabsTrigger>
              <TabsTrigger value="precos" className="flex items-center gap-2"><Tags className="h-4 w-4" /> Tabela de Preços</TabsTrigger>
              <TabsTrigger value="config" className="flex items-center gap-2"><Settings className="h-4 w-4" /> Configurações</TabsTrigger>
            </TabsList>
            <TabsContent value="pedidos"><HotsiteOrders /></TabsContent>
            <TabsContent value="precos"><HotsitePricing /></TabsContent>
            <TabsContent value="config"><ConfigHotsite /></TabsContent>
          </Tabs>
        </TabsContent>

        {/* ------------------------------ INSTAGRAM ------------------------------ */}
        <TabsContent value="instagram" className="space-y-4">
          <Tabs defaultValue="pedidos" className="space-y-4">
            <TabsList>
              <TabsTrigger value="pedidos" className="flex items-center gap-2"><ShoppingBag className="h-4 w-4" /> Pedidos</TabsTrigger>
              <TabsTrigger value="ia" className="flex items-center gap-2"><Bot className="h-4 w-4" /> Regras da IA</TabsTrigger>
              <TabsTrigger value="metricas" className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Métricas</TabsTrigger>
            </TabsList>
            <TabsContent value="pedidos">
              <Card><CardContent className="p-0"><PedidosDoCanal canal="instagram" /></CardContent></Card>
            </TabsContent>
            <TabsContent value="ia"><ConfigInstagram /></TabsContent>
            <TabsContent value="metricas"><MetricasInstagram resumo={insta} /></TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}
