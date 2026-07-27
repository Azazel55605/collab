import { useEffect, useMemo, useRef, useState, createContext, useContext, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { getAppVersion } from '../../lib/tauri';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import { createCollabTransport, type CollabTransport } from '../../lib/collabTransport';
import type { ChatMessage } from '../../types/collab';
import { vaultKind } from '../../types/vault';
import { useCollabIdentity } from '../../lib/collabIdentity';

const CollabContext = createContext<CollabTransport | null>(null);

export function useCollabContext() {
  return useContext(CollabContext);
}

export function CollabProvider({ children }: { children: ReactNode }) {
  const { vault } = useVaultStore();
  const { activeTabPath } = useEditorStore();
  const { isSidebarOpen, sidebarPanel, collabTab } = useUiStore();
  const {
    setPeers,
    setChatMessages,
    appendChatMessage,
    chatTypingUntil,
  } = useCollabStore();
  const identity = useCollabIdentity();
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const isChatVisible = isSidebarOpen && sidebarPanel === 'collab' && collabTab === 'chat';
  const isChatVisibleRef = useRef(isChatVisible);
  const [windowVisible, setWindowVisible] = useState(true);
  const windowVisibleRef = useRef(true);
  useEffect(() => {
    isChatVisibleRef.current = isChatVisible;
  }, [isChatVisible]);

  // Use a ref so the interval callback always reads the latest activeTabPath
  const activeTabPathRef = useRef(activeTabPath);
  useEffect(() => {
    activeTabPathRef.current = activeTabPath;
  }, [activeTabPath]);

  const transport = useMemo(() => (vault ? createCollabTransport(vault) : null), [vault]);
  const transportRef = useRef<CollabTransport | null>(null);
  transportRef.current = transport;

  useEffect(() => {
    let unlistenHidden: (() => void) | undefined;
    let unlistenShown: (() => void) | undefined;
    listen('background:window-hidden', () => {
      windowVisibleRef.current = false;
      setWindowVisible(false);
      setPeers([]);
      if (transportRef.current) {
        void transportRef.current.clearPresence(identity.userId).catch(() => {});
      }
    }).then((unlisten) => { unlistenHidden = unlisten; });
    listen('background:window-shown', () => {
      windowVisibleRef.current = true;
      setWindowVisible(true);
    }).then((unlisten) => { unlistenShown = unlisten; });
    return () => {
      unlistenHidden?.();
      unlistenShown?.();
    };
  }, [identity.userId, setPeers]);

  const broadcastPresence = async (activeFile: string | null) => {
    if (!windowVisibleRef.current || !vault || !transportRef.current) return;
    try {
      const version = await getAppVersion().catch(() => '0.0.0');
      await transportRef.current.broadcastPresence({
        userId: identity.userId,
        userName: identity.userName,
        userColor: identity.userColor,
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
      setPeers(all.filter((p) => p.userId !== identity.userId));
    } catch {}
  };

  // Local identity metadata remains useful for presence, chat, and history labels.
  useEffect(() => {
    if (!vault || vaultKind(vault) !== 'local') return;
    tauriCommands.registerKnownUser(vault.path, identity.userId, identity.userName, identity.userColor).catch(() => {});
  }, [vault, identity.userId, identity.userName, identity.userColor]);

  // Broadcast presence when active tab changes
  useEffect(() => {
    if (!vault) return;
    broadcastPresence(activeTabPath);
  }, [activeTabPath, vault?.path, identity.userId, identity.userName, identity.userColor]);

  useEffect(() => {
    if (!vault) return;
    broadcastPresence(activeTabPathRef.current);
  }, [chatTypingUntil, vault?.path, identity.userId, identity.userName, identity.userColor]);

  const handleIncomingMessages = (msgs: ChatMessage[], mode: 'replace' | 'append') => {
    const newRemoteMessages: ChatMessage[] = [];
    for (const msg of msgs) {
      if (knownMessageIdsRef.current.has(msg.id)) continue;
      knownMessageIdsRef.current.add(msg.id);
      if (msg.userId !== identity.userId) {
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
    if (!windowVisible || !vault || !transport) return;

    const interval = setInterval(() => broadcastPresence(activeTabPathRef.current), 10000);
    refreshPeers();

    const unsubPresence = transport.onPresenceChanged(refreshPeers);

    // Load initial chat messages
    transport.readChatMessages(100).then((msgs) => {
      knownMessageIdsRef.current = new Set(msgs.map((msg) => msg.id));
      setChatMessages(msgs);
    }).catch(() => {});

    const unsubChat = transport.onChatUpdated(async () => {
      try {
        const msgs = await transport.readChatMessages(100);
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

    return () => {
      clearInterval(interval);
      unsubPresence();
      unsubChat();
      unsubChatMessage?.();
    };
  }, [transport, vault?.path, identity.userId, windowVisible]);

  useEffect(() => {
    if (!vault || !transportRef.current) return;
    return () => {
      transportRef.current?.clearPresence(identity.userId).catch(() => {});
    };
  }, [vault?.path, identity.userId]);

  return (
    <CollabContext.Provider value={transport}>
      {children}
    </CollabContext.Provider>
  );
}
