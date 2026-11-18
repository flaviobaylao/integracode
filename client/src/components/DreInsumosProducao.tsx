import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

// Rodape da DRE: insumos consumidos nas ordens de producao, mes a mes, com o total
// por Materia-prima e Embalagens. Clicar no numero de OPs de um mes abre cada ordem
// com os insumos que ela usou. Fonte: /api/financial/dre-insumos-op.
const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const brl = (v: any) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtNum = (v: number) => (!v ? "-" : v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
const fmtQtd = (v: number) => (!v ? "-" : v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
const GRUPO: Record<string, string> = { mp: "Matéria-prima", emb: "Embalagens", outros: "Outros" };

export default function DreInsumosProducao({ year }: { year: number }) {
  const [modo, setModo] = useState<"valor" | "qtd">("valor");
  const [mesAberto, setMesAberto] = useState<number | null>(null);
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/financial/dre-insumos-op", year],
    queryFn: () => fetch(`/api/financial/dre-insumos-op?year=${year}`, { credentials: "include" }).then((r) => r.json()),
  });

  if (isLoading) return <div className="text-xs text-muted-foreground py-4">Carregando insumos das ordens de produção…</div>;
  if (!data || !Array.isArray(data.grupos)) {
    return <div className="text-xs text-red-600 py-4">Não foi possível carregar os insumos das ordens de produção{data?.message ? `: ${data.message}` : ""}.</div>;
  }

  const grupos: any[] = data.grupos;
  const opsPorMes: number[] = data.opsPorMes || new Array(12).fill(0);
  const totalOps = opsPorMes.reduce((s, v) => s + v, 0);
  const cel = "px-2 py-1 text-right whitespace-nowrap tabular-nums";
  const nomeCel = "sticky left-0 bg-background px-2 py-1 whitespace-nowrap border-r min-w-[250px] max-w-[300px] truncate z-10";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">Insumos consumidos nas ordens de produção — {year}</h3>
          <p className="text-xs text-muted-foreground">
            Consumo e perdas lançados nas OPs, pelo dia do lançamento. Valor pelo custo gravado no movimento (ou o custo atual do insumo).
            Clique no número de OPs de um mês para ver cada ordem.
          </p>
        </div>
        <div className="flex rounded-md border overflow-hidden text-xs">
          <button className={`px-3 py-1 ${modo === "valor" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`} onClick={() => setModo("valor")}>Valor (R$)</button>
          <button className={`px-3 py-1 border-l ${modo === "qtd" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`} onClick={() => setModo("qtd")}>Quantidade</button>
        </div>
      </div>

      <div className="border rounded-lg overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted sticky top-0 z-20">
            <tr className="text-xs font-semibold">
              <th className="sticky left-0 bg-muted px-2 py-2 text-left border-r min-w-[250px] z-30">Insumo</th>
              {MESES.map((m) => <th key={m} className="px-2 py-2 text-right whitespace-nowrap min-w-[75px]">{m}</th>)}
              <th className="px-2 py-2 text-right whitespace-nowrap border-l min-w-[85px]">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr className="text-xs font-semibold bg-muted/30">
              <td className={`${nomeCel} bg-muted/30`}>Ordens de produção (qtd)</td>
              {opsPorMes.map((v, i) => (
                <td key={i} className={`${cel} ${v ? "cursor-pointer underline decoration-dotted hover:bg-accent/60" : ""}`}
                  onClick={v ? () => setMesAberto(i + 1) : undefined}
                  title={v ? `Ver as ${v} OPs de ${MESES[i]}/${year}` : undefined}>
                  {v || "-"}
                </td>
              ))}
              <td className={`${cel} border-l`}>{totalOps || "-"}</td>
            </tr>

            {grupos.map((g) => (
              <GrupoRows key={g.key} g={g} modo={modo} cel={cel} nomeCel={nomeCel} />
            ))}

            <tr className="text-xs font-bold bg-green-50 dark:bg-green-950/30 border-t-2 border-b">
              <td className={nomeCel}>Total de insumos consumidos (R$)</td>
              {(data.total as number[]).map((v, i) => <td key={i} className={cel}>{fmtNum(v)}</td>)}
              <td className={`${cel} border-l`}>{fmtNum(data.totalAno)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {mesAberto && (
        <OpsDoMesModal
          mes={mesAberto}
          year={year}
          ops={(data.ops || []).filter((o: any) => o.mes === mesAberto)}
          onClose={() => setMesAberto(null)}
        />
      )}
    </div>
  );
}

