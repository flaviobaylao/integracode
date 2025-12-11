import { QueryClient, QueryFunction, QueryCache, MutationCache, QueryClientProvider, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Re-exportar TUDO do React Query para forçar o Vite a usar um único bundle
export { QueryClientProvider, useQuery, useMutation, useQueryClient, QueryCache, MutationCache, QueryClient };

export class UnauthorizedError extends Error {
  constructor(message: string = "Sessão expirada. Por favor, faça login novamente.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) {
      throw new UnauthorizedError();
    }
    
    // Tentar parsear como JSON primeiro (para erros estruturados do backend)
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      let errorData;
      try {
        errorData = await res.json();
      } catch (jsonError) {
        // Se falhar ao parsear JSON, lançar erro genérico
        console.log('⚠️ Failed to parse error JSON:', jsonError);
        throw new Error(`${res.status}: Error parsing response`);
      }
      
      console.log('🔴 API Error Response:', errorData);
      
      // Criar um Error que preserva todos os campos do errorData
      const error: any = new Error(errorData.message || JSON.stringify(errorData));
      error.status = res.status;
      error.code = errorData.code;
      error.missingCoordinates = errorData.missingCoordinates;
      
      // Copiar quaisquer outros campos do errorData para o error
      Object.keys(errorData).forEach(key => {
        if (key !== 'message' && !(key in error)) {
          error[key] = errorData[key];
        }
      });
      
      throw error;
    }
    
    // Fallback para text se não for JSON
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  options?: { timeout?: number }
): Promise<any> {
  const controller = new AbortController();
  const timeoutMs = options?.timeout || 120000; // 2 minutos padrão
  
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    console.log('🌐 API Request:', method, url, data ? 'with data' : 'no data');
    const res = await fetch(url, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
      signal: controller.signal,
    });

    console.log('📡 API Response:', res.status, res.statusText);
    await throwIfResNotOk(res);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function apiRequestMultipart(
  method: string,
  url: string,
  formData: FormData,
  options?: { timeout?: number }
): Promise<any> {
  const controller = new AbortController();
  const timeoutMs = options?.timeout || 120000; // 2 minutos padrão
  
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    console.log('🌐 API Multipart Request:', method, url);
    console.log('📦 FormData entries:');
    for (const [key, value] of formData.entries()) {
      console.log(`  - ${key}: ${value instanceof File ? `File(${value.name}, ${value.size} bytes)` : value}`);
    }
    
    const res = await fetch(url, {
      method,
      body: formData,
      credentials: "include",
      signal: controller.signal,
    });

    console.log('📡 API Response:', res.status, res.statusText);
    console.log('📝 Response headers:', res.headers);
    await throwIfResNotOk(res);
    return await res.json();
  } catch (error) {
    console.error('❌ Multipart request error:', error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

let unauthorizedHandlerRegistered = false;
function handleUnauthorizedError() {
  if (unauthorizedHandlerRegistered) return;
  unauthorizedHandlerRegistered = true;
  
  const event = new CustomEvent('session-expired', {
    detail: { message: 'Sua sessão expirou. Por favor, faça login novamente.' }
  });
  window.dispatchEvent(event);
  
  setTimeout(() => {
    window.location.href = '/login';
  }, 2000);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof UnauthorizedError) {
        handleUnauthorizedError();
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (error instanceof UnauthorizedError) {
        handleUnauthorizedError();
      }
    },
  }),
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000, // 5 minutos ao invés de Infinity
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
