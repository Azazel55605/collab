import { Files, Search, Tag } from 'lucide-react';

import { type SidebarPanel, useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { CollabPanel } from '../collaboration/CollabPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import FileTree from '../vault/FileTree';
import SearchPanel from '../vault/SearchPanel';
import TagsPanel from '../vault/TagsPanel';

const EDITOR_TABS: { id: SidebarPanel; icon: React.ReactNode; label: string }[] = [
  { id: 'files', icon: <Files size={13} />, label: 'Files' },
  { id: 'search', icon: <Search size={13} />, label: 'Search' },
  { id: 'tags', icon: <Tag size={13} />, label: 'Tags' },
];

export default function Sidebar() {
  const { sidebarPanel, setSidebarPanel } = useUiStore();
  const { vault } = useVaultStore();

  // Collab panel is a standalone overlay — skip normal tab logic
  if (sidebarPanel === 'collab') {
    return (
      <div className="flex flex-col h-full bg-sidebar">
        {vault && (
          <div className="px-3 pt-3 pb-2 border-b border-sidebar-border/60">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-sm bg-primary/20 flex items-center justify-center shrink-0">
                <div className="w-2 h-2 rounded-sm bg-primary" />
              </div>
              <span className="text-xs font-semibold text-foreground truncate">{vault.name}</span>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <CollabPanel />
        </div>
      </div>
    );
  }

  return (
    <Tabs
      value={sidebarPanel}
      onValueChange={(value) => setSidebarPanel(value as SidebarPanel)}
      className="flex flex-col h-full bg-sidebar"
    >
      {/* Vault name header */}
      {vault && (
        <div className="px-3 pt-3 pb-2 border-b border-sidebar-border/60">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-sm bg-primary/20 flex items-center justify-center shrink-0">
              <div className="w-2 h-2 rounded-sm bg-primary" />
            </div>
            <span className="text-xs font-semibold text-foreground truncate">{vault.name}</span>
          </div>
        </div>
      )}

      {/* Panel tab switcher */}
      <div className="px-2 pt-2 pb-1">
        <TabsList className="w-full" aria-label="Vault navigation">
          {EDITOR_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="flex-1">
              {tab.icon}
              <span>{tab.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {/* Panel content */}
      <TabsContent
        value={sidebarPanel}
        key={sidebarPanel}
        className="flex-1 overflow-hidden app-sidebar-panel-enter"
      >
        {sidebarPanel === 'files' && (
          <FileTree
            key={
              vault?.kind === 'hosted' ? `${vault.serverUrl}:${vault.hostedVaultId}` : vault?.path
            }
          />
        )}
        {sidebarPanel === 'search' && <SearchPanel />}
        {sidebarPanel === 'tags' && <TagsPanel />}
      </TabsContent>
    </Tabs>
  );
}
