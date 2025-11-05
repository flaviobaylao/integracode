import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertRouteSchema, type Route, type InsertRoute } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Plus, Edit, Trash2, MapPin } from "lucide-react";
import { z } from "zod";

const weekdayOptions = [
  { value: "Seg", label: "Segunda" },
  { value: "Ter", label: "Terça" },
  { value: "Qua", label: "Quarta" },
  { value: "Qui", label: "Quinta" },
  { value: "Sex", label: "Sexta" },
  { value: "Sab", label: "Sábado" },
  { value: "Dom", label: "Domingo" },
];

export function RouteManagement() {
  const { toast } = useToast();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<Route | null>(null);

  const { data: routes = [], isLoading } = useQuery<Route[]>({
    queryKey: ["/api/routes"],
  });

  const form = useForm<InsertRoute>({
    resolver: zodResolver(
      insertRouteSchema.extend({
        weekdays: z.string().refine(
          (val) => {
            try {
              const parsed = JSON.parse(val);
              return Array.isArray(parsed) && parsed.length > 0;
            } catch {
              return false;
            }
          },
          { message: "Selecione pelo menos um dia da semana" }
        ),
      })
    ),
    defaultValues: {
      name: "",
      weekdays: "[]",
      sellerId: null,
      isActive: true,
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: InsertRoute) => apiRequest("/api/routes", "POST", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
      toast({ title: "Rota criada com sucesso!" });
      setIsModalOpen(false);
      form.reset();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao criar rota",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<InsertRoute> }) =>
      apiRequest(`/api/routes/${id}`, "PUT", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
      toast({ title: "Rota atualizada com sucesso!" });
      setIsModalOpen(false);
      setEditingRoute(null);
      form.reset();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao atualizar rota",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/routes/${id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
      toast({ title: "Rota removida com sucesso!" });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao remover rota",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleOpenModal = (route?: Route) => {
    if (route) {
      setEditingRoute(route);
      form.reset({
        name: route.name,
        weekdays: route.weekdays,
        sellerId: route.sellerId,
        isActive: route.isActive,
      });
    } else {
      setEditingRoute(null);
      form.reset({
        name: "",
        weekdays: "[]",
        sellerId: null,
        isActive: true,
      });
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingRoute(null);
    form.reset();
  };

  const onSubmit = (data: InsertRoute) => {
    if (editingRoute) {
      updateMutation.mutate({ id: editingRoute.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleWeekdayToggle = (weekday: string) => {
    const currentWeekdays = JSON.parse(form.getValues("weekdays") || "[]");
    const newWeekdays = currentWeekdays.includes(weekday)
      ? currentWeekdays.filter((w: string) => w !== weekday)
      : [...currentWeekdays, weekday];
    form.setValue("weekdays", JSON.stringify(newWeekdays));
  };

  const getWeekdayLabels = (weekdaysJson: string) => {
    try {
      const weekdays = JSON.parse(weekdaysJson);
      return weekdays
        .map((day: string) => weekdayOptions.find((opt) => opt.value === day)?.label)
        .filter(Boolean)
        .join(", ");
    } catch {
      return "";
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Gerenciamento de Rotas
          </CardTitle>
          <Button onClick={() => handleOpenModal()} data-testid="button-create-route">
            <Plus className="h-4 w-4 mr-2" />
            Nova Rota
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8">Carregando rotas...</div>
          ) : routes.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nenhuma rota cadastrada. Clique em "Nova Rota" para criar.
            </div>
          ) : (
            <div className="space-y-2">
              {routes.map((route) => (
                <div
                  key={route.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                  data-testid={`route-item-${route.id}`}
                >
                  <div className="flex-1">
                    <h3 className="font-medium" data-testid={`route-name-${route.id}`}>
                      {route.name}
                    </h3>
                    <p className="text-sm text-muted-foreground" data-testid={`route-weekdays-${route.id}`}>
                      Dias: {getWeekdayLabels(route.weekdays)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenModal(route)}
                      data-testid={`button-edit-route-${route.id}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        if (confirm("Tem certeza que deseja remover esta rota?")) {
                          deleteMutation.mutate(route.id);
                        }
                      }}
                      data-testid={`button-delete-route-${route.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isModalOpen} onOpenChange={handleCloseModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingRoute ? "Editar Rota" : "Nova Rota"}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nome da Rota *</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="Ex: Centro, Zona Norte, etc."
                        data-testid="input-route-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="weekdays"
                render={() => (
                  <FormItem>
                    <FormLabel>Dias da Semana *</FormLabel>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {weekdayOptions.map((option) => {
                        const isSelected = JSON.parse(
                          form.getValues("weekdays") || "[]"
                        ).includes(option.value);
                        return (
                          <Button
                            key={option.value}
                            type="button"
                            variant={isSelected ? "default" : "outline"}
                            size="sm"
                            onClick={() => handleWeekdayToggle(option.value)}
                            className={
                              isSelected ? "bg-honest-blue hover:bg-honest-blue/90" : ""
                            }
                            data-testid={`button-weekday-${option.value}`}
                          >
                            {option.label}
                          </Button>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCloseModal}
                  data-testid="button-cancel-route"
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="button-submit-route"
                >
                  {editingRoute ? "Atualizar" : "Criar"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
