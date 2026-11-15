import { Files, Search, Tag } from 'lucide-react';

import { type SidebarPanel, useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { CollabPanel } from '../collaboration/CollabPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import FileTree from '../vault/FileTree';
import SearchPanel from '../vault/SearchPanel';
import TagsPanel from '../vault/TagsPanel';

import { sidebarSwitchListClass, sidebarSwitchTriggerClass } from './sidebarSwitch';
import { SidebarVaultHeader } from './SidebarVaultHeader';

const EDITOR_TABS: { id: SidebarPanel; icon: React.ReactNode; label: string }[] = [
  { id: 'files', icon: <Files size={13} />, label: 'Files' },
  { id: 'search', icon: <Search size={13} />, label: 'Search' },
  { id: 'tags', icon: <Tag size={13} />, label: 'Tags' },
];

export default function Sidebar() {
  const sidebarPanel = useUiStore((state) => state.sidebarPanel);
  const setSidebarPanel = useUiStore((state) => state.setSidebarPanel);
  const vault = useVaultStore((state) => state.vault);

  // The collaboration panel has its own switch (People / History) under the same header.
  if (sidebarPanel === 'collab') {
    return (
      <div className="flex h-full flex-col bg-sidebar">
        <SidebarVaultHeader />
        <div className="min-h-0 flex-1 overflow-hidden">
          <CollabPanel />
        </div>
      </div>
    );
  }

  return (
    <Tabs
      value={sidebarPanel}
      onValueChange={(value) => setSidebarPanel(value as SidebarPanel)}
      className="flex h-full flex-col gap-0 bg-sidebar"
    >
      <SidebarVaultHeader />

      <div className="px-2.5 pt-2.5 pb-2">
        <TabsList className={sidebarSwitchListClass} aria-label="Vault navigation">
          {EDITOR_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className={sidebarSwitchTriggerClass}>
              {tab.icon}
              <span>{tab.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent
        value={sidebarPanel}
        key={sidebarPanel}
        className="min-h-0 flex-1 overflow-hidden"
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
