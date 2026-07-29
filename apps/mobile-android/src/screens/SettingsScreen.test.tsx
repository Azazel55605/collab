import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.reject(new Error('unavailable'))) }));

import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_PREFS } from '../lib/theme';
import { SettingsScreen } from './SettingsScreen';

describe('mobile settings navigation', () => {
  it('starts with a searchable category index and opens one focused section', () => {
    render(<SettingsScreen prefs={DEFAULT_PREFS} onChange={vi.fn()} />);

    expect(screen.getByRole('navigation', { name: 'Settings categories' })).not.toBeNull();
    expect(screen.queryByText('Default time zone')).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'battery' },
    });
    expect(screen.getByRole('button', { name: /Background/ })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Calendar/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Background/ }));
    expect(screen.getByRole('heading', { name: 'Background' })).not.toBeNull();
    expect(screen.getByText('Pause on low battery')).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Settings categories' })).toBeNull();
  });

  it('returns from a detail section to the category index', () => {
    render(<SettingsScreen prefs={DEFAULT_PREFS} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }));
    expect(screen.getByText('Accent color')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));

    expect(screen.getByRole('navigation', { name: 'Settings categories' })).not.toBeNull();
    expect(screen.queryByText('Accent color')).toBeNull();
  });

  it('schedules the native background verification worker', async () => {
    render(<SettingsScreen prefs={DEFAULT_PREFS} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Background/ }));
    const verifyButton = screen.getByRole('button', { name: 'Verify background sync' });
    await waitFor(() => expect((verifyButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(verifyButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'background_android_verify',
        expect.objectContaining({ profileId: expect.any(String) }),
      );
    });
  });
});
