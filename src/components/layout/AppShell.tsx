import { useEffect, useRef, useCallback, Component, type ReactNode, type ErrorInfo } from 'react';
import { listen } from '@tauri-apps/api/event';
import ActivityBar from './ActivityBar';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import StatusBar from './StatusBar';
import { useVaultStore, useEditorStore, useNoteIndexStore, useUiStore } from '../../store';
import { tauriCommands } from '../../lib/tauri';
import NoteView from '../../views/NoteView';

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
import { CommandPalette } from '../command-palette/CommandPalette';
import { DragProvider } from '../../contexts/DragContext';
import SplitDropZones from '../grid/SplitDropZones';
import { GitFork, Layout, LayoutDashboard, FileText } from 'lucide-react';

export default function AppShell() {
  const { vault, refreshFileTree } = useVaultStore();
  const { activeTabPath, openTabs } = useEditorStore();
  const { activeView, sidebarWidth, isSidebarOpen, setSidebarWidth } = useUiStore();
  const { setNotes, setIndexing } = useNoteIndexStore();
  const resizingRef = useRef(false);
  const startXRef   = useRef(0);
  const startWRef   = useRef(0);

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

  const renderMainContent = () => {
    // Grid mode is self-contained — always shown when activeView === 'grid'
    if (activeView === 'grid') return <GridView />;

    // View tabs (graph/canvas/kanban/settings) always take priority — they were
    // explicitly opened and their type unambiguously identifies the content.
    if (activeTab) {
      if (activeTab.type === 'graph')    return <GraphPage />;
      if (activeTab.type === 'settings') return <SettingsPage />;
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
          <div className="relative flex shrink-0" style={{ width: sidebarWidth }}>
            <div className="flex-1 overflow-hidden">
              <Sidebar />
            </div>
            {/* Resize handle */}
            <div
              onMouseDown={onResizeStart}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 transition-colors z-10 group"
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 h-8 w-0.5 rounded-full bg-border/50 group-hover:bg-primary/50 transition-colors" />
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
      <CommandPalette />
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
    editor:   { icon: <FileText size={32} />,       title: 'No file open', hint: 'Select a file from the sidebar or press ⌘P to search.' },
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
