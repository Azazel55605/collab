import { useEffect } from 'react';
import { Files, Search, Tag, Layout, LayoutDashboard } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useUiStore, type SidebarPanel } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import FileTree from '../vault/FileTree';
import SearchPanel from '../vault/SearchPanel';
import TagsPanel from '../vault/TagsPanel';
import BoardsPanel from '../vault/BoardsPanel';
import { CollabPanel } from '../collaboration/CollabPanel';

const EDITOR_TABS: { id: SidebarPanel; icon: React.ReactNode; label: string }[] = [
  { id: 'files',  icon: <Files  size={13} />, label: 'Files'  },
  { id: 'search', icon: <Search size={13} />, label: 'Search' },
  { id: 'tags',   icon: <Tag    size={13} />, label: 'Tags'   },
];

const CANVAS_TABS: { id: SidebarPanel; icon: React.ReactNode; label: string }[] = [
  { id: 'canvas-boards', icon: <Layout  size={13} />, label: 'Boards' },
  { id: 'files',         icon: <Files   size={13} />, label: 'Files'  },
  { id: 'search',        icon: <Search  size={13} />, label: 'Search' },
];

const KANBAN_TABS: { id: SidebarPanel; icon: React.ReactNode; label: string }[] = [
  { id: 'kanban-boards', icon: <LayoutDashboard size={13} />, label: 'Boards' },
  { id: 'files',         icon: <Files           size={13} />, label: 'Files'  },
  { id: 'search',        icon: <Search          size={13} />, label: 'Search' },
];

export default function Sidebar() {
  const { sidebarPanel, setSidebarPanel, activeView } = useUiStore();
  const { vault } = useVaultStore();

  // Auto-switch panel when the main view changes
  useEffect(() => {
    if (activeView === 'canvas') {
      setSidebarPanel('canvas-boards');
    } else if (activeView === 'kanban') {
      setSidebarPanel('kanban-boards');
    } else if (sidebarPanel === 'canvas-boards' || sidebarPanel === 'kanban-boards') {
      setSidebarPanel('files');
    }
  }, [activeView]);

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

  const tabs =
    activeView === 'canvas' ? CANVAS_TABS :
    activeView === 'kanban' ? KANBAN_TABS :
    EDITOR_TABS;

  return (
    <div className="flex flex-col h-full bg-sidebar">
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
      <div className="flex px-2 pt-2 pb-1 gap-0.5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSidebarPanel(tab.id)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all duration-150 flex-1 justify-center',
              sidebarPanel === tab.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
            )}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {sidebarPanel === 'files'         && <FileTree />}
        {sidebarPanel === 'search'        && <SearchPanel />}
        {sidebarPanel === 'tags'          && <TagsPanel />}
        {sidebarPanel === 'canvas-boards' && <BoardsPanel kind="canvas" />}
        {sidebarPanel === 'kanban-boards' && <BoardsPanel kind="kanban" />}
      </div>
    </div>
  );
}
