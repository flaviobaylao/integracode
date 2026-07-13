import { useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { Plus } from "lucide-react";

const EMPTY = {
  name: "", companyName: "", cnpj: "", cpf: "", stateRegistration: "", email: "", phone: "",
  contactName: "", address: "", addressNumber: "", neighborhood: "", city: "", state: "", zipCode: "",
  defaultCategory: "", notes: "",
};

export default function Fornecedores() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  const abrir = () => { setForm({ ...EMPTY }); setError(""); setOpen(true); };

  const salvar = async () => {
    if (!form.name.trim()) { setError("Informe o nome do fornecedor."); return; }
    setSaving(true); setError("");
    try {
      const r = await fetch("/api/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || "Não foi possível cadastrar o fornecedor."); setSaving(false); return; }
      await queryClient.invalidateQueries({ queryKey: ["/api/synced-table", "suppliers"] });
      setOpen(false);
    } catch (e: any) {
      setError(String(e?.message || e) || "Falha ao cadastrar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <h1 className="text-2xl font-bold">Fornecedores</h1>
        <Button onClick={abrir}><Plus className="w-4 h-4 mr-2" />Novo Fornecedor</Button>
      </div>
      <SyncedTable
        table="suppliers"
        hideColumns={["id", "default_chart_account_id", "omie_instance_id", "address_complement"]}
        labels={{ name: "Nome", company_name: "Razão Social", cnpj: "CNPJ", cpf: "CPF", state_registration: "Insc. Estadual", email: "E-mail", phone: "Telefone", contact_name: "Contato", address: "Endereço", address_number: "Nº", neighborhood: "Bairro", city: "Cidade", state: "UF", zip_code: "CEP", default_category: "Categoria", notes: "Obs.", is_active: "Ativo", created_at: "Criado em", updated_at: "Atualizado em" }}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Novo Fornecedor</DialogTitle>
            <DialogDescription>Preencha os dados do fornecedor. Apenas o nome é obrigatório.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Nome *</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div><Label>Razão Social</Label><Input value={form.companyName} onChange={(e) => set("companyName", e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>CNPJ</Label><Input value={form.cnpj} onChange={(e) => set("cnpj", e.target.value)} /></div>
              <div><Label>CPF</Label><Input value={form.cpf} onChange={(e) => set("cpf", e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Insc. Estadual</Label><Input value={form.stateRegistration} onChange={(e) => set("stateRegistration", e.target.value)} /></div>
              <div><Label>Categoria</Label><Input value={form.defaultCategory} onChange={(e) => set("defaultCategory", e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>E-mail</Label><Input value={form.email} onChange={(e) => set("email", e.target.value)} /></div>
              <div><Label>Telefone</Label><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} /></div>
            </div>
            <div><Label>Contato</Label><Input value={form.contactName} onChange={(e) => set("contactName", e.target.value)} /></div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2"><Label>Endereço</Label><Input value={form.address} onChange={(e) => set("address", e.target.value)} /></div>
              <div><Label>Nº</Label><Input value={form.addressNumber} onChange={(e) => set("addressNumber", e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Bairro</Label><Input value={form.neighborhood} onChange={(e) => set("neighborhood", e.target.value)} /></div>
              <div><Label>Cidade</Label><Input value={form.city} onChange={(e) => set("city", e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>UF</Label><Input value={form.state} maxLength={2} onChange={(e) => set("state", e.target.value.toUpperCase())} /></div>
                <div><Label>CEP</Label><Input value={form.zipCode} onChange={(e) => set("zipCode", e.target.value)} /></div>
              </div>
            </div>
            <div><Label>Obs.</Label><Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} /></div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={salvar} disabled={saving}>{saving ? "Salvando…" : "Cadastrar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
