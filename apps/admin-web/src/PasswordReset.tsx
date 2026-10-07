import { type FormEvent, useEffect, useState } from 'react';

import { serverApi } from './api';
import { Button, Card, DialogShell, Input } from './ui';

export function PasswordResetScreen({ token }: { token: string }) {
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.history.replaceState({}, '', '/admin/');
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password'));
    if (password !== data.get('confirmation')) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await serverApi.redeemPasswordReset(token, password);
      form.reset();
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reset your password.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <Card className="auth-card">
        <h1>{done ? 'Password reset' : 'Reset your password'}</h1>
        {done ? (
          <>
            <p>Your password has changed. All previous sessions have been signed out.</p>
            <a href="/admin/">Continue to sign in</a>
          </>
        ) : (
          <>
            <p className="subtle">Choose a new password of at least 12 characters.</p>
            <form onSubmit={submit}>
              <label className="field">
                <span>New password</span>
                <Input
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  maxLength={1024}
                  autoComplete="new-password"
                />
              </label>
              <label className="field">
                <span>Confirm new password</span>
                <Input
                  name="confirmation"
                  type="password"
                  required
                  minLength={12}
                  maxLength={1024}
                  autoComplete="new-password"
                />
              </label>
              {error && (
                <p role="alert" className="error-banner">
                  {error}
                </p>
              )}
              <Button disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</Button>
            </form>
          </>
        )}
      </Card>
    </main>
  );
}

export function PasswordResetLinkDialog({
  user,
  onClose,
}: {
  user: { id: string; username: string };
  onClose: () => void;
}) {
  const [link, setLink] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await serverApi.createPasswordResetLink(user.id);
      setLink(`${window.location.origin}/admin/#reset=${encodeURIComponent(result.token)}`);
      setExpires(new Date(result.expiresAt).toLocaleString());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await serverApi.revokePasswordResetLink(user.id);
      setLink('');
      setMessage('Reset links revoked.');
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogShell title={`Password reset link for ${user.username}`} onClose={onClose}>
      <p>
        Share this link privately with the account owner. It expires after one hour and works once.
        Creating a new link replaces previous links. Their password stays unchanged until they use
        it.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {link && (
        <>
          <label className="field">
            <span>Reset link</span>
            <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <p>Expires: {expires}</p>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setMessage('Link copied.');
              } catch {
                setError('Could not copy. Select and copy the link above.');
              }
            }}
          >
            Copy link
          </Button>
        </>
      )}
      <div className="ui-dialog-actions">
        <Button variant="outline" disabled={busy} onClick={() => void revoke()}>
          Revoke reset links
        </Button>
        <Button disabled={busy} onClick={() => void create()}>
          {link ? 'Replace link' : 'Create reset link'}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </DialogShell>
  );
}
