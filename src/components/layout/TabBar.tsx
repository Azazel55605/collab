import { useRef, useState } from 'react';
import { X, FileText, Layout, LayoutDashboard, GitFork, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useDragContext } from '../../contexts/DragContext';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from '../ui/context-menu';

export default function TabBar() {
  const { openTabs, activeTabPath, closeTab, setActiveTab, reorderTabs } = useEditorStore();
  const { setActiveView } = useUiStore();
  const { setDraggingTab } = useDragContext();

  // Track which tab is being dragged (for intra-bar reorder)
  const dragSrcRef = useRef<string | null>(null);
  // { path, side } — which tab and which edge the insert line should appear on
  const [dropIndicator, setDropIndicator] = useState<{ path: string; side: 'left' | 'right' } | null>(null);

  if (openTabs.length === 0) return null;

  const handleTabClick = (relativePath: string, type: string) => {
    setActiveTab(relativePath);
    if (type === 'graph')        setActiveView('graph');
    else if (type === 'canvas')  setActiveView('canvas');
    else if (type === 'kanban')  setActiveView('kanban');
    else                         setActiveView('editor');
  };

  const getTabIcon = (type: string) => {
    if (type === 'canvas')   return <Layout size={11} className="shrink-0" />;
    if (type === 'kanban')   return <LayoutDashboard size={11} className="shrink-0" />;
    if (type === 'graph')    return <GitFork size={11} className="shrink-0" />;
    if (type === 'settings') return <Settings size={11} className="shrink-0" />;
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
            draggable
            onDragStart={(e) => {
              dragSrcRef.current = tab.relativePath;
              setDraggingTab({
                relativePath: tab.relativePath,
                title: tab.title,
                type: tab.type,
              });
              e.dataTransfer.setData('text/plain', tab.relativePath);
              e.dataTransfer.effectAllowed = 'move';
              const ghost = document.createElement('div');
              ghost.textContent = tab.title;
              ghost.style.cssText =
                'position:fixed;top:-100px;left:-100px;padding:4px 8px;background:var(--primary);color:var(--primary-foreground);border-radius:6px;font-size:12px;white-space:nowrap;pointer-events:none;';
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 0, 0);
              requestAnimationFrame(() => document.body.removeChild(ghost));
            }}
            onDragOver={(e) => {
              if (!dragSrcRef.current || dragSrcRef.current === tab.relativePath) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
              setDropIndicator({ path: tab.relativePath, side });
            }}
            onDragLeave={() => setDropIndicator(null)}
            onDrop={(e) => {
              e.preventDefault();
              const src = dragSrcRef.current;
              if (!src || src === tab.relativePath || !dropIndicator) return;
              reorderTabs(src, tab.relativePath, dropIndicator.side === 'left');
              setDropIndicator(null);
            }}
            onDragEnd={() => {
              dragSrcRef.current = null;
              setDraggingTab(null);
              setDropIndicator(null);
            }}
            onClick={() => handleTabClick(tab.relativePath, tab.type)}
            className={cn(
              'tab-active relative flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer whitespace-nowrap',
              'transition-all duration-150 group min-w-0 max-w-[200px] select-none border-r border-border/30',
              isActive
                ? 'bg-background text-foreground'
                : 'bg-muted/20 text-muted-foreground hover:text-foreground/80 hover:bg-muted/30'
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
              <span className="w-1.5 h-1.5 rounded-full bg-primary/70 shrink-0" />
            )}
            {tab.isDirty && isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 glow-primary-sm" />
            )}

            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.relativePath); }}
              className="ml-auto shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-accent transition-all"
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
              onSelect={() => openTabs.filter(t => t.relativePath !== tab.relativePath).forEach(t => closeTab(t.relativePath))}
            >
              Close other tabs
            </ContextMenuItem>
            <ContextMenuItem className="text-xs" onSelect={() => openTabs.forEach(t => closeTab(t.relativePath))}>
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
