import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentStatusPill } from './DocumentStatusPill';

afterEach(cleanup);

describe('DocumentStatusPill', () => {
  it('renders the status vocabulary label for each state', () => {
    const { rerender } = render(<DocumentStatusPill status="saving" />);
    expect(screen.getByText('Saving…')).toBeTruthy();

    rerender(<DocumentStatusPill status="dirty" />);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    rerender(<DocumentStatusPill status="offline-queued" />);
    expect(screen.getByText('Offline changes queued')).toBeTruthy();

    rerender(<DocumentStatusPill status="live-connected" />);
    expect(screen.getByText('Live')).toBeTruthy();

    rerender(<DocumentStatusPill status="live-reconnecting" />);
    expect(screen.getByText('Reconnecting…')).toBeTruthy();

    rerender(<DocumentStatusPill status="idle" />);
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('only shows recovery actions for remote-pending and conflict', () => {
    const { rerender } = render(
      <DocumentStatusPill status="dirty" onLoadRemote={vi.fn()} onKeepLocal={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /load latest/i })).toBeNull();

    rerender(
      <DocumentStatusPill status="remote-pending" onLoadRemote={vi.fn()} onKeepLocal={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /load latest/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep editing/i })).toBeTruthy();

    rerender(<DocumentStatusPill status="conflict" onLoadRemote={vi.fn()} onKeepLocal={vi.fn()} />);
    expect(screen.getByRole('button', { name: /keep mine/i })).toBeTruthy();
  });

  it('wires the recovery callbacks', () => {
    const onLoadRemote = vi.fn();
    const onKeepLocal = vi.fn();
    render(
      <DocumentStatusPill
        status="conflict"
        onLoadRemote={onLoadRemote}
        onKeepLocal={onKeepLocal}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /load latest/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep mine/i }));

    expect(onLoadRemote).toHaveBeenCalledTimes(1);
    expect(onKeepLocal).toHaveBeenCalledTimes(1);
  });

  it('can hide clean saved states for status-bar placement', () => {
    const { rerender } = render(<DocumentStatusPill status="idle" hideWhenSaved />);
    expect(screen.queryByText('Saved')).toBeNull();

    rerender(<DocumentStatusPill status="saved" hideWhenSaved />);
    expect(screen.queryByText('Saved')).toBeNull();

    rerender(<DocumentStatusPill status="dirty" hideWhenSaved />);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });
});
