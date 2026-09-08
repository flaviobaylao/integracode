// client/src/pages/RedeClientes.tsx
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — aba "Rede de Cliente".
//
// Uma REDE agrupa clientes que sao a mesma gestao: filiais do mesmo dono, socios
// em comum, ou CNPJs de mesma raiz. O cadastro de cada cliente segue separado —
// a rede e' so' a lente que consolida.
//
// Cada rede vira um cartao com os totais (clientes, faturamento do mes, do ano e
// debito) e a relacao das filiais por baixo. Faturamento e debito saem do MESMO
// filtro do resto da tela de carteiras (sem devolucao, amostra, aporte, NF-e
// cancelada, transferencia...), entao os numeros fecham com a aba Carteira.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Network, Plus, Search, Trash2, Pencil, ChevronDown, ChevronRight, Download, Info, X,
  MapPin, Crosshair,
} from "lucide-react";
import { exportToExcel } from "@/lib/tableTools";

type ClienteRede = {
  id: string; nome: string; doc: string | null; cidade: string; bairro: string;
  ativo: boolean; conquista: string | null; cadastroEm: string | null; inativadoEm: string | null;
  vendedor: string; sellerId: string;
  /** 'destinatario' | 'entrega' | 'nenhum' — papel do integrante na NF-e. */
  papel?: string;
  fatMes: number; fatMesAnt: number; fatMesAnoAnt: number; fatAno: number; fatAnoAnt: number; debito: number;
};
/** Endereço de entrega SEM CNPJ pendurado na rede — não é cliente, não tem carteira. */
type PontoEntrega = {
  id: string; redeId: string; nome: string;
  endereco: string; numero: string; complemento: string; bairro: string;
  cidade: string; uf: string; cep: string;
  latitude: number | null; longitude: number | null;
  contato: string; telefone: string; observacao: string;
};
type Rede = {
  id: string; nome: string; observacao: string; criadaPor: string; criadaEm: string;
  clientes: ClienteRede[];
  pontos?: PontoEntrega[];
  totais: {
    clientes: number; ativos: number; inativos: number;
    fatMes: number; fatMesAnt: number; fatMesAnoAnt: number; fatAno: number; fatAnoAnt: number; debito: number;
  };
};
type Candidato = {
  id: string; nome: string; doc: string | null; cidade: string; bairro: string;
  ativo: boolean; redeId: string | null; redeNome: string | null;
};

const BRL = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const BRL0 = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const NUM = (v: any) => Number(v || 0).toLocaleString("pt-BR");
const MES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const labelMes = (m: string) => {
  const [a, b] = String(m || "").split("-");
  return b ? `${MES_ABREV[Number(b) - 1]}/${a.slice(2)}` : m;
};
const dataBR = (d: any) => {
  const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};
/** Variação % de `atual` sobre `base`. Sem base não há variação — devolve null
 *  em vez de inventar "+100%", que é o erro clássico de dividir por zero. */
