import { useEffect, useState } from 'react';

import { useServerStore } from '../store/serverStore';

import { subscribeBackgroundPoll } from './backgroundPolls';
import { listConversations } from './conversations';

const POLL_MS = 15_000;

/**
 * Unread chat messages across every signed-in server account, from the first
 * inbox page of each (the newest 50 conversations). Polls in the background
 * while the window is visible; a server that fails keeps its last count.
 */
export function useChatUnreadTotal(): number {
  const connections = useServerStore((state) => state.connections);
  const accountsKey = JSON.stringify(
    Object.entries(connections)
      .filter(([, connection]) => connection.status.connected && connection.status.user)
      .map(([serverUrl, connection]) => [serverUrl, connection.status.user!.id])
      .sort(),
  );
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const accounts = (JSON.parse(accountsKey) as [string, string][]).map(
      ([serverUrl, accountId]) => ({ serverUrl, accountId }),
    );
    if (accounts.length === 0) {
      setTotal(0);
      return;
    }
    let cancelled = false;
    const counts = new Map<string, number>();
    const poll = async () => {
      await Promise.all(
        accounts.map(async (account) => {
          try {
            const rows = await listConversations(account);
            counts.set(
              account.serverUrl,
              rows.reduce((sum, row) => sum + Math.max(0, row.unread || 0), 0),
            );
          } catch {
            // Keep the last known count for a server that is briefly unreachable.
          }
        }),
      );
      if (!cancelled) setTotal([...counts.values()].reduce((sum, value) => sum + value, 0));
    };
    const unsubscribe = subscribeBackgroundPoll(poll, POLL_MS, true);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [accountsKey]);

  return total;
}
