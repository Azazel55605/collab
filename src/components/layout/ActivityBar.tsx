import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import {
  CalendarDays,
  Database,
  Files,
  LayoutGrid,
  MessageCircle,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Users2,
  Vault,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { type ActiveView, hasWorkspaceSidebar, useUiStore } from '../../store/uiStore';
import { AppLogo } from '../ui/AppLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

import { activityWorkspace, WORKSPACE_ORDER, type WorkspaceView } from './workspaceNavigation';

const NAV_ITEMS: Record<WorkspaceView, { icon: React.ReactNode; label: string }> = {
  editor: { icon: <Files size={18} />, label: 'Files' },
  chats: { icon: <MessageCircle size={18} />, label: 'Chats' },
  calendar: { icon: <CalendarDays size={18} />, label: 'Calendar' },
  databases: { icon: <Database size={18} />, label: 'Databases' },
  grid: { icon: <LayoutGrid size={18} />, label: 'Grid View' },
};
const ACTIVITY_INDICATOR_INSET = 2;

const SIDEBAR_LABELS = {
  calendar: 'calendar overview',
  chats: 'chats and teams',
  databases: 'database connections',
};

export default function ActivityBar() {
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const openVaultSidebar = useUiStore((state) => state.openVaultSidebar);
  const sidebarOpen = useUiStore((state) =>
    hasWorkspaceSidebar(state.activeView)
      ? state.workspaceSidebars[state.activeView]
      : state.isSidebarOpen,
  );
  const sidebarLabel = `${sidebarOpen ? 'Hide' : 'Show'} ${hasWorkspaceSidebar(activeView) ? SIDEBAR_LABELS[activeView] : 'vault sidebar'}`;
  const sidebarPanel = useUiStore((state) => state.sidebarPanel);
  const isSettingsOpen = useUiStore((state) => state.isSettingsOpen);
  const openSettings = useUiStore((state) => state.openSettings);
  const closeSettings = useUiStore((state) => state.closeSettings);
  const isVaultManagerOpen = useUiStore((state) => state.isVaultManagerOpen);
  const openVaultManager = useUiStore((state) => state.openVaultManager);
  const closeVaultManager = useUiStore((state) => state.closeVaultManager);
  const openTab = useEditorStore((state) => state.openTab);
  const peers = useCollabStore((state) => state.peers);
  const navView = activityWorkspace(activeView);
  const activeNavIndex = isSettingsOpen ? -1 : WORKSPACE_ORDER.indexOf(navView);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navButtonRefs = useRef<Partial<Record<ActiveView, HTMLButtonElement | null>>>({});
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);

  const measureIndicator = useCallback(() => {
    if (activeNavIndex < 0) {
      setIndicator(null);
      return;
    }
    const view = WORKSPACE_ORDER[activeNavIndex];
    const root = rootRef.current;
    const button = view ? navButtonRefs.current[view] : null;
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
    const view = WORKSPACE_ORDER[activeNavIndex];
    const button = view ? navButtonRefs.current[view] : null;
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
      if (activeView === 'editor' && sidebarPanel === 'files' && isSidebarOpen) toggleSidebar();
      else openVaultSidebar('files', true);
    } else {
      setActiveView(view);
    }
  };

  const handleNavMiddleClick = (event: React.MouseEvent, view: ActiveView) => {
    if (event.button !== 1 || view !== 'grid') return;
    event.preventDefault();
    openTab('__grid__', 'Grid', view as 'canvas');
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
            aria-label={sidebarLabel}
            aria-expanded={sidebarOpen}
            className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-150 app-motion-base"
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeft size={17} />}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="glass-strong border-border/50 text-xs text-foreground"
        >
          {sidebarLabel}
        </TooltipContent>
      </Tooltip>

      <div className="w-6 h-px bg-border/50 my-1" />

      {WORKSPACE_ORDER.map((view) => {
        const { icon, label } = NAV_ITEMS[view];
        const isActive = navView === view && !isSettingsOpen;
        return (
          <Tooltip key={view}>
            <TooltipTrigger asChild>
              <button
                ref={(node) => {
                  navButtonRefs.current[view] = node;
                }}
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
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
              if (!hasWorkspaceSidebar(activeView) && isSidebarOpen && sidebarPanel === 'collab')
                toggleSidebar();
              else openVaultSidebar('collab');
            }}
            className={cn(
              'relative w-9 h-9 flex items-center justify-center rounded-md transition-all duration-150 app-motion-base',
              !hasWorkspaceSidebar(activeView) && sidebarPanel === 'collab' && isSidebarOpen
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
