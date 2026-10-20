import { createContext, type ReactNode, useCallback, useContext, useEffect } from 'react';

import type { VaultMeta } from '../types/vault';

export const DocumentPaneContext = createContext<string | null>(null);
const PaneIdContext = createContext('');
const mountedPanes = new Set<string>();
let activePane: string | undefined;
export function activateDocumentPane(pane: string) {
  activePane = pane;
}
export function useDocumentPaneIsActive() {
  const pane = useContext(PaneIdContext);
  return useCallback(() => !pane || activePane === pane, [pane]);
}

export function documentVaultIdentity(vault: VaultMeta | null) {
  return vault?.kind === 'hosted'
    ? JSON.stringify(['hosted', vault.serverUrl, vault.hostedVaultId])
    : vault
      ? JSON.stringify(['local', vault.path])
      : null;
}

export function DocumentPane({
  vault,
  relativePath,
  type,
  paneId = '',
  children,
}: {
  vault: VaultMeta | null;
  relativePath?: string | null;
  type?: string;
  paneId?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!paneId) return;
    mountedPanes.add(paneId);
    activePane ??= paneId;
    return () => {
      mountedPanes.delete(paneId);
      if (activePane === paneId) activePane = mountedPanes.values().next().value;
    };
  }, [paneId]);
  const scope = documentVaultIdentity(vault);
  const identity =
    scope && relativePath ? JSON.stringify([scope, relativePath, type, paneId]) : null;
  return (
    <DocumentPaneContext.Provider key={identity ?? 'none'} value={identity}>
      <PaneIdContext.Provider value={paneId}>{children}</PaneIdContext.Provider>
    </DocumentPaneContext.Provider>
  );
}

/** Pane-local geometry must not overwrite a sibling's selection or viewport. */
export function useDocumentViewKey(relativePath: string) {
  const pane = useContext(PaneIdContext);
  return pane ? `${relativePath}\0${pane}` : relativePath;
}
