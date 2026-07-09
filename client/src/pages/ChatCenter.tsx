import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useRef, Component } from "react";
import { nowBrazil } from '@/lib/brazilTimezone';
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { Send, Clock, AlertCircle, CheckCircle, Phone, Plus, Paperclip, Image as ImageIcon, Music, File, User, MapPin, Sparkles, Loader2, RefreshCw, BookOpen, UserPlus, Bot, Users, ArrowRightLeft, BarChart2, Calendar, Archive } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PhonebookPanel } from "@/components/PhonebookPanel";
import { TemplatesPanel } from "@/components/TemplatesPanel";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useAuth } from "@/hooks/useAuth";

function getMediaUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/objects/') || url.startsWith('/uploads/') || url.startsWith('/api/')) {
    return `${window.location.origin}${url}`;
  }
  return url;
}

interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: "customer" | "agent" | "system";
  content: string;
  messageType: string;
  mediaUrl?: string;
  metadata?: {
    mediaType?: string;
    mediaFilename?: string;
    mediaSize?: number;
  };
  createdAt: Date | string;
  isRead: boolean;
}

interface Conversation {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerLinked?: boolean;
  channelPhone?: string | null;
  agentId?: string;
  agentName?: string;
  assignedAgentId?: string;
  assignedAgentName?: string;
  assignedAgentColor?: string;
  lastAttendedAt?: string;
  status: "new" | "assigned" | "in-progress" | "resolved";
  priority: "normal" | "urgent";
  lastMessageTime: string;
  messageCount: number;
  unreadCount?: number;
  hasUnread?: boolean;
  messages?: ChatMessage[];
  createdAt?: string;
}

interface Agent {
  id: string;
  name: string;
  status: string;
}

interface VirtualAttendanceStat {
  agentId: string;
  agentName: string;
  serviceDate: string;
  conversationCount: number;
}

