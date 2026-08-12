import React, { useEffect, useMemo, useState } from "react";
import { hojeBR, inicioDoMes, diaMaisBR } from '@shared/tempo';
import * as XLSX from "xlsx";
import BackToDashboardButton from "@/components/BackToDashboardButton";

// ---------------------------------------------------------------------------
// RELATÓRIOS DE CONCILIAÇÃO BANCÁRIA — módulo fixo (não é export avulso).
// Uma página com ABAS, cada aba é um relatório que fica no sistema:
//   1. Resumo & Saldo ....... fechamento do saldo + conferência com o extrato
//   2. Movimentações ........ extrato conciliado (entradas/saídas + saldo corrido)
//   3. Recebidos ............ títulos de clientes baixados pela conciliação
//   4. Pagos ................ títulos de fornecedores baixados pela conciliação
//   5. Automáticos .......... recebimentos compensados por WEBHOOK (boleto BB,
//                             PIX, cartão/hotsite) + conferência dia a dia da
//                             cobrança de boletos contra o crédito "COBRANCA"
//                             do extrato. NÃO entra no saldo (ver nota abaixo).
//   6. Pendentes ............ lançamentos do banco ainda sem título
//   7. Categorias ........... movimento por plano de contas
//   8. Histórico mensal ..... série fixa mês a mês da conta (todo o período)
//
// REGRA DE OURO da aba 5: o saldo (entradas − saídas) continua vindo SÓ do
// extrato. Recebimento que o webhook já baixou mas que ainda não apareceu no
// OFX é mostrado à parte ("fora do extrato") — somá-lo ao saldo contaria o
// mesmo dinheiro duas vezes quando o extrato do dia for importado.
// Cada aba exporta a SI MESMA (Excel/CSV) e há o "Excel completo" com tudo.
// Fonte: GET /api/reconciliation/report (read-only, nada é escrito no banco).
// ---------------------------------------------------------------------------

type Conta = { id: string; name: string; omie_instance_id: string | null };

const brl = (v: any) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const brlNum = (v: any) => Number(Number(v || 0).toFixed(2));
const dt = (d: any) => {
  if (!d) return "—";
  const s = String(d).slice(0, 10).split("-");
  return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : String(d);
};
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const fmtMes = (m: string) => {
  const [y, mo] = String(m || "").split("-");
  return `${MESES[(parseInt(mo, 10) || 1) - 1]}/${(y || "").slice(2)}`;
};
const isoHoje = () => hojeBR();
const isoPrimeiroDiaMes = () => inicioDoMes(hojeBR());
const fmtDoc = (v: any) => {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return d || "";
};

