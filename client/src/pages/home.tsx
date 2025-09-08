import { useAuth } from "@/hooks/useAuth";
import Layout from "@/components/Layout";
import Dashboard from "@/components/Dashboard";
import SalesCards from "@/components/SalesCards";
import CustomerManagement from "@/components/CustomerManagement";
import ProductManagement from "@/components/ProductManagement";
import Billings from "@/pages/Billings";
import WhatsAppIntegration from "@/components/WhatsAppIntegration";
import OmieIntegration from "@/components/OmieIntegration";
import SalesGoalsManagement from "@/components/SalesGoalsManagement";
import Sellers from "@/pages/sellers";
import TelemarketingPage from "@/pages/telemarketing";
import SalesSchedule from "@/pages/SalesSchedule";
import OverdueDebtsManagement from "@/components/OverdueDebtsManagement";
import BlockedOrdersManagement from "@/components/BlockedOrdersManagement";
import LocationsManagement from "@/pages/LocationsManagement";
import OrderSteps from "@/components/OrderSteps";
import InvoiceDebugger from "@/pages/InvoiceDebugger";
import DeliveryDashboard from "@/pages/DeliveryDashboard";
import DeliveryManagement from "@/pages/DeliveryManagement";
import DriverManagement from "@/pages/DriverManagement";
import DeliveryReports from "@/pages/DeliveryReports";
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
      case 'sales-goals':
        return <SalesGoalsManagement user={user as any} />;
      case 'products':
        return <ProductManagement />;
      case 'billings':
        return <Billings />;
      case 'debug-invoice':
        return <InvoiceDebugger />;
      case 'whatsapp':
        return <WhatsAppIntegration />;
      case 'omie':
        return <OmieIntegration />;
      case 'sellers':
        return <Sellers />;
      case 'telemarketing':
        return <TelemarketingPage />;
      case 'sales-schedule':
        return <SalesSchedule />;
      case 'overdue-debts':
        return <OverdueDebtsManagement />;
      case 'blocked-orders':
        return <BlockedOrdersManagement user={user as any} />;
      case 'order-sale':
        return <OrderSteps step="sale" />;
      case 'order-billing':
        return <OrderSteps step="billing" />;
      case 'order-billed':
        return <OrderSteps step="billed" />;
      case 'order-awaiting-route':
        return <OrderSteps step="awaiting-route" />;
      case 'order-in-route':
        return <OrderSteps step="in-route" />;
      case 'locations':
        return <LocationsManagement />;
      case 'delivery-dashboard':
        return <DeliveryDashboard />;
      case 'delivery-management':
        return <DeliveryManagement />;
      case 'driver-management':
        return <DriverManagement />;
      case 'delivery-reports':
        return <DeliveryReports />;
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
