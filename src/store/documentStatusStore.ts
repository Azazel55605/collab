import { useEffect } from 'react';

import { create } from 'zustand';

import type {
  DocumentSessionController,
  DocumentSessionSnapshot,
  DocumentStatus,
} from '../lib/documentSessionController';

export interface RegisteredDocumentStatus {
  status: DocumentStatus;
  /**
   * Phase 3: the live session controller + latest snapshot for the active
   * document, so the central status surface can render the full reconciliation
   * review (base/local/remote diff, copy-out, and the resolution actions). Type
   * parameters are erased at the store boundary; the surface treats documents
   * opaquely. Legacy registrants that only set `status`/`onLoadRemote`/
   * `onKeepLocal` still render as a plain pill.
   */
  controller?: DocumentSessionController<unknown>;
  snapshot?: DocumentSessionSnapshot<unknown>;
  /** Persists local content as a new revision/file ("Save mine as new"). */
  onSaveAsNew?: (localContent: string) => Promise<void>;
  readOnly?: boolean;
  onLoadRemote?: () => void;
  onKeepLocal?: () => void;
}

interface DocumentStatusState {
  statuses: Record<string, RegisteredDocumentStatus>;
  setDocumentStatus: (relativePath: string, status: RegisteredDocumentStatus) => void;
  clearDocumentStatus: (relativePath: string) => void;
}

export const useDocumentStatusStore = create<DocumentStatusState>((set) => ({
  statuses: {},
  setDocumentStatus: (relativePath, status) =>
    set((state) => ({
      statuses: {
        ...state.statuses,
        [relativePath]: status,
      },
    })),
  clearDocumentStatus: (relativePath) =>
    set((state) => {
      if (!(relativePath in state.statuses)) return state;
      const { [relativePath]: _removed, ...statuses } = state.statuses;
      return { statuses };
    }),
}));

export function useDocumentStatusRegistration(
  relativePath: string | null | undefined,
  status: RegisteredDocumentStatus | null,
): void {
  const setDocumentStatus = useDocumentStatusStore((state) => state.setDocumentStatus);
  const clearDocumentStatus = useDocumentStatusStore((state) => state.clearDocumentStatus);

  useEffect(() => {
    if (!relativePath || !status) return;
    setDocumentStatus(relativePath, status);
    return () => clearDocumentStatus(relativePath);
  }, [clearDocumentStatus, relativePath, setDocumentStatus, status]);
}
