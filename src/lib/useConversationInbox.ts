import { useEffect, useRef, useState } from 'react';

import type { ConversationAccount, ConversationSummary } from '../types/conversation';

import { conversationEvents, listConversations, listPinnedConversations } from './conversations';

export function useConversationInbox(account: ConversationAccount, connected: boolean) {
  const key = JSON.stringify([account.serverUrl, account.accountId]);
  const [state, setState] = useState({
    key,
    rows: [] as ConversationSummary[],
    /** Pinned rows load separately so they show regardless of paging. */
    pinned: [] as ConversationSummary[],
    older: false,
    busy: true,
    error: null as string | null,
    removed: [] as string[],
  });
  const generation = useRef(0);
  const current = useRef({ account, key, connected });
  current.current = { account, key, connected };
  const cursor = useRef('0');
  const polling = useRef(false);
  const older = useRef(false);
  const loadTicket = useRef(0);
  async function refresh(before?: string) {
    if (!current.current.connected) return;
    const request = current.current;
    const gen = generation.current;
    const ticket = ++loadTicket.current;
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      const [rows, pinned] = await Promise.all([
        listConversations(request.account, before),
        // Servers without pins ignore the filter; the flag check keeps them empty.
        listPinnedConversations(request.account).then((list) => list.filter((row) => row.pinned)),
      ]);
      if (
        generation.current !== gen ||
        current.current.key !== request.key ||
        ticket !== loadTicket.current
      )
        return;
      older.current = !!before;
      setState((value) => ({
        ...value,
        key: request.key,
        rows,
        pinned,
        older: !!before,
        busy: false,
        error: null,
      }));
    } catch (reason) {
      if (generation.current === gen && ticket === loadTicket.current)
        setState((value) => ({
          ...value,
          rows: [],
          pinned: [],
          busy: false,
          error: String(reason),
        }));
    }
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const gen = ++generation.current;
    cursor.current = '0';
    polling.current = false;
    older.current = false;
    setState({
      key,
      rows: [],
      pinned: [],
      older: false,
      busy: connected,
      error: null,
      removed: [],
    });
    if (!connected)
      return () => {
        generation.current = gen + 1;
      };
    void refreshRef.current();
    const poll = async () => {
      if (polling.current || document.visibilityState === 'hidden') return;
      polling.current = true;
      try {
        const page = await conversationEvents(account, cursor.current);
        if (generation.current !== gen) return;
        cursor.current = page.nextAfter;
        const removed = page.events
          .filter((event) => event.kind === 'removed')
          .map((event) => event.conversationId);
        if (removed.length)
          setState((value) => ({
            ...value,
            removed,
            rows: value.rows.filter((row) => !removed.includes(row.id)),
            pinned: value.pinned.filter((row) => !removed.includes(row.id)),
          }));
        // Inbox snapshots reconcile unread even after another device marks read.
        if (!older.current) await refreshRef.current();
      } catch (reason) {
        if (generation.current === gen)
          setState((value) => ({ ...value, rows: [], pinned: [], error: String(reason) }));
      } finally {
        if (generation.current === gen) polling.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    const wake = () => void poll();
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      generation.current = gen + 1;
      window.clearInterval(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
    // Serialized server/account identity owns this lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);
  return {
    ...(state.key === key && connected
      ? state
      : { key, rows: [], pinned: [], older: false, busy: false, error: null, removed: [] }),
    refresh,
  };
}
