import { create } from 'zustand';

export type SyncTransferDirection = 'upload' | 'download' | 'sync';
export type SyncTransferStatus = 'active' | 'completed' | 'failed';

export interface SyncTransfer {
  id: string;
  vaultId: string;
  vaultName: string;
  direction: SyncTransferDirection;
  label: string;
  detail: string | null;
  completed: number;
  total: number | null;
  status: SyncTransferStatus;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

type NewSyncTransfer = Pick<SyncTransfer, 'vaultId' | 'vaultName' | 'direction' | 'label'> &
  Partial<Pick<SyncTransfer, 'detail' | 'completed' | 'total'>>;

interface SyncTransferState {
  transfers: SyncTransfer[];
  begin: (transfer: NewSyncTransfer) => string;
  update: (
    id: string,
    patch: Partial<Pick<SyncTransfer, 'direction' | 'label' | 'detail' | 'completed' | 'total'>>,
  ) => void;
  complete: (id: string, label?: string) => void;
  fail: (id: string, error: unknown) => void;
  clearFinished: () => void;
  reset: () => void;
}

let transferSequence = 0;
const MAX_TRANSFER_HISTORY = 20;

function updateTransfer(
  transfers: SyncTransfer[],
  id: string,
  patch: Partial<SyncTransfer>,
): SyncTransfer[] {
  return transfers.map((transfer) =>
    transfer.id === id ? { ...transfer, ...patch, updatedAt: Date.now() } : transfer,
  );
}

export const useSyncTransferStore = create<SyncTransferState>((set) => ({
  transfers: [],
  begin: (input) => {
    const now = Date.now();
    const id = `sync-transfer-${now}-${++transferSequence}`;
    const transfer: SyncTransfer = {
      ...input,
      id,
      detail: input.detail ?? null,
      completed: input.completed ?? 0,
      total: input.total ?? null,
      status: 'active',
      error: null,
      startedAt: now,
      updatedAt: now,
    };
    set((state) => ({
      transfers: [transfer, ...state.transfers].slice(0, MAX_TRANSFER_HISTORY),
    }));
    return id;
  },
  update: (id, patch) =>
    set((state) => ({ transfers: updateTransfer(state.transfers, id, patch) })),
  complete: (id, label) =>
    set((state) => ({
      transfers: updateTransfer(state.transfers, id, {
        status: 'completed',
        ...(label ? { label } : {}),
      }),
    })),
  fail: (id, error) =>
    set((state) => ({
      transfers: updateTransfer(state.transfers, id, {
        status: 'failed',
        error: String(error),
      }),
    })),
  clearFinished: () =>
    set((state) => ({
      transfers: state.transfers.filter((transfer) => transfer.status === 'active'),
    })),
  reset: () => set({ transfers: [] }),
}));

export function transferPercent(
  transfer: Pick<SyncTransfer, 'completed' | 'total'>,
): number | null {
  if (!transfer.total || transfer.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((transfer.completed / transfer.total) * 100)));
}
