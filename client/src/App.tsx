import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import Login from "@/pages/login";
import SetPassword from "@/pages/set-password";
import Home from "@/pages/home";
import AdminLogin from "@/pages/admin-login";
import Sellers from "@/pages/sellers";
import TelemarketingPage from "@/pages/telemarketing";
import SalesSchedule from "@/pages/SalesSchedule";
import Billings from "@/pages/Billings";
import BlockedOrdersPage from "@/pages/BlockedOrders";
import DeliveryDashboard from "@/pages/DeliveryDashboard";
import DeliveryManagement from "@/pages/DeliveryManagement";
import DriverManagement from "@/pages/DriverManagement";
import DeliveryReports from "@/pages/DeliveryReports";
import VisitRoutes from "@/pages/VisitRoutes";
import DailyRouteView from "@/pages/DailyRouteView";
import RoutesManagement from "@/pages/RoutesManagement";
import UserManagementPage from "@/pages/UserManagementPage";
import BankAccountsDebug from "@/pages/BankAccountsDebug";
import ContasReceber from "@/pages/ContasReceber";
import OverdueDebtsPage from "@/pages/OverdueDebts";
import SalesGoalsPage from "@/pages/SalesGoals";
import CheckInPhotos from "@/pages/CheckInPhotos";
import HRManagement from "@/pages/HRManagement";
import CheckInAudit from "@/pages/CheckInAudit";
import ClearCache from "@/pages/ClearCache";
import HotsitePricing from "@/pages/HotsitePricing";

function Router() {
  const { isAuthenticated, isLoading, isError, error } = useAuth();

  // Se estiver carregando, mostra um loading spinner para evitar tela branca
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-orange-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-green-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Carregando Sistema Integra...</p>
        </div>
      </div>
    );
  }

  // Se houver erro ao carregar autenticação, mostra tela de erro com diagnóstico
  if (isError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 to-orange-50 p-4">
        <div className="max-w-2xl w-full bg-white rounded-lg shadow-xl p-8">
          <div className="text-center mb-6">
            <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-10 h-10 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Erro ao Carregar Sistema</h1>
            <p className="text-gray-600 mb-4">
              O Sistema Integra não conseguiu se conectar ao servidor. Isso pode acontecer após publicação.
            </p>
          </div>

          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <h2 className="font-semibold text-red-900 mb-2">Detalhes do erro:</h2>
            <p className="text-sm text-red-800 font-mono">{error?.message || 'Erro desconhecido'}</p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <h2 className="font-semibold text-blue-900 mb-3">💡 Soluções possíveis:</h2>
            <ul className="space-y-2 text-sm text-blue-800">
              <li className="flex items-start gap-2">
                <span className="font-bold mt-0.5">1.</span>
                <span>Se você acabou de <strong>publicar o app</strong>, verifique se o domínio de produção está na variável <code className="bg-blue-100 px-1 rounded">REPLIT_DOMAINS</code></span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-bold mt-0.5">2.</span>
                <span>Verifique se as <strong>variáveis de ambiente secretas</strong> (SESSION_SECRET, DATABASE_URL) estão configuradas na aba de Secrets do Replit</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-bold mt-0.5">3.</span>
                <span>Confira se o <strong>banco de dados está rodando</strong> e acessível em produção</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-bold mt-0.5">4.</span>
                <span>Verifique os <strong>logs do servidor</strong> para mensagens de erro detalhadas</span>
              </li>
            </ul>
          </div>

          <div className="flex gap-3 justify-center">
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold transition-colors"
              data-testid="button-reload"
            >
              Recarregar Página
            </button>
            <button
              onClick={() => window.location.href = '/api/login'}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold transition-colors"
              data-testid="button-login"
            >
              Ir para Login
            </button>
          </div>

          <div className="mt-6 text-center text-xs text-gray-500">
            <p>Ambiente: {window.location.hostname}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Switch>
      <Route path="/limpar-cache" component={ClearCache} />
      <Route path="/login" component={Login} />
      <Route path="/set-password" component={SetPassword} />
      <Route path="/admin-login" component={AdminLogin} />
      {!isAuthenticated ? (
        <Route path="/" component={Landing} />
      ) : (
        <>
          <Route path="/" component={Home} />
          <Route path="/sellers" component={Sellers} />
          <Route path="/telemarketing" component={TelemarketingPage} />
          <Route path="/sales-schedule" component={SalesSchedule} />
          <Route path="/billings" component={Billings} />
          <Route path="/sales-goals" component={SalesGoalsPage} />
          <Route path="/blocked-orders" component={BlockedOrdersPage} />
          <Route path="/contas-receber" component={ContasReceber} />
          <Route path="/overdue-debts" component={OverdueDebtsPage} />
          <Route path="/delivery-dashboard" component={DeliveryDashboard} />
          <Route path="/delivery-management" component={DeliveryManagement} />
          <Route path="/driver-management" component={DriverManagement} />
          <Route path="/delivery-reports" component={DeliveryReports} />
          <Route path="/visit-routes" component={VisitRoutes} />
          <Route path="/daily-route" component={DailyRouteView} />
          <Route path="/routes-management" component={RoutesManagement} />
          <Route path="/check-in-photos" component={CheckInPhotos} />
          <Route path="/check-in-audit" component={CheckInAudit} />
          <Route path="/auditoria-checkins" component={CheckInAudit} />
          <Route path="/rh" component={HRManagement} />
          <Route path="/hotsite-pricing" component={HotsitePricing} />
          <Route path="/admin/users" component={UserManagementPage} />
          <Route path="/debug/bank-accounts" component={BankAccountsDebug} />
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
