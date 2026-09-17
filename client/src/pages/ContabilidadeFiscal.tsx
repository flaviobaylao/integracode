import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import FiltroInstancia from "@/components/FiltroInstancia";
import SeletorMes from "@/components/SeletorMes";

// ═══════════════════════════════════════════════════════════════════════════
// FISCAL — listagem unificada de notas emitidas e recebidas, com os tributos de
// cada nota na própria linha e os anexos (XML / DANFE) ao lado. Tela SOMENTE
// LEITURA: não altera nada, só consolida o que já existe no sistema.
// ═══════════════════════════════════════════════════════════════════════════

const brl = (v: any) =>
  (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dia = (v: any) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

// Padrão: ANO CORRENTE FECHADO, para o seletor de mês abrir em "Ano todo" em
// vez de "Personalizado". Datas futuras sem nota não mudam nada no resultado.
const primeiroDiaDoAno = `${new Date().getFullYear()}-01-01`;
const ultimoDiaDoAno = `${new Date().getFullYear()}-12-31`;

export default function ContabilidadeFiscal() {
  const [inicio, setInicio] = useState(primeiroDiaDoAno);
  const [fim, setFim] = useState(ultimoDiaDoAno);
  const [instancias, setInstancias] = useState<string[]>([]);
  const [tipo, setTipo] = useState<"todas" | "saida" | "entrada">("todas");
  const [busca, setBusca] = useState("");
  const [buscaAplicada, setBuscaAplicada] = useState("");
  const [aberta, setAberta] = useState<{ id: string; tipo: string } | null>(null);
  // SPED: exige UMA instância (cada CNPJ entrega o seu arquivo).
  const [sped, setSped] = useState<any>(null);
  const [gerandoSped, setGerandoSped] = useState(false);
  const [erroSped, setErroSped] = useState("");

  const params = new URLSearchParams({ inicio, fim, tipo });
  if (instancias.length) params.set("instancias", instancias.join(","));
  if (buscaAplicada) params.set("busca", buscaAplicada);

  const notas = useQuery<any>({
    queryKey: ["/api/contabilidade/fiscal/notas", params.toString()],
    queryFn: async () => {
      const r = await fetch(`/api/contabilidade/fiscal/notas?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
      return r.json();
    },
  });

  const itens = useQuery<any[]>({
    queryKey: ["/api/contabilidade/fiscal/nota/itens", aberta?.id, aberta?.tipo],
    enabled: !!aberta,
    queryFn: async () => {
      const r = await fetch(`/api/contabilidade/fiscal/nota/${aberta!.id}/itens?tipo=${aberta!.tipo}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const instanciaUnica = instancias.length === 1 ? instancias[0] : null;

  const gerarSped = async () => {
    if (!instanciaUnica) return;
    setGerandoSped(true);
    setErroSped("");
    setSped(null);
    try {
      const r = await fetch(`/api/contabilidade/fiscal/sped?instancia=${instanciaUnica}&inicio=${inicio}&fim=${fim}`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setSped(j);
    } catch (e: any) {
      setErroSped(e.message);
    } finally {
      setGerandoSped(false);
    }
  };

  const t = notas.data?.totais;
  const linhas: any[] = notas.data?.linhas || [];

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-4" data-testid="pagina-contabilidade-fiscal">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Fiscal</h1>
        <p className="text-sm text-gray-500 mt-1">
          Notas emitidas e recebidas com os tributos de cada documento, XML e DANFE por linha. Visão somente leitura.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <FiltroInstancia valor={instancias} aoMudar={setInstancias} />
          <div className="flex flex-wrap items-end gap-3">
            <SeletorMes
              inicio={inicio}
              fim={fim}
              aoMudar={(i, f) => { setInicio(i); setFim(f); }}
            />
            <div>
              <label className="block text-xs text-gray-500 mb-1">De</label>
              <Input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} className="w-40" data-testid="fiscal-data-inicio" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Até</label>
              <Input type="date" value={fim} onChange={(e) => setFim(e.target.value)} className="w-40" data-testid="fiscal-data-fim" />
            </div>
            <div className="flex gap-1">
              {(["todas", "saida", "entrada"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setTipo(k)}
                  className={`px-3 py-2 rounded-md text-sm border ${tipo === k ? "bg-slate-800 text-white border-slate-800" : "bg-white border-gray-300 hover:bg-gray-50"}`}
                  data-testid={`fiscal-tipo-${k}`}
                >
                  {k === "todas" ? "Todas" : k === "saida" ? "Emitidas" : "Recebidas"}
                </button>
              ))}
            </div>
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs text-gray-500 mb-1">Buscar (participante, número, CNPJ, chave)</label>
              <Input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setBuscaAplicada(busca)}
                placeholder="Digite e pressione Enter"
                data-testid="fiscal-busca"
              />
            </div>
            <Button onClick={() => setBuscaAplicada(busca)} data-testid="fiscal-aplicar">Aplicar</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3" data-testid="fiscal-sped">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium text-gray-900">SPED Fiscal — EFD ICMS/IPI</div>
              <div className="text-sm text-gray-500">
                Gera o arquivo do período com os blocos 0, C (saídas e entradas), E, G, H (inventário), K e 9.
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={gerarSped} disabled={!instanciaUnica || gerandoSped} data-testid="fiscal-sped-gerar">
                {gerandoSped ? "Gerando…" : "Gerar prévia"}
              </Button>
              {sped && (
                <a
                  href={`/api/contabilidade/fiscal/sped?instancia=${instanciaUnica}&inicio=${inicio}&fim=${fim}&download=1`}
                  className="inline-flex items-center px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700"
                  data-testid="fiscal-sped-baixar"
                >
                  Baixar .txt
                </a>
              )}
            </div>
          </div>

          {!instanciaUnica && (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Selecione <strong>uma</strong> instância no filtro acima. Cada CNPJ entrega o seu próprio SPED.
            </div>
          )}
          {erroSped && <div className="text-sm text-red-600">{erroSped}</div>}

          {sped && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                {[
                  ["Notas de saída", `${sped.resumo.notasSaida}`],
                  ["Notas de entrada", `${sped.resumo.notasEntrada}`],
                  ["Participantes", `${sped.resumo.participantes}`],
                  ["Itens no inventário", `${sped.resumo.itensInventario}`],
                  ["Valor do inventário", brl(sped.resumo.valorInventario)],
                  ["ICMS a pagar", brl(sped.resumo.icmsAPagar)],
                ].map(([r, v]) => (
                  <div key={r} className="bg-white border rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500">{r}</div>
                    <div className="text-base font-semibold text-gray-900">{v}</div>
                  </div>
                ))}
              </div>

              {sped.pendencias?.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                  <div className="text-sm font-medium text-amber-900 mb-1">
                    Pendências para o contador conferir antes de transmitir
                  </div>
                  <ul className="list-disc pl-5 text-sm text-amber-800 space-y-0.5">
                    {sped.pendencias.map((p: string, k: number) => <li key={k}>{p}</li>)}
                  </ul>
                </div>
              )}

              <details className="text-sm">
                <summary className="cursor-pointer text-gray-600">Ver as primeiras linhas do arquivo</summary>
                <pre className="mt-2 bg-gray-50 border rounded-lg p-3 overflow-x-auto text-[11px] leading-relaxed">
                  {sped.previa.join("\n")}
                </pre>
              </details>
            </div>
          )}
        </CardContent>
      </Card>

      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2" data-testid="fiscal-totais">
          {[
            ["Notas", `${notas.data.total}`],
            ["Emitidas", `${t.saidas}`],
            ["Recebidas", `${t.entradas}`],
            ["Produtos", brl(t.produtos)],
            ["Base ICMS", brl(t.baseIcms)],
            ["ICMS", brl(t.icms)],
            ["PIS/COFINS", brl(t.pis + t.cofins)],
            ["Total das notas", brl(t.nota)],
          ].map(([r, v]) => (
            <div key={r} className="bg-white border rounded-lg px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-gray-500">{r}</div>
              <div className="text-base font-semibold text-gray-900">{v}</div>
            </div>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {notas.isLoading && <div className="p-6 text-sm text-gray-500">Carregando notas…</div>}
          {notas.error && <div className="p-6 text-sm text-red-600">{String((notas.error as any).message)}</div>}
          {!notas.isLoading && !notas.error && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr className="text-left">
                  {["Tipo", "Emissão", "Número", "Instância", "Participante", "CFOP", "Produtos", "Base ICMS", "ICMS", "ICMS ST", "IPI", "PIS", "COFINS", "Total", "Anexos"].map((h) => (
                    <th key={h} className="px-2 py-2 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr
                    key={`${l.tipo}-${l.id}`}
                    className="border-t hover:bg-slate-50 cursor-pointer"
                    onClick={() => setAberta({ id: l.id, tipo: l.tipo })}
                    data-testid={`fiscal-linha-${l.id}`}
                  >
                    <td className="px-2 py-1.5">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] ${l.tipo === "saida" ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}`}>
                        {l.tipo === "saida" ? "Saída" : "Entrada"}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{dia(l.emissao)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{l.numero}{l.serie ? `/${l.serie}` : ""}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{l.instancia}</td>
                    <td className="px-2 py-1.5 max-w-[220px] truncate" title={l.participante || ""}>{l.participante || "—"}</td>
                    <td className="px-2 py-1.5">{l.cfop || "—"}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.produtos)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.baseIcms)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.icms)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.icmsSt)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.ipi)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.pis)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.cofins)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap font-medium">{brl(l.total)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {l.temXml && (
                        <a
                          href={`/api/contabilidade/fiscal/nota/${l.id}/xml?tipo=${l.tipo}`}
                          className="text-blue-600 hover:underline mr-2"
                          data-testid={`fiscal-xml-${l.id}`}
                        >XML</a>
                      )}
                      {l.tipo === "saida" && (
                        <a
                          href={`/api/contabilidade/fiscal/nota/${l.id}/danfe`}
                          className="text-blue-600 hover:underline"
                          data-testid={`fiscal-danfe-${l.id}`}
                        >DANFE</a>
                      )}
                      {!l.temXml && l.tipo === "entrada" && <span className="text-gray-400">—</span>}
                    </td>
                  </tr>
                ))}
                {linhas.length === 0 && (
                  <tr><td colSpan={15} className="px-4 py-8 text-center text-gray-500">Nenhuma nota no período com esses filtros.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {aberta && (
        <div className="fixed inset-0 bg-black/30 z-50 flex justify-end" onClick={() => setAberta(null)}>
          <div className="bg-white w-full max-w-4xl h-full overflow-y-auto p-5" onClick={(e) => e.stopPropagation()} data-testid="fiscal-painel-itens">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Itens da nota</h2>
              <Button variant="outline" onClick={() => setAberta(null)}>Fechar</Button>
            </div>
            {itens.isLoading && <div className="text-sm text-gray-500">Carregando itens…</div>}
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr className="text-left">
                  {["#", "Produto", "NCM", "CFOP", "Qtd", "Unit.", "Total", "ICMS", "PIS", "COFINS", "IPI"].map((h) => (
                    <th key={h} className="px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(itens.data || []).map((i: any, k: number) => (
                  <tr key={k} className="border-t">
                    <td className="px-2 py-1.5">{i.item}</td>
                    <td className="px-2 py-1.5 max-w-[240px] truncate" title={i.produto}>{i.produto}</td>
                    <td className="px-2 py-1.5">{i.ncm || "—"}</td>
                    <td className="px-2 py-1.5">{i.cfop || "—"}</td>
                    <td className="px-2 py-1.5 text-right">{brl(i.quantidade)}</td>
                    <td className="px-2 py-1.5 text-right">{brl(i.unitario)}</td>
                    <td className="px-2 py-1.5 text-right">{brl(i.total)}</td>
                    <td className="px-2 py-1.5 text-right">{i.icms ? brl(i.icms.valor) : "—"}</td>
                    <td className="px-2 py-1.5 text-right">{i.pis ? brl(i.pis.valor) : "—"}</td>
                    <td className="px-2 py-1.5 text-right">{i.cofins ? brl(i.cofins.valor) : "—"}</td>
                    <td className="px-2 py-1.5 text-right">{i.ipi ? brl(i.ipi.valor) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
