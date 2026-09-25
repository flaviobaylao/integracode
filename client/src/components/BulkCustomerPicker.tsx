import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveSellers, MultiSelect, multiMatch } from "@/lib/tableTools";
import { cidadeCanonica } from "@/lib/cidadePadrao";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Search, Filter, X, Phone, Loader2, CheckCircle } from "lucide-react";

// ============================================================================
// BulkCustomerPicker — escolhe contatos do Disparo em Massa direto da base de
// Clientes Ativos, com OS MESMOS filtros da tela de Clientes Ativos e mostrando
// APENAS clientes cujo telefone foi CONFIRMADO pelo próprio cliente (ou isento
// por admin — o que o sistema trata como confirmado). Não usa planilha.
// ============================================================================

export interface PickedContact {
  phone: string; // apenas dígitos
  name: string;
  valid: boolean;
  customerId?: string;
}

// Mesma função robusta de parse de dias usada em Clientes Ativos.
const VALID_WEEKDAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"];
function parseWeekdaysArray(input: any): string[] {
  if (!input) return [];
  let values: string[] = [];
  if (Array.isArray(input)) {
    values = input.map((v) => String(v || "").trim()).filter((v) => v);
  } else {
    const str = String(input || "").trim();
    if (!str) return [];
    if (str.startsWith("{") && str.endsWith("}")) {
      values = str.slice(1, -1).split(",").map((v) => v.trim().replace(/^"|"$/g, "")).filter((v) => v);
    } else if (str.startsWith("[") && str.endsWith("]") && str.includes('"')) {
      try {
        const parsed = JSON.parse(str);
        values = (Array.isArray(parsed) ? parsed : []).map((v) => String(v || "").trim()).filter((v) => v);
      } catch { values = []; }
    } else if (str.includes(",") || str.includes(";") || str.includes("/") || str.includes(" e ")) {
      values = str.split(/[,;/]|\s+e\s+/).map((v) => v.trim()).filter((v) => v);
    } else {
      values = [str];
    }
  }
  return values.filter((v) => VALID_WEEKDAYS.includes(v));
}

const SEMANA_OPCOES: [string, string][] = [
  ["toda", "Toda semana"], ["impar", "1ª e 3ª do mês"], ["par", "2ª e 4ª do mês"],
  ["1", "1ª do mês"], ["2", "2ª do mês"], ["3", "3ª do mês"], ["4", "4ª do mês"], ["ultima", "Última do mês"],
];
const SEM_SEGMENTO = "(Sem segmento)";

interface ActiveCustomer {
  id: string;
  document?: string;
  customer?: {
    id: string;
    name: string;
    fantasyName: string | null;
    phone: string;
    city?: string | null;
    neighborhood?: string | null;
    latitude?: string | null;
    longitude?: string | null;
    sellerId?: string;
    sellerName?: string;
    virtualService?: boolean;
    weekdays?: string;
    visitPeriodicity?: string;
    semanaAtendimento?: string;
    segmentoPrincipal?: string | null;
    customerType?: string;
    isPositivatedThisMonth?: boolean;
  };
}

type PhoneVerif = Record<string, { status: string; over24h?: boolean; exempt?: boolean }>;

// Telefone plausível (mesma regra do disparo por carteira do phoneVerification).
function telefoneValido(phone?: string | null): boolean {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length < 10 || d.length > 13) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  if ("01234567890123456789".includes(d) || "98765432109876543210".includes(d)) return false;
  if (d.includes("00000")) return false;
  return true;
}

function toContact(ac: ActiveCustomer): PickedContact {
  return {
    phone: String(ac.customer?.phone || "").replace(/\D/g, ""),
    name: ac.customer?.fantasyName || ac.customer?.name || "Cliente",
    valid: true,
    customerId: ac.customer?.id,
  };
}

