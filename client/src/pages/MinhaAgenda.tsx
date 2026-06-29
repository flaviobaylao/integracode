import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function MinhaAgenda() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Minha Agenda</h1>
      <p className="text-muted-foreground text-sm mb-4">
        Itens de agenda pessoal sincronizados do sistema 1.0.
      </p>
      <SyncedTable
        table="personal_agenda_items"
        hideColumns={["id"]}
        labels={{
          title: "Título",
          description: "Descrição",
          due_date: "Data",
          status: "Status",
          priority: "Prioridade",
          created_at: "Criado em",
        }}
      />
    </div>
  );
}
