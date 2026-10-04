// client/src/pages/Comodatos.tsx
// -----------------------------------------------------------------------------
// CONTRATOS DE COMODATO  (tela /comodatos, grupo Clientes) — 04/out/2026
//
// Freezers/geladeiras da PURO em comodato nos pontos de venda: comodatário,
// endereço de instalação, equipamento (marca/modelo/série), valor do bem, data,
// assinaturas, status, devolução e cópia digitalizada do contrato.
// Fonte: /api/comodatos (server/comodatos-routes.ts).
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { exportToExcel } from "@/lib/excelExport";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Loader2, Search, FileDown, Paperclip, Trash2, AlertTriangle, CheckCircle2, Snowflake, Link2, Upload, ArrowUp, ArrowDown, ArrowUpDown, FileText, FileX2,
} from "lucide-react";

const SIGNATARIO_PURO_PADRAO = "Flavio Evangelista Baylão Neto";

// colunas ordenáveis → função que extrai a chave de ordenação
const ORDENACOES: Record<string, (c: any) => string | number> = {
  codigo: (c) => Number(c.numero) || 0,
  cliente: (c) => (c.cliente_fantasia || c.cliente_nome || c.cliente_razao || "").toLowerCase(),
  comodatario: (c) => (c.apelido_ponto || c.comodatario_razao || "").toLowerCase(),
  vendedor: (c) => (c.vendedor_nome || "").toLowerCase(),
  instalacao: (c) => (c.endereco_instalacao || "").toLowerCase(),
  equipamento: (c) => [c.marca, c.modelo, c.numero_serie].join(" ").toLowerCase(),
  valor: (c) => Number(c.valor_bem) || 0,
  data: (c) => c.data_contrato || "",
  status: (c) => c.status || "",
};
const colar = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

const brl = (v: any) =>
  v == null || isNaN(Number(v)) ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dt = (v: any) => {
  if (!v) return "—";
  const [y, m, d] = String(v).slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : String(v);
};