const variacao = (atual: number, base: number): number | null => {
  const b = Number(base) || 0;
  if (b <= 0) return null;
  return ((Number(atual) || 0) - b) / b;
};
/** "+18%" / "-7%" — o sinal é o que se lê primeiro. */
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`);
const corVar = (v: number | null) => (v === null ? "text-muted-foreground" : v > 0 ? "text-emerald-700" : v < 0 ? "text-destructive" : "text-muted-foreground");

/** 74810100 -> "74810-100". Mascara enquanto digita, sem atrapalhar o apagar. */
const cepBR = (v: any) => {
  const d = String(v || "").replace(/\D/g, "").slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

/**
 * Lê um par de coordenadas colado de qualquer jeito e devolve {lat, lng}.
 * Aceita "-16.708, -49.239", "-16.708 -49.239", "-16.708;-49.239" e o link do
 * Google Maps (".../@-16.708,-49.239,17z"). Devolve null quando não reconhece —
 * melhor deixar o usuário digitar do que chutar coordenada errada.
 */
const parseCoordenadas = (txt: any): { lat: string; lng: string } | null => {
  const bruto = String(txt || "").trim();
  if (!bruto) return null;
  // Link do Google Maps: o par que interessa vem depois do "@".
  const arroba = bruto.match(/@(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
  const alvo = arroba ? `${arroba[1]},${arroba[2]}` : bruto;
  const nums = alvo.match(/-?\d{1,3}(?:[.,]\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  // Vírgula decimal ("-16,708") vira ponto; o separador do par já foi consumido
  // pelo split, então não há ambiguidade aqui.
  let [a, b] = nums.map((n) => Number(n.replace(",", ".")));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Colou invertido (longitude primeiro)? Só corrige quando é inequívoco: o
  // primeiro número está fora da faixa de latitude e o segundo está dentro.
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: String(a), lng: String(b) };
};

/** CNPJ/CPF com pontuação, para conferir raiz de CNPJ a olho. */
const docBR = (d: any) => {
  const s = String(d || "").replace(/\D/g, "");
  if (s.length === 14) return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`;
  if (s.length === 11) return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`;
  return s || "—";
};

export default function RedeClientes() {
  const qc = useQueryClient();
  const [abertas, setAbertas] = useState<Record<string, boolean>>({});
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState<Rede | null>(null);
  const [criando, setCriando] = useState(false);

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/carteira/redes"],
    queryFn: async () => {
      const r = await fetch("/api/carteira/redes", { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar as redes de clientes");
      return r.json();
    },
  });

  const redes: Rede[] = data?.redes || [];
  const mes: string = data?.mes || "";
  const mesAnt: string = data?.mesAnt || "";
  const mesAnoAnt: string = data?.mesAnoAnt || "";
  const ano: string = data?.ano || "";
  const anoAnt: string = data?.anoAnt || "";
  const podeEditar = data?.podeEditar === true;

  const listaFiltrada = useMemo(() => {
    const alvo = busca.trim().toLocaleLowerCase("pt-BR");
    if (alvo.length < 2) return redes;
    return redes.filter(
      (r) =>
        r.nome.toLocaleLowerCase("pt-BR").includes(alvo) ||
        r.clientes.some((c) => c.nome.toLocaleLowerCase("pt-BR").includes(alvo) || (c.cidade || "").toLocaleLowerCase("pt-BR").includes(alvo)),
    );
  }, [redes, busca]);

  // Totais do rodapé: a soma de todas as redes que estão na tela.
  const totalGeral = useMemo(() => {
    const t = { redes: 0, clientes: 0, ativos: 0, fatMes: 0, fatMesAnt: 0, fatMesAnoAnt: 0, fatAno: 0, fatAnoAnt: 0, debito: 0 };
    for (const r of listaFiltrada) {
      t.redes++; t.clientes += r.totais.clientes; t.ativos += r.totais.ativos;
      t.fatMes += r.totais.fatMes; t.fatMesAnt += r.totais.fatMesAnt; t.fatMesAnoAnt += r.totais.fatMesAnoAnt;
      t.fatAno += r.totais.fatAno; t.fatAnoAnt += r.totais.fatAnoAnt; t.debito += r.totais.debito;
    }
    return t;
  }, [listaFiltrada]);

  const recarrega = () => { qc.invalidateQueries({ queryKey: ["/api/carteira/redes"] }); };

  const exportar = () => {
    const linhas: Record<string, any>[] = [];
    for (const r of listaFiltrada) {
      for (const c of r.clientes) {
        linhas.push({
          Rede: r.nome, Cliente: c.nome, "CPF/CNPJ": c.doc || "", Cidade: c.cidade, Bairro: c.bairro,
          Status: c.ativo ? "Ativo" : "Inativo", "Data da conquista": c.conquista ? dataBR(c.conquista) : "",
          Vendedor: c.vendedor,
          [`Faturamento ${labelMes(mesAnoAnt)}`]: Number(c.fatMesAnoAnt.toFixed(2)),
          [`Faturamento ${labelMes(mesAnt)}`]: Number(c.fatMesAnt.toFixed(2)),
          [`Faturamento ${labelMes(mes)}`]: Number(c.fatMes.toFixed(2)),
          "Var. vs mês anterior": pct(variacao(c.fatMes, c.fatMesAnt)),
          [`Var. vs ${labelMes(mesAnoAnt)}`]: pct(variacao(c.fatMes, c.fatMesAnoAnt)),
          [`Faturamento ${anoAnt}`]: Number(c.fatAnoAnt.toFixed(2)),
          [`Faturamento ${ano}`]: Number(c.fatAno.toFixed(2)),
          "Débito vencido": Number(c.debito.toFixed(2)),
        });
      }
      linhas.push({
        Rede: r.nome, Cliente: `TOTAL — ${r.totais.clientes} clientes`, "CPF/CNPJ": "", Cidade: "", Bairro: "",
        Status: `${r.totais.ativos} ativos / ${r.totais.inativos} inativos`, "Data da conquista": "", Vendedor: "",
        [`Faturamento ${labelMes(mesAnoAnt)}`]: Number(r.totais.fatMesAnoAnt.toFixed(2)),
        [`Faturamento ${labelMes(mesAnt)}`]: Number(r.totais.fatMesAnt.toFixed(2)),
        [`Faturamento ${labelMes(mes)}`]: Number(r.totais.fatMes.toFixed(2)),
        "Var. vs mês anterior": pct(variacao(r.totais.fatMes, r.totais.fatMesAnt)),
        [`Var. vs ${labelMes(mesAnoAnt)}`]: pct(variacao(r.totais.fatMes, r.totais.fatMesAnoAnt)),
        [`Faturamento ${anoAnt}`]: Number(r.totais.fatAnoAnt.toFixed(2)),
        [`Faturamento ${ano}`]: Number(r.totais.fatAno.toFixed(2)),
        "Débito vencido": Number(r.totais.debito.toFixed(2)),
      });
    }
    exportToExcel(linhas, `redes-de-clientes-${mes || "atual"}`);
  };

  // ── Papel na NF-e ──────────────────────────────────────────────────────────
  // Clicar no papel que o integrante ja' tem o desmarca (volta a 'nenhum'), que
  // e' como se desfaz um arranjo sem precisar de outro botao.
  const [salvandoPapel, setSalvandoPapel] = useState<string | null>(null);
  const definirPapel = async (redeId: string, c: ClienteRede, papel: string) => {
    const alvo = (c.papel || "nenhum") === papel ? "nenhum" : papel;
    setSalvandoPapel(c.id);
    try {
      const resp = await fetch(`/api/carteira/redes/${redeId}/papel`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clienteId: c.id, papel: alvo }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) { window.alert(j?.error || "Não deu para definir o papel."); return; }
      recarrega();
    } finally {
      setSalvandoPapel(null);
    }
  };

  const excluir = async (r: Rede) => {
    if (!window.confirm(`Desfazer a rede "${r.nome}"? Os ${r.totais.clientes} clientes continuam cadastrados — só deixam de ser agrupados.`)) return;
    const resp = await fetch(`/api/carteira/redes/${r.id}`, { method: "DELETE", credentials: "include" });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j?.ok === false) { window.alert(j?.error || "Não deu para excluir a rede."); return; }
    recarrega();
  };

  return (
    <div className="space-y-6">
      {/* Barra da aba */}
      <Card>
        <CardContent className="py-3 px-4 flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar rede, cliente ou cidade…"
              className="pl-8 w-[280px]"
              data-testid="input-busca-rede"
            />
          </div>
          <div className="text-sm text-muted-foreground">
            Faturamento do mês <span className="font-medium text-foreground">{labelMes(mes)}</span> e do ano{" "}
            <span className="font-medium text-foreground">{ano}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={exportar} data-testid="button-export-redes">
              <Download className="h-4 w-4 mr-2" />Exportar Excel
            </Button>
            {podeEditar ? (
              <Button onClick={() => setCriando(true)} data-testid="button-criar-rede">
                <Plus className="h-4 w-4 mr-2" />Criar Rede de Clientes
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Carregando as redes…</div>
      ) : error ? (
        <div className="text-center text-destructive py-16">Não deu para carregar as redes de clientes.</div>
      ) : redes.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center space-y-3">
            <Network className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <p className="font-medium">Nenhuma rede criada ainda</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Uma rede junta clientes que são a mesma gestão — filiais do mesmo dono, sócios em comum ou CNPJs de
              mesma raiz — e mostra o faturamento e o débito consolidados.
            </p>
            {podeEditar ? (
              <Button onClick={() => setCriando(true)} data-testid="button-criar-rede-vazio">
                <Plus className="h-4 w-4 mr-2" />Criar Rede de Clientes
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Consolidado de todas as redes — CONGELADO no topo. É a referência
              contra a qual se lê cada rede; rolar a lista e perder o total de
              vista obrigava a subir toda hora. O container de rolagem é o
              <main> do Layout, então `top-0` cola no topo da área útil. */}
          <Card className="sticky top-0 z-30 shadow-sm">
            <CardContent className="py-3 px-4 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
              <span className="font-semibold">{NUM(totalGeral.redes)} {totalGeral.redes === 1 ? "rede" : "redes"}</span>
              <span className="text-muted-foreground">
                {NUM(totalGeral.clientes)} clientes · <span className="text-emerald-700">{NUM(totalGeral.ativos)} ativos</span>
              </span>
              <span className="text-muted-foreground">{labelMes(mesAnoAnt)}: {BRL0(totalGeral.fatMesAnoAnt)}</span>
              <span className="text-muted-foreground">{labelMes(mesAnt)}: {BRL0(totalGeral.fatMesAnt)}</span>
              <span>
                {labelMes(mes)}: <b className="text-blue-700">{BRL0(totalGeral.fatMes)}</b>{" "}
                <span className={corVar(variacao(totalGeral.fatMes, totalGeral.fatMesAnt))}>
                  {pct(variacao(totalGeral.fatMes, totalGeral.fatMesAnt))} vs mês ant.
                </span>{" "}
                <span className={corVar(variacao(totalGeral.fatMes, totalGeral.fatMesAnoAnt))}>
                  {pct(variacao(totalGeral.fatMes, totalGeral.fatMesAnoAnt))} vs {labelMes(mesAnoAnt)}
                </span>
              </span>
              <span>Faturamento {ano}: <b className="text-blue-700">{BRL0(totalGeral.fatAno)}</b></span>
              <span>
                Débito vencido:{" "}
                <b className={totalGeral.debito > 0 ? "text-destructive" : "text-muted-foreground"}>{BRL0(totalGeral.debito)}</b>
              </span>
            </CardContent>
          </Card>

          {listaFiltrada.map((r) => {
            // Nasce RECOLHIDA: com várias redes, abrir todas empurrava os
            // totais para fora da tela e obrigava a rolar para comparar.
            const aberta = abertas[r.id] === true;
            return (
              <Card key={r.id} data-testid={`card-rede-${r.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => setAbertas((a) => ({ ...a, [r.id]: !aberta }))}
                        className="mt-1 text-muted-foreground hover:text-foreground"
                        data-testid={`toggle-rede-${r.id}`}
                      >
                        {aberta ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <Network className="h-5 w-5 text-blue-600" />
                          {r.nome}
                        </CardTitle>
                        <CardDescription>
                          {NUM(r.totais.clientes)} {r.totais.clientes === 1 ? "cliente" : "clientes"} ·{" "}
                          <span className="text-emerald-700">{r.totais.ativos} ativos</span>
                          {r.totais.inativos ? <> · <span className="text-muted-foreground">{r.totais.inativos} inativos</span></> : null}
                          {r.criadaEm ? ` · criada em ${r.criadaEm} por ${r.criadaPor}` : ""}
                        </CardDescription>
                        {r.observacao ? <p className="text-xs text-muted-foreground mt-1 max-w-2xl">{r.observacao}</p> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      {/* Ordem cronológica: mesmo mês do ano passado, mês anterior,
                          mês vigente (destacado) e o ano. Lê-se da esquerda para a
                          direita como o tempo passa. */}
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">{labelMes(mesAnoAnt)}</p>
                        <p className="text-base font-semibold text-muted-foreground">{BRL0(r.totais.fatMesAnoAnt)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">{labelMes(mesAnt)}</p>
                        <p className="text-base font-semibold text-muted-foreground">{BRL0(r.totais.fatMesAnt)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Faturamento {labelMes(mes)}</p>
                        <p className="text-lg font-bold text-blue-700">{BRL0(r.totais.fatMes)}</p>
                        <p className="text-[11px] leading-tight">
                          <span className={corVar(variacao(r.totais.fatMes, r.totais.fatMesAnt))}>
                            {pct(variacao(r.totais.fatMes, r.totais.fatMesAnt))} vs mês ant.
                          </span>{" · "}
                          <span className={corVar(variacao(r.totais.fatMes, r.totais.fatMesAnoAnt))}>
                            {pct(variacao(r.totais.fatMes, r.totais.fatMesAnoAnt))} vs {labelMes(mesAnoAnt)}
                          </span>
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Faturamento {ano}</p>
                        <p className="text-lg font-bold text-blue-700">{BRL0(r.totais.fatAno)}</p>
                        <p className="text-[11px] leading-tight text-muted-foreground">
                          {anoAnt}: {BRL0(r.totais.fatAnoAnt)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Débito vencido</p>
                        <p className={`text-lg font-bold ${r.totais.debito > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                          {BRL0(r.totais.debito)}
                        </p>
                      </div>
                      {podeEditar ? (
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditando(r)} data-testid={`btn-editar-rede-${r.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => excluir(r)} data-testid={`btn-excluir-rede-${r.id}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </CardHeader>
                {aberta ? (
                  <CardContent>
                    <div className="border rounded-md overflow-x-auto">
                      <Table>
                        <TableHeader className="bg-muted/40">
                          <TableRow>
                            <TableHead className="w-8">#</TableHead>
                            <TableHead>Cliente</TableHead>
                            <TableHead>Cidade</TableHead>
                            <TableHead>Bairro</TableHead>
                            <TableHead className="w-24">Status</TableHead>
                            <TableHead className="w-56 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1">
                                Papel na NF-e
                                <AjudaPapelNFe />
                              </span>
                            </TableHead>
                            <TableHead className="w-32 whitespace-nowrap">Data da conquista</TableHead>
                            <TableHead className="text-right whitespace-nowrap text-muted-foreground">Fat. {labelMes(mesAnoAnt)}</TableHead>
                            <TableHead className="text-right whitespace-nowrap text-muted-foreground">Fat. {labelMes(mesAnt)}</TableHead>
                            <TableHead className="text-right whitespace-nowrap">Fat. {labelMes(mes)}</TableHead>
                            <TableHead className="text-right whitespace-nowrap">Fat. {ano}</TableHead>
                            <TableHead className="text-right whitespace-nowrap">Débito</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {r.clientes.map((c, i) => (
                            <TableRow key={c.id} data-testid={`row-rede-cliente-${i}`}>
                              <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                              <TableCell className="font-medium leading-tight">
                                {c.nome}
                                <span className="block text-xs text-muted-foreground">
                                  {docBR(c.doc)}{c.vendedor ? ` · ${c.vendedor}` : ""}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm">{c.cidade || "—"}</TableCell>
                              <TableCell className="text-sm">{c.bairro || "—"}</TableCell>
                              <TableCell>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${c.ativo ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>
                                  {c.ativo ? "Ativo" : "Inativo"}
                                </span>
                              </TableCell>
                              <TableCell>
                                {/* Destinatário: recebe a NF-e e paga. Local de entrega: mantém
                                    pedidos próprios, mas a nota dele sai no CNPJ do destinatário. */}
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant={c.papel === "destinatario" ? "default" : "outline"}
                                    className="h-7 px-2 text-[11px]"
                                    disabled={!podeEditar || salvandoPapel === c.id}
                                    onClick={() => definirPapel(r.id, c, "destinatario")}
                                    title="Recebe a NF-e e o título de todos os locais de entrega da rede"
                                    data-testid={`btn-papel-destinatario-${c.id}`}
                                  >
                                    Destinatário
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant={c.papel === "entrega" ? "default" : "outline"}
                                    className="h-7 px-2 text-[11px]"
                                    disabled={!podeEditar || salvandoPapel === c.id}
                                    onClick={() => definirPapel(r.id, c, "entrega")}
                                    title="Faz pedidos próprios; a nota sai no CNPJ do destinatário e a mercadoria desce aqui"
                                    data-testid={`btn-papel-entrega-${c.id}`}
                                  >
                                    Local de entrega
                                  </Button>
                                </div>
                              </TableCell>
                              <TableCell className="text-sm whitespace-nowrap">{dataBR(c.conquista)}</TableCell>
                              <TableCell className="text-right whitespace-nowrap text-muted-foreground">{BRL(c.fatMesAnoAnt)}</TableCell>
                              <TableCell className="text-right whitespace-nowrap text-muted-foreground">{BRL(c.fatMesAnt)}</TableCell>
                              <TableCell className="text-right whitespace-nowrap">
                                {BRL(c.fatMes)}
                                <span className={`block text-[11px] ${corVar(variacao(c.fatMes, c.fatMesAnt))}`}>
                                  {pct(variacao(c.fatMes, c.fatMesAnt))} vs mês ant.
                                </span>
                              </TableCell>
                              <TableCell className="text-right whitespace-nowrap font-medium">
                                {BRL(c.fatAno)}
                                <span className="block text-[11px] text-muted-foreground">{anoAnt}: {BRL(c.fatAnoAnt)}</span>
                              </TableCell>
                              <TableCell className={`text-right whitespace-nowrap ${c.debito > 0 ? "text-destructive font-semibold" : "text-muted-foreground"}`}>
                                {BRL(c.debito)}
                              </TableCell>
                            </TableRow>
                          ))}
                          <TableRow className="bg-muted/50 font-semibold border-t-2">
                            <TableCell />
                            <TableCell>Total da rede</TableCell>
                            <TableCell colSpan={2} className="text-muted-foreground font-normal text-sm">
                              {NUM(r.totais.clientes)} clientes
                            </TableCell>
                            <TableCell className="text-xs font-normal text-muted-foreground">
                              {r.totais.ativos} ativos
                            </TableCell>
                            <TableCell />
                            <TableCell />
                            <TableCell className="text-right whitespace-nowrap text-muted-foreground">{BRL(r.totais.fatMesAnoAnt)}</TableCell>
                            <TableCell className="text-right whitespace-nowrap text-muted-foreground">{BRL(r.totais.fatMesAnt)}</TableCell>
                            <TableCell className="text-right whitespace-nowrap">{BRL(r.totais.fatMes)}</TableCell>
                            <TableCell className="text-right whitespace-nowrap">{BRL(r.totais.fatAno)}</TableCell>
                            <TableCell className={`text-right whitespace-nowrap ${r.totais.debito > 0 ? "text-destructive" : ""}`}>
                              {BRL(r.totais.debito)}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                    {r.clientes.some((c) => c.papel === "entrega") && !r.clientes.some((c) => c.papel === "destinatario") ? (
                      <p className="mt-2 text-xs text-amber-700">
                        Esta rede tem local de entrega mas nenhum destinatário marcado — enquanto isso,
                        cada CNPJ continua faturando no próprio nome.
                      </p>
                    ) : r.clientes.some((c) => c.papel === "destinatario") ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Pedidos dos locais de entrega são faturados individualmente, mas a NF-e sai no CNPJ do
                        destinatário — com a condição de pagamento dele — e a mercadoria desce no endereço do
                        CNPJ que fez o pedido.
                      </p>
                    ) : null}

                    <PontosDeEntrega rede={r} podeEditar={podeEditar} onMudou={recarrega} />
                  </CardContent>
                ) : null}
              </Card>
            );
          })}

          {listaFiltrada.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">Nenhuma rede bate com a busca.</CardContent></Card>
          ) : null}
        </>
      )}

      {(criando || editando) ? (
        <ModalRede
          rede={editando}
          onFechar={() => { setCriando(false); setEditando(null); }}
          onSalvo={() => { setCriando(false); setEditando(null); recarrega(); }}
        />
      ) : null}
    </div>
  );
}

/** Criação e edição da rede: nome, observação e os clientes que fazem parte. */
function ModalRede(props: { rede: Rede | null; onFechar: () => void; onSalvo: () => void }) {
  const ehEdicao = !!props.rede;
  const [nome, setNome] = useState(props.rede?.nome || "");
  const [observacao, setObservacao] = useState(props.rede?.observacao || "");
  const [escolhidos, setEscolhidos] = useState<Candidato[]>(
    (props.rede?.clientes || []).map((c) => ({
      id: c.id, nome: c.nome, doc: c.doc, cidade: c.cidade, bairro: c.bairro, ativo: c.ativo,
      redeId: props.rede?.id || null, redeNome: props.rede?.nome || null,
    })),
  );
  const [busca, setBusca] = useState("");
  const [buscaDebounce, setBuscaDebounce] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setBuscaDebounce(busca), 350);
    return () => clearTimeout(t);
  }, [busca]);

  const { data: candidatos = [], isFetching } = useQuery<Candidato[]>({
    queryKey: ["/api/carteira/redes/clientes", buscaDebounce],
    queryFn: async () => {
      const r = await fetch(`/api/carteira/redes/clientes?busca=${encodeURIComponent(buscaDebounce)}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: buscaDebounce.trim().length >= 2,
  });

  const jaEscolhido = (id: string) => escolhidos.some((c) => c.id === id);
  const alterna = (c: Candidato) => {
    setErro("");
    setEscolhidos((atual) => (atual.some((x) => x.id === c.id) ? atual.filter((x) => x.id !== c.id) : [...atual, c]));
  };

  const salvar = async () => {
    if (salvando) return;
    if (!nome.trim()) { setErro("Dê um nome à rede."); return; }
    if (!escolhidos.length) { setErro("Escolha pelo menos um cliente."); return; }
    setSalvando(true); setErro("");
    try {
      const corpo = { nome: nome.trim(), observacao, clienteIds: escolhidos.map((c) => c.id) };
      const url = ehEdicao ? `/api/carteira/redes/${props.rede!.id}` : "/api/carteira/redes";
      const r = await fetch(url, {
        method: ehEdicao ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(corpo),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || "Não deu para salvar a rede.");
      props.onSalvo();
    } catch (e: any) {
      setErro(e?.message || "Não deu para salvar a rede.");
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) props.onFechar(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ehEdicao ? `Editar rede — ${props.rede!.nome}` : "Criar Rede de Clientes"}</DialogTitle>
          <DialogDescription>
            Junte os clientes que são a mesma gestão: filiais do mesmo dono, sócios em comum ou CNPJs de mesma raiz.
            O cadastro de cada um continua separado — a rede só consolida os números.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Nome da rede *</label>
              <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Grupo Bom Preço" data-testid="input-nome-rede" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Observação</label>
              <Input value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Sócios em comum, mesma raiz de CNPJ…" data-testid="input-obs-rede" />
            </div>
          </div>

          {/* Escolhidos */}
          <div>
            <p className="text-xs text-muted-foreground mb-1">
              Clientes na rede <span className="font-semibold text-foreground">({escolhidos.length})</span>
            </p>
            {escolhidos.length === 0 ? (
              <p className="text-sm text-muted-foreground border rounded-md px-3 py-4 text-center">
                Nenhum cliente ainda. Busque abaixo pelo nome ou pelo CNPJ.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 border rounded-md p-2 max-h-40 overflow-auto">
                {escolhidos.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-900 border border-blue-200 rounded px-2 py-1">
                    {c.nome}
                    <span className="text-blue-700/60">{docBR(c.doc)}</span>
                    <button type="button" onClick={() => alterna(c)} className="hover:text-destructive" data-testid={`btn-tirar-${c.id}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Busca de clientes */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Adicionar clientes</label>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Nome, nome fantasia ou CNPJ (mínimo 2 letras)…"
                className="pl-8"
                data-testid="input-busca-cliente-rede"
              />
            </div>
            <div className="border rounded-md mt-2 max-h-64 overflow-auto divide-y">
              {buscaDebounce.trim().length < 2 ? (
                <p className="text-sm text-muted-foreground px-3 py-4 text-center">Digite pelo menos 2 letras para buscar.</p>
              ) : isFetching ? (
                <p className="text-sm text-muted-foreground px-3 py-4 text-center">Buscando…</p>
              ) : candidatos.length === 0 ? (
                <p className="text-sm text-muted-foreground px-3 py-4 text-center">Nenhum cliente encontrado.</p>
              ) : (
                candidatos.map((c) => {
                  // Cliente de OUTRA rede não pode ser marcado — o servidor
                  // recusaria, e é melhor dizer isso antes do que depois.
                  const emOutra = !!c.redeId && c.redeId !== props.rede?.id;
                  const marcado = jaEscolhido(c.id);
                  return (
                    <label
                      key={c.id}
                      className={`flex items-center gap-2 px-3 py-2 text-sm ${emOutra ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-muted/40"}`}
                      data-testid={`opt-cliente-${c.id}`}
                    >
                      <input type="checkbox" checked={marcado} disabled={emOutra} onChange={() => !emOutra && alterna(c)} />
                      <span className="flex-1 leading-tight">
                        {c.nome}
                        <span className="block text-xs text-muted-foreground">
                          {docBR(c.doc)}{c.cidade ? ` · ${c.cidade}` : ""}{c.bairro ? ` · ${c.bairro}` : ""}
                          {c.ativo ? "" : " · inativo"}
                        </span>
                      </span>
                      {emOutra ? <span className="text-xs text-amber-700 whitespace-nowrap">já em {c.redeNome}</span> : null}
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {erro ? <p className="text-sm text-destructive">{erro}</p> : null}

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={salvar} disabled={salvando} data-testid="btn-salvar-rede">
              {salvando ? "Salvando…" : ehEdicao ? "Salvar alterações" : "Criar rede"}
            </Button>
            <Button variant="ghost" onClick={props.onFechar}>Cancelar</Button>
            <span className="ml-auto text-xs text-muted-foreground">Um cliente pertence a uma rede só.</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Selo de rede para o CADASTRO do cliente. Busca sozinho e não desenha nada
 * quando o cliente não está em rede nenhuma.
 */
export function SeloRedeDoCliente(props: { customerId?: string | null; className?: string }) {
  const id = props.customerId || "";
  const { data } = useQuery<any>({
    queryKey: ["/api/carteira/redes/do-cliente", id],
    queryFn: async () => {
      const r = await fetch(`/api/carteira/redes/do-cliente/${id}`, { credentials: "include" });
      if (!r.ok) return { rede: null };
      return r.json();
    },
    enabled: !!id,
    staleTime: 60000,
  });
  const rede = data?.rede;
  if (!rede) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 text-xs rounded px-2 py-1 bg-blue-50 text-blue-900 border border-blue-200 hover:bg-blue-100 transition ${props.className || ""}`}
          data-testid="selo-rede-cliente"
        >
          <Network className="h-3.5 w-3.5" />
          Rede: <span className="font-semibold">{rede.nome}</span>
          <Info className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-sm space-y-1">
        <p className="font-semibold">{rede.nome}</p>
        <p className="text-muted-foreground text-xs">
          Este cliente faz parte de uma rede com {NUM(rede.clientes)} {rede.clientes === 1 ? "cliente" : "clientes"} —
          mesma gestão, sócios em comum ou CNPJs de mesma raiz.
        </p>
        <p className="text-muted-foreground text-xs">
          O faturamento e o débito consolidados ficam em <b>Gestão de Carteiras → Rede de Cliente</b>.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * O "i" ao lado de "Papel na NF-e". Explica em ACAO -> RESULTADO, porque quem
 * marca o papel precisa saber o que muda no faturamento ANTES de clicar — a
 * marcacao redireciona nota e boleto para outro CNPJ.
 */
function AjudaPapelNFe() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Como funciona o papel na NF-e"
          className="inline-flex items-center justify-center h-4 w-4 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition"
          data-testid="ajuda-papel-nfe"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 text-sm space-y-3">
        <div>
          <p className="font-semibold">Papel na NF-e</p>
          <p className="text-xs text-muted-foreground">
            Use quando a rede fatura tudo num CNPJ só, mas recebe a mercadoria em cada unidade.
          </p>
        </div>

        <div className="space-y-2">
          <div className="rounded border p-2">
            <p className="text-xs font-semibold">1. Marcar <span className="text-emerald-700">Destinatário</span></p>
            <p className="text-xs text-muted-foreground">
              No CNPJ que recebe a nota e paga — normalmente a matriz. Só um por rede;
              marcar outro desmarca o anterior.
            </p>
            <p className="text-xs mt-1">
              <b>Resultado:</b> a NF-e e o boleto de todos os locais de entrega passam a sair
              nesse CNPJ, com a condição de pagamento dele.
            </p>
          </div>

          <div className="rounded border p-2">
            <p className="text-xs font-semibold">2. Marcar <span className="text-emerald-700">Local de entrega</span></p>
            <p className="text-xs text-muted-foreground">
              Em cada unidade que recebe mercadoria. Ela mantém cadastro, rota e pedidos próprios.
            </p>
            <p className="text-xs mt-1">
              <b>Resultado:</b> o pedido continua sendo faturado individualmente, no seu tempo, mas
              a nota sai no CNPJ do destinatário e o endereço da unidade vai no quadro
              <b> LOCAL DE ENTREGA</b> da DANFE (grupo <code>&lt;entrega&gt;</code> do XML), que é
              onde o entregador descarrega e colhe a assinatura.
            </p>
          </div>

          <div className="rounded border p-2 bg-muted/40">
            <p className="text-xs font-semibold">3. Nenhum dos dois marcado <span className="font-normal text-muted-foreground">(situação padrão)</span></p>
            <p className="text-xs text-muted-foreground">
              É como todo cliente nasce. Clicar de novo no botão já marcado volta para cá.
            </p>
            <p className="text-xs mt-1">
              <b>Resultado:</b> nada muda. O cliente fatura no próprio CNPJ, com a condição de
              pagamento dele, e a NF-e sai sem o quadro LOCAL DE ENTREGA — exatamente como antes
              da rede existir.
            </p>
            <p className="text-xs mt-1 text-muted-foreground">
              Vale também para a rede inteira: enquanto <b>nenhum</b> integrante for marcado como
              destinatário, quem estiver como local de entrega continua faturando no próprio nome
              (a tela avisa em amarelo). O redirecionamento só começa quando existe o par
              destinatário + local de entrega.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * PONTOS DE ENTREGA SEM CNPJ.
 *
 * O caso: cliente de UM CNPJ so' que recebe em varios enderecos (lojas de
 * shopping, quiosques, cozinhas, obras). Esses pontos NAO sao clientes — nao
 * entram em clientes ativos, nao tem carteira, vendedor nem faturamento. Sao
 * enderecos com coordenada, pendurados na rede, que o vendedor escolhe no
 * pedido. A nota continua saindo no CNPJ do cliente; muda so' o quadro LOCAL DE
 * ENTREGA (grupo <entrega> da NF-e), que leva o endereco do ponto.
 */
function PontosDeEntrega(props: { rede: Rede; podeEditar: boolean; onMudou: () => void }) {
  const { rede, podeEditar, onMudou } = props;
  const pontos = rede.pontos || [];
  const [editando, setEditando] = useState<PontoEntrega | null>(null);
  const [criando, setCriando] = useState(false);

  const excluir = async (p: PontoEntrega) => {
    if (!window.confirm(`Remover o ponto de entrega "${p.nome}"? Pedidos e notas antigos continuam mostrando este endereço.`)) return;
    const resp = await fetch(`/api/carteira/redes/pontos/${p.id}`, { method: "DELETE", credentials: "include" });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j?.ok === false) { window.alert(j?.error || "Não deu para remover o ponto."); return; }
    onMudou();
  };

  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex items-center gap-2 mb-2">
        <MapPin className="h-4 w-4 text-sky-700" />
        <span className="text-sm font-semibold">Pontos de entrega sem CNPJ</span>
        <span className="text-xs text-muted-foreground">
          {pontos.length ? `${NUM(pontos.length)} ${pontos.length === 1 ? "ponto" : "pontos"}` : "nenhum"}
        </span>
        <AjudaPontosEntrega />
        {podeEditar ? (
          <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" onClick={() => setCriando(true)} data-testid={`btn-novo-ponto-${rede.id}`}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Novo ponto
          </Button>
        ) : null}
      </div>

      {pontos.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Endereços de entrega que não têm CNPJ próprio — lojas de shopping, quiosques, cozinhas, obras.
          Não viram cliente: o pedido continua no CNPJ da matriz e o vendedor só escolhe onde descarregar.
        </p>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Ponto</TableHead>
                <TableHead>Endereço</TableHead>
                <TableHead className="w-40">Cidade / UF</TableHead>
                <TableHead className="w-36">Coordenadas</TableHead>
                <TableHead className="w-40">Contato</TableHead>
                {podeEditar ? <TableHead className="w-20" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pontos.map((p, i) => (
                <TableRow key={p.id} data-testid={`row-ponto-${i}`}>
                  <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                  <TableCell className="font-medium leading-tight">
                    {p.nome}
                    {p.observacao ? <span className="block text-xs text-muted-foreground">{p.observacao}</span> : null}
                  </TableCell>
                  <TableCell className="text-sm leading-tight">
                    {[p.endereco, p.numero].filter(Boolean).join(", ")}
                    <span className="block text-xs text-muted-foreground">
                      {[p.complemento, p.bairro, p.cep ? `CEP ${p.cep}` : ""].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{p.cidade}{p.uf ? `/${p.uf}` : ""}</TableCell>
                  <TableCell className="text-xs font-mono whitespace-nowrap">
                    {p.latitude != null && p.longitude != null
                      ? `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`
                      : <span className="text-amber-700 font-sans">sem coordenada</span>}
                  </TableCell>
                  <TableCell className="text-sm leading-tight">
                    {p.contato || "—"}
                    {p.telefone ? <span className="block text-xs text-muted-foreground">{p.telefone}</span> : null}
                  </TableCell>
                  {podeEditar ? (
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditando(p)} data-testid={`btn-editar-ponto-${p.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => excluir(p)} data-testid={`btn-excluir-ponto-${p.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(criando || editando) ? (
        <ModalPonto
          redeId={rede.id}
          ponto={editando}
          onFechar={() => { setCriando(false); setEditando(null); }}
          onSalvo={() => { setCriando(false); setEditando(null); onMudou(); }}
        />
      ) : null}
    </div>
  );
}

/** O "i" dos pontos de entrega: o que é, o que não é, e o que muda na nota. */
function AjudaPontosEntrega() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Como funcionam os pontos de entrega"
          className="inline-flex items-center justify-center h-4 w-4 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition"
          data-testid="ajuda-pontos-entrega"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 text-sm space-y-3">
        <div>
          <p className="font-semibold">Pontos de entrega sem CNPJ</p>
          <p className="text-xs text-muted-foreground">
            Para o cliente de <b>um CNPJ só</b> que recebe em vários endereços.
            É o caso irmão do destinatário/local de entrega — só que aqui os pontos não têm documento próprio.
          </p>
        </div>

        <div className="space-y-2">
          <div className="rounded border p-2">
            <p className="text-xs font-semibold">1. Cadastrar o ponto</p>
            <p className="text-xs text-muted-foreground">
              Nome, endereço, cidade/UF e, de preferência, as coordenadas — é a coordenada que
              coloca o ponto na rota certa.
            </p>
            <p className="text-xs mt-1">
              <b>Resultado:</b> o ponto passa a aparecer no seletor <b>Ponto de entrega</b> do pedido
              desse cliente. Ele <b>não</b> vira cliente: não entra em clientes ativos, não tem
              carteira, vendedor, meta nem faturamento próprio.
            </p>
          </div>

          <div className="rounded border p-2">
            <p className="text-xs font-semibold">2. Escolher o ponto no pedido</p>
            <p className="text-xs text-muted-foreground">
              O vendedor lança o pedido normalmente no CNPJ do cliente e escolhe para qual ponto vai.
            </p>
            <p className="text-xs mt-1">
              <b>Resultado:</b> a NF-e sai com <b>os dois boxes</b> — destinatário no CNPJ do cliente
              (que paga) e <b>LOCAL DE ENTREGA</b> com o endereço do ponto. Como o ponto não tem
              documento, o grupo <code>&lt;entrega&gt;</code> leva o próprio CNPJ do cliente com o
              endereço do ponto, que é o que o layout da NF-e prevê para descarga em outro endereço
              da mesma empresa.
            </p>
          </div>

          <div className="rounded border p-2 bg-muted/40">
            <p className="text-xs font-semibold">3. Sem escolher ponto <span className="font-normal text-muted-foreground">(situação padrão)</span></p>
            <p className="text-xs mt-1">
              <b>Resultado:</b> nada muda. A nota sai só com o endereço do cadastro do cliente,
              sem quadro de local de entrega — como sempre foi.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Cadastro de um ponto. Endereço, cidade e UF são obrigatórios: sem eles a SEFAZ recusa o <entrega>. */
function ModalPonto(props: { redeId: string; ponto: PontoEntrega | null; onFechar: () => void; onSalvo: () => void }) {
  const p = props.ponto;
  const [f, setF] = useState({
    nome: p?.nome || "", endereco: p?.endereco || "", numero: p?.numero || "",
    complemento: p?.complemento || "", bairro: p?.bairro || "", cidade: p?.cidade || "",
    uf: p?.uf || "", cep: p?.cep || "",
    latitude: p?.latitude != null ? String(p.latitude) : "",
    longitude: p?.longitude != null ? String(p.longitude) : "",
    contato: p?.contato || "", telefone: p?.telefone || "", observacao: p?.observacao || "",
  });
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [buscandoCep, setBuscandoCep] = useState(false);
  const [avisoCep, setAvisoCep] = useState("");
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const setMuitos = (novos: Record<string, string>) => setF((x) => ({ ...x, ...novos }));

  /**
   * Lupa do CEP: preenche Endereço, Bairro, Cidade e UF.
   * NÃO preenche Número nem Complemento — o CEP não sabe (o "complemento" dos
   * Correios é faixa de numeração, "de 2496 ao fim - lado par", e no quadro de
   * entrega da NF-e isso vira lixo). Depois de achar, o foco vai para o Número,
   * que é justamente o que falta.
   */
  const buscarCep = async () => {
    const digitos = String(f.cep || "").replace(/\D/g, "");
    setErro(""); setAvisoCep("");
    if (digitos.length !== 8) { setAvisoCep("Digite os 8 dígitos do CEP."); return; }
    setBuscandoCep(true);
    try {
      const r = await fetch(`/api/util/cep/${digitos}`, { credentials: "include" });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setAvisoCep(j?.error || "Não deu para buscar o CEP — preencha à mão.");
        if (j?.uf) set("uf", j.uf);
        return;
      }
      setMuitos({
        cep: cepBR(j.cep || digitos),
        endereco: j.endereco || f.endereco,
        bairro: j.bairro || f.bairro,
        cidade: j.cidade || f.cidade,
        uf: j.uf || f.uf,
      });
      setAvisoCep(
        j.parcial
          ? "Correios fora do ar: veio só a UF pela faixa do CEP. Confira o resto."
          : `Endereço preenchido.${j.faixa ? ` Correios: ${j.faixa}.` : ""} Falta o número${f.complemento ? "" : " e o complemento"}.`,
      );
      setTimeout(() => {
        const el = document.querySelector('[data-testid="input-ponto-numero"]') as HTMLInputElement | null;
        el?.focus();
      }, 0);
    } catch {
      setAvisoCep("Não deu para buscar o CEP — preencha à mão.");
    } finally {
      setBuscandoCep(false);
    }
  };

  /** Colar "-16.708, -49.239" (ou o link do Maps) em qualquer um dos dois
   *  campos preenche os DOIS. Só entra no caminho normal se não reconhecer. */
  const colarCoordenadas = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const txt = e.clipboardData?.getData("text") || "";
    const par = parseCoordenadas(txt);
    if (!par) return;
    e.preventDefault();
    setMuitos({ latitude: par.lat, longitude: par.lng });
  };
  /** Rede de segurança: digitou/colou o par por outro caminho, separa também. */
  const digitouCoordenada = (campo: "latitude" | "longitude", v: string) => {
    const par = /[,;\s]/.test(v.trim()) || v.includes("@") ? parseCoordenadas(v) : null;
    if (par) { setMuitos({ latitude: par.lat, longitude: par.lng }); return; }
    set(campo, v);
  };

  // Coordenada do próprio aparelho: quem cadastra costuma estar no ponto.
  const pegarGPS = () => {
    if (!navigator.geolocation) { setErro("Este navegador não informa a localização."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { set("latitude", pos.coords.latitude.toFixed(6)); set("longitude", pos.coords.longitude.toFixed(6)); },
      () => setErro("Não deu para ler a localização — digite as coordenadas ou tente de novo."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const salvar = async () => {
    setErro(""); setSalvando(true);
    try {
      const url = p ? `/api/carteira/redes/pontos/${p.id}` : `/api/carteira/redes/${props.redeId}/pontos`;
      const resp = await fetch(url, {
        method: p ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) { setErro(j?.error || "Não deu para salvar o ponto."); return; }
      props.onSalvo();
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onFechar(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{p ? "Editar ponto de entrega" : "Novo ponto de entrega"}</DialogTitle>
          <DialogDescription>
            Endereço sem CNPJ próprio. Não vira cliente — só passa a aparecer no seletor do pedido
            e no quadro LOCAL DE ENTREGA da nota.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-6 gap-3">
          <div className="col-span-6">
            <label className="text-xs text-muted-foreground">Nome do ponto *</label>
            <Input value={f.nome} onChange={(e) => set("nome", e.target.value)} placeholder="Ex.: Loja Shopping Flamboyant" data-testid="input-ponto-nome" />
          </div>
          {/* CEP vem ANTES do endereço: é por ele que se começa a preencher. */}
          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">CEP</label>
            <div className="flex gap-1">
              <Input
                value={f.cep}
                onChange={(e) => { set("cep", cepBR(e.target.value)); setAvisoCep(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); buscarCep(); } }}
                onBlur={() => { if (String(f.cep).replace(/\D/g, "").length === 8 && !f.endereco) buscarCep(); }}
                placeholder="74810-100"
                inputMode="numeric"
                data-testid="input-ponto-cep"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={buscarCep}
                disabled={buscandoCep}
                aria-label="Buscar endereço pelo CEP"
                title="Buscar endereço pelo CEP"
                data-testid="btn-buscar-cep"
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="col-span-3 flex items-end">
            {buscandoCep ? (
              <p className="text-xs text-muted-foreground pb-2">Buscando nos Correios…</p>
            ) : avisoCep ? (
              <p className="text-xs text-muted-foreground pb-2" data-testid="aviso-cep">{avisoCep}</p>
            ) : (
              <p className="text-xs text-muted-foreground pb-2">Preenche endereço, bairro, cidade e UF.</p>
            )}
          </div>
          <div className="col-span-4">
            <label className="text-xs text-muted-foreground">Endereço *</label>
            <Input value={f.endereco} onChange={(e) => set("endereco", e.target.value)} placeholder="Av. Deputado Jamel Cecílio" data-testid="input-ponto-endereco" />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Número</label>
            <Input value={f.numero} onChange={(e) => set("numero", e.target.value)} placeholder="3300" data-testid="input-ponto-numero" />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">Complemento</label>
            <Input value={f.complemento} onChange={(e) => set("complemento", e.target.value)} placeholder="Piso L2, quiosque 14" />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">Bairro</label>
            <Input value={f.bairro} onChange={(e) => set("bairro", e.target.value)} placeholder="Jardim Goiás" />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">Cidade *</label>
            <Input value={f.cidade} onChange={(e) => set("cidade", e.target.value)} placeholder="Goiânia" data-testid="input-ponto-cidade" />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">UF *</label>
            <Input value={f.uf} maxLength={2} onChange={(e) => set("uf", e.target.value.toUpperCase())} placeholder="GO" data-testid="input-ponto-uf" />
          </div>

          {/* Colar o par em QUALQUER um dos dois campos preenche os dois. É assim
              que a coordenada chega na prática: copiada do Google Maps de uma vez. */}
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Latitude</label>
            <Input
              value={f.latitude}
              onPaste={colarCoordenadas}
              onChange={(e) => digitouCoordenada("latitude", e.target.value)}
              placeholder="-16.708 (ou cole o par)"
              data-testid="input-ponto-lat"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Longitude</label>
            <Input
              value={f.longitude}
              onPaste={colarCoordenadas}
              onChange={(e) => digitouCoordenada("longitude", e.target.value)}
              placeholder="-49.239 (ou cole o par)"
              data-testid="input-ponto-lng"
            />
          </div>
          <div className="col-span-2 flex items-end">
            <Button type="button" variant="outline" className="w-full" onClick={pegarGPS} data-testid="btn-ponto-gps">
              <Crosshair className="h-4 w-4 mr-1" /> Usar minha localização
            </Button>
          </div>

          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">Contato no local</label>
            <Input value={f.contato} onChange={(e) => set("contato", e.target.value)} placeholder="Gerente da loja" />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">Telefone</label>
            <Input value={f.telefone} onChange={(e) => set("telefone", e.target.value)} placeholder="(62) 90000-0000" />
          </div>
          <div className="col-span-6">
            <label className="text-xs text-muted-foreground">Observação para a entrega</label>
            <Textarea value={f.observacao} onChange={(e) => set("observacao", e.target.value)} rows={2} placeholder="Recebe até as 10h pela doca de serviço." />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          A coordenada é o que coloca o ponto na rota certa — sem ela, a roteirização cai no
          endereço do cadastro do cliente. Dá para colar o par direto do Google Maps
          (<span className="font-mono">-16.708, -49.239</span> ou o link do mapa) em qualquer um dos dois campos.
        </p>
        {erro ? <p className="text-sm text-destructive">{erro}</p> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onFechar}>Cancelar</Button>
          <Button onClick={salvar} disabled={salvando} data-testid="btn-salvar-ponto">
            {salvando ? "Salvando…" : p ? "Salvar" : "Cadastrar ponto"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
