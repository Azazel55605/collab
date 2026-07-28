import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  request: vi.fn(),
  sendTest: vi.fn(),
  preferencesGet: vi.fn(),
  preferencesSave: vi.fn(),
  calendarList: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    notificationPermissionStatus: mocks.status,
    notificationRequestPermission: mocks.request,
    notificationSendTest: mocks.sendTest,
    notificationPreferencesGet: mocks.preferencesGet,
    notificationPreferencesSave: mocks.preferencesSave,
    calendarList: mocks.calendarList,
  },
}));

import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../lib/notificationContract';
import { useCollabStore } from '../../store/collabStore';
import SettingsNotificationsSection from './SettingsNotificationsSection';

describe('SettingsNotificationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status.mockResolvedValue({ status: 'prompt', supported: true });
    mocks.request.mockResolvedValue({ status: 'granted', supported: true });
    mocks.sendTest.mockResolvedValue(undefined);
    mocks.preferencesGet.mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);
    mocks.preferencesSave.mockImplementation(async (_profileId, preferences) => preferences);
    mocks.calendarList.mockResolvedValue([]);
    useCollabStore.setState({ myUserId: 'profile-1' });
  });

  it('requests permission and enables test delivery', async () => {
    render(<SettingsNotificationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Send test' }));
    await waitFor(() => expect(mocks.sendTest).toHaveBeenCalled());
  });

  it('persists category and quiet-hour preferences for the active profile', async () => {
    render(<SettingsNotificationsSection />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Chat messages' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Enable quiet hours' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(mocks.preferencesSave).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({
        categoryEnabled: expect.objectContaining({ 'collaboration.message': false }),
        quietHours: expect.objectContaining({ startMinute: 1320, endMinute: 420 }),
      }),
    ));
  });

  it('persists a calendar source override', async () => {
    mocks.calendarList.mockResolvedValue([{
      schemaVersion: 1,
      id: 'calendar-1',
      globalId: 'calendar-global-1',
      location: { kind: 'local', profileId: 'profile-1' },
      name: 'Personal',
      color: '#a855f7',
      defaultTimeZone: 'Europe/Berlin',
      archived: false,
      readOnly: false,
      revision: 1,
      createdAt: '2026-07-28T00:00:00Z',
      updatedAt: '2026-07-28T00:00:00Z',
    }]);
    render(<SettingsNotificationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Calendars/ }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Personal notifications' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(mocks.preferencesSave).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({
        scopeEnabled: { 'calendar:calendar-1': false },
      }),
    ));
  });
});
