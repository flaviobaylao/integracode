import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function TabelaPrecos() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Tabela de Preços</h1>
      <SyncedTable
        table="price_tables"
        hideColumns={["id", "omie_instance_id"]}
        labels={{ name: "Nome", description: "Descrição", is_default: "Padrão", is_active: "Ativa", scope: "Escopo", created_at: "Criado em", updated_at: "Atualizado em" }}
      />
    </div>
  );
}
