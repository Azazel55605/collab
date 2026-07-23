import { CalendarDays, Cloud, FolderOpen, Library, Settings as SettingsIcon } from 'lucide-react';
import type { ReactNode, TouchEvent as ReactTouchEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Banner, ConfirmSheet } from './components/ui';
import { mobileExitApp } from './mobileTauri';
import { applyTheme, loadPrefs, savePrefs, type ThemePrefs } from './lib/theme';
import { FilesScreen } from './screens/FilesScreen';
import { ServersScreen } from './screens/ServersScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { VaultsScreen } from './screens/VaultsScreen';
import { CalendarScreen } from './screens/CalendarScreen';
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
  const syncServer = useMobileStore((s) => s.syncServer);
  const syncCalendars = useMobileStore((s) => s.syncCalendars);
  const tab = useMobileStore((s) => s.tab);
  const setTab = useMobileStore((s) => s.setTab);
  const swipeTab = useMobileStore((s) => s.swipeTab);
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);

  const connectedCount = useMemo(
    () => Object.values(statuses).filter((status) => status.connected).length,
    [statuses],
  );

  useEffect(() => {
    restore().catch((reason: unknown) => {
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
        const { statuses: current, syncServer: sync } = useMobileStore.getState();
        await Promise.all(
          Object.values(current)
            .filter((status) => status.connected && status.serverUrl)
            .map((status) => sync(status.serverUrl as string).catch(() => {})),
        );
        await useMobileStore.getState().syncCalendars().catch(() => {});
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
  }, [refreshStatuses, syncCalendars, syncServer]);

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
