import { useEffect, useRef, createContext, useContext, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { getAppVersion } from '../../lib/tauri';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import { FileSystemTransport, type CollabTransport } from '../../lib/collabTransport';
import type { ChatMessage } from '../../types/collab';

const CollabContext = createContext<CollabTransport | null>(null);

export function useCollabContext() {
  return useContext(CollabContext);
}

export function CollabProvider({ children }: { children: ReactNode }) {
  const { vault } = useVaultStore();
  const { activeTabPath } = useEditorStore();
  const { isSidebarOpen, sidebarPanel, collabTab } = useUiStore();
  const {
    myUserId,
    myUserName,
    myUserColor,
    setPeers,
    setMyRole,
    setChatMessages,
    appendChatMessage,
    chatTypingUntil,
  } = useCollabStore();
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const isChatVisible = isSidebarOpen && sidebarPanel === 'collab' && collabTab === 'chat';
  const isChatVisibleRef = useRef(isChatVisible);
  useEffect(() => {
    isChatVisibleRef.current = isChatVisible;
  }, [isChatVisible]);

  // Use a ref so the interval callback always reads the latest activeTabPath
  const activeTabPathRef = useRef(activeTabPath);
  useEffect(() => {
    activeTabPathRef.current = activeTabPath;
  }, [activeTabPath]);

  const transportRef = useRef<FileSystemTransport | null>(null);
  useEffect(() => {
    transportRef.current = vault ? new FileSystemTransport(vault.path) : null;
  }, [vault?.path]);

  const broadcastPresence = async (activeFile: string | null) => {
    if (!vault || !transportRef.current) return;
    try {
      const version = await getAppVersion().catch(() => '0.0.0');
      await transportRef.current.broadcastPresence({
        userId: myUserId,
        userName: myUserName,
        userColor: myUserColor,
        activeFile,
        cursorLine: null,
        chatTypingUntil,
        lastSeen: Date.now(),
        appVersion: version,
      });
    } catch {}
  };

  const refreshPeers = async () => {
    if (!vault || !transportRef.current) return;
    try {
      const all = await transportRef.current.readPresence();
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

  useEffect(() => {
    if (!vault) return;
    broadcastPresence(activeTabPathRef.current);
  }, [chatTypingUntil, vault?.path]);

  const handleIncomingMessages = (msgs: ChatMessage[], mode: 'replace' | 'append') => {
    const newRemoteMessages: ChatMessage[] = [];
    for (const msg of msgs) {
      if (knownMessageIdsRef.current.has(msg.id)) continue;
      knownMessageIdsRef.current.add(msg.id);
      if (msg.userId !== myUserId) {
        newRemoteMessages.push(msg);
      }
    }

    if (mode === 'replace') {
      setChatMessages(msgs);
    } else {
      for (const msg of msgs) {
        appendChatMessage(msg);
      }
    }

    if (isChatVisibleRef.current) return;
    for (const msg of newRemoteMessages) {
      toast.info(`${msg.userName} sent a message`, {
        description: msg.content.length > 72 ? `${msg.content.slice(0, 72)}...` : msg.content,
        duration: 3500,
      });
    }
  };

  // Interval broadcast + presence listener + chat listener
  useEffect(() => {
    if (!vault || !transportRef.current) return;

    const interval = setInterval(() => broadcastPresence(activeTabPathRef.current), 10000);
    refreshPeers();

    const unsubPresence = transportRef.current.onPresenceChanged(refreshPeers);

    // Load initial chat messages
    transportRef.current.readChatMessages(100).then((msgs) => {
      knownMessageIdsRef.current = new Set(msgs.map((msg) => msg.id));
      setChatMessages(msgs);
    }).catch(() => {});

    const unsubChat = transportRef.current.onChatUpdated(async () => {
      try {
        if (!transportRef.current) return;
        const msgs = await transportRef.current.readChatMessages(100);
        handleIncomingMessages(msgs, 'replace');
      } catch {}
    });

    let unsubChatMessage: (() => void) | undefined;
    listen<ChatMessage>('collab:chat-message', ({ payload }) => {
      if (!payload) return;
      handleIncomingMessages([payload], 'append');
    }).then((u) => {
      unsubChatMessage = u;
    });

    // Re-evaluate own role whenever vault.json changes (permission updates, ownership claims)
    const unsubConfig = transportRef.current.onConfigChanged(async () => {
      try {
        if (!transportRef.current) return;
        const config = await transportRef.current.readVaultConfig();
        resolveRoleFromConfig(config);
      } catch {}
    });

    return () => {
      clearInterval(interval);
      unsubPresence();
      unsubChat();
      unsubChatMessage?.();
      unsubConfig();
    };
  }, [vault?.path, myUserId]);

  useEffect(() => {
    if (!vault || !transportRef.current) return;
    return () => {
      transportRef.current?.clearPresence(myUserId).catch(() => {});
    };
  }, [vault?.path, myUserId]);

  return (
    <CollabContext.Provider value={transportRef.current}>
      {children}
    </CollabContext.Provider>
  );
}
