import { X, FileText, Layout, LayoutDashboard } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';

export default function TabBar() {
  const { openTabs, activeTabPath, closeTab, setActiveTab } = useEditorStore();
  const { setActiveView } = useUiStore();

  if (openTabs.length === 0) return null;

  const handleTabClick = (relativePath: string, type: string) => {
    setActiveTab(relativePath);
    if (type === 'canvas') setActiveView('canvas');
    else if (type === 'kanban') setActiveView('kanban');
    else setActiveView('editor');
  };

  const getTabIcon = (type: string) => {
    if (type === 'canvas') return <Layout size={11} className="shrink-0" />;
    if (type === 'kanban') return <LayoutDashboard size={11} className="shrink-0" />;
    return <FileText size={11} className="shrink-0" />;
  };

  return (
    <div className="flex items-end h-9 border-b border-border/50 bg-background overflow-x-auto scrollbar-none shrink-0">
      {openTabs.map((tab) => {
        const isActive = activeTabPath === tab.relativePath;
        return (
          <div
            key={tab.relativePath}
            onClick={() => handleTabClick(tab.relativePath, tab.type)}
            className={cn(
              'tab-active relative flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer whitespace-nowrap transition-all duration-150 group min-w-0 max-w-[200px] select-none border-r border-border/30',
              isActive
                ? 'bg-background text-foreground'
                : 'bg-muted/20 text-muted-foreground hover:text-foreground/80 hover:bg-muted/30'
            )}
          >
            <span className={cn(isActive ? 'text-primary' : 'text-muted-foreground')}>
              {getTabIcon(tab.type)}
            </span>
            <span className="truncate">{tab.title}</span>

            {/* Dirty indicator */}
            {tab.isDirty && !isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-primary/70 shrink-0" />
            )}
            {tab.isDirty && isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 glow-primary-sm" />
            )}

            {/* Close button */}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.relativePath); }}
              className="ml-auto shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-accent transition-all"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}

      {/* Spacer so the tab bar fills remaining width */}
      <div className="flex-1 h-8 border-b border-transparent" />
    </div>
  );
}
