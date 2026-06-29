import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function Visitas() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Visitas</h1>
      <p className="text-muted-foreground text-sm mb-4">
        Agenda de visitas sincronizada do sistema 1.0.
      </p>
      <SyncedTable
        table="visit_agenda"
        hideColumns={["id"]}
        labels={{
          customer_id: "Cliente",
          seller_id: "Vendedor",
          date: "Data",
          visit_status: "Status",
          actual_check_in: "Check-in",
          scheduled_time: "Horário",
          notes: "Observações",
          created_at: "Criado em",
        }}
      />
    </div>
  );
}
