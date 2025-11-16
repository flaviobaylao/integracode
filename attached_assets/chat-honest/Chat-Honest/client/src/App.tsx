import { useState, useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import { LoginPage } from "@/pages/login";
import { AdminPage } from "@/pages/admin";
import { WhatsAppSetupPage } from "@/pages/whatsapp-setup";
import { WhatsAppAnalysisPage } from "@/pages/whatsapp-analysis";
import TelegramSetup from "@/pages/telegram-setup";
import DeliveriesPage from "@/pages/deliveries";
import NotFound from "@/pages/not-found";

interface User {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'agent' | 'delivery';
}

function Router() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setLocation] = useLocation();

  useEffect(() => {
    // Check if user is already logged in
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch("/api/auth/user");
      if (response.ok) {
        const userData = await response.json();
        setUser(userData);
      }
    } catch (error) {
      console.log("Not authenticated");
    } finally {
      setLoading(false);
    }
  };

  const handleLoginSuccess = (userData: User) => {
    setUser(userData);
    // Redirect based on user role
    if (userData.role === 'admin') {
      setLocation("/admin");
    } else if (userData.role === 'delivery') {
      setLocation("/deliveries");
    } else {
      setLocation("/dashboard");
    }
  };

  const handleLogout = () => {
    setUser(null);
  };

  const handleNavigateToDashboard = () => {
    setLocation("/dashboard");
  };

  const handleNavigateToAdmin = () => {
    setLocation("/admin");
  };

  const handleNavigateToWhatsAppSetup = () => {
    setLocation("/whatsapp-setup");
  };

  const handleNavigateToTelegramSetup = () => {
    setLocation("/telegram-setup");
  };

  const handleNavigateToDeliveries = () => {
    setLocation("/deliveries");
  };

  const handleNavigateToWhatsAppAnalysis = () => {
    setLocation("/whatsapp-analysis");
  };

  const handleNavigateBack = () => {
    if (user?.role === 'admin') {
      setLocation("/admin");
    } else if (user?.role === 'delivery') {
      setLocation("/deliveries");
    } else {
      setLocation("/dashboard");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-whatsapp-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <Switch>
      <Route path="/">
        {user.role === 'admin' ? (
          <AdminPage user={user} onLogout={handleLogout} onNavigateToDashboard={handleNavigateToDashboard} onNavigateToWhatsAppSetup={handleNavigateToWhatsAppSetup} onNavigateToTelegramSetup={handleNavigateToTelegramSetup} onNavigateToWhatsAppAnalysis={handleNavigateToWhatsAppAnalysis} />
        ) : user.role === 'delivery' ? (
          <DeliveriesPage />
        ) : (
          <Dashboard user={user} onLogout={handleLogout} onNavigateToAdmin={undefined} onNavigateToWhatsAppSetup={handleNavigateToWhatsAppSetup} onNavigateToTelegramSetup={handleNavigateToTelegramSetup} />
        )}
      </Route>
      <Route path="/admin">
        {user.role === 'admin' ? (
          <AdminPage user={user} onLogout={handleLogout} onNavigateToDashboard={handleNavigateToDashboard} onNavigateToWhatsAppSetup={handleNavigateToWhatsAppSetup} onNavigateToTelegramSetup={handleNavigateToTelegramSetup} onNavigateToWhatsAppAnalysis={handleNavigateToWhatsAppAnalysis} />
        ) : (
          <div className="min-h-screen bg-gray-50 flex items-center justify-center">
            <div className="text-center">
              <div className="mx-auto h-12 w-12 text-red-500">
                <i className="fas fa-ban text-4xl"></i>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-gray-900">Acesso Negado</h2>
              <p className="mt-2 text-gray-600">Você não tem permissão para acessar esta página.</p>
            </div>
          </div>
        )}
      </Route>
      <Route path="/dashboard">
        <Dashboard user={user} onLogout={handleLogout} onNavigateToAdmin={undefined} onNavigateToWhatsAppSetup={handleNavigateToWhatsAppSetup} onNavigateToTelegramSetup={handleNavigateToTelegramSetup} />
      </Route>
      <Route path="/whatsapp-setup">
        <WhatsAppSetupPage user={user} onLogout={handleLogout} onNavigateBack={handleNavigateBack} />
      </Route>
      <Route path="/telegram-setup">
        <TelegramSetup onLogout={handleLogout} onNavigateBack={handleNavigateBack} />
      </Route>
      <Route path="/deliveries">
        {user.role === 'delivery' ? (
          <DeliveriesPage />
        ) : (
          <div className="min-h-screen bg-gray-50 flex items-center justify-center">
            <div className="text-center">
              <div className="mx-auto h-12 w-12 text-red-500">
                <i className="fas fa-ban text-4xl"></i>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-gray-900">Acesso Negado</h2>
              <p className="mt-2 text-gray-600">Você não tem permissão para acessar esta página.</p>
            </div>
          </div>
        )}
      </Route>
      <Route path="/whatsapp-analysis">
        {user.role === 'admin' ? (
          <WhatsAppAnalysisPage user={user} onLogout={handleLogout} onNavigateToAdmin={handleNavigateToAdmin} />
        ) : (
          <div className="min-h-screen bg-gray-50 flex items-center justify-center">
            <div className="text-center">
              <div className="mx-auto h-12 w-12 text-red-500">
                <i className="fas fa-ban text-4xl"></i>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-gray-900">Acesso Negado</h2>
              <p className="mt-2 text-gray-600">Você não tem permissão para acessar esta página.</p>
            </div>
          </div>
        )}
      </Route>
      <Route path="/settings">
        {user.role === 'admin' ? (
          <AdminPage user={user} onLogout={handleLogout} onNavigateToDashboard={handleNavigateToDashboard} onNavigateToWhatsAppSetup={handleNavigateToWhatsAppSetup} onNavigateToTelegramSetup={handleNavigateToTelegramSetup} onNavigateToWhatsAppAnalysis={handleNavigateToWhatsAppAnalysis} />
        ) : (
          <div className="min-h-screen bg-gray-50 flex items-center justify-center">
            <div className="text-center">
              <div className="mx-auto h-12 w-12 text-red-500">
                <i className="fas fa-ban text-4xl"></i>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-gray-900">Acesso Negado</h2>
              <p className="mt-2 text-gray-600">Você não tem permissão para acessar esta página.</p>
            </div>
          </div>
        )}
      </Route>
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
