import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function PixCharges() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">PIX</h1>
      <p className="text-muted-foreground text-sm mb-4">
        Cobranças PIX registradas no sistema.
      </p>
      <SyncedTable
        table="pix_charges"
        hideColumns={["id", "pix_qr_code_base64"]}
        labels={{
          txid: "TXID",
          customer_id: "Cliente",
          receivable_id: "Recebível",
          amount: "Valor",
          status: "Status",
          due_date: "Vencimento",
          paid_at: "Pago em",
          created_at: "Criado em",
        }}
      />
    </div>
  );
}
