import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';

export default function ClearCache() {
  const [, setLocation] = useLocation();
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState('Iniciando limpeza...');

  const addLog = (message: string) => {
    setLogs(prev => [...prev, message]);
  };

  useEffect(() => {
    const limparTudo = async () => {
      try {
        // 1. Desregistrar Service Worker
        setStatus('Desregistrando Service Worker...');
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (let registration of registrations) {
            await registration.unregister();
            addLog('Service Worker desregistrado');
          }
        }

        // 2. Limpar todos os caches
        setStatus('Limpando caches...');
        if ('caches' in window) {
          const cacheNames = await caches.keys();
          for (let cacheName of cacheNames) {
            await caches.delete(cacheName);
            addLog(`Cache "${cacheName}" removido`);
          }
        }

        // 3. Limpar localStorage
        setStatus('Limpando localStorage...');
        localStorage.clear();
        addLog('localStorage limpo');

        // 4. Limpar sessionStorage
        setStatus('Limpando sessionStorage...');
        sessionStorage.clear();
        addLog('sessionStorage limpo');

        // 5. Sucesso!
        setStatus('✅ Limpeza concluída!');
        addLog('Redirecionando para Auditoria de Check-ins...');

        // 6. Aguardar 2 segundos e redirecionar
        setTimeout(() => {
          window.location.href = '/auditoria-checkins';
        }, 2000);

      } catch (error) {
        const err = error as Error;
        setStatus('❌ Erro: ' + err.message);
        addLog('ERRO: ' + err.message);
        
        // Se der erro, redireciona mesmo assim após 3 segundos
        setTimeout(() => {
          window.location.href = '/auditoria-checkins';
        }, 3000);
      }
    };

    limparTudo();
  }, [setLocation]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-600 to-green-800 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-green-800 mb-4 text-center">
          🔄 Limpando Cache
        </h1>
        
        <div className="flex justify-center mb-6">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-green-200 border-t-green-600"></div>
        </div>
        
        <div className="text-center text-lg text-gray-700 mb-4">
          {status}
        </div>
        
        <div className="bg-gray-50 rounded-lg p-4 max-h-64 overflow-y-auto">
          {logs.map((log, index) => (
            <div 
              key={index} 
              className="text-sm text-gray-600 mb-2 pl-4 border-l-2 border-green-500"
            >
              ✓ {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
