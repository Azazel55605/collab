import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { WidgetSettingsSection } from './WidgetSettingsSection';

const configuration = {
  schemaVersion: 1,
  configurationId: 'widget-config-1',
  kind: 'agenda',
  selectedSourceIds: [],
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
      if (command === 'widget_refresh') return Promise.resolve([{ ...diagnostics, updateCause: 'manual' }]);
      if (command === 'calendar_list') {
        return Promise.resolve([
          { id: 'calendar-a', name: 'Personal', archived: false, deletedAt: null },
          { id: 'calendar-b', name: 'Work', archived: false, deletedAt: null },
        ]);
      }
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
      if (command === 'widget_configuration_save') {
        const next = (args as { configuration: typeof configuration }).configuration;
        savedPrivacy.push(next.privacy);
        if (savedPrivacy.length === 1) {
          return new Promise((resolve) => { resolveFirstSave = resolve; });
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
});
