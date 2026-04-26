import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsGeneralSection from './SettingsGeneralSection';

describe('SettingsGeneralSection', () => {
  it('handles startup and file operation toggles', () => {
    const setRestorePreviousSession = vi.fn();
    const setConfirmDelete = vi.fn();

    render(
      <SettingsGeneralSection
        restorePreviousSession={false}
        setRestorePreviousSession={setRestorePreviousSession}
        webPreviewsEnabled={false}
        setWebPreviewsEnabled={vi.fn()}
        hoverWebLinkPreviewsEnabled={false}
        setHoverWebLinkPreviewsEnabled={vi.fn()}
        backgroundWebPreviewPrefetchEnabled={false}
        setBackgroundWebPreviewPrefetchEnabled={vi.fn()}
        confirmDelete={false}
        setConfirmDelete={setConfirmDelete}
      />,
    );

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);
    expect(setRestorePreviousSession).toHaveBeenCalledWith(true);

    fireEvent.click(switches[4]);
    expect(setConfirmDelete).toHaveBeenCalledWith(true);
  });

  it('handles web preview toggles with disabled states', () => {
    const setWebPreviewsEnabled = vi.fn();
    const setHoverWebLinkPreviewsEnabled = vi.fn();
    const setBackgroundWebPreviewPrefetchEnabled = vi.fn();

    render(
      <SettingsGeneralSection
        restorePreviousSession={true}
        setRestorePreviousSession={vi.fn()}
        webPreviewsEnabled={true}
        setWebPreviewsEnabled={setWebPreviewsEnabled}
        hoverWebLinkPreviewsEnabled={true}
        setHoverWebLinkPreviewsEnabled={setHoverWebLinkPreviewsEnabled}
        backgroundWebPreviewPrefetchEnabled={false}
        setBackgroundWebPreviewPrefetchEnabled={setBackgroundWebPreviewPrefetchEnabled}
        confirmDelete={true}
        setConfirmDelete={vi.fn()}
      />,
    );

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[1]);
    expect(setWebPreviewsEnabled).toHaveBeenCalledWith(false);

    fireEvent.click(switches[2]);
    expect(setHoverWebLinkPreviewsEnabled).toHaveBeenCalledWith(false);

    fireEvent.click(switches[3]);
    expect(setBackgroundWebPreviewPrefetchEnabled).toHaveBeenCalledWith(true);
  });
});
