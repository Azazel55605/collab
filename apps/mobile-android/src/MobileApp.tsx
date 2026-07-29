import { CalendarDays, Cloud, FolderOpen, Library, Settings as SettingsIcon } from 'lucide-react';
import type { ReactNode, TouchEvent as ReactTouchEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Banner, ConfirmSheet } from './components/ui';
import {
  mobileExitApp,
  notificationAndroidTakePendingOpen,
  notificationListInbox,
  notificationMarkRead,
  notificationSyncRemote,
  reconcileAndroidBackground,
  requestAndroidBackgroundSync,
  type BackgroundJobRecord,
  type ServerConnectionStatus,
} from './mobileTauri';
import { normalizeServerUrl, type KnownServer } from './lib/servers';
import { applyTheme, loadPrefs, savePrefs, type ThemePrefs } from './lib/theme';
import { FilesScreen } from './screens/FilesScreen';
import { ServersScreen } from './screens/ServersScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { VaultsScreen } from './screens/VaultsScreen';
import { CalendarScreen } from './screens/CalendarScreen';
import { mobileCalendarProfileId } from './lib/calendarSync';
import { TAB_ORDER, type Tab, useMobileStore } from './state/store';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'servers', label: 'Servers', icon: <Cloud size={20} aria-hidden /> },
  { id: 'vaults', label: 'Vaults', icon: <Library size={20} aria-hidden /> },
  { id: 'files', label: 'Files', icon: <FolderOpen size={20} aria-hidden /> },
  { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={20} aria-hidden /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon size={20} aria-hidden /> },
];

const VIEW_SWIPE_THRESHOLD = 56;

function tabIndex(tab: Tab): number {
  return TAB_ORDER.indexOf(tab);
}

function isInteractiveSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"], .cm-editor',
  );
}

export function findBackgroundAttention(
  jobs: BackgroundJobRecord[],
  servers: KnownServer[],
  statuses: Record<string, ServerConnectionStatus>,
): BackgroundJobRecord | undefined {
  const knownServerUrls = new Set(servers.map((server) => normalizeServerUrl(server.serverUrl)));
  const connectedServerUrls = new Set(
    Object.values(statuses)
      .filter((status) => status.connected && status.serverUrl)
      .map((status) => normalizeServerUrl(status.serverUrl as string)),
  );
  return jobs.find((job, index) => {
    if (job.status !== 'authentication_required' && job.status !== 'permission_denied') {
      return false;
    }
    const serverUrl = job.serverUrl ? normalizeServerUrl(job.serverUrl) : null;
    if (serverUrl && !knownServerUrls.has(serverUrl)) return false;
    if (job.status === 'authentication_required' && serverUrl && connectedServerUrls.has(serverUrl)) {
      return false;
    }
    return !jobs.slice(0, index).some((newer) =>
      newer.status === 'succeeded'
      && newer.kind === job.kind
      && newer.serverUrl === job.serverUrl
      && newer.profileId === job.profileId
      && newer.vaultId === job.vaultId,
    );
  });
}

