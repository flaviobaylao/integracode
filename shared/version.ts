/**
 * Sistema de Versionamento do Integra
 * Formato: MAJOR.MINOR.PATCH
 * 
 * MAJOR: Mudanças incompatíveis na API ou alterações estruturais grandes
 * MINOR: Novas funcionalidades compatíveis com versões anteriores
 * PATCH: Correções de bugs e pequenas melhorias
 */

export const APP_VERSION = {
  major: 1,
  minor: 5,
  patch: 0,
  
  // Gerado automaticamente
  get full(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  },
  
  // Data de build (atualizada automaticamente no deploy)
  buildDate: new Date().toISOString(),
  
  // Nome da versão (opcional)
  name: 'Versão Estável'
};

export const VERSION_HISTORY = [
  { version: '1.5.0', date: '2025-10-24', changes: 'Correção de unidades de distância nas rotas' },
  { version: '1.4.0', date: '2025-10-20', changes: 'Otimização de rotas com OSRM e sincronização automática' },
  { version: '1.3.0', date: '2025-10-15', changes: 'Débitos vencidos e integração com Omie ERP' },
  { version: '1.2.0', date: '2025-10-10', changes: 'Gestão de entregas e planejamento de rotas VRP' },
  { version: '1.1.0', date: '2025-10-05', changes: 'Agenda automática e sincronização de sales cards' },
  { version: '1.0.0', date: '2025-10-01', changes: 'Lançamento inicial do Sistema Integra' },
];
