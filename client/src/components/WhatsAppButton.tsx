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
      console.log('📲 [WhatsAppButton] Iniciando conversa para:', phone, customerName);
      try {
        const response = await apiRequest('POST', '/api/chat/conversations/start', {
          customerPhone: phone,
          customerName: customerName
        });
        console.log('✅ [WhatsAppButton] Conversa criada:', response);
        return response;
      } catch (error) {
        console.error('❌ [WhatsAppButton] Erro ao criar conversa:', error);
        throw error;
      }
    },
    onSuccess: (data) => {
      console.log('🎉 [WhatsAppButton] Navegando para atendimento com conversa:', data.id);
      toast({
        title: "Sucesso",
        description: "Conversa iniciada! Redirecionando...",
      });
      setTimeout(() => {
        // 🎯 Navegar passando o ID da conversa como query param
        navigate(`/telemarketing/atendimento?conversationId=${data.id}`);
      }, 500);
    },
    onError: (error) => {
      console.error('⚠️ [WhatsAppButton] Erro na mutação:', error);
      toast({
        title: "Erro",
        description: error instanceof Error ? error.message : "Não foi possível criar a conversa",
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
