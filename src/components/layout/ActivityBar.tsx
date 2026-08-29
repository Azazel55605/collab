import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import {
  CalendarDays,
  Files,
  GitFork,
  Layout,
  LayoutDashboard,
  LayoutGrid,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Users2,
  Vault,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { type ActiveView, useUiStore } from '../../store/uiStore';
import { AppLogo } from '../ui/AppLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const NAV_ITEMS: { view: ActiveView; icon: React.ReactNode; label: string }[] = [
  { view: 'editor', icon: <Files size={18} />, label: 'Files' },
  { view: 'graph', icon: <GitFork size={18} />, label: 'Graph View' },
  { view: 'canvas', icon: <Layout size={18} />, label: 'Canvas' },
  { view: 'kanban', icon: <LayoutDashboard size={18} />, label: 'Kanban' },
  { view: 'calendar', icon: <CalendarDays size={18} />, label: 'Calendar' },
  { view: 'grid', icon: <LayoutGrid size={18} />, label: 'Grid View' },
];
const ACTIVITY_INDICATOR_INSET = 2;

// Synthetic paths for singleton view tabs (not real files)
const VIEW_TAB_PATHS: Partial<Record<ActiveView, string>> = {
  graph: '__graph__',
  canvas: '__canvas__',
  kanban: '__kanban__',
  grid: '__grid__',
};

