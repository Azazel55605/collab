import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackgroundSettings, tauriCommands } from '../../lib/tauri';

import SettingsBackgroundSection from './SettingsBackgroundSection';

const settings: BackgroundSettings = {
  schemaVersion: 1,
  runInBackground: false,
  backgroundSync: true,
  syncInterval: 'system_managed',
  startAtLogin: false,
  closeBehavior: 'hide_to_tray',
  paused: false,
  onlyUnmeteredNetworks: false,
  requireCharging: false,
  pauseOnLowBattery: true,
  allowRoaming: true,
};

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    backgroundSettingsGet: vi.fn(),
    backgroundSettingsSave: vi.fn(),
    backgroundSyncRegistered: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('SettingsBackgroundSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriCommands.backgroundSettingsGet).mockResolvedValue(settings);
    vi.mocked(tauriCommands.backgroundSettingsSave).mockImplementation(async (next) => next);
    vi.mocked(tauriCommands.backgroundSyncRegistered).mockResolvedValue([]);
  });

  it('persists the opt-in before enabling dependent controls', async () => {
    render(<SettingsBackgroundSection />);

    const switches = await screen.findAllByRole('switch');
    expect(switches[1].hasAttribute('disabled')).toBe(true);
    fireEvent.click(switches[0]);

    await waitFor(() => {
      expect(tauriCommands.backgroundSettingsSave).toHaveBeenCalledWith({
        ...settings,
        runInBackground: true,
      });
    });
    expect(screen.getAllByRole('switch')[1].hasAttribute('disabled')).toBe(false);
  });
});
