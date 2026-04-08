import { useEffect, useRef, useCallback, useState, Component, type ReactNode, type ErrorInfo } from 'react';
import { listen } from '@tauri-apps/api/event';
import ActivityBar from './ActivityBar';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import StatusBar from './StatusBar';
import { useVaultStore, useEditorStore, useNoteIndexStore, useUiStore } from '../../store';
import { tauriCommands } from '../../lib/tauri';
import NoteView from '../../views/NoteView';
import ImageView from '../../views/ImageView';
import PdfView from '../../views/PdfView';

// ── Editor error boundary ─────────────────────────────────────────────────────
class EditorErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e }; }
  componentDidCatch(e: Error, info: ErrorInfo) {
    console.error('[EditorErrorBoundary]', e, info);
  }
  render() {
    if (this.state.error) {
      const err = this.state.error as Error;
      return (
        <div style={{
          padding: '24px', fontFamily: 'monospace', fontSize: '13px',
          color: '#ff9999', background: '#1a0000', height: '100%',
          overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          <b style={{ fontSize: '15px', color: '#ff4444' }}>⚠ Editor crashed</b>
          {'\n\n'}{err.stack ?? err.message}
        </div>
      );
    }
    return this.props.children;
  }
}
import GraphPage from '../../views/GraphPage';
import CanvasPage from '../../views/CanvasPage';
import KanbanPage from '../../views/KanbanPage';
import SettingsPage from '../../views/SettingsPage';
import GridView from '../../views/GridView';
import { CollabProvider } from '../collaboration/CollabProvider';
import { ConflictDialog } from '../collaboration/ConflictDialog';
import { CommandBar } from '../command-bar/CommandBar';
import { DragProvider } from '../../contexts/DragContext';
import SplitDropZones from '../grid/SplitDropZones';
import { GitFork, Layout, LayoutDashboard, FileText, Settings as SettingsIcon, Image as ImageIcon } from 'lucide-react';

export default function AppShell() {
  const { vault, refreshFileTree } = useVaultStore();
  const { activeTabPath, openTabs, closeTab, setActiveTab } = useEditorStore();
  const { activeView, sidebarWidth, isSidebarOpen, setSidebarWidth, toggleSidebar, openSettings, closeSettings, isSettingsOpen, setActiveView } = useUiStore();
  const { setNotes, setIndexing } = useNoteIndexStore();
  const resizingRef = useRef(false);
  const startXRef   = useRef(0);
  const startWRef   = useRef(0);
  const [tabSwitcherIndex, setTabSwitcherIndex] = useState<number | null>(null);

  const getTabIcon = (type: string, size = 16) => {
    if (type === 'canvas')   return <Layout size={size} className="shrink-0" />;
    if (type === 'kanban')   return <LayoutDashboard size={size} className="shrink-0" />;
    if (type === 'graph')    return <GitFork size={size} className="shrink-0" />;
    if (type === 'settings') return <SettingsIcon size={size} className="shrink-0" />;
    if (type === 'image')    return <ImageIcon size={size} className="shrink-0" />;
    if (type === 'pdf')      return <FileText size={size} className="shrink-0" />;
    return <FileText size={size} className="shrink-0" />;
  };

  const activateTab = useCallback((tab: (typeof openTabs)[number]) => {
    setActiveTab(tab.relativePath);
    if      (tab.type === 'graph')  setActiveView('graph');
    else if (tab.type === 'kanban') setActiveView('kanban');
    else if (tab.type === 'canvas') setActiveView('canvas');
    else                            setActiveView('editor');
  }, [setActiveTab, setActiveView]);

  // Build note index on vault open
  useEffect(() => {
    if (!vault) return;
    setIndexing(true);
    tauriCommands.buildNoteIndex(vault.path)
      .then(setNotes)
      .finally(() => setIndexing(false));
  }, [vault?.path]);

  // File-system event listeners
  useEffect(() => {
    if (!vault) return;
    const unsubs: Array<() => void> = [];
    const setup = async () => {
      const u1 = await listen('vault:file-created',  () => refreshFileTree());
      const u2 = await listen('vault:file-deleted',  () => refreshFileTree());
      const u3 = await listen('vault:file-renamed',  () => refreshFileTree());
      const u4 = await listen('vault:file-modified', async () => {
        try {
          // Refresh tree so new/deleted files from other clients appear immediately.
          // Also rebuild the index for wikilink/search updates.
          await refreshFileTree();
          setNotes(await tauriCommands.buildNoteIndex(vault.path));
        } catch {}
      });
      unsubs.push(u1, u2, u3, u4);
    };
    setup();
    return () => unsubs.forEach((u) => u());
  }, [vault?.path]);

  // Global keyboard shortcuts
  useEffect(() => {
    const getCycleIndex = (backwards: boolean) => {
      if (openTabs.length < 2) return null;
      const idx = tabSwitcherIndex ?? openTabs.findIndex((t) => t.relativePath === activeTabPath);
      const next = backwards
        ? (idx - 1 + openTabs.length) % openTabs.length
        : (idx + 1) % openTabs.length;
      return next;
    };

    const commitTabSwitcher = () => {
      if (tabSwitcherIndex === null) return;
      const tab = openTabs[tabSwitcherIndex];
      if (tab) activateTab(tab);
      setTabSwitcherIndex(null);
    };

    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const inInput = !!(document.activeElement?.matches('input,textarea,[contenteditable]'));

      if (ctrl && e.code === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const next = getCycleIndex(e.shiftKey);
        if (next !== null) setTabSwitcherIndex(next);
        return;
      }

      if (!ctrl) return;

      switch (e.key) {
        case '\\':
          e.preventDefault();
          toggleSidebar();
          break;
        case ',':
          e.preventDefault();
          isSettingsOpen ? closeSettings() : openSettings();
          break;
        case 'w':
          e.preventDefault();
          if (activeTabPath) closeTab(activeTabPath);
          break;
        case '1': if (!inInput) { e.preventDefault(); setActiveView('editor'); } break;
        case '2':
          if (!inInput) {
            e.preventDefault();
            useEditorStore.getState().openTab('__graph__', 'Graph', 'graph');
            setActiveView('graph');
          }
          break;
        case '3': if (!inInput) { e.preventDefault(); setActiveView('kanban'); } break;
        case '4': if (!inInput) { e.preventDefault(); setActiveView('grid');   } break;
        case 'n':
          if (!inInput) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('cmdbar:open', { detail: { input: '> new note ' } }));
          }
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        commitTabSwitcher();
      }
    };

    const handleWindowBlur = () => {
      commitTabSwitcher();
    };

    document.addEventListener('keydown', handler, { capture: true });
    document.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('keydown', handler, { capture: true });
      document.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [openTabs, activeTabPath, tabSwitcherIndex, isSettingsOpen, toggleSidebar, openSettings, closeSettings, closeTab, setActiveView, activateTab]);

  // Sidebar drag-to-resize
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    resizingRef.current = true;
    startXRef.current   = e.clientX;
    startWRef.current   = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = e.clientX - startXRef.current;
      setSidebarWidth(Math.min(400, Math.max(160, startWRef.current + delta)));
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [setSidebarWidth]);

  const activeTab = openTabs.find((t) => t.relativePath === activeTabPath);
  const switcherTab = tabSwitcherIndex !== null ? openTabs[tabSwitcherIndex] : null;

  const renderMainContent = () => {
    // Grid mode is self-contained — always shown when activeView === 'grid'
    if (activeView === 'grid') return <GridView />;

    // View tabs (graph/canvas/kanban/settings) always take priority — they were
    // explicitly opened and their type unambiguously identifies the content.
    if (activeTab) {
      if (activeTab.type === 'graph')    return <GraphPage />;
      if (activeTab.type === 'settings') return <SettingsPage />;
      if (activeTab.type === 'image')    return <ImageView relativePath={activeTab.relativePath} />;
      if (activeTab.type === 'pdf')      return <PdfView relativePath={activeTab.relativePath} />;
      if (activeTab.type === 'canvas')   return <CanvasPage relativePath={activeTab.relativePath === '__canvas__' ? null : activeTab.relativePath} />;
      if (activeTab.type === 'kanban')   return <KanbanPage relativePath={activeTab.relativePath === '__kanban__' ? null : activeTab.relativePath} />;
      // Note tab: only show the note when activeView is editor — if the user
      // clicked Graph/Canvas/Kanban in the ActivityBar, show that view instead.
      if (activeView === 'editor')       return <NoteView relativePath={activeTab.relativePath} />;
    }

    // Fallback to activeView (covers: no open tabs, or note tab active but view changed)
    if (activeView === 'graph')  return <GraphPage />;
    if (activeView === 'canvas') return <CanvasPage relativePath={null} />;
    if (activeView === 'kanban') return <KanbanPage relativePath={null} />;
    return <EmptyEditor />;
  };

  return (
    <CollabProvider>
      <DragProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
        {/* Activity bar */}
        <ActivityBar />

        {/* Sidebar + resize handle */}
        {isSidebarOpen && (
          <div className="relative flex shrink-0 app-fade-slide-in" style={{ width: sidebarWidth }}>
            <div className="flex-1 overflow-hidden">
              <Sidebar />
            </div>
            {/* Resize handle */}
            <div
              onMouseDown={onResizeStart}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 transition-colors app-motion-fast z-10 group"
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 h-8 w-0.5 rounded-full bg-border/50 group-hover:bg-primary/50 transition-colors app-motion-fast" />
            </div>
          </div>
        )}

        {/* Main pane */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {activeView !== 'grid' && <TabBar />}
          {/* position:relative so the split drop zones are positioned inside the content area */}
          <div className="relative flex-1 overflow-hidden">
            <EditorErrorBoundary key={activeTabPath ?? activeView}>
              {renderMainContent()}
            </EditorErrorBoundary>
            {/* Edge drop zones — only visible when a tab is being dragged */}
            {activeView !== 'grid' && <SplitDropZones />}
          </div>
          <StatusBar />
        </div>
      </div>

      <ConflictDialog />
      <CommandBar />
      {switcherTab && (
        <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-background/18 backdrop-blur-xs-webkit">
          <div className="w-[min(560px,calc(100vw-48px))] rounded-2xl border border-border/50 bg-popover/94 px-4 py-4 shadow-2xl shadow-black/30">
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-border/40 bg-background/45 px-4 py-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary">
                {getTabIcon(switcherTab.type, 18)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{switcherTab.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{switcherTab.relativePath}</div>
              </div>
              <div className="shrink-0 rounded-full border border-border/50 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {switcherTab.type}
              </div>
            </div>

            <div className="flex gap-2 overflow-hidden">
              {openTabs.map((tab, index) => {
                const isSelected = index === tabSwitcherIndex;
                return (
                  <div
                    key={tab.relativePath}
                    className={isSelected
                      ? 'min-w-0 flex-1 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-primary shadow-lg shadow-primary/10'
                      : 'min-w-0 flex-1 rounded-xl border border-border/30 bg-background/35 px-3 py-2 text-muted-foreground'
                    }
                  >
                    <div className="mb-1 flex items-center gap-2 text-[11px]">
                      {getTabIcon(tab.type, 13)}
                      <span className="truncate">{tab.type}</span>
                    </div>
                    <div className="truncate text-xs font-medium">{tab.title}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      </DragProvider>
    </CollabProvider>
  );
}

function EmptyEditor() {
  const { activeView } = useUiStore();

  const hints: Record<string, { icon: React.ReactNode; title: string; hint: string }> = {
    graph:    { icon: <GitFork size={32} />,        title: 'Graph View',   hint: 'Visualising wikilink connections between your notes.' },
    canvas:   { icon: <Layout size={32} />,         title: 'Canvas',       hint: 'Drag notes onto an infinite canvas to build visual maps.' },
    kanban:   { icon: <LayoutDashboard size={32}/>, title: 'Kanban Board', hint: 'Organise tasks and assign them to collaborators.' },
    editor:   { icon: <FileText size={32} />,       title: 'No file open', hint: 'Select a file from the sidebar or press Ctrl+K to search.' },
    settings: { icon: null, title: '', hint: '' },
  };

  const h = hints[activeView] ?? hints.editor;

  return (
    <div className="flex-1 flex items-center justify-center h-full text-muted-foreground select-none">
      <div className="text-center">
        <div className="flex justify-center mb-3 text-muted-foreground/25">{h.icon}</div>
        <p className="text-base font-medium text-muted-foreground/60">{h.title}</p>
        <p className="text-sm mt-1 text-muted-foreground/40 max-w-xs">{h.hint}</p>
      </div>
    </div>
  );
}