export default function BulkCustomerPicker({
  value,
  onChange,
}: {
  value: PickedContact[];
  onChange: (contacts: PickedContact[]) => void;
}) {
  const { sellerOptions, resolveSeller } = useActiveSellers();

  const { data: activeCustomers = [], isLoading } = useQuery<ActiveCustomer[]>({
    queryKey: ["/api/active-customers"],
  });

  const { data: phoneVerif = {} } = useQuery<PhoneVerif>({
    queryKey: ["/api/customers/phone-verification-status"],
    queryFn: () =>
      fetch("/api/customers/phone-verification-status", { credentials: "include" }).then((r) => (r.ok ? r.json() : {})),
  });

  // Filtros (idênticos aos de Clientes Ativos)
  const [searchTerm, setSearchTerm] = useState("");
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [dayMulti, setDayMulti] = useState<string[]>([]);
  const [selectedVirtualType, setSelectedVirtualType] = useState<string>("");
  const [selectedPeriodicity, setSelectedPeriodicity] = useState<string>("");
  const [selectedSemana, setSelectedSemana] = useState<string>("");
  const [selectedPersonType, setSelectedPersonType] = useState<string>("");
  const [segmentMulti, setSegmentMulti] = useState<string[]>([]);
  const [selectedPositivation, setSelectedPositivation] = useState<string>("");
  const [selectedCoords, setSelectedCoords] = useState<string>("");
  const [cityMulti, setCityMulti] = useState<string[]>([]);
  const [neighborhoodMulti, setNeighborhoodMulti] = useState<string[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string>("");

  // BASE: só clientes com telefone CONFIRMADO pelo cliente e telefone plausível.
  const confirmados = useMemo(() => {
    return (activeCustomers || []).filter((ac) => {
      const id = ac.customer?.id;
      if (!id) return false;
      const pv = (phoneVerif as any)[id];
      if (!pv || pv.status !== "confirmed") return false;
      return telefoneValido(ac.customer?.phone);
    });
  }, [activeCustomers, phoneVerif]);

  // Opções derivadas (a partir da base confirmada)
  const cityLabelOf = (c?: string | null) => cidadeCanonica(c);
  const daysOfRoute = useMemo(
    () => Array.from(new Set(confirmados.filter((ac) => ac.customer?.weekdays).flatMap((ac) => parseWeekdaysArray(ac.customer?.weekdays)))).sort(),
    [confirmados],
  );
  const periodicities = useMemo(
    () => Array.from(new Set(confirmados.map((ac) => ac.customer?.visitPeriodicity).filter(Boolean) as string[])).sort(),
    [confirmados],
  );
  const cities = useMemo(
    () => Array.from(new Set(confirmados.map((ac) => cidadeCanonica(ac.customer?.city)).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR")),
    [confirmados],
  );
  const neighborhoods = useMemo(
    () => Array.from(new Set(confirmados
      .filter((ac) => cityMulti.length === 0 || cityMulti.includes(cityLabelOf(ac.customer?.city)))
      .map((ac) => ac.customer?.neighborhood?.trim())
      .filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b, "pt-BR")),
    [confirmados, cityMulti],
  );
  const segmentFilterOptions = useMemo(() => {
    const segs = Array.from(new Set(confirmados.map((ac) => ac.customer?.segmentoPrincipal).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    return [...segs, ...(confirmados.some((ac) => !ac.customer?.segmentoPrincipal) ? [SEM_SEGMENTO] : [])];
  }, [confirmados]);

  // Aplicação dos filtros (mesma lógica de Clientes Ativos)
  const filtered = useMemo(() => {
    const searchLower = searchTerm.toLowerCase();
    return confirmados.filter((ac) => {
      const name = ac.customer?.fantasyName || ac.customer?.name || "";
      const doc = ac.document || "";
      const matchesSearch = name.toLowerCase().includes(searchLower) || doc.includes(searchTerm);

      const custDays = ac.customer?.weekdays ? parseWeekdaysArray(ac.customer.weekdays) : [];
      const matchesDayOfRoute = dayMulti.length === 0 || custDays.some((d) => dayMulti.includes(d));

      const matchesPeriodicity = !selectedPeriodicity || ac.customer?.visitPeriodicity === selectedPeriodicity;
      const matchesSemana = !selectedSemana || String((ac.customer as any)?.semanaAtendimento || "toda") === selectedSemana;

      const matchesVirtualType = !selectedVirtualType ||
        (selectedVirtualType === "virtual" ? ac.customer?.virtualService === true : ac.customer?.virtualService === false);

      const matchesPositivation = !selectedPositivation ||
        (selectedPositivation === "sim" ? ac.customer?.isPositivatedThisMonth === true : ac.customer?.isPositivatedThisMonth === false);

      const phoneDigits = selectedPhone.replace(/\D/g, "");
      const customerPhone = (ac.customer?.phone || "").replace(/\D/g, "");
      const matchesPhone = !phoneDigits || customerPhone.includes(phoneDigits);

      const matchesCity = cityMulti.length === 0 || cityMulti.includes(cityLabelOf(ac.customer?.city));
      const matchesNeighborhood = multiMatch(neighborhoodMulti, ac.customer?.neighborhood?.trim() || "");

      const matchesSellerMulti = multiMatch(sellerMulti, resolveSeller(ac.customer?.sellerName || ac.customer?.sellerId));

      const ptDigits = (ac.document || "").replace(/\D/g, "");
      const personType = (ac.customer as any)?.customerType || (ptDigits.length === 14 ? "pessoa_juridica" : ptDigits.length === 11 ? "pessoa_fisica" : "");
      const matchesPersonType = !selectedPersonType || personType === selectedPersonType;

      const matchesSegment = multiMatch(segmentMulti, ac.customer?.segmentoPrincipal || SEM_SEGMENTO);

      const hasCoords = !!((ac.customer as any)?.latitude && (ac.customer as any)?.longitude);
      const matchesCoords = !selectedCoords || (selectedCoords === "com" ? hasCoords : !hasCoords);

      return matchesSearch && matchesSellerMulti && matchesDayOfRoute && matchesPeriodicity && matchesSemana &&
        matchesVirtualType && matchesPositivation && matchesPhone && matchesCity && matchesNeighborhood &&
        matchesPersonType && matchesSegment && matchesCoords;
    });
  }, [confirmados, searchTerm, dayMulti, selectedPeriodicity, selectedSemana, selectedVirtualType, selectedPositivation,
      selectedPhone, cityMulti, neighborhoodMulti, sellerMulti, selectedPersonType, segmentMulti, selectedCoords, resolveSeller]);

  // Seleção sincronizada com o value do pai (por telefone)
  const selectedPhones = useMemo(() => new Set(value.map((c) => c.phone)), [value]);

  const toggleOne = (ac: ActiveCustomer) => {
    const c = toContact(ac);
    if (!c.phone) return;
    if (selectedPhones.has(c.phone)) {
      onChange(value.filter((x) => x.phone !== c.phone));
    } else {
      onChange([...value, c]);
    }
  };

  const filteredContacts = useMemo(() => {
    const seen = new Set<string>();
    const out: PickedContact[] = [];
    for (const ac of filtered) {
      const c = toContact(ac);
      if (!c.phone || seen.has(c.phone)) continue;
      seen.add(c.phone);
      out.push(c);
    }
    return out;
  }, [filtered]);

  const allFilteredSelected = filteredContacts.length > 0 && filteredContacts.every((c) => selectedPhones.has(c.phone));

  const selectAllFiltered = () => {
    const map = new Map(value.map((c) => [c.phone, c]));
    for (const c of filteredContacts) if (!map.has(c.phone)) map.set(c.phone, c);
    onChange(Array.from(map.values()));
  };
  const clearFilteredSelection = () => {
    const inFiltered = new Set(filteredContacts.map((c) => c.phone));
    onChange(value.filter((c) => !inFiltered.has(c.phone)));
  };

  const limparFiltros = () => {
    setSearchTerm(""); setSellerMulti([]); setDayMulti([]); setSelectedVirtualType("");
    setSelectedPeriodicity(""); setSelectedSemana(""); setSelectedPersonType(""); setSegmentMulti([]);
    setSelectedPositivation(""); setSelectedCoords(""); setCityMulti([]); setNeighborhoodMulti([]); setSelectedPhone("");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando base de clientes...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Alert>
        Somente clientes com <strong>telefone confirmado pelo próprio cliente</strong> aparecem aqui
        ({confirmados.length} de {activeCustomers.length} clientes ativos). Use os filtros abaixo — são os mesmos de Clientes Ativos.
      </Alert>

      {/* Barra de filtros — mesma de Clientes Ativos */}
      <div className="flex flex-row items-center gap-1 flex-wrap">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-8 h-9 w-[200px]"
          />
          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <Filter className="h-4 w-4 text-muted-foreground" />

        <MultiSelect label="Vendedor" options={sellerOptions} selected={sellerMulti} onChange={setSellerMulti} testId="filter-seller-bulk" />
        <MultiSelect label="Dia" options={daysOfRoute} selected={dayMulti} onChange={setDayMulti} testId="filter-day-bulk" />

        <Select value={selectedVirtualType} onValueChange={setSelectedVirtualType}>
          <SelectTrigger className="w-[100px] h-9"><SelectValue placeholder="Tipo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="presencial">Presencial</SelectItem>
            <SelectItem value="virtual">Virtual</SelectItem>
          </SelectContent>
        </Select>

        <Select value={selectedPeriodicity} onValueChange={setSelectedPeriodicity}>
          <SelectTrigger className="w-[110px] h-9"><SelectValue placeholder="Período" /></SelectTrigger>
          <SelectContent>
            {periodicities.map((p) => (
              <SelectItem key={p} value={p}>{p === "semanal" ? "Semanal" : p === "quinzenal" ? "Quinzenal" : p === "mensal" ? "Mensal" : p}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={selectedSemana} onValueChange={setSelectedSemana}>
          <SelectTrigger className="w-[130px] h-9"><SelectValue placeholder="Semana do mês" /></SelectTrigger>
          <SelectContent>
            {SEMANA_OPCOES.map(([v, l]) => (<SelectItem key={v} value={v}>{l}</SelectItem>))}
          </SelectContent>
        </Select>

        <Select value={selectedPersonType} onValueChange={setSelectedPersonType}>
          <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="PJ / PF" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pessoa_juridica">Pessoa Jurídica</SelectItem>
            <SelectItem value="pessoa_fisica">Pessoa Física</SelectItem>
          </SelectContent>
        </Select>

        <MultiSelect label="Segmento" options={segmentFilterOptions} selected={segmentMulti} onChange={setSegmentMulti} testId="filter-segment-bulk" />

        <Select value={selectedPositivation} onValueChange={setSelectedPositivation}>
          <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="Positivação" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="sim">Positivado</SelectItem>
            <SelectItem value="nao">Não Positivado</SelectItem>
          </SelectContent>
        </Select>

        <Select value={selectedCoords} onValueChange={setSelectedCoords}>
          <SelectTrigger className="w-[140px] h-9"><SelectValue placeholder="Coordenadas" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="com">Com coordenada</SelectItem>
            <SelectItem value="sem">Sem coordenada</SelectItem>
          </SelectContent>
        </Select>

        <MultiSelect label="Cidade" options={cities} selected={cityMulti} onChange={(v) => { setCityMulti(v); setNeighborhoodMulti([]); }} testId="filter-city-bulk" />
        <MultiSelect label="Bairro" options={neighborhoods} selected={neighborhoodMulti} onChange={setNeighborhoodMulti} searchable testId="filter-neighborhood-bulk" />

        <div className="relative">
          <Phone className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Telefone" value={selectedPhone} onChange={(e) => setSelectedPhone(e.target.value)} className="w-[130px] h-9 pl-8" />
        </div>

        <Button variant="outline" size="sm" onClick={limparFiltros} className="h-9" title="Limpar filtros">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Ações de seleção */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-sm px-3 py-1">
          {filteredContacts.length} cliente{filteredContacts.length !== 1 ? "s" : ""} no filtro
        </Badge>
        <Badge className="bg-green-600 text-white text-sm px-3 py-1">
          {value.length} selecionado{value.length !== 1 ? "s" : ""}
        </Badge>
        <Button size="sm" variant="outline" className="h-8" onClick={allFilteredSelected ? clearFilteredSelection : selectAllFiltered} disabled={filteredContacts.length === 0}>
          {allFilteredSelected ? "Desmarcar filtrados" : "Selecionar todos os filtrados"}
        </Button>
        {value.length > 0 && (
          <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={() => onChange([])}>
            Limpar seleção
          </Button>
        )}
      </div>

      {/* Lista selecionável */}
      <ScrollArea className="h-[320px] border rounded-lg">
        {filteredContacts.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">
            Nenhum cliente confirmado com os filtros aplicados.
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((ac) => {
              const c = toContact(ac);
              if (!c.phone) return null;
              const checked = selectedPhones.has(c.phone);
              return (
                <label key={ac.customer?.id || c.phone} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50">
                  <input type="checkbox" checked={checked} onChange={() => toggleOne(ac)} className="h-4 w-4" />
                  <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium truncate">{c.name}</span>
                    <span className="text-muted-foreground ml-2 text-sm">{c.phone}</span>
                  </div>
                  {ac.customer?.city && <span className="text-xs text-muted-foreground shrink-0">{cidadeCanonica(ac.customer.city)}</span>}
                </label>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50/60 px-3 py-2 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200">
      <CheckCircle className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
      <div>{children}</div>
    </div>
  );
}
