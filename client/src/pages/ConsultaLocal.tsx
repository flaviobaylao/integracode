import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  MapPin, Navigation, Loader2, ArrowLeft, Phone, User, Crosshair,
  Store, Target, XCircle, Ban, HelpCircle, RefreshCw, Plus, Check,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type ResultadoConsulta = {
  tipo: "lead" | "cliente";
  id: string;
  nome: string;
  distancia: number;
  status: string;
  statusLabel: string;
  ativo: boolean;
  descartado: boolean;
  responsavelLabel: string;
  responsavel: string | null;
  bairro: string | null;
  cidade: string | null;
  telefone: string | null;
  contato: string | null;
  lat: number;
  lng: number;
};

type NovoPonto = {
  nome: string;
  categoria: string;
  tipo: string;
  distancia: number | null;
  endereco: string;
  businessStatus: string;
  lat: number;
  lng: number;
  placeId: string;
};

type Fase = "idle" | "localizando" | "buscando" | "pronto" | "erro";
type NovosFase = "idle" | "buscando" | "pronto" | "erro" | "disabled";

const RAIO_PADRAO = 100;

function estiloCenario(r: ResultadoConsulta) {
  if (r.tipo === "cliente") {
    return r.ativo
      ? { barra: "border-l-emerald-500", icone: <Store className="h-5 w-5 text-emerald-600" />, tag: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" }
      : { barra: "border-l-slate-400", icone: <Store className="h-5 w-5 text-slate-500" />, tag: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200" };
  }
  if (r.descartado) {
    return { barra: "border-l-gray-400", icone: <Ban className="h-5 w-5 text-gray-500" />, tag: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200" };
  }
  if (r.responsavel) {
    return { barra: "border-l-blue-500", icone: <Target className="h-5 w-5 text-blue-600" />, tag: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" };
  }
  return { barra: "border-l-amber-500", icone: <Target className="h-5 w-5 text-amber-600" />, tag: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" };
}

export default function ConsultaLocal() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [fase, setFase] = useState<Fase>("idle");
  const [resultados, setResultados] = useState<ResultadoConsulta[]>([]);
  const [raioUsado, setRaioUsado] = useState<number>(RAIO_PADRAO);
  const [coords, setCoords] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [erroMsg, setErroMsg] = useState<string>("");

  // ----- aba "Novos pontos" (radar de prospecção) -----
  const [aba, setAba] = useState<"integra" | "novos">("integra");
  const [novos, setNovos] = useState<NovoPonto[]>([]);
  const [novosFase, setNovosFase] = useState<NovosFase>("idle");
  const [novosMsg, setNovosMsg] = useState<string>("");
  const [cadastrados, setCadastrados] = useState<Record<string, "ok" | "loading">>({});

  const buscar = useCallback(async (lat: number, lng: number, raio: number) => {
    setFase("buscando");
    try {
      const data: any = await apiRequest("POST", "/api/consulta-local", { lat, lng, raio });
      if (data && data.ok) {
        setResultados(Array.isArray(data.resultados) ? data.resultados : []);
        setRaioUsado(data.raio || raio);
        setFase("pronto");
      } else {
        setErroMsg((data && data.message) || "Não foi possível consultar agora.");
        setFase("erro");
      }
    } catch (e: any) {
      setErroMsg(String((e && e.message) || e));
      setFase("erro");
    }
  }, []);

  const consultar = useCallback(() => {
    setErroMsg("");
    setResultados([]);
    setAba("integra");
    setNovos([]);
    setNovosFase("idle");
    setCadastrados({});
    if (!("geolocation" in navigator)) {
      setErroMsg("Este aparelho não permite usar a localização.");
      setFase("erro");
      return;
    }
    setFase("localizando");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setCoords({ lat: latitude, lng: longitude, acc: Math.round(accuracy || 0) });
        buscar(latitude, longitude, RAIO_PADRAO);
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "Permissão de localização negada. Toque no cadeado da barra de endereço e permita a localização para este site."
            : err.code === err.POSITION_UNAVAILABLE
            ? "Não foi possível obter sua localização. Verifique o GPS e tente novamente."
            : "Tempo esgotado ao obter a localização. Tente novamente.";
        setErroMsg(msg);
        setFase("erro");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }, [buscar]);

  const ampliar = useCallback(
    (raio: number) => {
      if (!coords) return;
      buscar(coords.lat, coords.lng, raio);
    },
    [coords, buscar]
  );

  const buscarNovos = useCallback(async () => {
    if (!coords) return;
    setNovosFase("buscando");
    setNovosMsg("");
    try {
      const data: any = await apiRequest("POST", "/api/radar/nearby", { lat: coords.lat, lng: coords.lng });
      if (data && data.ok) {
        setNovos(Array.isArray(data.resultados) ? data.resultados : []);
        setNovosFase("pronto");
      } else if (data && data.disabled) {
        setNovosFase("disabled");
        setNovosMsg(data.message || "Recurso desativado pelo administrador.");
      } else {
        setNovosFase("erro");
        setNovosMsg((data && data.message) || "Não foi possível buscar novos pontos.");
      }
    } catch (e: any) {
      setNovosFase("erro");
      setNovosMsg(String((e && e.message) || e));
    }
  }, [coords]);

  const trocarAba = useCallback((a: "integra" | "novos") => {
    setAba(a);
    if (a === "novos" && novosFase === "idle") buscarNovos();
  }, [novosFase, buscarNovos]);

  const cadastrarLead = useCallback(async (p: NovoPonto) => {
    setCadastrados((m) => ({ ...m, [p.placeId]: "loading" }));
    try {
      const payload: any = {
        fantasyName: p.nome,
        latitude: String(p.lat),
        longitude: String(p.lng),
        temperature: "cold",
        routeType: "prospeccao",
        status: "pending",
        observation: "Prospecção via radar" + (p.categoria ? ` · ${p.categoria}` : ""),
      };
      const res: any = await apiRequest("POST", "/api/leads", payload);
      if (res && (res.id || res.ok !== false)) {
        setCadastrados((m) => ({ ...m, [p.placeId]: "ok" }));
        toast({ title: "Lead cadastrado", description: p.nome });
      } else {
        setCadastrados((m) => { const n = { ...m }; delete n[p.placeId]; return n; });
        toast({ title: "Não foi possível cadastrar", description: (res && res.message) || "", variant: "destructive" });
      }
    } catch (e: any) {
      setCadastrados((m) => { const n = { ...m }; delete n[p.placeId]; return n; });
      toast({ title: "Erro ao cadastrar", description: String((e && e.message) || e), variant: "destructive" });
    }
  }, [toast]);

  const carregando = fase === "localizando" || fase === "buscando";

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Cabeçalho */}
      <div className="sticky top-0 z-10 bg-gradient-to-r from-emerald-600 to-green-600 text-white shadow-md">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate("/")} className="p-2 -ml-2 rounded-full hover:bg-white/15 transition" aria-label="Voltar" data-testid="button-voltar">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2 font-semibold leading-tight">
              <Crosshair className="h-5 w-5" /> Consulta no local
            </div>
            <div className="text-xs text-white/80">Este ponto já está no Integra?</div>
          </div>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-5 space-y-4">
        {/* Botão principal */}
        <Button onClick={consultar} disabled={carregando} className="w-full h-14 text-base bg-emerald-600 hover:bg-emerald-700" data-testid="button-consultar">
          {fase === "localizando" ? (
            <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Obtendo sua localização…</>
          ) : fase === "buscando" ? (
            <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Consultando…</>
          ) : (
            <><Navigation className="h-5 w-5 mr-2" /> Consultar este local</>
          )}
        </Button>

        {coords && fase !== "erro" && (
          <p className="text-center text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 inline mr-1" />
            {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
            {coords.acc ? ` · precisão ~${coords.acc} m` : ""}
          </p>
        )}

        {/* Estado inicial */}
        {fase === "idle" && (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-sm text-muted-foreground space-y-2">
              <Crosshair className="h-10 w-10 mx-auto text-emerald-500/70" />
              <p>Pare em frente ao estabelecimento e toque em <strong>Consultar este local</strong>.</p>
              <p>Buscamos leads e clientes num raio de {RAIO_PADRAO} m da sua posição.</p>
            </CardContent>
          </Card>
        )}

        {/* Erro */}
        {fase === "erro" && (
          <Card className="border-l-4 border-l-red-500">
            <CardContent className="py-5 text-sm space-y-3">
              <div className="flex items-start gap-2 text-red-600 dark:text-red-400">
                <XCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <span>{erroMsg}</span>
              </div>
              <Button variant="outline" size="sm" onClick={consultar} className="w-full">
                <RefreshCw className="h-4 w-4 mr-2" /> Tentar de novo
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Abas (aparecem depois da consulta) */}
        {fase === "pronto" && (
          <div className="flex bg-gray-200 dark:bg-gray-800 rounded-xl p-1 gap-1">
            <button
              onClick={() => trocarAba("integra")}
              className={`flex-1 text-sm font-semibold py-2 rounded-lg transition ${aba === "integra" ? "bg-white dark:bg-gray-950 shadow text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-300"}`}
              data-testid="tab-integra"
            >
              No Integra · {resultados.length}
            </button>
            <button
              onClick={() => trocarAba("novos")}
              className={`flex-1 text-sm font-semibold py-2 rounded-lg transition ${aba === "novos" ? "bg-white dark:bg-gray-950 shadow text-amber-700 dark:text-amber-300" : "text-gray-600 dark:text-gray-300"}`}
              data-testid="tab-novos"
            >
              Novos pontos{novosFase === "pronto" ? ` · ${novos.length}` : ""}
            </button>
          </div>
        )}

        {/* ======== ABA: NO INTEGRA ======== */}
        {fase === "pronto" && aba === "integra" && (
          <>
            {resultados.length === 0 ? (
              <Card className="border-l-4 border-l-slate-400">
                <CardContent className="py-8 text-center text-sm space-y-2">
                  <HelpCircle className="h-10 w-10 mx-auto text-slate-400" />
                  <p className="font-medium">Nenhum cadastro em até {raioUsado} m</p>
                  <p className="text-muted-foreground">Este ponto não parece estar no Integra. Veja a aba <strong>Novos pontos</strong> ou amplie o raio.</p>
                  <div className="flex gap-2 justify-center pt-2">
                    {raioUsado < 300 && <Button variant="outline" size="sm" onClick={() => ampliar(300)}>Ampliar para 300 m</Button>}
                    {raioUsado < 500 && raioUsado >= 300 && <Button variant="outline" size="sm" onClick={() => ampliar(500)}>Ampliar para 500 m</Button>}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">{resultados.length} cadastro{resultados.length > 1 ? "s" : ""} em até {raioUsado} m · do mais próximo</p>
                {resultados.map((r) => {
                  const est = estiloCenario(r);
                  return (
                    <Card key={`${r.tipo}-${r.id}`} className={`border-l-4 ${est.barra}`} data-testid={`card-resultado-${r.tipo}`}>
                      <CardContent className="py-4 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 min-w-0">
                            <div className="shrink-0 mt-0.5">{est.icone}</div>
                            <div className="min-w-0">
                              <div className="font-semibold leading-tight break-words">{r.nome}</div>
                              <span className={`inline-block mt-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${est.tag}`}>{r.statusLabel}</span>
                            </div>
                          </div>
                          <Badge variant="secondary" className="shrink-0 whitespace-nowrap">{r.distancia} m</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-1 pl-7">
                          <div className="flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5" />
                            <span>{r.responsavelLabel}: <span className="text-foreground font-medium">{r.responsavel || "não atribuído"}</span></span>
                          </div>
                          {(r.bairro || r.cidade) && (
                            <div className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /><span>{[r.bairro, r.cidade].filter(Boolean).join(" · ")}</span></div>
                          )}
                          {r.telefone && (
                            <a href={`tel:${r.telefone}`} className="flex items-center gap-1.5 text-blue-600 hover:underline w-fit"><Phone className="h-3.5 w-3.5" /><span>{r.telefone}{r.contato ? ` · ${r.contato}` : ""}</span></a>
                          )}
                        </div>
                        <div className="pl-7 pt-1">
                          <a href={`https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`} target="_blank" rel="noreferrer" className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"><Navigation className="h-3.5 w-3.5" /> Ver no mapa</a>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                {raioUsado < 500 && (
                  <div className="flex justify-center pt-1">
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => ampliar(raioUsado < 300 ? 300 : 500)}>Ampliar busca para {raioUsado < 300 ? 300 : 500} m</Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ======== ABA: NOVOS PONTOS (radar) ======== */}
        {fase === "pronto" && aba === "novos" && (
          <div className="space-y-3">
            {novosFase === "buscando" && (
              <Card><CardContent className="py-8 text-center text-sm text-muted-foreground"><Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" /> Buscando estabelecimentos por perto…</CardContent></Card>
            )}
            {novosFase === "disabled" && (
              <Card className="border-l-4 border-l-slate-400"><CardContent className="py-6 text-sm text-center text-muted-foreground"><Ban className="h-8 w-8 mx-auto mb-2 text-slate-400" />{novosMsg}</CardContent></Card>
            )}
            {novosFase === "erro" && (
              <Card className="border-l-4 border-l-red-500"><CardContent className="py-5 text-sm space-y-3"><div className="flex items-start gap-2 text-red-600 dark:text-red-400"><XCircle className="h-5 w-5 shrink-0 mt-0.5" /><span>{novosMsg}</span></div><Button variant="outline" size="sm" onClick={buscarNovos} className="w-full"><RefreshCw className="h-4 w-4 mr-2" /> Tentar de novo</Button></CardContent></Card>
            )}
            {novosFase === "pronto" && novos.length === 0 && (
              <Card className="border-l-4 border-l-slate-400"><CardContent className="py-8 text-center text-sm space-y-1"><HelpCircle className="h-10 w-10 mx-auto text-slate-400" /><p className="font-medium">Nenhum ponto novo em {raioUsado} m</p><p className="text-muted-foreground">Tudo por perto já está no Integra, ou não há estabelecimentos dos segmentos buscados.</p></CardContent></Card>
            )}
            {novosFase === "pronto" && novos.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">{novos.length} estabelecimento{novos.length > 1 ? "s" : ""} ainda não cadastrado{novos.length > 1 ? "s" : ""}</p>
                {novos.map((p) => {
                  const st = cadastrados[p.placeId];
                  return (
                    <Card key={p.placeId || p.nome} className="border-l-4 border-l-amber-500" data-testid="card-novo-ponto">
                      <CardContent className="py-4 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 min-w-0">
                            <MapPin className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <div className="font-semibold leading-tight break-words">{p.nome}</div>
                              <div className="mt-1 flex items-center gap-2 flex-wrap">
                                {p.categoria && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{p.categoria}</span>}
                                <span className="text-[9px] font-bold tracking-wide text-white bg-amber-500 px-1.5 py-0.5 rounded-full">NOVO</span>
                              </div>
                            </div>
                          </div>
                          {p.distancia != null && <Badge variant="secondary" className="shrink-0 whitespace-nowrap">{p.distancia} m</Badge>}
                        </div>
                        {p.endereco && <div className="text-xs text-muted-foreground pl-7 flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{p.endereco}</div>}
                        <div className="pl-7 pt-1 flex items-center gap-3">
                          {st === "ok" ? (
                            <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> Cadastrado como lead</span>
                          ) : (
                            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={st === "loading"} onClick={() => cadastrarLead(p)} data-testid="button-cadastrar-lead">
                              {st === "loading" ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Cadastrando…</> : <><Plus className="h-4 w-4 mr-1.5" /> Cadastrar como lead</>}
                            </Button>
                          )}
                          <a href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"><Navigation className="h-3.5 w-3.5" /> Mapa</a>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                <p className="text-[11px] text-center text-muted-foreground pt-1">Pontos do Google Places que ainda não estão no Integra. Nome e local são aproximados — edite depois se precisar.</p>
              </>
            )}
          </div>
        )}

        {/* Legenda (só na aba Integra) */}
        {(fase === "idle" || (fase === "pronto" && aba === "integra")) && (
          <div className="pt-2 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Cliente ativo</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-400" /> Cliente inativado</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-blue-500" /> Lead em prospecção</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Lead sem atendente</span>
          </div>
        )}
      </div>
    </div>
  );
}
