import { useState, useEffect } from "react";
import { Link } from "wouter";

interface Coupon { id: string; customer_id: string; customer_name?: string; code: string; discount_new_pct: number; discount_referrer_pct: number; max_referrals: number; used_count: number; active: boolean; }
interface Redemption { id: string; code: string; referrer_customer_id?: string; referred_customer_id?: string; referred_document?: string; channel: string; order_ref?: string; order_value?: string; discount_new_amount?: string; reward_referrer_status?: string; status: string; created_at?: string; }

export default function ProgramaIndicacao() {
  const [resumo, setResumo] = useState<any>({});
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [custId, setCustId] = useState("");
  const [genResult, setGenResult] = useState<string>("");
  const [msg, setMsg] = useState<string>("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/referral/list", { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (j && j.ok) { setResumo(j.resumo || {}); setCoupons(j.coupons || []); setRedemptions(j.redemptions || []); }
    } catch (e: any) { setMsg("Erro ao carregar: " + (e.message || e)); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const gerarCodigo = async () => {
    if (!custId.trim()) { setMsg("Informe o ID do cliente"); return; }
    try {
      const r = await fetch("/api/referral/code", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ customerId: custId.trim() }) });
      const j = await r.json();
      if (j && j.ok) { setGenResult("Codigo: " + j.code + "  (novo " + j.discountNewPct + "% / indicador " + j.discountReferrerPct + "% / teto " + j.maxReferrals + ")"); load(); }
      else setGenResult("Falha: " + (j.error || "erro"));
    } catch (e: any) { setGenResult("Erro: " + (e.message || e)); }
  };

  const confirmar = async (id: string) => {
    if (!window.confirm("Confirmar esta indicacao? Incrementa o uso do cupom e libera a recompensa do indicador.")) return;
    try {
      const r = await fetch("/api/admin/referral/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ redemptionId: id }) });
      const j = await r.json();
      if (j && j.ok) { setMsg("Indicacao confirmada"); load(); } else setMsg("Falha: " + (j.error || "erro"));
    } catch (e: any) { setMsg("Erro: " + (e.message || e)); }
  };

  const brl = (val: any) => "R$ " + (Number(val) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="p-6 space-y-6 max-w-full">
      <div className="flex items-center gap-3">
        <Link href="/"><a className="text-green-700 hover:underline">← Voltar</a></Link>
        <h1 className="text-2xl font-bold">Programa de Indicacao (Cupom)</h1>
      </div>
      <p className="text-sm text-gray-500">Novo cliente 15% no 1o pedido · indicador 10% no proximo pedido · teto 5 indicacoes · canais: hotsite + vendedor. (Fundacao: codigos e rastreamento ja funcionam; a aplicacao do desconto no checkout e ativada em seguida.)</p>
      {msg && <div className="p-2 bg-amber-50 border border-amber-300 rounded text-sm text-amber-800">{msg}</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Cupons</div><div className="text-2xl font-bold">{resumo.coupons || 0}</div></div>
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Indicacoes</div><div className="text-2xl font-bold">{resumo.redemptions || 0}</div></div>
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Confirmadas</div><div className="text-2xl font-bold text-green-600">{resumo.confirmadas || 0}</div></div>
        <div className="p-4 bg-white border rounded"><div className="text-xs text-gray-500">Pendentes</div><div className="text-2xl font-bold text-amber-600">{resumo.pendentes || 0}</div></div>
      </div>
      <div className="p-4 bg-white border rounded space-y-2">
        <h2 className="font-semibold">Gerar/obter codigo de um cliente</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input value={custId} onChange={(e) => setCustId(e.target.value)} placeholder="ID do cliente (customers.id)" className="border rounded px-3 py-2 text-sm w-80" />
          <button onClick={gerarCodigo} className="px-4 py-2 bg-green-700 text-white rounded text-sm font-semibold">Gerar/obter</button>
          {genResult && <span className="text-sm font-mono">{genResult}</span>}
        </div>
      </div>
      <div className="p-4 bg-white border rounded">
        <div className="flex items-center justify-between mb-2"><h2 className="font-semibold">Cupons ({coupons.length})</h2><button onClick={load} className="text-sm text-blue-600">Atualizar</button></div>
        {loading ? <p className="text-sm text-gray-400">Carregando...</p> : (
        <div className="overflow-auto max-h-96">
          <table className="w-full text-sm">
            <thead><tr className="text-left border-b"><th className="p-2">Cliente</th><th className="p-2">Codigo</th><th className="p-2">Usos</th><th className="p-2">Ativo</th></tr></thead>
            <tbody>{coupons.map((c) => (<tr key={c.id} className="border-b"><td className="p-2">{c.customer_name || c.customer_id}</td><td className="p-2 font-mono">{c.code}</td><td className="p-2">{c.used_count}/{c.max_referrals}</td><td className="p-2">{c.active ? "sim" : "nao"}</td></tr>))}</tbody>
          </table>
        </div>)}
      </div>
      <div className="p-4 bg-white border rounded">
        <h2 className="font-semibold mb-2">Indicacoes ({redemptions.length})</h2>
        <div className="overflow-auto max-h-96">
          <table className="w-full text-sm">
            <thead><tr className="text-left border-b"><th className="p-2">Data</th><th className="p-2">Codigo</th><th className="p-2">Indicado</th><th className="p-2">Canal</th><th className="p-2">Pedido</th><th className="p-2">Desc. novo</th><th className="p-2">Status</th><th className="p-2">Acao</th></tr></thead>
            <tbody>{redemptions.map((r) => (<tr key={r.id} className="border-b">
              <td className="p-2">{r.created_at ? new Date(r.created_at).toLocaleDateString("pt-BR") : ""}</td>
              <td className="p-2 font-mono">{r.code}</td>
              <td className="p-2">{r.referred_customer_id || r.referred_document || "-"}</td>
              <td className="p-2">{r.channel}</td>
              <td className="p-2">{brl(r.order_value)}</td>
              <td className="p-2">{brl(r.discount_new_amount)}</td>
              <td className="p-2">{r.status}</td>
              <td className="p-2">{r.status === "pending" ? <button onClick={() => confirmar(r.id)} className="text-xs px-2 py-1 bg-green-600 text-white rounded">Confirmar</button> : "-"}</td>
            </tr>))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
