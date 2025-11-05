import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar, Filter, X } from 'lucide-react';

interface SalesCardFiltersProps {
  routeDay: string;
  status: string;
  onRouteChange: (route: string) => void;
  onStatusChange: (status: string) => void;
  onClearFilters: () => void;
}

export default function SalesCardFilters({ 
  routeDay, 
  status, 
  onRouteChange, 
  onStatusChange, 
  onClearFilters 
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
    { value: 'pending', label: 'Pendente' },
    { value: 'completed', label: 'Finalizado' },
    { value: 'telemarketing', label: 'Telemarketing' },
    { value: 'transferred', label: 'Transferido' },
    { value: 'invoiced', label: 'Faturado' },
    { value: 'cancelled', label: 'Cancelado' }
  ];

  const hasActiveFilters = (routeDay && routeDay !== 'all') || (status && status !== 'all');

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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
        </div>
      )}
    </div>
  );
}