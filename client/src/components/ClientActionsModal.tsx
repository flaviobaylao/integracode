import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MessageCircle, FileText, ShoppingCart, History, Pencil, UserX, Loader2 } from "lucide-react";
import VirtualServiceLogModal from "@/components/VirtualServiceLogModal";
import CustomerEditModal from "@/components/CustomerEditModal";
import ActionHistoryModal from "@/components/ActionHistoryModal";

/**
 * Caixa "Ações do Cliente" COMPARTILHADA e autossuficiente — aberta ao clicar no
 * nome do cliente em várias telas (Gestão de Carteiras, Agenda da Carteira, Mapa,
 * Inbox). Traz todos os botões:
 *   • Abrir no Chat Center (WhatsApp)
 *   • Registrar Atendimento (Virtual/Presencial)
 *   • Efetuar Pedido / Abrir Card de Vendas  → leva para Clientes Ativos
 *   • Ver Histórico do Último Pedido          → leva para Clientes Ativos
 *   • Histórico de Ações do Cliente           → registros do Inbox (50 últimos)
 *   • Editar Cliente
 *   • Inativar Cliente (só admin)
 * NÃO tem "Editar Telefone" (feito dentro de Editar Cliente).
 * As alterações de cadastro continuam registradas no "relógio" ao lado do nome.
 */
export default function ClientActionsModal({
  open,
  onClose,
  customerId,
  customerName,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string | null;
  customerName?: string | null;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === "admin";

  const [showServiceLog, setShowServiceLog] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [inativando, setInativando] = useState(false);

  // Carrega o cadastro (telefone + dados para Editar Cliente) só quando a caixa abre.
  const { data: customer } = useQuery<any>({
    queryKey: ["/api/customers", customerId],
    enabled: open && !!customerId,
    staleTime: 60 * 1000,
  });

  const nome = customerName || customer?.fantasyName || customer?.name || "Cliente";
  const phone: string = customer?.phone || "";

  const abrirChat = () => {
    const digits = String(phone).replace(/\D/g, "");
    if (!digits) return;
    const normalized = digits.startsWith("55") ? digits : `55${digits}`;
    window.location.href = `/telemarketing/atendimento?phone=${normalized}`;
  };

  // Pedido / Último pedido: levam para Clientes Ativos, que já tem o fluxo completo
  // (abre o card / o último pedido pelo id do cliente ao ler o parâmetro na URL).
  const irParaPedido = () => {
    if (!customerId) return;
    window.location.href = `/clientes-ativos?acaoCliente=pedido&clienteId=${encodeURIComponent(customerId)}`;
  };
  const irParaUltimoPedido = () => {
    if (!customerId) return;
    window.location.href = `/clientes-ativos?acaoCliente=ultimo&clienteId=${encodeURIComponent(customerId)}`;
  };

  const inativar = async () => {
    if (!customerId) return;
    if (!window.confirm(`Inativar o cliente ${nome}?\n\nEle sai da lista de Clientes Ativos e passa a "Inativo" na Gestão de Clientes.`)) return;
    setInativando(true);
    try {
      await apiRequest("POST", "/api/customers/bulk-inactivate", { ids: [customerId] });
      toast({ title: "Cliente inativado!", description: "Removido dos Clientes Ativos e marcado como Inativo." });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/map-data"] });
      onClose();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao inativar cliente." });
    } finally {
      setInativando(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ações do Cliente</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 py-2">
            <div className="text-center mb-2">
              <p className="font-semibold text-lg">{nome}</p>
              <p className="text-sm text-muted-foreground">Selecione a ação desejada para este cliente</p>
            </div>

            {phone && (
              <Button
                variant="outline"
                className="w-full justify-start h-12 text-green-600 hover:text-green-700 hover:bg-green-50"
                onClick={abrirChat}
                data-testid="action-whatsapp"
              >
                <MessageCircle className="h-5 w-5 mr-3" />
                Abrir no Chat Center (WhatsApp)
              </Button>
            )}

            <Button
              variant="outline"
              className="w-full justify-start h-12 text-honest-blue hover:bg-blue-50"
              onClick={() => setShowServiceLog(true)}
              data-testid="action-registrar-atendimento"
            >
              <FileText className="h-5 w-5 mr-3" />
              Registrar Atendimento (Virtual/Presencial)
            </Button>

            <Button
              variant="outline"
              className="w-full justify-start h-12 text-orange-600 hover:bg-orange-50"
              onClick={irParaPedido}
              data-testid="action-pedido"
            >
              <ShoppingCart className="h-5 w-5 mr-3" />
              Efetuar Pedido / Abrir Card de Vendas
            </Button>

            <Button
              variant="outline"
              className="w-full justify-start h-12 text-purple-600 hover:bg-purple-50"
              onClick={irParaUltimoPedido}
              data-testid="action-ultimo-pedido"
            >
              <ShoppingCart className="h-5 w-5 mr-3" />
              Ver Histórico do Último Pedido
            </Button>

            <Button
              variant="outline"
              className="w-full justify-start h-12 text-slate-700 dark:text-slate-200 hover:bg-slate-50"
              onClick={() => setShowHistory(true)}
              data-testid="action-historico-acoes"
            >
              <History className="h-5 w-5 mr-3" />
              Histórico de Ações do Cliente
            </Button>

            <div className="grid grid-cols-1 gap-2 mt-1">
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => setShowEdit(true)}
                data-testid="action-editar-cliente"
              >
                <Pencil className="h-4 w-4 mr-2" />
                Editar Cliente
              </Button>

              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-500 justify-start"
                  onClick={inativar}
                  disabled={inativando}
                  data-testid="action-inativar"
                >
                  {inativando ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserX className="h-4 w-4 mr-2" />}
                  Inativar Cliente
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {customerId && (
        <VirtualServiceLogModal
          open={showServiceLog}
          onClose={() => setShowServiceLog(false)}
          customerId={customerId}
          customerName={nome}
          onSuccess={() => setShowServiceLog(false)}
        />
      )}

      {showEdit && customer && (
        <CustomerEditModal
          isOpen={showEdit}
          onClose={() => { setShowEdit(false); queryClient.invalidateQueries({ queryKey: ["/api/customers", customerId] }); }}
          customer={customer}
        />
      )}

      <ActionHistoryModal
        open={showHistory}
        onClose={() => setShowHistory(false)}
        customerId={customerId}
        customerName={nome}
      />
    </>
  );
}
