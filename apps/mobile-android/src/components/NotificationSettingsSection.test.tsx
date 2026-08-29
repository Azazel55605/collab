import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationSettingsSection } from './NotificationSettingsSection';

const mocks = vi.hoisted(() => ({
  permissionStatus: vi.fn(),
  exactStatus: vi.fn(),
  listInbox: vi.fn(),
  reconcile: vi.fn(),
  requestPermission: vi.fn(),
  sendTest: vi.fn(),
  openExactSettings: vi.fn(),
  markRead: vi.fn(),
  dismiss: vi.fn(),
  snooze: vi.fn(),
  retry: vi.fn(),
  preferencesGet: vi.fn(),
  preferencesSave: vi.fn(),
  listCalendars: vi.fn(),
}));

vi.mock('../mobileTauri', () => ({
  notificationPermissionStatus: mocks.permissionStatus,
  notificationAndroidExactAlarmStatus: mocks.exactStatus,
  notificationListInbox: mocks.listInbox,
  notificationReconcilePlatformSchedule: mocks.reconcile,
  notificationRequestPermission: mocks.requestPermission,
  notificationSendTest: mocks.sendTest,
  notificationAndroidOpenExactAlarmSettings: mocks.openExactSettings,
  notificationMarkRead: mocks.markRead,
  notificationDismiss: mocks.dismiss,
  notificationSnooze: mocks.snooze,
  notificationRetry: mocks.retry,
  notificationPreferencesGet: mocks.preferencesGet,
  notificationPreferencesSave: mocks.preferencesSave,
  listProfileCalendars: mocks.listCalendars,
}));

vi.mock('../lib/calendarSync', () => ({
  mobileCalendarProfileId: () => 'profile-1',
}));

describe('NotificationSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionStatus.mockResolvedValue({ status: 'prompt', supported: true });
    mocks.exactStatus.mockResolvedValue({ status: 'fallback', supported: true });
    mocks.listInbox.mockResolvedValue([]);
    mocks.requestPermission.mockResolvedValue({ status: 'prompt', supported: true });
    mocks.openExactSettings.mockResolvedValue(undefined);
    mocks.preferencesGet.mockResolvedValue({
      enabled: true,
      lockScreenPrivacy: 'title-only',
      categoryEnabled: {
        'calendar.reminder': true,
        'calendar.invitation': true,
        'collaboration.message': true,
        'collaboration.mention': true,
        'sync.action-required': true,
        'transfer.complete': true,
      },
      scopeEnabled: {},
      quietHours: null,
      allowTimeSensitiveDuringQuietHours: true,
      batchNotifications: true,
    });
    mocks.preferencesSave.mockImplementation(async (_profileId, preferences) => preferences);
    mocks.listCalendars.mockResolvedValue([]);
  });

  it('recovers Android permission and exact-alarm settings', async () => {
    render(<NotificationSettingsSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Enable notifications' }));
    await waitFor(() => expect(mocks.requestPermission).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: 'Open alarm settings' }));
    await waitFor(() => expect(mocks.openExactSettings).toHaveBeenCalled());
  });

  it('shows the durable inbox and snoozes a calendar reminder', async () => {
    mocks.permissionStatus.mockResolvedValue({ status: 'granted', supported: true });
    mocks.exactStatus.mockResolvedValue({ status: 'granted', supported: true });
    mocks.listInbox.mockResolvedValue([
      {
        envelope: {
          id: 'notice-1',
          category: 'calendar.reminder',
          title: 'Planning',
          body: 'Weekly planning',
          scheduledAt: '2026-07-28T12:00:00Z',
          createdAt: '2026-07-28T11:00:00Z',
        },
        state: 'delivered',
      },
    ]);
    mocks.snooze.mockResolvedValue({});

    render(<NotificationSettingsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze Planning' }));

    await waitFor(() => {
      expect(mocks.snooze).toHaveBeenCalledWith('profile-1', 'notice-1', 10);
    });
    expect(mocks.reconcile).toHaveBeenCalledWith('profile-1');
  });

  it('persists a calendar source override', async () => {
    mocks.listCalendars.mockResolvedValue([
      {
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
      },
    ]);
    render(<NotificationSettingsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Calendars/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Personal notifications' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save notification preferences' }));

    await waitFor(() =>
      expect(mocks.preferencesSave).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({
          scopeEnabled: { 'calendar:calendar-1': false },
        }),
      ),
    );
  });
});
