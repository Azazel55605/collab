import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarDefinition, CalendarMirrorGroup } from '../../types/calendar';
import { useCalendarStore } from '../../store/calendarStore';
import { useServerStore } from '../../store/serverStore';
import { useUiStore } from '../../store/uiStore';
import CalendarSyncStatusIndicator from './CalendarSyncStatusIndicator';

const serverUrl = 'https://calendar.example.test';
const hostedLocation = { kind: 'hosted' as const, serverUrl, userId: 'user-1' };
const localLocation = { kind: 'local' as const, profileId: 'profile-1' };
const hostedCalendar: CalendarDefinition = {
  schemaVersion: 1,
  id: 'hosted-calendar',
  globalId: 'hosted-global',
  location: hostedLocation,
  name: 'Hosted',
  color: '#60a5fa',
  defaultTimeZone: 'UTC',
  archived: false,
  readOnly: false,
  revision: 0,
  createdAt: '2026-07-24T08:00:00.000Z',
  updatedAt: '2026-07-24T08:00:00.000Z',
};
const group: CalendarMirrorGroup = {
  schemaVersion: 1,
  id: 'mirror-1',
  name: 'Personal mirror',
  enabled: true,
  members: [
    { id: 'local-member', calendarId: 'local-calendar', location: localLocation, addedAt: '2026-07-24T08:00:00.000Z' },
    { id: 'hosted-member', calendarId: hostedCalendar.id, location: hostedLocation, addedAt: '2026-07-24T08:00:00.000Z' },
  ],
  createdAt: '2026-07-24T08:00:00.000Z',
  updatedAt: '2026-07-24T08:00:00.000Z',
};

const syncHosted = vi.fn().mockResolvedValue([]);

beforeEach(() => {
  vi.clearAllMocks();
  useServerStore.setState({
    connections: {
      [serverUrl]: {
        status: {
          connected: true,
          serverUrl,
          allowInvalidCertificates: false,
          user: {
            id: 'user-1',
            username: 'alice',
            displayName: 'Alice',
            role: 'member',
            status: 'active',
          },
        },
        hostedVaults: [],
      },
    },
  } as never);
  useCalendarStore.setState({
    calendars: [hostedCalendar],
    syncResults: [],
    syncProgress: {},
    conflicts: [],
    mirrorGroups: [group],
    mirrorConflicts: [],
    mirrorStatuses: [],
    mirrorProgress: {},
    syncing: false,
    syncHosted,
  });
  useUiStore.setState({ activeView: 'editor' });
});

describe('CalendarSyncStatusIndicator mirrors', () => {
  it('shows waiting groups in the global calendar sync menu', () => {
    useCalendarStore.setState({
      mirrorStatuses: [{
        groupId: group.id,
        state: 'waiting',
        missingMemberIds: ['hosted-member'],
        conflictCount: 0,
      }],
    });
    render(<CalendarSyncStatusIndicator />);

    fireEvent.click(screen.getByText('1 mirror waiting'));
    expect(screen.getByText('Personal mirror')).toBeTruthy();
    expect(screen.getByText('Waiting for every server connection')).toBeTruthy();
  });

  it('shows operation progress and retries an isolated mirror error', async () => {
    useCalendarStore.setState({
      mirrorStatuses: [{
        groupId: group.id,
        state: 'error',
        missingMemberIds: [],
        conflictCount: 0,
        error: 'temporary write failure',
      }],
      mirrorProgress: {
        [group.id]: {
          groupId: group.id,
          groupName: group.name,
          phase: 'error',
          processedOperations: 1,
          totalOperations: 2,
          error: 'temporary write failure',
        },
      },
    });
    render(<CalendarSyncStatusIndicator />);

    fireEvent.click(screen.getByText('1 calendar issue'));
    expect(screen.getByText('temporary write failure')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Retry mirror sync'));
    await waitFor(() => expect(syncHosted).toHaveBeenCalledWith([
      { serverUrl, userId: 'user-1' },
    ]));
  });

  it('opens Calendar to resolve preserved mirror conflicts', () => {
    useCalendarStore.setState({
      mirrorStatuses: [{
        groupId: group.id,
        state: 'conflict',
        missingMemberIds: [],
        conflictCount: 1,
      }],
      mirrorConflicts: [{
        id: 'conflict-1',
        groupId: group.id,
        logicalItemKey: 'item-key',
        status: 'unresolved',
        versions: [],
        detectedAt: '2026-07-24T08:00:00.000Z',
      }],
    });
    render(<CalendarSyncStatusIndicator />);

    fireEvent.click(screen.getByText('1 calendar conflict'));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(useUiStore.getState().activeView).toBe('calendar');
  });
});
