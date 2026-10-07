import { useEffect, useRef, useState } from 'react';

import type { HostedChatPageMessage, HostedChatScope, PendingChatMessage } from '../types/chat';

import {
  CHAT_WINDOW_LIMIT,
  chatOutbox,
  chatScopeKey,
  compareChatSequence,
  discardChat,
  queueChat,
  readChatPage,
  sendChat,
} from './hostedChat';

interface ChatState {
  key: string;
  messages: HostedChatPageMessage[];
  pending: PendingChatMessage[];
  before: string | null;
  after: string | null;
  earlier: boolean;
  busy: boolean;
  authorized: boolean;
  error: string | null;
  sending: string | null;
}

function initial(key: string): ChatState {
  return {
    key,
    messages: [],
    pending: [],
    before: null,
    after: null,
    earlier: false,
    busy: true,
    authorized: false,
    error: null,
    sending: null,
  };
}

export interface ChatTransport {
  kind: string;
  read: typeof readChatPage;
  outbox: typeof chatOutbox;
  queue: typeof queueChat;
  discard: typeof discardChat;
  send: typeof sendChat;
}
const vaultTransport: ChatTransport = {
  kind: 'vault',
  read: readChatPage,
  outbox: chatOutbox,
  queue: queueChat,
  discard: discardChat,
  send: sendChat,
};

export function useHostedChat(
  scope: HostedChatScope,
  connected: boolean,
  transport: ChatTransport = vaultTransport,
) {
  const key = transport.kind + chatScopeKey(scope);
  const [state, setState] = useState(() => initial(key));
  const current = useRef({ scope, key, connected, transport });
  current.current = { scope, key, connected, transport };
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loading = useRef(false);
  const sending = useRef(false);

  async function load(mode: 'latest' | 'older' | 'new' = 'latest') {
    if (loading.current || !current.current.connected) return;
    const request = current.current;
    const ticket = generation.current;
    const previous = stateRef.current.key === request.key ? stateRef.current : initial(request.key);
    if (mode === 'older' && !previous.before) return;
    loading.current = true;
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      const page = await request.transport.read(
        request.scope,
        mode === 'older'
          ? { before: previous.before! }
          : mode === 'new' && previous.after
            ? { after: previous.after }
            : {},
      );
      if (current.current.key !== request.key || ticket !== generation.current) return;
      setState((value) => {
        const map = new Map(
          (mode === 'latest' ? [] : value.messages).map((message) => [message.id, message]),
        );
        if (!(mode === 'new' && value.earlier)) {
          for (const message of page.messages) map.set(message.id, message);
        }
        const ordered = [...map.values()].sort((a, b) =>
          compareChatSequence(a.sequence, b.sequence),
        );
        const messages =
          mode === 'older'
            ? ordered.slice(0, CHAT_WINDOW_LIMIT)
            : ordered.slice(-CHAT_WINDOW_LIMIT);
        return {
          ...value,
          messages,
          busy: false,
          authorized: true,
          before: mode === 'new' ? value.before : page.nextBefore,
          after: mode === 'older' ? value.after : page.nextAfter,
          earlier: mode === 'older' || (mode === 'new' && value.earlier),
          error: null,
        };
      });
      // A lost acknowledgement is reconciled by UUID, preserving deliberate
      // retry for older drafts that are not in the current window.
      const acknowledged = new Set(
        [...previous.messages, ...page.messages].map((message) => message.id),
      );
      for (const message of previous.pending) {
        if (acknowledged.has(message.id))
          await request.transport.discard(request.scope, message.id);
      }
      if (current.current.key === request.key && ticket === generation.current) {
        setState((value) => ({
          ...value,
          pending: value.pending.filter((message) => !acknowledged.has(message.id)),
        }));
      }
    } catch (reason) {
      if (current.current.key !== request.key || ticket !== generation.current) return;
      // Do not keep authorized history visible after an authorization failure.
      // No persisted history cache is created by this hook.
      setState((value) => ({
        ...value,
        messages: [],
        before: null,
        after: null,
        earlier: false,
        authorized: false,
        busy: false,
        error: String(reason),
      }));
    } finally {
      if (ticket === generation.current) loading.current = false;
    }
  }
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ticket = ++generation.current;
    loading.current = false;
    sending.current = false;
    setState(initial(key));
    void transport
      .outbox(scope)
      .then((pending) => {
        if (generation.current === ticket) setState((value) => ({ ...value, pending }));
      })
      .catch((reason) => {
        if (generation.current === ticket)
          setState((value) => ({ ...value, error: String(reason) }));
      });
    void loadRef.current();
    return () => {
      generation.current = ticket + 1;
    };
    // Scope identity is explicitly captured in the serialized key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);

  useEffect(() => {
    if (!connected) {
      setState((value) => ({ ...value, messages: [], authorized: false, busy: false }));
      return;
    }
    void loadRef.current();
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      void loadRef.current('new');
    };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [connected, key]);

  async function transmit(message: PendingChatMessage, create: boolean) {
    if (sending.current || !current.current.connected || !stateRef.current.authorized) return false;
    const request = current.current;
    const ticket = generation.current;
    sending.current = true;
    let queued = !create;
    setState((value) => ({ ...value, sending: message.id, error: null }));
    try {
      if (create) {
        await request.transport.queue(request.scope, message);
        queued = true;
        if (ticket !== generation.current) return false;
        setState((value) => ({ ...value, pending: [...value.pending, message] }));
      }
      await request.transport.send(request.scope, message);
      await request.transport.discard(request.scope, message.id);
      if (ticket !== generation.current) return true;
      setState((value) => ({
        ...value,
        pending: value.pending.filter((entry) => entry.id !== message.id),
      }));
      void loadRef.current('new');
      return true;
    } catch (reason) {
      if (ticket === generation.current) setState((value) => ({ ...value, error: String(reason) }));
      return create && queued;
    } finally {
      if (ticket === generation.current) {
        sending.current = false;
        setState((value) => ({ ...value, sending: null }));
      }
    }
  }

  async function discard(id: string) {
    const request = current.current;
    const ticket = generation.current;
    try {
      await request.transport.discard(request.scope, id);
      if (ticket === generation.current)
        setState((value) => ({
          ...value,
          pending: value.pending.filter((message) => message.id !== id),
        }));
    } catch (reason) {
      if (ticket === generation.current) setState((value) => ({ ...value, error: String(reason) }));
    }
  }

  return {
    ...(state.key === key
      ? { ...state, ...(!connected ? { messages: [], authorized: false } : {}) }
      : initial(key)),
    refresh: () => load('latest'),
    older: () => load('older'),
    submit: (content: string) =>
      transmit({ id: crypto.randomUUID(), content: content.trim(), createdAt: Date.now() }, true),
    retry: (message: PendingChatMessage) => transmit(message, false),
    discard,
  };
}
