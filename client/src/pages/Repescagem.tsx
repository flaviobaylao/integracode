import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function Repescagem() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Repescagem</h1>
      <p className="text-muted-foreground text-sm mb-4">
        Atribuições de repescagem sincronizadas do sistema 1.0.
      </p>
      <SyncedTable
        table="repescagem_assignments"
        hideColumns={["id"]}
        labels={{
          customer_id: "Cliente",
          attendant_id: "Atendente",
          status: "Status",
          assigned_at: "Atribuído em",
          created_at: "Criado em",
        }}
      />
    </div>
  );
}
