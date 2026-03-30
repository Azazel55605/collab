import { Files, GitFork, Layout, LayoutDashboard, Settings, PanelLeftClose, PanelLeft } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useUiStore, type ActiveView } from '../../store/uiStore';
import { useEditorStore } from '../../store/editorStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const NAV_ITEMS: { view: ActiveView; icon: React.ReactNode; label: string }[] = [
  { view: 'editor',  icon: <Files           size={18} />, label: 'Files'      },
  { view: 'graph',   icon: <GitFork         size={18} />, label: 'Graph View' },
  { view: 'canvas',  icon: <Layout          size={18} />, label: 'Canvas'     },
  { view: 'kanban',  icon: <LayoutDashboard size={18} />, label: 'Kanban'     },
];

// Synthetic paths for singleton view tabs (not real files)
const VIEW_TAB_PATHS: Partial<Record<ActiveView, string>> = {
  graph:  '__graph__',
  canvas: '__canvas__',
  kanban: '__kanban__',
};

export default function ActivityBar() {
  const {
    activeView, setActiveView,
    isSidebarOpen, toggleSidebar, setSidebarPanel,
    isSettingsOpen, openSettings, closeSettings,
  } = useUiStore();
  const { openTab } = useEditorStore();

  const handleNavClick = (view: ActiveView) => {
    if (view === 'editor') {
      setSidebarPanel('files');
      if (!isSidebarOpen) toggleSidebar();
      else if (activeView === 'editor') toggleSidebar();
    } else {
      setActiveView(view);
    }
    if (view !== 'editor') setActiveView(view);
  };

  // Middle-click: open the view as a persistent tab without switching the main view
  const handleNavMiddleClick = (e: React.MouseEvent, view: ActiveView) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const path = VIEW_TAB_PATHS[view];
    if (!path) return; // 'editor' has no singleton tab
    openTab(path, view === 'graph' ? 'Graph' : view === 'canvas' ? 'Canvas' : 'Kanban', view as 'graph' | 'canvas' | 'kanban');
    setActiveView(view);
  };

  const handleSettingsMiddleClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openTab('__settings__', 'Settings', 'settings');
    // Keep activeView as-is; settings tab renders inline without affecting activeView
  };

  return (
    <div className="relative w-11 flex flex-col items-center py-2 gap-0.5 border-r border-border/50 bg-sidebar shrink-0">
      {/* Sidebar toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-150"
          >
            {isSidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeft size={17} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="glass-strong border-border/50 text-xs">
          {isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        </TooltipContent>
      </Tooltip>

      <div className="w-6 h-px bg-border/50 my-1" />

      {NAV_ITEMS.map(({ view, icon, label }) => {
        const isActive = activeView === view && !isSettingsOpen;
        return (
          <Tooltip key={view}>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleNavClick(view)}
                onMouseDown={(e) => handleNavMiddleClick(e, view)}
                className={cn(
                  'relative w-9 h-9 flex items-center justify-center rounded-md transition-all duration-150',
                  isActive
                    ? 'activity-item-active text-primary bg-primary/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
                )}
              >
                {icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="glass-strong border-border/50 text-xs">
              {label}
            </TooltipContent>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      {/* Settings — opens modal */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => isSettingsOpen ? closeSettings() : openSettings()}
            onMouseDown={handleSettingsMiddleClick}
            className={cn(
              'relative w-9 h-9 flex items-center justify-center rounded-md transition-all duration-150',
              isSettingsOpen
                ? 'activity-item-active text-primary bg-primary/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
            )}
          >
            <Settings size={17} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="glass-strong border-border/50 text-xs">
          Settings
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
