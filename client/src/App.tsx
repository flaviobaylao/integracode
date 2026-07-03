import { useState } from "react";
import { Switch, Route } from "wouter";
import { queryClient, QueryClientProvider } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import MobileNav from "@/components/mobile-nav";
import PWAInstallBanner from "@/components/PWAInstallBanner";
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
import RoutesSummary from "@/pages/RoutesSummary";
import DriverManagement from "@/pages/DriverManagement";
import DeliveryReports from "@/pages/DeliveryReports";
import VisitRoutes from "@/pages/VisitRoutes";
import RotaDoDia from "@/pages/RotaDoDia";
import RoutesManagement from "@/pages/RoutesManagement";
import DeliveryRoutesList from "@/pages/DeliveryRoutesList";
import RotaEntrega from "@/pages/RotaEntrega";
import DeliveryDailySummary from "@/pages/DeliveryDailySummary";
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
import HotsiteOrders from "@/pages/HotsiteOrders";
import LeadsManagement from "@/pages/LeadsManagement";
import TelemarketingDashboard from "@/pages/TelemarketingDashboard";
import WhatsAppSetup from "@/pages/WhatsAppSetup";
import TelegramSetup from "@/pages/TelegramSetup";
import ChatDeliveries from "@/pages/ChatDeliveries";
import ChatAnalysis from "@/pages/ChatAnalysis";
import ChatManagement from "@/pages/ChatManagement";
import ChatCenter from "@/pages/ChatCenter";
import AgentManagement from "@/pages/AgentManagement";
import QuickTemplates from "@/pages/QuickTemplates";
import TelemarketingHub from "@/pages/TelemarketingHub";
import ClientsMap from "@/pages/ClientsMap";
import SystemAdmin from "@/pages/SystemAdmin";
import ActiveCustomers from "@/pages/ActiveCustomers";
import VirtualClientsToday from "@/pages/VirtualClientsToday";
import ChatTest from "@/pages/ChatTest";
import RoutesValidation from "@/pages/RoutesValidation";
import SalesCardDetail from "@/pages/SalesCardDetail";
import ChatAISettings from "@/pages/ChatAISettings";
import BulkMessage from "@/pages/BulkMessage";
import SDRDigital from "@/pages/SDRDigital";
import PedidoRapido from "@/pages/PedidoRapido";
import VendasDigitais from "@/pages/VendasDigitais";
import TelemarketingRotaDoDia from "@/pages/TelemarketingRotaDoDia";
import OmieInstances from "@/pages/OmieInstances";
import OmieStageLogs from "@/pages/OmieStageLogs";
import FiscalInvoices from "@/pages/FiscalInvoices";
import Inventory from "@/pages/Inventory";
import BillingPipeline from "@/pages/BillingPipeline";
import Financial from "@/pages/Financial";
import Industry from "@/pages/Industry";
import Reports from "@/pages/Reports";
import PurchaseRadar from "@/pages/PurchaseRadar";
import RelatoriosIA from "@/pages/RelatoriosIA";
import PagamentoClientes from "@/pages/PagamentoClientes";
import DashboardFinanceiro from "@/pages/DashboardFinanceiro";
import Repescagem from "@/pages/Repescagem";
import MinhaAgenda from "@/pages/MinhaAgenda";
import PixCharges from "@/pages/PixCharges";
import Visitas from "@/pages/Visitas";
import ResumoVisitas from "@/pages/ResumoVisitas";
import ExecucaoRota from "@/pages/ExecucaoRota";
import RadarChurn from "@/pages/RadarChurn";
import AgentesIA from "@/pages/AgentesIA";
import CenariosFiscais from "@/pages/CenariosFiscais";
import TelefonesClientes from "@/pages/TelefonesClientes";
import TabelaPrecos from "@/pages/TabelaPrecos";
import PrecosGrade from "@/pages/PrecosGrade";
import Cupons from "@/pages/Cupons";
import Fornecedores from "@/pages/Fornecedores";
import RecuperacaoFaturamento from "@/pages/RecuperacaoFaturamento";
import ConciliacaoBancaria from "@/pages/ConciliacaoBancaria";
import AuditoriaCobrancas from "@/pages/AuditoriaCobrancas";
import AutomacoesComunicacao from "@/pages/AutomacoesComunicacao";
import Cielo from "@/pages/Cielo";
import IndustriaDados from "@/pages/IndustriaDados";
import TodasAsContas from "@/pages/TodasAsContas";
import FluxoCaixa from "@/pages/FluxoCaixa";
import ConferenciaPagamentos from "@/pages/ConferenciaPagamentos";
import SyncMonitor from "@/pages/SyncMonitor";

