// ============================================================================
// ROTEIRIZAÇÃO COM IA — a partir do Pipeline de Faturamento
// ----------------------------------------------------------------------------
// Fluxo: seleciona os cards em "Aguardando Rota / Ag. Rota BSB / Impresso" no
// Kanban → marca os motoristas/veículos disponíveis do dia (cadastro existente
// delivery_drivers) → o agente de IA distribui os pedidos → o algoritmo otimiza
// a sequência (2-opt + OSRM) → o operador confere e salva.
//
// As rotas salvas usam os MESMOS endpoints/tabelas da tela Gestão de Entregas
// (delivery_routes / delivery_route_stops), então aparecem normalmente em
// Rotas de Entrega, Execução de Rota e no app do motorista.
// ============================================================================

import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import MissingCoordinatesModal from "@/components/MissingCoordinatesModal";
import {
  Truck, Bot, Loader2, MapPin, Clock, AlertTriangle, CheckCircle2,
  Wand2, ArrowLeft, Save, Users, Gauge, Info, Map as MapIcon, Eye, EyeOff,
  Printer, FileText,
} from "lucide-react";
import { imprimirFolhasDeRosto, imprimirRotasCompleto, rotaDoPlano } from "@/lib/route-print";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Mesmas bases usadas pela tela Gestão de Entregas
const START_LOCATIONS = [
  { id: 'honest-goiania', name: 'HONEST GOIANIA', latitude: -16.719458733340122, longitude: -49.29937095026935 },
  { id: 'baruc-bsb', name: 'BARUC BSB', latitude: -16.049611084920134, longitude: -47.997992569313645 },
];

const VEHICLE_TYPES = [
  { value: 'moto', label: '🏍️ Moto' },
  { value: 'carro', label: '🚗 Carro' },
  { value: 'caminhao', label: '🚚 Caminhão' },
  { value: 'baruc', label: '🛻 BARUC (Brasília)' },
];

// Paleta categórica segura para daltonismo (Okabe-Ito, sem o amarelo — ilegível
// sobre as telhas claras do OpenStreetMap). Uma cor por motorista.
const ROTA_CORES = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#56B4E9', '#6A3D9A', '#A6761D', '#333333'];

const coordDe = (o: any, latKeys: string[], lngKeys: string[]): [number, number] | null => {
  const pick = (keys: string[]) => {
    for (const k of keys) {
      const v = parseFloat(o?.[k]);
      if (Number.isFinite(v) && v !== 0) return v;
    }
    return NaN;
  };
  const lat = pick(latKeys);
  const lng = pick(lngKeys);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
};

