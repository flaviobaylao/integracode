import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function RecuperacaoFaturamento() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Recuperação de Faturamento</h1>
      <SyncedTable
        table="recovery_invoices"
        hideColumns={["id", "upload_id", "access_key", "referenced_access_key", "sefaz_verifier_version", "omie_instance_id"]}
        labels={{ invoice_number: "NF", series: "Série", invoice_model: "Modelo", issue_date: "Emissão", total_value: "Valor", issuer_cnpj: "CNPJ Emitente", issuer_name: "Emitente", issuer_uf: "UF", recipient_document: "Doc. Destinatário", recipient_name: "Destinatário", recipient_city: "Cidade", recipient_uf: "UF Dest.", sefaz_status: "Status SEFAZ", cfop: "CFOP", operation_nature: "Natureza", is_cancelled: "Cancelada", is_return: "Devolução", seller_name: "Vendedor", payment_method: "Pagamento", created_at: "Criado em" }}
      />
    </div>
  );
}
