import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsGeneralSection from './SettingsGeneralSection';

function getSwitchForLabel(label: string) {
  return screen.getByText(label).closest('[aria-disabled]')?.querySelector('[role="switch"]') as HTMLElement;
}

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
        fileTreeHoverPreviewsEnabled={false}
        setFileTreeHoverPreviewsEnabled={vi.fn()}
        confirmDelete={false}
        setConfirmDelete={setConfirmDelete}
        liveCollabDebug={false}
        setLiveCollabDebug={vi.fn()}
      />,
    );

    fireEvent.click(getSwitchForLabel('Restore previous session'));
    expect(setRestorePreviousSession).toHaveBeenCalledWith(true);

    fireEvent.click(getSwitchForLabel('Confirm before deleting'));
    expect(setConfirmDelete).toHaveBeenCalledWith(true);
  });

  it('handles web preview toggles with disabled states', () => {
    const setWebPreviewsEnabled = vi.fn();
    const setHoverWebLinkPreviewsEnabled = vi.fn();
    const setBackgroundWebPreviewPrefetchEnabled = vi.fn();
    const setFileTreeHoverPreviewsEnabled = vi.fn();

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
        fileTreeHoverPreviewsEnabled={false}
        setFileTreeHoverPreviewsEnabled={setFileTreeHoverPreviewsEnabled}
        confirmDelete={true}
        setConfirmDelete={vi.fn()}
        liveCollabDebug={false}
        setLiveCollabDebug={vi.fn()}
      />,
    );

    fireEvent.click(getSwitchForLabel('Enable web previews'));
    expect(setWebPreviewsEnabled).toHaveBeenCalledWith(false);

    fireEvent.click(getSwitchForLabel('Hover previews for links'));
    expect(setHoverWebLinkPreviewsEnabled).toHaveBeenCalledWith(false);

    fireEvent.click(getSwitchForLabel('Background prefetch for open documents'));
    expect(setBackgroundWebPreviewPrefetchEnabled).toHaveBeenCalledWith(true);

    fireEvent.click(getSwitchForLabel('Hover previews in file tree'));
    expect(setFileTreeHoverPreviewsEnabled).toHaveBeenCalledWith(true);
  });

  it('visually marks dependent web preview rows as disabled', () => {
    render(
      <SettingsGeneralSection
        restorePreviousSession={true}
        setRestorePreviousSession={vi.fn()}
        webPreviewsEnabled={false}
        setWebPreviewsEnabled={vi.fn()}
        hoverWebLinkPreviewsEnabled={false}
        setHoverWebLinkPreviewsEnabled={vi.fn()}
        backgroundWebPreviewPrefetchEnabled={false}
        setBackgroundWebPreviewPrefetchEnabled={vi.fn()}
        fileTreeHoverPreviewsEnabled={false}
        setFileTreeHoverPreviewsEnabled={vi.fn()}
        confirmDelete={true}
        setConfirmDelete={vi.fn()}
        liveCollabDebug={false}
        setLiveCollabDebug={vi.fn()}
      />,
    );

    expect(screen.getByText('Hover previews for links').closest('[aria-disabled="true"]')).not.toBeNull();
    expect(screen.getByText('Background prefetch for open documents').closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('shows file tree previews under the broader previews section', () => {
    render(
      <SettingsGeneralSection
        restorePreviousSession={true}
        setRestorePreviousSession={vi.fn()}
        webPreviewsEnabled={true}
        setWebPreviewsEnabled={vi.fn()}
        hoverWebLinkPreviewsEnabled={true}
        setHoverWebLinkPreviewsEnabled={vi.fn()}
        backgroundWebPreviewPrefetchEnabled={false}
        setBackgroundWebPreviewPrefetchEnabled={vi.fn()}
        fileTreeHoverPreviewsEnabled={false}
        setFileTreeHoverPreviewsEnabled={vi.fn()}
        confirmDelete={true}
        setConfirmDelete={vi.fn()}
        liveCollabDebug={false}
        setLiveCollabDebug={vi.fn()}
      />,
    );

    expect(screen.getByText('Previews')).toBeTruthy();
    expect(screen.getByText('Web previews')).toBeTruthy();
    expect(screen.getByText('Hover previews in file tree')).toBeTruthy();
  });
});
