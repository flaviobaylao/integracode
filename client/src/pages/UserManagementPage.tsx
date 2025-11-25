import UserManagement from "@/components/UserManagement";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function UserManagementPage() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user?.role !== 'admin') {
      setLocation('/');
    }
  }, [user, isLoading, setLocation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-orange"></div>
      </div>
    );
  }

  if (user?.role !== 'admin') {
    return null;
  }

  return (
    <div>
      <div className="flex items-center justify-between p-6 pb-0">
        <h1 className="text-3xl font-bold">Gerenciamento de Usuários</h1>
        <BackToDashboardButton />
      </div>
      <UserManagement />
    </div>
  );
}
