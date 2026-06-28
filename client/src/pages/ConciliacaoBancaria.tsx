import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function ConciliacaoBancaria() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Conciliação Bancária</h1>
      <SyncedTable
        table="bank_statement_items"
        hideColumns={["id", "statement_id", "matched_receivable_id", "matched_payable_id", "matched_by", "match_confidence"]}
        labels={{ transaction_date: "Data", amount: "Valor", type: "Tipo", description: "Descrição", document: "Documento", balance_after: "Saldo", origin_name: "Origem", origin_document: "Doc. Origem", reconciliation_status: "Conciliação", matched_at: "Conciliado em", notes: "Obs.", created_at: "Criado em" }}
      />
    </div>
  );
}
