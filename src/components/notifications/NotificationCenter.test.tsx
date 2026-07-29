import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../types/notification';

const mocks = vi.hoisted(() => ({
  listInbox: vi.fn(),
  syncRemote: vi.fn(),
  markRead: vi.fn(),
  dismiss: vi.fn(),
  snooze: vi.fn(),
  retry: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    notificationListInbox: mocks.listInbox,
    notificationSyncRemote: mocks.syncRemote,
    notificationMarkRead: mocks.markRead,
    notificationDismiss: mocks.dismiss,
    notificationSnooze: mocks.snooze,
    notificationRetry: mocks.retry,
  },
}));

import { useCollabStore } from '../../store/collabStore';
import NotificationCenter from './NotificationCenter';

const record: NotificationRecord = {
  envelope: {
    schemaVersion: 1,
    id: 'notice-1',
    category: 'calendar.reminder',
    kind: 'calendar.event-reminder',
    channel: 'calendar',
    accountKey: 'profile-1',
    sourceId: 'event-1',
    deliveryKey: 'reminder-1',
    createdAt: '2026-07-28T10:00:00Z',
    scheduledAt: '2026-07-28T10:05:00Z',
    title: 'Planning',
    privacy: 'title-only',
    priority: 'time-sensitive',
    destination: {
      kind: 'calendar-item',
      profileId: 'profile-1',
      calendarId: 'calendar-1',
      itemId: 'event-1',
    },
    actions: [{ kind: 'open' }, { kind: 'dismiss' }],
    requiresInbox: true,
  },
  state: 'delivered',
  updatedAt: '2026-07-28T10:05:00Z',
  deliveredAt: '2026-07-28T10:05:00Z',
  deliverySurface: 'native',
  attemptCount: 0,
};

describe('NotificationCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockResolvedValue(() => {});
    mocks.listInbox.mockResolvedValue([record]);
    mocks.syncRemote.mockResolvedValue([]);
    mocks.markRead.mockResolvedValue(undefined);
    mocks.dismiss.mockResolvedValue(undefined);
    useCollabStore.setState({ myUserId: 'profile-1' });
  });

  it('shows unread native inbox records and dismisses them', async () => {
    render(<NotificationCenter />);
    await waitFor(() => expect(mocks.syncRemote).toHaveBeenCalledWith('profile-1'));
    const trigger = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(trigger);
    expect(await screen.findByText('Planning')).not.toBeNull();

    mocks.listInbox.mockResolvedValue([]);
    fireEvent.click(screen.getByTitle('Dismiss'));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith('profile-1', 'notice-1'));
    await waitFor(() => expect(screen.queryByText('Planning')).toBeNull());
  });
});
