import {
  Calculator,
  FileCode,
  FilePlus,
  GitFork,
  Grid3X3,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  Link2,
  ListTodo,
  Settings,
  Shapes,
  Table2,
  Tags,
} from 'lucide-react';
import { toast } from 'sonner';

import { dispatchEditorToolbarAction } from '../../lib/editorToolbarActions';
import { tauriCommands } from '../../lib/tauri';
import type { ActiveView, DateFormat } from '../../store/uiStore';
import type { NoteMetadata, SearchResult } from '../../types/note';
import type { NoteFile, VaultMeta } from '../../types/vault';

export interface RenderCtx {
  notes: NoteMetadata[];
  files: NoteFile[];
  searchResults: SearchResult[];
  activeView: ActiveView;
  vault: VaultMeta | null;
  dateFormat: DateFormat;
  openTab: (relativePath: string, title: string, type?: 'note' | 'canvas' | 'kanban' | 'graph' | 'settings' | 'image' | 'pdf') => void;
  setActiveView: (v: ActiveView) => void;
  openSettings: () => void;
  refreshFileTree: () => Promise<void>;
  setInput: (s: string) => void;
  close: () => void;
}

export interface Action {
  id: string;
  keywords: string[];
  label: string;
  icon: React.ReactNode;
  onSelect: (ctx: RenderCtx, query: string) => void | Promise<void>;
}

export const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance', keywords: ['theme', 'accent', 'color', 'look'] },
  { id: 'editor', label: 'Editor', keywords: ['font', 'typing', 'delete', 'notes'] },
  { id: 'display', label: 'Display', keywords: ['scale', 'motion', 'animation', 'ui'] },
  { id: 'calendar', label: 'Calendar', keywords: ['date', 'week', 'format'] },
  { id: 'profile', label: 'Profile', keywords: ['name', 'identity', 'presence', 'user'] },
  { id: 'about', label: 'About', keywords: ['version', 'update', 'app'] },
  { id: 'shortcuts', label: 'Shortcuts', keywords: ['keyboard', 'hotkeys', 'bindings'] },
] as const;

