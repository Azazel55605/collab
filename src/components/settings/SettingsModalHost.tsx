import { type ComponentProps, useEffect, useState } from 'react';

import { useUiStore } from '../../store/uiStore';
import { DeferredModalStatus } from '../layout/DeferredModalStatus';
import { deferredView } from '../layout/deferredView';

const close = () => useUiStore.getState().closeSettings();
const Settings = deferredView<
  NonNullable<ComponentProps<typeof import('./SettingsModal').default>>
>(() => import('./SettingsModal'), {
  loading: <DeferredModalStatus title="Settings" close={close} />,
  error: <DeferredModalStatus title="Settings" close={close} failed />,
});

/** Capture tab requests even while the first Settings import is pending. */
export function SettingsModalHost() {
  const open = useUiStore((state) => state.isSettingsOpen);
  const [requestedTab, setRequestedTab] = useState<string | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      if (!useUiStore.getState().isSettingsOpen) return;
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      if (typeof tab === 'string') setRequestedTab(tab);
    };
    window.addEventListener('settings:open-tab', listener);
    return () => window.removeEventListener('settings:open-tab', listener);
  }, []);
  useEffect(() => {
    if (!open) setRequestedTab(null);
  }, [open]);
  return open ? <Settings requestedTab={requestedTab} /> : null;
}
