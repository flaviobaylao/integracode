import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function WhatsAppSimulator() {
  const [isOpen, setIsOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [message, setMessage] = useState("");
  const { toast } = useToast();

  const simulateMessageMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/webhook/whatsapp", {
        from: customerPhone,
        name: customerName,
        body: message,
      });
    },
    onSuccess: () => {
      setCustomerName("");
      setCustomerPhone("");
      setMessage("");
      setIsOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: "Mensagem simulada",
        description: "Nova conversa criada e distribuída automaticamente",
      });
    },
    onError: () => {
      toast({
        title: "Erro",
        description: "Não foi possível simular a mensagem",
        variant: "destructive",
      });
    },
  });

  const quickSimulations = [
    {
      name: "Cliente Urgente",
      phone: "+5511111111111",
      message: "Preciso cancelar meu pedido urgente!"
    },
    {
      name: "Novo Cliente",
      phone: "+5511222222222", 
      message: "Olá! Gostaria de saber sobre seus produtos"
    },
    {
      name: "Suporte Técnico",
      phone: "+5511333333333",
      message: "Meu produto apresentou defeito, preciso de ajuda"
    }
  ];

  const handleQuickSimulation = (simulation: typeof quickSimulations[0]) => {
    setCustomerName(simulation.name);
    setCustomerPhone(simulation.phone);
    setMessage(simulation.message);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customerName && customerPhone && message) {
      simulateMessageMutation.mutate();
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 p-4 bg-whatsapp-500 hover:bg-whatsapp-600 text-white rounded-full shadow-lg transition-colors z-50"
        title="Simular mensagem do WhatsApp"
      >
        <i className="fab fa-whatsapp text-2xl"></i>
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 w-96 bg-white rounded-lg shadow-xl border border-gray-200 z-50">
      <div className="p-4 bg-whatsapp-500 text-white rounded-t-lg flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <i className="fab fa-whatsapp text-xl"></i>
          <span className="font-semibold">Simular WhatsApp</span>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="text-white hover:text-gray-200 transition-colors"
        >
          <i className="fas fa-times"></i>
        </button>
      </div>

      <div className="p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Nome do Cliente
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-500 focus:border-transparent"
              placeholder="Ex: João Silva"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Telefone
            </label>
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-500 focus:border-transparent"
              placeholder="Ex: +5511999999999"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Mensagem
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-500 focus:border-transparent resize-none"
              rows={3}
              placeholder="Digite a mensagem do cliente..."
              required
            />
          </div>

          <div className="flex space-x-2">
            <button
              type="submit"
              disabled={simulateMessageMutation.isPending}
              className="flex-1 bg-whatsapp-500 hover:bg-whatsapp-600 text-white py-2 px-4 rounded-lg transition-colors disabled:opacity-50"
            >
              {simulateMessageMutation.isPending ? "Enviando..." : "Simular"}
            </button>
          </div>
        </form>

        <div className="mt-4 pt-4 border-t border-gray-200">
          <p className="text-sm font-medium text-gray-700 mb-2">Simulações Rápidas:</p>
          <div className="space-y-2">
            {quickSimulations.map((simulation, index) => (
              <button
                key={index}
                onClick={() => handleQuickSimulation(simulation)}
                className="w-full text-left p-2 bg-gray-50 hover:bg-gray-100 rounded text-sm transition-colors"
              >
                <div className="font-medium">{simulation.name}</div>
                <div className="text-gray-600 truncate">{simulation.message}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}