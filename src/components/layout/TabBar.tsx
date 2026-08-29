import { useEffect, useRef, useState } from 'react';

import {
  CircuitBoard,
  FileText,
  GitFork,
  Image as ImageIcon,
  Layout,
  LayoutDashboard,
  Settings,
  X,
} from 'lucide-react';

import { type DragPoint, useDragContext } from '../../contexts/DragContext';
import { cn } from '../../lib/utils';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';

type DropIndicator = { path: string; side: 'left' | 'right' };

export default function TabBar() {
  const { openTabs, activeTabPath, closeTab, setActiveTab, reorderTabs } = useEditorStore();
  const { setActiveView } = useUiStore();
  const { startTabDrag, draggingTab, subscribePointer, registerDropResolver } = useDragContext();

  // Live element refs for each tab, keyed by path, used to hit-test the pointer.
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map());
  // { path, side } — which tab and which edge the insert line should appear on
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  // Latest values captured for the stable pointer/drop callbacks below.
  const draggingTabRef = useRef(draggingTab);
  draggingTabRef.current = draggingTab;
  const reorderRef = useRef(reorderTabs);
  reorderRef.current = reorderTabs;

  // Resolve which tab (and which edge) the pointer is over.
  const hitTest = (point: DragPoint): DropIndicator | null => {
    for (const [path, el] of tabRefs.current) {
      const rect = el.getBoundingClientRect();
      if (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      ) {
        return { path, side: point.x < rect.left + rect.width / 2 ? 'left' : 'right' };
      }
    }
    return null;
  };

  // Update the insertion indicator as the pointer moves during a drag.
  useEffect(() => {
    return subscribePointer((point) => {
      const dragging = draggingTabRef.current;
      if (!point || !dragging) {
        setDropIndicator(null);
        return;
      }
      const hit = hitTest(point);
      setDropIndicator(hit && hit.path !== dragging.relativePath ? hit : null);
    });
  }, [subscribePointer]);

  // Perform the reorder when the drag ends over the tab bar.
  useEffect(() => {
    return registerDropResolver((point) => {
      const dragging = draggingTabRef.current;
      if (!dragging) return false;
      const hit = hitTest(point);
      if (!hit) return false;
      if (hit.path !== dragging.relativePath) {
        reorderRef.current(dragging.relativePath, hit.path, hit.side === 'left');
      }
      return true;
    });
  }, [registerDropResolver]);

  if (openTabs.length === 0) return null;

  const handleTabClick = (relativePath: string, type: string) => {
    setActiveTab(relativePath);
    if (type === 'graph') setActiveView('graph');
    else if (type === 'canvas') setActiveView('canvas');
    else if (type === 'kanban') setActiveView('kanban');
    else setActiveView('editor');
  };

  const handleTabMiddleClick = (event: React.MouseEvent, relativePath: string) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    closeTab(relativePath);
  };

  const getTabIcon = (type: string) => {
    if (type === 'canvas') return <Layout size={11} className="shrink-0" />;
    if (type === 'kanban') return <LayoutDashboard size={11} className="shrink-0" />;
    if (type === 'logic') return <CircuitBoard size={11} className="shrink-0" />;
    if (type === 'graph') return <GitFork size={11} className="shrink-0" />;
    if (type === 'settings') return <Settings size={11} className="shrink-0" />;
    if (type === 'image') return <ImageIcon size={11} className="shrink-0" />;
    if (type === 'pdf') return <FileText size={11} className="shrink-0" />;
    return <FileText size={11} className="shrink-0" />;
  };

  return (
    <div className="flex items-end h-9 border-b border-border/50 bg-background overflow-x-auto scrollbar-none shrink-0">
      {openTabs.map((tab) => {
        const isActive = activeTabPath === tab.relativePath;
        return (
          <ContextMenu key={tab.relativePath}>
            <ContextMenuTrigger asChild>
              <div
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.relativePath, el);
                  else tabRefs.current.delete(tab.relativePath);
                }}
                onPointerDown={(e) =>
                  startTabDrag(
                    { relativePath: tab.relativePath, title: tab.title, type: tab.type },
                    e,
                  )
                }
                onMouseDown={(event) => handleTabMiddleClick(event, tab.relativePath)}
                onClick={() => handleTabClick(tab.relativePath, tab.type)}
                className={cn(
                  'tab-active relative flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer whitespace-nowrap',
                  'transition-all duration-150 app-motion-base app-tab-enter group min-w-0 max-w-[200px] select-none border-r border-border/30',
                  isActive
                    ? 'bg-background text-foreground app-active-glint'
                    : 'bg-muted/20 text-muted-foreground hover:text-foreground/80 hover:bg-muted/30',
                )}
              >
                {/* Insert indicator line */}
                {dropIndicator?.path === tab.relativePath && (
                  <span
                    className="absolute top-1 bottom-1 w-0.5 rounded-full bg-primary z-10 pointer-events-none"
                    style={{ [dropIndicator.side]: -1 }}
                  />
                )}
                <span className={cn(isActive ? 'text-primary' : 'text-muted-foreground')}>
                  {getTabIcon(tab.type)}
                </span>
                <span className="truncate">{tab.title}</span>

                {tab.isDirty && !isActive && (
                  <span className="w-1.5 h-1.5 rounded-full bg-primary/70 shrink-0 app-status-breathe" />
                )}
                {tab.isDirty && isActive && (
                  <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 glow-primary-sm app-status-breathe" />
                )}

                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.relativePath);
                  }}
                  className="ml-auto shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-accent transition-all app-motion-fast"
                >
                  <X size={10} />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-44">
              <ContextMenuItem className="text-xs" onSelect={() => closeTab(tab.relativePath)}>
                Close tab
              </ContextMenuItem>
              <ContextMenuItem
                className="text-xs"
                onSelect={() =>
                  openTabs
                    .filter((t) => t.relativePath !== tab.relativePath)
                    .forEach((t) => closeTab(t.relativePath))
                }
              >
                Close other tabs
              </ContextMenuItem>
              <ContextMenuItem
                className="text-xs"
                onSelect={() => openTabs.forEach((t) => closeTab(t.relativePath))}
              >
                Close all tabs
              </ContextMenuItem>
              {tab.type === 'note' && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-xs"
                    onSelect={() => navigator.clipboard.writeText(tab.relativePath)}
                  >
                    Copy path
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      <div className="flex-1 h-8 border-b border-transparent" />
    </div>
  );
}
