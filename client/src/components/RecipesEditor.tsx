import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Plus, Pencil, Trash2, X, Loader2 } from "lucide-react";

// Editor de Receitas (Indústria) — CRUD sobre /api/industria/recipes.
// CUTOVER 17/ago/2026: o 2.0 é o dono de recipes/recipe_items (o backfill do 1.0
// não sobrescreve mais estas tabelas). Tela anterior era só leitura (SyncedTable).

type RecipeItem = {
  id?: string;
  raw_material_id: string | null;
  raw_material_name?: string | null;
  quantity: string | number | null;
  unit?: string | null;
};

type Recipe = {
  id: string;
  name: string;
  product_name: string | null;
  product_id: string | null;
  type: string | null;
  estimated_yield: string | number | null;
  yield_unit: string | null;
  description: string | null;
  is_active: boolean | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  items: RecipeItem[];
};

type FormState = {
  id: string | null; // null = nova receita
  name: string;
  product_id: string;
  product_name: string;
  type: string;
  estimated_yield: string;
  yield_unit: string;
  description: string;
  is_active: boolean;
  items: RecipeItem[];
};

const EMPTY_FORM: FormState = {
  id: null, name: "", product_id: "", product_name: "", type: "",
  estimated_yield: "1", yield_unit: "unidade", description: "", is_active: true, items: [],
};

const NONE = "__none__";

