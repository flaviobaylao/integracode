import { useState } from 'react';
import { Info } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// ============================================================================
// REGRAS DA REPESCAGEM — fonte UNICA (icone "i").
// Usado no cabecalho da tela de Repescagem e ao lado de "Efetividade em vendas"
// no Resumo de Visitas. IMPORTANTE: sempre que uma regra de repescagem mudar,
// atualizar o texto AQUI (um so lugar mantem as duas telas sincronizadas).
// ============================================================================
export default function RepescagemRulesInfo({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`inline-flex items-center justify-center h-5 w-5 rounded-full border border-blue-300 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors ${className}`}
        title="Ver as regras da repescagem"
        aria-label="Ver as regras da repescagem"
        data-testid="button-repescagem-regras"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Info className="h-5 w-5 text-blue-600" /> Regras da Repescagem</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-gray-700 dark:text-gray-200 space-y-4">
            <div>
              <p className="font-semibold mb-1">Como ler as bolinhas (Efetividade em vendas)</p>
              <p className="mb-1">Uma bolinha por <b>ciclo</b> (semana, quinzena ou mês, conforme a periodicidade do cliente), da mais antiga (esquerda) para a mais recente (direita):</p>
              <ul className="list-none pl-1 space-y-1">
                <li className="flex items-start gap-2"><span className="mt-1 inline-block h-3 w-3 rounded-full bg-green-500 shrink-0" /><span><b>Verde</b> — houve <b>pedido</b> na janela do ciclo.</span></li>
                <li className="flex items-start gap-2"><span className="mt-1 inline-block h-3 w-3 rounded-full bg-yellow-400 shrink-0" /><span><b>Amarelo</b> — houve <b>atendimento</b> (check-in ou virtual), mas <b>sem pedido</b>.</span></li>
                <li className="flex items-start gap-2"><span className="mt-1 inline-block h-3 w-3 rounded-full bg-red-500 shrink-0" /><span><b>Vermelho</b> — passou o dia da visita <b>sem atendimento e sem pedido</b>.</span></li>
                <li className="flex items-start gap-2"><span className="mt-1 inline-block h-3 w-3 rounded-full border border-gray-400 bg-transparent shrink-0" /><span><b>Sem cor</b> — <b>atendimento do ciclo ainda não realizado</b>.</span></li>
              </ul>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">A repescagem olha a <b>última bolinha</b>: se ela não estiver verde (vermelha ou amarela), o cliente entra na repescagem conforme as regras abaixo.</p>
            </div>
            <div>
              <p className="font-semibold mb-1">Quem é elegível</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Clientes <b>ativos</b> (inativos não entram).</li>
                <li>Carteiras de <b>vendedor externo</b> e de <b>telemarketing</b> (Letícia/Robson). Carteiras de canal/sistema (Honest 1/2/3, HOTSITE, INSTAGRAM) e sem dono ficam de fora.</li>
                <li>Clientes vinculados a uma <b>rede de clientes</b> não entram.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Quando o cliente cai em repescagem</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Segue <b>periodicidade e dia de rota</b>, o mesmo raciocínio do Resumo de Visitas (ciclos/bolinhas).</li>
                <li>Cai <b>se e somente se a última bolinha não estiver verde</b> — a visita agendada mais recente sem <b>pedido</b> na janela do ciclo. Vale tanto para a bolinha <b>vermelha</b> (não foi atendido) quanto para a <b>amarela</b> (foi atendido, mas não comprou).</li>
                <li><b>Semanal</b>: cai 1 dia após o dia de rota, se a última bolinha não estiver verde.</li>
                <li><b>Quinzenal/Mensal</b>: se ainda há visita agendada <b>nesta semana</b> (carência da próxima visita), não cai; só cai <b>1 dia depois da data prevista</b>, se a bolinha continuar sem verde.</li>
                <li><b>Permanece</b> enquanto a última bolinha não estiver verde. <b>Assim que houver pedido/venda</b> (na data da visita ou depois, inclusive fim de semana), o cliente <b>sai da lista e entra em um novo ciclo</b> — só volta se a próxima visita ficar sem pedido.</li>
                <li>A bolinha <b>sem cor</b> é o ciclo atual, com o atendimento ainda não realizado — cliente nenhum cai por causa dela.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Para quem vai (roteamento) — cada cliente também aparece na rota do próprio dono (card duplo)</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Carlos T. e Radilton → <b>Letícia</b></li>
                <li>Jhonatan e Cleber → <b>Robson</b></li>
                <li>Gilmar → <b>50/50 Letícia/Robson</b></li>
                <li>Letícia e Robson → seus próprios clientes ficam <b>com eles mesmos</b></li>
                <li>Demais vendedores externos → clientes dentro do perímetro de 2 km da rota do dia (próprio vendedor primeiro), <b>sem teto por vendedor</b>; o excedente vai para telemarketing.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Atribuição da venda e fechamento de rota</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Quem implanta o pedido fica com a venda; o card do outro fica <b>inativo/desabilitado</b>.</li>
                <li>No fechamento, <b>só o vendedor de cadastro (dono) justifica</b> repescagem não atendida; o atendente habilitado não. Card inativo (já vendido/atendido) fica isento.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Travas</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>Sem trava automática</b> (nem no sorteio/roteamento especial, nem ao trocar o atendente). O cadeado manual existe, mas só age se alguém clicar.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Regra correlata da Rota do Dia</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Cliente <b>mensal que já comprou no mês vigente</b> não aparece na rota do dia.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Automação</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Job diário às <b>00:10 (horário de Brasília)</b>: gera as rotas do dia e roda a distribuição da repescagem, capturando o dia anterior inteiro — todos os dias.</li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
