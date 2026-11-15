import type { ReactNode } from 'react';

import { ChevronDown, Cloud, HardDrive, LogOut, Settings2, Vault } from 'lucide-react';

import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { vaultKind } from '../../types/vault';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { serverHost } from '../vault/launcher/vaultEntries';

/**
 * The 48 px vault header shared by every sidebar panel. It sits level with the
 * document header and opens the vault menu: vault manager and closing the vault
 * to return to the start screen.
 */
export function SidebarVaultHeader({ action }: { action?: ReactNode }) {
  const vault = useVaultStore((state) => state.vault);
  const closeVault = useVaultStore((state) => state.closeVault);
  const openVaultManager = useUiStore((state) => state.openVaultManager);
  if (!vault) return null;
  const hosted = vaultKind(vault) === 'hosted' && vault.kind === 'hosted';
  const where = hosted ? serverHost(vault.serverUrl) : 'On this device';
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-sidebar-border/60 pr-1.5 pl-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Vault menu: ${vault.name}`}
            className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors outline-none hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent/60"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Vault className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-semibold">{vault.name}</span>
              <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                {hosted ? (
                  <Cloud className="size-3 shrink-0" />
                ) : (
                  <HardDrive className="size-3 shrink-0" />
                )}
                <span className="truncate">{where}</span>
              </span>
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="truncate text-[11px]">{vault.name}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={openVaultManager}>
            <Settings2 /> Vault manager…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={closeVault}>
            <LogOut /> Close vault
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {action}
    </div>
  );
}
