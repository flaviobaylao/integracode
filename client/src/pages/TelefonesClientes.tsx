import BackToDashboardButton from "@/components/BackToDashboardButton";
import { PhonebookPanel } from "@/components/PhonebookPanel";

export default function TelefonesClientes() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Telefones de Clientes</h1>
      <PhonebookPanel />
    </div>
  );
}