function Router() {
  const { isAuthenticated, isLoading, isError, error, refetch } = useAuth();
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await refetch();
    } finally {
      setIsRetrying(false);
    }
  };

  if (isLoading || isRetrying) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-orange-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-green-600 mx-auto mb-4"></div>
          <p className="text-gray-600">{isRetrying ? 'Reconectando...' : 'Carregando Sistema Integra...'}</p>
        </div>
      </div>
    );
  }

  if (isError) {
    const isConnectionError = error?.message?.includes('timeout') ||
      error?.message?.includes('rede') ||
      error?.message?.includes('fetch');

    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-50 to-yellow-50 p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-xl p-6">
          <div className="text-center mb-5">
            <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-8 h-8 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              {isConnectionError ? 'Problema de Conexão' : 'Erro ao Carregar'}
            </h1>
            <p className="text-gray-600 text-sm">
              {isConnectionError
                ? 'Sua internet pode estar lenta ou instável. Toque em "Tentar Novamente" para reconectar.'
                : 'O sistema não conseguiu se conectar. Tente novamente ou faça login.'}
            </p>
          </div>

          <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 mb-5">
            <p className="text-xs text-orange-800">{error?.message || 'Erro desconhecido'}</p>
          </div>

          {isConnectionError && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-5">
              <p className="text-sm text-blue-800 font-medium mb-1">Dicas:</p>
              <ul className="text-xs text-blue-700 space-y-1">
                <li>- Verifique se o Wi-Fi ou dados móveis estão ligados</li>
                <li>- Mova-se para um local com melhor sinal</li>
                <li>- Aguarde alguns segundos e tente novamente</li>
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <button
              onClick={handleRetry}
              className="w-full px-6 py-4 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold transition-colors text-lg"
              data-testid="button-retry"
            >
              Tentar Novamente
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium transition-colors text-sm"
                data-testid="button-reload"
              >
                Recarregar Página
              </button>
              <button
                onClick={() => window.location.href = '/api/login'}
                className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors text-sm"
                data-testid="button-login"
              >
                Ir para Login
              </button>
            </div>
          </div>

          <div className="mt-4 text-center text-xs text-gray-400">
            <p>{window.location.hostname}</p>
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
      <Route path="/pedido-rapido" component={PedidoRapido} />
      {!isAuthenticated ? (
        <Route path="/" component={Landing} />
      ) : (
        <>
          <Route path="/" component={Home} />
          <Route path="/sellers" component={Sellers} />
          <Route path="/telemarketing" component={TelemarketingHub} />
          <Route path="/telemarketing/main" component={TelemarketingPage} />
          <Route path="/sales-schedule" component={SalesSchedule} />
          <Route path="/billings" component={Billings} />
          <Route path="/sales-goals" component={SalesGoalsPage} />
          <Route path="/blocked-orders" component={BlockedOrdersPage} />
          <Route path="/contas-receber" component={ContasReceber} />
          <Route path="/overdue-debts" component={OverdueDebtsPage} />
          <Route path="/delivery-dashboard" component={DeliveryDashboard} />
          <Route path="/delivery-management" component={DeliveryManagement} />
          <Route path="/delivery-routes" component={RoutesSummary} />
          <Route path="/mapa-clientes" component={ClientsMap} />
          <Route path="/clientes-ativos" component={ActiveCustomers} />
          <Route path="/clientes-virtuais-hoje" component={VirtualClientsToday} />
          <Route path="/rota-entrega" component={RotaEntrega} />
          <Route path="/entregas-do-dia" component={DeliveryDailySummary} />
          <Route path="/driver-management" component={DriverManagement} />
          <Route path="/delivery-reports" component={DeliveryReports} />
          <Route path="/visit-routes" component={VisitRoutes} />
          <Route path="/rota-do-dia" component={RotaDoDia} />
          <Route path="/routes-management" component={RoutesManagement} />
          <Route path="/check-in-photos" component={CheckInPhotos} />
          <Route path="/check-in-audit" component={CheckInAudit} />
          <Route path="/auditoria-checkins" component={CheckInAudit} />
          <Route path="/rh" component={HRManagement} />
          <Route path="/hotsite-pricing" component={HotsitePricing} />
          <Route path="/hotsite-orders" component={HotsiteOrders} />
          <Route path="/leads" component={LeadsManagement} />
          <Route path="/vendas-digitais" component={VendasDigitais} />
          <Route path="/whatsapp" component={WhatsAppSetup} />
          <Route path="/telemarketing/dashboard" component={TelemarketingDashboard} />
          <Route path="/telemarketing/whatsapp" component={WhatsAppSetup} />
          <Route path="/telemarketing/telegram" component={TelegramSetup} />
          <Route path="/telemarketing/deliveries" component={ChatDeliveries} />
          <Route path="/telemarketing/analysis" component={ChatAnalysis} />
          <Route path="/telemarketing/conversas" component={ChatManagement} />
          <Route path="/telemarketing/atendimento" component={ChatCenter} />
          <Route path="/telemarketing/agentes" component={AgentManagement} />
          <Route path="/telemarketing/templates" component={QuickTemplates} />
          <Route path="/telemarketing/test" component={ChatTest} />
          <Route path="/telemarketing/ai-settings" component={ChatAISettings} />
          <Route path="/telemarketing/sdr-digital" component={SDRDigital} />
          <Route path="/telemarketing/disparo-em-massa" component={BulkMessage} />
          <Route path="/telemarketing/rota-do-dia" component={TelemarketingRotaDoDia} />
          <Route path="/admin/users" component={UserManagementPage} />
          <Route path="/admin/system" component={SystemAdmin} />
          <Route path="/admin/omie-instances" component={OmieInstances} />
          <Route path="/admin/omie-stage-logs" component={OmieStageLogs} />
          <Route path="/admin/sync-monitor" component={SyncMonitor} />
          <Route path="/admin/agentes" component={AgentesIA} />
          <Route path="/cenarios-fiscais" component={CenariosFiscais} />
          <Route path="/telefones-clientes" component={TelefonesClientes} />
          <Route path="/tabela-precos" component={TabelaPrecos} />
          <Route path="/precos-grade" component={PrecosGrade} />
          <Route path="/cupons" component={Cupons} />
          <Route path="/fornecedores" component={Fornecedores} />
          <Route path="/recuperacao-faturamento" component={RecuperacaoFaturamento} />
          <Route path="/conciliacao-bancaria" component={ConciliacaoBancaria} />
          <Route path="/auditoria-cobrancas" component={AuditoriaCobrancas} />
          <Route path="/automacoes-comunicacao" component={AutomacoesComunicacao} />
          <Route path="/cielo" component={Cielo} />
          <Route path="/industria-dados" component={IndustriaDados} />
          <Route path="/todas-as-contas" component={TodasAsContas} />
          <Route path="/fluxo-caixa" component={FluxoCaixa} />
          <Route path="/conferencia-pagamentos" component={ConferenciaPagamentos} />
          <Route path="/validacao-rotas" component={RoutesValidation} />
          <Route path="/sales-card/:id" component={SalesCardDetail} />
          <Route path="/fiscal-invoices" component={FiscalInvoices} />
          <Route path="/estoque" component={Inventory} />
          <Route path="/billing-pipeline" component={BillingPipeline} />
          <Route path="/financeiro" component={Financial} />
          <Route path="/industria" component={Industry} />
          <Route path="/relatorios" component={Reports} />
          <Route path="/radar-compras" component={PurchaseRadar} />
          <Route path="/relatorios-ia" component={RelatoriosIA} />
          <Route path="/pagamento-clientes" component={PagamentoClientes} />
      <Route path="/dashboard-financeiro" component={DashboardFinanceiro} />
          <Route path="/repescagem" component={Repescagem} />
          <Route path="/minha-agenda" component={MinhaAgenda} />
          <Route path="/pix-charges" component={PixCharges} />
          <Route path="/visitas" component={Visitas} />
          <Route path="/resumo-visitas" component={ResumoVisitas} />
          <Route path="/execucao-rota" component={ExecucaoRota} />
          <Route path="/radar-churn" component={RadarChurn} />
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
        <PWAInstallBanner />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
