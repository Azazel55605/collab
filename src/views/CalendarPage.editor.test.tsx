import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createCalendarDefinition, normalizeCalendarItem } from '../types/calendar';
import { CalendarRail, CalendarSearch, CalendarSettingsDialog, ItemEditorDialog } from './CalendarPage';

describe('calendar item editor', () => {
  it('keeps draft fields when calendar store updates preserve the same default calendar', () => {
    const calendar = createCalendarDefinition({
      id: 'calendar-1',
      location: { kind: 'local', profileId: 'profile-1' },
      name: 'Personal',
      color: '#a78bfa',
      defaultTimeZone: 'Europe/Berlin',
      now: '2026-07-23T08:00:00.000Z',
    });
    const request = { date: '2026-07-23', kind: 'event' as const };
    const props = {
      request,
      onOpenChange: vi.fn(),
      saving: false,
      onSave: vi.fn(),
    };
    const { rerender } = render(<ItemEditorDialog {...props} calendars={[calendar]} />);
    const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;

    fireEvent.change(title, { target: { value: 'Draft planning event' } });
    rerender(
      <ItemEditorDialog
        {...props}
        saving
        calendars={[{ ...calendar, updatedAt: '2026-07-23T08:01:00.000Z' }]}
      />,
    );

    expect(title.value).toBe('Draft planning event');
  });

  it('preserves task metadata and typed attachments when editing', async () => {
    const calendar = createCalendarDefinition({
      id: 'calendar-1',
      location: { kind: 'local', profileId: 'profile-1' },
      name: 'Personal',
      color: '#a78bfa',
      defaultTimeZone: 'UTC',
      now: '2026-07-23T08:00:00.000Z',
    });
    const task = normalizeCalendarItem({
      id: 'task-1',
      uid: 'task-1@collab.local',
      calendarId: calendar.id,
      kind: 'task',
      title: 'Review board',
      reminders: [],
      attendees: [],
      attachments: [{ id: 'attachment-1', kind: 'kanbanTask', name: 'Planning card', fileId: 'board-1', cardId: 'card-1' }],
      start: { kind: 'date', date: '2026-07-23' },
      due: { kind: 'date', date: '2026-07-24' },
      status: 'in-progress',
      priority: 'high',
      revision: 2,
      createdAt: '2026-07-23T08:00:00.000Z',
      updatedAt: '2026-07-23T08:00:00.000Z',
    });
    const onSave = vi.fn().mockImplementation(async (item) => item);
    render(<ItemEditorDialog
      request={{ date: '2026-07-23', kind: 'task', item: task }}
      onOpenChange={vi.fn()}
      calendars={[calendar]}
      saving={false}
      onSave={onSave}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      status: 'in-progress',
      priority: 'high',
      attachments: task.attachments,
    });
  });
});

describe('calendar management', () => {
  const localCalendar = createCalendarDefinition({
    id: 'calendar-1',
    location: { kind: 'local', profileId: 'profile-1' },
    name: 'Personal',
    color: '#a78bfa',
    defaultTimeZone: 'Europe/Berlin',
    now: '2026-07-23T08:00:00.000Z',
  });

  it('keeps archived calendars recoverable from the calendar rail', () => {
    const archived = { ...localCalendar, id: 'calendar-2', name: 'Archive', archived: true };
    const onArchive = vi.fn();
    render(<CalendarRail
      calendars={[localCalendar, archived]}
      subscriptions={[]}
      visibleIds={[localCalendar.id]}
      saving={false}
      mirrorAttention={false}
      onVisible={vi.fn()}
      onAdd={vi.fn()}
      onSubscribe={vi.fn()}
      onMirrors={vi.fn()}
      onEdit={vi.fn()}
      onImport={vi.fn()}
      onExport={vi.fn()}
      onPublish={vi.fn()}
      onRefreshSubscription={vi.fn()}
      onDeleteSubscription={vi.fn()}
      onArchive={onArchive}
    />);

    expect((screen.getByRole('checkbox', { name: 'Personal' }) as HTMLButtonElement).dataset.state).toBe('checked');
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archive' }));
    expect(onArchive).toHaveBeenCalledWith(archived, false);
  });

  it('edits calendar identity without duplicating application time-zone settings', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CalendarSettingsDialog
      calendar={localCalendar}
      saving={false}
      onOpenChange={vi.fn()}
      onSave={onSave}
    />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Private' },
    });
    expect(screen.queryByRole('textbox', { name: 'Default time zone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use color #60a5fa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(localCalendar.id, {
      name: 'Private',
      color: '#60a5fa',
    }));
  });

  it('shows bounded search results with calendar origin context', () => {
    const result = normalizeCalendarItem({
      id: 'event-1',
      uid: 'event-1@collab.local',
      calendarId: localCalendar.id,
      kind: 'event',
      title: 'Planning',
      reminders: [],
      start: { kind: 'date', date: '2026-07-23' },
      end: { kind: 'date', date: '2026-07-24' },
      availability: 'busy',
      revision: 0,
      createdAt: '2026-07-23T08:00:00.000Z',
      updatedAt: '2026-07-23T08:00:00.000Z',
    });
    const onOpenItem = vi.fn();
    render(<CalendarSearch
      open
      onOpenChange={vi.fn()}
      query="plan"
      onQueryChange={vi.fn()}
      results={[result]}
      searching={false}
      calendarById={new Map([[localCalendar.id, localCalendar]])}
      onOpenItem={onOpenItem}
    />);

    fireEvent.click(screen.getByRole('button', { name: /Planning/ }));
    expect(onOpenItem).toHaveBeenCalledWith(result);
    expect(screen.getByText(/Personal · Local/)).toBeTruthy();
  });
});
