import OverdueDebtsManagement from "@/components/OverdueDebtsManagement";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function OverdueDebtsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Débitos em Atraso</h1>
        <BackToDashboardButton />
      </div>
      <OverdueDebtsManagement />
    </div>
  );
}
