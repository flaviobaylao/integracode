import { Button } from "@/components/ui/button";
import { MessageCircle } from "lucide-react";

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
  if (!phone) return null;

  // Abre a conversa do cliente na Central de Atendimento em uma NOVA GUIA.
  // Usa uma aba nomeada (reutilizada em cliques seguintes) e é chamado de forma
  // SÍNCRONA no clique para não ser bloqueado por bloqueador de pop-up.
  // A própria Central (ChatCenter) localiza/cria a conversa pelo telefone
  // (POST /api/chat/conversations/by-phone/:phone).
  const openCentral = () => {
    const digits = String(phone || "").replace(/\D/g, "");
    window.open(
      digits
        ? `/telemarketing/atendimento?phone=${digits}`
        : `/telemarketing/atendimento`,
      "honest-central-atendimento"
    );
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={openCentral}
      className={className}
      title={`Abrir conversa com ${customerName} na Central de Atendimento`}
      data-testid={`button-whatsapp-${phone.replace(/\D/g, "")}`}
    >
      <MessageCircle className="h-4 w-4 mr-1" />
      WhatsApp
    </Button>
  );
}
