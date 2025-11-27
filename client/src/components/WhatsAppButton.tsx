import { Button } from "@/components/ui/button";
import { MessageCircle } from "lucide-react";
import { useMutation } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";

interface WhatsAppButtonProps {
  phone: string;
  customerName: string;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "outline" | "ghost";
  className?: string;
}

export default function WhatsAppButton({
  phone,
  customerName,
  size = "sm",
  variant = "outline",
  className = ""
}: WhatsAppButtonProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const createConversationMutation = useMutation({
    mutationFn: async () => {
      return apiRequest('/api/chat/conversations', 'POST', {
        customerPhone: phone,
        customerName: customerName
      });
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Conversa iniciada! Redirecionando...",
      });
      setTimeout(() => {
        navigate('/telemarketing/atendimento');
      }, 500);
    },
    onError: () => {
      toast({
        title: "Erro",
        description: "Não foi possível criar a conversa",
        variant: "destructive",
      });
    }
  });

  if (!phone) return null;

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => createConversationMutation.mutate()}
      disabled={createConversationMutation.isPending}
      className={className}
      title={`Enviar mensagem via WhatsApp para ${customerName}`}
      data-testid={`button-whatsapp-${phone.replace(/\D/g, '')}`}
    >
      <MessageCircle className="h-4 w-4 mr-1" />
      {createConversationMutation.isPending ? "Iniciando..." : "WhatsApp"}
    </Button>
  );
}
