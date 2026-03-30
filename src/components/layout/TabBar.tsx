import { X, FileText, Layout, LayoutDashboard, GitFork, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useDragContext } from '../../contexts/DragContext';

export default function TabBar() {
  const { openTabs, activeTabPath, closeTab, setActiveTab } = useEditorStore();
  const { setActiveView } = useUiStore();
  const { setDraggingTab } = useDragContext();

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
          <div
            key={tab.relativePath}
            draggable
            onDragStart={(e) => {
              setDraggingTab({
                relativePath: tab.relativePath,
                title: tab.title,
                type: tab.type,
              });
              // Required: WebKit won't fire drop events without setData
              e.dataTransfer.setData('text/plain', tab.relativePath);
              e.dataTransfer.effectAllowed = 'move';
              // Minimal drag image so the browser ghost doesn't obscure the zones
              const ghost = document.createElement('div');
              ghost.textContent = tab.title;
              ghost.style.cssText =
                'position:fixed;top:-100px;left:-100px;padding:4px 8px;background:var(--primary);color:var(--primary-foreground);border-radius:6px;font-size:12px;white-space:nowrap;pointer-events:none;';
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 0, 0);
              requestAnimationFrame(() => document.body.removeChild(ghost));
            }}
            onDragEnd={() => setDraggingTab(null)}
            onClick={() => handleTabClick(tab.relativePath, tab.type)}
            className={cn(
              'tab-active relative flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer whitespace-nowrap',
              'transition-all duration-150 group min-w-0 max-w-[200px] select-none border-r border-border/30',
              isActive
                ? 'bg-background text-foreground'
                : 'bg-muted/20 text-muted-foreground hover:text-foreground/80 hover:bg-muted/30'
            )}
          >
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
        );
      })}

      <div className="flex-1 h-8 border-b border-transparent" />
    </div>
  );
}
