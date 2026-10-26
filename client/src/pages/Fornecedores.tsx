import { useRef, useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { Plus, Pencil, Paperclip, Trash2, Download, ExternalLink, Copy, Loader2, ShieldAlert, FileText } from "lucide-react";
import { Link } from "wouter";

// ---------------------------------------------------------------------------
// Cadastro de Fornecedores — novo, edição, dados de pagamento e anexos.
// Backend: POST /api/suppliers (cria) · GET/PUT /api/suppliers/:id/cadastro ·
// POST /api/suppliers/:id/anexos · GET/DELETE /api/suppliers/anexos/:attId
// ---------------------------------------------------------------------------

const EMPTY = {
  name: "", companyName: "", cnpj: "", cpf: "", stateRegistration: "", email: "", phone: "",
  contactName: "", address: "", addressNumber: "", addressComplement: "", neighborhood: "", city: "", state: "", zipCode: "",
  defaultCategory: "", notes: "", isActive: true,
  paymentMethod: "", paymentTerms: "", bankCode: "", bankName: "", bankAgency: "", bankAccount: "", bankAccountType: "",
  accountHolderName: "", accountHolderDocument: "", pixKeyType: "", pixKey: "", paymentNotes: "",
  isCritical: false, criticalApprovedBy: "", criticalApprovedAt: "", criticalValidUntil: "", criticalNotes: "",
};

const APROVADORES = [{ v: "naiara", l: "Naiara" }, { v: "flavio", l: "Flavio" }];
const TIPOS_PENDENCIA = ["Licença sanitária", "Alvará de funcionamento", "Laudo de análise", "Certificado de qualidade", "Ficha técnica", "FISPQ", "Cartão CNPJ", "Contrato", "Certidão negativa", "Outro"];
const SITUACAO_PEND: Record<string, { l: string; cls: string }> = {
  pendente: { l: "Sem anexo", cls: "bg-amber-100 text-amber-800" },
  vencido: { l: "Vencido", cls: "bg-red-100 text-red-800" },
  vencendo: { l: "Vence em ≤30 dias", cls: "bg-orange-100 text-orange-800" },
  ok: { l: "Em dia", cls: "bg-green-100 text-green-800" },
};
const fmtData = (d: any) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("pt-BR") : "—");

const FORMAS = [
  { v: "boleto", l: "Boleto" },
  { v: "transferencia", l: "Transferência (TED)" },
  { v: "pix", l: "PIX" },
  { v: "deposito", l: "Depósito em conta" },
  { v: "dinheiro", l: "Dinheiro" },
  { v: "cartao", l: "Cartão" },
  { v: "debito_automatico", l: "Débito automático" },
  { v: "outro", l: "Outro" },
];
const TIPOS_PIX = [
  { v: "cpf", l: "CPF" }, { v: "cnpj", l: "CNPJ" }, { v: "email", l: "E-mail" },
  { v: "telefone", l: "Telefone" }, { v: "aleatoria", l: "Chave aleatória" },
];
const TIPOS_CONTA = [{ v: "corrente", l: "Conta corrente" }, { v: "poupanca", l: "Poupança" }, { v: "pagamento", l: "Conta pagamento" }];
const BANCOS = [
  ["001", "Banco do Brasil"], ["104", "Caixa Econômica Federal"], ["237", "Bradesco"], ["341", "Itaú"],
  ["033", "Santander"], ["756", "Sicoob"], ["748", "Sicredi"], ["260", "Nubank"], ["077", "Inter"],
  ["336", "C6 Bank"], ["290", "PagBank"], ["323", "Mercado Pago"], ["380", "PicPay"], ["208", "BTG Pactual"],
  ["070", "BRB"], ["422", "Safra"], ["655", "Votorantim"], ["403", "Cora"], ["197", "Stone"], ["085", "Ailos"],
];

// colunas do banco → campos do formulário
const MAPA: Record<string, string> = {
  name: "name", company_name: "companyName", cnpj: "cnpj", cpf: "cpf", state_registration: "stateRegistration",
  email: "email", phone: "phone", contact_name: "contactName", address: "address", address_number: "addressNumber",
  address_complement: "addressComplement", neighborhood: "neighborhood", city: "city", state: "state", zip_code: "zipCode",
  default_category: "defaultCategory", notes: "notes", payment_method: "paymentMethod", payment_terms: "paymentTerms",
  bank_code: "bankCode", bank_name: "bankName", bank_agency: "bankAgency", bank_account: "bankAccount",
  bank_account_type: "bankAccountType", account_holder_name: "accountHolderName",
  account_holder_document: "accountHolderDocument", pix_key_type: "pixKeyType", pix_key: "pixKey", payment_notes: "paymentNotes",
  critical_approved_by: "criticalApprovedBy", critical_approved_at: "criticalApprovedAt", critical_valid_until: "criticalValidUntil", critical_notes: "criticalNotes",
};

