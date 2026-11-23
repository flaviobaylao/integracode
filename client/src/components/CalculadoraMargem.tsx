// Aba admin-only do Dashboard Geral: Calculadora de Margem por SKU (custo pleno).
// Consome GET /api/industria/precificacao/base (rota já restrita a admin).
// Volume anual, custo de material por SKU, sugestão de conversão, imposto e frete
// vêm de Produção & Faturamento e do contas a pagar. O admin informa custo de
// conversão, comissão, perda/troca e o markup de cada SKU — o preço de venda é
// derivado do markup e também pode ser digitado direto.
// Botão "Gerar proposta" monta o PDF no padrão Hot Park / Lagoa com jsPDF.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";

const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const brl4 = (n: any) => "R$ " + new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(Number(n) || 0);
const nf = (n: any) => new Intl.NumberFormat("pt-BR").format(Number(n) || 0);
const pct = (n: any) => n == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(n));
const cap = (s: string) => String(s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const num = (v: any) => { const n = Number(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : 0; };

type Row = { sabor: string; tam: string; custo_material: number | null; vendidas_12m: number; faturamento_12m: number; preco_medio_12m: number | null };

const Info = ({ t }: { t: string }) => (
  <span title={t} className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-200 text-gray-500 text-[9px] font-bold cursor-help align-[1px] normal-case tracking-normal">i</span>
);

export default function CalculadoraMargem() {
  const { data, isLoading, error, refetch } = useQuery<any>({ queryKey: ["/api/industria/precificacao/base"], refetchOnWindowFocus: false, staleTime: 0 });

  // --- premissas (editáveis pelo admin) -----------------------------------
  const [conv, setConv] = useState<string>("");        // custo de conversão anual (R$)
  const [volOv, setVolOv] = useState<string>("");      // volume anual (override)
  const [f350, setF350] = useState<string>("0,6712");
  const [f900, setF900] = useState<string>("1,7259");
  const [imp, setImp] = useState<string>("");          // alíquota de imposto (%)
  const [com, setCom] = useState<string>("0");         // comissão (%)
  const [per, setPer] = useState<string>("0");         // perda/troca (%)
  const [fre, setFre] = useState<string>("");          // frete (%)
  const [mkDef, setMkDef] = useState<string>("1,70");
  const [mk, setMk] = useState<Record<string, string>>({});       // markup por SKU
  const [pvManual, setPvManual] = useState<Record<string, string>>({}); // preço digitado direto
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [cliente, setCliente] = useState<string>("");
  const [gerando, setGerando] = useState(false);

  // Carrega premissas salvas; onde não houver, usa a sugestão calculada.
  useEffect(() => {
    if (!data) return;
    const c = data.config || {};
    const s = data.sugestoes || {};
    const br = (v: any) => (v == null ? "" : String(v).replace(".", ","));
    setConv(br(c.custo_conversao_anual ?? s.custoConversaoAnual));
    setVolOv(c.volume_anual_override == null ? "" : String(c.volume_anual_override));
    setF350(br(c.fator_rateio_350 ?? 0.6712));
    setF900(br(c.fator_rateio_900 ?? 1.7259));
    setImp(br(((c.aliquota_imposto ?? s.aliquotaImposto) ?? 0) * 100));
    setCom(br((c.comissao_pct ?? 0) * 100));
    setPer(br((c.perda_troca_pct ?? 0) * 100));
    setFre(br(((c.frete_pct ?? s.fretePct) ?? 0) * 100));
    setMkDef(br(c.markup_padrao ?? 1.7));
    const m: Record<string, string> = {};
    const salvo = (c.markup_por_sku || {}) as Record<string, any>;
    for (const k of Object.keys(salvo)) m[k] = br(salvo[k]);
    setMk(m);
  }, [data]);

  const rows: Row[] = data?.rows || [];
  const volumeBase = num(volOv) > 0 ? num(volOv) : Number(data?.volume?.total || 0);
  const convAnual = num(conv);
  // Custo de conversão por unidade: anual ÷ volume × fator de rateio da gramatura.
  const convUnit = (tam: string) => (volumeBase > 0 ? (convAnual / volumeBase) * num(tam === "350" ? f350 : f900) : 0);

  const calc = (r: Row) => {
    const key = r.sabor + "|" + r.tam;
    const material = Number(r.custo_material || 0);
    const conversao = convUnit(r.tam);
    const pleno = material + conversao;
    const markup = num(mk[key] || mkDef);
    const manual = pvManual[key];
    const preco = manual !== undefined && manual !== "" ? num(manual) : pleno * markup;
    const vImp = preco * (num(imp) / 100);
    const vCom = preco * (num(com) / 100);
    const vFre = preco * (num(fre) / 100);
    const vPer = preco * (num(per) / 100);
    const margem = preco - pleno - vImp - vCom - vFre - vPer;
    return { key, material, conversao, pleno, markup, preco, vImp, vCom, vFre, vPer, margem, margemPct: preco > 0 ? margem / preco : 0 };
  };

  const linhas = useMemo(() => rows.map((r) => ({ r, c: calc(r) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, conv, volOv, f350, f900, imp, com, per, fre, mkDef, mk, pvManual]);

  const r350 = linhas.filter((x) => x.r.tam === "350");
  const r900 = linhas.filter((x) => x.r.tam === "900");

  async function salvar() {
    setSalvando(true); setMsg("");
    try {
      const body = {
        custoConversaoAnual: num(conv) || null,
        volumeAnualOverride: num(volOv) || null,
        fatorRateio350: num(f350), fatorRateio900: num(f900),
        aliquotaImposto: num(imp) / 100, comissaoPct: num(com) / 100,
        perdaTrocaPct: num(per) / 100, fretePct: num(fre) / 100,
        markupPadrao: num(mkDef),
        markupPorSku: Object.fromEntries(Object.entries(mk).filter(([, v]) => v !== "").map(([k, v]) => [k, num(v)])),
      };
      const resp = await fetch("/api/industria/precificacao/config", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setMsg("Premissas salvas.");
      refetch();
    } catch (e: any) { setMsg("Erro ao salvar: " + (e?.message || String(e))); }
    finally { setSalvando(false); setTimeout(() => setMsg(""), 4000); }
  }

  // ---- proposta em PDF, no padrão usado com Hot Park e Lagoa ---------------
  async function gerarProposta() {
    if (!cliente.trim()) { setMsg("Informe o nome do cliente."); setTimeout(() => setMsg(""), 3000); return; }
    setGerando(true);
    try {
      const jsPDFmod: any = await import("jspdf");
      const JsPDF = jsPDFmod.jsPDF ?? jsPDFmod.default;
      const autoTableMod: any = await import("jspdf-autotable");
      const autoTable = autoTableMod.default ?? autoTableMod;
      const doc = new JsPDF({ unit: "mm", format: "a4" });
      const W = doc.internal.pageSize.getWidth();
      const H = doc.internal.pageSize.getHeight();
      const VERDE: [number, number, number] = [27, 77, 46];
      const LEAF: [number, number, number] = [109, 179, 63];
      const CINZA: [number, number, number] = [75, 90, 82];
      const hoje = new Date().toLocaleDateString("pt-BR");

      const chrome = () => {
        doc.setTextColor(...VERDE); doc.setFont("helvetica", "bold"); doc.setFontSize(10);
        doc.text("HONEST SUCOS NATURAIS", W - 18, 14, { align: "right" });
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...CINZA);
        doc.text("Puro Indústria e Comércio de Produtos Naturais Ltda · CNPJ 28.295.493/0001-53 · IE 10.709.937-3", W - 18, 18, { align: "right" });
        doc.text("Fábrica própria · Rod. Bela Vista de Goiás–Cristianópolis, KM 08 · Bela Vista de Goiás/GO", W - 18, 22, { align: "right" });
        doc.setFillColor(...LEAF); doc.rect(18, 25, W - 36, 1.2, "F");
        doc.rect(18, H - 20, W - 36, 0.6, "F");
        doc.setFontSize(7.5); doc.setTextColor(...CINZA);
        doc.text("bebahonest.com.br · WhatsApp (62) 99578-2812 · Suco misto de fruta sem adição de açúcares, conservantes e corantes", 18, H - 15);
      };
      chrome();

      let y = 36;
      doc.setTextColor(...VERDE); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
      doc.text(`PROPOSTA COMERCIAL · GOIÂNIA, ${hoje} · VÁLIDA POR 30 DIAS`, 18, y); y += 8;
      doc.setTextColor(0, 0, 0); doc.setFontSize(18);
      doc.text("Proposta de abastecimento", 18, y); y += 8;
      doc.setFontSize(13); doc.setTextColor(...VERDE);
      doc.text(cliente.trim(), 18, y); y += 8;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...CINZA);
      doc.text(doc.splitTextToSize(
        "Fornecimento de suco misto de fruta refrigerado, sem adição de açúcares, conservantes ou corantes, " +
        "produzido em fábrica própria em Bela Vista de Goiás, com entrega refrigerada porta a porta.", W - 36), 18, y);
      y += 12;

      const body350 = r350.map(({ r, c }) => [cap(r.sabor) + " 350 ml", brl(c.preco), pct(c.margemPct)]);
      const body900 = r900.map(({ r, c }) => [cap(r.sabor) + " 900 ml", brl(c.preco), pct(c.margemPct)]);

      doc.setTextColor(...VERDE); doc.setFont("helvetica", "bold"); doc.setFontSize(12);
      doc.text("Tabela de preços — 350 ml", 18, y); y += 2;
      autoTable(doc, {
        startY: y + 2, margin: { left: 18, right: 18 },
        head: [["Produto", "Preço por unidade", "Margem"]],
        body: body350.map((b) => [b[0], b[1], ""]),   // margem fica fora do PDF do cliente
        theme: "grid", styles: { font: "helvetica", fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: [238, 241, 232], textColor: [75, 90, 82], fontStyle: "bold" },
        columnStyles: { 1: { halign: "center" }, 2: { halign: "center" } },
      });
      y = (doc as any).lastAutoTable.finalY + 8;

      doc.setTextColor(...VERDE); doc.setFont("helvetica", "bold"); doc.setFontSize(12);
      doc.text("Tabela de preços — 900 ml", 18, y);
      autoTable(doc, {
        startY: y + 4, margin: { left: 18, right: 18 },
        head: [["Produto", "Preço por unidade", ""]],
        body: body900.map((b) => [b[0], b[1], ""]),
        theme: "grid", styles: { font: "helvetica", fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: [238, 241, 232], textColor: [75, 90, 82], fontStyle: "bold" },
        columnStyles: { 1: { halign: "center" } },
      });
      y = (doc as any).lastAutoTable.finalY + 10;

      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...VERDE);
      doc.text("Condições", 18, y); y += 6;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(0, 0, 0);
      const cond = [
        "Fardo de 350 ml com 12 unidades · fardo de 900 ml com 6 unidades.",
        "Palete PBR-1: 175 fardos de 350 ml (2.100 un) · 156 fardos de 900 ml (936 un).",
        "Validade de 120 dias · conservação refrigerada de -2 °C a 5 °C.",
        "Entrega refrigerada porta a porta, a partir da fábrica em Bela Vista de Goiás ou do CD em Goiânia.",
        "Sem exigência de exclusividade. Equipamento de refrigeração em comodato, mediante solicitação.",
      ];
      cond.forEach((t) => { doc.text("• " + t, 18, y); y += 5; });

      y += 6;
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...VERDE);
      doc.text("Contatos Honest", 18, y); y += 6;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(0, 0, 0);
      doc.text("Carlos · vendedor externo · WhatsApp (62) 99923-9974", 18, y); y += 5;
      doc.text("Cinthia · coordenadora de vendas · (62) 99451-1997", 18, y); y += 5;
      doc.text("Flávio · diretor · (62) 99578-2812", 18, y); y += 5;
      doc.setFontSize(8); doc.setTextColor(...CINZA);
      doc.text("coordvendas@bebahonest.com.br · bebahonest.com.br", 18, y);

      const slug = cliente.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "_");
      doc.save("Proposta_Honest_" + slug + ".pdf");
      setMsg("Proposta gerada.");
    } catch (e: any) { setMsg("Erro ao gerar PDF: " + (e?.message || String(e))); }
    finally { setGerando(false); setTimeout(() => setMsg(""), 4000); }
  }

  if (isLoading) return <div className="mt-6 text-sm text-gray-500">Carregando base de precificação…</div>;
  if (error) return <div className="mt-6 text-sm text-red-600">Erro ao carregar: {String((error as any)?.message || error)}</div>;

  const inp = "w-28 px-2 py-1 text-sm text-right border border-gray-300 rounded font-semibold text-blue-700 focus:outline-none focus:ring-1 focus:ring-emerald-500";
  const cell = "px-3 py-2 text-right tabular-nums whitespace-nowrap";
  const th = "px-3 py-2 text-right text-[11px] uppercase tracking-wide text-gray-500 font-semibold whitespace-nowrap";

  const Campo = ({ label, v, set, suf, dica }: any) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-gray-600">{label}{dica && <Info t={dica} />}</span>
      <span className="flex items-center gap-1">
        <input className={inp} value={v} onChange={(e) => set(e.target.value)} />
        {suf && <span className="text-xs text-gray-400 w-4">{suf}</span>}
      </span>
    </div>
  );

  const Linha = ({ r, c }: { r: Row; c: any }) => (
    <tr className="border-b border-gray-100">
      <td className="px-3 py-2 text-left font-medium">{cap(r.sabor)}</td>
      <td className="px-3 py-2 text-left"><span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-600">{r.tam}ml</span></td>
      <td className={cell}>{r.custo_material != null ? brl4(c.material) : <span className="text-gray-400">—</span>}</td>
      <td className={cell}>{brl4(c.conversao)}</td>
      <td className={cell + " font-semibold"}>{brl4(c.pleno)}</td>
      <td className="px-2 py-1 text-right">
        <input className={inp + " w-20"} value={mk[c.key] ?? mkDef}
          onChange={(e) => setMk({ ...mk, [c.key]: e.target.value })} title="Markup sobre o custo pleno" />
      </td>
      <td className="px-2 py-1 text-right">
        <input className={inp + " w-24"} value={pvManual[c.key] ?? c.preco.toFixed(2).replace(".", ",")}
          onChange={(e) => setPvManual({ ...pvManual, [c.key]: e.target.value })} title="Preço de venda — editável" />
      </td>
      <td className={cell}>{brl(c.vImp)}</td>
      <td className={cell}>{brl(c.vCom + c.vFre + c.vPer)}</td>
      <td className={cell + " font-semibold"}>{brl(c.margem)}</td>
      <td className={cell}>
        <span className={c.margemPct < 0.15 ? "text-rose-600 font-bold" : c.margemPct < 0.25 ? "text-amber-600 font-bold" : "text-emerald-700 font-bold"}>{pct(c.margemPct)}</span>
      </td>
      <td className={cell + " text-gray-500"}>{r.preco_medio_12m != null ? brl(r.preco_medio_12m) : "—"}</td>
    </tr>
  );

  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Calculadora de Margem por SKU</h2>
          <p className="text-xs text-gray-500">
            Custo de material e volume vêm de Produção &amp; Faturamento. Custo de conversão, comissão, perda/troca e markup são premissas suas.
            {data?.generatedAt ? " · atualizado em " + new Date(data.generatedAt).toLocaleString("pt-BR") : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs font-medium text-emerald-700">{msg}</span>}
          <button type="button" onClick={salvar} disabled={salvando}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-emerald-600 text-emerald-700 hover:bg-emerald-600 hover:text-white transition-colors disabled:opacity-50">
            {salvando ? "Salvando…" : "Salvar premissas"}
          </button>
        </div>
      </div>

      {/* ---------------- premissas ---------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card><CardContent className="p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Puxado do sistema</h3>
          <Campo label="Volume anual (un)" v={volOv} set={setVolOv}
            dica={"Unidades faturadas nos últimos 12 meses. Sugestão do sistema: " + nf(data?.volume?.total) + " un (" + nf(data?.volume?.ml350) + " de 350 ml e " + nf(data?.volume?.ml900) + " de 900 ml). Deixe em branco para usar a sugestão."} />
          <Campo label="Imposto sobre venda" v={imp} set={setImp} suf="%"
            dica={"Sugestão: DAS pago ÷ receita dos últimos 12 meses = " + pct(data?.sugestoes?.aliquotaImposto)} />
          <Campo label="Frete de saída" v={fre} set={setFre} suf="%"
            dica={"Sugestão: conta Frete ÷ receita dos últimos 12 meses = " + pct(data?.sugestoes?.fretePct)} />
          <p className="text-[11px] text-gray-400 mt-2">Receita 12 meses: {brl(data?.volume?.receita)}</p>
        </CardContent></Card>

        <Card><CardContent className="p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Custo de conversão</h3>
          <Campo label="Custo anual da fábrica (R$)" v={conv} set={setConv}
            dica="Mão de obra, encargos, benefícios, energia, aluguel, manutenções e material de uso e consumo. Não está no custo do lote." />
          <Campo label="Fator de rateio 350 ml" v={f350} set={setF350}
            dica="1,0000 = rateio por unidade. 0,6712 = rateio por litro." />
          <Campo label="Fator de rateio 900 ml" v={f900} set={setF900}
            dica="1,7259 = rateio por litro (o 900 ml carrega mais que o 350 ml)." />
          <p className="text-[11px] text-gray-400 mt-2">
            Sugestão do sistema: {brl(data?.sugestoes?.custoConversaoAnual)} — soma das contas de fábrica dos últimos 12 meses.
            {" "}Conversão por unidade: 350 ml {brl4(convUnit("350"))} · 900 ml {brl4(convUnit("900"))}
          </p>
        </CardContent></Card>

        <Card><CardContent className="p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Suas premissas</h3>
          <Campo label="Comissão sobre venda" v={com} set={setCom} suf="%" dica="Comissão paga ao vendedor neste canal." />
          <Campo label="Perda e troca sobre venda" v={per} set={setPer} suf="%" dica="Reserve aqui o custo de troca e quebra." />
          <Campo label="Markup padrão" v={mkDef} set={setMkDef} dica="Multiplicador sobre o custo pleno, usado nos SKUs sem markup próprio. Preço = custo pleno × markup." />
          <p className="text-[11px] text-gray-400 mt-2">O markup de cada SKU e o preço podem ser ajustados linha a linha na tabela abaixo.</p>
        </CardContent></Card>
      </div>

      {/* ---------------- tabela ---------------- */}
      <Card><CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 1180 }}>
            <thead><tr className="border-b border-gray-200">
              <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Sabor</th>
              <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Emb.</th>
              <th className={th}>Custo material<Info t="Custo unitário do lote em uso, módulo Indústria — insumo, garrafa, tampa e rótulo." /></th>
              <th className={th}>Conversão<Info t="Custo anual da fábrica ÷ volume anual × fator de rateio da gramatura." /></th>
              <th className={th}>Custo pleno<Info t="Material + conversão." /></th>
              <th className={th}>Markup<Info t="Multiplicador sobre o custo pleno. Editável por SKU." /></th>
              <th className={th}>Preço venda<Info t="Calculado do markup. Pode ser digitado direto — o markup da linha passa a ser apenas referência." /></th>
              <th className={th}>Imposto</th>
              <th className={th}>Com. + frete + perda</th>
              <th className={th}>Margem R$</th>
              <th className={th}>Margem %<Info t="Margem sobre o preço de venda, já deduzidos custo pleno, imposto, comissão, frete e perda." /></th>
              <th className={th}>Preço médio 12m<Info t="Faturamento ÷ unidades vendidas nos últimos 12 meses, para comparar com o preço simulado." /></th>
            </tr></thead>
            <tbody>
              {r350.map(({ r, c }) => <Linha key={c.key} r={r} c={c} />)}
              <tr className="bg-slate-100"><td colSpan={12} className="px-3 py-1.5 text-xs font-semibold text-slate-600">900 ml</td></tr>
              {r900.map(({ r, c }) => <Linha key={c.key} r={r} c={c} />)}
            </tbody>
          </table>
        </div>
      </CardContent></Card>

      {/* ---------------- proposta ---------------- */}
      <Card><CardContent className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[260px]">
            <label className="block text-xs font-semibold text-gray-600 mb-1">Gerar proposta para o cliente</label>
            <input value={cliente} onChange={(e) => setCliente(e.target.value)}
              placeholder="Nome do cliente, como deve sair na proposta"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500" />
          </div>
          <button type="button" onClick={gerarProposta} disabled={gerando}
            className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-50">
            {gerando ? "Gerando…" : "Gerar proposta em PDF"}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          A proposta sai no padrão usado com Hot Park e Lagoa: papel timbrado, tabela de preços por gramatura com os preços desta tela,
          condições de fardo, palete, validade e entrega, e o bloco de contatos. A margem NÃO vai no documento do cliente.
        </p>
      </CardContent></Card>

      <p className="text-[11px] text-gray-400">
        O custo de conversão é um rateio médio da fábrica, não um custo medido por SKU: sabores com mais etapas ou maior perda de processo
        custam mais do que a média mostra. Use como piso de tabela, não como verdade SKU a SKU. O custo de material vem do lote em uso e
        muda a cada novo lote produzido.
      </p>
    </div>
  );
}
