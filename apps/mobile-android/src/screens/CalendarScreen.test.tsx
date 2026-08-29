import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { calendarMirrorItemFingerprint } from '../../../../src/lib/calendarMirroring';
import type {
  CalendarDefinition,
  CalendarItem,
  CalendarMirrorGroup,
  CalendarOperationFailure,
} from '../../../../src/types/calendar';
import { DEFAULT_PREFS } from '../lib/theme';
import { useMobileStore } from '../state/store';

import { CalendarScreen } from './CalendarScreen';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const calendar: CalendarDefinition = {
  schemaVersion: 1,
  id: 'calendar-1',
  globalId: 'global-1',
  location: { kind: 'local' as const, profileId: 'profile-1' },
  name: 'Personal',
  color: '#a78bfa',
  defaultTimeZone: 'UTC',
  archived: false,
  readOnly: false,
  revision: 0,
  createdAt: '2026-07-23T08:00:00.000Z',
  updatedAt: '2026-07-23T08:00:00.000Z',
};

describe('mobile Calendar screen', () => {
  beforeEach(() => {
    localStorage.clear();
    useMobileStore.setState({
      statuses: {},
      calendarSyncing: false,
      calendarConflicts: [],
      calendarMirrorConflicts: [],
      calendarMirrorStatuses: [],
      calendarMirrorProgress: {},
      calendarSyncProgress: {},
      calendarSyncResults: [],
      calendarCacheOrigins: [],
      selected: null,
      files: [],
      vaults: {},
      tab: 'calendar',
      activeSheet: null,
      syncCalendars: vi.fn().mockResolvedValue(undefined),
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar]);
      if (command === 'calendar_list_items') return Promise.resolve([]);
      if (command === 'calendar_upsert_item' || command === 'calendar_acknowledge_operations')
        return Promise.resolve();
      return Promise.reject(new Error(`unhandled command ${command}`));
    });
  });

  it('creates timed events by default with reminder and durable operation metadata', async () => {
    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findByRole('button', { name: /Personal/ });

    fireEvent.click(screen.getByRole('button', { name: 'New calendar item' }));
    expect(screen.getByRole('switch', { name: 'All day' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Mobile planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'calendar_upsert_item',
        expect.objectContaining({
          item: expect.objectContaining({
            kind: 'event',
            title: 'Mobile planning',
            start: expect.objectContaining({ kind: 'dateTime' }),
            end: expect.objectContaining({ kind: 'dateTime' }),
            reminders: [{ kind: 'relative', minutesBefore: 10 }],
          }),
          operation: expect.objectContaining({
            mutation: expect.objectContaining({ type: 'upsertItem' }),
          }),
        }),
      ),
    );
    expect(invoke).toHaveBeenCalledWith('calendar_acknowledge_operations', expect.any(Object));
  });

  it('keeps month and day swipes inside Calendar and exposes Today', async () => {
    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    const content = document.querySelector('.mobile-calendar-content.view-month');
    expect(content).toBeTruthy();
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
    fireEvent.touchStart(content!, { touches: [{ clientX: 280, clientY: 260 }] });
    fireEvent.touchEnd(content!, { changedTouches: [{ clientX: 70, clientY: 262 }] });
    expect(
      await screen.findAllByText(
        new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(nextMonth),
      ),
    ).not.toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    const currentDay = document.querySelector<HTMLButtonElement>(
      '.calendar-mobile-grid [aria-current="date"]',
    );
    expect(currentDay).toBeTruthy();
    fireEvent.click(currentDay!);

    await waitFor(() =>
      expect(document.querySelector('.mobile-calendar-content.view-day')).toBeTruthy(),
    );
    const dayContent = document.querySelector('.mobile-calendar-content.view-day');
    expect(dayContent).toBeTruthy();
    fireEvent.touchStart(dayContent!, { touches: [{ clientX: 280, clientY: 260 }] });
    fireEvent.touchEnd(dayContent!, { changedTouches: [{ clientX: 70, clientY: 260 }] });
    expect(dayContent?.className).toContain('calendar-subview-next');
  });

  it('shows calendar items as compact month bars and opens them for editing', async () => {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const nextDay = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar]);
      if (command === 'calendar_list_items')
        return Promise.resolve([
          {
            id: 'event-1',
            uid: 'event-1@collab.test',
            calendarId: calendar.id,
            kind: 'event',
            title: 'Planning review with the team',
            start: { kind: 'date', date: day },
            end: { kind: 'date', date: nextDay },
            availability: 'busy',
            reminders: [],
            attendees: [],
            attachments: [],
            revision: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ]);
      if (command === 'calendar_upsert_item' || command === 'calendar_acknowledge_operations')
        return Promise.resolve();
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findAllByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    const entry = await screen.findByRole('button', { name: 'Planning review with the team' });
    expect(entry.className).toContain('calendar-mobile-entry');
    fireEvent.click(entry);
    expect(screen.getByRole('dialog', { name: 'Edit calendar item' })).toBeTruthy();
  });

  // The month grid buckets items by day once rather than testing every item
  // against every cell. These are the cases where the two could disagree.
  it('places multi-day, birthday, and task items on exactly the days they occur', async () => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar]);
      if (command === 'calendar_list_items')
        return Promise.resolve([
          {
            id: 'event-span',
            uid: 'event-span@collab.test',
            calendarId: calendar.id,
            kind: 'event',
            title: 'Offsite',
            // A timed event covering three days must appear on all three.
            start: { kind: 'dateTime', dateTime: `${month}-10T09:00:00.000Z`, timeZone: 'UTC' },
            end: { kind: 'dateTime', dateTime: `${month}-12T17:00:00.000Z`, timeZone: 'UTC' },
            availability: 'busy',
            reminders: [],
            attendees: [],
            attachments: [],
            revision: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          {
            id: 'birthday-1',
            uid: 'birthday-1@collab.test',
            calendarId: calendar.id,
            kind: 'birthday',
            title: 'Sam',
            // Birthdays match on month and day, ignoring the stored year.
            date: `1990-${month.slice(5)}-15`,
            reminders: [],
            revision: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          {
            id: 'task-1',
            uid: 'task-1@collab.test',
            calendarId: calendar.id,
            kind: 'task',
            title: 'File report',
            due: { kind: 'date', date: `${month}-20` },
            completed: false,
            reminders: [],
            revision: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ]);
      if (command === 'calendar_acknowledge_operations') return Promise.resolve();
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findAllByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    expect((await screen.findAllByRole('button', { name: 'Offsite' })).length).toBe(3);
    expect(screen.getAllByRole('button', { name: 'Sam' }).length).toBe(1);
    expect(screen.getAllByRole('button', { name: 'File report' }).length).toBe(1);
  });

  it('renders timed items in the vertical day timeline', async () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30);
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar]);
      if (command === 'calendar_list_items')
        return Promise.resolve([
          {
            id: 'timed-event-1',
            uid: 'timed-event-1@collab.test',
            calendarId: calendar.id,
            kind: 'event',
            title: 'Timeline planning',
            start: { kind: 'dateTime', dateTime: start.toISOString(), timeZone: 'UTC' },
            end: { kind: 'dateTime', dateTime: end.toISOString(), timeZone: 'UTC' },
            availability: 'busy',
            reminders: [],
            attendees: [],
            attachments: [],
            revision: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ]);
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findAllByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));

    const item = await screen.findByRole('button', { name: /Timeline planning/ });
    expect(item.className).toContain('calendar-mobile-timed-item');
    expect(document.querySelectorAll('.calendar-mobile-hour-line')).toHaveLength(24);

    const slots = screen.getAllByRole('button', { name: /Create event on .* at/ });
    fireEvent.click(slots[19]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Created from timeline' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'calendar_upsert_item',
        expect.objectContaining({
          item: expect.objectContaining({ title: 'Created from timeline' }),
        }),
      ),
    );
    const createCall = invoke.mock.calls.find(
      ([command, args]) =>
        command === 'calendar_upsert_item' &&
        (args as { item?: { title?: string } }).item?.title === 'Created from timeline',
    );
    const createdItem = (
      createCall?.[1] as { item: { start: { dateTime: string }; end: { dateTime: string } } }
    ).item;
    expect(new Date(createdItem.start.dateTime).getHours()).toBe(9);
    expect(new Date(createdItem.start.dateTime).getMinutes()).toBe(30);
    expect(new Date(createdItem.end.dateTime).getHours()).toBe(10);
    expect(new Date(createdItem.end.dateTime).getMinutes()).toBe(30);
  });

  it('shows three timed days and creates in the selected day column', async () => {
    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: '3 Day' }));

    expect(screen.getByRole('button', { name: 'Previous three days' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next three days' })).toBeTruthy();
    const slots = screen.getAllByRole('button', { name: /Create event on .* at/ });
    expect(slots).toHaveLength(144);

    fireEvent.click(slots[48 + 19]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Second day planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'calendar_upsert_item',
        expect.objectContaining({
          item: expect.objectContaining({ title: 'Second day planning' }),
        }),
      ),
    );
    const createCall = invoke.mock.calls.find(
      ([command, args]) =>
        command === 'calendar_upsert_item' &&
        (args as { item?: { title?: string } }).item?.title === 'Second day planning',
    );
    const createdStart = new Date(
      (createCall?.[1] as { item: { start: { dateTime: string } } }).item.start.dateTime,
    );
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(createdStart.getFullYear()).toBe(tomorrow.getFullYear());
    expect(createdStart.getMonth()).toBe(tomorrow.getMonth());
    expect(createdStart.getDate()).toBe(tomorrow.getDate());
    expect(createdStart.getHours()).toBe(9);
    expect(createdStart.getMinutes()).toBe(30);
  });

  it('creates, edits, archives, and restores a local calendar', async () => {
    let definitions = [{ ...calendar }];
    invoke.mockImplementation((command: string, args: { calendar?: CalendarDefinition }) => {
      if (command === 'calendar_list') return Promise.resolve(definitions);
      if (command === 'calendar_list_items') return Promise.resolve([]);
      if (command === 'calendar_save' && args.calendar) {
        const saved = args.calendar;
        definitions = [...definitions.filter((entry) => entry.id !== saved.id), saved];
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'Manage calendars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Calendar name' }), {
      target: { value: 'Work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const editWork = await screen.findByRole('button', { name: 'Edit Work' });
    fireEvent.click(editWork);
    fireEvent.change(screen.getByRole('textbox', { name: 'Calendar name' }), {
      target: { value: 'Work projects' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const archive = await screen.findByRole('button', { name: 'Archive Work projects' });
    fireEvent.click(archive);
    const restore = await screen.findByRole('button', { name: 'Restore Work projects' });
    fireEvent.click(restore);
    expect(await screen.findByRole('button', { name: 'Archive Work projects' })).toBeTruthy();
  });

  it('creates a calendar on a connected hosted server and caches it locally', async () => {
    let definitions = [{ ...calendar }];
    useMobileStore.setState({
      statuses: {
        'https://collab.example.com': {
          connected: true,
          serverUrl: 'https://collab.example.com',
          allowInvalidCertificates: false,
          user: { id: 'user-1', username: 'ada', displayName: 'Ada' },
          accessExpiresAt: null,
        },
      },
    });
    invoke.mockImplementation(
      (command: string, args: { calendar?: CalendarDefinition; body?: CalendarDefinition }) => {
        if (command === 'calendar_list') return Promise.resolve(definitions);
        if (command === 'calendar_list_items') return Promise.resolve([]);
        if (command === 'hosted_calendar_request' && args.body) {
          return Promise.resolve({
            ...args.body,
            id: 'hosted-calendar-1',
            globalId: 'hosted-global-1',
          });
        }
        if (command === 'calendar_save' && args.calendar) {
          definitions = [...definitions, args.calendar];
          return Promise.resolve();
        }
        return Promise.reject(new Error(`unhandled command ${command}`));
      },
    );

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'Manage calendars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    fireEvent.click(screen.getByRole('button', { name: /Server.*collab\.example\.com/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Calendar name' }), {
      target: { value: 'Hosted work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('button', { name: 'Edit Hosted work' })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith(
      'hosted_calendar_request',
      expect.objectContaining({
        serverUrl: 'https://collab.example.com',
        method: 'POST',
        path: '/api/v1/calendars',
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'calendar_save',
      expect.objectContaining({
        calendar: expect.objectContaining({
          id: 'hosted-calendar-1',
          location: expect.objectContaining({
            kind: 'hosted',
            serverUrl: 'https://collab.example.com',
          }),
        }),
      }),
    );
  });

  it('resolves a preserved mirror conflict from calendar management', async () => {
    const serverUrl = 'https://calendar.example.test';
    const hostedCalendar: CalendarDefinition = {
      ...calendar,
      id: 'hosted-calendar',
      globalId: 'hosted-global',
      name: 'Hosted',
      location: { kind: 'hosted', serverUrl, userId: 'user-1' },
    };
    const group: CalendarMirrorGroup = {
      schemaVersion: 1,
      id: 'mirror-1',
      name: 'Personal mirror',
      enabled: true,
      members: [
        {
          id: 'local-member',
          calendarId: calendar.id,
          location: calendar.location as Extract<CalendarDefinition['location'], { kind: 'local' }>,
          addedAt: calendar.createdAt,
        },
        {
          id: 'hosted-member',
          calendarId: hostedCalendar.id,
          location: hostedCalendar.location as Extract<
            CalendarDefinition['location'],
            { kind: 'hosted' }
          >,
          addedAt: calendar.createdAt,
        },
      ],
      createdAt: calendar.createdAt,
      updatedAt: calendar.updatedAt,
    };
    const source: CalendarItem = {
      id: 'local-item',
      uid: 'shared-item@collab.test',
      calendarId: calendar.id,
      kind: 'event',
      title: 'Keep local version',
      start: { kind: 'date', date: '2026-07-24' },
      end: { kind: 'date', date: '2026-07-25' },
      availability: 'busy',
      reminders: [],
      attendees: [],
      attachments: [],
      revision: 1,
      createdAt: calendar.createdAt,
      updatedAt: calendar.updatedAt,
    };
    const hosted = {
      ...source,
      id: 'hosted-item',
      calendarId: hostedCalendar.id,
      title: 'Hosted version',
    };
    const conflict = {
      id: 'mirror-conflict-1',
      groupId: group.id,
      logicalItemKey: `${source.uid}\u0000master`,
      status: 'unresolved' as const,
      versions: [
        {
          memberId: 'local-member',
          fingerprint: calendarMirrorItemFingerprint(source),
          item: source,
        },
        {
          memberId: 'hosted-member',
          fingerprint: calendarMirrorItemFingerprint(hosted),
          item: hosted,
        },
      ],
      detectedAt: calendar.updatedAt,
    };
    const syncCalendars = vi.fn().mockResolvedValue(undefined);
    useMobileStore.setState({
      statuses: {
        [serverUrl]: {
          connected: true,
          serverUrl,
          allowInvalidCertificates: false,
          accessExpiresAt: '2999-01-01T00:00:00.000Z',
          user: {
            id: 'user-1',
            username: 'alice',
            displayName: 'Alice',
          },
        },
      },
      calendarMirrorStatuses: [
        {
          groupId: group.id,
          state: 'conflict',
          missingMemberIds: [],
          conflictCount: 1,
        },
      ],
      calendarMirrorConflicts: [conflict],
      syncCalendars,
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar, hostedCalendar]);
      if (command === 'calendar_list_items' || command === 'calendar_list_mirror_items')
        return Promise.resolve([source, hosted]);
      if (command === 'calendar_list_mirror_groups') return Promise.resolve([group]);
      if (
        command === 'calendar_upsert_item' ||
        command === 'calendar_save_mirror_anchors' ||
        command === 'calendar_save_mirror_conflict'
      )
        return Promise.resolve();
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findAllByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'Manage calendars' }));
    const manager = await screen.findByRole('dialog', { name: 'Manage calendars' });
    fireEvent.click(await within(manager).findByRole('button', { name: /Keep local version/ }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'calendar_save_mirror_conflict',
        expect.objectContaining({
          conflict: expect.objectContaining({ id: conflict.id, status: 'resolved' }),
        }),
      ),
    );
    expect(syncCalendars).toHaveBeenCalled();
  });

  it('edits a recurring occurrence through the shared exception model', async () => {
    const today = new Date();
    today.setHours(9, 0, 0, 0);
    const master: CalendarItem = {
      id: 'series-1',
      uid: 'series-1@collab.test',
      calendarId: calendar.id,
      kind: 'event',
      title: 'Daily standup',
      start: { kind: 'dateTime', dateTime: today.toISOString(), timeZone: 'UTC' },
      end: {
        kind: 'dateTime',
        dateTime: new Date(today.getTime() + 30 * 60_000).toISOString(),
        timeZone: 'UTC',
      },
      availability: 'busy',
      recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
      reminders: [],
      attendees: [],
      attachments: [],
      revision: 2,
      createdAt: today.toISOString(),
      updatedAt: today.toISOString(),
    };
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar]);
      if (command === 'calendar_list_items') return Promise.resolve([master]);
      if (command === 'calendar_upsert_item' || command === 'calendar_acknowledge_operations')
        return Promise.resolve();
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    const entries = await screen.findAllByRole('button', { name: /Daily standup/ });
    fireEvent.click(entries[1]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Moved standup' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'calendar_upsert_item',
        expect.objectContaining({
          item: expect.objectContaining({
            title: 'Moved standup',
            recurrenceId: expect.objectContaining({ kind: 'dateTime' }),
            recurrenceSeriesId: 'series-1',
          }),
        }),
      ),
    );
  });

  it('offers retry and discard actions for failed calendar operations', async () => {
    const failure: CalendarOperationFailure = {
      operation: {
        clientOperationId: 'failed-op',
        deviceId: 'phone',
        mutation: {
          type: 'deleteItem',
          calendarId: calendar.id,
          itemId: 'event-1',
          deletedAt: new Date().toISOString(),
        },
      },
      attemptCount: 1,
      lastError: 'revision conflict',
      lastAttemptAt: new Date().toISOString(),
    };
    const syncCalendars = vi.fn().mockResolvedValue(undefined);
    useMobileStore.setState({ calendarConflicts: [failure], syncCalendars });
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar]);
      if (command === 'calendar_list_items') return Promise.resolve([]);
      if (command === 'calendar_retry_operation') return Promise.resolve();
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: /calendar change.*Review/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('calendar_retry_operation', {
        profileId: expect.any(String),
        clientOperationId: 'failed-op',
      }),
    );
    expect(syncCalendars).toHaveBeenCalled();
  });

  it('adds a hosted attendee and responds to server invitations', async () => {
    const hosted = {
      ...calendar,
      id: 'hosted-calendar',
      location: {
        kind: 'hosted' as const,
        serverUrl: 'https://collab.example.com',
        userId: 'user-1',
      },
    };
    useMobileStore.setState({
      statuses: {
        'https://collab.example.com': {
          connected: true,
          serverUrl: 'https://collab.example.com',
          allowInvalidCertificates: false,
          user: { id: 'user-1', username: 'ada', displayName: 'Ada' },
          accessExpiresAt: null,
        },
      },
    });
    invoke.mockImplementation((command: string, args: { path?: string }) => {
      if (command === 'calendar_list') return Promise.resolve([hosted]);
      if (command === 'calendar_list_items') return Promise.resolve([]);
      if (command === 'hosted_user_directory')
        return Promise.resolve([{ userId: 'user-2', username: 'grace', displayName: 'Grace' }]);
      if (command === 'calendar_upsert_item') return Promise.resolve();
      if (command === 'hosted_calendar_request' && args.path === '/api/v1/calendars/invitations')
        return Promise.resolve([
          {
            id: 'invitation-1',
            organizerUserId: 'user-2',
            attendeeUserId: 'user-1',
            attendeeId: 'attendee-1',
            response: 'needs-action',
            item: { id: 'invited-event', title: 'Server planning', kind: 'event' },
          },
        ]);
      if (command === 'hosted_calendar_request' && args.path?.endsWith('/response'))
        return Promise.resolve({});
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    await screen.findByRole('button', { name: /Personal/ });
    fireEvent.click(screen.getByRole('button', { name: 'New calendar item' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Hosted meeting' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search server users' }), {
      target: { value: 'gr' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Grace.*grace/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'calendar_upsert_item',
        expect.objectContaining({
          item: expect.objectContaining({
            attendees: [expect.objectContaining({ userId: 'user-2' })],
          }),
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Calendar invitations' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'hosted_calendar_request',
        expect.objectContaining({
          path: '/api/v1/calendars/invitations/invitation-1/response',
          body: { response: 'accepted' },
        }),
      ),
    );
  });

  it('opens an attached Kanban task at its actual card', async () => {
    const event: CalendarItem = {
      id: 'event-with-card',
      uid: 'event-with-card@collab.test',
      calendarId: calendar.id,
      kind: 'event',
      title: 'Review task',
      start: { kind: 'date', date: new Date().toISOString().slice(0, 10) },
      end: { kind: 'date', date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) },
      availability: 'busy',
      reminders: [],
      attendees: [],
      attachments: [
        {
          id: 'attachment-1',
          kind: 'kanbanTask',
          name: 'Ship release',
          serverUrl: 'https://collab.example.com',
          vaultId: 'vault-1',
          fileId: 'board-1',
          cardId: 'card-7',
        },
      ],
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    useMobileStore.setState({
      selected: {
        serverUrl: 'https://collab.example.com',
        vault: {
          id: 'vault-1',
          name: 'Work',
          role: 'editor',
          status: 'active',
          members: 1,
          storageBytes: 0,
          manifestSequence: 1,
          updatedAt: null,
          capabilities: [],
        },
      },
      files: [
        {
          id: 'board-1',
          parentId: null,
          name: 'Roadmap.kanban',
          relativePath: 'Roadmap.kanban',
          kind: 'document',
          documentType: 'kanban',
          state: 'active',
          updatedAt: null,
          sizeBytes: null,
          contentHash: null,
          revisionSequence: 1,
        },
      ],
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([calendar]);
      if (command === 'calendar_list_items') return Promise.resolve([event]);
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Review task/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Ship releaseKanban task$/ }));

    expect(useMobileStore.getState().tab).toBe('files');
    expect(useMobileStore.getState().activeSheet).toEqual({
      kind: 'kanban',
      fileId: 'board-1',
      cardId: 'card-7',
    });
  });

  it('writes generated hosted task completion through to its Kanban card', async () => {
    const generatedCalendar: CalendarDefinition = {
      ...calendar,
      id: 'kanban-calendar',
      globalId: 'kanban-calendar',
      location: { kind: 'kanban', originKey: 'https://collab.example::vault-1' },
      name: 'Assigned tasks · Project',
      readOnly: true,
    };
    const task: CalendarItem = {
      id: 'generated-task',
      uid: 'kanban:vault-1:board-1:card-1',
      calendarId: generatedCalendar.id,
      kind: 'task',
      title: 'Ship release',
      reminders: [],
      attendees: [],
      attachments: [],
      due: { kind: 'date', date: new Date().toISOString().slice(0, 10) },
      status: 'needs-action',
      sourceBinding: {
        kind: 'kanban',
        serverUrl: 'https://collab.example',
        vaultId: 'vault-1',
        fileId: 'board-1',
        cardId: 'card-1',
        sourceRevision: 7,
      },
      revision: 7,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    invoke.mockImplementation((command: string) => {
      if (command === 'calendar_list') return Promise.resolve([generatedCalendar]);
      if (command === 'calendar_list_items') return Promise.resolve([task]);
      if (command === 'hosted_vault_request') return Promise.resolve({});
      return Promise.reject(new Error(`unhandled command ${command}`));
    });

    render(<CalendarScreen prefs={DEFAULT_PREFS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Ship release/ }));
    fireEvent.click(screen.getByRole('button', { name: 'completed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'hosted_vault_request',
        expect.objectContaining({
          serverUrl: 'https://collab.example',
          method: 'POST',
          path: '/api/v1/vaults/vault-1/files/board-1/kanban-cards/card-1/calendar',
          body: expect.objectContaining({
            expectedSourceRevision: 7,
            completed: true,
          }),
        }),
      ),
    );
    expect(invoke).not.toHaveBeenCalledWith('calendar_upsert_item', expect.anything());
  });
});
