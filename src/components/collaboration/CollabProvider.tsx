import { useEffect, createContext, useContext, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useCollabStore } from '../../store/collabStore';
import { tauriCommands } from '../../lib/tauri';

const CollabContext = createContext<null>(null);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useCollabContext() {
  return useContext(CollabContext);
}

export function CollabProvider({ children }: { children: ReactNode }) {
  const { vault } = useVaultStore();
  const { activeTabPath } = useEditorStore();
  const { myUserId, myUserName, myUserColor, setPeers } = useCollabStore();

  const broadcastPresence = async (activeFile: string | null) => {
    if (!vault) return;
    try {
      await tauriCommands.writePresence(vault.path, myUserId, {
        userId: myUserId,
        userName: myUserName,
        userColor: myUserColor,
        activeFile,
        cursorLine: null,
        lastSeen: Date.now(),
        appVersion: '0.1.0',
      });
    } catch {}
  };

  const refreshPeers = async () => {
    if (!vault) return;
    try {
      const all = await tauriCommands.readAllPresence(vault.path);
      setPeers(all.filter((p) => p.userId !== myUserId));
    } catch {}
  };

  useEffect(() => {
    if (!vault) return;
    broadcastPresence(activeTabPath);
  }, [activeTabPath, vault?.path]);

  useEffect(() => {
    if (!vault) return;
    const interval = setInterval(() => broadcastPresence(activeTabPath), 10000);
    refreshPeers();

    let unsub: (() => void) | undefined;
    listen('collab:presence-changed', refreshPeers).then((u) => {
      unsub = u;
    });

    return () => {
      clearInterval(interval);
      unsub?.();
      tauriCommands.clearPresence(vault.path, myUserId).catch(() => {});
    };
  }, [vault?.path]);

  return <CollabContext.Provider value={null}>{children}</CollabContext.Provider>;
}
