import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('mobile widget settings', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'widget_active_profile_set') return Promise.resolve(undefined);
      if (command === 'widget_configuration_list') return Promise.resolve([configuration]);
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
});