function GrupoRows({ g, modo, cel, nomeCel }: { g: any; modo: "valor" | "qtd"; cel: string; nomeCel: string }) {
  return (
    <>
      <tr className="text-xs font-semibold bg-muted/30">
        <td colSpan={14} className="sticky left-0 bg-muted/30 px-2 py-1.5 z-10">{g.nome}</td>
      </tr>
      {g.itens.length === 0 && (
        <tr className="text-xs text-muted-foreground"><td className={nomeCel}>Nenhum consumo lançado</td><td colSpan={13}></td></tr>
      )}
      {g.itens.map((it: any) => (
        <tr key={it.id} className="text-xs hover:bg-accent/20">
          <td className={nomeCel} title={`${it.nome}${it.codigo ? ` (${it.codigo})` : ""}`}>
            {it.nome}{modo === "qtd" && it.unidade ? <span className="text-muted-foreground"> ({it.unidade})</span> : null}
          </td>
          {(modo === "valor" ? it.valor : it.qtd).map((v: number, i: number) => (
            <td key={i} className={cel} title={modo === "valor" ? `${fmtQtd(it.qtd[i])} ${it.unidade || ""}` : brl(it.valor[i])}>
              {modo === "valor" ? fmtNum(v) : fmtQtd(v)}
            </td>
          ))}
          <td className={`${cel} border-l font-medium`}>{modo === "valor" ? fmtNum(it.valorTotal) : fmtQtd(it.qtdTotal)}</td>
        </tr>
      ))}
      <tr className="text-xs font-bold border-t border-b bg-muted/50">
        <td className={`${nomeCel} bg-muted/50`}>Total {g.nome} (R$)</td>
        {(g.valor as number[]).map((v, i) => <td key={i} className={cel}>{fmtNum(v)}</td>)}
        <td className={`${cel} border-l`}>{fmtNum(g.total)}</td>
      </tr>
    </>
  );
}

function OpsDoMesModal({ mes, year, ops, onClose }: { mes: number; year: number; ops: any[]; onClose: () => void }) {
  const soma = (k: string) => ops.reduce((s, o) => s + (Number(o[k]) || 0), 0);
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl max-w-5xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <div className="font-bold">Ordens de produção — {MESES[mes - 1]}/{year}</div>
            <div className="text-xs text-muted-foreground">
              {ops.length} OP(s) · Matéria-prima {brl(soma("mp"))} · Embalagens {brl(soma("emb"))}
              {soma("outros") ? ` · Outros ${brl(soma("outros"))}` : ""} · Total {brl(soma("total"))}
            </div>
          </div>
          <button className="text-2xl leading-none px-2 hover:text-red-600" onClick={onClose}>×</button>
        </div>
        <div className="overflow-auto p-3 space-y-3">
          {ops.length === 0 && <div className="text-center text-muted-foreground py-10">Nenhuma OP neste mês.</div>}
          {ops.map((o) => (
            <div key={o.id} className="border rounded-md">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 bg-muted/40 text-xs">
                <div>
                  <span className="font-bold">OP {o.op}</span> · {o.produto || "—"}
                  {o.lote ? ` · Lote ${o.lote}` : ""}
                  {o.quantidade ? ` · ${fmtQtd(o.quantidade)} un` : ""}
                  {o.dataProducao ? ` · Produção ${o.dataProducao.split("-").reverse().join("/")}` : ""}
                  {o.status ? ` · ${o.status}` : ""}
                </div>
                <div className="tabular-nums">
                  MP {brl(o.mp)} · Emb {brl(o.emb)}{o.outros ? ` · Outros ${brl(o.outros)}` : ""} · <span className="font-bold">Total {brl(o.total)}</span>
                </div>
              </div>
              <table className="text-xs w-full">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-3 py-1">Insumo</th><th className="px-2 py-1">Grupo</th>
                    <th className="px-2 py-1 text-right">Quantidade</th><th className="px-2 py-1 text-right">Custo unit.</th>
                    <th className="px-3 py-1 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {o.insumos.map((i: any, k: number) => (
                    <tr key={k} className="border-b last:border-0">
                      <td className="px-3 py-1">{i.material}{i.perda ? <span className="ml-1 text-red-600">(perda)</span> : null}</td>
                      <td className="px-2 py-1">{GRUPO[i.grupo] || i.grupo}</td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{fmtQtd(i.quantidade)} {i.unidade}</td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{brl(i.custoUnit)}</td>
                      <td className="px-3 py-1 text-right tabular-nums whitespace-nowrap">{brl(i.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
