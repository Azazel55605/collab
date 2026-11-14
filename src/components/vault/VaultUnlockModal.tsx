import { useRef, useState } from 'react';

import { ArrowLeft, Eye, EyeOff, Lock } from 'lucide-react';
import { toast } from 'sonner';

import { useVaultStore } from '../../store/vaultStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

/** A locked, encrypted vault: one card on the start screen's backdrop. */
export default function VaultUnlockModal() {
  const { vault, unlockVault, closeVault } = useVaultStore();
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setWrong(false);
    try {
      await unlockVault(password);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('incorrect')) {
        setWrong(true);
        setPassword('');
        inputRef.current?.focus();
        return;
      }
      toast.error(`Failed to unlock vault: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vault-bg app-launcher-enter flex h-screen items-center justify-center overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/3 h-[420px] w-[620px] rounded-full bg-primary/10 blur-[120px] app-ambient-drift" />
        <div className="absolute right-1/4 bottom-0 h-[300px] w-[420px] rounded-full bg-sky-500/8 blur-[100px] app-ambient-drift [animation-delay:-2.4s]" />
      </div>

      <form
        className="relative flex w-full max-w-[380px] flex-col items-center gap-4 rounded-[18px] border border-border/70 bg-popover/90 px-7 pt-8 pb-6 text-center shadow-2xl shadow-black/40 backdrop-blur-xl"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Lock size={26} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{vault?.name}</h1>
          <p className="truncate text-[12.5px] text-muted-foreground" title={vault?.path}>
            Encrypted vault{vault?.kind !== 'hosted' && vault?.path ? ` · ${vault.path}` : ''}
          </p>
        </div>
        <div className="relative w-full">
          <Input
            ref={inputRef}
            type={showPw ? 'text' : 'password'}
            placeholder="Vault password"
            aria-label="Vault password"
            aria-invalid={wrong || undefined}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setWrong(false);
            }}
            autoFocus
            disabled={busy}
            className="h-10 pr-10 text-sm"
          />
          <Button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            variant="ghost"
            size="icon"
            aria-label={showPw ? 'Hide password' : 'Show password'}
            className="absolute top-1/2 right-1.5 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
          </Button>
        </div>
        {wrong && (
          <p role="alert" className="-mt-2 w-full text-left text-xs text-destructive">
            That password is not right. Try again.
          </p>
        )}
        <Button type="submit" disabled={!password || busy} className="h-10 w-full gap-2">
          <Lock size={15} />
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        <Button
          type="button"
          onClick={closeVault}
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
        >
          <ArrowLeft size={13} />
          Back to all vaults
        </Button>
      </form>
    </div>
  );
}