/** Enquadra o mapa em todos os pontos plotados. */
function AjustarZoom({ pontos }: { pontos: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    // Dentro de um Dialog o container só ganha altura depois da animação de
    // abertura; sem o invalidateSize o Leaflet renderiza faixas cinzas.
    const enquadrar = () => {
      map.invalidateSize();
      if (!pontos.length) return;
      if (pontos.length === 1) { map.setView(pontos[0], 14); return; }
      map.fitBounds(L.latLngBounds(pontos), { padding: [28, 28], maxZoom: 15 });
    };
    enquadrar();
    const t1 = setTimeout(enquadrar, 250);
    const t2 = setTimeout(enquadrar, 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [map, JSON.stringify(pontos)]);
  return null;
}

const pino = (cor: string, texto: string, tamanho = 28) => L.divIcon({
  html: `<div style="background:${cor};width:${tamanho}px;height:${tamanho}px;border-radius:50%;border:3px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${tamanho > 30 ? 13 : 11}px;box-shadow:0 2px 5px rgba(0,0,0,.4)">${texto}</div>`,
  className: '',
  iconSize: [tamanho, tamanho],
  iconAnchor: [tamanho / 2, tamanho / 2],
});

/**
 * Plota as rotas propostas: uma cor por motorista, base marcada com "S",
 * paradas numeradas na ordem de visita e a linha ligando base → paradas → base.
 */
function MapaRotas({ rotas, altura = 380 }: { rotas: Array<{ rota: any; cor: string }>; altura?: number }) {
  const pontos: Array<[number, number]> = [];
  for (const { rota } of rotas) {
    const base = coordDe(rota, ['startLatitude'], ['startLongitude']);
    if (base) pontos.push(base);
    for (const s of (rota.stops || [])) {
      const c = coordDe(s, ['latitude', 'customerLatitude'], ['longitude', 'customerLongitude']);
      if (c) pontos.push(c);
    }
  }
  if (!pontos.length) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground border rounded-lg" style={{ height: altura }}>
        Sem coordenadas para plotar.
      </div>
    );
  }
  const centro = pontos[0];

  return (
    <div className="border rounded-lg overflow-hidden" style={{ height: altura }}>
      <MapContainer center={centro} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <AjustarZoom pontos={pontos} />
        {rotas.map(({ rota, cor }, ri) => {
          const base = coordDe(rota, ['startLatitude'], ['startLongitude']);
          const paradas = (rota.stops || [])
            .map((s: any) => ({ s, c: coordDe(s, ['latitude', 'customerLatitude'], ['longitude', 'customerLongitude']) }))
            .filter((x: any) => x.c);
          const linha: Array<[number, number]> = [
            ...(base ? [base] : []),
            ...paradas.map((x: any) => x.c as [number, number]),
            ...(base ? [base] : []),
          ];
          return (
            <Fragment key={ri}>
              {base && (
                <Marker position={base} icon={pino(cor, 'S', 32)}>
                  <Popup><strong>Saída / retorno</strong><br />{rota.driverName || 'Motorista'}<br />{rota.startAddress}</Popup>
                </Marker>
              )}
              {paradas.map((x: any, i: number) => (
                <Marker key={i} position={x.c} icon={pino(cor, String(x.s.stopOrder ?? i + 1))}>
                  <Popup>
                    <strong>{x.s.stopOrder ?? i + 1}. {x.s.customerName}</strong><br />
                    <span style={{ color: cor, fontWeight: 600 }}>{rota.driverName} · {rota.vehicleType}</span><br />
                    {x.s.customerAddress}<br />
                    <span style={{ fontSize: 11, color: '#666' }}>
                      Chegada {x.s.estimatedArrival} · +{Number(x.s.distanceFromPrevious || 0).toFixed(1)} km
                    </span>
                  </Popup>
                </Marker>
              ))}
              {linha.length > 1 && <Polyline positions={linha} color={cor} weight={3} opacity={0.75} />}
            </Fragment>
          );
        })}
      </MapContainer>
    </div>
  );
}

interface FleetDriver {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  vehicleType: string;
  licensePlate?: string | null;
  homeLatitude?: string | null;
  homeLongitude?: string | null;
  routesToday: number;
}

interface VehicleForm {
  driverId: string;
  driverName: string;
  type: string;
  licensePlate?: string;
  capacity: string; // texto no form; vira number no envio
  timeWindowStart: string;
  timeWindowEnd: string;
  startLocationId: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** ids de billing_pipeline dos cards selecionados no Kanban */
  orderIds: string[];
  onSaved?: () => void;
}

function todayISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export default function RoutePlannerDialog({ open, onOpenChange, orderIds, onSaved }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState<'frota' | 'resultado'>('frota');
  const [routeDate, setRouteDate] = useState<string>(todayISO());
  const [vehicles, setVehicles] = useState<Record<string, VehicleForm>>({});
  const [respectWeekdays, setRespectWeekdays] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const [selectedRoutes, setSelectedRoutes] = useState<Set<number>>(new Set());
  const [missingCoords, setMissingCoords] = useState<any[] | null>(null);
  // Mapa: quais rotas estão visíveis no panorama e quais têm mapa individual aberto
  const [rotasNoMapa, setRotasNoMapa] = useState<Set<number>>(new Set());
  const [mapaDaRota, setMapaDaRota] = useState<Record<number, boolean>>({});
  // Salvamento: o pop-up NÃO se fecha sozinho — fica aberto para a impressão.
  const [savedInfo, setSavedInfo] = useState<{ rotas: number } | null>(null);
  const [imprimindo, setImprimindo] = useState<null | 'completo' | 'rosto'>(null);

  const { data: fleet, isLoading: loadingFleet } = useQuery<{ drivers: FleetDriver[]; hasAiKey: boolean }>({
    queryKey: ['/api/delivery-routes/fleet', routeDate],
    queryFn: () => apiRequest('GET', `/api/delivery-routes/fleet?date=${routeDate}`),
    enabled: open,
    staleTime: 0,
  });

  const drivers = fleet?.drivers || [];

  // Reset ao fechar
  useEffect(() => {
    if (!open) {
      setStep('frota');
      setPlan(null);
      setSelectedRoutes(new Set());
      setMissingCoords(null);
      setRotasNoMapa(new Set());
      setMapaDaRota({});
      setSavedInfo(null);
      setImprimindo(null);
    }
  }, [open]);

  // Fechar o pop-up é o momento de devolver o controle ao Kanban: só aí a seleção
  // é limpa (se limpássemos no salvamento, o pop-up ficaria aberto com "0 pedidos").
  const fecharDialog = (v: boolean) => {
    if (!v && savedInfo) onSaved?.();
    onOpenChange(v);
  };

  const toggleDriver = (d: FleetDriver, on: boolean) => {
    setVehicles(prev => {
      const next = { ...prev };
      if (!on) {
        delete next[d.id];
        return next;
      }
      const tipo = (d.vehicleType || 'moto').toLowerCase();
      next[d.id] = {
        driverId: d.id,
        driverName: d.name,
        type: tipo,
        licensePlate: d.licensePlate || undefined,
        capacity: '',
        timeWindowStart: '08:00',
        timeWindowEnd: '18:00',
        startLocationId: tipo === 'baruc' ? 'baruc-bsb' : 'honest-goiania',
      };
      return next;
    });
  };

  const patchVehicle = (id: string, patch: Partial<VehicleForm>) => {
    setVehicles(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const selectedVehicles = useMemo(() => Object.values(vehicles), [vehicles]);

  const buildPayloadVehicles = () =>
    selectedVehicles.map(v => {
      const loc = START_LOCATIONS.find(l => l.id === v.startLocationId) || START_LOCATIONS[0];
      const cap = parseInt(v.capacity, 10);
      return {
        type: v.type,
        driverId: v.driverId,
        driverName: v.driverName,
        licensePlate: v.licensePlate,
        startLatitude: loc.latitude,
        startLongitude: loc.longitude,
        startAddress: loc.name,
        timeWindowStart: v.timeWindowStart,
        timeWindowEnd: v.timeWindowEnd,
        capacity: Number.isFinite(cap) && cap > 0 ? cap : undefined,
      };
    });

  const planMutation = useMutation({
    mutationFn: async () =>
      await apiRequest('POST', '/api/delivery-routes/plan', {
        orderIds,
        vehicles: buildPayloadVehicles(),
        routeDate,
        mode: 'ia',
        dryRun: true,
        respectReceivingWeekdays: respectWeekdays,
      }),
    onSuccess: (data: any) => {
      setPlan(data);
      setSelectedRoutes(new Set((data.routes || []).map((_: any, i: number) => i)));
      setRotasNoMapa(new Set((data.routes || []).map((_: any, i: number) => i)));
      setStep('resultado');
      toast({
        title: data?.ai?.modo === 'ia' ? 'Rotas montadas pela IA' : 'Rotas montadas pelo algoritmo',
        description: `${data.stats.assignedOrders} de ${data.stats.totalOrders} pedidos em ${data.routes.length} rota(s) · ${data.stats.totalDistance.toFixed(1)} km`,
      });
    },
    onError: (error: any) => {
      if (error?.status === 422 && error?.code === 'MISSING_COORDINATES') {
        setMissingCoords(error.missingCoordinates || []);
        return;
      }
      toast({ title: 'Erro ao montar as rotas', description: error?.message || 'Erro desconhecido', variant: 'destructive' });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const routes = (plan?.routes || [])
        .map((r: any, i: number) => ({ r, i }))
        .filter(({ i }: any) => selectedRoutes.has(i))
        .map(({ r }: any) => {
          const v = selectedVehicles.find(x => x.driverId === r.driverId);
          return {
            route: {
              routeDate,
              driverId: r.driverId,
              driverName: r.driverName,
              vehicleType: r.vehicleType,
              startLatitude: r.startLatitude,
              startLongitude: r.startLongitude,
              totalDistance: r.totalDistance,
              totalDuration: Math.round(r.totalDuration || 0),
              timeWindowStart: v?.timeWindowStart || '08:00',
              timeWindowEnd: v?.timeWindowEnd || '18:00',
            },
            stops: (r.stops || []).map((s: any) => ({
              ...s,
              billingId: s.salesCardId, // /api/deliveries e /plan devolvem ids de billing_pipeline
              latitude: s.latitude ?? s.customerLatitude,
              longitude: s.longitude ?? s.customerLongitude,
            })),
          };
        });
      return await apiRequest('POST', '/api/delivery-routes/save', { routes });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      // ⚠️ NÃO fecha o pop-up: o operador ainda precisa imprimir os pedidos e as
      // folhas de rosto. O fechamento (e a limpeza da seleção) é sempre manual.
      setSavedInfo({ rotas: data?.routes?.length || 0 });
      toast({
        title: 'Rotas salvas e enviadas',
        description: `${data?.routes?.length || 0} rota(s) gravada(s). Os cards foram para "Em Rota". Imprima os pedidos aqui ou depois, em Rotas de Entrega.`,
      });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao salvar as rotas', description: error?.message || 'Erro desconhecido', variant: 'destructive' });
    },
  });

  // ── Impressão (mesmo pacote do Pipeline de Faturamento + folha de rosto) ────
  // Imprime as rotas MARCADAS na lista abaixo, na ordem das paradas.
  const rotasParaImprimir = () =>
    (plan?.routes || [])
      .map((r: any, i: number) => ({ r, i }))
      .filter(({ i }: any) => selectedRoutes.has(i))
      .map(({ r }: any) => {
        const v = selectedVehicles.find(x => x.driverId === r.driverId);
        return rotaDoPlano(r, routeDate, { inicio: v?.timeWindowStart, fim: v?.timeWindowEnd });
      });

  const handleImprimirCompleto = async () => {
    const rotas = rotasParaImprimir();
    if (!rotas.length) { toast({ title: 'Marque ao menos uma rota', variant: 'destructive' }); return; }
    setImprimindo('completo');
    try {
      const r = await imprimirRotasCompleto(rotas);
      toast({ title: `${r.pedidos} pedido(s) impresso(s)`, description: `${r.rotas} folha(s) de rosto + pedido, DANFE e cobrança de cada entrega.` });
    } catch (e: any) {
      toast({ title: 'Erro ao imprimir', description: e?.message || 'Erro desconhecido', variant: 'destructive' });
    } finally { setImprimindo(null); }
  };

  const handleImprimirRosto = async () => {
    const rotas = rotasParaImprimir();
    if (!rotas.length) { toast({ title: 'Marque ao menos uma rota', variant: 'destructive' }); return; }
    setImprimindo('rosto');
    try {
      const n = await imprimirFolhasDeRosto(rotas);
      toast({ title: `${n} folha(s) de rosto gerada(s)` });
    } catch (e: any) {
      toast({ title: 'Erro ao imprimir', description: e?.message || 'Erro desconhecido', variant: 'destructive' });
    } finally { setImprimindo(null); }
  };

  const ai = plan?.ai;
  const podeGerar = orderIds.length > 0 && selectedVehicles.length > 0 && selectedVehicles.every(v => !!v.driverId);

  return (
    <>
      <Dialog open={open} onOpenChange={fecharDialog}>
        <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-purple-600" />
              Roteirização com IA
              <Badge variant="outline" className="ml-2">{orderIds.length} pedido(s)</Badge>
            </DialogTitle>
            <DialogDescription>
              {step === 'frota'
                ? 'Marque os motoristas e veículos disponíveis para hoje. O agente distribui os pedidos e o algoritmo otimiza a sequência.'
                : 'Confira a proposta antes de salvar. Ao salvar, as rotas vão para os motoristas e os cards avançam para "Em Rota".'}
            </DialogDescription>
          </DialogHeader>

          {/* ================= ETAPA 1 — FROTA ================= */}
          {step === 'frota' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <Label className="text-xs">Data da rota</Label>
                  <Input type="date" value={routeDate} onChange={e => setRouteDate(e.target.value)} className="h-9 w-44" />
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 pb-2">
                  <Checkbox checked={respectWeekdays} onCheckedChange={v => setRespectWeekdays(!!v)} />
                  Excluir clientes que não recebem neste dia
                </label>
                {fleet && !fleet.hasAiKey && (
                  <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    ANTHROPIC_API_KEY não configurada — a distribuição sairá pelo algoritmo.
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Users className="h-4 w-4 text-gray-500" />
                  <span className="text-sm font-semibold">Motoristas / veículos disponíveis</span>
                  <Badge variant="outline" className="text-xs">{selectedVehicles.length} selecionado(s)</Badge>
                </div>

                {loadingFleet ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-6">
                    <Loader2 className="h-4 w-4 animate-spin" /> Carregando frota…
                  </div>
                ) : drivers.length === 0 ? (
                  <div className="text-sm text-gray-500 py-6">
                    Nenhum motorista ativo no cadastro. Cadastre em Logística → Motoristas.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {drivers.map(d => {
                      const v = vehicles[d.id];
                      return (
                        <Card key={d.id} className={v ? 'border-purple-300 bg-purple-50/40 dark:bg-purple-900/10' : ''}>
                          <CardContent className="p-3">
                            <div className="flex items-center gap-3 flex-wrap">
                              <Checkbox checked={!!v} onCheckedChange={on => toggleDriver(d, !!on)} />
                              <div className="min-w-[190px]">
                                <div className="font-medium text-sm">{d.name}</div>
                                <div className="text-xs text-gray-500">
                                  {(d.vehicleType || '—')}{d.licensePlate ? ` · ${d.licensePlate}` : ''}
                                </div>
                              </div>
                              {d.routesToday > 0 && (
                                <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                                  já tem {d.routesToday} rota(s) nesta data
                                </Badge>
                              )}

                              {v && (
                                <div className="flex items-end gap-2 flex-wrap ml-auto">
                                  <div>
                                    <Label className="text-[10px]">Veículo</Label>
                                    <Select value={v.type} onValueChange={val => patchVehicle(d.id, { type: val, startLocationId: val === 'baruc' ? 'baruc-bsb' : v.startLocationId })}>
                                      <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        {VEHICLE_TYPES.map(t => <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>)}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div>
                                    <Label className="text-[10px]">Capac.</Label>
                                    <Input type="number" min={1} placeholder="—" value={v.capacity}
                                      onChange={e => patchVehicle(d.id, { capacity: e.target.value })}
                                      className="h-8 w-[70px] text-xs" />
                                  </div>
                                  <div>
                                    <Label className="text-[10px]">Início</Label>
                                    <Input type="time" value={v.timeWindowStart}
                                      onChange={e => patchVehicle(d.id, { timeWindowStart: e.target.value })}
                                      className="h-8 w-[100px] text-xs" />
                                  </div>
                                  <div>
                                    <Label className="text-[10px]">Fim</Label>
                                    <Input type="time" value={v.timeWindowEnd}
                                      onChange={e => patchVehicle(d.id, { timeWindowEnd: e.target.value })}
                                      className="h-8 w-[100px] text-xs" />
                                  </div>
                                  <div>
                                    <Label className="text-[10px]">Base</Label>
                                    <Select value={v.startLocationId} onValueChange={val => patchVehicle(d.id, { startLocationId: val })}>
                                      <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        {START_LOCATIONS.map(l => <SelectItem key={l.id} value={l.id} className="text-xs">{l.name}</SelectItem>)}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button variant="outline" onClick={() => fecharDialog(false)}>Cancelar</Button>
                <Button
                  className="bg-purple-600 hover:bg-purple-700 text-white"
                  disabled={!podeGerar || planMutation.isPending}
                  onClick={() => planMutation.mutate()}
                >
                  {planMutation.isPending
                    ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Montando rotas…</>
                    : <><Wand2 className="h-4 w-4 mr-2" /> Gerar rotas com IA</>}
                </Button>
              </div>
            </div>
          )}

          {/* ================= ETAPA 2 — RESULTADO ================= */}
          {step === 'resultado' && plan && (
            <div className="space-y-4">
              {/* Cabeçalho da IA */}
              <Card className="border-purple-200 bg-purple-50/60 dark:bg-purple-900/10">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-purple-600" />
                    <span className="text-sm font-semibold">
                      {ai?.modo === 'ia' ? `Distribuição pelo agente (${ai?.modelo || 'claude'})` : 'Distribuição pelo algoritmo'}
                    </span>
                    {ai?.duracaoMs != null && <Badge variant="outline" className="text-[10px]">{(ai.duracaoMs / 1000).toFixed(1)}s</Badge>}
                    {ai?.tokens && <Badge variant="outline" className="text-[10px]">{ai.tokens.input}→{ai.tokens.output} tokens</Badge>}
                  </div>
                  {ai?.resumo && <p className="text-sm text-gray-700 dark:text-gray-300">{ai.resumo}</p>}
                  {ai?.motivoFallback && (
                    <p className="text-xs text-amber-700 flex items-start gap-1"><Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />{ai.motivoFallback}</p>
                  )}
                  {!!ai?.justificativas?.length && (
                    <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5 pt-1">
                      {ai.justificativas.map((j: any, i: number) => <li key={i}><b>{j.veiculo}:</b> {j.texto}</li>)}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {/* Estatísticas */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {[
                  { label: 'Pedidos', value: plan.stats.totalOrders },
                  { label: 'Atribuídos', value: plan.stats.assignedOrders },
                  { label: 'Sem rota', value: plan.stats.unassignedOrders },
                  { label: 'Distância', value: `${plan.stats.totalDistance.toFixed(1)} km` },
                ].map((s, i) => (
                  <Card key={i}><CardContent className="p-3">
                    <div className="text-[11px] text-gray-500">{s.label}</div>
                    <div className="text-lg font-bold">{s.value}</div>
                  </CardContent></Card>
                ))}
              </div>

              {/* Mapa das rotas propostas */}
              {!!plan.routes?.length && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <MapIcon className="h-4 w-4 text-gray-500" />
                    <span className="text-sm font-semibold">Mapa das rotas propostas</span>
                    <span className="text-[11px] text-muted-foreground">clique num motorista para isolar a rota dele</span>
                    <div className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" className="h-6 text-[11px]"
                        onClick={() => setRotasNoMapa(new Set(plan.routes.map((_: any, i: number) => i)))}>
                        <Eye className="h-3 w-3 mr-1" />Todos
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[11px]"
                        onClick={() => setRotasNoMapa(new Set())}>
                        <EyeOff className="h-3 w-3 mr-1" />Nenhum
                      </Button>
                    </div>
                  </div>

                  {/* Legenda: uma cor por motorista, clicável */}
                  <div className="flex flex-wrap gap-1.5">
                    {plan.routes.map((r: any, i: number) => {
                      const cor = ROTA_CORES[i % ROTA_CORES.length];
                      const ativo = rotasNoMapa.has(i);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setRotasNoMapa(prev => {
                            const n = new Set(prev);
                            if (n.has(i)) n.delete(i); else n.add(i);
                            return n;
                          })}
                          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition ${ativo ? 'border-gray-400 bg-white dark:bg-gray-800' : 'border-dashed border-gray-300 opacity-50'}`}
                          title={ativo ? 'Ocultar do mapa' : 'Mostrar no mapa'}
                        >
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: cor }} />
                          <span className="font-medium">{r.driverName || `Rota ${i + 1}`}</span>
                          <span className="text-muted-foreground">{r.stops?.length || 0} paradas · {Number(r.totalDistance || 0).toFixed(0)} km</span>
                        </button>
                      );
                    })}
                  </div>

                  <MapaRotas
                    altura={400}
                    rotas={plan.routes
                      .map((r: any, i: number) => ({ rota: r, cor: ROTA_CORES[i % ROTA_CORES.length], i }))
                      .filter((x: any) => rotasNoMapa.has(x.i))}
                  />
                </div>
              )}

              {/* Ocupação por veículo — a métrica é QUANTIDADE (entregas/cota).
                  Não há balanceamento de carga: minutos são só viabilidade da jornada. */}
              {!!ai?.cargaPorVeiculo?.length && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Gauge className="h-4 w-4 text-gray-500" />Paradas por veículo
                    <span className="font-normal text-[11px] text-gray-400">(cota de quantidade — sem equilíbrio de carga)</span>
                  </div>
                  {ai.cargaPorVeiculo.filter((c: any) => c.entregas > 0).map((c: any, i: number) => {
                    const cota = c.cota ?? c.entregas;
                    const pct = cota > 0 ? (c.entregas / cota) * 100 : 0;
                    return (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="w-52 truncate">{c.motorista || c.veiculo}</span>
                        <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                          <div className={`h-full ${pct > 100 ? 'bg-red-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                        <span className="w-52 text-right text-gray-500">
                          {c.entregas}/{cota} paradas{c.cotaCadastrada ? ' (cap.)' : ''} · {c.minutosEstimados}/{c.minutosDisponiveis} min
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Vizinhos que ficaram em rotas diferentes — com o motivo */}
              {!!ai?.vizinhosSeparados?.length && (
                <Card className="border-orange-200 bg-orange-50/60 dark:bg-orange-900/10"><CardContent className="p-3">
                  <div className="text-xs font-semibold mb-1 flex items-center gap-1">
                    <Users className="h-3.5 w-3.5 text-orange-600" />
                    Clientes próximos em rotas diferentes — por quê
                  </div>
                  <ul className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
                    {ai.vizinhosSeparados.map((v: any, i: number) => (
                      <li key={i} className="leading-snug">
                        <b>{v.a}</b> ({v.veiculoA}) e <b>{v.b}</b> ({v.veiculoB}) estão a{' '}
                        <b>{v.distanciaKm.toFixed(2)} km</b> um do outro — {v.motivo}
                      </li>
                    ))}
                  </ul>
                </CardContent></Card>
              )}

              {/* Ajustes e alertas */}
              {!!ai?.ajustes?.length && (
                <Card className="border-blue-200 bg-blue-50/60 dark:bg-blue-900/10"><CardContent className="p-3">
                  <div className="text-xs font-semibold mb-1 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-blue-600" />Correções aplicadas sobre a proposta da IA</div>
                  <ul className="text-xs text-gray-700 dark:text-gray-300 list-disc pl-5 space-y-0.5">
                    {ai.ajustes.map((a: string, i: number) => <li key={i}>{a}</li>)}
                  </ul>
                </CardContent></Card>
              )}
              {!!ai?.alertas?.length && (
                <Card className="border-amber-200 bg-amber-50/60 dark:bg-amber-900/10"><CardContent className="p-3">
                  <div className="text-xs font-semibold mb-1 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 text-amber-600" />Atenção</div>
                  <ul className="text-xs text-gray-700 dark:text-gray-300 list-disc pl-5 space-y-0.5">
                    {ai.alertas.map((a: string, i: number) => <li key={i}>{a}</li>)}
                  </ul>
                </CardContent></Card>
              )}

              {/* Rotas */}
              <div className="space-y-3">
                {(plan.routes || []).map((r: any, idx: number) => (
                  <Card key={idx} className={selectedRoutes.has(idx) ? 'border-emerald-300' : 'opacity-60'}>
                    <CardContent className="p-3">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <Checkbox
                          checked={selectedRoutes.has(idx)}
                          onCheckedChange={on => setSelectedRoutes(prev => {
                            const n = new Set(prev);
                            if (on) n.add(idx); else n.delete(idx);
                            return n;
                          })}
                        />
                        <span className="inline-block h-3 w-3 rounded-full shrink-0" style={{ background: ROTA_CORES[idx % ROTA_CORES.length] }} title="Cor desta rota no mapa" />
                        <Truck className="h-4 w-4 text-indigo-600" />
                        <span className="font-semibold text-sm">{r.driverName || 'Sem motorista'}</span>
                        <Badge variant="outline" className="text-[10px]">{r.vehicleType}</Badge>
                        <Badge variant="outline" className="text-[10px]">{r.stops?.length || 0} paradas</Badge>
                        <Badge variant="outline" className="text-[10px]">{Number(r.totalDistance || 0).toFixed(1)} km</Badge>
                        <Badge variant="outline" className="text-[10px]">{Math.round(r.totalDuration || 0)} min</Badge>
                        <span className="text-[11px] text-gray-500 flex items-center gap-1 ml-auto">
                          <MapPin className="h-3 w-3" />{r.startAddress}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px]"
                          onClick={() => setMapaDaRota(prev => ({ ...prev, [idx]: !prev[idx] }))}
                        >
                          <MapIcon className="h-3 w-3 mr-1" />
                          {mapaDaRota[idx] ? 'Ocultar mapa' : 'Ver no mapa'}
                        </Button>
                      </div>
                      {mapaDaRota[idx] && (
                        <div className="mb-2">
                          <MapaRotas altura={280} rotas={[{ rota: r, cor: ROTA_CORES[idx % ROTA_CORES.length] }]} />
                        </div>
                      )}
                      <div className="divide-y">
                        {(r.stops || []).map((s: any, si: number) => (
                          <div key={si} className="py-1.5 flex items-center gap-2 text-xs">
                            <span className={`w-6 h-6 rounded-full text-white flex items-center justify-center font-bold shrink-0 ${s.isUrgent ? 'bg-amber-500' : 'bg-emerald-600'}`}>{si + 1}</span>
                            <span className="flex-1 truncate font-medium flex items-center gap-1">
                              {s.isUrgent && <span title="Entrega prioritária" className="text-amber-500">★</span>}
                              {s.customerName}
                            </span>
                            <span className="hidden md:block flex-1 truncate text-gray-500">{s.customerAddress}</span>
                            <span className="text-gray-500 flex items-center gap-1"><Clock className="h-3 w-3" />{s.estimatedArrival}</span>
                            <span className="w-16 text-right text-gray-400">+{Number(s.distanceFromPrevious || 0).toFixed(1)} km</span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Não atribuídos */}
              {!!plan.unassignedOrders?.length && (
                <Card className="border-red-200 bg-red-50/60 dark:bg-red-900/10"><CardContent className="p-3">
                  <div className="text-xs font-semibold mb-1 text-red-700">
                    {plan.unassignedOrders.length} pedido(s) sem rota — continuam em "Aguardando Rota"
                  </div>
                  <div className="text-xs text-gray-700 dark:text-gray-300 space-y-0.5">
                    {plan.unassignedOrders.map((o: any, i: number) => (
                      <div key={i}>• {o.customerName}</div>
                    ))}
                  </div>
                </CardContent></Card>
              )}

              {/* Confirmação do salvamento — o pop-up continua aberto de propósito */}
              {savedInfo && (
                <Card className="border-emerald-300 bg-emerald-50/70 dark:bg-emerald-900/10"><CardContent className="p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span className="font-semibold text-emerald-800 dark:text-emerald-300">
                      {savedInfo.rotas} rota(s) salva(s) e enviada(s) aos motoristas.
                    </span>
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      Imprima agora ou depois, na tela <b>Rotas de Entrega</b>.
                    </span>
                  </div>
                </CardContent></Card>
              )}

              <div className="flex justify-between gap-2 pt-2 border-t flex-wrap">
                <Button variant="outline" onClick={() => setStep('frota')}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Ajustar frota
                </Button>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    className="border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                    disabled={selectedRoutes.size === 0 || !!imprimindo}
                    onClick={handleImprimirRosto}
                    title="Uma folha de rosto por motorista, com as entregas e as distâncias ponto a ponto"
                  >
                    {imprimindo === 'rosto'
                      ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Gerando…</>
                      : <><FileText className="h-4 w-4 mr-2" /> Folha de rosto ({selectedRoutes.size})</>}
                  </Button>
                  <Button
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                    disabled={selectedRoutes.size === 0 || !!imprimindo}
                    onClick={handleImprimirCompleto}
                    title="Folha de rosto + pedido, DANFE e cobrança de cada entrega, na ordem da rota"
                  >
                    {imprimindo === 'completo'
                      ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Gerando…</>
                      : <><Printer className="h-4 w-4 mr-2" /> Imprimir Completo ({selectedRoutes.size})</>}
                  </Button>
                  <Button variant="outline" onClick={() => fecharDialog(false)}>
                    {savedInfo ? 'Fechar' : 'Fechar sem salvar'}
                  </Button>
                  <Button
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    disabled={selectedRoutes.size === 0 || saveMutation.isPending || !!savedInfo}
                    onClick={() => saveMutation.mutate()}
                  >
                    {saveMutation.isPending
                      ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Salvando…</>
                      : savedInfo
                        ? <><CheckCircle2 className="h-4 w-4 mr-2" /> Rotas salvas</>
                        : <><Save className="h-4 w-4 mr-2" /> Salvar e enviar ({selectedRoutes.size})</>}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Coordenadas faltantes: mesmo modal usado pela Gestão de Entregas */}
      {missingCoords && (
        <MissingCoordinatesModal
          isOpen={!!missingCoords}
          onClose={() => setMissingCoords(null)}
          missingCoordinates={missingCoords}
          onSuccess={() => {
            setMissingCoords(null);
            setTimeout(() => planMutation.mutate(), 500);
          }}
        />
      )}
    </>
  );
}
