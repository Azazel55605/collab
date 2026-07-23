import { useCallback, useEffect, useMemo } from 'react';
import { useCalendarStore } from '../../store/calendarStore';
import { useCollabStore } from '../../store/collabStore';
import { useServerStore } from '../../store/serverStore';
import {
  normalizeHostedCalendarOrigins,
  type HostedCalendarOrigin,
} from '../../lib/calendarSync';

const BACKGROUND_SYNC_INTERVAL_MS = 60_000;

export default function CalendarSyncCoordinator() {
  const profileId = useCollabStore((state) => state.myUserId);
  const connections = useServerStore((state) => state.connections);
  const initialize = useCalendarStore((state) => state.initialize);
  const syncHosted = useCalendarStore((state) => state.syncHosted);
  const originsJson = JSON.stringify(normalizeHostedCalendarOrigins(Object.values(connections).flatMap((connection) => {
    const { status } = connection;
    return status.connected && status.serverUrl && status.user
      ? [{ serverUrl: status.serverUrl, userId: status.user.id }]
      : [];
  })));
  const origins = useMemo(
    () => JSON.parse(originsJson) as HostedCalendarOrigin[],
    [originsJson],
  );

  const sync = useCallback(async () => {
    if (!profileId) return;
    await initialize(profileId);
    if (origins.length > 0) await syncHosted(origins);
  }, [initialize, origins, profileId, syncHosted]);

  const runSync = useCallback(() => {
    void sync().catch((error) => {
      useCalendarStore.setState({
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [sync]);

  useEffect(() => {
    runSync();
  }, [runSync]);

  useEffect(() => {
    const runWhenVisible = () => {
      if (document.visibilityState === 'visible') runSync();
    };
    const timer = window.setInterval(runWhenVisible, BACKGROUND_SYNC_INTERVAL_MS);
    window.addEventListener('focus', runWhenVisible);
    window.addEventListener('online', runWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', runWhenVisible);
      window.removeEventListener('online', runWhenVisible);
    };
  }, [runSync]);

  return null;
}
