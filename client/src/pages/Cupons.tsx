import { useEffect, useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface Coupon {
  id: string; code: string; description?: string | null;
  discount_type: string; discount_value: string | number;
  valid_from?: string | null; valid_until?: string | null;
  is_active: boolean; max_uses?: number | null; used_count: number;
  min_order_value?: string | number | null;
  once_per_customer?: boolean; channels?: string; enabled_2_0?: boolean;
  created_by_user_id?: string | null; created_at?: string;
}
interface Redemption {
  id: string; coupon_code: string; customer_id?: string | null; customer_name?: string | null;
  sales_card_id?: string | null; order_total_before?: string | number | null;
  discount_applied?: string | number | null; order_total_after?: string | number | null;
  redeemed_at?: string;
}

const EMPTY = { code: "", description: "", discountType: "percent", discountValue: "", validFrom: "", validUntil: "", maxUses: "", minOrderValue: "", oncePerCustomer: true, channels: "todos", isActive: true };

export default function Cupons() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [resumo, setResumo] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState<any>({ ...EMPTY });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const brl = (v: any) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dayBRT = (ts: any) => {
    if (!ts) return "";
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
    } catch { return ""; }
  };
  const dayBR = (ts: any) => { const d = dayBRT(ts); return d ? d.split("-").reverse().join("/") : "—"; };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/coupons", { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (j && j.ok) { setCoupons(j.coupons || []); setRedemptions(j.redemptions || []); setResumo(j.resumo || {}); setMsg(""); }
      else setMsg("Falha ao carregar: " + (j?.error || "erro"));
    } catch (e: any) { setMsg("Erro ao carregar: " + (e.message || e)); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const novo = () => { setForm({ ...EMPTY }); setShowForm(true); setMsg(""); };
  const editar = (c: Coupon) => {
    setForm({
      code: c.code, description: c.description || "",
      discountType: /perc|%/i.test(String(c.discount_type)) ? "percent" : "fixed",
      discountValue: String(c.discount_value ?? ""),
      validFrom: dayBRT(c.valid_from), validUntil: dayBRT(c.valid_until),
      maxUses: c.max_uses == null ? "" : String(c.max_uses),
      minOrderValue: c.min_order_value == null ? "" : String(c.min_order_value),
      oncePerCustomer: c.once_per_customer !== false,
      channels: c.channels || "todos",
      isActive: c.is_active !== false,
    });
    setShowForm(true); setMsg("");
  };

  const salvar = async () => {
    if (!form.code || String(form.code).trim().length < 3) { setMsg("Informe um código com pelo menos 3 caracteres (letras e números)."); return; }
    if (!(Number(String(form.discountValue).replace(",", ".")) > 0)) { setMsg("Informe o valor do desconto."); return; }
    const pct = form.discountType === "percent";
    const resumoRegra = pct ? form.discountValue + "%" : brl(String(form.discountValue).replace(",", "."));
    if (!window.confirm("Confirmar o cupom " + String(form.code).toUpperCase() + " com desconto de " + resumoRegra + "?\n\nEle passa a valer nos pedidos assim que estiver ativo e dentro da vigência.")) return;
    setSaving(true);
    try {
      await fetch("/api/admin/coupons/setup", { method: "POST", credentials: "include" });
      const r = await fetch("/api/admin/coupons", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (j && j.ok) { setMsg("Cupom " + j.coupon.code + " salvo."); setShowForm(false); setForm({ ...EMPTY }); load(); }
      else setMsg("Falha: " + (j?.error || "erro"));
    } catch (e: any) { setMsg("Erro: " + (e.message || e)); }
    setSaving(false);
  };

  const alternarAtivo = async (c: Coupon) => {
    const ativar = c.is_active === false;
    if (!window.confirm((ativar ? "Ativar" : "Desativar") + " o cupom " + c.code + "?")) return;
    try {
      const r = await fetch("/api/admin/coupons/active", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ code: c.code, active: ativar }) });
      const j = await r.json();
      if (j && j.ok) { setMsg("Cupom " + c.code + (ativar ? " ativado." : " desativado.")); load(); }
      else setMsg("Falha: " + (j?.error || "erro"));
    } catch (e: any) { setMsg("Erro: " + (e.message || e)); }
  };

  const estornar = async (r: Redemption) => {
    if (!window.confirm("Estornar o uso do cupom " + r.coupon_code + "?\n\nO uso deixa de contar no limite do cupom e sai desta lista. O valor do pedido NÃO é alterado — ajuste o pedido se necessário.")) return;
    try {
      const resp = await fetch("/api/admin/coupons/estornar", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ redemptionId: r.id }) });
      const j = await resp.json();
      if (j && j.ok) { setMsg("Uso estornado."); load(); } else setMsg("Falha: " + (j?.error || "erro"));
    } catch (e: any) { setMsg("Erro: " + (e.message || e)); }
  };

  const situacao = (c: Coupon) => {
    if (c.enabled_2_0 !== true) return { txt: "Não habilitado", cls: "bg-gray-100 text-gray-600" };
    if (c.is_active === false) return { txt: "Inativo", cls: "bg-gray-100 text-gray-600" };
    const now = Date.now();
    if (c.valid_from && new Date(c.valid_from).getTime() > now) return { txt: "Agendado", cls: "bg-blue-100 text-blue-700" };
    if (c.valid_until && new Date(c.valid_until).getTime() < now) return { txt: "Expirado", cls: "bg-amber-100 text-amber-700" };
    if (c.max_uses != null && Number(c.used_count) >= Number(c.max_uses)) return { txt: "Esgotado", cls: "bg-amber-100 text-amber-700" };
    return { txt: "Válido", cls: "bg-green-100 text-green-700" };
  };

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Cupons de Desconto</h1>
          <p className="text-sm text-gray-500">O desconto é aplicado pelo servidor no fechamento do pedido do vendedor (o hotsite ainda não usa cupom). Um desconto por pedido — o cupom promocional tem prioridade sobre o programa de indicação.</p>
        </div>
        <button onClick={novo} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-novo-cupom">+ Novo cupom</button>
      </div>

      {msg && <div className="p-2 bg-amber-50 border border-amber-300 rounded text-sm text-amber-800">{msg}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Cupons</div><div className="text-2xl font-bold">{resumo.coupons || 0}</div></div>
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Ativos</div><div className="text-2xl font-bold text-green-600">{resumo.ativos || 0}</div></div>
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Usos</div><div className="text-2xl font-bold">{resumo.usos || 0}</div></div>
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Desconto concedido</div><div className="text-2xl font-bold text-red-600">{brl(resumo.descontoConcedido)}</div></div>
      </div>

      {showForm && (
        <div className="p-4 bg-white border-2 border-blue-300 rounded space-y-3" data-testid="form-cupom">
          <h2 className="font-semibold">Cadastro de cupom</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Código</label>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Za-z0-9]/g, "") })} placeholder="HONEST8" className="w-full border rounded px-2 py-1" data-testid="input-cupom-code" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Tipo de desconto</label>
              <select value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value })} className="w-full border rounded px-2 py-1">
                <option value="percent">Percentual (%)</option>
                <option value="fixed">Valor fixo (R$)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{form.discountType === "percent" ? "Percentual (%)" : "Valor (R$)"}</label>
              <input value={form.discountValue} onChange={(e) => setForm({ ...form, discountValue: e.target.value })} placeholder={form.discountType === "percent" ? "8" : "20,00"} className="w-full border rounded px-2 py-1" data-testid="input-cupom-valor" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Válido de</label>
              <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Válido até</label>
              <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Pedido mínimo (R$)</label>
              <input value={form.minOrderValue} onChange={(e) => setForm({ ...form, minOrderValue: e.target.value })} placeholder="opcional" className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Máximo de usos</label>
              <input value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} placeholder="vazio = ilimitado" className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Canal</label>
              <select value={form.channels} onChange={(e) => setForm({ ...form, channels: e.target.value })} className="w-full border rounded px-2 py-1">
                <option value="todos">Todos</option>
                <option value="vendedor">Só vendedor</option>
              </select>
            </div>
            <div className="md:col-span-3">
              <label className="block text-xs text-gray-500 mb-1">Descrição (opcional)</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border rounded px-2 py-1" />
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!form.oncePerCustomer} onChange={(e) => setForm({ ...form, oncePerCustomer: e.target.checked })} /> Apenas 1 uso por cliente</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Ativo</label>
          </div>
          <div className="flex gap-2">
            <button onClick={salvar} disabled={saving} className="px-4 py-2 rounded bg-green-600 hover:bg-green-700 text-white disabled:opacity-50" data-testid="button-salvar-cupom">{saving ? "Salvando..." : "Salvar cupom"}</button>
            <button onClick={() => { setShowForm(false); setForm({ ...EMPTY }); }} className="px-4 py-2 rounded border">Cancelar</button>
          </div>
          <p className="text-xs text-gray-500">A vigência conta o dia inteiro no horário de Brasília. Salvar um código já existente atualiza a regra dele (o histórico de usos é preservado). Cupons antigos, herdados do sistema 1.0, só passam a valer depois de abertos e salvos aqui.</p>
        </div>
      )}

      <div className="bg-white border rounded overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="[&>th]:text-left [&>th]:p-2 [&>th]:font-semibold">
              <th>Código</th><th>Desconto</th><th>Vigência</th><th>Pedido mín.</th><th>Usos</th><th>Canal</th><th>Situação</th><th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="p-4 text-center text-gray-500">Carregando...</td></tr>}
            {!loading && coupons.length === 0 && <tr><td colSpan={8} className="p-4 text-center text-gray-500">Nenhum cupom cadastrado.</td></tr>}
            {coupons.map((c) => {
              const s = situacao(c);
              const pct = /perc|%/i.test(String(c.discount_type));
              return (
                <tr key={c.id} className="border-t [&>td]:p-2" data-testid={"row-cupom-" + c.code}>
                  <td className="font-mono font-semibold">{c.code}{c.description ? <div className="text-xs text-gray-500 font-sans font-normal">{c.description}</div> : null}</td>
                  <td>{pct ? (Number(c.discount_value) || 0) + "%" : brl(c.discount_value)}</td>
                  <td>{dayBR(c.valid_from)} → {dayBR(c.valid_until)}</td>
                  <td>{c.min_order_value == null ? "—" : brl(c.min_order_value)}</td>
                  <td>{c.used_count}{c.max_uses != null ? " / " + c.max_uses : ""}</td>
                  <td>{c.channels === "vendedor" ? "Vendedor" : c.channels === "hotsite" ? "Hotsite" : "Todos"}</td>
                  <td><span className={"px-2 py-0.5 rounded text-xs " + s.cls}>{s.txt}</span></td>
                  <td className="whitespace-nowrap">
                    <button onClick={() => editar(c)} className="px-2 py-1 text-xs border rounded mr-1">Editar</button>
                    {c.enabled_2_0 !== true
                      ? <button onClick={() => editar(c)} className="px-2 py-1 text-xs rounded text-white bg-blue-600" title="Cupom herdado do 1.0: revise a regra e salve para ele passar a valer">Revisar e habilitar</button>
                      : <button onClick={() => alternarAtivo(c)} className={"px-2 py-1 text-xs rounded text-white " + (c.is_active === false ? "bg-green-600" : "bg-gray-500")}>{c.is_active === false ? "Ativar" : "Desativar"}</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="font-semibold mb-2">Usos registrados</h2>
        <div className="bg-white border rounded overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="[&>th]:text-left [&>th]:p-2 [&>th]:font-semibold">
                <th>Data</th><th>Cupom</th><th>Cliente</th><th>Valor original</th><th>Desconto</th><th>Valor final</th><th></th>
              </tr>
            </thead>
            <tbody>
              {redemptions.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-gray-500">Nenhum uso registrado.</td></tr>}
              {redemptions.map((r) => (
                <tr key={r.id} className="border-t [&>td]:p-2">
                  <td>{r.redeemed_at ? new Date(r.redeemed_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}</td>
                  <td className="font-mono">{r.coupon_code}</td>
                  <td>{r.customer_name || r.customer_id || "—"}</td>
                  <td>{brl(r.order_total_before)}</td>
                  <td className="text-red-600">- {brl(r.discount_applied)}</td>
                  <td className="font-semibold">{brl(r.order_total_after)}</td>
                  <td><button onClick={() => estornar(r)} className="px-2 py-1 text-xs border rounded text-red-700 border-red-300">Estornar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
