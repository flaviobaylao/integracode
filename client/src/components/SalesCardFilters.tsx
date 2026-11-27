import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar, Filter, X, User } from 'lucide-react';
import { Input } from '@/components/ui/input';

interface SalesCardFiltersProps {
  routeDay: string;
  status: string;
  onRouteChange: (route: string) => void;
  onStatusChange: (status: string) => void;
  onClearFilters: () => void;
  // (27/nov/2026) Horizonte de datas (data do card, YYYY-MM-DD) — para todos os perfis.
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  // (27/nov/2026) Vendedor — so' admins veem (a lista vem dos cards carregados).
  sellerId?: string;
  sellerOptions?: Array<{ id: string; name: string }>;
  onSellerChange?: (id: string) => void;
  showSellerFilter?: boolean;
}

export default function SalesCardFilters({ 
  routeDay, 
  status, 
  onRouteChange, 
  onStatusChange, 
  onClearFilters,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  sellerId = 'all',
  sellerOptions = [],
  onSellerChange,
  showSellerFilter = false,
}: SalesCardFiltersProps) {
  
  const routeOptions = [
    { value: 'all', label: 'Todas as Rotas' },
    { value: 'Seg', label: 'Segunda-feira' },
    { value: 'Ter', label: 'Terça-feira' },
    { value: 'Qua', label: 'Quarta-feira' },
    { value: 'Qui', label: 'Quinta-feira' },
    { value: 'Sex', label: 'Sexta-feira' },
    { value: 'Sab', label: 'Sábado' },
    { value: 'Dom', label: 'Domingo' }
  ];

  const statusOptions = [
    { value: 'all', label: 'Todos os Status' },
    { value: 'draft', label: 'Rascunho' },
    { value: 'pending', label: 'Pendente' },
    { value: 'completed', label: 'Finalizado' },
    { value: 'telemarketing', label: 'Telemarketing' },
    { value: 'transferred', label: 'Transferido' },
    { value: 'invoiced', label: 'Faturado' },
    { value: 'cancelled', label: 'Cancelado' }
  ];

  const hasActiveFilters = (routeDay && routeDay !== 'all') || (status && status !== 'all')
    || !!dateFrom || !!dateTo || (showSellerFilter && sellerId && sellerId !== 'all');
  const fmtBR = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };
  const sellerLabel = (id: string) => sellerOptions.find(s => s.id === id)?.name || id;

  const getRouteLabel = (route: string) => {
    return routeOptions.find(r => r.value === route)?.label || route;
  };

  const getStatusLabel = (stat: string) => {
    return statusOptions.find(s => s.value === stat)?.label || stat;
  };

  return (
    <div className="bg-white p-4 rounded-lg border shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-gray-500" />
        <h3 className="font-medium text-gray-900">Filtros</h3>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearFilters}
            className="ml-auto text-gray-500 hover:text-gray-700"
          >
            <X className="h-4 w-4 mr-1" />
            Limpar
          </Button>
        )}
      </div>

      <div className={`grid grid-cols-1 md:grid-cols-2 ${showSellerFilter ? 'xl:grid-cols-4' : 'xl:grid-cols-3'} gap-4`}>
        {/* Filtro de Rota */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Rota (Dia da Semana)
          </label>
          <Select value={routeDay} onValueChange={onRouteChange}>
            <SelectTrigger>
              <SelectValue placeholder="Selecionar rota" />
            </SelectTrigger>
            <SelectContent>
              {routeOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Filtro de Status */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">
            Status do Card
          </label>
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger>
              <SelectValue placeholder="Selecionar status" />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Horizonte de datas (data do card) — todos os perfis */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Período (data do card)
          </label>
          <div className="flex items-center gap-2">
            <Input type="date" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)} aria-label="De" data-testid="filter-date-from" className="min-w-0" />
            <span className="text-xs text-gray-500">até</span>
            <Input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => onDateToChange(e.target.value)} aria-label="Até" data-testid="filter-date-to" className="min-w-0" />
          </div>
        </div>

        {/* Vendedor — so' admins */}
        {showSellerFilter && onSellerChange && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
              <User className="h-4 w-4" />
              Vendedor
            </label>
            <Select value={sellerId} onValueChange={onSellerChange}>
              <SelectTrigger data-testid="filter-seller">
                <SelectValue placeholder="Todos os vendedores" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os vendedores</SelectItem>
                {sellerOptions.map(o => (
                  <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Filtros Ativos */}
      {hasActiveFilters && (
        <div className="flex flex-wrap gap-2 pt-2 border-t">
          <span className="text-sm text-gray-600">Filtros ativos:</span>
          {routeDay && routeDay !== 'all' && (
            <Badge variant="secondary" className="flex items-center gap-1">
              {getRouteLabel(routeDay)}
              <button
                onClick={() => onRouteChange('all')}
                className="ml-1 hover:bg-gray-300 rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {status && status !== 'all' && (
            <Badge variant="secondary" className="flex items-center gap-1">
              {getStatusLabel(status)}
              <button
                onClick={() => onStatusChange('all')}
                className="ml-1 hover:bg-gray-300 rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {(dateFrom || dateTo) && (
            <Badge variant="secondary" className="flex items-center gap-1">
              {dateFrom && dateTo ? `${fmtBR(dateFrom)} a ${fmtBR(dateTo)}` : dateFrom ? `a partir de ${fmtBR(dateFrom)}` : `até ${fmtBR(dateTo)}`}
              <button
                onClick={() => { onDateFromChange(''); onDateToChange(''); }}
                className="ml-1 hover:bg-gray-300 rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {showSellerFilter && sellerId && sellerId !== 'all' && onSellerChange && (
            <Badge variant="secondary" className="flex items-center gap-1">
              {sellerLabel(sellerId)}
              <button
                onClick={() => onSellerChange('all')}
                className="ml-1 hover:bg-gray-300 rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
