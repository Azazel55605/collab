import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsModal from './SettingsModal';

vi.mock('../../lib/tauri', () => ({
  getAppVersion: vi.fn(async () => '0.7.1'),
}));

describe('SettingsModal layout', () => {
  it('scrolls the tab list inside the body and keeps the footer separate', () => {
    render(<SettingsModal />);

    const about = screen.getByRole('button', { name: 'About' });
    const navigation = about.closest('nav');
    expect(navigation?.className).toContain('overflow-y-auto');

    fireEvent(
      window,
      new CustomEvent('settings:open-tab', {
        detail: { tab: 'ink' },
      }),
    );
    expect(screen.getByText('New drawing tools')).toBeTruthy();
    const footerClose = screen
      .getAllByRole('button', { name: 'Close' })
      .find((button) => button.textContent === 'Close');
    expect(footerClose?.parentElement?.className).toContain('shrink-0');
  });
});
