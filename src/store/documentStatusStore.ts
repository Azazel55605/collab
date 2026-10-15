import { useEffect, useId } from 'react';

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
  /** Materialize pending gesture/live state before navigation flushes controllers. */
  beforeLeave?: () => Promise<void>;
  onLoadRemote?: () => void;
  onKeepLocal?: () => void;
}

interface DocumentStatusState {
  statuses: Record<string, RegisteredDocumentStatus>;
  registrations: Record<string, { relativePath: string; status: RegisteredDocumentStatus }>;
  setDocumentStatus: (
    relativePath: string,
    status: RegisteredDocumentStatus,
    owner?: string,
  ) => void;
  clearDocumentStatus: (relativePath: string, owner?: string) => void;
}

export const useDocumentStatusStore = create<DocumentStatusState>((set) => ({
  statuses: {},
  registrations: {},
  setDocumentStatus: (relativePath, status, owner = relativePath) =>
    set((state) => ({
      registrations: { ...state.registrations, [owner]: { relativePath, status } },
      statuses: { ...state.statuses, [relativePath]: status },
    })),
  clearDocumentStatus: (relativePath, owner = relativePath) =>
    set((state) => {
      const { [owner]: _registration, ...registrations } = state.registrations;
      const remaining = Object.values(registrations).filter(
        (entry) => entry.relativePath === relativePath,
      );
      const { [relativePath]: _removed, ...statuses } = state.statuses;
      if (remaining.length) statuses[relativePath] = remaining[remaining.length - 1].status;
      return { registrations, statuses };
    }),
}));

/** Include every mounted pane even when multiple panes show the same path. */
export function getRegisteredDocumentStatuses(): RegisteredDocumentStatus[] {
  const { statuses, registrations } = useDocumentStatusStore.getState();
  return [
    ...new Set([
      ...Object.values(statuses),
      ...Object.values(registrations).map((entry) => entry.status),
    ]),
  ];
}

export function useDocumentStatusRegistration(
  relativePath: string | null | undefined,
  status: RegisteredDocumentStatus | null,
): void {
  const owner = useId();
  const setDocumentStatus = useDocumentStatusStore((state) => state.setDocumentStatus);
  const clearDocumentStatus = useDocumentStatusStore((state) => state.clearDocumentStatus);

  useEffect(() => {
    if (!relativePath || !status) return;
    setDocumentStatus(relativePath, status, owner);
    return () => clearDocumentStatus(relativePath, owner);
  }, [clearDocumentStatus, owner, relativePath, setDocumentStatus, status]);
}
