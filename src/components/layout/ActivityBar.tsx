import { Files, GitFork, Layout, LayoutDashboard, Settings, PanelLeftClose, PanelLeft } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useUiStore, type ActiveView } from '../../store/uiStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const NAV_ITEMS: { view: ActiveView; icon: React.ReactNode; label: string }[] = [
  { view: 'editor',  icon: <Files           size={18} />, label: 'Files'      },
  { view: 'graph',   icon: <GitFork         size={18} />, label: 'Graph View' },
  { view: 'canvas',  icon: <Layout          size={18} />, label: 'Canvas'     },
  { view: 'kanban',  icon: <LayoutDashboard size={18} />, label: 'Kanban'     },
];

export default function ActivityBar() {
  const {
    activeView, setActiveView,
    isSidebarOpen, toggleSidebar, setSidebarPanel,
    isSettingsOpen, openSettings, closeSettings,
  } = useUiStore();

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
