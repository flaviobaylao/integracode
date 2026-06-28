import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function Cupons() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Cupons de Desconto</h1>
      <SyncedTable
        table="coupons"
        hideColumns={["id", "created_by_user_id"]}
        labels={{ code: "Código", description: "Descrição", discount_type: "Tipo", discount_value: "Valor", valid_from: "Válido de", valid_until: "Válido até", is_active: "Ativo", max_uses: "Usos máx.", used_count: "Usos", min_order_value: "Pedido mín.", created_at: "Criado em", updated_at: "Atualizado em" }}
      />
    </div>
  );
}
