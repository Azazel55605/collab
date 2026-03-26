import { useEffect } from 'react';
import { FolderOpen, Plus, Clock, ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { useVaultStore } from '../../store/vaultStore';
import { tauriCommands } from '../../lib/tauri';
import { toast } from 'sonner';

export default function VaultPicker() {
  const { openVault, loadRecentVaults, recentVaults, isLoading } = useVaultStore();

  useEffect(() => { loadRecentVaults(); }, []);

  const handleOpenDialog = async () => {
    try {
      const path = await tauriCommands.showOpenVaultDialog();
      if (path) await openVault(path);
    } catch (e) {
      toast.error('Failed to open vault: ' + e);
    }
  };

  const handleCreateVault = async () => {
    try {
      const path = await tauriCommands.showOpenVaultDialog();
      if (!path) return;
      const name = prompt('Vault name:', 'My Vault');
      if (!name) return;
      await tauriCommands.createVault(path, name);
      await openVault(path);
    } catch (e) {
      toast.error('Failed to create vault: ' + e);
    }
  };

  return (
    <div className="vault-bg flex h-screen items-center justify-center overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full bg-primary/8 blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[300px] rounded-full bg-blue-500/6 blur-[100px]" />
      </div>

      <div className="relative w-full max-w-md px-4">
        {/* Logo block */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/15 border border-primary/20 mb-4 glow-primary-sm">
            <Sparkles size={24} className="text-primary" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">collab</h1>
          <p className="text-sm text-muted-foreground mt-1.5">Your collaborative knowledge base</p>
        </div>

        {/* Glass card */}
        <div className="glass rounded-xl p-5 shadow-2xl">
          <div className="flex flex-col gap-2.5">
            <Button
              onClick={handleOpenDialog}
              disabled={isLoading}
              className="h-11 gap-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all"
            >
              <FolderOpen size={16} />
              Open Existing Vault
            </Button>
            <Button
              onClick={handleCreateVault}
              variant="outline"
              disabled={isLoading}
              className="h-11 gap-2 text-sm font-medium border-border/60 bg-white/4 hover:bg-white/8 transition-all"
            >
              <Plus size={16} />
              Create New Vault
            </Button>
          </div>

          {recentVaults.length > 0 && (
            <>
              <div className="flex items-center gap-2 mt-5 mb-3">
                <Separator className="flex-1 bg-border/40" />
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground uppercase tracking-widest shrink-0">
                  <Clock size={10} />
                  Recent
                </span>
                <Separator className="flex-1 bg-border/40" />
              </div>

              <div className="space-y-1">
                {recentVaults.slice(0, 5).map((v) => (
                  <button
                    key={v.id}
                    onClick={() => openVault(v.path)}
                    disabled={isLoading}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:border-border/50 hover:bg-white/5 text-left transition-all group"
                  >
                    <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/15 flex items-center justify-center shrink-0">
                      <div className="w-2 h-2 rounded-sm bg-primary/70" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{v.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate opacity-70">{v.path}</div>
                    </div>
                    <ArrowRight
                      size={13}
                      className="text-muted-foreground opacity-0 group-hover:opacity-60 group-hover:translate-x-0.5 transition-all shrink-0"
                    />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <p className="text-center text-[11px] text-muted-foreground/40 mt-4">
          All data stored locally · Collaboration via shared folders
        </p>
      </div>
    </div>
  );
}
