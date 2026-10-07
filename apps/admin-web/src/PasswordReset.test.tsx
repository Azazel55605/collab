import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serverApi } from './api';
import { App } from './App';
import { PasswordResetLinkDialog, PasswordResetScreen } from './PasswordReset';

vi.mock('./api', () => ({
  serverApi: {
    createPasswordResetLink: vi.fn(),
    revokePasswordResetLink: vi.fn(),
    redeemPasswordReset: vi.fn(),
    bootstrapStatus: vi.fn(),
  },
}));
beforeEach(() => {
  window.history.replaceState({}, '', '/admin/');
  vi.mocked(serverApi.createPasswordResetLink).mockResolvedValue({
    id: 'reset-id',
    token: 'secret',
    expiresAt: '2026-10-07T15:00:00Z',
  });
  vi.mocked(serverApi.revokePasswordResetLink).mockResolvedValue();
  vi.mocked(serverApi.redeemPasswordReset).mockResolvedValue();
});
afterEach(() => window.history.replaceState({}, '', '/admin/'));

describe('password reset links', () => {
  it('creates a shareable link for the chosen user and allows revocation', async () => {
    render(
      <PasswordResetLinkDialog user={{ id: 'member-id', username: 'member' }} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create reset link' }));
    const input = await screen.findByLabelText('Reset link');
    expect(input).toHaveProperty('value', `${window.location.origin}/admin/#reset=secret`);
    expect(serverApi.createPasswordResetLink).toHaveBeenCalledWith('member-id');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke reset links' }));
    await screen.findByText('Reset links revoked.');
    expect(screen.queryByLabelText('Reset link')).toBeNull();
    expect(serverApi.revokePasswordResetLink).toHaveBeenCalledWith('member-id');
  });
  it('reports issuance failures without exposing a broken link', async () => {
    vi.mocked(serverApi.createPasswordResetLink).mockRejectedValueOnce(
      new Error('Account disabled.'),
    );
    render(
      <PasswordResetLinkDialog user={{ id: 'member-id', username: 'member' }} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create reset link' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Error: Account disabled.',
    );
    expect(screen.queryByLabelText('Reset link')).toBeNull();
  });
  it('requires matching passwords, completes once, and returns to sign in', async () => {
    render(<PasswordResetScreen token="secret" />);
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new password long enough' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'other password long enough' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await screen.findByText('New passwords do not match.');
    expect(serverApi.redeemPasswordReset).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'new password long enough' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await screen.findByRole('link', { name: 'Continue to sign in' });
    expect(serverApi.redeemPasswordReset).toHaveBeenCalledExactlyOnceWith(
      'secret',
      'new password long enough',
    );
    expect(screen.queryByLabelText('New password')).toBeNull();
  });
  it('reports expired links and restores the submit control', async () => {
    vi.mocked(serverApi.redeemPasswordReset).mockRejectedValueOnce(
      new Error('The password reset link is invalid or expired.'),
    );
    render(<PasswordResetScreen token="expired" />);
    for (const label of ['New password', 'Confirm new password'])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: 'new password long enough' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await screen.findByText('The password reset link is invalid or expired.');
    expect(screen.getByRole('button', { name: 'Reset password' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  it('opens the public reset screen while removing the token from the URL', async () => {
    window.history.replaceState({}, '', '/admin/#reset=private-token');
    render(<App />);
    await screen.findByRole('heading', { name: 'Reset your password' });
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(serverApi.bootstrapStatus).not.toHaveBeenCalled();
    for (const label of ['New password', 'Confirm new password'])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: 'new password long enough' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await screen.findByRole('link', { name: 'Continue to sign in' });
    expect(serverApi.redeemPasswordReset).toHaveBeenCalledWith(
      'private-token',
      'new password long enough',
    );
  });
});