export function MobileApp() {
  const [prefs, setPrefs] = useState<ThemePrefs>(() => {
    const initial = loadPrefs();
    applyTheme(initial);
    return initial;
  });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [viewDir, setViewDir] = useState<1 | -1>(1);
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const restore = useMobileStore((s) => s.restore);
  const refreshStatuses = useMobileStore((s) => s.refreshStatuses);
  const backgroundJobs = useMobileStore((s) => s.backgroundJobs);
  const servers = useMobileStore((s) => s.servers);
  const tab = useMobileStore((s) => s.tab);
  const setTab = useMobileStore((s) => s.setTab);
  const swipeTab = useMobileStore((s) => s.swipeTab);
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);

  const connectedCount = useMemo(
    () => Object.values(statuses).filter((status) => status.connected).length,
    [statuses],
  );
  const backgroundAttention = findBackgroundAttention(backgroundJobs, servers, statuses);

  useEffect(() => {
    restore()
      .then(() => {
        void notificationSyncRemote(mobileCalendarProfileId()).catch(() => {});
      })
      .catch((reason: unknown) => {
        setRestoreError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [restore]);

  // Keep connection status fresh when the app returns to the foreground, and
  // replay any offline-queued writes for still-connected servers (foreground
  // sync — Android may suspend background work, so this is the primary trigger).
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      void (async () => {
        await refreshStatuses().catch(() => {});
        const profileId = mobileCalendarProfileId();
        await notificationSyncRemote(profileId).catch(() => {});
        await reconcileAndroidBackground(profileId).catch(() => {});
        await requestAndroidBackgroundSync(profileId, false).catch(() => {});
        await useMobileStore.getState().refreshBackgroundJobs().catch(() => {});
      })();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshStatuses]);

  // Android hardware back / back-gesture handling. Native Android dispatches a
  // DOM event for every back press so the WebView history stack can never
  // accidentally finish the activity before app navigation has a say.
  const showExitConfirmRef = useRef(false);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    showExitConfirmRef.current = showExitConfirm;
  }, [showExitConfirm]);

  useEffect(() => {
    const onBack = () => {
      if (showExitConfirmRef.current) {
        setShowExitConfirm(false);
        return;
      }
      if (useMobileStore.getState().goBack()) {
        return;
      }
      setShowExitConfirm(true);
    };
    window.addEventListener('collab-android-back', onBack);
    return () => window.removeEventListener('collab-android-back', onBack);
  }, []);

  useEffect(() => {
    const openNotification = async (profileId: string, notificationId: string) => {
      const records = await notificationListInbox(profileId, true, 200);
      const record = records.find((candidate) => candidate.envelope.id === notificationId);
      if (!record) {
        setTab('settings');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('collab-settings-open-category', {
            detail: { category: 'notifications' },
          }));
        }, 0);
        return;
      }
      await notificationMarkRead(profileId, notificationId).catch(() => {});
      const destination = record.envelope.destination;
      if (destination.kind === 'calendar-item' || destination.kind === 'calendar-invitations') {
        setTab('calendar');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('collab-calendar-open-notification', {
            detail: destination,
          }));
        }, 0);
      } else if (destination.kind === 'vault-chat') {
        const state = useMobileStore.getState();
        const match = Object.entries(state.vaults)
          .flatMap(([serverUrl, vaults]) =>
            vaults.map((vault) => ({ serverUrl, vault })))
          .find(({ vault }) => vault.id === destination.vaultId);
        if (match) {
          await state.selectVault(match.serverUrl, match.vault);
          setTab('files');
        } else {
          setTab('settings');
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent('collab-settings-open-category', {
              detail: { category: 'notifications' },
            }));
          }, 0);
        }
      } else {
        setTab('settings');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('collab-settings-open-category', {
            detail: {
              category: destination.kind === 'settings'
                ? destination.section === 'background'
                  ? 'background'
                  : destination.section === 'servers'
                    ? 'account'
                    : 'notifications'
                : 'notifications',
            },
          }));
        }, 0);
      }
    };

    const onNotificationOpen = (event: Event) => {
      const detail = (event as CustomEvent<{
        profileId?: string;
        notificationId?: string;
      }>).detail;
      if (!detail?.profileId || !detail.notificationId) return;
      void notificationAndroidTakePendingOpen().catch(() => null);
      void openNotification(detail.profileId, detail.notificationId);
    };

    window.addEventListener('collab-notification-open', onNotificationOpen);
    void notificationAndroidTakePendingOpen()
      .then((pending) => {
        if (pending) void openNotification(pending.profileId, pending.notificationId);
      })
      .catch(() => {});
    return () => window.removeEventListener('collab-notification-open', onNotificationOpen);
  }, [setTab]);

  const updatePrefs = useCallback((next: ThemePrefs) => {
    setPrefs(next);
    applyTheme(next);
    savePrefs(next);
  }, []);

  const navigateToTab = useCallback(
    (next: Tab) => {
      if (next === tab) return;
      setViewDir(tabIndex(next) > tabIndex(tab) ? 1 : -1);
      setTab(next);
    },
    [setTab, tab],
  );

  const handleMainTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (event.touches.length !== 1) return;
    if (useMobileStore.getState().activeSheet) return;
    if (isInteractiveSwipeTarget(event.target)) return;
    const touch = event.touches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleMainTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start || event.changedTouches.length === 0) return;
      if (useMobileStore.getState().activeSheet) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < VIEW_SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      event.preventDefault();
      event.stopPropagation();
      setViewDir(dx < 0 ? 1 : -1);
      swipeTab(dx < 0 ? 1 : -1);
    },
    [swipeTab],
  );

  return (
    <div className="app-root">
      <main className="app-main" onTouchStart={handleMainTouchStart} onTouchEnd={handleMainTouchEnd}>
        {restoreError ? (
          <div className="screen-top-banner">
            <Banner tone="error">{restoreError}</Banner>
          </div>
        ) : null}
        {!restoreError && backgroundAttention ? (
          <div className="screen-top-banner">
            <Banner tone="error">
              {backgroundAttention.status === 'authentication_required'
                ? 'Background sync needs you to sign in again.'
                : 'Background sync no longer has permission to update some content.'}
            </Banner>
          </div>
        ) : null}

        <div key={tab} className={`main-view ${viewDir === 1 ? 'from-right' : 'from-left'}`}>
          {tab === 'servers' ? <ServersScreen onOpenServer={() => navigateToTab('vaults')} /> : null}
          {tab === 'vaults' ? <VaultsScreen /> : null}
          {tab === 'files' ? <FilesScreen prefs={prefs} /> : null}
          {tab === 'calendar' ? <CalendarScreen prefs={prefs} /> : null}
          {tab === 'settings' ? <SettingsScreen prefs={prefs} onChange={updatePrefs} /> : null}
        </div>
      </main>

      <nav className="tab-bar" aria-label="Primary">
        {TABS.map((item) => {
          const badge =
            item.id === 'servers' && connectedCount > 0
              ? connectedCount
              : item.id === 'files' && selected
                ? '•'
                : null;
          return (
            <button
              key={item.id}
              type="button"
              className={`tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => navigateToTab(item.id)}
            >
              <span className="tab-icon">
                {item.icon}
                {badge != null ? <span className="tab-badge">{badge}</span> : null}
              </span>
              <span className="tab-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {showExitConfirm ? (
        <ConfirmSheet
          title="Quit Collab?"
          message="Close the mobile companion app."
          confirmLabel="Quit"
          onCancel={() => setShowExitConfirm(false)}
          onConfirm={() => void mobileExitApp().catch(() => window.close())}
        />
      ) : null}
    </div>
  );
}
