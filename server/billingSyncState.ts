export type BillingSyncStatus = 'idle' | 'running' | 'completed' | 'error';

export interface BillingSyncState {
  status: BillingSyncStatus;
  currentPage: number;
  totalPages: number;
  invoicesFound: number;
  invoicesProcessed: number;
  inserted: number;
  updated: number;
  currentInvoice: string;
  message: string;
  startedAt: Date | null;
  completedAt: Date | null;
}

export const billingSyncState: BillingSyncState = {
  status: 'idle',
  currentPage: 0,
  totalPages: 0,
  invoicesFound: 0,
  invoicesProcessed: 0,
  inserted: 0,
  updated: 0,
  currentInvoice: '',
  message: '',
  startedAt: null,
  completedAt: null
};

export function isBillingSyncRunning(): boolean {
  if (billingSyncState.status !== 'running') return false;
  if (!billingSyncState.startedAt) return false;
  const elapsed = Date.now() - billingSyncState.startedAt.getTime();
  if (elapsed > 30 * 60 * 1000) {
    console.log('⚠️ [SYNC-STATE] Auto-reset: sincronização presa há mais de 30 minutos');
    billingSyncState.status = 'idle';
    return false;
  }
  return true;
}
