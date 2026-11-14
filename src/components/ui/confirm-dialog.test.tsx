import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { chooseAction, confirmAction, ConfirmDialog, ConfirmDialogHost } from './confirm-dialog';

describe('confirmAction', () => {
  it('resolves true when the action is confirmed', async () => {
    render(<ConfirmDialogHost />);
    let answer: Promise<boolean>;
    act(() => {
      answer = confirmAction({ title: 'Remove it?', confirmLabel: 'Remove', destructive: true });
    });
    expect(screen.getByRole('dialog', { name: 'Remove it?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await expect(answer!).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('resolves false on cancel, and answers an earlier request when a new one arrives', async () => {
    render(<ConfirmDialogHost />);
    let first: Promise<boolean>;
    let second: Promise<boolean>;
    act(() => {
      first = confirmAction({ title: 'First?', confirmLabel: 'Yes' });
    });
    act(() => {
      second = confirmAction({ title: 'Second?', confirmLabel: 'Yes' });
    });
    await expect(first!).resolves.toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second!).resolves.toBe(false);
  });
});

describe('chooseAction', () => {
  it('resolves the chosen card, with the confirm label following the choice', async () => {
    render(<ConfirmDialogHost />);
    let answer: Promise<'one' | 'all' | null>;
    act(() => {
      answer = chooseAction({
        title: 'Delete which?',
        choices: [
          { value: 'one', title: 'This event' },
          { value: 'all', title: 'All events' },
        ],
        confirmLabel: (value) => (value === 'all' ? 'Delete series' : 'Delete event'),
        destructive: true,
      });
    });
    expect(screen.getByRole('button', { name: 'Delete event' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /All events/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete series' }));
    await expect(answer!).resolves.toBe('all');
  });
});

describe('ConfirmDialog', () => {
  it('runs the action and keeps the dialog open while busy', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Close session?"
        confirmLabel="Close session"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(onConfirm).toHaveBeenCalled();
    rerender(
      <ConfirmDialog
        open
        busy
        onOpenChange={onOpenChange}
        title="Close session?"
        confirmLabel="Close session"
        onConfirm={onConfirm}
      />,
    );
    expect(
      (screen.getByRole('button', { name: /Close session/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
