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
  const { data: user, isLoading, error, isError, refetch } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      try {
        const res = await fetch("/api/auth/user", {
          credentials: "include",
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (res.status === 401) {
          return null;
        }
        
        if (!res.ok) {
          throw new Error(`${res.status}: ${res.statusText}`);
        }
        
        return await res.json();
      } catch (err: any) {
        clearTimeout(timeoutId);
        
        if (err.name === 'AbortError') {
          console.warn('Auth check timeout, will retry...');
          throw new Error('Auth check timeout - verifique sua conexão');
        }

        if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
          console.warn('Network error during auth check, will retry...');
          throw new Error('Erro de rede - verifique sua conexão');
        }
        
        throw err;
      }
    },
    retry: 4,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    refetchOnReconnect: true,
    networkMode: 'always',
  });

  return {
    user,
    isLoading,
    isError,
    error,
    isAuthenticated: !!user && !isError,
    refetch,
  };
}
