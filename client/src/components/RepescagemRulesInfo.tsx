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
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">A repescagem olha a <b>última bolinha</b>: só entra quem está <b>vermelho</b> (sem atendimento e sem pedido). <b>Amarelo</b> (atendido, sem pedido) e <b>verde</b> (com pedido) não entram — e quem já estava na lista, sai.</p>
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
                <li>Cai <b>somente quando a última visita agendada NÃO foi feita</b> (bolinha vermelha — sem check-in, sem atendimento virtual e sem pedido). <b>Se a visita foi feita — com ou sem pedido</b> (bolinha amarela ou verde) — o cliente <b>não cai</b>. A visita conta como feita pelo check-in do card (mesma fonte do Resumo de Visitas), check-in na rota, atendimento virtual ou pedido.</li>
                <li><b>Semana de atendimento do cadastro:</b> quando o cliente tem semana definida (1ª, 2ª, 3ª, 4ª, última, 1ª e 3ª, 2ª e 4ª), o dia de rota considerado é <b>exatamente o da rota real</b> — semanas do mês contadas pela segunda-feira. Ex.: cliente mensal da <b>3ª semana</b> visitado na segunda 19/10 cai em 20/10 se não for atendido. Sem semana definida ("toda semana"), vale o calendário pela periodicidade.</li>
                <li><b>Só de segunda a sexta:</b> não há sorteio de repescagem no <b>sábado</b> nem no <b>domingo</b>. O cliente não atendido na <b>sexta</b> cai na <b>segunda</b>.</li>
                <li><b>Semanal</b>: cai 1 dia útil após o dia de rota, se a última bolinha estiver vermelha.</li>
                <li><b>Quinzenal/Mensal</b>: se ainda há visita agendada <b>nesta semana</b> (carência da próxima visita), não cai; só cai <b>1 dia depois da data prevista</b>, se a bolinha continuar vermelha.</li>
                <li><b>Permanece</b> enquanto a última bolinha estiver vermelha. <b>Assim que houver pedido (venda) OU qualquer registro de atendimento — do vendedor ou do atendente</b> (check-in na rota/card, check-in da agenda, atendimento virtual/resgate, visita concluída ou repescagem marcada como atendida), com ou sem venda, o cliente <b>sai da lista</b> na hora e <b>não cai no dia seguinte</b>; entra em um novo ciclo e só volta se a próxima visita ficar vermelha.</li>
                <li><b>Proximidade da próxima visita:</b> o cliente <b>não permanece em repescagem colado na próxima visita</b>. Quando a <b>próxima visita agendada é hoje</b> (tem visita na rota do dia) <b>ou amanhã</b> (um dia antes), ele <b>sai da lista</b> e aguarda o <b>novo ciclo</b> — se essa visita ficar sem atendimento/venda, ele volta a cair 1 dia depois. Vale para todas as periodicidades.</li>
                <li>A bolinha <b>sem cor</b> é o ciclo atual, com o atendimento ainda não realizado — cliente nenhum cai por causa dela.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Para quem vai (roteamento) — cada cliente também aparece na rota do próprio dono (card duplo)</p>
              <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">O roteamento especial (carteira → atendente) é <b>configurável no painel “Atendentes e carteiras de repescagem”</b>. Os atendentes são o <b>telemarketing</b> e os <b>vendedores externos</b>; para cada carteira que recebem, escolhe-se o <b>% (10 a 100)</b> dos clientes daquela carteira que o atendente <b>vê</b>. <b>Não é rateio:</b> quando 2+ atendentes recebem a mesma carteira, <b>cada um vê o seu %</b> — com <b>100%</b>, todos veem <b>todos</b> os clientes da carteira em repescagem na rota do dia. Quem <b>capturar</b> o atendimento fica com o cliente no dia e ele some para os demais. % não escolhido = 100%. Os <b>vendedores externos</b> aparecem no painel: recebem sempre os próprios clientes na <b>rota do dia</b> (perímetro) e, se marcados com carteiras de outros vendedores, também passam a atendê-las (igual ao telemarketing). Os padrões espelham o de hoje:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>Incluir/tirar atendentes:</b> no painel, a chave <b>Na repescagem</b> tira o atendente na hora (as carteiras dele ficam salvas); quem está fora aparece em <b>“Fora da repescagem”</b> com o botão <b>+ Incluir</b>. Carteiras: <b>×</b> no chip remove, <b>+ adicionar / remover carteiras</b> marca várias (com Marcar/Desmarcar todos).</li>
                <li>Carlos T. e Radilton → <b>Letícia</b></li>
                <li>Jhonatan e Cleber → <b>Robson</b></li>
                <li>Gilmar → <b>Letícia/Robson</b> (ambos veem os clientes; ajustável pelo %)</li>
                <li>Letícia e Robson → seus próprios clientes ficam <b>com eles mesmos</b></li>
                <li>Demais vendedores externos → carteira própria; na rota, clientes dentro do perímetro de 2 km da rota do dia (próprio vendedor primeiro), <b>sem teto por vendedor</b>; o excedente vai para telemarketing.</li>
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
              <p className="font-semibold mb-1">Migração de carteira (por quedas no mês, com venda)</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Conta as <b>quedas em repescagem dentro do mês vigente</b> (zera a cada mês). Ao atingir o limiar, se a queda foi <b>fechada com venda</b>, a carteira <b>migra na hora para quem vendeu</b> (quem implantou o pedido). Vale para <b>todos os clientes</b>.</li>
                <li><b>Semanal/quinzenal:</b> migra na <b>2ª queda</b> do mês. Na 1ª queda, a venda/comissão vai para quem atendeu, mas o cliente <b>fica na carteira atual</b> (ainda não migra).</li>
                <li><b>Mensal (e bimestral):</b> migra já na <b>1ª queda</b> do mês — quem vender leva o cliente.</li>
                <li>Migra para <b>quem vendeu</b>, seja <b>vendedor externo ou telemarketing</b>. <b>Não precisa</b> ser o mesmo atendente das vezes anteriores nem quedas consecutivas. Atendimento <b>sem</b> venda tira o cliente da lista, mas <b>não migra</b>.</li>
                <li>A migração fica registrada no <b>histórico do cliente</b> e no histórico de migrações de carteira.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Botão "Repescagem" nos reports (decisão do Admin)</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Todo <b>report</b> (não-venda, justificativa, etc.) tem um botão <b>"Repescagem"</b> no Inbox do admin.</li>
                <li>Ao acionar, o cliente é forçado a cair em repescagem <b>excepcionalmente no próximo dia útil</b> (decidido na sexta, cai na segunda), mesmo que pelas regras normais ele <b>não cairia</b> (ex.: foi atendido ou já comprou). É uma inclusão <b>manual, por decisão do Admin</b>.</li>
                <li><b>Só vale para aquele dia.</b> Depois disso o cliente <b>volta a respeitar todas as regras normais</b> de repescagem — não é reinjetado nos dias seguintes (só volta a cair se a próxima visita ficar vermelha).</li>
                <li>Ao acionar, o <b>report sai de pendentes e vai para Resolvidas</b> no Inbox.</li>
                <li>Fica registrado no <b>histórico do cliente</b>.</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold mb-1">Captura de atendimento (telemarketing)</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Cada cliente em repescagem tem o botão <b>"Capturar"</b> — no <b>card de repescagem da Rota do Dia</b> e na tela de Repescagem. Ao capturar, o cliente <b>fica com você</b> (é reatribuído a você), ganha o selo <b>"Capturado por você"</b> e <b>some da lista dos demais telemarketings</b>, evitando dois atendentes ligarem para o mesmo cliente.</li>
                <li><b>Todo atendimento do telemarketing é feito pelo card capturado:</b> ao clicar em WhatsApp ou em Registrar Pedido/Atendimento num card ainda não capturado, ele é <b>capturado automaticamente</b> antes. Cliente capturado por outro atendente fica bloqueado.</li>
                <li>O cliente <b>volta a aparecer para os demais</b> quando o capturador: clica em <b>Liberar</b>, <b>registra um pedido</b> (o cliente sai da repescagem), ou <b>automaticamente às 18h</b> (encerramento do dia — rotina agendada às 18:00).</li>
                <li>O <b>capturador</b> continua vendo o cliente (com o botão Liberar); o <b>admin vê tudo</b>, com o selo "capturado por…", e pode liberar.</li>
                <li><b>Sem trava/redistribuição automática</b> no sorteio: o cliente só fica preso a um atendente quando é capturado.</li>
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
                <li>Job às <b>00:10 (horário de Brasília)</b>: gera as rotas do dia e, <b>de segunda a sexta</b>, roda a distribuição da repescagem (na segunda entram também os não atendidos de sexta). Sábado e domingo: sem sorteio.</li>
                <li>Job diário às <b>18:00 (horário de Brasília)</b>: libera todas as capturas de atendimento do dia.</li>
                <li><b>Report das 17h no Inbox (seg a sex):</b> lista os clientes <b>atendidos</b> na repescagem do dia — de que <b>carteira</b> são, <b>quem atendeu</b> (incluindo a IA) e se houve <b>venda</b> (valor e quem implantou o pedido).</li>
                <li><b>Report das 18h no Inbox:</b> no mesmo horário, o admin recebe <b>um único report</b> com todos os clientes que caíram na repescagem do dia e <b>não foram atendidos</b> (sem atendimento virtual, check-in de rota ou pedido no dia). No report ele escolhe se eles <b>voltam para a repescagem</b> (todos ou os marcados) — entram no sorteio do <b>próximo dia útil</b> e são <b>redistribuídos</b> conforme o painel de carteiras — ou <b>não devolve</b> (seguem as regras normais).</li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
