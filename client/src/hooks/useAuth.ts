import { useQuery } from "@/lib/queryClient";

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl?: string;
  role: 'admin' | 'coordinator' | 'administrative' | 'vendedor' | 'telemarketing' | 'motorista';
  route?: string;
  isActive: boolean;
  homeLatitude?: string;
  homeLongitude?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function useAuth() {
  const { data: user, isLoading, error, isError } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segundos timeout
      
      try {
        const res = await fetch("/api/auth/user", {
          credentials: "include",
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        // Se não autenticado, retorna null (não é erro, é estado válido)
        if (res.status === 401) {
          return null;
        }
        
        if (!res.ok) {
          throw new Error(`${res.status}: ${res.statusText}`);
        }
        
        return await res.json();
      } catch (err: any) {
        clearTimeout(timeoutId);
        
        // Se for timeout ou erro de rede, lança erro para permitir retry
        if (err.name === 'AbortError') {
          console.warn('Auth check timeout, will retry...');
          throw new Error('Auth check timeout - please check your connection');
        }
        
        throw err;
      }
    },
    retry: 2, // Permite 2 retries para recuperar de erros temporários
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 3000), // Backoff exponencial
    staleTime: 1000 * 30, // 30 segundos - permite revalidação mais frequente
    gcTime: 1000 * 60 * 5, // 5 minutos
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    refetchOnReconnect: true, // Revalida quando a conexão volta
    networkMode: 'online', // Só tenta quando online
  });

  return {
    user,
    isLoading,
    isError,
    error,
    isAuthenticated: !!user && !isError,
  };
}
