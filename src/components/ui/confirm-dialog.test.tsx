import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { confirmAction, ConfirmDialogHost } from './confirm-dialog';

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
