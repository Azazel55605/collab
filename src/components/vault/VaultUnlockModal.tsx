import { useRef, useState } from 'react';
import { Lock, Eye, EyeOff, Vault, LogOut } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useVaultStore } from '../../store/vaultStore';
import { toast } from 'sonner';

export default function VaultUnlockModal() {
  const { vault, unlockVault, closeVault } = useVaultStore();
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    try {
      await unlockVault(password);
    } catch (e) {
      toast.error('Incorrect password');
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vault-bg flex h-screen items-center justify-center overflow-hidden">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full bg-primary/8 blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[300px] rounded-full bg-blue-500/6 blur-[100px]" />
      </div>

      <div className="relative w-full max-w-sm px-4">
        {/* Icon + title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/15 border border-primary/20 mb-4 glow-primary-sm">
            <Lock size={24} className="text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Vault Locked</h1>
          <div className="flex items-center justify-center gap-1.5 mt-1.5">
            <Vault size={12} className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{vault?.name}</p>
          </div>
        </div>

        {/* Card */}
        <div className="glass rounded-xl p-5 shadow-2xl space-y-3">
          <div className="relative">
            <Input
              ref={inputRef}
              type={showPw ? 'text' : 'password'}
              placeholder="Enter vault password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              autoFocus
              disabled={busy}
              className="h-11 pr-10 text-sm"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          <Button
            onClick={submit}
            disabled={!password || busy}
            className="w-full h-11 gap-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
          >
            <Lock size={15} />
            {busy ? 'Unlocking…' : 'Unlock Vault'}
          </Button>
        </div>

        {/* Switch vault */}
        <div className="text-center mt-4">
          <button
            onClick={closeVault}
            className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            <LogOut size={11} />
            Switch vault
          </button>
        </div>
      </div>
    </div>
  );
}
