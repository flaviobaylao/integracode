import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function AuditoriaCobrancas() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Auditoria de Cobranças</h1>
      <SyncedTable
        table="boleto_charges"
        hideColumns={["id", "pix_qr_code_base64", "pix_copia_e_cola", "codigo_barras", "linha_digitavel"]}
        labels={{ nosso_numero: "Nosso Número", numero_convenio: "Convênio", numero_carteira: "Carteira", data_vencimento: "Vencimento", valor_original: "Valor", debtor_name: "Pagador", debtor_document: "Documento", status: "Status", receivable_id: "Recebível", customer_id: "Cliente", created_at: "Criado em" }}
      />
    </div>
  );
}
