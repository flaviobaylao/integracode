import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { MessageCircle, BarChart3, Settings, FileText, Bot, Send, Search } from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function TelemarketingHub() {
  const modules = [
    {
      icon: MessageCircle,
      title: "Central de Atendimento",
      description: "Gerencie conversas WhatsApp em tempo real",
      href: "/telemarketing/atendimento",
      color: "bg-green-100 text-green-700",
      testid: "card-chat-center"
    },
    {
      icon: BarChart3,
      title: "Dashboard de Conversas",
      description: "Estatísticas e métricas de atendimento",
      href: "/telemarketing/conversas",
      color: "bg-blue-100 text-blue-700",
      testid: "card-chat-dashboard"
    },
    {
      icon: Settings,
      title: "Templates de Resposta",
      description: "Crie respostas rápidas por categoria",
      href: "/telemarketing/templates",
      color: "bg-purple-100 text-purple-700",
      testid: "card-templates"
    },
    {
      icon: FileText,
      title: "Análise de Conversas",
      description: "Análise avançada e relatórios",
      href: "/telemarketing/analysis",
      color: "bg-orange-100 text-orange-700",
      testid: "card-analysis"
    },
    {
      icon: Bot,
      title: "Configurações do ChatGPT",
      description: "Configure atendimento automático por IA",
      href: "/telemarketing/ai-settings",
      color: "bg-cyan-100 text-cyan-700",
      testid: "card-ai-settings"
    },
    {
      icon: Send,
      title: "Disparo em Massa",
      description: "Envie mensagens WhatsApp para múltiplos contatos",
      href: "/telemarketing/disparo-em-massa",
      color: "bg-green-100 text-green-700",
      testid: "card-bulk-message"
    },
    {
      icon: Search,
      title: "SDR Digital",
      description: "Prospecte leads usando Google Places API",
      href: "/telemarketing/sdr-digital",
      color: "bg-indigo-100 text-indigo-700",
      testid: "card-sdr-digital"
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-12 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-gray-900 mb-3">Central de Telemarketing</h1>
            <p className="text-xl text-gray-600">Gerencie conversas, acompanhe métricas e otimize seu atendimento</p>
          </div>
          <BackToDashboardButton />
        </div>

        {/* Main Modules Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {modules.map((module) => {
            const IconComponent = module.icon;
            return (
              <Link key={module.href} href={module.href}>
                <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full" data-testid={module.testid}>
                  <CardHeader>
                    <div className={`w-12 h-12 rounded-lg ${module.color} flex items-center justify-center mb-4`}>
                      <IconComponent className="w-6 h-6" />
                    </div>
                    <CardTitle>{module.title}</CardTitle>
                    <CardDescription>{module.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" className="w-full" data-testid={`button-${module.testid}`}>
                      Acessar
                    </Button>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5" />
              Ações Rápidas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Link href="/telemarketing/atendimento">
                <Button variant="default" className="w-full" data-testid="button-quick-chat">
                  Iniciar Atendimento
                </Button>
              </Link>
              <Link href="/telemarketing/templates">
                <Button variant="outline" className="w-full" data-testid="button-quick-templates">
                  Gerenciar Templates
                </Button>
              </Link>
              <Link href="/telemarketing/conversas">
                <Button variant="outline" className="w-full" data-testid="button-quick-stats">
                  Ver Estatísticas
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Info Section */}
        <div className="mt-12 bg-white rounded-lg p-6 border border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">💡 Como Usar</h2>
          <ul className="space-y-2 text-gray-700 text-sm">
            <li><strong>✅ Central de Atendimento:</strong> Responda mensagens WhatsApp em tempo real, atribua a agentes e mude status</li>
            <li><strong>📊 Dashboard:</strong> Acompanhe total de conversas, tempo de resposta e taxa de resolução</li>
            <li><strong>⚡ Templates:</strong> Crie respostas padrão para agilizar o atendimento</li>
            <li><strong>📈 Análise:</strong> Gere relatórios e analise o desempenho do atendimento</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
