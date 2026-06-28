import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";

export default function Fornecedores() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Fornecedores</h1>
      <SyncedTable
        table="suppliers"
        hideColumns={["id", "default_chart_account_id", "omie_instance_id", "address_complement"]}
        labels={{ name: "Nome", company_name: "Razão Social", cnpj: "CNPJ", cpf: "CPF", state_registration: "Insc. Estadual", email: "E-mail", phone: "Telefone", contact_name: "Contato", address: "Endereço", address_number: "Nº", neighborhood: "Bairro", city: "Cidade", state: "UF", zip_code: "CEP", default_category: "Categoria", notes: "Obs.", is_active: "Ativo", created_at: "Criado em", updated_at: "Atualizado em" }}
      />
    </div>
  );
}
