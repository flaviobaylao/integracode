// ─────────────────────────────────────────────────────────────────────────────
// QUEM ENXERGA A HONEST INTEIRA NA GESTÃO DE CARTEIRAS
//
// 15/11/2026 (Flavio). Até aqui a regra era pelo avesso: só `vendedor` e
// `telemarketing` ficavam presos à própria carteira, e TODO o resto — incluindo
// administrativo e motorista — via o global da empresa nas quatro abas
// (Carteira, Dossiê do vendedor, Agenda de Rota, Rede de Cliente). Virou o
// contrário, que é como a regra sempre deveria ter sido escrita: a lista diz
// quem PODE ver tudo, e quem não está nela vê só a própria carteira.
//
// Mudar isso em sete lugares diferentes é como a regra desanda — já aconteceu
// nesta base. Por isso ela mora aqui, num arquivo só, e os endpoints das quatro
// abas importam daqui em vez de repetir a lista.
//
// Efeito colateral conhecido e aceito: usuário sem carteira nenhuma (um
// administrativo, por exemplo) passa a ver a tela vazia em vez do global. Isso
// é a regra funcionando, não defeito — mas a tela precisa dizer isso com
// todas as letras, senão parece que o sistema quebrou.
// ─────────────────────────────────────────────────────────────────────────────

/** Papéis que enxergam todas as carteiras. Qualquer outro vê só a própria. */
export const PAPEIS_GLOBAIS = ["admin", "coordinator"] as const;

/** `true` quando o papel pode ver o global da Honest. */
export function vePainelGlobal(papel: any): boolean {
  return (PAPEIS_GLOBAIS as readonly string[]).includes(String(papel || ""));
}

/** `true` quando o usuário fica restrito à própria carteira. */
export function escopoRestrito(papel: any): boolean {
  return !vePainelGlobal(papel);
}
