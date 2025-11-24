import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { MessageCircle, Send, Phone, Image } from 'lucide-react';

export default function WhatsAppMessenger() {
  const { toast } = useToast();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [recentMessages, setRecentMessages] = useState<any[]>([]);

  const formatPhoneNumber = (phone: string) => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11) {
      return `55${cleaned}`;
    }
    return cleaned.startsWith('55') ? cleaned : `55${cleaned}`;
  };

  const handleSendMessage = async () => {
    if (!phoneNumber.trim() || !message.trim()) {
      toast({
        title: 'Erro',
        description: 'Preencha o número e a mensagem',
        variant: 'destructive'
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch('/api/whatsapp/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: formatPhoneNumber(phoneNumber),
          text: message
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erro ao enviar mensagem');
      }

      const result = await response.json();
      
      toast({
        title: 'Sucesso',
        description: 'Mensagem enviada com sucesso via WhatsApp!',
      });

      setRecentMessages([
        { phone: phoneNumber, message, timestamp: new Date(), status: 'sent' },
        ...recentMessages.slice(0, 4)
      ]);

      setPhoneNumber('');
      setMessage('');
    } catch (error: any) {
      toast({
        title: 'Erro ao enviar',
        description: error.message || 'Falha ao enviar mensagem',
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2">
        <MessageCircle className="h-8 w-8 text-green-600" />
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Enviar Mensagens WhatsApp</h1>
          <p className="text-slate-600 mt-1">Comunique-se com clientes e motoristas via Evolution API</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nova Mensagem</CardTitle>
          <CardDescription>Envie mensagens de texto via WhatsApp</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Número de Telefone</label>
            <div className="flex gap-2">
              <span className="px-3 py-2 bg-gray-100 rounded-md text-sm font-semibold text-gray-600">+55</span>
              <Input
                placeholder="11 987654321"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={isLoading}
                data-testid="input-phone"
              />
            </div>
            <p className="text-xs text-gray-500">DDD + número (11 dígitos com DDD)</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Mensagem</label>
            <Textarea
              placeholder="Digite sua mensagem aqui..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={isLoading}
              rows={4}
              data-testid="textarea-message"
            />
            <p className="text-xs text-gray-500">{message.length}/1000 caracteres</p>
          </div>

          <Button
            onClick={handleSendMessage}
            disabled={isLoading || !phoneNumber.trim() || !message.trim()}
            className="w-full bg-green-600 hover:bg-green-700"
            size="lg"
            data-testid="button-send-message"
          >
            <Send className="h-4 w-4 mr-2" />
            {isLoading ? 'Enviando...' : 'Enviar via WhatsApp'}
          </Button>
        </CardContent>
      </Card>

      {recentMessages.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Mensagens Recentes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentMessages.map((msg, idx) => (
                <div key={idx} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="flex-1">
                    <p className="font-medium text-sm">+55 {msg.phone}</p>
                    <p className="text-sm text-gray-700 mt-1">{msg.message}</p>
                    <p className="text-xs text-gray-500 mt-2">
                      {msg.timestamp?.toLocaleTimeString('pt-BR')}
                    </p>
                  </div>
                  <span className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded">
                    ✓ Enviado
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="bg-blue-50 border-blue-200">
        <CardHeader>
          <CardTitle className="text-base">ℹ️ Dicas de Uso</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-blue-900 space-y-2">
          <p>• Insira números com DDD completo (exemplo: 11 987654321)</p>
          <p>• A Evolution API formata automaticamente para E.164</p>
          <p>• Verifique se a instância está conectada e ativa</p>
          <p>• Máximo de 1000 caracteres por mensagem</p>
        </CardContent>
      </Card>
    </div>
  );
}
