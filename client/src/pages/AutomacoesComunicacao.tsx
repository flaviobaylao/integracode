import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function AutomacoesComunicacao() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Automações de Comunicação</h1>
      <SyncedTable
        table="communication_automations"
        hideColumns={["id", "created_by", "umbler_channel_id", "recipient_user_id", "trigger_filters"]}
        labels={{ name: "Nome", description: "Descrição", is_active: "Ativa", trigger_event: "Gatilho", recipient_type: "Destinatário", recipient_fixed_phone: "Telefone fixo", message_template: "Mensagem", channel: "Canal", sent_count: "Enviadas", failed_count: "Falhas", last_triggered_at: "Último disparo", created_at: "Criada em" }}
      />
    </div>
  );
}
