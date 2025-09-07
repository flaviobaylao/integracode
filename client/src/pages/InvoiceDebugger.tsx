import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, FileText, AlertCircle } from "lucide-react";
import { useState } from "react";

interface InvoiceData {
  [key: string]: any;
}

export default function InvoiceDebugger() {
  const [invoiceNumber, setInvoiceNumber] = useState('');
  
  const { data: invoiceData, isLoading, error, refetch } = useQuery<InvoiceData>({
    queryKey: ['/api/omie/debug-invoice', invoiceNumber],
    enabled: !!invoiceNumber && invoiceNumber.length > 0,
    retry: false,
  });

  const flattenObject = (obj: any, prefix: string = ''): Array<{line: number, field: string, value: any, type: string}> => {
    const result: Array<{line: number, field: string, value: any, type: string}> = [];
    let lineNumber = 1;

    const flatten = (item: any, path: string) => {
      if (item === null || item === undefined) {
        result.push({
          line: lineNumber++,
          field: path,
          value: item,
          type: typeof item
        });
      } else if (Array.isArray(item)) {
        if (item.length === 0) {
          result.push({
            line: lineNumber++,
            field: path,
            value: '[]',
            type: 'array (empty)'
          });
        } else {
          item.forEach((subItem, index) => {
            flatten(subItem, `${path}[${index}]`);
          });
        }
      } else if (typeof item === 'object') {
        Object.keys(item).forEach(key => {
          const newPath = path ? `${path}.${key}` : key;
          flatten(item[key], newPath);
        });
      } else {
        result.push({
          line: lineNumber++,
          field: path,
          value: item,
          type: typeof item
        });
      }
    };

    flatten(obj, prefix);
    return result;
  };

  const formatValue = (value: any, type: string) => {
    if (value === null) return <span className="text-gray-400">null</span>;
    if (value === undefined) return <span className="text-gray-400">undefined</span>;
    if (value === '') return <span className="text-gray-400">""</span>;
    if (type === 'string') return <span className="text-green-600">"{String(value)}"</span>;
    if (type === 'number') return <span className="text-blue-600">{value}</span>;
    if (type === 'boolean') return <span className="text-purple-600">{String(value)}</span>;
    if (value === '[]') return <span className="text-gray-400">{value}</span>;
    return String(value);
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'string': return 'bg-green-100 text-green-800';
      case 'number': return 'bg-blue-100 text-blue-800';
      case 'boolean': return 'bg-purple-100 text-purple-800';
      case 'object': return 'bg-orange-100 text-orange-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-center space-x-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Buscando dados da NF {invoiceNumber}...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-center space-x-2 text-red-600">
              <AlertCircle className="h-4 w-4" />
              <span>Erro ao buscar NF {invoiceNumber}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const flatData = invoiceData ? flattenObject(invoiceData) : [];
  const dateFields = flatData.filter(item => 
    item.field.toLowerCase().includes('data') || 
    item.field.toLowerCase().includes('date') || 
    item.field.includes('dEmi') || 
    item.field.includes('dSaiEnt') || 
    item.field.includes('dhEmi') || 
    item.field.includes('dDtEmissao') || 
    item.field.includes('dReg') || 
    item.field.includes('dInc') || 
    item.field.includes('dAlt')
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Debug NF {invoiceNumber}</h1>
          <p className="text-gray-600">Análise detalhada dos dados importáveis da Nota Fiscal</p>
        </div>
        <Button
          onClick={() => refetch()}
          variant="outline"
          data-testid="button-refresh-debug"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Atualizar
        </Button>
      </div>

      {/* Summary */}
      {invoiceData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total de Campos</p>
                  <h3 className="text-2xl font-bold text-gray-800">{flatData.length}</h3>
                </div>
                <FileText className="h-8 w-8 text-honest-blue" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Campos de Data</p>
                  <h3 className="text-2xl font-bold text-green-600">{dateFields.length}</h3>
                </div>
                <div className="h-8 w-8 bg-green-100 rounded-full flex items-center justify-center">
                  <i className="fas fa-calendar text-green-600"></i>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">NF Número</p>
                  <h3 className="text-2xl font-bold text-honest-blue">{invoiceNumber}</h3>
                </div>
                <div className="h-8 w-8 bg-blue-100 rounded-full flex items-center justify-center">
                  <i className="fas fa-file-invoice text-honest-blue"></i>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Campos de Data em Destaque */}
      {dateFields.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <i className="fas fa-calendar text-green-600"></i>
              Campos de Data Identificados
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Linha</TableHead>
                  <TableHead>Campo</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Tipo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dateFields.map((item) => (
                  <TableRow key={item.line} className="bg-green-50">
                    <TableCell className="font-mono text-sm">
                      <Badge variant="outline">{item.line}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-green-700">
                      {item.field}
                    </TableCell>
                    <TableCell>{formatValue(item.value, item.type)}</TableCell>
                    <TableCell>
                      <Badge className={getTypeColor(item.type)}>{item.type}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Todos os Campos */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Todos os Dados Importáveis - NF {invoiceNumber}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!invoiceData ? (
            <div className="text-center py-10">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500">Nenhum dado encontrado para NF {invoiceNumber}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Linha</TableHead>
                  <TableHead className="w-1/3">Campo</TableHead>
                  <TableHead className="w-1/3">Valor</TableHead>
                  <TableHead className="w-24">Tipo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flatData.map((item) => (
                  <TableRow key={item.line} data-testid={`row-field-${item.line}`}>
                    <TableCell className="font-mono text-sm">
                      <Badge variant="outline">{item.line}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm break-all">
                      {item.field}
                    </TableCell>
                    <TableCell className="break-all">
                      {formatValue(item.value, item.type)}
                    </TableCell>
                    <TableCell>
                      <Badge className={getTypeColor(item.type)}>{item.type}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}