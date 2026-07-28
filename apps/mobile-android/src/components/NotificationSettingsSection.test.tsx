import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('../lib/calendarSync', () => ({
  mobileCalendarProfileId: () => 'profile-1',
}));

import { NotificationSettingsSection } from './NotificationSettingsSection';

describe('NotificationSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionStatus.mockResolvedValue({ status: 'prompt', supported: true });
    mocks.exactStatus.mockResolvedValue({ status: 'fallback', supported: true });
    mocks.listInbox.mockResolvedValue([]);
    mocks.requestPermission.mockResolvedValue({ status: 'prompt', supported: true });
    mocks.openExactSettings.mockResolvedValue(undefined);
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
    mocks.listInbox.mockResolvedValue([{
      envelope: {
        id: 'notice-1',
        category: 'calendar.reminder',
        title: 'Planning',
        body: 'Weekly planning',
        scheduledAt: '2026-07-28T12:00:00Z',
        createdAt: '2026-07-28T11:00:00Z',
      },
      state: 'delivered',
    }]);
    mocks.snooze.mockResolvedValue({});

    render(<NotificationSettingsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze Planning' }));

    await waitFor(() => {
      expect(mocks.snooze).toHaveBeenCalledWith('profile-1', 'notice-1', 10);
    });
    expect(mocks.reconcile).toHaveBeenCalledWith('profile-1');
  });
});
