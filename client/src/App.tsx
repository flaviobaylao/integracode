import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import Home from "@/pages/home";
import AdminLogin from "@/pages/admin-login";
import Sellers from "@/pages/sellers";
import TelemarketingPage from "@/pages/telemarketing";
import SalesSchedule from "@/pages/SalesSchedule";
import Billings from "@/pages/Billings";
import DeliveryDashboard from "@/pages/DeliveryDashboard";
import DeliveryManagement from "@/pages/DeliveryManagement";
import DriverManagement from "@/pages/DriverManagement";
import DeliveryReports from "@/pages/DeliveryReports";
import VisitRoutes from "@/pages/VisitRoutes";
import RoutesManagement from "@/pages/RoutesManagement";
import UserManagementPage from "@/pages/UserManagementPage";

function Router() {
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <Switch>
      <Route path="/admin-login" component={AdminLogin} />
      {isLoading || !isAuthenticated ? (
        <Route path="/" component={Landing} />
      ) : (
        <>
          <Route path="/" component={Home} />
          <Route path="/sellers" component={Sellers} />
          <Route path="/telemarketing" component={TelemarketingPage} />
          <Route path="/sales-schedule" component={SalesSchedule} />
          <Route path="/billings" component={Billings} />
          <Route path="/delivery-dashboard" component={DeliveryDashboard} />
          <Route path="/delivery-management" component={DeliveryManagement} />
          <Route path="/driver-management" component={DriverManagement} />
          <Route path="/delivery-reports" component={DeliveryReports} />
          <Route path="/visit-routes" component={VisitRoutes} />
          <Route path="/routes-management" component={RoutesManagement} />
          <Route path="/admin/users" component={UserManagementPage} />
        </>
      )}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
