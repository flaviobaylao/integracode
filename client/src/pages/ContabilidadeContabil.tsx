import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import FiltroInstancia from "@/components/FiltroInstancia";
import SeletorMes from "@/components/SeletorMes";

// ═══════════════════════════════════════════════════════════════════════════
// CONTÁBIL — razão de estoque por período e por instância: saldo inicial,
// entradas, saídas, ajustes, saldo final e valorização pelo CMV do lote.
// Tela SOMENTE LEITURA.
// ═══════════════════════════════════════════════════════════════════════════

const n4 = (v: any) => (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
const brl = (v: any) =>
  v === null || v === undefined ? "—" : (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// O período padrão é o MÊS CORRENTE FECHADO (1º ao último dia), para o seletor
// de mês já abrir mostrando o nome do mês em vez de "Personalizado".
const p2 = (n: number) => String(n).padStart(2, "0");
const inicioDoMes = () => {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-01`;
};
const fimDoMes = () => {
  const d = new Date();
  const u = new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 0));
  return `${u.getUTCFullYear()}-${p2(u.getUTCMonth() + 1)}-${p2(u.getUTCDate())}`;
};

export default function ContabilidadeContabil() {
  const [inicio, setInicio] = useState(inicioDoMes());
  const [fim, setFim] = useState(fimDoMes());
  const [instancias, setInstancias] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [buscaAplicada, setBuscaAplicada] = useState("");
  const [mensal, setMensal] = useState(false);
  // Duas visões: produto acabado (inventory_lots) e insumo de produção (raw_materials).
  const [visao, setVisao] = useState<"produtos" | "insumos">("produtos");

  const params = new URLSearchParams({ inicio, fim });
  if (instancias.length) params.set("instancias", instancias.join(","));
  if (buscaAplicada) params.set("busca", buscaAplicada);
  if (mensal) params.set("mensal", "1");

  const razao = useQuery<any>({
    queryKey: ["/api/contabilidade/contabil/razao-estoque", params.toString()],
    queryFn: async () => {
      const r = await fetch(`/api/contabilidade/contabil/razao-estoque?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
      return r.json();
    },
  });

  const insumos = useQuery<any>({
    queryKey: ["/api/contabilidade/contabil/insumos", params.toString()],
    enabled: visao === "insumos",
    queryFn: async () => {
      const r = await fetch(`/api/contabilidade/contabil/insumos?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
      return r.json();
    },
  });

  const fonte = visao === "insumos" ? insumos : razao;
  const linhas: any[] = fonte.data?.linhas || [];
  const t = fonte.data?.totais;

  // Inventário mensal: o backend devolve um fechamento por mês com os saldos por
  // (produto, instância). Aqui viramos isso em uma linha por item e uma coluna por mês.
  const meses: string[] = (razao.data?.mensal || []).map((m: any) => m.fechamento);
  const linhasMensais = (() => {
    if (!mensal || visao !== "produtos" || !meses.length) return [] as any[];
    const idx = new Map<string, any>();
    for (const l of linhas) idx.set(`${l.produtoId}|${l.instanciaId}|${l.tipoEstoque}`, l);
    const mapa = new Map<string, any>();
    for (const m of razao.data.mensal) {
      for (const s of m.saldos) {
        const k = `${s.produtoId}|${s.instanciaId}|${s.tipoEstoque}`;
        const base = idx.get(k);
        if (!base) continue;
        let linha = mapa.get(k);
        if (!linha) { linha = { instancia: base.instancia, produto: base.produto, porMes: {} as any }; mapa.set(k, linha); }
        linha.porMes[m.fechamento] = s.saldo;
      }
    }
    return Array.from(mapa.values()).sort((a, b) =>
      String(a.instancia).localeCompare(String(b.instancia)) || String(a.produto).localeCompare(String(b.produto)));
  })();

  const baixarCsv = () => {
    const cab = ["Instancia", "Codigo", "Item", "Tipo", "SaldoInicial", "Entradas", "Saidas", "Ajustes", "BaixaNaoRegistrada", "SaldoFinal", "ConsumoEsperado", "CustoUnitario", "ValorFinal"];
    const corpo = linhas.map((l) => [
      l.instancia, l.codigo || "", l.produto, visao === "insumos" ? (l.categoria || "insumo") : l.tipoEstoque,
      l.saldoInicial, l.entradas, l.saidas, l.ajustes ?? "", l.baixaNaoRegistrada ?? 0, l.saldoFinal,
      l.consumoEsperado ?? "", l.custoUnitario ?? "", l.valorFinal ?? "",
    ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"));
    const blob = new Blob(["﻿" + [cab.join(";"), ...corpo].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `razao-${visao}-${inicio}-a-${fim}.csv`;
    a.click();
  };

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-4" data-testid="pagina-contabilidade-contabil">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Contábil</h1>
        <p className="text-sm text-gray-500 mt-1">
          Razão de estoque por período, de produtos acabados e de insumos de produção, com saldo inicial, movimentação, valorização e a reconstrução que impede saldo negativo.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <FiltroInstancia valor={instancias} aoMudar={setInstancias} />
          <div className="flex gap-1">
            {([["produtos", "Produtos acabados"], ["insumos", "Insumos de produção"]] as const).map(([k, rotulo]) => (
              <button
                key={k}
                onClick={() => setVisao(k as any)}
                className={`px-3 py-2 rounded-md text-sm border ${visao === k ? "bg-slate-800 text-white border-slate-800" : "bg-white border-gray-300 hover:bg-gray-50"}`}
                data-testid={`contabil-visao-${k}`}
              >
                {rotulo}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <SeletorMes
              inicio={inicio}
              fim={fim}
              aoMudar={(i, f) => { setInicio(i); setFim(f); }}
            />
            <div>
              <label className="block text-xs text-gray-500 mb-1">De</label>
              <Input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} className="w-40" data-testid="contabil-data-inicio" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Até</label>
              <Input type="date" value={fim} onChange={(e) => setFim(e.target.value)} className="w-40" data-testid="contabil-data-fim" />
            </div>
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs text-gray-500 mb-1">Buscar produto</label>
              <Input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setBuscaAplicada(busca)}
                placeholder="Nome ou código"
                data-testid="contabil-busca"
              />
            </div>
            <Button onClick={() => setBuscaAplicada(busca)} data-testid="contabil-aplicar">Aplicar</Button>
            <Button variant="outline" onClick={baixarCsv} disabled={!linhas.length} data-testid="contabil-csv">Baixar CSV</Button>
            {visao === "produtos" && (
              <label className="flex items-center gap-2 text-sm text-gray-700 select-none">
                <input type="checkbox" checked={mensal} onChange={(e) => setMensal(e.target.checked)} data-testid="contabil-mensal" />
                Inventário mensal (fechamento de cada mês)
              </label>
            )}
          </div>
        </CardContent>
      </Card>

      {[fonte.data?.avisoReconstrucao, fonte.data?.aviso, ...(fonte.data?.avisos || [])]
        .filter(Boolean)
        .map((a: string, k: number) => (
          <div key={k} className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-2" data-testid="contabil-aviso">
            {a}
          </div>
        ))}

      {t && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-2" data-testid="contabil-totais">
          {[
            ["Itens", `${t.itens}`],
            ["Saldo inicial", n4(t.saldoInicial)],
            ["Entradas", n4(t.entradas)],
            ["Saídas", n4(t.saidas)],
            ["Saldo final", n4(t.saldoFinal)],
            ["Baixa não registrada", n4(t.baixaNaoRegistrada || 0)],
            ["Valorização", `R$ ${brl(t.valorFinal)}`],
          ].map(([r, v]) => (
            <div key={r} className="bg-white border rounded-lg px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-gray-500">{r}</div>
              <div className="text-base font-semibold text-gray-900">{v}</div>
            </div>
          ))}
        </div>
      )}

      {mensal && meses.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">
              Inventário mensal — saldo no último dia de cada mês
            </div>
            <table className="w-full text-sm" data-testid="contabil-tabela-mensal">
              <thead className="bg-gray-50 text-gray-600">
                <tr className="text-left">
                  <th className="px-2 py-2 font-medium">Instância</th>
                  <th className="px-2 py-2 font-medium">Produto</th>
                  {meses.map((m) => (
                    <th key={m} className="px-2 py-2 font-medium text-right whitespace-nowrap">{m.slice(5, 7)}/{m.slice(0, 4)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {linhasMensais.map((l, k) => (
                  <tr key={k} className="border-t hover:bg-slate-50">
                    <td className="px-2 py-1.5 whitespace-nowrap">{l.instancia}</td>
                    <td className="px-2 py-1.5 max-w-[260px] truncate" title={l.produto}>{l.produto}</td>
                    {meses.map((m) => (
                      <td key={m} className="px-2 py-1.5 text-right">{n4(l.porMes[m] || 0)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {fonte.isLoading && <div className="p-6 text-sm text-gray-500">Reconstruindo o razão de estoque…</div>}
          {fonte.error && <div className="p-6 text-sm text-red-600">{String((fonte.error as any).message)}</div>}
          {!fonte.isLoading && !fonte.error && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr className="text-left">
                  {(visao === "insumos"
                    ? ["Instância", "Código", "Insumo", "Categoria", "Un.", "Saldo inicial", "Entradas", "Saídas", "Baixa não registrada", "Saldo final", "Consumo esperado", "Custo unit.", "Valor final"]
                    : ["Instância", "Código", "Produto", "Tipo", "Saldo inicial", "Entradas", "Saídas", "Ajustes", "Baixa não registrada", "Saldo final", "Custo unit.", "Valor final"]
                  ).map((h) => (
                    <th key={h} className="px-2 py-2 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, k) => (
                  <tr key={k} className="border-t hover:bg-slate-50" data-testid={`contabil-linha-${k}`}>
                    <td className="px-2 py-1.5 whitespace-nowrap">{l.instancia}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{l.codigo || "—"}</td>
                    <td className="px-2 py-1.5 max-w-[260px] truncate" title={l.produto}>{l.produto}</td>
                    {visao === "insumos" ? (
                      <>
                        <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{l.categoria || "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{l.unidade}</td>
                      </>
                    ) : (
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{l.tipoEstoque === "blocked" ? "Bloqueado" : "Em uso"}</td>
                    )}
                    <td className="px-2 py-1.5 text-right">{n4(l.saldoInicial)}</td>
                    <td className="px-2 py-1.5 text-right text-emerald-700">{n4(l.entradas)}</td>
                    <td className="px-2 py-1.5 text-right text-rose-700">{n4(l.saidas)}</td>
                    {visao === "produtos" && <td className="px-2 py-1.5 text-right">{n4(l.ajustes)}</td>}
                    <td className="px-2 py-1.5 text-right" title="Diferença entre os movimentos lançados e o saldo de hoje: saiu sem ser registrada.">
                      {l.baixaNaoRegistrada > 0
                        ? <span className="text-amber-700 font-medium">{n4(l.baixaNaoRegistrada)}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium">{n4(l.saldoFinal)}</td>
                    {visao === "insumos" && (
                      <td className="px-2 py-1.5 text-right text-gray-600" title="Quanto as vendas do período consumiriam deste insumo, pela ficha técnica.">
                        {l.consumoEsperado > 0 ? n4(l.consumoEsperado) : <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    <td className="px-2 py-1.5 text-right">{l.custoUnitario === null ? <span className="text-gray-400">—</span> : brl(l.custoUnitario)}</td>
                    <td className="px-2 py-1.5 text-right">{l.valorFinal === null ? <span className="text-gray-400">—</span> : brl(l.valorFinal)}</td>
                  </tr>
                ))}
                {linhas.length === 0 && (
                  <tr><td colSpan={13} className="px-4 py-8 text-center text-gray-500">Nenhum item com esses filtros.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