const STATUS: Record<string, { label: string; cls: string }> = {
  ativo: { label: "Ativo", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  pendente_assinatura: { label: "Pendente assinatura", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  encerrado: { label: "Encerrado", cls: "bg-slate-100 text-slate-700 border-slate-200" },
  devolvido: { label: "Devolvido", cls: "bg-blue-100 text-blue-800 border-blue-200" },
  cancelado: { label: "Cancelado", cls: "bg-rose-100 text-rose-800 border-rose-200" },
};
const TIPOS: Record<string, string> = { freezer: "Freezer", geladeira: "Geladeira", visa_cooler: "Visa cooler", outro: "Outro" };
const GRAV_CLS: Record<string, string> = {
  alta: "bg-red-100 text-red-800 border-red-200",
  media: "bg-amber-100 text-amber-800 border-amber-200",
  baixa: "bg-slate-100 text-slate-600 border-slate-200",
};

const VAZIO: any = {
  customerId: null, clienteNome: "",
  comodatarioRazao: "", comodatarioCnpj: "", apelidoPonto: "",
  enderecoInstalacao: "", cidade: "Goiânia", uf: "GO", cep: "",
  equipamentoTipo: "freezer", marca: "", modelo: "", numeroSerie: "", codigoProduto: "",
  tensao: "220V", volumeLitros: "", volumeBrutoLitros: "", valorBem: "",
  dataContrato: "", prazo: "Indeterminado", status: "ativo",
  assinadoComodante: false, assinadoComodatario: false, testemunhasAssinadas: false,
  signatarioComodatario: "", signatarioComodante: SIGNATARIO_PURO_PADRAO, equipamentoUsado: false,
  dataDevolucao: "", condicaoDevolucao: "", observacoes: "",
  nfAquisicaoNumero: "", nfAquisicaoData: "", nfAquisicaoFornecedor: "", nfAquisicaoValor: "",
};

function paraForm(c: any) {
  return {
    customerId: c.customer_id, clienteNome: c.cliente_fantasia || c.cliente_nome || "",
    comodatarioRazao: c.comodatario_razao || "", comodatarioCnpj: c.comodatario_cnpj || "",
    apelidoPonto: c.apelido_ponto || "", enderecoInstalacao: c.endereco_instalacao || "",
    cidade: c.cidade || "", uf: c.uf || "", cep: c.cep || "",
    equipamentoTipo: c.equipamento_tipo || "freezer", marca: c.marca || "", modelo: c.modelo || "",
    numeroSerie: c.numero_serie || "", codigoProduto: c.codigo_produto || "", tensao: c.tensao || "",
    volumeLitros: c.volume_litros ?? "", volumeBrutoLitros: c.volume_bruto_litros ?? "",
    valorBem: c.valor_bem ?? "", dataContrato: c.data_contrato || "", prazo: c.prazo || "Indeterminado",
    status: c.status || "ativo",
    assinadoComodante: !!c.assinado_comodante, assinadoComodatario: !!c.assinado_comodatario,
    testemunhasAssinadas: !!c.testemunhas_assinadas, signatarioComodatario: c.signatario_comodatario || "",
    signatarioComodante: c.signatario_comodante || SIGNATARIO_PURO_PADRAO, equipamentoUsado: !!c.equipamento_usado,
    dataDevolucao: c.data_devolucao || "", condicaoDevolucao: c.condicao_devolucao || "",
    observacoes: c.observacoes || "",
    nfAquisicaoNumero: c.nf_aquisicao_numero || "", nfAquisicaoData: c.nf_aquisicao_data || "",
    nfAquisicaoFornecedor: c.nf_aquisicao_fornecedor || "", nfAquisicaoValor: c.nf_aquisicao_valor ?? "",
  };
}

async function api(url: string, opts: RequestInit = {}) {
  const r = await fetch(url, { credentials: "include", ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
  return j;
}

export default function Comodatos() {
  const { toast } = useToast();
  const [busca, setBusca] = useState("");
  const [fStatus, setFStatus] = useState<string>("todos");
  const [ordem, setOrdem] = useState<{ col: string; asc: boolean }>({ col: "comodatario", asc: true });
  const [soPendentes, setSoPendentes] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState<any>({ ...VAZIO });
  const [salvando, setSalvando] = useState(false);
  const [anexos, setAnexos] = useState<any[]>([]);
  const [buscaCli, setBuscaCli] = useState("");
  const [consultandoCnpj, setConsultandoCnpj] = useState(false);
  const [gerandoPdf, setGerandoPdf] = useState(false);
  const [distrato, setDistrato] = useState<{ contrato: any; dataDistrato: string; dataDevolucao: string; condicao: string; motivo: string; pendencias: string; encerrar: boolean } | null>(null);
  const [gerandoDistrato, setGerandoDistrato] = useState(false);
  const [cliOpcoes, setCliOpcoes] = useState<any[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/comodatos"],
    queryFn: () => api("/api/comodatos"),
  });
  const itens: any[] = data?.itens || [];
  const resumo = data?.resumo;

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const qd = q.replace(/\D/g, "");
    return itens.filter((c) => {
      if (fStatus !== "todos" && c.status !== fStatus) return false;
      if (soPendentes && !c.pendencias?.some((p: any) => p.gravidade !== "baixa")) return false;
      if (!q) return true;
      const hay = [c.codigo, c.comodatario_razao, c.apelido_ponto, c.endereco_instalacao, c.marca, c.modelo,
        c.numero_serie, c.cliente_nome, c.cliente_fantasia, c.cliente_razao, c.vendedor_nome].join(" ").toLowerCase();
      return hay.includes(q) || (qd.length >= 4 && [c.comodatario_cnpj, c.cliente_cnpj].some((x) => String(x || "").replace(/\D/g, "").includes(qd)));
    }).sort((a, b) => {
      const f = ORDENACOES[ordem.col] || ORDENACOES.comodatario;
      const va = f(a), vb = f(b);
      // vazio sempre no fim, independente da direção
      if (va === "" && vb !== "") return 1;
      if (vb === "" && va !== "") return -1;
      const r = typeof va === "number" && typeof vb === "number" ? va - vb : colar.compare(String(va), String(vb));
      return ordem.asc ? r : -r;
    });
  }, [itens, busca, fStatus, soPendentes, ordem]);

  const ordenarPor = (col: string) => setOrdem((o) => (o.col === col ? { col, asc: !o.asc } : { col, asc: true }));
  const Th = ({ col, children, className = "" }: { col?: string; children: ReactNode; className?: string }) => (
    <TableHead className={`bg-slate-100 whitespace-nowrap ${col ? "cursor-pointer select-none hover:bg-slate-200" : ""} ${className}`}
      onClick={col ? () => ordenarPor(col) : undefined}>
      <span className="inline-flex items-center gap-1">
        {children}
        {col && (ordem.col === col
          ? (ordem.asc ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
          : <ArrowUpDown className="w-3 h-3 opacity-30" />)}
      </span>
    </TableHead>
  );

  const recarregar = () => queryClient.invalidateQueries({ queryKey: ["/api/comodatos"] });

  const abrirNovo = () => {
    setEditId(null); setForm({ ...VAZIO }); setAnexos([]); setBuscaCli(""); setCliOpcoes([]); setAberto(true);
  };
  const abrirEdicao = async (c: any) => {
    setEditId(c.id); setForm(paraForm(c)); setAnexos([]); setBuscaCli(""); setCliOpcoes([]); setAberto(true);
    try { const det = await api(`/api/comodatos/${c.id}`); setAnexos(det.anexosLista || []); } catch { /* lista vazia */ }
  };

  const buscarCliente = async (q: string) => {
    setBuscaCli(q);
    if (q.trim().length < 2) { setCliOpcoes([]); return; }
    try { setCliOpcoes(await api(`/api/comodatos/clientes-busca?q=${encodeURIComponent(q)}`)); } catch { setCliOpcoes([]); }
  };

  // lupa do CNPJ: Receita Federal + cliente já cadastrado com o mesmo CNPJ
  const consultarCnpj = async () => {
    const dig = String(form.comodatarioCnpj || "").replace(/\D/g, "");
    if (dig.length !== 14) { toast({ title: "Informe um CNPJ com 14 dígitos", variant: "destructive" }); return; }
    setConsultandoCnpj(true);
    try {
      const r = await api(`/api/comodatos/cnpj/${dig}`);
      const rc = r.receita;
      setForm((f: any) => ({
        ...f,
        comodatarioCnpj: rc?.cnpj || f.comodatarioCnpj,
        comodatarioRazao: rc?.razaoSocial || f.comodatarioRazao,
        apelidoPonto: r.cliente ? (r.cliente.fantasy_name || r.cliente.name) : (f.apelidoPonto || rc?.nomeFantasia || ""),
        enderecoInstalacao: f.enderecoInstalacao || rc?.endereco || "",
        cidade: rc?.cidade || f.cidade,
        uf: rc?.uf || f.uf,
        cep: rc?.cep || f.cep,
        customerId: f.customerId || r.cliente?.id || null,
        clienteNome: f.customerId ? f.clienteNome : (r.cliente ? (r.cliente.fantasy_name || r.cliente.name) : f.clienteNome),
      }));
      if (rc) {
        toast({ title: `Receita: ${rc.razaoSocial}`, description: `${rc.situacao || ""}${r.cliente ? " · cliente já cadastrado, vínculo feito" : " · não há cliente cadastrado com esse CNPJ"}` });
      } else {
        toast({ title: "Receita indisponível", description: `${r.erroReceita || ""}${r.cliente ? " — vínculo com o cliente cadastrado feito" : ""}`, variant: r.cliente ? "default" : "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Falha na consulta", description: e?.message, variant: "destructive" });
    } finally {
      setConsultandoCnpj(false);
    }
  };

  // PDF do contrato para assinatura (do que está no formulário; não exige salvar)
  const gerarPdf = async () => {
    if (!form.comodatarioRazao.trim()) { toast({ title: "Informe a razão social do comodatário para gerar o contrato", variant: "destructive" }); return; }
    setGerandoPdf(true);
    try {
      const body: any = { ...form, codigo: editId ? itens.find((i) => i.id === editId)?.codigo : undefined };
      delete body.clienteNome;
      const r = await fetch("/api/comodatos/contrato.pdf", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      toast({ title: "Erro ao gerar o PDF", description: e?.message, variant: "destructive" });
    } finally {
      setGerandoPdf(false);
    }
  };

  const abrirDistrato = (c: any) => {
    const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    setDistrato({ contrato: c, dataDistrato: hoje, dataDevolucao: c.data_devolucao || hoje, condicao: c.condicao_devolucao || "",
      motivo: c.distrato_motivo || "", pendencias: c.distrato_pendencias || "", encerrar: !["encerrado", "devolvido", "cancelado"].includes(c.status) });
  };
  const gerarDistrato = async () => {
    if (!distrato) return;
    setGerandoDistrato(true);
    try {
      const { contrato, ...campos } = distrato;
      const r = await fetch(`/api/comodatos/${contrato.id}/distrato`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(campos),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (campos.encerrar) { await recarregar(); toast({ title: `Contrato ${contrato.codigo} encerrado`, description: "Distrato gerado e devolução registrada." }); }
      else toast({ title: "Distrato gerado", description: "O contrato continua com o status atual." });
      setDistrato(null);
    } catch (e: any) {
      toast({ title: "Erro ao gerar o distrato", description: e?.message, variant: "destructive" });
    } finally {
      setGerandoDistrato(false);
    }
  };

  const salvar = async () => {
    if (!form.comodatarioRazao.trim()) { toast({ title: "Informe a razão social do comodatário", variant: "destructive" }); return; }
    setSalvando(true);
    try {
      const body: any = { ...form };
      delete body.clienteNome;
      body.valorBem = form.valorBem === "" ? null : Number(String(form.valorBem).replace(",", "."));
      body.nfAquisicaoValor = form.nfAquisicaoValor === "" ? null : Number(String(form.nfAquisicaoValor).replace(",", "."));
      const url = editId ? `/api/comodatos/${editId}` : "/api/comodatos";
      await api(url, {
        method: editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await recarregar();
      toast({ title: editId ? "Contrato atualizado" : "Contrato cadastrado" });
      setAberto(false);
    } catch (e: any) {
      toast({ title: "Erro ao salvar", description: e?.message, variant: "destructive" });
    } finally {
      setSalvando(false);
    }
  };

  const excluir = async () => {
    if (!editId) return;
    if (!window.confirm("Excluir este contrato de comodato?")) return;
    try { await api(`/api/comodatos/${editId}`, { method: "DELETE" }); await recarregar(); setAberto(false); }
    catch (e: any) { toast({ title: "Erro ao excluir", description: e?.message, variant: "destructive" }); }
  };

  const enviarAnexo = async (file: File) => {
    if (!editId) return;
    const fd = new FormData();
    fd.append("arquivo", file);
    try {
      const a = await api(`/api/comodatos/${editId}/anexos`, { method: "POST", body: fd });
      setAnexos((l) => [...l, a]);
      recarregar();
    } catch (e: any) {
      toast({ title: "Falha no anexo", description: e?.message, variant: "destructive" });
    }
  };
  const removerAnexo = async (id: string) => {
    if (!window.confirm("Remover este anexo?")) return;
    await api(`/api/comodatos/anexos/${id}`, { method: "DELETE" }).catch(() => {});
    setAnexos((l) => l.filter((a) => a.id !== id));
    recarregar();
  };

  const exportar = () => {
    exportToExcel(filtrados.map((c) => ({
      "Código": c.codigo,
      "Comodatário - Nome fantasia (ponto)": c.apelido_ponto || "",
      "Comodatário - Razão social": c.comodatario_razao,
      "Comodatário - CNPJ": c.comodatario_cnpj || "",
      "Cliente - Nome fantasia": c.cliente_fantasia || c.cliente_nome || "",
      "Cliente - Razão social": c.cliente_razao || "",
      "Cliente - CNPJ": c.cliente_cnpj || "",
      "Vendedor": c.vendedor_nome || "",
      "Endereço de instalação": c.endereco_instalacao || "",
      "Cidade/UF": [c.cidade, c.uf].filter(Boolean).join("/"),
      "CEP": c.cep || "",
      "Equipamento": TIPOS[c.equipamento_tipo] || c.equipamento_tipo,
      "Marca": c.marca || "", "Modelo": c.modelo || "", "Nº de série": c.numero_serie || "",
      "Código produto": c.codigo_produto || "", "Tensão": c.tensao || "",
      "Volume (L)": c.volume_litros ?? "", "Volume bruto (L)": c.volume_bruto_litros ?? "",
      "Valor do bem": c.valor_bem ?? "",
      "Data do contrato": dt(c.data_contrato), "Prazo": c.prazo,
      "Status": STATUS[c.status]?.label || c.status,
      "Assinado PURO": c.assinado_comodante ? "Sim" : "Não",
      "Assinado comodatário": c.assinado_comodatario ? "Sim" : "Não",
      "Testemunhas": c.testemunhas_assinadas ? "Sim" : "Não",
      "Signatário": c.signatario_comodatario || "",
      "Devolução": dt(c.data_devolucao),
      "Pendências": (c.pendencias || []).map((p: any) => p.texto).join("; "),
      "NF de aquisição": c.nf_aquisicao_numero || "",
      "Data NF": dt(c.nf_aquisicao_data),
      "Fornecedor NF": c.nf_aquisicao_fornecedor || "",
      "Valor NF": c.nf_aquisicao_valor ?? "",
      "Anexos": c.anexos || 0,
      "Observações": c.observacoes || "",
    })), `Contratos_Comodato_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <BackToDashboardButton />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Snowflake className="w-6 h-6 text-sky-600" />Contratos de Comodato</h1>
          <p className="text-sm text-muted-foreground">Freezers e geladeiras da PURO em comodato nos pontos de venda Honest.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportar} disabled={!filtrados.length}><FileDown className="w-4 h-4 mr-2" />Excel</Button>
          <Button onClick={abrirNovo}><Plus className="w-4 h-4 mr-2" />Novo contrato</Button>
        </div>
      </div>

      {resumo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Equipamentos em campo</div>
            <div className="text-2xl font-bold">{resumo.equipamentosEmCampo}</div>
            <div className="text-xs text-muted-foreground">{resumo.total} contrato(s) no total</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Valor dos bens em campo</div>
            <div className="text-2xl font-bold">{brl(resumo.valorEmCampo)}</div>
            <div className="text-xs text-muted-foreground">{(resumo.porMarca || []).map((m: any) => `${m.marca}: ${m.qtd}`).join(" · ")}</div>
          </CardContent></Card>
          <Card className="cursor-pointer" onClick={() => setSoPendentes((v) => !v)}><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Com pendência a regularizar</div>
            <div className="text-2xl font-bold text-amber-600">{resumo.comPendencia}</div>
            <div className="text-xs text-muted-foreground">{soPendentes ? "Filtrando — clique para limpar" : "Clique para filtrar"}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Sem assinatura da PURO</div>
            <div className="text-2xl font-bold text-red-600">{resumo.semAssinaturaPuro}</div>
            <div className="text-xs text-muted-foreground">contratos ativos</div>
          </CardContent></Card>
        </div>
      )}

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
          <Input className="pl-8" placeholder="Buscar por cliente, ponto, razão social, CNPJ, vendedor, série, marca…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <select className="border rounded-md h-9 px-2 text-sm bg-background" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="todos">Todos os status</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={soPendentes} onCheckedChange={(v) => setSoPendentes(!!v)} />Só com pendência
        </label>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Carregando…</div>
      ) : error ? (
        <div className="text-red-600">Erro: {(error as any)?.message}</div>
      ) : (
        <div className="border rounded-md overflow-auto max-h-[70vh]">
          <Table>
            <TableHeader className="sticky top-0 z-10 shadow-sm">
              <TableRow>
                <Th col="codigo">Código</Th>
                <Th col="comodatario">Comodatário</Th>
                <Th col="cliente">Cliente vinculado</Th>
                <Th col="vendedor">Vendedor</Th>
                <Th col="instalacao">Instalação</Th>
                <Th col="equipamento">Equipamento</Th>
                <Th col="valor" className="text-right">Valor</Th>
                <Th col="data">Data</Th>
                <Th col="status">Status</Th>
                <Th>Pendências</Th>
                <Th>Ações</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtrados.map((c) => (
                <TableRow key={c.id} className="cursor-pointer hover:bg-muted/50" onClick={() => abrirEdicao(c)}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{c.codigo}</TableCell>
                  <TableCell className="min-w-[200px]">
                    <div className="font-medium">{c.apelido_ponto || c.comodatario_razao}</div>
                    {c.apelido_ponto && <div className="text-xs text-muted-foreground">{c.comodatario_razao}</div>}
                    <div className="text-xs text-muted-foreground font-mono">{c.comodatario_cnpj}</div>
                  </TableCell>
                  <TableCell className="min-w-[200px]">
                    {c.customer_id ? (
                      <>
                        <div className="font-medium flex items-center gap-1"><Link2 className="w-3 h-3 text-emerald-600" />{c.cliente_fantasia || c.cliente_nome}</div>
                        <div className="text-xs text-muted-foreground">{c.cliente_razao || c.cliente_nome}</div>
                        <div className="text-xs text-muted-foreground font-mono">{c.cliente_cnpj}</div>
                      </>
                    ) : <span className="text-xs text-amber-700">Não vinculado</span>}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{c.vendedor_nome || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-xs max-w-[240px]">
                    {c.endereco_instalacao || <span className="text-muted-foreground">—</span>}
                    {c.cep && <div className="text-muted-foreground">CEP {c.cep}</div>}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="font-medium">{TIPOS[c.equipamento_tipo] || c.equipamento_tipo} {c.marca || ""}</div>
                    <div className="text-muted-foreground">
                      {[c.modelo && `Mod. ${c.modelo}`, c.numero_serie && `Série ${c.numero_serie}`, c.tensao, c.volume_litros && `${c.volume_litros} L`].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">{brl(c.valor_bem)}</TableCell>
                  <TableCell className="whitespace-nowrap">{dt(c.data_contrato)}</TableCell>
                  <TableCell><Badge variant="outline" className={STATUS[c.status]?.cls}>{STATUS[c.status]?.label || c.status}</Badge></TableCell>
                  <TableCell>
                    {c.pendencias?.length ? (
                      <div className="flex flex-wrap gap-1 max-w-[260px]">
                        {c.pendencias.map((p: any) => (
                          <Badge key={p.codigo} variant="outline" className={`text-[10px] ${GRAV_CLS[p.gravidade]}`}>{p.texto}</Badge>
                        ))}
                      </div>
                    ) : <span className="text-emerald-600 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />OK</span>}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" title="Contrato em PDF" onClick={() => window.open(`/api/comodatos/${c.id}/contrato.pdf`, "_blank")}>
                        <FileText className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant={c.distrato_data ? "secondary" : "outline"} size="sm" className="whitespace-nowrap" title={c.distrato_data ? `Distrato de ${dt(c.distrato_data)}` : "Gerar distrato"} onClick={() => abrirDistrato(c)}>
                        <FileX2 className="w-3.5 h-3.5 mr-1" />Distrato
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!filtrados.length && (
                <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">Nenhum contrato encontrado.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Editar contrato de comodato" : "Novo contrato de comodato"}</DialogTitle>
            <DialogDescription>Comodante: PURO INDÚSTRIA E COMÉRCIO DE PRODUTOS NATURAIS LTDA — CNPJ 28.295.493/0001-53</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <section className="space-y-3">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase">Comodatário</h3>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <Label>CNPJ do comodatário</Label>
                  <div className="flex gap-1">
                    <Input value={form.comodatarioCnpj} onChange={(e) => set("comodatarioCnpj", e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); consultarCnpj(); } }} />
                    <Button type="button" variant="outline" size="icon" title="Buscar dados na Receita Federal" onClick={consultarCnpj} disabled={consultandoCnpj}>
                      {consultandoCnpj ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
                <div><Label>Razão social (conforme CNPJ) *</Label><Input value={form.comodatarioRazao} onChange={(e) => set("comodatarioRazao", e.target.value)} /></div>
                <div className="md:col-span-2"><Label>Apelido do ponto</Label><Input placeholder="Preenchido com o nome fantasia do cliente vinculado" value={form.apelidoPonto} onChange={(e) => set("apelidoPonto", e.target.value)} /></div>
                <div className="md:col-span-2">
                  <Label>Cliente vinculado</Label>
                  {form.customerId ? (
                    <div className="flex items-center gap-2 text-sm">
                      <Link2 className="w-4 h-4 text-emerald-600" />{form.clienteNome || form.customerId}
                      <Button variant="ghost" size="sm" onClick={() => setForm((f: any) => ({ ...f, customerId: null, clienteNome: "" }))}>desvincular</Button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Input placeholder="Buscar cliente por nome ou CNPJ (o vínculo também é feito sozinho pelo CNPJ)" value={buscaCli} onChange={(e) => buscarCliente(e.target.value)} />
                      {cliOpcoes.length > 0 && (
                        <div className="absolute z-20 bg-background border rounded-md mt-1 w-full max-h-48 overflow-auto shadow">
                          {cliOpcoes.map((o) => (
                            <button key={o.id} type="button" className="block w-full text-left px-3 py-1.5 text-sm hover:bg-muted"
                              onClick={() => { setForm((f: any) => ({ ...f, customerId: o.id, clienteNome: o.fantasy_name || o.name, apelidoPonto: o.fantasy_name || o.name || f.apelidoPonto })); setCliOpcoes([]); setBuscaCli(""); }}>
                              {o.fantasy_name || o.name} <span className="text-xs text-muted-foreground">{o.cnpj || o.cpf} {o.city ? `· ${o.city}` : ""}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="md:col-span-2"><Label>Endereço de instalação</Label><Input value={form.enderecoInstalacao} onChange={(e) => set("enderecoInstalacao", e.target.value)} /></div>
                <div><Label>Cidade</Label><Input value={form.cidade} onChange={(e) => set("cidade", e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>UF</Label><Input maxLength={2} value={form.uf} onChange={(e) => set("uf", e.target.value.toUpperCase())} /></div>
                  <div><Label>CEP</Label><Input value={form.cep} onChange={(e) => set("cep", e.target.value)} /></div>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase">Equipamento</h3>
              <div className="grid md:grid-cols-3 gap-3">
                <div><Label>Tipo</Label>
                  <select className="border rounded-md h-9 px-2 text-sm w-full bg-background" value={form.equipamentoTipo} onChange={(e) => set("equipamentoTipo", e.target.value)}>
                    {Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div><Label>Marca</Label><Input value={form.marca} onChange={(e) => set("marca", e.target.value)} /></div>
                <div><Label>Modelo</Label><Input value={form.modelo} onChange={(e) => set("modelo", e.target.value)} /></div>
                <div><Label>Nº de série</Label><Input value={form.numeroSerie} onChange={(e) => set("numeroSerie", e.target.value)} /></div>
                <div><Label>Código do produto</Label><Input value={form.codigoProduto} onChange={(e) => set("codigoProduto", e.target.value)} /></div>
                <div><Label>Tensão</Label><Input value={form.tensao} onChange={(e) => set("tensao", e.target.value)} /></div>
                <div><Label>Volume (L)</Label><Input type="number" value={form.volumeLitros} onChange={(e) => set("volumeLitros", e.target.value)} /></div>
                <div><Label>Volume bruto (L)</Label><Input type="number" value={form.volumeBrutoLitros} onChange={(e) => set("volumeBrutoLitros", e.target.value)} /></div>
                <div><Label>Valor do bem (R$)</Label><Input type="number" step="0.01" value={form.valorBem} onChange={(e) => set("valorBem", e.target.value)} /></div>
              </div>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.equipamentoUsado} onCheckedChange={(v) => set("equipamentoUsado", !!v)} />Equipamento usado (o contrato sai "usado" em vez de "sem uso")</label>
              <div className="grid md:grid-cols-4 gap-3">
                <div><Label>NF de aquisição</Label><Input value={form.nfAquisicaoNumero} onChange={(e) => set("nfAquisicaoNumero", e.target.value)} /></div>
                <div><Label>Data da NF</Label><Input type="date" value={form.nfAquisicaoData} onChange={(e) => set("nfAquisicaoData", e.target.value)} /></div>
                <div><Label>Valor da NF (R$)</Label><Input type="number" step="0.01" value={form.nfAquisicaoValor} onChange={(e) => set("nfAquisicaoValor", e.target.value)} /></div>
                <div className="md:col-span-4"><Label>Fornecedor da NF</Label><Input value={form.nfAquisicaoFornecedor} onChange={(e) => set("nfAquisicaoFornecedor", e.target.value)} /></div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase">Contrato</h3>
              <div className="grid md:grid-cols-3 gap-3">
                <div><Label>Data do contrato</Label><Input type="date" value={form.dataContrato} onChange={(e) => set("dataContrato", e.target.value)} /></div>
                <div><Label>Prazo</Label><Input value={form.prazo} onChange={(e) => set("prazo", e.target.value)} /></div>
                <div><Label>Status</Label>
                  <select className="border rounded-md h-9 px-2 text-sm w-full bg-background" value={form.status} onChange={(e) => set("status", e.target.value)}>
                    {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap gap-5 text-sm">
                <label className="flex items-center gap-2"><Checkbox checked={form.assinadoComodante} onCheckedChange={(v) => set("assinadoComodante", !!v)} />Assinado pela PURO</label>
                <label className="flex items-center gap-2"><Checkbox checked={form.assinadoComodatario} onCheckedChange={(v) => set("assinadoComodatario", !!v)} />Assinado pelo comodatário</label>
                <label className="flex items-center gap-2"><Checkbox checked={form.testemunhasAssinadas} onCheckedChange={(v) => set("testemunhasAssinadas", !!v)} />2 testemunhas assinaram</label>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div><Label>Assina pela PURO (comodante)</Label><Input value={form.signatarioComodante} onChange={(e) => set("signatarioComodante", e.target.value)} /></div>
                <div><Label>Assina pelo comodatário</Label><Input value={form.signatarioComodatario} onChange={(e) => set("signatarioComodatario", e.target.value)} /></div>
              </div>
              {["encerrado", "devolvido"].includes(form.status) && (
                <div className="grid md:grid-cols-3 gap-3">
                  <div><Label>Data da devolução</Label><Input type="date" value={form.dataDevolucao} onChange={(e) => set("dataDevolucao", e.target.value)} /></div>
                  <div className="md:col-span-2"><Label>Condição na devolução</Label><Input value={form.condicaoDevolucao} onChange={(e) => set("condicaoDevolucao", e.target.value)} /></div>
                </div>
              )}
              <div><Label>Observações</Label><Textarea rows={3} value={form.observacoes} onChange={(e) => set("observacoes", e.target.value)} /></div>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase flex items-center gap-2"><Paperclip className="w-4 h-4" />Contrato digitalizado</h3>
              {!editId ? (
                <p className="text-xs text-muted-foreground">Salve o contrato para anexar as fotos/PDF.</p>
              ) : (
                <>
                  {anexos.length === 0 && (
                    <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Nenhuma cópia anexada.</p>
                  )}
                  <ul className="space-y-1">
                    {anexos.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-sm">
                        <a className="text-blue-600 hover:underline" href={`/api/comodatos/anexos/${a.id}`} target="_blank" rel="noreferrer">{a.file_name}</a>
                        <span className="text-xs text-muted-foreground">{Math.round((a.file_size || 0) / 1024)} KB</span>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removerAnexo(a.id)}><Trash2 className="w-3 h-3" /></Button>
                      </li>
                    ))}
                  </ul>
                  <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple className="hidden"
                    onChange={(e) => { Array.from(e.target.files || []).forEach(enviarAnexo); e.target.value = ""; }} />
                  <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Upload className="w-4 h-4 mr-2" />Anexar fotos/PDF</Button>
                </>
              )}
            </section>
          </div>

          <DialogFooter className="gap-2">
            {editId && <Button variant="ghost" className="text-red-600" onClick={excluir}><Trash2 className="w-4 h-4 mr-2" />Excluir</Button>}
            <Button variant="secondary" className="mr-auto" onClick={gerarPdf} disabled={gerandoPdf}>
              {gerandoPdf ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}Gerar contrato (PDF)
            </Button>
            <Button variant="outline" onClick={() => setAberto(false)}>Cancelar</Button>
            <Button onClick={salvar} disabled={salvando}>{salvando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!distrato} onOpenChange={(o) => { if (!o) setDistrato(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Distrato do contrato {distrato?.contrato?.codigo}</DialogTitle>
            <DialogDescription>{distrato?.contrato?.apelido_ponto || distrato?.contrato?.comodatario_razao} — {TIPOS[distrato?.contrato?.equipamento_tipo] || ""} {distrato?.contrato?.marca || ""} {distrato?.contrato?.numero_serie ? `série ${distrato?.contrato?.numero_serie}` : ""}</DialogDescription>
          </DialogHeader>
          {distrato && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Data do distrato</Label><Input type="date" value={distrato.dataDistrato} onChange={(e) => setDistrato({ ...distrato, dataDistrato: e.target.value })} /></div>
                <div><Label>Data da devolução</Label><Input type="date" value={distrato.dataDevolucao} onChange={(e) => setDistrato({ ...distrato, dataDevolucao: e.target.value })} /></div>
              </div>
              <div><Label>Condição do equipamento na devolução</Label><Input placeholder="perfeito estado de conservação e funcionamento" value={distrato.condicao} onChange={(e) => setDistrato({ ...distrato, condicao: e.target.value })} /></div>
              <div><Label>Motivo (opcional)</Label><Input placeholder="Ex.: encerramento das atividades do ponto" value={distrato.motivo} onChange={(e) => setDistrato({ ...distrato, motivo: e.target.value })} /></div>
              <div><Label>Pendências a cobrar (opcional)</Label><Textarea rows={2} placeholder="Avarias ou valores devidos; em branco = quitação plena" value={distrato.pendencias} onChange={(e) => setDistrato({ ...distrato, pendencias: e.target.value })} /></div>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={distrato.encerrar} onCheckedChange={(v) => setDistrato({ ...distrato, encerrar: !!v })} />Encerrar o contrato e registrar a devolução ao gerar</label>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDistrato(null)}>Cancelar</Button>
            <Button onClick={gerarDistrato} disabled={gerandoDistrato}>{gerandoDistrato ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileX2 className="w-4 h-4 mr-2" />}Gerar distrato (PDF)</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