export const ACTIONS: Action[] = [
  {
    id: 'graph',
    keywords: ['graph', 'open graph', 'graph view'],
    label: 'Open Graph View',
    icon: <GitFork className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      ctx.openTab('__graph__', 'Graph', 'graph');
      ctx.setActiveView('graph');
      ctx.close();
    },
  },
  {
    id: 'kanban',
    keywords: ['kanban', 'board', 'open kanban'],
    label: 'Open Kanban View',
    icon: <LayoutDashboard className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      ctx.setActiveView('kanban');
      ctx.close();
    },
  },
  {
    id: 'canvas',
    keywords: ['canvas', 'open canvas', 'canvas view'],
    label: 'Open Canvas View',
    icon: <Layers className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      ctx.setActiveView('canvas');
      ctx.close();
    },
  },
  {
    id: 'grid',
    keywords: ['grid', 'grid view', 'workspace'],
    label: 'Open Grid View',
    icon: <Grid3X3 className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      ctx.setActiveView('grid');
      ctx.close();
    },
  },
  {
    id: 'settings',
    keywords: ['settings', 'preferences', 'config'],
    label: 'Open Settings',
    icon: <Settings className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      ctx.openSettings();
      ctx.close();
    },
  },
  {
    id: 'new-note',
    keywords: ['new note', 'create note', 'add note'],
    label: 'New Note',
    icon: <FilePlus className="size-4 shrink-0" />,
    onSelect: async (ctx, query) => {
      const name = query.replace(/^new\s+note\s*/i, '').trim() || 'Untitled';
      if (!ctx.vault) return;
      try {
        const file = await tauriCommands.createNote(ctx.vault.path, `${name}.md`);
        await ctx.refreshFileTree();
        ctx.openTab(file.relativePath, name, 'note');
        ctx.setActiveView('editor');
      } catch (e) {
        toast.error('Failed to create note: ' + e);
      }
      ctx.close();
    },
  },
  {
    id: 'new-canvas',
    keywords: ['new canvas', 'create canvas', 'new canvas board'],
    label: 'New Canvas Board',
    icon: <Layers className="size-4 shrink-0" />,
    onSelect: async (ctx, query) => {
      const name = query.replace(/^new\s+canvas\s*/i, '').trim() || 'Canvas';
      if (!ctx.vault) return;
      try {
        const file = await tauriCommands.createNote(ctx.vault.path, `${name}.canvas`);
        await ctx.refreshFileTree();
        ctx.openTab(file.relativePath, name, 'canvas');
        ctx.setActiveView('canvas');
      } catch (e) {
        toast.error('Failed to create canvas board: ' + e);
      }
      ctx.close();
    },
  },
  {
    id: 'add-tags-line',
    keywords: ['add tags', 'tags line', 'frontmatter tags', 'tag note'],
    label: 'Add tags line to note',
    icon: <Tags className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      window.dispatchEvent(new CustomEvent('tag:add-tags-line'));
      ctx.close();
    },
  },
  {
    id: 'open-icon-picker',
    keywords: ['icon', 'icons', 'nerd font', 'symbol', 'glyph', 'insert icon'],
    label: 'Open Nerd Font Icon Picker',
    icon: <Shapes className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      if (ctx.activeView !== 'editor') {
        toast.error('Open a note first to insert icons.');
        return;
      }
      dispatchEditorToolbarAction('icon');
      ctx.close();
    },
  },
  {
    id: 'open-link-editor',
    keywords: ['link', 'url', 'hyperlink', 'insert link'],
    label: 'Open Link Editor',
    icon: <Link2 className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      if (ctx.activeView !== 'editor') {
        toast.error('Open a note first to insert links.');
        return;
      }
      dispatchEditorToolbarAction('link');
      ctx.close();
    },
  },
  {
    id: 'open-image-editor',
    keywords: ['image', 'picture', 'media', 'insert image'],
    label: 'Open Image Editor',
    icon: <ImageIcon className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      if (ctx.activeView !== 'editor') {
        toast.error('Open a note first to insert images.');
        return;
      }
      dispatchEditorToolbarAction('image');
      ctx.close();
    },
  },
  {
    id: 'open-table-editor',
    keywords: ['table', 'grid', 'insert table'],
    label: 'Open Table Editor',
    icon: <Table2 className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      if (ctx.activeView !== 'editor') {
        toast.error('Open a note first to insert tables.');
        return;
      }
      dispatchEditorToolbarAction('table');
      ctx.close();
    },
  },
  {
    id: 'open-task-list-editor',
    keywords: ['task list', 'checklist', 'todo list', 'insert tasks'],
    label: 'Open Task List Editor',
    icon: <ListTodo className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      if (ctx.activeView !== 'editor') {
        toast.error('Open a note first to insert task lists.');
        return;
      }
      dispatchEditorToolbarAction('taskList');
      ctx.close();
    },
  },
  {
    id: 'open-math-editor',
    keywords: ['math', 'equation', 'formula', 'latex', 'insert math'],
    label: 'Open Math Block Editor',
    icon: <Calculator className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      if (ctx.activeView !== 'editor') {
        toast.error('Open a note first to insert math blocks.');
        return;
      }
      dispatchEditorToolbarAction('math');
      ctx.close();
    },
  },
  {
    id: 'open-code-editor',
    keywords: ['code', 'code block', 'snippet', 'insert code'],
    label: 'Open Code Block Editor',
    icon: <FileCode className="size-4 shrink-0" />,
    onSelect: (ctx) => {
      if (ctx.activeView !== 'editor') {
        toast.error('Open a note first to insert code blocks.');
        return;
      }
      dispatchEditorToolbarAction('code');
      ctx.close();
    },
  },
  {
    id: 'new-kanban',
    keywords: ['new kanban', 'create kanban', 'new board'],
    label: 'New Kanban Board',
    icon: <LayoutDashboard className="size-4 shrink-0" />,
    onSelect: async (ctx, query) => {
      const name = query.replace(/^new\s+kanban\s*/i, '').trim() || 'Board';
      if (!ctx.vault) return;
      try {
        const file = await tauriCommands.createNote(ctx.vault.path, `${name}.kanban`);
        await ctx.refreshFileTree();
        ctx.openTab(file.relativePath, name, 'kanban');
        ctx.setActiveView('kanban');
      } catch (e) {
        toast.error('Failed to create board: ' + e);
      }
      ctx.close();
    },
  },
];
