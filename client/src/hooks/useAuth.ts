import { useQuery } from "@tanstack/react-query";

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl?: string;
  role: 'admin' | 'coordinator' | 'administrative' | 'vendedor';
  route?: string;
  isActive: boolean;
  homeLatitude?: string;
  homeLongitude?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function useAuth() {
  const { data: user, isLoading, error, isError } = useQuery<User>({
    queryKey: ["/api/auth/user"],
    retry: 1,
    retryDelay: 1000,
    staleTime: 1000 * 60 * 5, // 5 minutos
    gcTime: 1000 * 60 * 10, // 10 minutos (antigamente cacheTime)
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    networkMode: 'online',
  });

  return {
    user,
    isLoading,
    isError,
    error,
    isAuthenticated: !!user && !isError,
  };
}
