// =============================================================================
// QUANDO O ENTREGADOR PODE TOCAR EM "INICIAR ROTA"
// -----------------------------------------------------------------------------
// A regra mora aqui, e não dentro da tela, porque ela decide MAIS do que um
// botão: é o toque em "Iniciar Rota" que dispara o aviso "seu pedido saiu para
// entrega" para todos os clientes da rota (POST /api/delivery-routes/:id/start
// → avisarRotaIniciada). Botão escondido = cliente sem aviso, em silêncio.
//
// Foi exatamente o que aconteceu (achado em 21/set/2026): a tela escondia o
// botão quando havia rota em 'em_andamento' OU em 'rota_enviada'. Só que
// 'rota_enviada' é o estado em que a rota CHEGA no app do entregador — é o
// único momento em que ele deveria ver o botão. E o app do entregador só
// recebe rotas em 'rota_enviada', 'em_andamento' ou 'concluida'. Ou seja: a
// condição era verdadeira para toda rota visível e o botão nunca aparecia.
//
// Ninguém notou porque a lista de paradas continua funcionando sem iniciar a
// rota: o entregador marca entrega e devolução normalmente. O que não
// acontecia era o aviso ao cliente.
// =============================================================================

/** Estados em que a rota JÁ saiu — o botão de iniciar não faz mais sentido. */
export const ROTA_JA_EM_CURSO = ['em_andamento', 'concluida'];

/** Estado em que a rota está com o entregador, esperando ele iniciar. */
export const ROTA_ESPERANDO_INICIO = 'rota_enviada';

/**
 * Mostra o botão "Iniciar Rota"? Sim quando existe rota esperando início e
 * nenhuma já em curso.
 */
export function podeIniciarRota(rotas: Array<{ status?: string | null }>): boolean {
  if (!Array.isArray(rotas) || rotas.length === 0) return false;
  const emCurso = rotas.some((r) => ROTA_JA_EM_CURSO.includes(String(r?.status || '')));
  if (emCurso) return false;
  return rotas.some((r) => String(r?.status || '') === ROTA_ESPERANDO_INICIO);
}
