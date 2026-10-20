import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { useUiStore } from '../../store/uiStore';

import { SettingsModalHost } from './SettingsModalHost';

const load = vi.hoisted(() => ({ started: vi.fn(), finish: (() => {}) as () => void }));
vi.mock('./SettingsModal', async () => {
  load.started();
  await new Promise<void>((resolve) => {
    load.finish = resolve;
  });
  return {
    default: ({ requestedTab }: { requestedTab: string }) => (
      <div>Settings tab: {requestedTab}</div>
    ),
  };
});

it('keeps the latest requested tab while Settings loads and clears it when closed', async () => {
  useUiStore.setState({ isSettingsOpen: false });
  render(<SettingsModalHost />);
  expect(load.started).not.toHaveBeenCalled();
  act(() => useUiStore.getState().openSettings());
  await waitFor(() => expect(load.started).toHaveBeenCalledOnce());
  act(() => {
    window.dispatchEvent(new CustomEvent('settings:open-tab', { detail: { tab: 'editor' } }));
    window.dispatchEvent(new CustomEvent('settings:open-tab', { detail: { tab: 'profile' } }));
  });
  await act(async () => {
    load.finish();
  });
  expect(await screen.findByText('Settings tab: profile')).toBeTruthy();
  act(() => useUiStore.getState().closeSettings());
  expect(screen.queryByText('Settings tab: profile')).toBeNull();
  act(() =>
    window.dispatchEvent(new CustomEvent('settings:open-tab', { detail: { tab: 'profile' } })),
  );
  act(() => useUiStore.getState().openSettings());
  expect(await screen.findByText('Settings tab:')).toBeTruthy();
});