// Componente para painel de estatísticas de atendimentos virtuais
function VirtualAttendancePanel() {
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>(() => {
    const now = nowBrazil();
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return {
      start: start.toISOString().split('T')[0],
      end: now.toISOString().split('T')[0]
    };
  });

  const { data, isLoading, refetch } = useQuery<{ summaries: VirtualAttendanceStat[] }>({
    queryKey: ['/api/chat/virtual-attendance', dateRange.start, dateRange.end],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: dateRange.start,
        endDate: dateRange.end
      });
      const res = await fetch(`/api/chat/virtual-attendance?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Erro ao buscar estatísticas');
      return res.json();
    }
  });

  const summaries = data?.summaries || [];

  // Agrupar por agente para totais
  const agentTotals = summaries.reduce((acc, stat) => {
    if (!acc[stat.agentId]) {
      acc[stat.agentId] = { agentName: stat.agentName, total: 0 };
    }
    acc[stat.agentId].total += stat.conversationCount;
    return acc;
  }, {} as Record<string, { agentName: string; total: number }>);

  // Agrupar por data para totais diários
  const dailyTotals = summaries.reduce((acc, stat) => {
    if (!acc[stat.serviceDate]) {
      acc[stat.serviceDate] = 0;
    }
    acc[stat.serviceDate] += stat.conversationCount;
    return acc;
  }, {} as Record<string, number>);

  const totalGeral = summaries.reduce((sum, stat) => sum + stat.conversationCount, 0);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-500" />
          <Input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
            className="h-8 text-xs w-36"
          />
          <span className="text-gray-500">até</span>
          <Input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
            className="h-8 text-xs w-36"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} className="h-8">
          <RefreshCw className="w-3 h-3 mr-1" />
          Atualizar
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : summaries.length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">
          Nenhum atendimento encontrado no período selecionado
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {/* Resumo por Agente */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Resumo por Atendente</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(agentTotals).map(([agentId, { agentName, total }]) => (
                <div key={agentId} className="bg-green-50 border border-green-200 rounded-lg p-3">
                  <p className="text-xs text-gray-600 truncate">{agentName}</p>
                  <p className="text-lg font-bold text-green-700">{total}</p>
                  <p className="text-[10px] text-gray-500">atendimentos</p>
                </div>
              ))}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-gray-600">Total Geral</p>
                <p className="text-lg font-bold text-blue-700">{totalGeral}</p>
                <p className="text-[10px] text-gray-500">atendimentos</p>
              </div>
            </div>
          </div>

          {/* Tabela Detalhada */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Detalhamento por Data</h3>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="text-left p-2 font-medium">Data</th>
                    <th className="text-left p-2 font-medium">Atendente</th>
                    <th className="text-right p-2 font-medium">Conversas</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((stat, idx) => (
                    <tr key={`${stat.agentId}-${stat.serviceDate}-${idx}`} className="border-t hover:bg-gray-50">
                      <td className="p-2">
                        {format(new Date(stat.serviceDate + 'T12:00:00'), 'dd/MM/yyyy', { locale: ptBR })}
                      </td>
                      <td className="p-2">{stat.agentName}</td>
                      <td className="p-2 text-right font-semibold">{stat.conversationCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// Componente Auxiliar para Item de Conversa
function ConversationItem({ conv, selectedConversation, setSelectedConversation, getStatusColor, formatLastMessageTime, onAddToPhonebook, setPhonebookData, isAdmin, labelObjsFor }: any) {
  const convLabelObjs = (labelObjsFor ? labelObjsFor(conv.id) : []) as any[];
  return (
    <div
      className={`w-full text-left p-3 rounded-lg transition-colors relative ${
        selectedConversation === conv.id
          ? "bg-green-100 border-2 border-green-600 shadow-sm"
          : "bg-gray-50 hover:bg-gray-100 border border-gray-200"
      }`}
      data-testid={`conversation-item-${conv.id}`}
    >
      {isAdmin && conv.assignedAgentColor && (
        <div 
          className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg"
          style={{ backgroundColor: conv.assignedAgentColor }}
          title={`Atribuída a: ${conv.assignedAgentName || 'ChatGPT'}`}
        />
      )}
      <button
        onClick={() => setSelectedConversation(conv.id)}
        className="w-full text-left"
        data-testid={`button-conversation-${conv.id}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-semibold text-sm truncate text-gray-900">
                {conv.customerName}
              </p>
              {conv.priority === "urgent" && (
                <Badge variant="destructive" className="text-[10px] h-4">
                  Urgente
                </Badge>
              )}
              {conv.customerLinked && (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full bg-green-500 text-white text-[9px] font-medium px-1.5 h-4 shrink-0"
                  title="Telefone vinculado ao cadastro do cliente"
                  data-testid={`badge-customer-linked-${conv.id}`}
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.1 3.1 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd"/></svg>
                  Cliente
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-medium whitespace-nowrap text-gray-400">
              {formatLastMessageTime(conv.lastMessageTime)}
            </p>
          </div>
        </div>
      </button>
      <div className="flex items-center gap-2 mt-1">
        <p className="text-xs text-gray-500 truncate">
          {conv.customerPhone}
        </p>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPhonebookData({ name: conv.customerName, phone: conv.customerPhone });
          }}
          className="p-1.5 rounded-full bg-green-50 hover:bg-green-100 text-green-600 hover:text-green-700 transition-colors border border-green-200"
          title="Adicionar à agenda"
          data-testid={`button-add-phonebook-${conv.id}`}
        >
          <UserPlus className="h-4 w-4" />
        </button>
      </div>
      {convLabelObjs.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {convLabelObjs.map((l: any) => (
            <span key={l.id} className="inline-flex items-center rounded-full text-white text-[9px] font-medium px-1.5 h-4" style={{ backgroundColor: l.color }} title={`Etiqueta: ${l.name}`}>{l.name}</span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <Badge className={`text-[10px] ${getStatusColor(conv.status)}`}>
          {conv.status === 'new' ? 'Nova' : 
           conv.status === 'assigned' ? 'Atribuída' :
           conv.status === 'in-progress' ? 'Em andamento' : 'Resolvida'}
        </Badge>
        {isAdmin && conv.assignedAgentName && (
          <span 
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{ 
              backgroundColor: conv.assignedAgentColor ? `${conv.assignedAgentColor}20` : '#e5e7eb',
              color: conv.assignedAgentColor || '#6b7280'
            }}
          >
            {conv.assignedAgentName}
          </span>
        )}
        {!isAdmin && (
          <span className="text-[10px] text-gray-400 truncate">
            Atendente: {conv.assignedAgentName || conv.agentName || "Ninguém"}
          </span>
        )}
      </div>
    </div>
  );
}

class ChatCenterErrorBoundary extends Component<{ children: any }, { hasError: boolean }> {
  constructor(props: any) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: any, info: any) { console.error('[ChatCenter] erro de render capturado:', error, info); }
  render() {
    if ((this.state as any).hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-12 text-center" style={{ minHeight: '300px' }}>
          <p className="text-lg font-semibold mb-2">Ocorreu um erro ao exibir esta tela.</p>
          <p className="text-gray-600 mb-4">Isso nao afeta o envio/recebimento das mensagens. Recarregue para continuar.</p>
          <button onClick={() => window.location.reload()} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">Recarregar</button>
        </div>
      );
    }
    return (this.props as any).children;
  }
}

function ChatCenterInner() {
  const { toast } = useToast();
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [assignedAgent, setAssignedAgent] = useState<string>("");
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaCaption, setMediaCaption] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [transferToAgent, setTransferToAgent] = useState<string>("");

  // Query para buscar agentes online para transferência
  const { data: onlineAgentsData } = useQuery<{ success: boolean; agents: { id: string; name: string; email: string; status: string }[] }>({
    queryKey: ['/api/chat/agents/online'],
    refetchInterval: 30000,
  });
  const onlineAgents = onlineAgentsData?.agents || [];

  // Canais Umbler (honest1-4) para o seletor de canal por conversa
  const { data: channelsData } = useQuery<{ canais: { phone: string; nome: string; tipo: string; status: string }[] }>({
    queryKey: ['/api/chat/umbler-talk/channels'],
    staleTime: 300000,
  });

  // Mutation para transferir conversa
  const transferMutation = useMutation({
    mutationFn: async ({ conversationId, toAgentId }: { conversationId: string; toAgentId: string }) => {
      const response = await apiRequest('POST', `/api/chat/conversations/${conversationId}/transfer`, { toAgentId });
      return response;
    },
    onSuccess: () => {
      toast({ title: "Conversa transferida com sucesso" });
      setShowTransferDialog(false);
      setTransferToAgent("");
      queryClient.invalidateQueries({ queryKey: ['/api/chat/conversations'] });
    },
    onError: (error: any) => {
      toast({ title: "Erro ao transferir conversa", description: error.message, variant: "destructive" });
    }
  });

  // Mutation para finalizar atendimento
  const finishMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      const response = await apiRequest('PATCH', `/api/chat/conversations/${conversationId}/finish`, {});
      return response;
    },
    onSuccess: () => {
      toast({ title: "Atendimento finalizado com sucesso" });
      setSelectedConversation(null);
      queryClient.invalidateQueries({ queryKey: ['/api/chat/conversations'] });
    },
    onError: (error: any) => {
      toast({ title: "Erro ao finalizar atendimento", description: error.message, variant: "destructive" });
    }
  });

  // 🟢 HEARTBEAT - Enviar presença a cada 30 segundos quando ChatCenter estiver aberto
  useEffect(() => {
    const sendHeartbeat = async () => {
      try {
        await fetch('/api/chat/agents/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include'
        });
      } catch (error) {
        console.warn('⚠️ [HEARTBEAT] Erro ao enviar heartbeat:', error);
      }
    };

    const sendOffline = () => {
      try {
        // Use synchronous XMLHttpRequest for reliable delivery on page unload
        // This is one of the few legitimate uses of sync XHR
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/chat/agents/offline', false); // false = synchronous
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.send(JSON.stringify({}));
      } catch (error) {
        console.warn('⚠️ [OFFLINE] Erro ao enviar offline:', error);
      }
    };

    const sendOfflineAsync = async () => {
      try {
        await fetch('/api/chat/agents/offline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include'
        });
      } catch (error) {
        console.warn('⚠️ [OFFLINE] Erro ao enviar offline async:', error);
      }
    };

    // Enviar heartbeat imediatamente ao abrir
    sendHeartbeat();

    // Configurar intervalo de 30 segundos
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);

    // Lidar com visibilidade da página
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat();
      } else if (document.visibilityState === 'hidden') {
        // Tentar enviar offline quando a aba fica oculta
        sendOfflineAsync();
      }
    };

    // Lidar com fechamento da página
    const handleBeforeUnload = () => {
      sendOffline();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Cleanup: enviar offline e limpar listeners
    return () => {
      clearInterval(heartbeatInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Tentar enviar offline ao desmontar componente (navegação interna)
      sendOfflineAsync();
    };
  }, []);

  // Fetch conversations - polling a cada 3 segundos (evita rate limiting)
  const { data: conversationsData, isLoading: convLoading, refetch: refetchConversations } = useQuery({
    queryKey: ["/api/chat/conversations"],
    refetchInterval: 3000,
    select: (data: Conversation[]) => {
      // DEBUG log para verificar dados recebidos (ajuda na depuração remota)
      if (data && data.length > 0) {
        // console.log('DEBUG CONVS:', data.slice(0, 3).map(c => ({ name: c.customerName, lastMsg: c.lastMessageTime, unread: c.hasUnread })));
      }
      return [...data].sort((a, b) => {
        // Por tempo da última mensagem (mais recente primeiro)
        // Usar timestamps numéricos para comparação robusta
        const timeA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
        const timeB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
        
        if (timeA !== timeB) {
           return timeB - timeA;
        }
        
        // 3. Fallback para data de atualização (ou criação) se não houver mensagens
        // Garantir que estamos acessando propriedades que existem no objeto
        const updateA = (a as any).updatedAt ? new Date((a as any).updatedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const updateB = (b as any).updatedAt ? new Date((b as any).updatedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        
        if (updateA !== updateB) {
          return updateB - updateA;
        }

        const createA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const createB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return createB - createA;
      });
    }
  });
  const conversations = (conversationsData as Conversation[]) || [];

  // 🎯 Selecionar conversa automaticamente se vindo de um botão WhatsApp ou Clientes Ativos
  const phoneParamProcessed = useRef(false);
  useEffect(() => {
    // Só processar uma vez e quando não estiver carregando
    if (phoneParamProcessed.current || convLoading) return;
    
    const params = new URLSearchParams(window.location.search);
    const conversationId = params.get('conversationId');
    const phoneParam = params.get('phone');
    
    // Marcar como processado se tiver parâmetros
    if (conversationId || phoneParam) {
      phoneParamProcessed.current = true;
    }
    
    const handlePhoneParam = async () => {
      try {
        if (conversationId) {
          console.log('🎯 [ChatCenter] Abrindo conversa por ID:', conversationId);
          setSelectedConversation(conversationId);
          window.history.replaceState({}, '', '/telemarketing/atendimento');
        } else if (phoneParam) {
          console.log('🎯 [ChatCenter] Buscando/criando conversa por telefone:', phoneParam);
          try {
            const response = await fetch(`/api/chat/conversations/by-phone/${phoneParam}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include'
            });
            console.log('🔍 [ChatCenter] Resposta by-phone:', response.status);
            if (response.ok) {
              const data = await response.json();
              console.log('🔍 [ChatCenter] Dados recebidos:', data);
              if (data.conversationId) {
                console.log('✅ [ChatCenter] Conversa encontrada/criada:', data.conversationId);
                setSelectedConversation(data.conversationId);
                refetchConversations();
              }
            } else {
              const errorText = await response.text();
              console.warn('⚠️ [ChatCenter] Erro na resposta:', response.status, errorText);
            }
          } catch (err) {
            console.warn('⚠️ [ChatCenter] Erro ao buscar conversa por telefone:', err);
          }
          window.history.replaceState({}, '', '/telemarketing/atendimento');
        }
      } catch (error) {
        console.warn('⚠️ [ChatCenter] Erro ao ler parâmetro:', error);
      }
    };
    
    if (conversationId || phoneParam) {
      handlePhoneParam();
    }
  }, [convLoading, refetchConversations]);

  // Separar conversas SPAM (contatos com "SPAM" no nome)
  const spamConversations = conversations.filter(conv => 
    conv.customerName.toUpperCase().includes('SPAM')
  );

  // Separar conversas de GRUPO (contatos com "GRUPO" no nome)
  const grupoConversations = conversations.filter(conv => 
    conv.customerName.toUpperCase().includes('GRUPO') && 
    !conv.customerName.toUpperCase().includes('SPAM')
  );

  // Conversas normais (excluindo SPAM e GRUPO)
  const normalConversations = conversations.filter(conv => 
    !conv.customerName.toUpperCase().includes('SPAM') &&
    !conv.customerName.toUpperCase().includes('GRUPO')
  );

  // Cadastro de Clientes para busca por nome exato/CNPJ/telefone/palavra avulsa
  const { data: registeredCustomers = [] } = useQuery<any[]>({
    queryKey: ['/api/customers'],
    queryFn: async () => { const r = await fetch('/api/customers', { credentials: 'include' }); return r.ok ? r.json() : []; },
    staleTime: 5 * 60 * 1000,
  });
  const custByPhone = new Map<string, any>();
  (registeredCustomers as any[]).forEach((c: any) => {
    const d = (c.phone || '').replace(/\D/g, '');
    if (d.length >= 8) custByPhone.set(d.slice(-8), c);
  });
  const convMatchesSearch = (conv: any) => {
    const t = searchTerm.trim().toLowerCase();
    if (!t) return true;
    const tDigits = t.replace(/\D/g, '');
    const convPhone = (conv.customerPhone || '').replace(/\D/g, '');
    if ((conv.customerName || '').toLowerCase().includes(t)) return true;
    if (tDigits !== '' && convPhone.includes(tDigits)) return true;
    const cust = convPhone.length >= 8 ? custByPhone.get(convPhone.slice(-8)) : null;
    if (cust) {
      if ((cust.name || '').toLowerCase().includes(t)) return true;
      if ((cust.fantasyName || '').toLowerCase().includes(t)) return true;
      if ((cust.companyName || '').toLowerCase().includes(t)) return true;
      if (tDigits !== '' && (cust.cnpj || '').replace(/\D/g, '').includes(tDigits)) return true;
      if (tDigits !== '' && (cust.cpf || '').replace(/\D/g, '').includes(tDigits)) return true;
    }
    return false;
  };

  // Filtrar conversas por termo de busca (cruzando com o cadastro de Clientes)
  const filteredConversations = normalConversations.filter(convMatchesSearch);
  const filteredSpamConversations = spamConversations.filter(convMatchesSearch);
  const filteredGrupoConversations = grupoConversations.filter(convMatchesSearch);

  // Fetch messages para a conversa selecionada - polling a cada 2 segundos (evita rate limiting)
  const { data: messagesData, isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
    queryKey: ["/api/chat/conversations", selectedConversation, "messages"],
    enabled: !!selectedConversation,
    refetchInterval: 2000,
    queryFn: async () => {
      const response = await fetch(`/api/chat/conversations/${selectedConversation}/messages`);
      if (!response.ok) throw new Error("Falha ao buscar mensagens");
      return response.json();
    }
  });
  const messages = (messagesData as ChatMessage[]) || [];

  // Query para buscar histórico de atribuições
  const { data: assignmentHistory } = useQuery({
    queryKey: ["/api/chat/conversations", selectedConversation, "assignment-history"],
    enabled: !!selectedConversation,
    queryFn: async () => {
      const response = await fetch(`/api/chat/conversations/${selectedConversation}/assignment-history`);
      if (!response.ok) throw new Error("Falha ao buscar histórico");
      return response.json();
    }
  });

  // Fetch agents
  const { data: agentsData } = useQuery({
    queryKey: ["/api/chat/agents"],
  });
  const agents = (agentsData as Agent[]) || [];

  // Fetch quick templates
  const { data: templatesData } = useQuery({
    queryKey: ["/api/chat/quick-templates"],
  });
  const templates = (templatesData as any[]) || [];

  // Fetch agent detailed stats (admin only)
  const isAdmin = user?.role === 'admin' || user?.role === 'coordinator' || user?.role === 'administrative';

  // ===== Etiquetas (labels) das conversas =====
  const [showLabelsModal, setShowLabelsModal] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#3B82F6");
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editLabelName, setEditLabelName] = useState("");
  const [editLabelColor, setEditLabelColor] = useState("#3B82F6");
  const { data: labelsData } = useQuery<{ labels: any[] }>({
    queryKey: ['/api/chat/labels'],
    queryFn: async () => { const r = await fetch('/api/chat/labels', { credentials: 'include' }); return r.ok ? r.json() : { labels: [] }; },
  });
  const labels: any[] = labelsData?.labels || [];
  const myLabelCount = labels.filter(l => l.createdBy === (user as any)?.id).length;
  const { data: convLabelsData } = useQuery<{ items: any[] }>({
    queryKey: ['/api/chat/conversation-labels'],
    queryFn: async () => { const r = await fetch('/api/chat/conversation-labels', { credentials: 'include' }); return r.ok ? r.json() : { items: [] }; },
    refetchInterval: 15000,
  });
  const labelById = new Map<string, any>(labels.map(l => [l.id, l]));
  const labelIdsByConv = new Map<string, string[]>();
  (convLabelsData?.items || []).forEach((it: any) => {
    const arr = labelIdsByConv.get(it.conversationId) || [];
    arr.push(it.labelId); labelIdsByConv.set(it.conversationId, arr);
  });
  const labelsForConv = (convId: string) => (labelIdsByConv.get(convId) || []).map(id => labelById.get(id)).filter(Boolean);
  const invalidateLabels = () => queryClient.invalidateQueries({ queryKey: ['/api/chat/labels'] });
  const createLabelMutation = useMutation({
    mutationFn: async () => await apiRequest('POST', '/api/chat/labels', { name: newLabelName, color: newLabelColor }),
    onSuccess: () => { setNewLabelName(''); setNewLabelColor('#3B82F6'); invalidateLabels(); toast({ title: 'Etiqueta criada' }); },
    onError: (e: any) => toast({ title: 'Erro ao criar etiqueta', description: e?.message || String(e), variant: 'destructive' }),
  });
  const updateLabelMutation = useMutation({
    mutationFn: async ({ id, name, color }: any) => await apiRequest('PATCH', `/api/chat/labels/${id}`, { name, color }),
    onSuccess: () => { setEditingLabelId(null); invalidateLabels(); },
    onError: (e: any) => toast({ title: 'Erro ao alterar etiqueta', description: e?.message || String(e), variant: 'destructive' }),
  });
  const deleteLabelMutation = useMutation({
    mutationFn: async (id: string) => await apiRequest('DELETE', `/api/chat/labels/${id}`),
    onSuccess: () => { invalidateLabels(); queryClient.invalidateQueries({ queryKey: ['/api/chat/conversation-labels'] }); },
    onError: (e: any) => toast({ title: 'Erro ao excluir etiqueta', description: e?.message || String(e), variant: 'destructive' }),
  });
  const setConvLabelsMutation = useMutation({
    mutationFn: async ({ convId, labelIds }: any) => await apiRequest('POST', `/api/chat/conversations/${convId}/labels`, { labelIds }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/chat/conversation-labels'] }),
    onError: (e: any) => toast({ title: 'Erro ao marcar conversa', description: e?.message || String(e), variant: 'destructive' }),
  });
  const toggleConvLabel = (convId: string, labelId: string) => {
    const current = labelIdsByConv.get(convId) || [];
    const next = current.includes(labelId) ? current.filter(x => x !== labelId) : [...current, labelId];
    setConvLabelsMutation.mutate({ convId, labelIds: next });
  };
  const { data: agentStatsData } = useQuery({
    queryKey: ["/api/chat/agents/detailed-stats"],
    enabled: isAdmin,
    refetchInterval: 5000,
  });
  const agentStats = (agentStatsData as any[]) || [];

  // Mutation para marcar conversa como lida
  const markAsReadMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      const response = await fetch(`/api/chat/conversations/${conversationId}/mark-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Falha ao marcar como lida');
      return response.json();
    },
    onSuccess: () => {
      refetchConversations();
    }
  });

  // Marcar conversa como lida quando selecionada (DESATIVADO)
  useEffect(() => {
    /* 
    if (selectedConversation) {
      const conv = conversations.find(c => c.id === selectedConversation);
      if (conv?.hasUnread) {
        markAsReadMutation.mutate(selectedConversation);
      }
    }
    */
  }, [selectedConversation]);

  // Mutation para sincronizar mensagens do WhatsApp
  const syncWhatsAppMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/chat/sync-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Falha ao sincronizar');
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "✅ Sincronização Concluída",
        description: `${data.totalChats || 0} conversas sincronizadas`
      });
      refetchConversations();
    },
    onError: (error: any) => {
      toast({
        title: "❌ Erro na Sincronização",
        description: error.message || "Falha ao sincronizar mensagens do WhatsApp",
        variant: "destructive"
      });
    }
  });

  // Mutation para sincronizar atendentes ativos
  const syncAgentsMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/chat/agents/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Falha ao sincronizar atendentes');
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "✅ Atendentes Sincronizados",
        description: data.message || "A lista de atendentes foi atualizada."
      });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/agents/detailed-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/agents"] });
    },
    onError: (error: any) => {
      toast({
        title: "❌ Erro na Sincronização",
        description: error.message || "Falha ao sincronizar atendentes",
        variant: "destructive"
      });
    }
  });

  const reconfigureWebhookMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/chat/webhook/force-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Falha ao reconfigurar webhook');
      }
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "✅ Webhook Reconfigurado",
        description: data.message
      });
    },
    onError: (error: any) => {
      toast({
        title: "❌ Erro",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  // Seller info will be fetched later after selectedChat is determined

  // Mutation para fazer upload de arquivo
  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return fetch("/api/chat/upload", {
        method: "POST",
        body: formData
      }).then(r => r.json());
    },
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: "Arquivo enviado com sucesso" });
    },
    onError: () => {
      toast({ title: "Erro", description: "Falha ao fazer upload do arquivo", variant: "destructive" });
    }
  });

  // Mutation para enviar mensagem
  const sendMessageMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          senderType: "agent",
          messageType: "text"
        })
      }).then(r => r.json());
    },
    onSuccess: () => {
      setMessageText("");
      // Invalidar tanto mensagens quanto conversas para recarregar agentId
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
    },
    onError: () => {
      toast({ title: "Erro", description: "Não foi possível enviar a mensagem", variant: "destructive" });
    }
  });

  // Mutation para enviar mídia
  const sendMediaMutation = useMutation({
    mutationFn: async ({ mediaUrl, messageType }: { mediaUrl: string; messageType: string }) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: mediaCaption || "",
          mediaUrl,
          messageType,
          senderType: "agent"
        })
      }).then(r => r.json());
    },
    onSuccess: () => {
      setMediaCaption("");
      setSelectedFile(null);
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
      toast({ title: "Sucesso", description: "Mídia enviada com sucesso" });
    },
    onError: () => {
      toast({ title: "Erro", description: "Falha ao enviar mídia", variant: "destructive" });
    }
  });

  // Mutation para enviar localização
  const sendLocationMutation = useMutation({
    mutationFn: async () => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            try {
              const response = await fetch(`/api/chat/conversations/${selectedConversation}/message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content: "Localização compartilhada",
                  latitude: position.coords.latitude,
                  longitude: position.coords.longitude,
                  messageType: "location",
                  senderType: "agent"
                })
              });
              resolve(response.json());
            } catch (error) {
              reject(error);
            }
          },
          (error) => reject(error)
        );
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
      toast({ title: "Sucesso", description: "Localização enviada com sucesso" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error?.message || "Falha ao obter localização", variant: "destructive" });
    }
  });

  // Mutation para atribuir conversa
  const assignConversationMutation = useMutation({
    mutationFn: async (agentId: string) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/assign`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId })
      }).then(r => r.json());
    },
    onSuccess: () => {
      toast({ title: "Sucesso", description: "Conversa atribuída com sucesso" });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
    }
  });

  // Mutation para atualizar status
  const updateStatusMutation = useMutation({
    mutationFn: async (status: string) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      }).then(r => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
    }
  });

  // Mutation para iniciar nova conversa
  const startConversationMutation = useMutation({
    mutationFn: async ({ phoneNumber, customerName }: { phoneNumber: string; customerName: string }) => {
      return fetch(`/api/chat/conversations/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          customerPhone: phoneNumber.replace(/\D/g, ''),
          customerName: customerName || `Cliente ${phoneNumber}`
        })
      }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Erro ${r.status}`); return d; });
    },
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: "Conversa iniciada com sucesso" });
      setShowNewConversation(false);
      setNewPhoneNumber("");
      setNewCustomerName("");
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
      if (data.id) setSelectedConversation(data.id);
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao iniciar conversa", variant: "destructive" });
    }
  });

  const selectedChat = conversations.find((c: Conversation) => c.id === selectedConversation);

  const setChannelMutation = useMutation({
    mutationFn: async ({ id, channelPhone }: { id: string; channelPhone: string }) => {
      const response = await apiRequest('PATCH', `/api/chat/conversations/${id}`, { channelPhone });
      return response;
    },
    onSuccess: () => { toast({ title: "Canal atualizado" }); queryClient.invalidateQueries({ queryKey: ['/api/chat/conversations'] }); },
    onError: (e: any) => { toast({ title: "Erro ao trocar canal", description: e.message, variant: "destructive" }); },
  });
  // canais WhatsApp broker rotulados honest1-4 (dedup por telefone, melhor status)
  const waChannels = (() => {
    const raw = (channelsData?.canais || []).filter((c) => c.phone && /broker/i.test(String(c.tipo || '')) && /honest/i.test(String(c.nome || '')));
    const rank = (st: string) => st === 'Live' ? 4 : st === 'Offline' ? 3 : st === 'Disabled' ? 2 : 1;
    const byPhone: Record<string, { phone: string; nome: string; status: string }> = {};
    for (const c of raw) {
      const ph = String(c.phone).replace(/\D/g, '');
      const cur = byPhone[ph];
      if (!cur || rank(c.status) > rank(cur.status)) byPhone[ph] = { phone: ph, nome: c.nome, status: c.status };
    }
    return Object.values(byPhone).sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
  })();

  const [phonebookData, setPhonebookData] = useState<{ name: string; phone: string } | null>(null);

  // Mutation para adicionar contato à agenda
  const addToPhonebookMutation = useMutation({
    mutationFn: async ({ name, phone }: { name: string; phone: string }) => {
      return apiRequest('POST', '/api/phonebook-contacts', { name, phone });
    },
    onSuccess: () => {
      toast({ title: "Sucesso", description: "Contato adicionado à agenda" });
      queryClient.invalidateQueries({ queryKey: ['/api/phonebook-contacts'] });
      setPhonebookData(null);
    },
    onError: () => {
      toast({ title: "Erro", description: "Não foi possível adicionar à agenda", variant: "destructive" });
    }
  });

  // Mutation para obter sugestão de resposta da IA (Grok/GPT)
  const aiSuggestionMutation = useMutation({
    mutationFn: async () => {
      const chat = conversations.find((c: Conversation) => c.id === selectedConversation);
      if (!selectedConversation || !chat) throw new Error("Nenhuma conversa selecionada");
      if (!messagesData?.length) throw new Error("Aguarde as mensagens carregarem");
      
      // Enviar todas as mensagens ordenadas cronologicamente para contexto completo
      const orderedMessages = [...messagesData].sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      
      const response = await fetch('/api/chat/ai-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: selectedConversation,
          customerName: chat.customerName,
          customerPhone: chat.customerPhone,
          messages: orderedMessages.map(m => ({
            senderType: m.senderType,
            content: m.content,
            createdAt: m.createdAt
          }))
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Falha ao obter sugestão');
      }
      return response.json();
    },
    onSuccess: (data) => {
      if (data.success && data.response) {
        setMessageText(data.response);
        toast({ 
          title: `✨ ${data.provider === 'grok' ? 'Grok' : 'GPT'} Sugeriu`, 
          description: "Revise a sugestão antes de enviar" 
        });
      } else {
        toast({ 
          title: "Erro", 
          description: data.error || "Não foi possível gerar sugestão", 
          variant: "destructive" 
        });
      }
    },
    onError: (error: any) => {
      toast({ 
        title: "Erro", 
        description: error.message || "Falha ao obter sugestão da IA", 
        variant: "destructive" 
      });
    }
  });

  // Fetch seller info for customer (after selectedChat is defined)
  const { data: sellerInfoData } = useQuery({
    queryKey: ["/api/chat/customer-seller", selectedChat?.customerPhone],
    enabled: !!selectedChat?.customerPhone,
    queryFn: async () => {
      const response = await fetch(`/api/chat/customer-seller/${selectedChat?.customerPhone}`);
      if (!response.ok) throw new Error("Falha ao buscar vendedor");
      return response.json();
    }
  });
  const sellerName = (sellerInfoData as any)?.sellerName || "Carregando...";

  // Scroll automático para a última mensagem
  useEffect(() => {
    // Usar setTimeout para garantir que o DOM foi atualizado
    const timer = setTimeout(() => {
      if (messagesEndRef.current) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [messages, selectedChat]);

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;
    await sendMessageMutation.mutateAsync(messageText);
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
  };

  const getMediaType = (file: File): 'image' | 'audio' | 'video' | 'document' => {
    const mime = file.type;
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    return 'document';
  };

  const handleSendMedia = async () => {
    if (!selectedFile) return;
    
    try {
      const uploadResult = await uploadFileMutation.mutateAsync(selectedFile);
      if (uploadResult.success && uploadResult.file?.url) {
        const mediaType = getMediaType(selectedFile);
        await sendMediaMutation.mutateAsync({
          mediaUrl: uploadResult.file.url,
          messageType: mediaType
        });
      }
    } catch (error) {
      console.error('Erro ao enviar mídia:', error);
    }
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      "new": "bg-blue-100 text-blue-700",
      "assigned": "bg-purple-100 text-purple-700",
      "in-progress": "bg-yellow-100 text-yellow-700",
      "resolved": "bg-green-100 text-green-700",
    };
    return colors[status] || "bg-gray-100 text-gray-700";
  };

  const getPriorityIcon = (priority: string) => {
    return priority === "urgent" ? "🔴" : "⚪";
  };

  const formatLastMessageTime = (timestamp: string | undefined) => {
    if (!timestamp) return "sem mensagens";
    try {
      const date = new Date(timestamp);
      if (isToday(date)) {
        return format(date, "HH:mm", { locale: ptBR });
      } else if (isYesterday(date)) {
        return "Ontem";
      } else {
        return format(date, "dd/MM", { locale: ptBR });
      }
    } catch {
      return timestamp;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-4 md:p-8">
      {/* Modal para Adicionar à Agenda com Edição de Nome */}
      <Dialog open={!!phonebookData} onOpenChange={(open) => !open && setPhonebookData(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar à Agenda</DialogTitle>
            <DialogDescription>
              Confirme ou edite o nome do cliente antes de salvar na agenda.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Nome do Cliente</label>
              <Input 
                value={phonebookData?.name || ""} 
                onChange={(e) => setPhonebookData(prev => prev ? { ...prev, name: e.target.value } : null)}
                placeholder="Nome completo"
                data-testid="input-edit-phonebook-name"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Telefone</label>
              <Input 
                value={phonebookData?.phone || ""} 
                disabled 
                className="bg-gray-100"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setPhonebookData(null)}>
              Cancelar
            </Button>
            <Button 
              onClick={() => {
                if (phonebookData) {
                  addToPhonebookMutation.mutate({ 
                    name: phonebookData.name, 
                    phone: phonebookData.phone 
                  });
                }
              }}
              disabled={addToPhonebookMutation.isPending}
              className="bg-green-600 hover:bg-green-700"
              data-testid="button-confirm-phonebook"
            >
              {addToPhonebookMutation.isPending ? "Salvando..." : "Salvar na Agenda"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="w-full">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Central de Atendimento WhatsApp</h1>
            <p className="text-gray-600">Gerencie conversas e atenda clientes em tempo real</p>
          </div>
          <div className="flex gap-3">
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLocation('/telemarketing/ai-settings')}
                className="flex items-center gap-2 bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                data-testid="button-ai-settings"
              >
                <Bot className="h-4 w-4" />
                Configurar IA
              </Button>
            )}
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => syncAgentsMutation.mutate()}
                  disabled={syncAgentsMutation.isPending}
                  variant="outline"
                  size="sm"
                  className="gap-2 bg-purple-50 hover:bg-purple-100 text-purple-700 border-purple-200"
                  title="Sincronizar Atendentes"
                >
                  <Users className={`w-4 h-4 ${syncAgentsMutation.isPending ? 'animate-spin' : ''}`} />
                  {syncAgentsMutation.isPending ? 'Sincronizando...' : 'Sincronizar Atendentes'}
                </Button>

                <Button
                  onClick={() => syncWhatsAppMutation.mutate()}
                  disabled={syncWhatsAppMutation.isPending}
                  variant="outline"
                  className="gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${syncWhatsAppMutation.isPending ? 'animate-spin' : ''}`} />
                  {syncWhatsAppMutation.isPending ? 'Sincronizando...' : 'Sincronizar WhatsApp'}
                </Button>

                <Button
                  onClick={() => reconfigureWebhookMutation.mutate()}
                  disabled={reconfigureWebhookMutation.isPending}
                  variant="outline"
                  size="sm"
                  className="gap-2 border-red-200 text-red-600 hover:bg-red-50"
                  title="Forçar Reconfiguração de Webhook"
                >
                  <MapPin className={`w-4 h-4 ${reconfigureWebhookMutation.isPending ? 'animate-spin' : ''}`} />
                  {reconfigureWebhookMutation.isPending ? 'Configurando...' : 'Fix Webhook'}
                </Button>
              </div>
            )}
            <BackToDashboardButton />
          </div>
        </div>

        <div className={`grid grid-cols-1 ${isAdmin ? "lg:grid-cols-12" : "lg:grid-cols-10"} gap-4`} style={{ minHeight: 'calc(100vh - 160px)' }}>
          {isAdmin && (
            // Sidebar esquerda com stats de agentes
            <div className="lg:col-span-2">
              <Card className="h-full">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Atendentes</CardTitle>
                  <CardDescription className="text-xs">Status e performance</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <ScrollArea className="h-[calc(100vh-220px)] pr-2">
                    {agentStats.length === 0 ? (
                      <div className="text-center py-8 text-gray-500 text-xs">Carregando...</div>
                    ) : (
                      agentStats.map((agent: any) => (
                        <div 
                          key={agent.id} 
                          className="border rounded-lg p-2 mb-2 bg-gray-50 hover:bg-gray-100 transition relative"
                          style={{ borderLeftWidth: '4px', borderLeftColor: agent.color || '#9ca3af' }}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`inline-block w-3 h-3 rounded-full ring-2 ring-white shadow-sm ${agent.status === 'online' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}></span>
                            <p className="text-xs font-semibold truncate flex-1">{agent.name}</p>
                          </div>
                          <div className="text-xs text-gray-600 space-y-0.5 ml-3">
                            <p>✅ Respondidas: <span className="font-semibold">{agent.messagesAnswered}</span></p>
                            <p>📥 A responder: <span className="font-semibold text-red-600">{agent.messagesToRespond}</span></p>
                          </div>
                        </div>
                      ))
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          )}
          
          {/* Lista de Conversas + Agenda Telefônica */}
          <div className={`${isAdmin ? "lg:col-span-3" : "lg:col-span-3"}`}>
            <Tabs defaultValue="conversas" className="h-full">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between mb-3">
                    <TabsList className="grid w-full grid-cols-5 max-w-[560px]">
                      <TabsTrigger value="conversas" className="gap-1 text-xs" data-testid="tab-conversas">
                        <Phone className="w-3 h-3" />
                        Conversas
                      </TabsTrigger>
                      <TabsTrigger value="grupo" className="gap-1 text-xs relative" data-testid="tab-grupo">
                        <Users className="w-3 h-3" />
                        Grupos
                        {grupoConversations.length > 0 && (
                          <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center">
                            {grupoConversations.length}
                          </span>
                        )}
                      </TabsTrigger>
                      <TabsTrigger value="spam" className="gap-1 text-xs relative" data-testid="tab-spam">
                        <Archive className="w-3 h-3" />
                        SPAM
                        {spamConversations.length > 0 && (
                          <span className="absolute -top-1 -right-1 bg-orange-500 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center">
                            {spamConversations.length}
                          </span>
                        )}
                      </TabsTrigger>
                      <TabsTrigger value="agenda" className="gap-1 text-xs" data-testid="tab-agenda">
                        <BookOpen className="w-3 h-3" />
                        Agenda
                      </TabsTrigger>
                      <TabsTrigger value="atendimentos" className="gap-1 text-xs" data-testid="tab-atendimentos">
                        <BarChart2 className="w-3 h-3" />
                        Atendimentos
                      </TabsTrigger>
                    </TabsList>
                  </div>
                </CardHeader>

                <TabsContent value="conversas" className="m-0">
                  <div className="px-4 pb-2 flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <CardTitle className="text-lg">Conversas</CardTitle>
                      <CardDescription>{filteredConversations.length} conversas</CardDescription>
                    </div>
                    <div className="flex items-center gap-2 flex-1 max-w-[200px]">
                      <Input 
                        placeholder="Buscar: nome, CNPJ, telefone ou palavra..." 
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => setShowNewConversation(true)}
                      className="bg-green-600 hover:bg-green-700 shrink-0"
                      data-testid="button-new-conversation"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="px-4 pb-4 overflow-y-auto" style={{ height: 'calc(100vh - 180px)' }}>
                      <div className="space-y-2 pr-2">
                        {convLoading ? (
                          <div className="text-center py-4 text-gray-500">Carregando...</div>
                        ) : filteredConversations.length === 0 ? (
                          <div className="text-center py-4 text-gray-500">Nenhuma conversa encontrada</div>
                        ) : (
                          <div className="space-y-6">
                            {/* Seção de Não Respondidas */}
                            {filteredConversations.some(c => c.hasUnread) && (
                              <div className="space-y-3">
                                <h3 className="text-xs font-bold text-red-500 uppercase tracking-wider mb-2 flex items-center gap-2 px-1">
                                  <AlertCircle className="w-3 h-3" />
                                  Mensagens Não Respondidas
                                </h3>
                                <div className="space-y-2">
                                  {filteredConversations.filter(c => c.hasUnread).map((conv) => (
                                    <ConversationItem 
                                      key={conv.id} 
                                      conv={conv} 
                                      selectedConversation={selectedConversation}
                                      setSelectedConversation={setSelectedConversation}
                                      getStatusColor={getStatusColor}
                                      formatLastMessageTime={formatLastMessageTime}
                                      onAddToPhonebook={(name: string, phone: string) => addToPhonebookMutation.mutate({ name, phone })}
                                      setPhonebookData={setPhonebookData}
                                      isAdmin={isAdmin} labelObjsFor={labelsForConv}
                                    />
                                  ))}
                                </div>
                                <div className="my-6 border-b border-gray-100" />
                              </div>
                            )}

                            {/* Seção de Todas as Conversas */}
                            <div className="space-y-3 pb-8">
                              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 px-1">Histórico de Conversas</h3>
                              <div className="space-y-2">
                                {filteredConversations.filter(c => !c.hasUnread).map((conv) => (
                                  <ConversationItem 
                                    key={conv.id} 
                                    conv={conv} 
                                    selectedConversation={selectedConversation}
                                    setSelectedConversation={setSelectedConversation}
                                    getStatusColor={getStatusColor}
                                    formatLastMessageTime={formatLastMessageTime}
                                    onAddToPhonebook={(name: string, phone: string) => addToPhonebookMutation.mutate({ name, phone })}
                                    setPhonebookData={setPhonebookData}
                                    isAdmin={isAdmin} labelObjsFor={labelsForConv}
                                  />
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                  </div>
                </TabsContent>

                <TabsContent value="grupo" className="m-0">
                  <div className="px-4 pb-2 flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Users className="w-5 h-5 text-blue-500" />
                        Mensagens de Grupos
                      </CardTitle>
                      <CardDescription>{filteredGrupoConversations.length} conversas de grupos</CardDescription>
                    </div>
                    <div className="flex items-center gap-2 flex-1 max-w-[200px]">
                      <Input 
                        placeholder="Buscar: nome, CNPJ, telefone ou palavra..." 
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                  <div className="px-4 pb-4 overflow-y-auto" style={{ height: 'calc(100vh - 180px)' }}>
                      <div className="space-y-2 pr-2">
                        {convLoading ? (
                          <div className="text-center py-4 text-gray-500">Carregando...</div>
                        ) : filteredGrupoConversations.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            <Users className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                            <p className="font-medium">Nenhuma conversa de grupo</p>
                            <p className="text-sm mt-1">Contatos salvos com "GRUPO" no nome aparecem aqui</p>
                          </div>
                        ) : (
                          <div className="space-y-2 pb-8">
                            {filteredGrupoConversations.map((conv) => (
                              <ConversationItem 
                                key={conv.id} 
                                conv={conv} 
                                selectedConversation={selectedConversation}
                                setSelectedConversation={setSelectedConversation}
                                getStatusColor={getStatusColor}
                                formatLastMessageTime={formatLastMessageTime}
                                onAddToPhonebook={(name: string, phone: string) => addToPhonebookMutation.mutate({ name, phone })}
                                setPhonebookData={setPhonebookData}
                                isAdmin={isAdmin} labelObjsFor={labelsForConv}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                  </div>
                </TabsContent>

                <TabsContent value="spam" className="m-0">
                  <div className="px-4 pb-2 flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Archive className="w-5 h-5 text-orange-500" />
                        Mensagens Arquivadas (SPAM)
                      </CardTitle>
                      <CardDescription>{filteredSpamConversations.length} conversas arquivadas</CardDescription>
                    </div>
                    <div className="flex items-center gap-2 flex-1 max-w-[200px]">
                      <Input 
                        placeholder="Buscar: nome, CNPJ, telefone ou palavra..." 
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                  <div className="px-4 pb-4 overflow-y-auto" style={{ height: 'calc(100vh - 180px)' }}>
                      <div className="space-y-2 pr-2">
                        {convLoading ? (
                          <div className="text-center py-4 text-gray-500">Carregando...</div>
                        ) : filteredSpamConversations.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            <Archive className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                            <p className="font-medium">Nenhuma conversa SPAM</p>
                            <p className="text-sm mt-1">Contatos salvos com "SPAM" no nome aparecem aqui</p>
                          </div>
                        ) : (
                          <div className="space-y-2 pb-8">
                            {filteredSpamConversations.map((conv) => (
                              <ConversationItem 
                                key={conv.id} 
                                conv={conv} 
                                selectedConversation={selectedConversation}
                                setSelectedConversation={setSelectedConversation}
                                getStatusColor={getStatusColor}
                                formatLastMessageTime={formatLastMessageTime}
                                onAddToPhonebook={(name: string, phone: string) => addToPhonebookMutation.mutate({ name, phone })}
                                setPhonebookData={setPhonebookData}
                                isAdmin={isAdmin} labelObjsFor={labelsForConv}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                  </div>
                </TabsContent>

                <TabsContent value="agenda" className="m-0 px-4 pb-4">
                  <PhonebookPanel 
                    onStartConversation={(phone, name) => {
                      setNewPhoneNumber(phone);
                      setNewCustomerName(name);
                      setShowNewConversation(true);
                    }}
                  />
                </TabsContent>

                <TabsContent value="atendimentos" className="m-0 px-4 pb-4">
                  <VirtualAttendancePanel />
                </TabsContent>
              </Card>
            </Tabs>
          </div>

          {/* Chat - Coluna expandida para mais espaço */}
          <div className={`${isAdmin ? "lg:col-span-5" : "lg:col-span-5"} space-y-3`}>
            {selectedChat ? (
              <>
                {/* Info do Cliente */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-lg">{selectedChat.customerName}</CardTitle>
                        <div className="flex items-center gap-2 mt-2">
                          <Phone className="w-4 h-4 text-gray-600" />
                          <span className="text-sm text-gray-600">{selectedChat.customerPhone}</span>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 text-green-600 hover:text-green-700 hover:bg-green-50"
                                  onClick={() => setPhonebookData({
                                    name: selectedChat.customerName,
                                    phone: selectedChat.customerPhone
                                  })}
                                  disabled={addToPhonebookMutation.isPending}
                                  data-testid="button-add-to-phonebook"
                                >
                                  {addToPhonebookMutation.isPending ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <UserPlus className="h-3 w-3" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Adicionar à agenda</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                        {waChannels.length > 0 && (
                          <div className="flex items-center gap-2 mt-2 text-xs text-gray-600">
                            <span>📡 Canal:</span>
                            <select
                              value={selectedChat.channelPhone ? String(selectedChat.channelPhone).replace(/\D/g, '') : "5562992682630"}
                              onChange={(e) => setChannelMutation.mutate({ id: selectedChat.id, channelPhone: e.target.value })}
                              disabled={setChannelMutation.isPending}
                              className="border rounded px-1.5 py-0.5 text-xs"
                              data-testid="select-channel"
                              title="Canal de saída (WhatsApp) usado nesta conversa"
                            >
                              {waChannels.map((c) => (
                                <option key={c.phone} value={c.phone} disabled={c.status !== 'Live'}>
                                  {(c.nome || c.phone)}{c.status !== 'Live' ? ` (${c.status})` : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-2 text-xs text-blue-600">
                          <User className="w-3 h-3" />
                          <span>Vendedor: <strong>{sellerName}</strong></span>
                        </div>
                        {selectedChat.agentId && (
                          <div className="flex items-center gap-2 mt-2 text-xs text-green-600 font-semibold">
                            <span>👤 Atendente: {agents.find(a => a.id === selectedChat.agentId)?.name || "Carregando..."}</span>
                          </div>
                        )}
                        {(() => {
                          const headerLabels = labelsForConv(selectedChat.id);
                          return headerLabels.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1 mt-2" data-testid="header-conversation-labels">
                              <span className="text-xs text-gray-500">🏷️</span>
                              {headerLabels.map((l: any) => (
                                <button
                                  key={l.id}
                                  type="button"
                                  onClick={() => setShowLabelsModal(true)}
                                  className="inline-flex items-center rounded-full text-white text-[11px] font-medium px-2 h-5 hover:opacity-90"
                                  style={{ backgroundColor: l.color }}
                                  title={`Etiqueta: ${l.name} (clique para gerenciar)`}
                                >
                                  {l.name}
                                </button>
                              ))}
                            </div>
                          ) : null;
                        })()}
                      </div>
                      <div className="flex flex-col gap-2 items-end">
                        <Badge className={getStatusColor(selectedChat.status)}>
                          {selectedChat.status === "new" ? "Novo" : 
                           selectedChat.status === "assigned" ? "Atribuído" :
                           selectedChat.status === "in-progress" ? "Em andamento" : "Resolvido"}
                        </Badge>
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" className="text-xs" onClick={() => setShowLabelsModal(true)} data-testid="button-open-labels" title="Etiquetas da conversa">🏷️ Etiquetas</Button>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs text-green-600 border-green-600 hover:bg-green-50"
                                  onClick={() => {
                                    if (selectedConversation) {
                                      finishMutation.mutate(selectedConversation);
                                    }
                                  }}
                                  disabled={finishMutation.isPending || selectedChat.status === 'resolved'}
                                  data-testid="button-finish-conversation"
                                >
                                  {finishMutation.isPending ? (
                                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  ) : (
                                    <CheckCircle className="h-3 w-3 mr-1" />
                                  )}
                                  Finalizar
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Finalizar atendimento</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          {true && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="text-xs"
                                    onClick={() => setShowTransferDialog(true)}
                                    data-testid="button-transfer-conversation"
                                  >
                                    <ArrowRightLeft className="h-3 w-3 mr-1" />
                                    Transferir
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Transferir conversa para outro atendente</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                        {isAdmin && selectedChat.assignedAgentName && (
                          <span 
                            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                            style={{ 
                              backgroundColor: selectedChat.assignedAgentColor ? `${selectedChat.assignedAgentColor}20` : '#e5e7eb',
                              color: selectedChat.assignedAgentColor || '#6b7280'
                            }}
                          >
                            {selectedChat.assignedAgentName}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Histórico de Atribuições */}
                    {assignmentHistory && assignmentHistory.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-gray-200">
                        <p className="text-xs font-semibold text-gray-600 mb-2">📋 Histórico de Atribuições:</p>
                        <div className="space-y-1 max-h-24 overflow-y-auto">
                          {(assignmentHistory as any[]).map((item: any, idx: number) => (
                            <div key={idx} className="text-[10px] text-gray-500 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              <span>
                                {(() => { const _d = new Date(item.createdAt); return isNaN(_d.getTime()) ? "--" : format(_d, "dd/MM/yy HH:mm", { locale: ptBR }); })()}
                                {" - "}
                                <span className="font-medium">{item.assignedAgentName || item.assignedAgentId}</span>
                                {item.assignedByUserName && item.assignedByUserName !== 'Sistema' && (
                                  <span className="text-gray-400"> (por {item.assignedByUserName})</span>
                                )}
                                {item.reason === 'transfer' && <span className="text-blue-500"> [Transferido]</span>}
                                {item.reason === 'initial_user' && <span className="text-green-500"> [Iniciado]</span>}
                                {item.reason === 'initial_customer' && <span className="text-purple-500"> [Cliente]</span>}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardHeader>
                </Card>

                {/* Área de Chat + Input de Mensagem - Tudo junto */}
                <Card className="flex flex-col" style={{ height: 'calc(100vh - 300px)', minHeight: '400px' }}>
                  <CardContent className="flex-1 overflow-hidden p-4 flex flex-col">
                    <ScrollArea ref={scrollRef} className="flex-1" style={{ maxHeight: 'calc(100% - 120px)' }}>
                      <div className="space-y-4">
                        {messagesLoading ? (
                          <div className="text-center py-8 text-gray-500">Carregando mensagens...</div>
                        ) : messages.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">Nenhuma mensagem ainda</div>
                        ) : (
                          messages.map((msg: any) => (
                            <div
                              key={msg.id}
                              className={`flex ${msg.senderType === "agent" ? "justify-end" : "justify-start"} ${!msg.isRead ? "mb-3 p-2 bg-blue-50 rounded border-l-4 border-blue-500" : ""}`}
                              data-testid={`message-${msg.id}`}
                            >
                              <div className="flex gap-2 items-flex-end">
                                <div
                                  className={`max-w-xs px-4 py-2 rounded-lg ${
                                    msg.senderType === "agent"
                                      ? "bg-green-600 text-white"
                                      : !msg.isRead
                                      ? "bg-blue-200 text-gray-900 font-semibold border-2 border-blue-400"
                                      : "bg-gray-200 text-gray-900"
                                  }`}
                                >
                                {msg.senderType !== "agent" && (
                                  <div className="text-xs font-semibold mb-1 opacity-80">
                                    👤 {sellerName}
                                  </div>
                                )}
                                {msg.messageType === 'location' && (msg.content || '').includes('[Localização:') ? (
                                  <div className="mb-2 bg-gradient-to-r from-green-100 to-blue-100 p-2 rounded">
                                    <p className="text-xs font-semibold flex items-center gap-1">📍 {msg.content}</p>
                                  </div>
                                ) : (msg.mediaUrl || (msg.messageType === 'image' || msg.messageType === 'audio' || msg.messageType === 'video' || msg.messageType === 'document')) ? (
                                  <div className="mb-2">
                                    {msg.messageType === 'image' && msg.mediaUrl && (
                                      <>
                                        <img 
                                          src={getMediaUrl(msg.mediaUrl)} 
                                          alt="Imagem" 
                                          className="max-w-xs rounded cursor-pointer shadow-lg border" 
                                          style={{ maxHeight: '200px' }}
                                          onClick={() => window.open(getMediaUrl(msg.mediaUrl), '_blank')}
                                          onError={(e) => {
                                            const target = e.target as HTMLImageElement;
                                            target.style.display = 'none';
                                            const fallback = target.nextElementSibling as HTMLElement;
                                            if (fallback) fallback.style.display = 'flex';
                                          }}
                                        />
                                        <div className="hidden items-center justify-center p-4 bg-gray-100 rounded text-gray-500 text-sm">
                                          <ImageIcon className="h-4 w-4 mr-2" />
                                          Imagem não disponível
                                        </div>
                                      </>
                                    )}
                                    {msg.messageType === 'image' && !msg.mediaUrl && (
                                      <div className="bg-yellow-100 p-2 rounded text-xs">📷 Imagem (sem URL)</div>
                                    )}
                                    {msg.messageType === 'audio' && msg.mediaUrl && <audio src={getMediaUrl(msg.mediaUrl)} controls className="max-w-sm" />}
                                    {msg.messageType === 'audio' && !msg.mediaUrl && (
                                      <div className="bg-yellow-100 p-2 rounded text-xs">🎵 Áudio (sem URL)</div>
                                    )}
                                    {msg.messageType === 'video' && msg.mediaUrl && <video src={getMediaUrl(msg.mediaUrl)} controls className="max-w-sm rounded" />}
                                    {msg.messageType === 'video' && !msg.mediaUrl && (
                                      <div className="bg-yellow-100 p-2 rounded text-xs">🎬 Vídeo (sem URL)</div>
                                    )}
                                    {msg.messageType === 'document' && msg.mediaUrl && (
                                      <a href={getMediaUrl(msg.mediaUrl)} target="_blank" rel="noopener noreferrer" className="underline text-blue-600">
                                        📄 {msg.content && !msg.content.startsWith('[') ? msg.content : 'Documento'}
                                      </a>
                                    )}
                                    {msg.messageType === 'document' && !msg.mediaUrl && (
                                      <div className="bg-yellow-100 p-2 rounded text-xs">📄 Documento (sem URL)</div>
                                    )}
                                  </div>
                                ) : (msg.messageType !== 'text' && msg.content && msg.content.startsWith('data:')) ? (
                                  <div className="mb-2">
                                    {msg.messageType === 'image' && <img src={msg.content} alt="mídia" className="max-w-sm rounded" />}
                                    {msg.messageType === 'audio' && <audio src={msg.content} controls className="max-w-sm" />}
                                    {msg.messageType === 'video' && <video src={msg.content} controls className="max-w-sm rounded" />}
                                  </div>
                                ) : null}
                                {msg.messageType === 'text' && msg.content && <p className="text-sm">{msg.content}</p>}
                                {msg.messageType !== 'text' && msg.messageType !== 'location' && msg.messageType !== 'image' && msg.messageType !== 'audio' && msg.messageType !== 'video' && msg.messageType !== 'document' && msg.content && !msg.content.startsWith('data:') && !msg.content.startsWith('/objects/') && !msg.content.startsWith('/uploads/') && !msg.content.includes('Erro:') && <p className="text-sm">{msg.content}</p>}
                                  <p className={`text-xs mt-1 ${msg.senderType === "agent" ? "opacity-70" : "opacity-75"}`}>
                                    {msg.createdAt ? format(new Date(msg.createdAt), "HH:mm", { locale: ptBR }) : ""}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                        {/* Âncora para scroll automático */}
                        <div ref={messagesEndRef} />
                      </div>
                    </ScrollArea>
                    
                    {/* Input de Mensagem - Junto com as mensagens */}
                    <div className="border-t mt-3 pt-3 space-y-2">
                    {templates.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {templates.slice(0, 4).map((template: any) => (
                          <Button
                            key={template.id}
                            variant="outline"
                            size="sm"
                            onClick={() => setMessageText(template.content)}
                            data-testid={`button-template-${template.id}`}
                            className="text-xs"
                          >
                            {template.title}
                          </Button>
                        ))}
                      </div>
                    )}
                    {selectedFile && (
                      <div className="bg-blue-50 p-3 rounded flex items-center justify-between">
                        <span className="text-sm text-gray-700">📎 {selectedFile.name}</span>
                        <button onClick={() => setSelectedFile(null)} className="text-red-500 text-sm">✕</button>
                      </div>
                    )}
                    {selectedFile && (
                      <Input
                        placeholder="Adicione uma legenda (opcional)..."
                        value={mediaCaption}
                        onChange={(e) => setMediaCaption(e.target.value)}
                        data-testid="input-media-caption"
                      />
                    )}
                    <div className="flex gap-2 items-end">
                      <Textarea
                        placeholder="Digite sua mensagem (Enter envia · Shift+Enter nova linha)..."
                        value={messageText}
                        onChange={(e) => setMessageText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage();
                          }
                        }}
                        data-testid="textarea-message"
                        className="resize-none flex-1"
                        rows={2}
                        disabled={!!selectedFile}
                      />
                      <div className="flex gap-1">
                        {!selectedFile ? (
                          <>
                            <input
                              ref={fileInputRef}
                              type="file"
                              onChange={handleFileSelect}
                              accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx"
                              className="hidden"
                              data-testid="input-file"
                            />
                            <Button
                              onClick={() => fileInputRef.current?.click()}
                              variant="outline"
                              size="icon"
                              data-testid="button-upload"
                              title="Enviar mídia"
                            >
                              <Paperclip className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={() => sendLocationMutation.mutate()}
                              variant="outline"
                              size="icon"
                              disabled={sendLocationMutation.isPending}
                              data-testid="button-location"
                              title="Enviar localização"
                            >
                              <MapPin className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={() => aiSuggestionMutation.mutate()}
                              variant="outline"
                              size="icon"
                              disabled={aiSuggestionMutation.isPending || messagesLoading || !messagesData?.length}
                              data-testid="button-ai-suggestion"
                              title={messagesLoading ? "Carregando mensagens..." : "IA Ajuda - Sugerir resposta"}
                              className="bg-purple-50 hover:bg-purple-100 border-purple-300"
                            >
                              {aiSuggestionMutation.isPending || messagesLoading ? (
                                <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                              ) : (
                                <Sparkles className="w-4 h-4 text-purple-600" />
                              )}
                            </Button>
                            <Button
                              onClick={handleSendMessage}
                              disabled={!messageText.trim() || sendMessageMutation.isPending}
                              data-testid="button-send"
                              className="bg-green-600 hover:bg-green-700"
                            >
                              <Send className="w-4 h-4" />
                            </Button>
                          </>
                        ) : (
                          <Button
                            onClick={handleSendMedia}
                            disabled={sendMediaMutation.isPending || uploadFileMutation.isPending}
                            data-testid="button-send-media"
                            className="bg-blue-600"
                          >
                            {uploadFileMutation.isPending ? "Enviando..." : <Send className="w-4 h-4" />}
                          </Button>
                        )}
                      </div>
                    </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Controles de Atribuição e Status - Barra compacta */}
                <div className="flex items-center gap-2 mt-1 p-2 bg-gray-50 rounded border">
                  <Select value={selectedChat.agentId || ""} onValueChange={setAssignedAgent}>
                    <SelectTrigger data-testid="select-agent" className="h-7 text-xs w-40">
                      <SelectValue placeholder="Atribuir..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={selectedChat.status} onValueChange={(status) => updateStatusMutation.mutate(status)}>
                    <SelectTrigger data-testid="select-status" className="h-7 text-xs w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">Novo</SelectItem>
                      <SelectItem value="assigned">Atribuído</SelectItem>
                      <SelectItem value="in-progress">Em andamento</SelectItem>
                      <SelectItem value="resolved">Resolvido</SelectItem>
                    </SelectContent>
                  </Select>
                  {assignedAgent && (
                    <Button 
                      onClick={() => assignConversationMutation.mutate(assignedAgent)}
                      disabled={assignConversationMutation.isPending}
                      data-testid="button-assign"
                      className="h-7 text-xs"
                      size="sm"
                    >
                      Atribuir
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <Card className="h-full flex items-center justify-center">
                <div className="text-center">
                  <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">Selecione uma conversa para começar</p>
                </div>
              </Card>
            )}
          </div>

          {/* Painel de Templates à direita */}
          <div className="lg:col-span-2 hidden lg:block" style={{ height: 'calc(100vh - 180px)' }}>
            <TemplatesPanel
              onSelectTemplate={(template) => {
                if (template.content) {
                  setMessageText(template.content);
                }
              }}
              onSendImage={async (imageUrl, caption) => {
                if (selectedConversation) {
                  try {
                    await apiRequest("POST", `/api/chat/conversations/${selectedConversation}/messages/media`, {
                      mediaUrl: imageUrl,
                      mediaType: "image",
                      caption: caption || ""
                    });
                    queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
                    toast({ title: "Imagem enviada com sucesso" });
                  } catch (error: any) {
                    toast({ title: "Erro ao enviar imagem", description: error.message, variant: "destructive" });
                  }
                }
              }}
              isAdmin={isAdmin} labelObjsFor={labelsForConv}
              hasActiveConversation={!!selectedConversation}
            />
          </div>
        </div>

        {/* Dialog para iniciar nova conversa */}
        <Dialog open={showNewConversation} onOpenChange={setShowNewConversation}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Iniciar Nova Conversa</DialogTitle>
              <DialogDescription>Insira o número telefônico e o nome do cliente para iniciar uma nova conversa</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Número Telefônico</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-600 px-3 py-2 bg-gray-100 rounded">+55</span>
                  <Input
                    placeholder="62 9 9578-2812"
                    value={newPhoneNumber}
                    onChange={(e) => setNewPhoneNumber(e.target.value.replace(/\D/g, ''))}
                    maxLength={11}
                    data-testid="input-phone-number"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">DDD (2 dígitos) + Telefone (8-9 dígitos)</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Nome do Cliente (opcional)</label>
                <Input
                  placeholder="Ex: João Silva"
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  data-testid="input-customer-name"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowNewConversation(false);
                    setNewPhoneNumber("");
                    setNewCustomerName("");
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    if (!newPhoneNumber.length || newPhoneNumber.length < 10) {
                      toast({ title: "Erro", description: "Insira um DDD válido (2 dígitos) e telefone (8-9 dígitos)", variant: "destructive" });
                      return;
                    }
                    startConversationMutation.mutate({ 
                      phoneNumber: `+55${newPhoneNumber}`, 
                      customerName: newCustomerName 
                    });
                  }}
                  disabled={startConversationMutation.isPending || newPhoneNumber.length < 10}
                  className="bg-green-600 hover:bg-green-700"
                  data-testid="button-start-conversation"
                >
                  {startConversationMutation.isPending ? "Iniciando..." : "Iniciar"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Dialog para transferir conversa */}
        <Dialog open={showTransferDialog} onOpenChange={setShowTransferDialog}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Transferir Conversa</DialogTitle>
              <DialogDescription>Selecione o atendente ou ChatGPT para transferir esta conversa</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Transferir para:</label>
                <Select value={transferToAgent} onValueChange={setTransferToAgent}>
                  <SelectTrigger data-testid="select-transfer-agent">
                    <SelectValue placeholder="Selecione um atendente" />
                  </SelectTrigger>
                  <SelectContent>
                    {onlineAgents
                      .filter((agent) => agent.id && agent.id.trim() !== '')
                      .map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name} {agent.id === 'chatgpt' ? '🤖' : ''}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowTransferDialog(false);
                    setTransferToAgent("");
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    if (selectedConversation && transferToAgent) {
                      transferMutation.mutate({ 
                        conversationId: selectedConversation, 
                        toAgentId: transferToAgent 
                      });
                    }
                  }}
                  disabled={transferMutation.isPending || !transferToAgent}
                  className="bg-green-600 hover:bg-green-700"
                  data-testid="button-confirm-transfer"
                >
                  {transferMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Transferindo...
                    </>
                  ) : "Transferir"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {showLabelsModal && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => { setShowLabelsModal(false); setEditingLabelId(null); }}>
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-3 border-b flex items-center justify-between">
                <div className="font-bold text-gray-800">🏷️ Etiquetas</div>
                <button onClick={() => { setShowLabelsModal(false); setEditingLabelId(null); }} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
              <div className="px-5 py-4 space-y-4 text-sm">
                {selectedConversation && (
                  <div>
                    <div className="text-xs font-semibold text-gray-600 mb-2">Marcar esta conversa</div>
                    {labels.length === 0 ? <p className="text-xs text-gray-400">Nenhuma etiqueta criada ainda.</p> : (
                      <div className="flex flex-wrap gap-2">
                        {labels.map((l: any) => {
                          const on = (labelIdsByConv.get(selectedConversation) || []).includes(l.id);
                          return (
                            <button key={l.id} onClick={() => toggleConvLabel(selectedConversation, l.id)}
                              className="inline-flex items-center gap-1 rounded-full px-2.5 h-7 text-xs font-medium border transition"
                              style={on ? { backgroundColor: l.color, borderColor: l.color, color: '#fff' } : { borderColor: l.color, color: '#374151', background: '#fff' }}>
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: on ? '#fff' : l.color }} />
                              {l.name}{on ? ' ✓' : ''}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                <div className="border-t pt-3">
                  <div className="text-xs font-semibold text-gray-600 mb-2">Gerenciar etiquetas <span className="text-gray-400">({myLabelCount}/5 suas)</span></div>
                  <div className="flex items-center gap-2 mb-2">
                    <input type="color" value={newLabelColor} onChange={(e) => setNewLabelColor(e.target.value)} className="w-9 h-9 rounded border p-0.5" title="Cor" />
                    <input value={newLabelName} onChange={(e) => setNewLabelName(e.target.value)} placeholder="Nova etiqueta" maxLength={40} className="flex-1 border rounded px-2 py-1.5" data-testid="input-new-label" />
                    <button onClick={() => { if (newLabelName.trim()) createLabelMutation.mutate(); }} disabled={createLabelMutation.isPending || myLabelCount >= 5 || !newLabelName.trim()} className="px-3 py-1.5 rounded bg-green-600 text-white text-sm disabled:opacity-50" data-testid="button-create-label">Criar</button>
                  </div>
                  {myLabelCount >= 5 && <p className="text-[11px] text-amber-600 mb-2">Você atingiu o limite de 5 etiquetas.</p>}
                  <div className="space-y-1.5">
                    {labels.length === 0 && <p className="text-xs text-gray-400">Nenhuma etiqueta.</p>}
                    {labels.map((l: any) => (
                      <div key={l.id} className="flex items-center gap-2 border rounded px-2 py-1.5">
                        {editingLabelId === l.id ? (
                          <>
                            <input type="color" value={editLabelColor} onChange={(e) => setEditLabelColor(e.target.value)} className="w-8 h-8 rounded border p-0.5" />
                            <input value={editLabelName} onChange={(e) => setEditLabelName(e.target.value)} maxLength={40} className="flex-1 border rounded px-2 py-1" />
                            <button onClick={() => updateLabelMutation.mutate({ id: l.id, name: editLabelName, color: editLabelColor })} className="text-green-600 text-xs font-medium">Salvar</button>
                            <button onClick={() => setEditingLabelId(null)} className="text-gray-400 text-xs">Cancelar</button>
                          </>
                        ) : (
                          <>
                            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                            <span className="flex-1 truncate">{l.name}</span>
                            <span className="text-[10px] text-gray-400 truncate max-w-[90px]" title={l.createdByName}>{l.createdByName || ''}</span>
                            {l.canEdit && (
                              <>
                                <button onClick={() => { setEditingLabelId(l.id); setEditLabelName(l.name); setEditLabelColor(l.color); }} className="text-blue-600 text-xs">Editar</button>
                                <button onClick={() => { if (window.confirm(`Excluir a etiqueta "${l.name}"?`)) deleteLabelMutation.mutate(l.id); }} className="text-red-500 text-xs">Excluir</button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatCenter() {
  return (
    <ChatCenterErrorBoundary>
      <ChatCenterInner />
    </ChatCenterErrorBoundary>
  );
}
