import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../ui/command';
import {
  FileText,
  LayoutDashboard,
  Layers,
  Hash,
  Calculator,
  FilePlus,
  GitFork,
  Settings,
  Grid3X3,
  Type,
  Copy,
  Tags,
} from 'lucide-react';
import { useVaultStore } from '../../store/vaultStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore, type ActiveView, type DateFormat } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import { evalMath, formatMathResult } from './mathEval';
import { completeInsertQuery, generateSnippets } from './snippets';
import type { NoteMetadata, SearchResult } from '../../types/note';
import { toast } from 'sonner';

// ── Types ──────────────────────────────────────────────────────────────────────

type Mode =
  | { type: 'search';     query: string }
  | { type: 'math';       expr: string }
  | { type: 'action';     query: string }
  | { type: 'tag';        tag: string }
  | { type: 'fileType';   ext: string }
  | { type: 'nameSearch'; query: string }
  | { type: 'insert';     query: string };

interface RenderCtx {
  notes: NoteMetadata[];
  searchResults: SearchResult[];
  activeView: ActiveView;
  vault: import('../../types/vault').VaultMeta | null;
  dateFormat: DateFormat;
  openTab: (relativePath: string, title: string, type?: 'note' | 'canvas' | 'kanban' | 'graph' | 'settings') => void;
  setActiveView: (v: ActiveView) => void;
  openSettings: () => void;
  refreshFileTree: () => Promise<void>;
  setInput: (s: string) => void;
  close: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function detectMode(raw: string): Mode {
  const s = raw.trimStart();

  if (s.startsWith('='))  return { type: 'math',       expr:  s.slice(1).trim() };
  if (s.startsWith('>'))  return { type: 'action',     query: s.slice(1).trim() };

  const tagColon = s.match(/^tag:(.*)$/i);
  if (tagColon)            return { type: 'tag',        tag:   tagColon[1].trim() };
  if (s.startsWith('#'))   return { type: 'tag',        tag:   s.slice(1) };

  const shortTypeMatch = s.match(/^:(md|kanban|canvas)/i);
  if (shortTypeMatch)      return { type: 'fileType',   ext:   shortTypeMatch[1].toLowerCase() };
  const typeMatch = s.match(/^type:(md|kanban|canvas)/i);
  if (typeMatch)           return { type: 'fileType',   ext:   typeMatch[1].toLowerCase() };

  const nameMatch = s.match(/^name:(.*)$/i);
  if (nameMatch)           return { type: 'nameSearch', query: nameMatch[1].trim() };

  if (s.startsWith('/'))   return { type: 'insert',     query: s.slice(1).trim() };
  const insertMatch = s.match(/^insert:(.*)$/i);
  if (insertMatch)         return { type: 'insert',     query: insertMatch[1].trim() };

  // Insert prefixes — shown only when in editor view
  if (/^(table\b|code\b|link\b|date\b|heading\b|h[1-6]\b|hr$|quote\b|blockquote\b|checklist\b|todo\b)/i.test(s)) {
    return { type: 'insert', query: s };
  }

  return { type: 'search', query: s };
}

function getTabType(relativePath: string): 'note' | 'canvas' | 'kanban' {
  if (relativePath.endsWith('.kanban')) return 'kanban';
  if (relativePath.endsWith('.canvas')) return 'canvas';
  return 'note';
}

function getViewForType(type: 'note' | 'canvas' | 'kanban'): ActiveView {
  if (type === 'kanban') return 'kanban';
  if (type === 'canvas') return 'canvas';
  return 'editor';
}

function FileTypeIcon({ path, className = 'size-4 shrink-0 opacity-60' }: { path: string; className?: string }) {
  if (path.endsWith('.kanban')) return <LayoutDashboard className={className} />;
  if (path.endsWith('.canvas')) return <Layers className={className} />;
  return <FileText className={className} />;
}

// ── Mode placeholders ──────────────────────────────────────────────────────────

const MODE_PLACEHOLDER: Record<Mode['type'], string> = {
  search:     'Search notes…',
  math:       'Math — e.g. =sqrt(2)*pi',
  action:     'Action — e.g. > new note My Note',
  tag:        'Filter by tag…',
  fileType:   'Type filter — e.g. :md or type:kanban',
  nameSearch: 'Search by name…',
  insert:     'Insert — e.g. / or /table 3x4',
};

// ── Actions definition ─────────────────────────────────────────────────────────

interface Action {
  id: string;
  keywords: string[];
  label: string;
  icon: React.ReactNode;
  onSelect: (ctx: RenderCtx, query: string) => void | Promise<void>;
}

const ACTIONS: Action[] = [
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

// ── Mode renderers ─────────────────────────────────────────────────────────────

function renderSearch(mode: { type: 'search'; query: string }, ctx: RenderCtx) {
  const { notes, searchResults } = ctx;

  if (!mode.query) {
    const recent = [...notes].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 6);
    if (!recent.length) return <CommandEmpty>No notes yet.</CommandEmpty>;
    return (
      <CommandGroup heading="Recent">
        {recent.map((n) => {
          const type = getTabType(n.relativePath);
          return (
            <CommandItem
              key={n.relativePath}
              value={n.relativePath + n.title}
              onSelect={() => {
                ctx.openTab(n.relativePath, n.title, type);
                ctx.setActiveView(getViewForType(type));
                ctx.close();
              }}
              className="gap-2"
            >
              <FileTypeIcon path={n.relativePath} />
              <span className="truncate flex-1">{n.title}</span>
              {n.tags.slice(0, 2).map((t) => (
                <span key={t} className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  {t}
                </span>
              ))}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50 max-w-[160px] truncate">
                {n.relativePath}
              </span>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  }

  if (!searchResults.length) {
    return <CommandEmpty>No results for "{mode.query}"</CommandEmpty>;
  }

  return (
    <CommandGroup heading="Notes">
      {searchResults.map((r) => {
        const type = getTabType(r.relativePath);
        return (
          <CommandItem
            key={r.relativePath}
            value={r.relativePath + r.title}
            onSelect={() => {
              ctx.openTab(r.relativePath, r.title, type);
              ctx.setActiveView(getViewForType(type));
              ctx.close();
            }}
            className="items-start gap-2"
          >
            <FileTypeIcon path={r.relativePath} className="size-4 shrink-0 opacity-60 mt-0.5" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{r.title}</span>
              {r.excerpt && (
                <span className="truncate text-xs text-muted-foreground">{r.excerpt}</span>
              )}
            </div>
            <span className="shrink-0 rounded bg-muted/60 px-1 text-[10px] text-muted-foreground/70 capitalize">
              {r.matchType}
            </span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function renderMath(mode: { type: 'math'; expr: string }) {
  if (!mode.expr) {
    return (
      <CommandEmpty className="text-muted-foreground">
        Type an expression — e.g. <span className="font-mono">=2^10</span> or <span className="font-mono">=sqrt(144)</span>
      </CommandEmpty>
    );
  }
  const result = evalMath(mode.expr);
  if (result === null) {
    return <CommandEmpty>Invalid expression</CommandEmpty>;
  }
  const display = formatMathResult(result);
  return (
    <CommandGroup heading="Result">
      <CommandItem
        value="math-result"
        onSelect={() => { navigator.clipboard.writeText(display); }}
        className="gap-2"
      >
        <Calculator className="size-4 shrink-0 text-primary" />
        <span className="font-mono text-sm font-medium">{mode.expr.trim()} = {display}</span>
        <CommandShortcut className="flex items-center gap-1">
          <Copy className="size-3" /> copy
        </CommandShortcut>
      </CommandItem>
    </CommandGroup>
  );
}

function renderTag(mode: { type: 'tag'; tag: string }, ctx: RenderCtx) {
  const { notes } = ctx;
  const q = mode.tag.toLowerCase();

  // Unique tags matching the query
  const allTags = [...new Set(notes.flatMap((n) => n.tags))];
  const matchingTags = allTags
    .filter((t) => !q || t.toLowerCase().includes(q))
    .slice(0, 5);

  // Notes that have any matching tag
  const matchingNotes = notes.filter((n) =>
    n.tags.some((t) => !q || t.toLowerCase().includes(q))
  );

  if (!matchingTags.length && !matchingNotes.length) {
    return <CommandEmpty>No notes with tag "{mode.tag}"</CommandEmpty>;
  }

  return (
    <>
      {matchingTags.length > 0 && (
        <CommandGroup heading="Tags">
          {matchingTags.map((t) => (
            <CommandItem
              key={t}
              value={'tag-' + t}
              onSelect={() => ctx.setInput(`#${t}`)}
              className="gap-2"
            >
              <Hash className="size-4 shrink-0 opacity-60" />
              <span>{t}</span>
              <CommandShortcut>
                {notes.filter((n) => n.tags.includes(t)).length} notes
              </CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {matchingTags.length > 0 && matchingNotes.length > 0 && <CommandSeparator />}
      {matchingNotes.length > 0 && (
        <CommandGroup heading="Notes with this tag">
          {matchingNotes.slice(0, 8).map((n) => {
            const type = getTabType(n.relativePath);
            return (
              <CommandItem
                key={n.relativePath}
                value={'tagged-' + n.relativePath}
                onSelect={() => {
                  ctx.openTab(n.relativePath, n.title, type);
                  ctx.setActiveView(getViewForType(type));
                  ctx.close();
                }}
                className="gap-2"
              >
                <FileTypeIcon path={n.relativePath} />
                <span className="truncate flex-1">{n.title}</span>
                <div className="flex shrink-0 gap-1">
                  {n.tags.filter((t) => !q || t.toLowerCase().includes(q)).slice(0, 2).map((t) => (
                    <span key={t} className="rounded bg-primary/15 px-1 text-[10px] text-primary">
                      {t}
                    </span>
                  ))}
                </div>
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}
    </>
  );
}

function renderFileType(mode: { type: 'fileType'; ext: string }, ctx: RenderCtx) {
  const filtered = ctx.notes.filter((n) => n.relativePath.endsWith('.' + mode.ext));
  if (!filtered.length) {
    return <CommandEmpty>No {mode.ext} files found.</CommandEmpty>;
  }
  const labels: Record<string, string> = { md: 'Notes', kanban: 'Kanban Boards', canvas: 'Canvases' };
  return (
    <CommandGroup heading={labels[mode.ext] ?? mode.ext}>
      {filtered.map((n) => {
        const type = getTabType(n.relativePath);
        return (
          <CommandItem
            key={n.relativePath}
            value={n.relativePath}
            onSelect={() => {
              ctx.openTab(n.relativePath, n.title, type);
              ctx.setActiveView(getViewForType(type));
              ctx.close();
            }}
            className="gap-2"
          >
            <FileTypeIcon path={n.relativePath} />
            <span className="truncate flex-1">{n.title}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">{n.relativePath}</span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function renderNameSearch(mode: { type: 'nameSearch'; query: string }, ctx: RenderCtx) {
  const q = mode.query.toLowerCase();
  const filtered = q
    ? ctx.notes.filter((n) => n.title.toLowerCase().includes(q))
    : [...ctx.notes].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 8);

  if (!filtered.length) {
    return <CommandEmpty>No notes named "{mode.query}"</CommandEmpty>;
  }
  return (
    <CommandGroup heading="By name">
      {filtered.map((n) => {
        const type = getTabType(n.relativePath);
        return (
          <CommandItem
            key={n.relativePath}
            value={n.relativePath}
            onSelect={() => {
              ctx.openTab(n.relativePath, n.title, type);
              ctx.setActiveView(getViewForType(type));
              ctx.close();
            }}
            className="gap-2"
          >
            <FileTypeIcon path={n.relativePath} />
            <span className="truncate flex-1">{n.title}</span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function renderActions(mode: { type: 'action'; query: string }, ctx: RenderCtx) {
  const q = mode.query.toLowerCase();
  const matched = ACTIONS.filter((a) =>
    !q || a.keywords.some((k) => k.includes(q)) || a.label.toLowerCase().includes(q)
  );
  if (!matched.length) {
    return <CommandEmpty>No actions matching "{mode.query}"</CommandEmpty>;
  }
  return (
    <CommandGroup heading="Actions">
      {matched.map((a) => (
        <CommandItem
          key={a.id}
          value={'action-' + a.id}
          onSelect={() => a.onSelect(ctx, mode.query)}
          className="gap-2"
        >
          {a.icon}
          <span>{a.label}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function renderInsert(mode: { type: 'insert'; query: string }, ctx: RenderCtx) {
  if (ctx.activeView !== 'editor') {
    return (
      <CommandEmpty>
        Open a note first to insert snippets.
      </CommandEmpty>
    );
  }
  const snippets = generateSnippets(mode.query, ctx.dateFormat);
  if (!snippets.length) {
    return <CommandEmpty>No snippets matching "{mode.query}". Try <span className="font-mono">/</span> to browse.</CommandEmpty>;
  }
  return (
    <CommandGroup heading={mode.query ? 'Insert' : 'Available snippets'}>
      {snippets.map((s, i) => (
        <CommandItem
          key={i}
          value={'snippet-' + s.label}
          onSelect={() => {
            window.dispatchEvent(new CustomEvent('cmdbar:insert', { detail: { text: s.text } }));
            ctx.close();
          }}
          className="gap-2"
        >
          <Type className="size-4 shrink-0 opacity-60" />
          <span className="flex-1">{s.label}</span>
          <CommandShortcut className="font-mono text-[10px]">{s.preview}</CommandShortcut>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function renderMode(mode: Mode, ctx: RenderCtx): React.ReactNode {
  switch (mode.type) {
    case 'search':     return renderSearch(mode, ctx);
    case 'math':       return renderMath(mode);
    case 'action':     return renderActions(mode, ctx);
    case 'tag':        return renderTag(mode, ctx);
    case 'fileType':   return renderFileType(mode, ctx);
    case 'nameSearch': return renderNameSearch(mode, ctx);
    case 'insert':     return renderInsert(mode, ctx);
  }
}

// ── Mode hint strip ────────────────────────────────────────────────────────────

function ModeHints({ current }: { current: Mode['type'] }) {
  const hints: Array<{ label: string; prefix: string; mode: Mode['type'] }> = [
    { label: 'Search',  prefix: '',      mode: 'search' },
    { label: '= Math',  prefix: '=',     mode: 'math' },
    { label: '> Action',prefix: '>',     mode: 'action' },
    { label: '#Tag',    prefix: '#',     mode: 'tag' },
    { label: ':Type',   prefix: ':',     mode: 'fileType' },
    { label: 'name:',   prefix: 'name:', mode: 'nameSearch' },
    { label: '/Insert', prefix: '/',     mode: 'insert' },
  ];
  return (
    <div className="flex flex-wrap gap-1 border-t border-border/40 px-2 py-1.5">
      {hints.map((h) => (
        <span
          key={h.mode}
          className={`rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
            current === h.mode
              ? 'bg-primary/20 text-primary'
              : 'bg-muted/60 text-muted-foreground'
          }`}
        >
          {h.label}
        </span>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function CommandBar() {
  const [open, setOpen]               = useState(false);
  const [input, setInput]             = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const { vault, refreshFileTree }    = useVaultStore();
  const { notes }                     = useNoteIndexStore();
  const { openTab }                   = useEditorStore();
  const { activeView, setActiveView, openSettings, dateFormat } = useUiStore();

  // Hotkey: Ctrl+K (primary) and Ctrl+P (alias)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Programmatic open with optional pre-filled input (e.g. Ctrl+N → '> new note ')
  useEffect(() => {
    const handler = (e: Event) => {
      const prefill = (e as CustomEvent<{ input?: string }>).detail?.input ?? '';
      setInput(prefill);
      setOpen(true);
    };
    window.addEventListener('cmdbar:open', handler);
    return () => window.removeEventListener('cmdbar:open', handler);
  }, []);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setInput('');
      setSearchResults([]);
    }
  }, [open]);

  // Debounced IPC full-text search (only in 'search' mode with a query)
  useEffect(() => {
    const mode = detectMode(input);
    if (mode.type !== 'search' || !vault || !mode.query) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const results = await tauriCommands.searchNotes(vault.path, mode.query);
        setSearchResults(results);
      } catch { /* silent */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [input, vault]);

  const close = useCallback(() => setOpen(false), []);

  const mode = detectMode(input);
  const insertCompletion = mode.type === 'insert' ? completeInsertQuery(mode.query) : null;

  const ctx: RenderCtx = {
    notes,
    searchResults,
    activeView,
    vault,
    dateFormat,
    openTab,
    setActiveView,
    openSettings,
    refreshFileTree,
    setInput,
    close,
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[30%] translate-y-0 overflow-hidden p-0 gap-0 rounded-xl! sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command Bar</DialogTitle>
          <DialogDescription>
            Search notes, run actions, calculate expressions, filter by tag or type, or browse insert snippets.
          </DialogDescription>
        </DialogHeader>

        <Command shouldFilter={false} className="rounded-xl!">
          <CommandInput
            placeholder={MODE_PLACEHOLDER[mode.type]}
            value={input}
            onValueChange={setInput}
            onKeyDown={(e) => {
              if (mode.type !== 'insert' || !insertCompletion) return;
              if (e.key !== 'Tab' && e.key !== 'ArrowRight') return;
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed) return;
              e.preventDefault();
              const prefix = input.trimStart().startsWith('/') ? '/' : input.trimStart().startsWith('insert:') ? 'insert:' : '/';
              setInput(`${prefix}${insertCompletion}`);
            }}
          />
          {mode.type === 'insert' && insertCompletion && (
            <div className="px-3 pb-1 text-[11px] text-muted-foreground">
              <span className="font-mono text-foreground/80">{input.trimStart().startsWith('insert:') ? 'insert:' : '/'}</span>
              <span className="font-mono text-foreground/80">{mode.query}</span>
              <span className="font-mono opacity-50">{insertCompletion.slice(mode.query.trimStart().length)}</span>
              <span className="ml-2 text-[10px] uppercase tracking-wide opacity-60">Tab</span>
              <span className="ml-1 text-[10px] uppercase tracking-wide opacity-60">Right</span>
            </div>
          )}
          <CommandList className="max-h-80">
            {renderMode(mode, ctx)}
          </CommandList>
          <ModeHints current={mode.type} />
        </Command>
      </DialogContent>
    </Dialog>
  );
}