export default function RecipesEditor() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["/api/industria/recipes"],
    queryFn: async () => {
      const r = await fetch("/api/industria/recipes", { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar receitas");
      return r.json();
    },
  });

  const { data: rawMat } = useQuery({
    queryKey: ["/api/synced-table", "raw_materials", "editor"],
    queryFn: async () => {
      const r = await fetch("/api/synced-table/raw_materials?limit=2000", { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar matérias-primas");
      return r.json();
    },
  });

  const { data: products } = useQuery({
    queryKey: ["/api/products", "recipes-editor"],
    queryFn: async () => {
      const r = await fetch("/api/products", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const recipes: Recipe[] = data?.recipes || [];
  const materials: any[] = (rawMat?.rows || []).slice().sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  const productList: any[] = (Array.isArray(products) ? products : []).slice().sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

  const filtered = useMemo(() => {
    if (!q.trim()) return recipes;
    const s = q.toLowerCase();
    return recipes.filter((r) =>
      [r.name, r.product_name, r.type].some((v) => String(v ?? "").toLowerCase().includes(s)));
  }, [recipes, q]);

  const openNew = () => setForm({ ...EMPTY_FORM, items: [] });
  const openEdit = (r: Recipe) => setForm({
    id: r.id,
    name: r.name || "",
    product_id: r.product_id || "",
    product_name: r.product_name || "",
    type: r.type || "",
    estimated_yield: r.estimated_yield == null ? "" : String(r.estimated_yield),
    yield_unit: r.yield_unit || "",
    description: r.description || "",
    is_active: r.is_active !== false,
    items: (r.items || []).map((it) => ({ ...it })),
  });

  const setField = (k: keyof FormState, v: any) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const setItem = (idx: number, patch: Partial<RecipeItem>) =>
    setForm((f) => {
      if (!f) return f;
      const items = f.items.slice();
      items[idx] = { ...items[idx], ...patch };
      return { ...f, items };
    });

  const addItem = () => setForm((f) => (f ? { ...f, items: [...f.items, { raw_material_id: null, quantity: "", unit: "" }] } : f));
  const removeItem = (idx: number) => setForm((f) => (f ? { ...f, items: f.items.filter((_, i) => i !== idx) } : f));

  const onPickMaterial = (idx: number, materialId: string) => {
    const mat = materials.find((m) => String(m.id) === materialId);
    setItem(idx, {
      raw_material_id: materialId,
      raw_material_name: mat?.name || null,
      unit: (form?.items[idx]?.unit || mat?.unit || "") as string,
    });
  };

  const onPickProduct = (val: string) => {
    if (val === NONE) { setField("product_id", ""); return; }
    const p = productList.find((x) => String(x.id) === val);
    setForm((f) => (f ? { ...f, product_id: val, product_name: p?.name || f.product_name } : f));
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/industria/recipes"] });
    qc.invalidateQueries({ queryKey: ["/api/synced-table", "recipes"] });
    qc.invalidateQueries({ queryKey: ["/api/synced-table", "recipe_items"] });
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast({ title: "Informe o nome da receita", variant: "destructive" });
      return;
    }
    const badItem = form.items.find((it) => it.raw_material_id && !(Number(String(it.quantity).replace(",", ".")) > 0));
    if (badItem) {
      toast({ title: "Ingrediente com quantidade inválida", description: "Informe uma quantidade maior que zero.", variant: "destructive" });
      return;
    }
    const items = form.items
      .filter((it) => it.raw_material_id)
      .map((it) => ({ raw_material_id: it.raw_material_id, quantity: it.quantity, unit: it.unit }));
    const body = {
      name: form.name,
      product_id: form.product_id || null,
      product_name: form.product_name || null,
      type: form.type || null,
      estimated_yield: form.estimated_yield === "" ? null : form.estimated_yield,
      yield_unit: form.yield_unit || null,
      description: form.description || null,
      is_active: form.is_active,
    };
    setSaving(true);
    try {
      if (form.id == null) {
        const r = await fetch("/api/industria/recipes", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, items }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j?.error || "Falha ao criar a receita");
        toast({ title: "Receita criada", description: form.name });
      } else {
        const r1 = await fetch(`/api/industria/recipes/${form.id}`, {
          method: "PATCH", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j1 = await r1.json();
        if (!r1.ok || !j1.ok) throw new Error(j1?.error || "Falha ao salvar a receita");
        const r2 = await fetch(`/api/industria/recipes/${form.id}/items`, {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });
        const j2 = await r2.json();
        if (!r2.ok || !j2.ok) throw new Error(j2?.error || "Falha ao salvar os ingredientes");
        toast({ title: "Receita salva", description: form.name });
      }
      setForm(null);
      invalidate();
    } catch (e: any) {
      toast({ title: "Erro ao salvar", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: Recipe) => {
    if (!window.confirm(`Excluir a receita "${r.name}"? Os ingredientes serão excluídos junto. Esta ação não pode ser desfeita.`)) return;
    try {
      const resp = await fetch(`/api/industria/recipes/${r.id}`, { method: "DELETE", credentials: "include" });
      const j = await resp.json();
      if (!resp.ok || !j.ok) throw new Error(j?.error || "Falha ao excluir");
      toast({ title: "Receita excluída", description: r.name });
      invalidate();
    } catch (e: any) {
      toast({ title: "Erro ao excluir", description: String(e?.message || e), variant: "destructive" });
    }
  };

  const fmtQty = (v: any) => {
    const n = Number(String(v ?? "").replace(",", "."));
    return isFinite(n) ? n.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) : String(v ?? "-");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Input placeholder="Buscar receita..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
        <span className="text-sm text-gray-500">
          {isLoading ? "Carregando..." : `${filtered.length} de ${data?.total ?? recipes.length} receitas`}
        </span>
        <div className="flex-1" />
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" />
          Nova Receita
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Receita</TableHead>
              <TableHead>Produto</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Rendimento</TableHead>
              <TableHead>Un. Rend.</TableHead>
              <TableHead>Ingredientes</TableHead>
              <TableHead>Ativa</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.id} className="cursor-pointer hover:bg-gray-50" onClick={() => openEdit(r)}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell>{r.product_name || "-"}</TableCell>
                <TableCell>{r.type || "-"}</TableCell>
                <TableCell>{r.estimated_yield == null ? "-" : fmtQty(r.estimated_yield)}</TableCell>
                <TableCell>{r.yield_unit || "-"}</TableCell>
                <TableCell>
                  {(r.items || []).length === 0 ? (
                    <span className="text-gray-400">nenhum</span>
                  ) : (
                    <span title={(r.items || []).map((it) => `${it.raw_material_name || "?"} — ${fmtQty(it.quantity)} ${it.unit || ""}`).join("\n")}>
                      {(r.items || []).length} {(r.items || []).length === 1 ? "item" : "itens"}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {r.is_active !== false
                    ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Sim</Badge>
                    : <Badge variant="secondary">Não</Badge>}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(r)} title="Editar">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(r)} title="Excluir" className="text-red-500 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-gray-400 py-8">Nenhuma receita</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={form != null} onOpenChange={(o) => { if (!o) setForm(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form?.id == null ? "Nova Receita" : "Editar Receita"}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Nome da receita *</Label>
                <Input value={form.name} onChange={(e) => setField("name", e.target.value)} placeholder="Ex.: POLPA INTEGRAL DE MORANGO" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Produto vinculado</Label>
                  <Select value={form.product_id || NONE} onValueChange={onPickProduct}>
                    <SelectTrigger><SelectValue placeholder="— sem vínculo —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— sem vínculo —</SelectItem>
                      {form.product_id && !productList.some((p) => String(p.id) === form.product_id) && (
                        <SelectItem value={form.product_id}>{form.product_name || form.product_id}</SelectItem>
                      )}
                      {productList.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Nome do produto (texto)</Label>
                  <Input value={form.product_name} onChange={(e) => setField("product_name", e.target.value)} placeholder="Como aparece na listagem" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>Tipo</Label>
                  <Input list="recipe-type-options" value={form.type} onChange={(e) => setField("type", e.target.value)} placeholder="polpa / suco" />
                  <datalist id="recipe-type-options">
                    <option value="polpa" />
                    <option value="suco" />
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <Label>Rendimento</Label>
                  <Input inputMode="decimal" value={form.estimated_yield} onChange={(e) => setField("estimated_yield", e.target.value)} placeholder="1" />
                </div>
                <div className="space-y-1.5">
                  <Label>Un. do rendimento</Label>
                  <Input list="recipe-yield-unit-options" value={form.yield_unit} onChange={(e) => setField("yield_unit", e.target.value)} placeholder="kg / unidade" />
                  <datalist id="recipe-yield-unit-options">
                    <option value="kg" />
                    <option value="unidade" />
                    <option value="l" />
                  </datalist>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Descrição</Label>
                <Textarea rows={2} value={form.description} onChange={(e) => setField("description", e.target.value)} />
              </div>

              <div className="flex items-center gap-2">
                <Switch checked={form.is_active} onCheckedChange={(v) => setField("is_active", v)} id="recipe-active" />
                <Label htmlFor="recipe-active">Receita ativa</Label>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold">Ingredientes (matéria-prima)</Label>
                  <Button type="button" variant="outline" size="sm" onClick={addItem}>
                    <Plus className="h-4 w-4 mr-1" />
                    Adicionar
                  </Button>
                </div>
                {form.items.length === 0 && (
                  <p className="text-sm text-gray-400">Nenhum ingrediente. Clique em "Adicionar".</p>
                )}
                {form.items.map((it, idx) => (
                  <div key={it.id || `new-${idx}`} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <Select value={it.raw_material_id || ""} onValueChange={(v) => onPickMaterial(idx, v)}>
                        <SelectTrigger><SelectValue placeholder="Matéria-prima..." /></SelectTrigger>
                        <SelectContent>
                          {it.raw_material_id && !materials.some((m) => String(m.id) === String(it.raw_material_id)) && (
                            <SelectItem value={String(it.raw_material_id)}>{it.raw_material_name || it.raw_material_id}</SelectItem>
                          )}
                          {materials.map((m) => (
                            <SelectItem key={m.id} value={String(m.id)}>
                              {m.name}{m.unit ? ` (${m.unit})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      className="w-28"
                      inputMode="decimal"
                      placeholder="Qtd"
                      value={it.quantity == null ? "" : String(it.quantity)}
                      onChange={(e) => setItem(idx, { quantity: e.target.value })}
                    />
                    <Input
                      className="w-24"
                      placeholder="Un."
                      value={it.unit || ""}
                      onChange={(e) => setItem(idx, { unit: e.target.value })}
                    />
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeItem(idx)} className="text-red-500 hover:text-red-600" title="Remover">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={saving}>Cancelar</Button>
            <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {form?.id == null ? "Criar receita" : "Salvar alterações"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
