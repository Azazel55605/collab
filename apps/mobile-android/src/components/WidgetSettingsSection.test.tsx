import { act } from 'react';

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WidgetSettingsSection } from './WidgetSettingsSection';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const configuration = {
  schemaVersion: 1,
  configurationId: 'widget-config-1',
  kind: 'agenda',
  selectedSourceIds: [],
  selectedItemIds: [],
  privacy: 'full',
  display: { horizonDays: 7, maxItems: 6, showCompleted: false },
  actions: { openItem: true, toggleTask: false },
  updatedAt: '2026-08-01T10:00:00Z',
};

const diagnostics = {
  schemaVersion: 1,
  configurationId: 'widget-config-1',
  lastAttemptAt: '2026-08-01T10:01:00Z',
  lastSuccessAt: '2026-08-01T10:01:00Z',
  updateCause: 'settings',
  generationDurationMs: 12,
  serializedBytes: 2048,
  itemCount: 4,
  truncated: false,
  freshSources: 2,
  staleSources: 0,
  unavailableSources: 0,
};

describe('mobile widget settings', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'widget_active_profile_set') return Promise.resolve(undefined);
      if (command === 'widget_configuration_list') return Promise.resolve([configuration]);
      if (command === 'widget_diagnostics_list') return Promise.resolve([diagnostics]);
      if (command === 'widget_refresh')
        return Promise.resolve([{ ...diagnostics, updateCause: 'manual' }]);
      if (command === 'calendar_list') {
        return Promise.resolve([
          { id: 'calendar-a', name: 'Personal', archived: false, deletedAt: null },
          { id: 'calendar-b', name: 'Work', archived: false, deletedAt: null },
        ]);
      }
      if (command === 'calendar_list_items') return Promise.resolve([]);
      if (command === 'widget_configuration_save') {
        return Promise.resolve((args as { configuration: typeof configuration }).configuration);
      }
      if (command === 'widget_configuration_delete') return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it('loads native configurations and persists privacy and source selection', async () => {
    render(<WidgetSettingsSection />);

    expect(await screen.findByText('Agenda 1')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Titles only' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'widget_configuration_save',
        expect.objectContaining({
          configuration: expect.objectContaining({ privacy: 'titleOnly' }),
        }),
      );
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Work' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'widget_configuration_save',
        expect.objectContaining({
          configuration: expect.objectContaining({ selectedSourceIds: ['calendar-a'] }),
        }),
      );
    });
  });

  it('serializes rapid changes and keeps the newest setting selected', async () => {
    let resolveFirstSave: ((value: typeof configuration) => void) | undefined;
    const savedPrivacy: string[] = [];
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'widget_active_profile_set') return Promise.resolve(undefined);
      if (command === 'widget_configuration_list') return Promise.resolve([configuration]);
      if (command === 'widget_diagnostics_list') return Promise.resolve([diagnostics]);
      if (command === 'calendar_list') return Promise.resolve([]);
      if (command === 'calendar_list_items') return Promise.resolve([]);
      if (command === 'widget_configuration_save') {
        const next = (args as { configuration: typeof configuration }).configuration;
        savedPrivacy.push(next.privacy);
        if (savedPrivacy.length === 1) {
          return new Promise((resolve) => {
            resolveFirstSave = resolve;
          });
        }
        return Promise.resolve(next);
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<WidgetSettingsSection />);
    expect(await screen.findByText('Agenda 1')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Titles only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Private' }));

    await waitFor(() => expect(savedPrivacy).toEqual(['titleOnly']));
    await act(async () => resolveFirstSave?.({ ...configuration, privacy: 'titleOnly' }));
    await waitFor(() => expect(savedPrivacy).toEqual(['titleOnly', 'private']));
    expect(screen.getByRole('button', { name: 'Private' }).className).toContain('selected');
  });

  it('persists the ten-item launcher option', async () => {
    render(<WidgetSettingsSection />);
    expect(await screen.findByText('Agenda 1')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '10' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'widget_configuration_save',
        expect.objectContaining({
          configuration: expect.objectContaining({
            display: expect.objectContaining({ maxItems: 10 }),
          }),
        }),
      );
    });
  });

  it('shows privacy-safe status and supports manual refresh', async () => {
    render(<WidgetSettingsSection />);
    expect(await screen.findByText(/4 items · 2 KB · 12 ms/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh widgets' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('widget_refresh', { profileId: expect.any(String) });
    });
    expect(screen.getByText(/Updated/)).not.toBeNull();
    expect(screen.getByText(/touch and hold it on the home screen/)).not.toBeNull();
  });

  it('persists explicit countdown event selection', async () => {
    const countdown = { ...configuration, kind: 'countdown', selectedItemIds: [] } as const;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'widget_active_profile_set') return Promise.resolve(undefined);
      if (command === 'widget_configuration_list') return Promise.resolve([countdown]);
      if (command === 'widget_diagnostics_list') return Promise.resolve([diagnostics]);
      if (command === 'calendar_list') return Promise.resolve([]);
      if (command === 'calendar_list_items') {
        return Promise.resolve([
          {
            id: 'event-1',
            uid: 'event-1',
            calendarId: 'calendar-a',
            kind: 'event',
            title: 'Release day',
            start: { kind: 'date', date: '2026-08-20' },
            end: { kind: 'date', date: '2026-08-21' },
          },
        ]);
      }
      if (command === 'widget_configuration_save') {
        return Promise.resolve((args as { configuration: typeof countdown }).configuration);
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<WidgetSettingsSection />);
    expect(await screen.findByText('Countdowns 1')).not.toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Release day/ }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'widget_configuration_save',
        expect.objectContaining({
          configuration: expect.objectContaining({ selectedItemIds: ['event-1'] }),
        }),
      );
    });
  });

  describe('tasks widget', () => {
    const tasks = {
      ...configuration,
      kind: 'tasks',
      display: { horizonDays: 14, maxItems: 6, showCompleted: false },
      tasks: {
        includeCalendarTasks: true,
        includeKanbanTasks: true,
        includeUndated: true,
        selectedBoardIds: [],
      },
    } as const;

    beforeEach(() => {
      vi.mocked(invoke).mockImplementation((command, args) => {
        if (command === 'widget_active_profile_set') return Promise.resolve(undefined);
        if (command === 'widget_configuration_list') return Promise.resolve([tasks]);
        if (command === 'widget_diagnostics_list') return Promise.resolve([diagnostics]);
        if (command === 'calendar_list') return Promise.resolve([]);
        if (command === 'calendar_list_items') {
          return Promise.resolve([
            {
              id: 'task-1',
              uid: 'task-1',
              calendarId: 'calendar-kanban',
              kind: 'task',
              title: 'Review the board',
              status: 'needs-action',
              sourceBinding: {
                kind: 'kanban',
                vaultId: 'vault-1',
                fileId: 'file-1',
                cardId: 'card-1',
                path: 'Boards/Team.kanban',
              },
            },
          ]);
        }
        if (command === 'widget_configuration_save') {
          return Promise.resolve((args as { configuration: typeof tasks }).configuration);
        }
        return Promise.reject(new Error(`unexpected command: ${command}`));
      });
    });

    it('persists task source selection and board filters', async () => {
      render(<WidgetSettingsSection />);
      expect(await screen.findByText('Tasks 1')).not.toBeNull();

      fireEvent.click(screen.getByRole('checkbox', { name: 'Tasks without a due date' }));
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          'widget_configuration_save',
          expect.objectContaining({
            configuration: expect.objectContaining({
              tasks: expect.objectContaining({ includeUndated: false }),
            }),
          }),
        );
      });

      // Boards are labelled from the cached assignment, not from a stored path.
      fireEvent.click(screen.getByRole('checkbox', { name: 'Team' }));
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          'widget_configuration_save',
          expect.objectContaining({
            configuration: expect.objectContaining({
              tasks: expect.objectContaining({ selectedBoardIds: [] }),
            }),
          }),
        );
      });
    });

    it('keeps the launcher completion action opt-in', async () => {
      render(<WidgetSettingsSection />);
      const toggle = await screen.findByRole('checkbox', { name: /Complete from the widget/ });
      expect((toggle as HTMLInputElement).checked).toBe(false);

      fireEvent.click(toggle);
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          'widget_configuration_save',
          expect.objectContaining({
            configuration: expect.objectContaining({
              actions: expect.objectContaining({ toggleTask: true }),
            }),
          }),
        );
      });
    });
  });

  describe('sync widget', () => {
    const syncConfiguration = {
      ...configuration,
      configurationId: 'widget-sync-1',
      kind: 'sync',
      display: { horizonDays: 366, maxItems: 6, showCompleted: false },
    };

    beforeEach(() => {
      vi.mocked(invoke).mockImplementation((command, args) => {
        if (command === 'widget_active_profile_set') return Promise.resolve(undefined);
        if (command === 'widget_configuration_list') return Promise.resolve([syncConfiguration]);
        if (command === 'widget_diagnostics_list') {
          return Promise.resolve([{ ...diagnostics, configurationId: 'widget-sync-1' }]);
        }
        if (command === 'widget_sync_accounts') {
          return Promise.resolve([
            { accountId: 'account-aaaa', label: 'https://collab.example', vaults: 2 },
            { accountId: 'account-bbbb', label: 'https://other.example', vaults: 1 },
          ]);
        }
        if (command === 'calendar_list') {
          return Promise.resolve([
            { id: 'calendar-a', name: 'Personal', archived: false, deletedAt: null },
          ]);
        }
        if (command === 'calendar_list_items') return Promise.resolve([]);
        if (command === 'widget_configuration_save') {
          return Promise.resolve((args as { configuration: typeof configuration }).configuration);
        }
        return Promise.reject(new Error(`unexpected command: ${command}`));
      });
    });

    it('scopes by account and never offers the calendar picker', async () => {
      render(<WidgetSettingsSection />);

      expect(await screen.findByText('Sync status 1')).not.toBeNull();
      // A sync widget aggregates accounts, so calendars are meaningless here.
      expect(screen.queryByText('Calendars')).toBeNull();
      expect(screen.getByText('All accounts')).not.toBeNull();

      // Deselecting one account expands the implicit "all" into an explicit
      // list, so the remaining choice is unambiguous.
      fireEvent.click(screen.getByRole('checkbox', { name: /other\.example/ }));
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          'widget_configuration_save',
          expect.objectContaining({
            configuration: expect.objectContaining({ selectedSourceIds: ['account-aaaa'] }),
          }),
        );
      });
    });
  });
});
