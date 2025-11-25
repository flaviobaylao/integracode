import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function BankAccountsDebug() {
  const { data: accounts, isLoading } = useQuery({
    queryKey: ['/api/omie/bank-accounts'],
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Contas Correntes do Omie</h1>
        <BackToDashboardButton />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Contas Correntes do Omie</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {accounts && Array.isArray(accounts) ? (
              accounts.map((account: any, index: number) => (
                <div 
                  key={index} 
                  className="p-4 border rounded-lg"
                  data-testid={`account-${index}`}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <strong>Código:</strong> {account.nCodCC || 'N/A'}
                    </div>
                    <div>
                      <strong>Nome:</strong> {account.cDescrCC || 'N/A'}
                    </div>
                    <div>
                      <strong>Tipo:</strong> {account.cTipo || 'N/A'}
                    </div>
                    <div>
                      <strong>Banco:</strong> {account.cNomeBanco || 'N/A'}
                    </div>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-gray-600">
                      Ver JSON completo
                    </summary>
                    <pre className="mt-2 p-2 bg-gray-100 rounded text-xs overflow-auto">
                      {JSON.stringify(account, null, 2)}
                    </pre>
                  </details>
                </div>
              ))
            ) : (
              <p>Nenhuma conta encontrada</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
