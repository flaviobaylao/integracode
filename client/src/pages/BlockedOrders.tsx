import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import Layout from "@/components/Layout";
import BlockedOrdersManagement from "@/components/BlockedOrdersManagement";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function BlockedOrdersPage() {
  const { user, isLoading } = useAuth();
  const [activeView, setActiveView] = useState('blocked-orders');

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-honest-blue"></div>
      </div>
    );
  }

  return (
    <Layout activeView={activeView} setActiveView={setActiveView}>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Pedidos Bloqueados</h1>
        <BackToDashboardButton />
      </div>
      <BlockedOrdersManagement user={user as any} />
    </Layout>
  );
}
