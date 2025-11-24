import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Send } from 'lucide-react';

interface WhatsAppMessageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerPhone: string;
  customerName: string;
  customerId?: string;
}

export function WhatsAppMessageModal({
  open,
  onOpenChange,
  customerPhone,
  customerName,
  customerId
}: WhatsAppMessageModalProps) {
  const { toast } = useToast();
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSend = async () => {
    if (!message.trim()) {
      toast({ title: 'Erro', description: 'Digite uma mensagem', variant: 'destructive' });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch('/api/whatsapp/send-with-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: customerPhone,
          text: message,
          customerId,
          recipientName: customerName
        })
      });

      if (!response.ok) throw new Error('Erro ao enviar');

      toast({
        title: 'Sucesso',
        description: `Mensagem enviada para ${customerName} ✓`
      });

      setMessage('');
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: 'Erro',
        description: error.message,
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enviar WhatsApp</DialogTitle>
          <DialogDescription>Para {customerName}</DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          <div>
            <p className="text-xs text-gray-500">Telefone: {customerPhone}</p>
          </div>
          
          <Textarea
            placeholder="Digite sua mensagem..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={isLoading}
            rows={3}
            data-testid="textarea-whatsapp-message"
          />
          
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleSend}
              disabled={isLoading || !message.trim()}
              className="bg-green-600 hover:bg-green-700"
              data-testid="button-send-whatsapp"
            >
              <Send className="h-4 w-4 mr-2" />
              {isLoading ? 'Enviando...' : 'Enviar'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