export default function ActivityBar() {
  const {
    activeView,
    setActiveView,
    isSidebarOpen,
    toggleSidebar,
    setSidebarPanel,
    sidebarPanel,
    isSettingsOpen,
    openSettings,
    closeSettings,
    isVaultManagerOpen,
    openVaultManager,
    closeVaultManager,
  } = useUiStore();
  const { openTab } = useEditorStore();
  const { peers } = useCollabStore();
  const activeNavIndex = isSettingsOpen
    ? -1
    : NAV_ITEMS.findIndex((item) => item.view === activeView);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navButtonRefs = useRef<Partial<Record<ActiveView, HTMLButtonElement | null>>>({});
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);

  const measureIndicator = useCallback(() => {
    if (activeNavIndex < 0) {
      setIndicator(null);
      return;
    }
    const item = NAV_ITEMS[activeNavIndex];
    const root = rootRef.current;
    const button = item ? navButtonRefs.current[item.view] : null;
    if (!root || !button) {
      setIndicator(null);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const inset = Math.min(ACTIVITY_INDICATOR_INSET, buttonRect.height / 2);
    const height = Math.max(2, buttonRect.height - inset * 2);
    setIndicator({
      top: buttonRect.top - rootRect.top - inset * 2.2,
      height,
    });
  }, [activeNavIndex]);

  useLayoutEffect(() => {
    measureIndicator();
    const root = rootRef.current;
    const activeItem = activeNavIndex >= 0 ? NAV_ITEMS[activeNavIndex] : null;
    const button = activeItem ? navButtonRefs.current[activeItem.view] : null;
    if (!root) return;
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureIndicator);
    observer?.observe(root);
    if (button) observer?.observe(button);
    window.addEventListener('resize', measureIndicator);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureIndicator);
    };
  }, [activeNavIndex, measureIndicator]);

  const handleNavClick = (view: ActiveView) => {
    if (view === 'editor') {
      setSidebarPanel('files');
      setActiveView('editor');
      if (!isSidebarOpen) toggleSidebar();
      else if (activeView === 'editor') toggleSidebar();
    } else if (view === 'graph') {
      openTab('__graph__', 'Graph', 'graph');
      setActiveView('graph');
    } else {
      setActiveView(view);
    }
  };

  // Middle-click: open the view as a persistent tab without switching the main view
  const handleNavMiddleClick = (e: React.MouseEvent, view: ActiveView) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const path = VIEW_TAB_PATHS[view];
    if (!path) return; // 'editor' has no singleton tab
    const titles: Partial<Record<ActiveView, string>> = {
      graph: 'Graph',
      canvas: 'Canvas',
      kanban: 'Kanban',
      grid: 'Grid',
    };
    openTab(path, titles[view] ?? view, view as 'graph' | 'canvas' | 'kanban');
    setActiveView(view);
  };

  const handleSettingsMiddleClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openTab('__settings__', 'Settings', 'settings');
    // Keep activeView as-is; settings tab renders inline without affecting activeView
  };

  return (
    <div
      ref={rootRef}
      className="relative w-11 flex flex-col items-center py-2 gap-0.5 border-r border-border/50 bg-sidebar shrink-0"
    >
      <span
        className={cn(
          'pointer-events-none absolute left-0 z-10 w-0.5 rounded-r-full bg-primary shadow-[0_0_8px_var(--glow-primary)] app-activity-indicator',
          indicator ? 'opacity-100' : 'opacity-0',
        )}
        style={{
          height: indicator?.height ?? 0,
          transform: `translateY(${indicator?.top ?? 0}px)`,
        }}
      />
      {/* App logo */}
      <div className="w-9 h-9 flex items-center justify-center">
        <AppLogo size={22} className="text-primary/70" />
      </div>

      <div className="w-6 h-px bg-border/50 mb-0.5" />

      {/* Sidebar toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-150 app-motion-base"
          >
            {isSidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeft size={17} />}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="glass-strong border-border/50 text-xs text-foreground"
        >
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
                ref={(node) => {
                  navButtonRefs.current[view] = node;
                }}
                onClick={() => handleNavClick(view)}
                onMouseDown={(e) => handleNavMiddleClick(e, view)}
                className={cn(
                  'relative w-9 h-9 flex items-center justify-center rounded-md transition-all duration-150 app-motion-base',
                  isActive
                    ? 'activity-item-active text-primary bg-primary/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
                )}
              >
                {icon}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              className="glass-strong border-border/50 text-xs text-foreground"
            >
              {label}
            </TooltipContent>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      {/* Collab */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => {
              setSidebarPanel('collab');
              if (!isSidebarOpen) toggleSidebar();
              else if (sidebarPanel === 'collab') toggleSidebar();
            }}
            className={cn(
              'relative w-9 h-9 flex items-center justify-center rounded-md transition-all duration-150 app-motion-base',
              sidebarPanel === 'collab' && isSidebarOpen
                ? 'activity-item-active text-primary bg-primary/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
            )}
          >
            <Users2 size={17} />
            {peers.length > 0 && (
              <span
                key={peers.length}
                className="absolute top-1 right-1 min-w-[14px] h-[14px] bg-primary text-primary-foreground text-[9px] font-bold rounded-full flex items-center justify-center px-0.5 app-chip-change"
              >
                {peers.length}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="glass-strong border-border/50 text-xs text-foreground"
        >
          Collaboration
        </TooltipContent>
      </Tooltip>

      {/* Vault Manager */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => (isVaultManagerOpen ? closeVaultManager() : openVaultManager())}
            className={cn(
              'relative w-9 h-9 flex items-center justify-center rounded-md transition-all duration-150 app-motion-base',
              isVaultManagerOpen
                ? 'activity-item-active text-primary bg-primary/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
            )}
          >
            <Vault size={17} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="glass-strong border-border/50 text-xs text-foreground"
        >
          Vault Manager
        </TooltipContent>
      </Tooltip>

      {/* Settings — opens modal */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => (isSettingsOpen ? closeSettings() : openSettings())}
            onMouseDown={handleSettingsMiddleClick}
            className={cn(
              'relative w-9 h-9 flex items-center justify-center rounded-md transition-all duration-150 app-motion-base',
              isSettingsOpen
                ? 'activity-item-active text-primary bg-primary/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
            )}
          >
            <Settings size={17} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="glass-strong border-border/50 text-xs text-foreground"
        >
          Settings
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
