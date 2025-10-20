import { useMutation } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { SalesCardWithRelations } from "@shared/schema";
import { Loader2, AlertTriangle } from "lucide-react";

interface CustomerInactivateModalProps {
  isOpen: boolean;
  onClose: () => void;
  card: SalesCardWithRelations | null;
}

export default function CustomerInactivateModal({
  isOpen,
  onClose,
  card,
}: CustomerInactivateModalProps) {
  const { toast } = useToast();

  const inactivateCustomerMutation = useMutation({
    mutationFn: async () => {
      if (!card?.customer.id || !card?.id) {
        throw new Error("Dados inválidos");
      }
      return await apiRequest("POST", `/api/customers/${card.customer.id}/inactivate`, {
        cardId: card.id
      });
    },
    onSuccess: (data: any) => {
      toast({
        title: "Cliente inativado com sucesso!",
        description: `${data.deletedCards || 0} card(s) futuro(s) foram removidos.`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      onClose();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao inativar cliente",
        description: error.message || "Ocorreu um erro ao inativar o cliente",
        variant: "destructive",
      });
    },
  });

  const handleConfirm = () => {
    inactivateCustomerMutation.mutate();
  };

  const customerName = card?.customer.fantasyName || card?.customer.name || "este cliente";

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center space-x-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <span>Confirmar Inativação de Cliente</span>
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3 pt-2">
            <p className="font-semibold">
              Você tem certeza que deseja inativar o cliente <span className="text-foreground">{customerName}</span>?
            </p>
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3 space-y-2 text-sm">
              <p className="font-semibold text-red-800 dark:text-red-400">⚠️ Esta ação terá os seguintes efeitos:</p>
              <ul className="list-disc list-inside space-y-1 text-red-700 dark:text-red-300">
                <li>O cliente será marcado como inativo</li>
                <li>Todos os cards futuros deste cliente serão apagados</li>
                <li>O cliente não aparecerá mais em rotas e agendas futuras</li>
                <li>O card atual será mantido como último registro</li>
              </ul>
            </div>
            <p className="text-sm text-muted-foreground">
              Esta ação não pode ser desfeita facilmente. Tem certeza que deseja continuar?
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={inactivateCustomerMutation.isPending}
            data-testid="button-cancel-inactivate"
          >
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={inactivateCustomerMutation.isPending}
            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            data-testid="button-confirm-inactivate"
          >
            {inactivateCustomerMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Sim, Inativar Cliente
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
