import type { ReactNode } from 'react';

import { Database, Info, LayoutGrid, MessageSquare, Plus, Server, Settings } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { useUiStore } from '../../../store/uiStore';
import { AppLogo } from '../../ui/AppLogo';
import { Button } from '../../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';

import { ServerStatusDot } from './ServerStatus';
import { type ServerEntry, serverStatusLabel } from './vaultEntries';

export type LauncherDestination = 'vaults' | 'chats' | 'databases';

/** Server list shown in the rail on the vaults page; omitted on chats and databases. */
export interface LauncherServerPanel {
  servers: ServerEntry[];
  serverFilter: string | null;
  onToggleServer: (serverUrl: string) => void;
  onServerDetails: (server: ServerEntry) => void;
  onAddServer: () => void;
}

/**
 * The navigation rail of the vault-less start screen. It is shared by the vault
 * list, chats and databases so each of those pages can reach the others before a
 * vault is open.
 */
export function LauncherRail({
  current,
  serverPanel,
}: {
  current: LauncherDestination;
  serverPanel?: LauncherServerPanel;
}) {
  const setActiveView = useUiStore((state) => state.setActiveView);
  const openSettings = useUiStore((state) => state.openSettings);

  return (
    <nav
      aria-label="Start"
      className="flex shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar px-3 py-2 md:w-60 md:flex-col md:items-stretch md:gap-6 md:border-r md:border-b-0 md:px-3 md:py-5"
    >
      <div className="mr-2 flex items-center gap-2.5 md:mr-0 md:px-1.5">
        <div className="flex size-8 items-center justify-center rounded-lg border border-primary/25 bg-primary/15">
          <AppLogo size={17} className="text-primary" />
        </div>
        <span className="hidden text-base font-bold tracking-tight md:inline">collab</span>
      </div>

      <div className="flex items-center gap-0.5 md:flex-col md:items-stretch">
        <RailItem
          icon={<LayoutGrid />}
          label="Vaults"
          current={current === 'vaults'}
          // Any view other than chats/databases shows the start screen while no vault is open.
          onClick={() => setActiveView('editor')}
        />
        <RailItem
          icon={<MessageSquare />}
          label="Chats"
          current={current === 'chats'}
          onClick={() => setActiveView('chats')}
        />
        <RailItem
          icon={<Database />}
          label="Databases"
          current={current === 'databases'}
          onClick={() => setActiveView('databases')}
        />
      </div>

      {serverPanel && (
        <section aria-labelledby="rail-servers-heading" className="hidden flex-col gap-0.5 md:flex">
          <div className="flex items-center justify-between pr-1 pb-1 pl-2.5">
            <h2
              id="rail-servers-heading"
              className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase"
            >
              Servers
            </h2>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={serverPanel.onAddServer}
              aria-label="Add server"
            >
              <Plus />
            </Button>
          </div>
          {serverPanel.servers.length === 0 && (
            <button
              type="button"
              onClick={serverPanel.onAddServer}
              className="rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              Add a server…
            </button>
          )}
          {serverPanel.servers.map((server) => {
            const selected = serverPanel.serverFilter === server.serverUrl;
            return (
              <div key={server.serverUrl} className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => serverPanel.onToggleServer(server.serverUrl)}
                  title={selected ? 'Show all vaults' : "Show only this server's vaults"}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors app-motion-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    selected
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'hover:bg-muted/60',
                  )}
                >
                  <ServerStatusDot state={server.state} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{server.host}</span>
                    <span
                      className={cn(
                        'block truncate text-[11px]',
                        server.state === 'signed-out'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-muted-foreground',
                      )}
                    >
                      {serverStatusLabel(server)}
                    </span>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => serverPanel.onServerDetails(server)}
                  aria-label={`Details for ${server.host}`}
                  title="Server details"
                  className="text-muted-foreground"
                >
                  <Info />
                </Button>
              </div>
            );
          })}
        </section>
      )}

      <div className="ml-auto flex items-center gap-0.5 md:mt-auto md:ml-0 md:flex-col md:items-stretch">
        {serverPanel && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Servers" className="md:hidden">
                <Server />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel>Servers</DropdownMenuLabel>
              {serverPanel.servers.map((server) => (
                <DropdownMenuItem
                  key={server.serverUrl}
                  onSelect={() => serverPanel.onToggleServer(server.serverUrl)}
                >
                  <ServerStatusDot state={server.state} />
                  <span className="truncate">{server.host}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={serverPanel.onAddServer}>
                <Plus />
                Add server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <RailItem icon={<Settings />} label="Settings" onClick={openSettings} />
      </div>
    </nav>
  );
}

function RailItem({
  icon,
  label,
  current = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex h-9 items-center justify-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors app-motion-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:justify-start [&_svg]:size-4',
        current
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}
