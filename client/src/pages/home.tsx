import { useAuth } from "@/hooks/useAuth";
import Layout from "@/components/Layout";
import Dashboard from "@/components/Dashboard";
import SalesCards from "@/components/SalesCards";
import CustomerManagement from "@/components/CustomerManagement";
import ProductManagement from "@/components/ProductManagement";
import WhatsAppIntegration from "@/components/WhatsAppIntegration";
import OmieIntegration from "@/components/OmieIntegration";
import Sellers from "@/pages/sellers";
import TelemarketingPage from "@/pages/telemarketing";
import { useState } from "react";

export default function Home() {
  const { user, isLoading } = useAuth();
  const [activeView, setActiveView] = useState('dashboard');

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-honest-blue"></div>
      </div>
    );
  }

  const renderActiveView = () => {
    switch (activeView) {
      case 'dashboard':
        return <Dashboard />;
      case 'sales-cards':
        return <SalesCards />;
      case 'customers':
        return <CustomerManagement />;
      case 'products':
        return <ProductManagement />;
      case 'whatsapp':
        return <WhatsAppIntegration />;
      case 'omie':
        return <OmieIntegration />;
      case 'sellers':
        return <Sellers />;
      case 'telemarketing':
        return <TelemarketingPage />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <Layout activeView={activeView} setActiveView={setActiveView} user={user as any}>
      {renderActiveView()}
    </Layout>
  );
}
