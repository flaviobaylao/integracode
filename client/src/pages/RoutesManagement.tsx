import { RouteManagement } from "@/components/RouteManagement";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function RoutesManagementPage() {
  return (
    <div className="container mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Gerenciamento de Rotas</h1>
        <BackToDashboardButton />
      </div>
      <RouteManagement />
    </div>
  );
}