const fmtBytes = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const selectCls = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

type Anexo = { id: string; file_name: string; mimetype: string; file_size: number; descricao: string | null; created_at: string };
type Pendencia = {
  id: string; tipo: string; descricao: string | null; valid_until: string | null; attachment_id: string | null;
  anexo_nome: string | null; situacao: "pendente" | "vencido" | "vencendo" | "ok";
};
type PendLocal = { tipo: string; descricao: string; validUntil: string; file: File | null }; // antes de o fornecedor existir

export default function Fornecedores() {
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [tab, setTab] = useState("dados");
  const [form, setForm] = useState<any>({ ...EMPTY });
  const [anexos, setAnexos] = useState<Anexo[]>([]);
  const [pendentes, setPendentes] = useState<File[]>([]); // arquivos escolhidos antes de o fornecedor existir
  const [descAnexo, setDescAnexo] = useState("");
  const [pendencias, setPendencias] = useState<Pendencia[]>([]);
  const [pendLocais, setPendLocais] = useState<PendLocal[]>([]);
  const [novaPend, setNovaPend] = useState<PendLocal>({ tipo: "", descricao: "", validUntil: "", file: null });
  const [salvandoPend, setSalvandoPend] = useState(false);
  const [confirmDelPend, setConfirmDelPend] = useState<string | null>(null);
  const pendFileRef = useRef<HTMLInputElement>(null);
  const pendTrocaRef = useRef<HTMLInputElement>(null);
  const [pendTrocaId, setPendTrocaId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const refreshTabela = () => queryClient.invalidateQueries({ queryKey: ["/api/synced-table", "suppliers"] });

  const limparPend = () => { setPendencias([]); setPendLocais([]); setNovaPend({ tipo: "", descricao: "", validUntil: "", file: null }); setConfirmDelPend(null); };

  const abrirNovo = () => {
    setEditId(null); setForm({ ...EMPTY }); setAnexos([]); setPendentes([]); setDescAnexo(""); limparPend();
    setError(""); setInfo(""); setTab("dados"); setConfirmDel(null); setOpen(true);
  };

  const abrirEdicao = async (id: string) => {
    setEditId(id); setForm({ ...EMPTY }); setAnexos([]); setPendentes([]); setDescAnexo(""); limparPend();
    setError(""); setInfo(""); setTab("dados"); setConfirmDel(null); setOpen(true); setLoading(true);
    try {
      const r = await fetch(`/api/suppliers/${id}/cadastro`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Falha ao carregar o fornecedor");
      const f: any = { ...EMPTY };
      for (const [col, campo] of Object.entries(MAPA)) f[campo] = j[col] ?? "";
      f.isActive = j.is_active !== false;
      f.isCritical = j.is_critical === true;
      f.criticalApprovedAt = j.critical_approved_at ? String(j.critical_approved_at).slice(0, 10) : "";
      f.criticalValidUntil = j.critical_valid_until ? String(j.critical_valid_until).slice(0, 10) : "";
      setForm(f);
      setAnexos(j.anexos || []);
      setPendencias(j.pendencias || []);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const enviarArquivo = async (id: string, file: File, descricao: string) => {
    const fd = new FormData();
    fd.append("arquivo", file);
    if (descricao) fd.append("descricao", descricao);
    const r = await fetch(`/api/suppliers/${id}/anexos`, { method: "POST", credentials: "include", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${file.name}: ${j?.error || "falha no envio"}`);
    return j as Anexo;
  };

  const escolherArquivos = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const lista = Array.from(files);
    const grandes = lista.filter((f) => f.size > 15 * 1024 * 1024);
    if (grandes.length) { setError(`Acima de 15MB: ${grandes.map((f) => f.name).join(", ")}`); return; }
    setError("");
    if (!editId) { setPendentes((p) => [...p, ...lista]); return; }
    setUploading(true);
    try {
      for (const f of lista) {
        const novo = await enviarArquivo(editId, f, descAnexo.trim());
        setAnexos((a) => [novo, ...a]);
      }
      setDescAnexo("");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const excluirAnexo = async (attId: string) => {
    try {
      const r = await fetch(`/api/suppliers/anexos/${attId}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error("Não foi possível excluir o anexo");
      setAnexos((a) => a.filter((x) => x.id !== attId));
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setConfirmDel(null);
    }
  };

  // ===== pendências do cadastro (fornecedor crítico) =====
  const enviarPendencia = async (id: string, p: PendLocal) => {
    const fd = new FormData();
    fd.append("tipo", p.tipo);
    if (p.descricao) fd.append("descricao", p.descricao);
    if (p.validUntil) fd.append("validUntil", p.validUntil);
    if (p.file) fd.append("arquivo", p.file);
    const r = await fetch(`/api/suppliers/${id}/pendencias`, { method: "POST", credentials: "include", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p.tipo}: ${j?.error || "falha ao gravar a pendência"}`);
    return j as Pendencia;
  };

  const adicionarPendencia = async () => {
    const tipo = novaPend.tipo.trim();
    if (!tipo) { setError("Informe o tipo da pendência (ex.: Licença sanitária, Laudo)."); return; }
    if (novaPend.file && novaPend.file.size > 15 * 1024 * 1024) { setError("Arquivo acima de 15MB."); return; }
    setError("");
    if (!editId) {
      setPendLocais((p) => [...p, { ...novaPend, tipo }]);
      setNovaPend({ tipo: "", descricao: "", validUntil: "", file: null });
      if (pendFileRef.current) pendFileRef.current.value = "";
      return;
    }
    setSalvandoPend(true);
    try {
      const nova = await enviarPendencia(editId, { ...novaPend, tipo });
      setPendencias((p) => [...p, nova]);
      setNovaPend({ tipo: "", descricao: "", validUntil: "", file: null });
      if (pendFileRef.current) pendFileRef.current.value = "";
      if (nova.attachment_id) {
        const rr = await fetch(`/api/suppliers/${editId}/cadastro`, { credentials: "include" });
        if (rr.ok) setAnexos((await rr.json()).anexos || []);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSalvandoPend(false);
    }
  };

  const atualizarPendencia = async (pendId: string, campos: { validUntil?: string; descricao?: string; tipo?: string; file?: File | null; removerAnexo?: boolean }) => {
    const fd = new FormData();
    if (campos.tipo !== undefined) fd.append("tipo", campos.tipo);
    if (campos.descricao !== undefined) fd.append("descricao", campos.descricao);
    if (campos.validUntil !== undefined) fd.append("validUntil", campos.validUntil);
    if (campos.file) fd.append("arquivo", campos.file);
    if (campos.removerAnexo) fd.append("removerAnexo", "1");
    try {
      const r = await fetch(`/api/suppliers/pendencias/${pendId}`, { method: "PUT", credentials: "include", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "Não foi possível atualizar a pendência");
      setPendencias((p) => p.map((x) => (x.id === pendId ? (j as Pendencia) : x)));
      if (campos.file || campos.removerAnexo) {
        const rr = await fetch(`/api/suppliers/${editId}/cadastro`, { credentials: "include" });
        if (rr.ok) setAnexos((await rr.json()).anexos || []);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };

  const excluirPendencia = async (pendId: string) => {
    try {
      const r = await fetch(`/api/suppliers/pendencias/${pendId}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error("Não foi possível excluir a pendência");
      setPendencias((p) => p.filter((x) => x.id !== pendId));
      const rr = await fetch(`/api/suppliers/${editId}/cadastro`, { credentials: "include" });
      if (rr.ok) setAnexos((await rr.json()).anexos || []);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setConfirmDelPend(null);
    }
  };

  const salvar = async () => {
    if (!String(form.name || "").trim()) { setError("Informe o nome do fornecedor."); setTab("dados"); return; }
    if (form.isCritical && form.criticalValidUntil && form.criticalApprovedAt && form.criticalValidUntil < form.criticalApprovedAt) {
      setError("A vigência não pode ser anterior à data de aprovação."); setTab("critico"); return;
    }
    setSaving(true); setError(""); setInfo("");
    try {
      let id = editId;
      if (!id) {
        const r = await fetch("/api/suppliers", {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(form),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || "Não foi possível cadastrar o fornecedor.");
        id = j.id;
      }
      const r2 = await fetch(`/api/suppliers/${id}/cadastro`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(form),
      });
      const j2 = await r2.json().catch(() => ({}));
      if (!r2.ok) throw new Error(j2?.error || "Não foi possível salvar o cadastro.");

      // anexos escolhidos no cadastro novo sobem depois que o fornecedor existe
      const falhas: string[] = [];
      for (const f of pendentes) {
        try { await enviarArquivo(id!, f, descAnexo.trim()); } catch (e: any) { falhas.push(String(e?.message || e)); }
      }
      for (const p of pendLocais) {
        try { await enviarPendencia(id!, p); } catch (e: any) { falhas.push(String(e?.message || e)); }
      }
      await refreshTabela();
      if (falhas.length) {
        setEditId(id); setPendentes([]); setPendLocais([]); setTab("anexos");
        setError(`Fornecedor salvo, mas alguns anexos falharam: ${falhas.join("; ")}`);
        const rr = await fetch(`/api/suppliers/${id}/cadastro`, { credentials: "include" });
        if (rr.ok) { const jj = await rr.json(); setAnexos(jj.anexos || []); setPendencias(jj.pendencias || []); }
        return;
      }
      setOpen(false);
    } catch (e: any) {
      setError(String(e?.message || e) || "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  const copiarDadosPagamento = async () => {
    const forma = FORMAS.find((x) => x.v === form.paymentMethod)?.l;
    const linhas = [
      `Fornecedor: ${form.companyName || form.name}`,
      form.cnpj ? `CNPJ: ${form.cnpj}` : form.cpf ? `CPF: ${form.cpf}` : "",
      forma ? `Forma de pagamento: ${forma}` : "",
      form.paymentTerms ? `Prazo: ${form.paymentTerms}` : "",
      form.pixKey ? `PIX (${TIPOS_PIX.find((x) => x.v === form.pixKeyType)?.l || "chave"}): ${form.pixKey}` : "",
      form.bankName || form.bankCode ? `Banco: ${[form.bankCode, form.bankName].filter(Boolean).join(" - ")}` : "",
      form.bankAgency ? `Agência: ${form.bankAgency}` : "",
      form.bankAccount ? `Conta${form.bankAccountType ? ` ${TIPOS_CONTA.find((x) => x.v === form.bankAccountType)?.l.toLowerCase()}` : ""}: ${form.bankAccount}` : "",
      form.accountHolderName ? `Titular: ${form.accountHolderName}${form.accountHolderDocument ? ` (${form.accountHolderDocument})` : ""}` : "",
      form.paymentNotes ? `Obs.: ${form.paymentNotes}` : "",
    ].filter(Boolean);
    try { await navigator.clipboard.writeText(linhas.join("\n")); setInfo("Dados de pagamento copiados."); } catch { setError("Não foi possível copiar."); }
  };

  const escolherBanco = (v: string) => {
    set("bankCode", v);
    const b = BANCOS.find(([c]) => c === v.padStart(3, "0"));
    if (b && !form.bankName) set("bankName", b[1]);
  };

  const mostraPix = form.paymentMethod === "pix" || !!form.pixKey;
  const mostraBanco = ["transferencia", "deposito", "debito_automatico"].includes(form.paymentMethod) || !!form.bankAccount;

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <h1 className="text-2xl font-bold">Fornecedores</h1>
        <div className="flex gap-2">
          <Link href="/fornecedores-criticos">
            <Button variant="outline" data-testid="relatorio-criticos"><ShieldAlert className="w-4 h-4 mr-2" />Fornecedores críticos</Button>
          </Link>
          <Button onClick={abrirNovo}><Plus className="w-4 h-4 mr-2" />Novo Fornecedor</Button>
        </div>
      </div>
      <SyncedTable
        table="suppliers"
        hideColumns={[
          "id", "default_chart_account_id", "omie_instance_id", "address_complement", "city_code",
          "payment_terms", "bank_code", "bank_agency", "bank_account", "bank_account_type", "account_holder_name",
          "account_holder_document", "pix_key_type", "payment_notes", "critical_approved_at", "critical_notes",
        ]}
        labels={{ name: "Nome", company_name: "Razão Social", cnpj: "CNPJ", cpf: "CPF", state_registration: "Insc. Estadual", email: "E-mail", phone: "Telefone", contact_name: "Contato", address: "Endereço", address_number: "Nº", neighborhood: "Bairro", city: "Cidade", state: "UF", zip_code: "CEP", default_category: "Categoria", notes: "Obs.", is_active: "Ativo", created_at: "Criado em", updated_at: "Atualizado em", payment_method: "Pagamento", bank_name: "Banco", pix_key: "Chave PIX", is_critical: "Crítico", critical_approved_by: "Aprovado por", critical_valid_until: "Vigência até" }}
        rowActions={(r) => (
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Editar" onClick={() => abrirEdicao(r.id)} data-testid={`editar-fornecedor-${r.id}`}>
            <Pencil className="w-4 h-4" />
          </Button>
        )}
        onRowDoubleClick={(r) => abrirEdicao(r.id)}
      />

      <Dialog open={open} onOpenChange={(v) => { if (!saving) setOpen(v); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? `Editar fornecedor${form.name ? ` — ${form.name}` : ""}` : "Novo Fornecedor"}</DialogTitle>
            <DialogDescription>Apenas o nome é obrigatório. Dados de pagamento e anexos ficam nas abas ao lado.</DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="py-12 flex justify-center text-gray-500"><Loader2 className="w-5 h-5 animate-spin mr-2" />Carregando…</div>
          ) : (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="mb-3">
                <TabsTrigger value="dados">Dados</TabsTrigger>
                <TabsTrigger value="pagamento">Pagamento</TabsTrigger>
                <TabsTrigger value="critico" className={form.isCritical ? "text-red-700 font-semibold" : ""}>
                  Crítico{form.isCritical && (pendencias.length + pendLocais.length) ? ` (${pendencias.length + pendLocais.length})` : ""}
                </TabsTrigger>
                <TabsTrigger value="anexos">Anexos{(anexos.length + pendentes.length) ? ` (${anexos.length + pendentes.length})` : ""}</TabsTrigger>
              </TabsList>

              <TabsContent value="dados" className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2"><Label>Nome *</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input type="checkbox" checked={!!form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Ativo
                  </label>
                </div>
                <div><Label>Razão Social</Label><Input value={form.companyName} onChange={(e) => set("companyName", e.target.value)} /></div>
                <div className="grid grid-cols-3 gap-3">
                  <div><Label>CNPJ</Label><Input value={form.cnpj} onChange={(e) => set("cnpj", e.target.value)} /></div>
                  <div><Label>CPF</Label><Input value={form.cpf} onChange={(e) => set("cpf", e.target.value)} /></div>
                  <div><Label>Insc. Estadual</Label><Input value={form.stateRegistration} onChange={(e) => set("stateRegistration", e.target.value)} /></div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div><Label>E-mail</Label><Input value={form.email} onChange={(e) => set("email", e.target.value)} /></div>
                  <div><Label>Telefone</Label><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} /></div>
                  <div><Label>Contato</Label><Input value={form.contactName} onChange={(e) => set("contactName", e.target.value)} /></div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div className="col-span-2"><Label>Endereço</Label><Input value={form.address} onChange={(e) => set("address", e.target.value)} /></div>
                  <div><Label>Nº</Label><Input value={form.addressNumber} onChange={(e) => set("addressNumber", e.target.value)} /></div>
                  <div><Label>Complemento</Label><Input value={form.addressComplement} onChange={(e) => set("addressComplement", e.target.value)} /></div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div><Label>Bairro</Label><Input value={form.neighborhood} onChange={(e) => set("neighborhood", e.target.value)} /></div>
                  <div><Label>Cidade</Label><Input value={form.city} onChange={(e) => set("city", e.target.value)} /></div>
                  <div><Label>UF</Label><Input value={form.state} maxLength={2} onChange={(e) => set("state", e.target.value.toUpperCase())} /></div>
                  <div><Label>CEP</Label><Input value={form.zipCode} onChange={(e) => set("zipCode", e.target.value)} /></div>
                </div>
                <div><Label>Categoria</Label><Input value={form.defaultCategory} onChange={(e) => set("defaultCategory", e.target.value)} /></div>
                <div><Label>Obs.</Label><Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} /></div>
              </TabsContent>

              <TabsContent value="pagamento" className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Forma de pagamento</Label>
                    <select className={selectCls} value={form.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)} data-testid="forma-pagamento">
                      <option value="">— selecione —</option>
                      {FORMAS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
                    </select>
                  </div>
                  <div><Label>Prazo / condição</Label><Input placeholder="ex.: 28 dias, à vista, 30/60/90" value={form.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} /></div>
                </div>

                {form.paymentMethod === "boleto" && (
                  <p className="text-xs text-gray-500 -mt-1">Boleto: o fornecedor emite e envia a cobrança. Os dados bancários abaixo são opcionais (úteis se um dia pagar por TED/PIX).</p>
                )}

                <fieldset className={`border rounded-md p-3 space-y-3 ${mostraPix ? "" : "opacity-70"}`}>
                  <legend className="text-sm font-medium px-1">PIX</legend>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Tipo de chave</Label>
                      <select className={selectCls} value={form.pixKeyType} onChange={(e) => set("pixKeyType", e.target.value)}>
                        <option value="">—</option>
                        {TIPOS_PIX.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2"><Label>Chave PIX</Label><Input value={form.pixKey} onChange={(e) => set("pixKey", e.target.value)} /></div>
                  </div>
                </fieldset>

                <fieldset className={`border rounded-md p-3 space-y-3 ${mostraBanco ? "" : "opacity-70"}`}>
                  <legend className="text-sm font-medium px-1">Dados bancários</legend>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Cód. banco</Label>
                      <Input list="lista-bancos" value={form.bankCode} onChange={(e) => escolherBanco(e.target.value)} placeholder="ex.: 001" />
                      <datalist id="lista-bancos">{BANCOS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</datalist>
                    </div>
                    <div className="col-span-2"><Label>Banco</Label><Input value={form.bankName} onChange={(e) => set("bankName", e.target.value)} /></div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><Label>Agência</Label><Input value={form.bankAgency} onChange={(e) => set("bankAgency", e.target.value)} placeholder="0000-0" /></div>
                    <div><Label>Conta (com dígito)</Label><Input value={form.bankAccount} onChange={(e) => set("bankAccount", e.target.value)} placeholder="00000-0" /></div>
                    <div>
                      <Label>Tipo de conta</Label>
                      <select className={selectCls} value={form.bankAccountType} onChange={(e) => set("bankAccountType", e.target.value)}>
                        <option value="">—</option>
                        {TIPOS_CONTA.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2"><Label>Titular da conta</Label><Input value={form.accountHolderName} onChange={(e) => set("accountHolderName", e.target.value)} placeholder="se diferente do fornecedor" /></div>
                    <div><Label>CPF/CNPJ do titular</Label><Input value={form.accountHolderDocument} onChange={(e) => set("accountHolderDocument", e.target.value)} /></div>
                  </div>
                </fieldset>

                <div><Label>Observações de pagamento</Label><Textarea value={form.paymentNotes} onChange={(e) => set("paymentNotes", e.target.value)} placeholder="ex.: enviar comprovante para o WhatsApp do contato" /></div>
                <Button type="button" variant="outline" size="sm" onClick={copiarDadosPagamento}><Copy className="w-4 h-4 mr-2" />Copiar dados de pagamento</Button>
              </TabsContent>

              <TabsContent value="critico" className="space-y-4">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={!!form.isCritical} onChange={(e) => set("isCritical", e.target.checked)} data-testid="fornecedor-critico" />
                  <ShieldAlert className="w-4 h-4 text-red-600" /> Fornecedor crítico
                </label>
                <p className="text-xs text-gray-500 -mt-2">Fornecedor crítico é o que impacta diretamente a qualidade/segurança do produto (insumos, embalagens, serviços de análise…). Exige aprovação, vigência e documentos em dia.</p>

                <fieldset className={`border rounded-md p-3 space-y-3 ${form.isCritical ? "" : "opacity-60"}`}>
                  <legend className="text-sm font-medium px-1">Aprovação</legend>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Aprovado por</Label>
                      <select className={selectCls} value={form.criticalApprovedBy} onChange={(e) => { set("criticalApprovedBy", e.target.value); if (e.target.value && !form.criticalApprovedAt) set("criticalApprovedAt", new Date().toISOString().slice(0, 10)); }} data-testid="aprovado-por">
                        <option value="">— não aprovado —</option>
                        {APROVADORES.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}
                      </select>
                    </div>
                    <div><Label>Data da aprovação</Label><Input type="date" value={form.criticalApprovedAt} onChange={(e) => set("criticalApprovedAt", e.target.value)} /></div>
                    <div><Label>Vigência até</Label><Input type="date" value={form.criticalValidUntil} onChange={(e) => set("criticalValidUntil", e.target.value)} data-testid="vigencia-ate" /></div>
                  </div>
                  {form.criticalValidUntil && (() => {
                    const dias = Math.round((new Date(`${form.criticalValidUntil}T00:00:00`).getTime() - new Date(new Date().toISOString().slice(0, 10) + "T00:00:00").getTime()) / 86400000);
                    return <p className={`text-xs ${dias < 0 ? "text-red-600" : dias <= 30 ? "text-orange-600" : "text-gray-500"}`}>{dias < 0 ? `Aprovação vencida há ${-dias} dia(s).` : dias === 0 ? "Aprovação vence hoje." : `Aprovação válida por mais ${dias} dia(s).`}</p>;
                  })()}
                  <div><Label>Observações da aprovação</Label><Textarea value={form.criticalNotes} onChange={(e) => set("criticalNotes", e.target.value)} placeholder="ex.: aprovado após visita técnica em 10/10; renovar laudo anual" /></div>
                </fieldset>

                <fieldset className="border rounded-md p-3 space-y-3">
                  <legend className="text-sm font-medium px-1">Pendências do cadastro (licença, laudo, alvará…)</legend>
                  <div className="grid grid-cols-6 gap-2 items-end">
                    <div className="col-span-2">
                      <Label>Tipo *</Label>
                      <Input list="tipos-pendencia" value={novaPend.tipo} onChange={(e) => setNovaPend((p) => ({ ...p, tipo: e.target.value }))} placeholder="ex.: Licença sanitária" data-testid="pendencia-tipo" />
                      <datalist id="tipos-pendencia">{TIPOS_PENDENCIA.map((t) => <option key={t} value={t} />)}</datalist>
                    </div>
                    <div className="col-span-2"><Label>Descrição</Label><Input value={novaPend.descricao} onChange={(e) => setNovaPend((p) => ({ ...p, descricao: e.target.value }))} placeholder="nº do documento, órgão…" /></div>
                    <div><Label>Vigência até</Label><Input type="date" value={novaPend.validUntil} onChange={(e) => setNovaPend((p) => ({ ...p, validUntil: e.target.value }))} /></div>
                    <div className="flex gap-1">
                      <input ref={pendFileRef} type="file" className="hidden" onChange={(e) => setNovaPend((p) => ({ ...p, file: e.target.files?.[0] || null }))} />
                      <Button type="button" variant="outline" size="sm" className="h-10 px-2" title={novaPend.file ? novaPend.file.name : "Anexar documento"} onClick={() => pendFileRef.current?.click()}>
                        <Paperclip className={`w-4 h-4 ${novaPend.file ? "text-green-600" : ""}`} />
                      </Button>
                      <Button type="button" size="sm" className="h-10" onClick={adicionarPendencia} disabled={salvandoPend} data-testid="pendencia-adicionar">
                        {salvandoPend ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      </Button>
                    </div>
                  </div>
                  {novaPend.file && <p className="text-xs text-gray-500 -mt-1">Arquivo: {novaPend.file.name} ({fmtBytes(novaPend.file.size)})</p>}

                  {pendLocais.length > 0 && (
                    <ul className="border rounded-md divide-y">
                      {pendLocais.map((p, i) => (
                        <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                          <FileText className="w-4 h-4 text-gray-400" />
                          <span className="flex-1 truncate">{p.tipo}{p.descricao ? ` — ${p.descricao}` : ""}{p.validUntil ? ` · até ${fmtData(p.validUntil)}` : ""}{p.file ? ` · ${p.file.name}` : " · sem anexo"}</span>
                          <span className="text-xs text-amber-600">a gravar</span>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setPendLocais((l) => l.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {pendencias.length > 0 ? (
                    <ul className="border rounded-md divide-y">
                      {pendencias.map((p) => {
                        const st = SITUACAO_PEND[p.situacao] || SITUACAO_PEND.ok;
                        return (
                          <li key={p.id} className="px-3 py-2 text-sm space-y-1">
                            <div className="flex items-center gap-2">
                              <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                              <span className="font-medium flex-1 truncate">{p.tipo}{p.descricao ? <span className="font-normal text-gray-600"> — {p.descricao}</span> : null}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${st.cls}`}>{st.l}</span>
                              {confirmDelPend === p.id ? (
                                <span className="flex items-center gap-1">
                                  <Button size="sm" variant="destructive" className="h-7 px-2" onClick={() => excluirPendencia(p.id)}>Excluir</Button>
                                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setConfirmDelPend(null)}>Não</Button>
                                </span>
                              ) : (
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Excluir pendência" onClick={() => setConfirmDelPend(p.id)}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                              )}
                            </div>
                            <div className="flex items-center gap-3 pl-6 flex-wrap">
                              <label className="flex items-center gap-1 text-xs text-gray-600">Vigência até
                                <Input type="date" className="h-7 w-[150px] text-xs" value={p.valid_until ? String(p.valid_until).slice(0, 10) : ""} onChange={(e) => atualizarPendencia(p.id, { validUntil: e.target.value })} />
                              </label>
                              {p.attachment_id ? (
                                <span className="flex items-center gap-2 text-xs">
                                  <a href={`/api/suppliers/anexos/${p.attachment_id}`} target="_blank" rel="noreferrer" className="hover:underline flex items-center gap-1"><Paperclip className="w-3 h-3" />{p.anexo_nome || "anexo"}</a>
                                  <a href={`/api/suppliers/anexos/${p.attachment_id}?download=1`} title="Baixar"><Download className="w-3 h-3 text-gray-500" /></a>
                                  <button type="button" className="text-gray-500 hover:underline" onClick={() => { setPendTrocaId(p.id); pendTrocaRef.current?.click(); }}>trocar</button>
                                </span>
                              ) : (
                                <button type="button" className="text-xs text-blue-700 hover:underline flex items-center gap-1" onClick={() => { setPendTrocaId(p.id); pendTrocaRef.current?.click(); }}><Paperclip className="w-3 h-3" />anexar documento</button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (pendLocais.length === 0 && <p className="text-xs text-gray-400 py-2 text-center">Nenhuma pendência registrada.</p>)}
                  <input ref={pendTrocaRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && pendTrocaId) { if (f.size > 15 * 1024 * 1024) setError("Arquivo acima de 15MB."); else atualizarPendencia(pendTrocaId, { file: f }); } setPendTrocaId(null); e.target.value = ""; }} />
                  <p className="text-xs text-gray-500">Sem anexo = pendência em aberto. Com anexo, a situação segue a vigência do documento. Anexos das pendências também aparecem na aba Anexos.</p>
                </fieldset>
              </TabsContent>

              <TabsContent value="anexos" className="space-y-3">
                <div className="flex gap-2 items-end flex-wrap">
                  <div className="flex-1 min-w-[200px]"><Label>Descrição (opcional)</Label><Input value={descAnexo} onChange={(e) => setDescAnexo(e.target.value)} placeholder="ex.: contrato, cartão CNPJ, comprovante bancário" /></div>
                  <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => escolherArquivos(e.target.files)} />
                  <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="anexar-arquivo">
                    {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Paperclip className="w-4 h-4 mr-2" />}Anexar arquivos
                  </Button>
                </div>
                <p className="text-xs text-gray-500">PDF, imagens, planilhas etc. — até 15MB por arquivo.{!editId && " Os arquivos sobem quando o fornecedor for cadastrado."}</p>

                {pendentes.length > 0 && (
                  <ul className="border rounded-md divide-y">
                    {pendentes.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <Paperclip className="w-4 h-4 text-gray-400" />
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className="text-xs text-amber-600">a enviar</span>
                        <span className="text-xs text-gray-500">{fmtBytes(f.size)}</span>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setPendentes((p) => p.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></Button>
                      </li>
                    ))}
                  </ul>
                )}

                {anexos.length > 0 ? (
                  <ul className="border rounded-md divide-y">
                    {anexos.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <Paperclip className="w-4 h-4 text-gray-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <a href={`/api/suppliers/anexos/${a.id}`} target="_blank" rel="noreferrer" className="font-medium hover:underline truncate block">{a.file_name}</a>
                          <span className="text-xs text-gray-500">
                            {a.descricao ? `${a.descricao} · ` : ""}{fmtBytes(Number(a.file_size || 0))} · {new Date(a.created_at).toLocaleDateString("pt-BR")}
                          </span>
                        </div>
                        <a href={`/api/suppliers/anexos/${a.id}`} target="_blank" rel="noreferrer" title="Abrir"><ExternalLink className="w-4 h-4 text-gray-500" /></a>
                        <a href={`/api/suppliers/anexos/${a.id}?download=1`} title="Baixar"><Download className="w-4 h-4 text-gray-500" /></a>
                        {confirmDel === a.id ? (
                          <span className="flex items-center gap-1">
                            <Button size="sm" variant="destructive" className="h-7 px-2" onClick={() => excluirAnexo(a.id)}>Excluir</Button>
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setConfirmDel(null)}>Não</Button>
                          </span>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Excluir" onClick={() => setConfirmDel(a.id)}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (pendentes.length === 0 && <p className="text-sm text-gray-400 py-4 text-center">Nenhum anexo.</p>)}
              </TabsContent>
            </Tabs>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
          {info && <p className="text-sm text-green-700">{info}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={salvar} disabled={saving || loading}>{saving ? "Salvando…" : editId ? "Salvar alterações" : "Cadastrar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
