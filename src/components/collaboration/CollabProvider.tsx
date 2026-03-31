import { useEffect, useRef, createContext, useContext, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getAppVersion } from '../../lib/tauri';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useCollabStore } from '../../store/collabStore';
import { tauriCommands } from '../../lib/tauri';
import { FileSystemTransport, type CollabTransport } from '../../lib/collabTransport';

const CollabContext = createContext<CollabTransport | null>(null);

export function useCollabContext() {
  return useContext(CollabContext);
}

export function CollabProvider({ children }: { children: ReactNode }) {
  const { vault } = useVaultStore();
  const { activeTabPath } = useEditorStore();
  const { myUserId, myUserName, myUserColor, setPeers, setMyRole, setChatMessages } = useCollabStore();

  // Use a ref so the interval callback always reads the latest activeTabPath
  const activeTabPathRef = useRef(activeTabPath);
  useEffect(() => {
    activeTabPathRef.current = activeTabPath;
  }, [activeTabPath]);

  const transportRef = useRef<FileSystemTransport | null>(null);
  if (vault && (!transportRef.current || transportRef.current['vaultPath' as never] !== vault.path)) {
    transportRef.current = new FileSystemTransport(vault.path);
  }

  const broadcastPresence = async (activeFile: string | null) => {
    if (!vault) return;
    try {
      const version = await getAppVersion().catch(() => '0.0.0');
      await tauriCommands.writePresence(vault.path, myUserId, {
        userId: myUserId,
        userName: myUserName,
        userColor: myUserColor,
        activeFile,
        cursorLine: null,
        lastSeen: Date.now(),
        appVersion: version,
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

  const resolveRoleFromConfig = (config: { owner?: string; members?: Array<{ userId: string; role: string }> }) => {
    if (config.owner === myUserId) {
      setMyRole('admin');
    } else {
      const member = config.members?.find((m) => m.userId === myUserId);
      setMyRole(member ? (member.role as import('../../types/vault').MemberRole) : null);
    }
  };

  // Register self in known_users, claim ownership for legacy vaults, resolve own role
  useEffect(() => {
    if (!vault) return;
    (async () => {
      try {
        // Use the safe, non-privileged register command — cannot touch owner/members
        const config = await tauriCommands.registerKnownUser(vault.path, myUserId, myUserName, myUserColor);
        // If vault has no owner (legacy vault or freshly opened folder), claim it
        if (!config.owner) {
          const claimed = await tauriCommands.claimVaultOwnership(vault.path, myUserId, myUserName)
            .catch(() => config); // if concurrent claim lost, just use existing config
          resolveRoleFromConfig(claimed);
        } else {
          resolveRoleFromConfig(config);
        }
      } catch {}
    })();
  }, [vault?.path]);

  // Broadcast presence when active tab changes
  useEffect(() => {
    if (!vault) return;
    broadcastPresence(activeTabPath);
  }, [activeTabPath, vault?.path]);

  // Interval broadcast + presence listener + chat listener
  useEffect(() => {
    if (!vault) return;

    const interval = setInterval(() => broadcastPresence(activeTabPathRef.current), 10000);
    refreshPeers();

    let unsubPresence: (() => void) | undefined;
    listen('collab:presence-changed', refreshPeers).then((u) => {
      unsubPresence = u;
    });

    // Load initial chat messages
    tauriCommands.readChatMessages(vault.path, 100).then(setChatMessages).catch(() => {});

    let unsubChat: (() => void) | undefined;
    listen('collab:chat-updated', async () => {
      try {
        const msgs = await tauriCommands.readChatMessages(vault.path, 100);
        setChatMessages(msgs);
      } catch {}
    }).then((u) => {
      unsubChat = u;
    });

    // Re-evaluate own role whenever vault.json changes (permission updates, ownership claims)
    let unsubConfig: (() => void) | undefined;
    listen('collab:config-changed', async () => {
      try {
        const config = await tauriCommands.getVaultConfig(vault.path);
        resolveRoleFromConfig(config);
      } catch {}
    }).then((u) => {
      unsubConfig = u;
    });

    return () => {
      clearInterval(interval);
      unsubPresence?.();
      unsubChat?.();
      unsubConfig?.();
      tauriCommands.clearPresence(vault.path, myUserId).catch(() => {});
    };
  }, [vault?.path]);

  return (
    <CollabContext.Provider value={transportRef.current}>
      {children}
    </CollabContext.Provider>
  );
}
