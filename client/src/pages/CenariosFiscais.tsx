import BackToDashboardButton from "@/components/BackToDashboardButton";
import FiscalScenariosTab from "@/components/FiscalScenariosTab";

export default function CenariosFiscais() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Cenários Fiscais</h1>
      <FiscalScenariosTab />
    </div>
  );
}
