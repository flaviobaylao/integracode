import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle, XCircle, Loader2 } from "lucide-react";

interface CustomerExcelImportProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ImportResult {
  success: boolean;
  updated: number;
  notFound: number;
  totalProcessed: number;
  errors: string[];
  message: string;
  debugInfo?: Array<{
    row: number;
    customer: string;
    availableColumns: string[];
    latitudeCol: any;
    latitudeType: string;
    longitudeCol: any;
    longitudeType: string;
    updateData: any;
    updateSuccess?: boolean;
    updateError?: string;
    reason?: string;
  }>;
}

export default function CustomerExcelImport({ isOpen, onClose }: CustomerExcelImportProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/customers/import', {
        method: 'POST',
        body: formData,
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Falha ao importar dados');
      }

      return response.json();
    },
    onSuccess: (data: ImportResult) => {
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      toast({
        title: "Importação concluída",
        description: data.message,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro na importação",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Validar tipo de arquivo
      const validTypes = [
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv'
      ];
      
      if (!validTypes.includes(file.type) && !file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
        toast({
          title: "Arquivo inválido",
          description: "Por favor, selecione um arquivo Excel (.xlsx, .xls) ou CSV (.csv)",
          variant: "destructive",
        });
        return;
      }

      setSelectedFile(file);
      setImportResult(null);
    }
  };

  const handleImport = () => {
    if (!selectedFile) {
      toast({
        title: "Nenhum arquivo selecionado",
        description: "Por favor, selecione um arquivo para importar",
        variant: "destructive",
      });
      return;
    }

    importMutation.mutate(selectedFile);
  };

  const handleClose = () => {
    setSelectedFile(null);
    setImportResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  const handleBrowseFiles = () => {
    fileInputRef.current?.click();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Importar Dados de Clientes via Excel
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Instruções */}
          <Card className="bg-blue-50 border-blue-200">
            <CardContent className="p-4">
              <h3 className="font-semibold text-blue-900 mb-2">Instruções de Importação</h3>
              <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                <li>A planilha deve conter as seguintes colunas: <strong>CPF OU CNPJ</strong>, <strong>LATITUDE</strong>, <strong>LONGITUDE</strong>, <strong>ROTA</strong>, <strong>PERIODICIDADE</strong></li>
                <li>O CPF/CNPJ será usado para identificar o cliente existente</li>
                <li>Os campos latitude, longitude, rota e periodicidade serão atualizados</li>
                <li>Periodicidade aceita: semanal, quinzenal, mensal ou bimestral</li>
                <li>Clientes não encontrados serão listados nos erros</li>
              </ul>
            </CardContent>
          </Card>

          {/* Upload de arquivo */}
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileSelect}
              className="hidden"
              data-testid="input-file-excel"
            />
            
            <div className="text-center">
              {selectedFile ? (
                <div className="space-y-2">
                  <FileSpreadsheet className="h-12 w-12 mx-auto text-green-600" />
                  <p className="text-sm font-medium text-gray-700">{selectedFile.name}</p>
                  <p className="text-xs text-gray-500">
                    {(selectedFile.size / 1024).toFixed(2)} KB
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBrowseFiles}
                    data-testid="button-change-file"
                  >
                    Escolher outro arquivo
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="h-12 w-12 mx-auto text-gray-400" />
                  <p className="text-sm text-gray-600">
                    Arraste um arquivo ou clique para selecionar
                  </p>
                  <Button
                    variant="outline"
                    onClick={handleBrowseFiles}
                    data-testid="button-select-file"
                  >
                    Selecionar Arquivo
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Resultado da importação */}
          {importResult && (
            <Card>
              <CardContent className="p-4">
                <h3 className="font-semibold mb-3">Resultado da Importação</h3>
                
                <div className="space-y-2 mb-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Total processado:</span>
                    <span className="font-medium">{importResult.totalProcessed}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Clientes atualizados:</span>
                    <span className="font-medium text-green-600 flex items-center gap-1">
                      <CheckCircle className="h-4 w-4" />
                      {importResult.updated}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Clientes não encontrados:</span>
                    <span className="font-medium text-orange-600 flex items-center gap-1">
                      <AlertCircle className="h-4 w-4" />
                      {importResult.notFound}
                    </span>
                  </div>
                </div>

                {importResult.errors.length > 0 && (
                  <div className="mt-4">
                    <h4 className="font-medium text-sm text-red-700 mb-2 flex items-center gap-1">
                      <XCircle className="h-4 w-4" />
                      Erros e avisos:
                    </h4>
                    <div className="bg-red-50 rounded p-3 max-h-48 overflow-y-auto">
                      <ul className="text-xs text-red-800 space-y-1">
                        {importResult.errors.map((error, index) => (
                          <li key={index}>• {error}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                {importResult.debugInfo && importResult.debugInfo.length > 0 && (
                  <div className="mt-4">
                    <h4 className="font-medium text-sm text-blue-700 mb-2">
                      🔍 Informações de Debug (primeiras 5 linhas):
                    </h4>
                    <div className="bg-blue-50 rounded p-3 max-h-96 overflow-y-auto">
                      {importResult.debugInfo.slice(0, 5).map((debug, index) => (
                        <div key={index} className="mb-4 pb-4 border-b border-blue-200 last:border-0">
                          <div className="text-xs text-blue-900 font-medium mb-2">
                            Linha {debug.row}: {debug.customer}
                          </div>
                          <div className="text-xs text-blue-800 space-y-1 pl-3">
                            <div><strong>Colunas disponíveis:</strong> {debug.availableColumns.join(', ')}</div>
                            <div><strong>LATITUDE lida:</strong> {debug.latitudeCol !== undefined ? `"${debug.latitudeCol}" (${debug.latitudeType})` : 'NÃO ENCONTRADA'}</div>
                            <div><strong>LONGITUDE lida:</strong> {debug.longitudeCol !== undefined ? `"${debug.longitudeCol}" (${debug.longitudeType})` : 'NÃO ENCONTRADA'}</div>
                            <div><strong>Dados para atualizar:</strong> {JSON.stringify(debug.updateData)}</div>
                            {debug.updateSuccess !== undefined && (
                              <div className={debug.updateSuccess ? 'text-green-700' : 'text-red-700'}>
                                <strong>Atualização:</strong> {debug.updateSuccess ? '✅ Sucesso' : `❌ Falhou - ${debug.reason || debug.updateError}`}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Botões de ação */}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={handleClose}
              data-testid="button-close-import"
            >
              Fechar
            </Button>
            <Button
              onClick={handleImport}
              disabled={!selectedFile || importMutation.isPending}
              className="bg-green-600 hover:bg-green-700"
              data-testid="button-execute-import"
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Importando...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Importar
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