const SIT: Record<string, { label: string; cls: string }> = {
  reconciled: { label: "Conciliado", cls: "bg-green-100 text-green-800 border-green-200" },
  pending: { label: "Pendente", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  ignored: { label: "Ignorado", cls: "bg-gray-100 text-gray-600 border-gray-200" },
};

const ABAS = [
  { id: "resumo", label: "Resumo & Saldo", icone: "📊" },
  { id: "movimentacoes", label: "Movimentações", icone: "📄" },
  { id: "recebidos", label: "Recebidos", icone: "🟢" },
  { id: "pagos", label: "Pagos", icone: "🔴" },
  { id: "automaticos", label: "Recebidos automáticos", icone: "⚡" },
  { id: "pendentes", label: "Pendentes", icone: "⏳" },
  { id: "categorias", label: "Categorias", icone: "🗂️" },
  { id: "mensal", label: "Histórico mensal", icone: "📅" },
];

function Kpi({ titulo, valor, sub, tom }: { titulo: string; valor: string; sub?: string; tom?: string }) {
  const tons: Record<string, string> = {
    verde: "text-green-700", vermelho: "text-red-700", azul: "text-blue-700", cinza: "text-gray-800",
  };
  return (
    <div className="border rounded-lg bg-white p-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{titulo}</div>
      <div className={`text-lg font-bold ${tons[tom || "cinza"]}`}>{valor}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Bloco({ titulo, acao, children }: { titulo: string; acao?: any; children: any }) {
  return (
    <div className="border rounded-lg bg-white print-break">
      <div className="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold">{titulo}</div>
        {acao && <div className="flex gap-2 items-center no-print">{acao}</div>}
      </div>
      {children}
    </div>
  );
}

function BotaoExport({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick}
      className="px-2.5 py-1 border rounded text-xs bg-white hover:bg-gray-50"
      data-testid={`button-export-${label.toLowerCase().replace(/\W+/g, "-")}`}>
      {label}
    </button>
  );
}

// baixa uma aba de dados como .xlsx
const baixarXlsx = (linhas: any[], aba: string, nome: string) => {
  try {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas.length ? linhas : [{ Aviso: "sem dados no período" }]), aba.slice(0, 31));
    XLSX.writeFile(wb, /\.xlsx$/i.test(nome) ? nome : nome + ".xlsx");
  } catch (e) { console.error(e); alert("Falha ao exportar para Excel."); }
};
// baixa uma aba de dados como .csv (; + BOM, abre no Excel pt-BR)
const baixarCsv = (linhas: any[], nome: string) => {
  if (!linhas.length) { alert("Sem dados para exportar."); return; }
  const cab = Object.keys(linhas[0]);
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "﻿" + [cab, ...linhas.map((l) => cab.map((c) => l[c]))].map((l) => l.map(esc).join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = /\.csv$/i.test(nome) ? nome : nome + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

// Props: quando embutido na tela de Conciliação Bancária, recebe a conta já
// escolhida lá em cima e esconde o cabeçalho/voltar (a página hospedeira já tem).
export default function RelatorioConciliacao(props: {
  contaInicial?: string;
  embutido?: boolean;
} = {}) {
  const { contaInicial, embutido } = props;
  const [contas, setContas] = useState<Conta[]>([]);
  const [contaId, setContaId] = useState<string>(contaInicial || "");
  const [de, setDe] = useState<string>(isoPrimeiroDiaMes());
  const [ate, setAte] = useState<string>(isoHoje());
  const [saldoInicialManual, setSaldoInicialManual] = useState<string>("");
  const [dados, setDados] = useState<any>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string>("");
  const [filtro, setFiltro] = useState<string>("");
  const [situacao, setSituacao] = useState<string>("todas");
  const [aba, setAba] = useState<string>("resumo");

  useEffect(() => {
    fetch("/api/reconciliation/filters", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        const acc: Conta[] = Array.isArray(d?.accounts) ? d.accounts : [];
        setContas(acc);
        if (acc.length && !contaId) setContaId(contaInicial || acc[0].id);
      })
      .catch(() => setErro("Não foi possível carregar as contas bancárias."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const carregar = async (cid = contaId) => {
    if (!cid) return;
    setCarregando(true);
    setErro("");
    try {
      const qs = new URLSearchParams({ accountId: cid, from: de, to: ate });
      if (saldoInicialManual.trim() !== "") qs.set("saldoInicial", saldoInicialManual.replace(",", "."));
      const r = await fetch(`/api/reconciliation/report?${qs.toString()}`, { credentials: "include", cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "falha ao gerar o relatório");
      setDados(d);
    } catch (e: any) {
      setErro(String(e?.message || e));
      setDados(null);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    if (contaId) carregar(contaId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contaId]);

  // conta trocada na tela hospedeira (Conciliação Bancária) -> segue a seleção
  useEffect(() => {
    if (contaInicial && contaInicial !== contaId) setContaId(contaInicial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contaInicial]);

  const periodoRapido = (tipo: string) => {
    const h = new Date();
    if (tipo === "mes") { setDe(new Date(h.getFullYear(), h.getMonth(), 1).toISOString().slice(0, 10)); setAte(isoHoje()); }
    else if (tipo === "mesPassado") { setDe(new Date(h.getFullYear(), h.getMonth() - 1, 1).toISOString().slice(0, 10)); setAte(new Date(h.getFullYear(), h.getMonth(), 0).toISOString().slice(0, 10)); }
    else if (tipo === "30") { setDe(new Date(h.getTime() - 29 * 86400000).toISOString().slice(0, 10)); setAte(isoHoje()); }
    else if (tipo === "ano") { setDe(new Date(h.getFullYear(), 0, 1).toISOString().slice(0, 10)); setAte(isoHoje()); }
  };

  // ---- dados derivados ----------------------------------------------------
  const itens: any[] = dados?.itens || [];
  const r = dados?.resumo || {};
  const st = dados?.status || {};
  const tit = dados?.titulos || {};
  const bate = r?.bate;
  const sufixo = `${de}_a_${ate}`;

  const itensFiltrados = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return itens.filter((i: any) => {
      if (situacao !== "todas" && (i.status || "pending") !== situacao) return false;
      if (!f) return true;
      const texto = [i.contraparte, i.historico, i.descricao, i.documento, i.docBanco,
        ...(i.titulos || []).map((t: any) => `${t.titulo || ""} ${t.nome || ""} ${t.categoria || ""}`)]
        .join(" ").toLowerCase();
      return texto.includes(f) || String(i.valor).includes(f);
    });
  }, [itens, filtro, situacao]);

  const totFiltrado = useMemo(() => ({
    entradas: itensFiltrados.reduce((a, i) => a + Number(i.entrada || 0), 0),
    saidas: itensFiltrados.reduce((a, i) => a + Number(i.saida || 0), 0),
  }), [itensFiltrados]);

  // títulos achatados (uma linha por título baixado) — abas Recebidos / Pagos
  const titulosFlat = useMemo(() => {
    const out: any[] = [];
    for (const i of itens) for (const t of (i.titulos || [])) out.push({ ...t, _data: i.data, _contraparte: i.contraparte, _itemValor: i.valor, _tipo: i.tipo });
    return out;
  }, [itens]);
  const recebidos = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return titulosFlat.filter((t) => t.especie === "receber" &&
      (!f || `${t.titulo || ""} ${t.nome || ""} ${t.categoria || ""} ${t._contraparte || ""}`.toLowerCase().includes(f)));
  }, [titulosFlat, filtro]);
  const pagos = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return titulosFlat.filter((t) => t.especie === "pagar" &&
      (!f || `${t.titulo || ""} ${t.nome || ""} ${t.categoria || ""} ${t._contraparte || ""}`.toLowerCase().includes(f)));
  }, [titulosFlat, filtro]);
  const pendentes = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return itens.filter((i: any) => (i.status || "pending") === "pending" &&
      (!f || `${i.contraparte || ""} ${i.historico || ""} ${i.descricao || ""}`.toLowerCase().includes(f)));
  }, [itens, filtro]);

  // ---- linhas para exportação (mesma estrutura da tela) -------------------
  const linhasResumo = () => ([
    { Campo: "Conta", Valor: dados?.conta?.nome || "" },
    { Campo: "Banco", Valor: dados?.conta?.banco || "" },
    { Campo: "Agência / Conta", Valor: `${dados?.conta?.agencia || ""} ${dados?.conta?.numero || ""}`.trim() },
    { Campo: "Período", Valor: `${dt(dados?.periodo?.de)} a ${dt(dados?.periodo?.ate)}` },
    { Campo: "Saldo inicial", Valor: brlNum(r.saldoInicial) },
    { Campo: "Entradas (créditos)", Valor: brlNum(r.entradas) },
    { Campo: "Saídas (débitos)", Valor: brlNum(r.saidas) },
    { Campo: "Resultado do período", Valor: brlNum(r.resultado) },
    { Campo: "Saldo final calculado", Valor: brlNum(r.saldoFinalCalculado) },
    { Campo: "Saldo do banco (extrato)", Valor: r.saldoBanco == null ? "—" : brlNum(r.saldoBanco) },
    { Campo: "Data do saldo do banco", Valor: r.saldoBancoData ? dt(r.saldoBancoData) : "—" },
    { Campo: "Diferença", Valor: r.diferenca == null ? "—" : brlNum(r.diferenca) },
    { Campo: "Bate com o extrato?", Valor: bate == null ? "sem saldo do banco" : bate ? "SIM" : "NÃO" },
    { Campo: "Conciliados (qtd)", Valor: st?.conciliados?.qtd || 0 },
    { Campo: "Pendentes (qtd)", Valor: st?.pendentes?.qtd || 0 },
    { Campo: "Ignorados (qtd)", Valor: st?.ignorados?.qtd || 0 },
    { Campo: "Recebido (títulos)", Valor: brlNum(tit?.recebido?.valor) },
    { Campo: "Pago (títulos)", Valor: brlNum(tit?.pago?.valor) },
  ]);
  const linhasConferencia = () => (dados?.conferencia || []).map((c: any) => ({
    Data: dt(c.data),
    "Saldo do banco": brlNum(c.saldoBanco),
    "Saldo calculado": brlNum(c.saldoCalculado),
    Diferença: brlNum(c.diferenca),
    Situação: c.calibracao ? "SALDO BASE (calibração)" : Math.abs(Number(c.diferenca || 0)) < 0.01 ? "BATE" : "DIVERGE",
    Arquivo: c.arquivo || "",
  }));
  const linhasMovimentacoes = () => itensFiltrados.map((i: any) => ({
    Data: dt(i.data), Tipo: i.tipo === "C" ? "Entrada" : "Saída",
    Histórico: i.historico || "", Contraparte: i.contraparte || "", "CPF/CNPJ": fmtDoc(i.documento), Hora: i.hora || "",
    Entrada: i.entrada ? brlNum(i.entrada) : "", Saída: i.saida ? brlNum(i.saida) : "", Saldo: brlNum(i.saldo),
    Situação: (SIT[i.status || "pending"] || SIT.pending).label,
    Títulos: (i.titulos || []).map((t: any) => `${t.especie === "receber" ? "REC" : "PAG"} ${t.titulo || "s/nº"} · ${t.nome || ""} · ${brl(t.valor)}`).join(" | "),
    Categoria: (i.titulos || []).map((t: any) => t.categoria).filter(Boolean).join(" | "),
    Juros: brlNum((i.titulos || []).reduce((a: number, t: any) => a + Number(t.juros || 0), 0)),
    Desconto: brlNum((i.titulos || []).reduce((a: number, t: any) => a + Number(t.desconto || 0), 0)),
    Extrato: i.arquivo || "", Observação: i.observacao || "",
  }));
  const linhasTitulos = (lista: any[], rotulo: string) => lista.map((t: any) => ({
    "Data no banco": dt(t._data), [rotulo]: t.nome || "", "CPF/CNPJ": fmtDoc(t.documento),
    Título: t.titulo || "", Vencimento: t.vencimento ? dt(t.vencimento) : "",
    "Valor do título": brlNum(t.valorTitulo), "Valor conciliado": brlNum(t.valor),
    Juros: brlNum(t.juros), Desconto: brlNum(t.desconto), "Baixado": brlNum(t.baixado),
    Categoria: t.categoria || "", "Lançamento no banco": t._contraparte || "", Origem: t.origem || "",
  }));
  const linhasPendentes = () => pendentes.map((i: any) => ({
    Data: dt(i.data), Tipo: i.tipo === "C" ? "Entrada" : "Saída",
    Contraparte: i.contraparte || "", Histórico: i.historico || "", "CPF/CNPJ": fmtDoc(i.documento),
    Valor: brlNum(i.valor), Extrato: i.arquivo || "",
  }));
  // ---- recebimentos compensados por WEBHOOK (boleto BB, PIX, cartão, ...) --
  const auto = dados?.recebimentosAutomaticos || null;
  const cobr = dados?.cobrancaBoletos || null;
  const SIT_COBR: Record<string, { label: string; cls: string }> = {
    bate: { label: "✅ bate", cls: "text-green-700" },
    diverge: { label: "❌ diverge", cls: "text-red-700" },
    aguardando_extrato: { label: "⏳ aguardando extrato", cls: "text-amber-700" },
    so_extrato: { label: "só no extrato", cls: "text-gray-600" },
  };
  const automaticos = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return ((auto?.itens || []) as any[])
      .filter((x) => x.automatica)
      .filter((x) => !f || `${x.titulo || ""} ${x.nome || ""} ${x.origemRotulo || ""} ${x.referencia || ""}`.toLowerCase().includes(f));
  }, [auto, filtro]);
  const linhasAutomaticos = () => automaticos.map((x: any) => ({
    Data: dt(x.data), Origem: x.origemRotulo || x.origem, "Forma": x.formaPagamento || "",
    Cliente: x.nome || "", "CPF/CNPJ": fmtDoc(x.documento), Título: x.titulo || "",
    Vencimento: x.vencimento ? dt(x.vencimento) : "",
    "Valor do título": x.valorTitulo == null ? "" : brlNum(x.valorTitulo),
    "Valor recebido": brlNum(x.valor), Categoria: x.categoria || "",
    "No extrato?": x.noExtrato ? "SIM" : "NÃO (aguardando)",
    "Como casou": x.casamento || "", Referência: x.referencia || "", Observação: x.observacao || "",
  }));
  const linhasCobranca = () => ((cobr?.linhas || []) as any[]).map((l) => ({
    Data: dt(l.data), "Boletos recebidos (qtd)": l.qtdBoletos, "Valor recebido (webhook)": brlNum(l.valorBoletos),
    'Créditos "COBRANCA" (qtd)': l.qtdCreditos, "Valor no extrato": brlNum(l.valorExtrato),
    Diferença: brlNum(l.diferenca), Situação: (SIT_COBR[l.situacao] || { label: l.situacao }).label,
  }));

  const linhasCategorias = () => (dados?.porCategoria || []).map((c: any) => ({
    Categoria: c.categoria, Entradas: brlNum(c.entradas), Saídas: brlNum(c.saidas), Lançamentos: c.qtd,
  }));
  const linhasMensal = () => (dados?.porMes || []).map((m: any) => ({
    Mês: fmtMes(m.mes), Entradas: brlNum(m.entradas), Saídas: brlNum(m.saidas), Resultado: brlNum(m.resultado),
    "Saldo no fim do mês": brlNum(m.saldoFinal),
    "Saldo do banco": m.saldoBanco == null ? "—" : brlNum(m.saldoBanco),
    Diferença: m.diferenca == null ? "—" : brlNum(m.diferenca),
    Lançamentos: m.qtd, Conciliados: m.conciliados, Pendentes: m.pendentes, Ignorados: m.ignorados,
    "Valor pendente": brlNum(m.valorPendente),
  }));

  const exportarTudo = () => {
    if (!dados) return;
    try {
      const wb = XLSX.utils.book_new();
      const add = (nome: string, linhas: any[]) =>
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas.length ? linhas : [{ Aviso: "sem dados" }]), nome);
      add("Resumo", linhasResumo());
      add("Conferência", linhasConferencia());
      add("Movimentações", linhasMovimentacoes());
      add("Recebidos", linhasTitulos(recebidos, "Cliente"));
      add("Pagos", linhasTitulos(pagos, "Fornecedor"));
      add("Recebidos automáticos", linhasAutomaticos());
      add("Cobrança x extrato", linhasCobranca());
      add("Pendentes", linhasPendentes());
      add("Categorias", linhasCategorias());
      add("Histórico mensal", linhasMensal());
      XLSX.writeFile(wb, `Conciliacao_${String(dados?.conta?.nome || "conta").replace(/[^\w]+/g, "_")}_${sufixo}.xlsx`);
    } catch (e) { console.error(e); alert("Falha ao exportar para Excel."); }
  };

  const abaAtual = ABAS.find((a) => a.id === aba) || ABAS[0];
  const contagemAba: Record<string, number> = {
    movimentacoes: itens.length, recebidos: recebidos.length, pagos: pagos.length,
    automaticos: automaticos.length,
    pendentes: pendentes.length, categorias: (dados?.porCategoria || []).length, mensal: (dados?.porMes || []).length,
  };

  return (
    <div className={`${embutido ? "space-y-3" : "p-4 space-y-3"} print:p-0`}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; }
          table { font-size: 10px; }
          .print-break { page-break-inside: avoid; }
        }
      `}</style>

      {!embutido && <div className="no-print"><BackToDashboardButton /></div>}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          {!embutido && <h1 className="text-xl font-bold">🏦 Relatórios de Conciliação Bancária</h1>}
          <p className="text-sm text-gray-600">
            Movimentações de entrada e saída, o que foi recebido e pago, e o saldo da conta batendo com o extrato do banco.
          </p>
        </div>
        <div className="flex gap-2 no-print">
          <button onClick={exportarTudo} disabled={!dados}
            className="px-3 py-2 border rounded-md text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            data-testid="button-export-tudo">Excel completo (10 abas)</button>
          <button onClick={() => window.print()} disabled={!dados}
            className="px-3 py-2 border rounded-md text-sm bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-40"
            data-testid="button-print">Imprimir / PDF</button>
        </div>
      </div>

      {/* Filtros */}
      <div className="border rounded-lg bg-white p-3 space-y-2 no-print">
        <div className="flex gap-2 flex-wrap items-end">
          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Conta bancária</label>
            <select value={contaId} onChange={(e) => setContaId(e.target.value)}
              className="border rounded px-2 py-1.5 text-sm min-w-[220px]" data-testid="select-conta">
              {contas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-1">De</label>
            <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
              className="border rounded px-2 py-1.5 text-sm" data-testid="input-de" />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Até</label>
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
              className="border rounded px-2 py-1.5 text-sm" data-testid="input-ate" />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Saldo inicial (opcional)</label>
            <input type="text" value={saldoInicialManual} placeholder="deduzido do extrato"
              onChange={(e) => setSaldoInicialManual(e.target.value)}
              className="border rounded px-2 py-1.5 text-sm w-40" data-testid="input-saldo-inicial" />
          </div>
          <button onClick={() => carregar()} disabled={carregando || !contaId}
            className="px-4 py-2 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            data-testid="button-gerar">{carregando ? "Atualizando…" : "Atualizar"}</button>
          <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Buscar nome, título, valor…"
            className="border rounded px-2 py-1.5 text-sm w-56 ml-auto" data-testid="input-busca" />
        </div>
        <div className="flex gap-1.5 flex-wrap text-xs">
          <span className="text-gray-500 py-1">Período:</span>
          <button onClick={() => periodoRapido("mes")} className="px-2 py-1 border rounded hover:bg-gray-50">Mês atual</button>
          <button onClick={() => periodoRapido("mesPassado")} className="px-2 py-1 border rounded hover:bg-gray-50">Mês passado</button>
          <button onClick={() => periodoRapido("30")} className="px-2 py-1 border rounded hover:bg-gray-50">Últimos 30 dias</button>
          <button onClick={() => periodoRapido("ano")} className="px-2 py-1 border rounded hover:bg-gray-50">Ano</button>
          <span className="text-gray-400 py-1">· o Histórico mensal mostra a conta inteira, independente do período</span>
        </div>
      </div>

      {erro && <div className="border border-red-200 bg-red-50 text-red-700 rounded p-3 text-sm">Erro: {erro}</div>}
      {carregando && <div className="text-sm text-gray-500">Carregando lançamentos…</div>}

      {dados && (
        <>
          {/* Cabeçalho do relatório (também na impressão) */}
          <div className="border rounded-lg bg-white p-3 print-break">
            <div className="flex justify-between flex-wrap gap-2">
              <div>
                <div className="font-semibold">{dados?.conta?.nome}</div>
                <div className="text-xs text-gray-600">
                  {[dados?.conta?.banco, dados?.conta?.agencia && `Ag. ${dados.conta.agencia}`, dados?.conta?.numero && `C/C ${dados.conta.numero}`]
                    .filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <div className="text-right text-xs text-gray-600">
                <div>Período: <b>{dt(dados?.periodo?.de)}</b> a <b>{dt(dados?.periodo?.ate)}</b></div>
                <div>{itens.length} lançamento(s) · relatório: <b>{abaAtual.label}</b> · emitido em {dt(isoHoje())}</div>
              </div>
            </div>
          </div>

          {(dados?.avisos || []).map((a: string, k: number) => (
            <div key={k} className="border border-amber-200 bg-amber-50 text-amber-800 rounded p-2.5 text-xs">⚠️ {a}</div>
          ))}

          {/* ABAS */}
          <div className="flex gap-1 flex-wrap border-b no-print">
            {ABAS.map((a) => (
              <button key={a.id} onClick={() => setAba(a.id)}
                className={`px-3 py-2 text-sm rounded-t-md border border-b-0 -mb-px ${
                  aba === a.id ? "bg-white font-semibold text-blue-700 border-gray-300" : "bg-gray-50 text-gray-600 border-transparent hover:bg-gray-100"}`}
                data-testid={`tab-${a.id}`}>
                {a.icone} {a.label}
                {contagemAba[a.id] != null && <span className="ml-1 text-[10px] text-gray-400">({contagemAba[a.id]})</span>}
              </button>
            ))}
          </div>

          {/* ---------------- ABA: RESUMO & SALDO ---------------- */}
          {aba === "resumo" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 print-break">
                <Kpi titulo="Saldo inicial" valor={brl(r.saldoInicial)} sub={`em ${dt(dados?.periodo?.de)}`} />
                <Kpi titulo="Entradas" valor={brl(r.entradas)} sub={`${r.qtdEntradas || 0} crédito(s)`} tom="verde" />
                <Kpi titulo="Saídas" valor={brl(r.saidas)} sub={`${r.qtdSaidas || 0} débito(s)`} tom="vermelho" />
                <Kpi titulo="Resultado" valor={brl(r.resultado)} sub="entradas − saídas" tom={Number(r.resultado) >= 0 ? "verde" : "vermelho"} />
                <Kpi titulo="Saldo final calculado" valor={brl(r.saldoFinalCalculado)} sub={`em ${dt(dados?.periodo?.ate)}`} tom="azul" />
                <div className={`border rounded-lg p-3 ${bate == null ? "bg-gray-50" : bate ? "bg-green-50 border-green-300" : "bg-red-50 border-red-300"}`}>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Saldo do banco</div>
                  <div className="text-lg font-bold">{r.saldoBanco == null ? "—" : brl(r.saldoBanco)}</div>
                  <div className="text-[11px] text-gray-600">
                    {r.saldoBanco == null ? "sem saldo no extrato importado" : (
                      <>extrato de {dt(r.saldoBancoData)} · diferença <b className={bate ? "text-green-700" : "text-red-700"}>{brl(r.diferenca)}</b> {bate ? "✅ bate" : "❌ não bate"}</>
                    )}
                  </div>
                </div>
              </div>

              <Bloco titulo="📐 Conferência do saldo com o extrato do banco"
                acao={<>
                  <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasConferencia(), "Conferência", `Conferencia_${sufixo}`)} />
                  <BotaoExport label="CSV" onClick={() => baixarCsv(linhasConferencia(), `Conferencia_${sufixo}`)} />
                </>}>
                {(dados?.conferencia || []).length === 0 ? (
                  <div className="p-3 text-xs text-gray-500">
                    Nenhum saldo do banco encontrado nos extratos importados desta conta. Importe um OFX (que traz o bloco
                    LEDGERBAL) ou informe o saldo inicial no filtro.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-xs text-gray-600">
                        <tr>
                          <th className="text-left px-3 py-2">Data do extrato</th>
                          <th className="text-right px-3 py-2">Saldo do banco</th>
                          <th className="text-right px-3 py-2">Saldo calculado</th>
                          <th className="text-right px-3 py-2">Diferença</th>
                          <th className="text-left px-3 py-2">Arquivo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(dados?.conferencia || []).map((c: any, k: number) => {
                          const ok = Math.abs(Number(c.diferenca || 0)) < 0.01;
                          return (
                            <tr key={k} className="border-t">
                              <td className="px-3 py-1.5">
                                {dt(c.data)}
                                {c.calibracao && <span className="ml-1 text-[10px] text-gray-400">(base)</span>}
                              </td>
                              <td className="px-3 py-1.5 text-right">{brl(c.saldoBanco)}</td>
                              <td className="px-3 py-1.5 text-right">{brl(c.saldoCalculado)}</td>
                              <td className={`px-3 py-1.5 text-right font-semibold ${c.calibracao ? "text-gray-500" : ok ? "text-green-700" : "text-red-700"}`}>
                                {c.calibracao ? "— calibração" : `${ok ? "✅ " : "❌ "}${brl(c.diferenca)}`}
                              </td>
                              <td className="px-3 py-1.5 text-xs text-gray-500 truncate max-w-[280px]">{c.arquivo || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Bloco>

              <div className="grid md:grid-cols-2 gap-3">
                <Bloco titulo="✔️ Situação dos lançamentos do período"
                  acao={<BotaoExport label="Excel" onClick={() => baixarXlsx(linhasResumo(), "Resumo", `Resumo_${sufixo}`)} />}>
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-600">
                      <tr><th className="text-left px-3 py-2">Situação</th><th className="text-right px-3 py-2">Qtd</th>
                        <th className="text-right px-3 py-2">Entradas</th><th className="text-right px-3 py-2">Saídas</th></tr>
                    </thead>
                    <tbody>
                      {[["Conciliados", st.conciliados, "text-green-700"], ["Pendentes", st.pendentes, "text-amber-700"], ["Ignorados", st.ignorados, "text-gray-600"]]
                        .map(([label, v, cls]: any, k: number) => (
                          <tr key={k} className="border-t">
                            <td className={`px-3 py-1.5 font-medium ${cls}`}>{label}</td>
                            <td className="px-3 py-1.5 text-right">{v?.qtd || 0}</td>
                            <td className="px-3 py-1.5 text-right">{brl(v?.entradas)}</td>
                            <td className="px-3 py-1.5 text-right">{brl(v?.saidas)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {Number(st?.pendentes?.qtd || 0) > 0 && (
                    <div className="px-3 py-2 text-xs text-amber-700 border-t bg-amber-50">
                      {st.pendentes.qtd} lançamento(s) do banco ainda sem título conciliado — é o que explica diferença entre
                      o financeiro e o extrato. <button className="underline no-print" onClick={() => setAba("pendentes")}>ver a lista</button>
                    </div>
                  )}
                </Bloco>

                <Bloco titulo="💰 O que foi recebido e pago (títulos baixados na conciliação)">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-600">
                      <tr><th className="text-left px-3 py-2"></th><th className="text-right px-3 py-2">Títulos</th>
                        <th className="text-right px-3 py-2">Valor</th><th className="text-right px-3 py-2">Juros</th>
                        <th className="text-right px-3 py-2">Desconto</th></tr>
                    </thead>
                    <tbody>
                      <tr className="border-t">
                        <td className="px-3 py-1.5 font-medium text-green-700">Recebido (clientes)</td>
                        <td className="px-3 py-1.5 text-right">{tit?.recebido?.qtd || 0}</td>
                        <td className="px-3 py-1.5 text-right">{brl(tit?.recebido?.valor)}</td>
                        <td className="px-3 py-1.5 text-right">{brl(tit?.recebido?.juros)}</td>
                        <td className="px-3 py-1.5 text-right">{brl(tit?.recebido?.desconto)}</td>
                      </tr>
                      <tr className="border-t">
                        <td className="px-3 py-1.5 font-medium text-red-700">Pago (fornecedores)</td>
                        <td className="px-3 py-1.5 text-right">{tit?.pago?.qtd || 0}</td>
                        <td className="px-3 py-1.5 text-right">{brl(tit?.pago?.valor)}</td>
                        <td className="px-3 py-1.5 text-right">{brl(tit?.pago?.juros)}</td>
                        <td className="px-3 py-1.5 text-right">{brl(tit?.pago?.desconto)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="px-3 py-2 text-[11px] text-gray-500 border-t">
                    Detalhe título a título nas abas <button className="underline no-print" onClick={() => setAba("recebidos")}>Recebidos</button> e{" "}
                    <button className="underline no-print" onClick={() => setAba("pagos")}>Pagos</button>.
                  </div>
                  {Number(auto?.automaticos?.qtd || 0) > 0 && (
                    <div className="border-t">
                      <table className="w-full text-sm">
                        <tbody>
                          <tr>
                            <td className="px-3 py-1.5 font-medium text-emerald-700">⚡ Recebido automático (webhook)</td>
                            <td className="px-3 py-1.5 text-right">{auto?.automaticos?.qtd || 0}</td>
                            <td className="px-3 py-1.5 text-right">{brl(auto?.automaticos?.valor)}</td>
                            <td className="px-3 py-1.5 text-right text-[11px] text-gray-500" colSpan={2}>
                              boleto BB · PIX · cartão
                            </td>
                          </tr>
                          <tr className="border-t">
                            <td className="px-3 py-1.5 pl-6 text-amber-700">⏳ ainda sem lançamento no extrato</td>
                            <td className="px-3 py-1.5 text-right text-amber-700">{auto?.foraDoExtrato?.qtd || 0}</td>
                            <td className="px-3 py-1.5 text-right text-amber-700">{brl(auto?.foraDoExtrato?.valor)}</td>
                            <td className="px-3 py-1.5 text-right text-[11px] text-gray-500" colSpan={2}>
                              <button className="underline no-print" onClick={() => setAba("automaticos")}>ver detalhe</button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <div className="px-3 py-2 text-[11px] text-gray-500 border-t bg-emerald-50/40">
                        Recebimento compensado por webhook <b>não entra</b> em Entradas/Saldo: o mesmo dinheiro chega pelo
                        extrato do dia e seria contado duas vezes. O saldo acima continua sendo o do banco.
                      </div>
                    </div>
                  )}
                </Bloco>
              </div>
            </div>
          )}

          {/* ---------------- ABA: MOVIMENTAÇÕES ---------------- */}
          {aba === "movimentacoes" && (
            <Bloco titulo="📄 Movimentações da conta (entradas e saídas)"
              acao={<>
                <select value={situacao} onChange={(e) => setSituacao(e.target.value)}
                  className="border rounded px-2 py-1 text-xs" data-testid="select-situacao">
                  <option value="todas">Todas as situações</option>
                  <option value="reconciled">Conciliados</option>
                  <option value="pending">Pendentes</option>
                  <option value="ignored">Ignorados</option>
                </select>
                <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasMovimentacoes(), "Movimentações", `Movimentacoes_${sufixo}`)} />
                <BotaoExport label="CSV" onClick={() => baixarCsv(linhasMovimentacoes(), `Movimentacoes_${sufixo}`)} />
              </>}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600">
                    <tr>
                      <th className="text-left px-2 py-2 whitespace-nowrap">Data</th>
                      <th className="text-left px-2 py-2">Lançamento no banco</th>
                      <th className="text-left px-2 py-2">Histórico — o que foi recebido / pago</th>
                      <th className="text-right px-2 py-2 whitespace-nowrap">Entrada</th>
                      <th className="text-right px-2 py-2 whitespace-nowrap">Saída</th>
                      <th className="text-right px-2 py-2 whitespace-nowrap">Saldo</th>
                      <th className="text-center px-2 py-2">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itensFiltrados.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-500">Nenhum lançamento no período.</td></tr>
                    )}
                    {itensFiltrados.map((i: any) => {
                      const s = SIT[i.status || "pending"] || SIT.pending;
                      return (
                        <tr key={i.id} className="border-t align-top hover:bg-gray-50">
                          <td className="px-2 py-1.5 whitespace-nowrap">{dt(i.data)}{i.hora && <span className="text-[11px] text-gray-400"> {i.hora}</span>}</td>
                          <td className="px-2 py-1.5">
                            <div className="font-medium">{i.contraparte || "—"}</div>
                            <div className="text-[11px] text-gray-500">
                              {[i.historico, fmtDoc(i.documento) || null].filter(Boolean).join(" · ") || i.descricao}
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            {(i.titulos || []).length === 0 ? (
                              <span className="text-[11px] text-gray-400 italic">
                                {i.status === "ignored" ? (i.observacao || "ignorado — sem título") : "sem título conciliado"}
                              </span>
                            ) : (
                              <div className="space-y-0.5">
                                {(i.titulos || []).map((t: any, k: number) => (
                                  <div key={k} className="text-[11px]">
                                    <span className={t.especie === "receber" ? "text-green-700 font-semibold" : "text-red-700 font-semibold"}>
                                      {t.especie === "receber" ? "Recebido" : "Pago"}
                                    </span>{" "}
                                    <b>{t.titulo || "s/nº"}</b> · {t.nome || "—"} · {brl(t.valor)}
                                    {Number(t.juros || 0) > 0 && <span className="text-amber-700"> +juros {brl(t.juros)}</span>}
                                    {Number(t.desconto || 0) > 0 && <span className="text-blue-700"> −desc. {brl(t.desconto)}</span>}
                                    {t.categoria && <span className="text-gray-500"> · {t.categoria}</span>}
                                    {t.vencimento && <span className="text-gray-400"> · venc. {dt(t.vencimento)}</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right text-green-700 whitespace-nowrap">{i.entrada ? brl(i.entrada) : ""}</td>
                          <td className="px-2 py-1.5 text-right text-red-700 whitespace-nowrap">{i.saida ? brl(i.saida) : ""}</td>
                          <td className="px-2 py-1.5 text-right font-medium whitespace-nowrap">{brl(i.saldo)}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${s.cls}`}>{s.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr className="border-t">
                      <td className="px-2 py-2" colSpan={3}>
                        Totais {filtro || situacao !== "todas" ? "(filtrados)" : "do período"} — {itensFiltrados.length} lançamento(s)
                      </td>
                      <td className="px-2 py-2 text-right text-green-700">{brl(totFiltrado.entradas)}</td>
                      <td className="px-2 py-2 text-right text-red-700">{brl(totFiltrado.saidas)}</td>
                      <td className="px-2 py-2 text-right">{brl(r.saldoFinalCalculado)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Bloco>
          )}

          {/* ---------------- ABAS: RECEBIDOS / PAGOS ---------------- */}
          {(aba === "recebidos" || aba === "pagos") && (() => {
            const receber = aba === "recebidos";
            const lista = receber ? recebidos : pagos;
            const rotulo = receber ? "Cliente" : "Fornecedor";
            const somaVal = lista.reduce((a, t) => a + Number(t.valor || 0), 0);
            const somaJur = lista.reduce((a, t) => a + Number(t.juros || 0), 0);
            const somaDes = lista.reduce((a, t) => a + Number(t.desconto || 0), 0);
            return (
              <Bloco titulo={`${receber ? "🟢 Recebimentos" : "🔴 Pagamentos"} — títulos baixados pela conciliação`}
                acao={<>
                  <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasTitulos(lista, rotulo), receber ? "Recebidos" : "Pagos", `${receber ? "Recebidos" : "Pagos"}_${sufixo}`)} />
                  <BotaoExport label="CSV" onClick={() => baixarCsv(linhasTitulos(lista, rotulo), `${receber ? "Recebidos" : "Pagos"}_${sufixo}`)} />
                </>}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-600">
                      <tr>
                        <th className="text-left px-2 py-2 whitespace-nowrap">Data no banco</th>
                        <th className="text-left px-2 py-2">{rotulo}</th>
                        <th className="text-left px-2 py-2 whitespace-nowrap">Título</th>
                        <th className="text-left px-2 py-2 whitespace-nowrap">Vencimento</th>
                        <th className="text-left px-2 py-2">Categoria</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Valor do título</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Conciliado</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Juros</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Desconto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lista.length === 0 && (
                        <tr><td colSpan={9} className="px-3 py-6 text-center text-sm text-gray-500">
                          Nenhum título {receber ? "recebido" : "pago"} conciliado no período.
                        </td></tr>
                      )}
                      {lista.map((t: any, k: number) => (
                        <tr key={k} className="border-t hover:bg-gray-50">
                          <td className="px-2 py-1.5 whitespace-nowrap">{dt(t._data)}</td>
                          <td className="px-2 py-1.5">
                            <div className="font-medium">{t.nome || "—"}</div>
                            {t.documento && <div className="text-[11px] text-gray-500">{fmtDoc(t.documento)}</div>}
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap font-mono text-xs">{t.titulo || "s/nº"}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-xs">{t.vencimento ? dt(t.vencimento) : "—"}</td>
                          <td className="px-2 py-1.5 text-xs text-gray-600">{t.categoria || "—"}</td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(t.valorTitulo)}</td>
                          <td className={`px-2 py-1.5 text-right font-medium whitespace-nowrap ${receber ? "text-green-700" : "text-red-700"}`}>{brl(t.valor)}</td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap text-amber-700">{Number(t.juros || 0) ? brl(t.juros) : "—"}</td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap text-blue-700">{Number(t.desconto || 0) ? brl(t.desconto) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 font-semibold">
                      <tr className="border-t">
                        <td className="px-2 py-2" colSpan={6}>{lista.length} título(s)</td>
                        <td className={`px-2 py-2 text-right ${receber ? "text-green-700" : "text-red-700"}`}>{brl(somaVal)}</td>
                        <td className="px-2 py-2 text-right text-amber-700">{brl(somaJur)}</td>
                        <td className="px-2 py-2 text-right text-blue-700">{brl(somaDes)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Bloco>
            );
          })()}

          {/* ---------------- ABA: RECEBIDOS AUTOMÁTICOS (WEBHOOK) ---------------- */}
          {aba === "automaticos" && (
            <div className="space-y-3">
              {auto?.erro && (
                <div className="border rounded-lg bg-amber-50 border-amber-200 p-3 text-xs text-amber-800">
                  Não foi possível ler as baixas automáticas nesta base: {auto.erro}
                </div>
              )}

              {/* KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Kpi titulo="Recebido por webhook" valor={brl(auto?.automaticos?.valor)} tom="verde"
                  sub={`${auto?.automaticos?.qtd || 0} baixa(s) no período`} />
                <Kpi titulo="Já refletido no extrato" valor={brl(auto?.jaNoExtrato?.valor)} tom="azul"
                  sub={`${auto?.jaNoExtrato?.qtd || 0} · já conta no saldo`} />
                <Kpi titulo="Fora do extrato" valor={brl(auto?.foraDoExtrato?.valor)} tom="vermelho"
                  sub={`${auto?.foraDoExtrato?.qtd || 0} · aguardando o OFX do dia`} />
                <Kpi titulo="Cobrança × extrato" valor={brl(cobr?.totais?.diferenca)}
                  tom={Math.abs(Number(cobr?.totais?.diferenca || 0)) < 0.01 ? "verde" : "vermelho"}
                  sub={`boletos ${brl(cobr?.totais?.valorBoletos)} · extrato ${brl(cobr?.totais?.valorExtrato)}`} />
              </div>

              {/* Cobrança de boletos dia a dia x crédito "COBRANCA" do extrato */}
              <Bloco titulo="🏦 Cobrança (boletos) dia a dia × crédito “COBRANCA” do extrato"
                acao={<>
                  <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasCobranca(), "Cobrança x extrato", `Cobranca_x_Extrato_${sufixo}`)} />
                  <BotaoExport label="CSV" onClick={() => baixarCsv(linhasCobranca(), `Cobranca_x_Extrato_${sufixo}`)} />
                </>}>
                <div className="px-3 py-2 text-[11px] text-gray-600 border-b bg-gray-50">
                  O BB credita a liquidação dos boletos do dia em <b>uma linha “COBRANCA”</b> no extrato (repasse
                  consolidado) — por isso título a título nunca casa 1:1. Aqui os boletos recebidos são <b>somados por dia</b>
                  {" "}e comparados com o crédito do extrato daquele dia.
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-600">
                      <tr>
                        <th className="text-left px-2 py-2 whitespace-nowrap">Data</th>
                        <th className="text-right px-2 py-2">Boletos</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Recebido (webhook)</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Créditos “COBRANCA”</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Valor no extrato</th>
                        <th className="text-right px-2 py-2">Diferença</th>
                        <th className="text-left px-2 py-2">Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {((cobr?.linhas || []).length === 0) && (
                        <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-500">
                          Nenhum boleto liquidado nem crédito “COBRANCA” no período.
                        </td></tr>
                      )}
                      {(cobr?.linhas || []).map((l: any, k: number) => {
                        const s = SIT_COBR[l.situacao] || { label: l.situacao, cls: "text-gray-600" };
                        return (
                          <tr key={k} className="border-t hover:bg-gray-50">
                            <td className="px-2 py-1.5 whitespace-nowrap">{dt(l.data)}</td>
                            <td className="px-2 py-1.5 text-right">{l.qtdBoletos || "—"}</td>
                            <td className="px-2 py-1.5 text-right text-green-700 whitespace-nowrap">{brl(l.valorBoletos)}</td>
                            <td className="px-2 py-1.5 text-right">{l.qtdCreditos || "—"}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">{brl(l.valorExtrato)}</td>
                            <td className={`px-2 py-1.5 text-right font-medium whitespace-nowrap ${Math.abs(Number(l.diferenca || 0)) < 0.01 ? "text-gray-500" : "text-red-700"}`}>{brl(l.diferenca)}</td>
                            <td className={`px-2 py-1.5 text-xs whitespace-nowrap ${s.cls}`}>{s.label}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50 font-semibold">
                      <tr className="border-t">
                        <td className="px-2 py-2">Total do período</td>
                        <td className="px-2 py-2 text-right">{cobr?.totais?.qtdBoletos || 0}</td>
                        <td className="px-2 py-2 text-right text-green-700">{brl(cobr?.totais?.valorBoletos)}</td>
                        <td className="px-2 py-2 text-right">{cobr?.totais?.qtdCreditos || 0}</td>
                        <td className="px-2 py-2 text-right">{brl(cobr?.totais?.valorExtrato)}</td>
                        <td className={`px-2 py-2 text-right ${Math.abs(Number(cobr?.totais?.diferenca || 0)) < 0.01 ? "text-gray-600" : "text-red-700"}`}>{brl(cobr?.totais?.diferenca)}</td>
                        <td className="px-2 py-2"></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="px-3 py-2 text-[11px] text-gray-500 border-t">
                  O acumulado do período é a conferência que vale: o BB às vezes credita em D+1, então um dia pode
                  divergir e o total fechar. {cobr?.ultimoDiaExtrato ? `Extrato importado até ${dt(cobr.ultimoDiaExtrato)}.` : ""}
                </div>
              </Bloco>

              {/* Por origem */}
              <Bloco titulo="⚡ Por origem da baixa automática">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600">
                    <tr>
                      <th className="text-left px-3 py-2">Origem</th>
                      <th className="text-right px-3 py-2">Baixas</th>
                      <th className="text-right px-3 py-2">Valor</th>
                      <th className="text-right px-3 py-2">Fora do extrato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(auto?.porOrigem || []).length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-500">Nenhuma baixa no período.</td></tr>
                    )}
                    {(auto?.porOrigem || []).map((o: any, k: number) => (
                      <tr key={k} className="border-t">
                        <td className="px-3 py-1.5">
                          <span className={o.automatica ? "font-medium text-emerald-700" : "text-gray-600"}>{o.rotulo}</span>
                          {!o.automatica && <span className="ml-2 text-[11px] text-gray-400">(não é webhook)</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right">{o.qtd}</td>
                        <td className="px-3 py-1.5 text-right">{brl(o.valor)}</td>
                        <td className="px-3 py-1.5 text-right text-amber-700">{o.foraQtd ? `${o.foraQtd} · ${brl(o.foraValor)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 text-[11px] text-gray-500 border-t">
                  Um gateway novo entra sozinho: a origem é classificada no backend por uma tabela de regras
                  (<code>ORIGENS_BAIXA</code>) — incluir Mercado Pago, PagSeguro etc. é uma linha.
                </div>
              </Bloco>

              {/* Título a título */}
              <Bloco titulo="⚡ Recebimentos compensados automaticamente — título a título"
                acao={<>
                  <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasAutomaticos(), "Recebidos automáticos", `Recebidos_Automaticos_${sufixo}`)} />
                  <BotaoExport label="CSV" onClick={() => baixarCsv(linhasAutomaticos(), `Recebidos_Automaticos_${sufixo}`)} />
                </>}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-600">
                      <tr>
                        <th className="text-left px-2 py-2 whitespace-nowrap">Data</th>
                        <th className="text-left px-2 py-2">Origem</th>
                        <th className="text-left px-2 py-2">Cliente</th>
                        <th className="text-left px-2 py-2 whitespace-nowrap">Título</th>
                        <th className="text-left px-2 py-2 whitespace-nowrap">Vencimento</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Valor do título</th>
                        <th className="text-right px-2 py-2 whitespace-nowrap">Recebido</th>
                        <th className="text-left px-2 py-2 whitespace-nowrap">No extrato?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {automaticos.length === 0 && (
                        <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-gray-500">
                          Nenhum recebimento compensado por webhook no período.
                        </td></tr>
                      )}
                      {automaticos.map((x: any, k: number) => (
                        <tr key={k} className="border-t hover:bg-gray-50">
                          <td className="px-2 py-1.5 whitespace-nowrap">{dt(x.data)}</td>
                          <td className="px-2 py-1.5 text-xs">{x.origemRotulo}</td>
                          <td className="px-2 py-1.5">
                            <div className="font-medium">{x.nome || "—"}</div>
                            {x.documento && <div className="text-[11px] text-gray-500">{fmtDoc(x.documento)}</div>}
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap font-mono text-xs">{x.titulo || "s/nº"}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-xs">{x.vencimento ? dt(x.vencimento) : "—"}</td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">{x.valorTitulo == null ? "—" : brl(x.valorTitulo)}</td>
                          <td className="px-2 py-1.5 text-right font-medium text-green-700 whitespace-nowrap">{brl(x.valor)}</td>
                          <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                            {x.noExtrato
                              ? <span className="text-blue-700">✅ sim<span className="text-gray-400"> · {x.casamento}</span></span>
                              : <span className="text-amber-700">⏳ aguardando</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 font-semibold">
                      <tr className="border-t">
                        <td className="px-2 py-2" colSpan={6}>{automaticos.length} recebimento(s)</td>
                        <td className="px-2 py-2 text-right text-green-700">
                          {brl(automaticos.reduce((a: number, x: any) => a + Number(x.valor || 0), 0))}
                        </td>
                        <td className="px-2 py-2"></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="px-3 py-2 text-[11px] text-gray-500 border-t">
                  <b>“No extrato? ⏳ aguardando”</b> = o webhook já baixou o título, mas o crédito ainda não foi
                  conciliado no extrato desta conta — é o que explica o financeiro estar à frente do banco. Assim que o
                  OFX do dia entrar, a linha vira ✅ e o valor deixa de ser contado duas vezes.
                </div>
              </Bloco>
            </div>
          )}

          {/* ---------------- ABA: PENDENTES ---------------- */}
          {aba === "pendentes" && (
            <Bloco titulo="⏳ Lançamentos do banco ainda sem conciliação"
              acao={<>
                <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasPendentes(), "Pendentes", `Pendentes_${sufixo}`)} />
                <BotaoExport label="CSV" onClick={() => baixarCsv(linhasPendentes(), `Pendentes_${sufixo}`)} />
              </>}>
              <div className="px-3 py-2 text-xs text-gray-600 border-b bg-amber-50">
                Esta é a fila de trabalho da conciliação: enquanto houver linha aqui, o financeiro não reflete o extrato.
                A conciliação em si é feita na tela <b>Conciliação Bancária</b>.
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600">
                    <tr>
                      <th className="text-left px-2 py-2 whitespace-nowrap">Data</th>
                      <th className="text-left px-2 py-2">Lançamento no banco</th>
                      <th className="text-left px-2 py-2">Extrato de origem</th>
                      <th className="text-right px-2 py-2 whitespace-nowrap">Entrada</th>
                      <th className="text-right px-2 py-2 whitespace-nowrap">Saída</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendentes.length === 0 && (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-green-700">
                        ✅ Nenhum lançamento pendente no período — tudo conciliado.
                      </td></tr>
                    )}
                    {pendentes.map((i: any) => (
                      <tr key={i.id} className="border-t hover:bg-gray-50">
                        <td className="px-2 py-1.5 whitespace-nowrap">{dt(i.data)}{i.hora && <span className="text-[11px] text-gray-400"> {i.hora}</span>}</td>
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{i.contraparte || "—"}</div>
                          <div className="text-[11px] text-gray-500">{[i.historico, fmtDoc(i.documento) || null].filter(Boolean).join(" · ") || i.descricao}</div>
                        </td>
                        <td className="px-2 py-1.5 text-[11px] text-gray-500 truncate max-w-[240px]">{i.arquivo || "—"}</td>
                        <td className="px-2 py-1.5 text-right text-green-700 whitespace-nowrap">{i.entrada ? brl(i.entrada) : ""}</td>
                        <td className="px-2 py-1.5 text-right text-red-700 whitespace-nowrap">{i.saida ? brl(i.saida) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr className="border-t">
                      <td className="px-2 py-2" colSpan={3}>{pendentes.length} pendente(s)</td>
                      <td className="px-2 py-2 text-right text-green-700">{brl(pendentes.reduce((a, i) => a + Number(i.entrada || 0), 0))}</td>
                      <td className="px-2 py-2 text-right text-red-700">{brl(pendentes.reduce((a, i) => a + Number(i.saida || 0), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Bloco>
          )}

          {/* ---------------- ABA: CATEGORIAS ---------------- */}
          {aba === "categorias" && (
            <Bloco titulo="🗂️ Movimentação por categoria (plano de contas)"
              acao={<>
                <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasCategorias(), "Categorias", `Categorias_${sufixo}`)} />
                <BotaoExport label="CSV" onClick={() => baixarCsv(linhasCategorias(), `Categorias_${sufixo}`)} />
              </>}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600">
                    <tr><th className="text-left px-3 py-2">Categoria</th><th className="text-right px-3 py-2">Entradas</th>
                      <th className="text-right px-3 py-2">Saídas</th><th className="text-right px-3 py-2">Lançamentos</th></tr>
                  </thead>
                  <tbody>
                    {(dados?.porCategoria || []).length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-500">Sem títulos conciliados no período.</td></tr>
                    )}
                    {(dados?.porCategoria || []).map((c: any, k: number) => (
                      <tr key={k} className="border-t">
                        <td className="px-3 py-1.5">{c.categoria}</td>
                        <td className="px-3 py-1.5 text-right text-green-700">{c.entradas ? brl(c.entradas) : "—"}</td>
                        <td className="px-3 py-1.5 text-right text-red-700">{c.saidas ? brl(c.saidas) : "—"}</td>
                        <td className="px-3 py-1.5 text-right">{c.qtd}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr className="border-t">
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right text-green-700">{brl((dados?.porCategoria || []).reduce((a: number, c: any) => a + Number(c.entradas || 0), 0))}</td>
                      <td className="px-3 py-2 text-right text-red-700">{brl((dados?.porCategoria || []).reduce((a: number, c: any) => a + Number(c.saidas || 0), 0))}</td>
                      <td className="px-3 py-2 text-right">{(dados?.porCategoria || []).reduce((a: number, c: any) => a + Number(c.qtd || 0), 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Bloco>
          )}

          {/* ---------------- ABA: HISTÓRICO MENSAL ---------------- */}
          {aba === "mensal" && (
            <Bloco titulo="📅 Histórico mensal da conta (todo o período com lançamentos)"
              acao={<>
                <BotaoExport label="Excel" onClick={() => baixarXlsx(linhasMensal(), "Histórico mensal", `Historico_Mensal_${String(dados?.conta?.nome || "conta").replace(/[^\w]+/g, "_")}`)} />
                <BotaoExport label="CSV" onClick={() => baixarCsv(linhasMensal(), `Historico_Mensal`)} />
              </>}>
              <div className="px-3 py-2 text-xs text-gray-600 border-b">
                Série fixa da conta — <b>não depende do filtro de período</b>. Mostra o saldo no fim de cada mês e, quando há
                extrato importado naquele mês, o saldo que o banco informou.
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600">
                    <tr>
                      <th className="text-left px-2 py-2">Mês</th>
                      <th className="text-right px-2 py-2">Entradas</th>
                      <th className="text-right px-2 py-2">Saídas</th>
                      <th className="text-right px-2 py-2">Resultado</th>
                      <th className="text-right px-2 py-2">Saldo no fim do mês</th>
                      <th className="text-right px-2 py-2">Saldo do banco</th>
                      <th className="text-right px-2 py-2">Diferença</th>
                      <th className="text-center px-2 py-2">Conc. / Pend. / Ign.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dados?.porMes || []).length === 0 && (
                      <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-gray-500">Sem lançamentos importados nesta conta.</td></tr>
                    )}
                    {(dados?.porMes || []).map((m: any, k: number) => {
                      const ok = m.diferenca == null ? null : Math.abs(Number(m.diferenca)) < 0.01;
                      return (
                        <tr key={k} className="border-t hover:bg-gray-50">
                          <td className="px-2 py-1.5 font-medium">{fmtMes(m.mes)}</td>
                          <td className="px-2 py-1.5 text-right text-green-700">{brl(m.entradas)}</td>
                          <td className="px-2 py-1.5 text-right text-red-700">{brl(m.saidas)}</td>
                          <td className={`px-2 py-1.5 text-right ${Number(m.resultado) >= 0 ? "text-green-700" : "text-red-700"}`}>{brl(m.resultado)}</td>
                          <td className="px-2 py-1.5 text-right font-medium">{brl(m.saldoFinal)}</td>
                          <td className="px-2 py-1.5 text-right">{m.saldoBanco == null ? "—" : brl(m.saldoBanco)}</td>
                          <td className={`px-2 py-1.5 text-right font-semibold ${ok == null ? "text-gray-400" : ok ? "text-green-700" : "text-red-700"}`}>
                            {ok == null ? "—" : `${ok ? "✅ " : "❌ "}${brl(m.diferenca)}`}
                          </td>
                          <td className="px-2 py-1.5 text-center text-xs">
                            <span className="text-green-700">{m.conciliados}</span> /{" "}
                            <span className={Number(m.pendentes) > 0 ? "text-amber-700 font-semibold" : "text-gray-500"}>{m.pendentes}</span> /{" "}
                            <span className="text-gray-500">{m.ignorados}</span>
                            {Number(m.valorPendente) > 0 && <div className="text-[10px] text-amber-700">pend. {brl(m.valorPendente)}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr className="border-t">
                      <td className="px-2 py-2">Total</td>
                      <td className="px-2 py-2 text-right text-green-700">{brl((dados?.porMes || []).reduce((a: number, m: any) => a + Number(m.entradas || 0), 0))}</td>
                      <td className="px-2 py-2 text-right text-red-700">{brl((dados?.porMes || []).reduce((a: number, m: any) => a + Number(m.saidas || 0), 0))}</td>
                      <td colSpan={5}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Bloco>
          )}

          <div className="text-[11px] text-gray-500 pb-6">
            Saldo inicial {dados?.base?.origem === "informado" ? "informado no filtro" : dados?.base?.origem === "extrato" ? "deduzido do saldo do próprio extrato do banco (LEDGERBAL do OFX)" : "não disponível (considerado zero)"}.
            Lançamentos ignorados entram no saldo (o dinheiro se moveu); ignorar significa apenas que não há título a conciliar.
            Linhas espelho (mesmo lançamento em dois arquivos) não são contadas duas vezes.
          </div>
        </>
      )}
    </div>
  );
}
