import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from '../ui/command';
import {
  Calculator,
  Copy,
  FileText,
  Hash,
  Layers,
  LayoutDashboard,
  Settings,
  Type,
} from 'lucide-react';

import { evalMath, formatMathResult } from './mathEval';
import { generateSnippets } from './snippets';
import {
  formatNerdFontHexCode,
  groupNerdFontIcons,
  isNerdFontIconQuery,
  searchNerdFontIcons,
} from '../../lib/nerdFontIcons';
import {
  getTabType,
  getViewForType,
  type Mode,
} from './commandBarUtils';
import { ACTIONS, SETTINGS_SECTIONS, type RenderCtx } from './commandBarActions';

function FileTypeIcon({ path, className = 'size-4 shrink-0 opacity-60' }: { path: string; className?: string }) {
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/i.test(path)) return <FileText className={className} />;
  if (/\.pdf$/i.test(path)) return <FileText className={className} />;
  if (path.endsWith('.kanban')) return <LayoutDashboard className={className} />;
  if (path.endsWith('.canvas')) return <Layers className={className} />;
  return <FileText className={className} />;
}

function renderSearch(mode: { type: 'search'; query: string }, ctx: RenderCtx) {
  const { files, searchResults } = ctx;

  if (!mode.query) {
    const recent = [...files].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 8);
    if (!recent.length) return <CommandEmpty>No files yet.</CommandEmpty>;
    return (
      <CommandGroup heading="Recent">
        {recent.map((file) => {
          const type = getTabType(file.relativePath);
          return (
            <CommandItem
              key={file.relativePath}
              value={file.relativePath + file.name}
              onSelect={() => {
                ctx.openTab(file.relativePath, file.name, type);
                ctx.setActiveView(getViewForType(type));
                ctx.close();
              }}
              className="gap-2"
            >
              <FileTypeIcon path={file.relativePath} />
              <span className="truncate flex-1">{file.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50 max-w-[160px] truncate">
                {file.relativePath}
              </span>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  }

  const q = mode.query.toLowerCase();
  const settingMatches = SETTINGS_SECTIONS
    .filter((section) =>
      `${section.label} settings ${section.keywords.join(' ')}`.toLowerCase().includes(q)
    )
    .slice(0, 6);
  const fileMatches = files
    .filter((file) =>
      file.name.toLowerCase().includes(q)
      || file.relativePath.toLowerCase().includes(q)
    )
    .filter((file) => !searchResults.some((result) => result.relativePath === file.relativePath))
    .slice(0, 8);

  if (!searchResults.length && !fileMatches.length && !settingMatches.length) {
    return <CommandEmpty>No results for "{mode.query}"</CommandEmpty>;
  }

  return (
    <>
      {settingMatches.length > 0 && (
        <CommandGroup heading="Settings">
          {settingMatches.map((section) => (
            <CommandItem
              key={section.id}
              value={`settings-${section.id}${section.label}`}
              onSelect={() => {
                ctx.openSettings();
                window.setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('settings:open-tab', { detail: { tab: section.id } }));
                }, 0);
                ctx.close();
              }}
              className="gap-2"
            >
              <Settings className="size-4 shrink-0 opacity-60" />
              <span className="flex-1">{section.label}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/60">Settings</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {settingMatches.length > 0 && (searchResults.length > 0 || fileMatches.length > 0) && <CommandSeparator />}
      {searchResults.length > 0 && (
        <CommandGroup heading="Notes">
          {searchResults.map((result) => {
            const type = getTabType(result.relativePath);
            return (
              <CommandItem
                key={result.relativePath}
                value={result.relativePath + result.title}
                onSelect={() => {
                  ctx.openTab(result.relativePath, result.title, type);
                  ctx.setActiveView(getViewForType(type));
                  ctx.close();
                }}
                className="items-start gap-2"
              >
                <FileTypeIcon path={result.relativePath} className="size-4 shrink-0 opacity-60 mt-0.5" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{result.title}</span>
                  {result.excerpt && (
                    <span className="truncate text-xs text-muted-foreground">{result.excerpt}</span>
                  )}
                </div>
                <span className="shrink-0 rounded bg-muted/60 px-1 text-[10px] text-muted-foreground/70 capitalize">
                  {result.matchType}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}
      {searchResults.length > 0 && fileMatches.length > 0 && <CommandSeparator />}
      {fileMatches.length > 0 && (
        <CommandGroup heading="Files">
          {fileMatches.map((file) => {
            const type = getTabType(file.relativePath);
            return (
              <CommandItem
                key={file.relativePath}
                value={file.relativePath + file.name}
                onSelect={() => {
                  ctx.openTab(file.relativePath, file.name, type);
                  ctx.setActiveView(getViewForType(type));
                  ctx.close();
                }}
                className="gap-2"
              >
                <FileTypeIcon path={file.relativePath} />
                <span className="truncate flex-1">{file.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50 max-w-[180px] truncate">
                  {file.relativePath}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}
    </>
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
  const allTags = [...new Set(notes.flatMap((note) => note.tags))];
  const matchingTags = allTags
    .filter((tag) => !q || tag.toLowerCase().includes(q))
    .slice(0, 5);
  const matchingNotes = notes.filter((note) =>
    note.tags.some((tag) => !q || tag.toLowerCase().includes(q))
  );

  if (!matchingTags.length && !matchingNotes.length) {
    return <CommandEmpty>No notes with tag "{mode.tag}"</CommandEmpty>;
  }

  return (
    <>
      {matchingTags.length > 0 && (
        <CommandGroup heading="Tags">
          {matchingTags.map((tag) => (
            <CommandItem
              key={tag}
              value={'tag-' + tag}
              onSelect={() => ctx.setInput(`#${tag}`)}
              className="gap-2"
            >
              <Hash className="size-4 shrink-0 opacity-60" />
              <span>{tag}</span>
              <CommandShortcut>
                {notes.filter((note) => note.tags.includes(tag)).length} notes
              </CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {matchingTags.length > 0 && matchingNotes.length > 0 && <CommandSeparator />}
      {matchingNotes.length > 0 && (
        <CommandGroup heading="Notes with this tag">
          {matchingNotes.slice(0, 8).map((note) => {
            const type = getTabType(note.relativePath);
            return (
              <CommandItem
                key={note.relativePath}
                value={'tagged-' + note.relativePath}
                onSelect={() => {
                  ctx.openTab(note.relativePath, note.title, type);
                  ctx.setActiveView(getViewForType(type));
                  ctx.close();
                }}
                className="gap-2"
              >
                <FileTypeIcon path={note.relativePath} />
                <span className="truncate flex-1">{note.title}</span>
                <div className="flex shrink-0 gap-1">
                  {note.tags.filter((tag) => !q || tag.toLowerCase().includes(q)).slice(0, 2).map((tag) => (
                    <span key={tag} className="rounded bg-primary/15 px-1 text-[10px] text-primary">
                      {tag}
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
  const filtered = ctx.files.filter((file) => file.extension.toLowerCase() === mode.ext);
  if (!filtered.length) {
    return <CommandEmpty>No {mode.ext} files found.</CommandEmpty>;
  }
  const labels: Record<string, string> = { md: 'Notes', kanban: 'Kanban Boards', canvas: 'Canvases', pdf: 'PDFs' };
  return (
    <CommandGroup heading={labels[mode.ext] ?? mode.ext}>
      {filtered.map((file) => {
        const type = getTabType(file.relativePath);
        return (
          <CommandItem
            key={file.relativePath}
            value={file.relativePath}
            onSelect={() => {
              ctx.openTab(file.relativePath, file.name, type);
              ctx.setActiveView(getViewForType(type));
              ctx.close();
            }}
            className="gap-2"
          >
            <FileTypeIcon path={file.relativePath} />
            <span className="truncate flex-1">{file.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">{file.relativePath}</span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function renderNameSearch(mode: { type: 'nameSearch'; query: string }, ctx: RenderCtx) {
  const q = mode.query.toLowerCase();
  const filtered = q
    ? ctx.files.filter((file) =>
      file.name.toLowerCase().includes(q)
      || file.relativePath.toLowerCase().includes(q)
    )
    : [...ctx.files].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 8);

  if (!filtered.length) {
    return <CommandEmpty>No files named "{mode.query}"</CommandEmpty>;
  }
  return (
    <CommandGroup heading="By name">
      {filtered.map((file) => {
        const type = getTabType(file.relativePath);
        return (
          <CommandItem
            key={file.relativePath}
            value={file.relativePath}
            onSelect={() => {
              ctx.openTab(file.relativePath, file.name, type);
              ctx.setActiveView(getViewForType(type));
              ctx.close();
            }}
            className="gap-2"
          >
            <FileTypeIcon path={file.relativePath} />
            <span className="truncate flex-1">{file.name}</span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function renderActions(mode: { type: 'action'; query: string }, ctx: RenderCtx) {
  const q = mode.query.toLowerCase();
  const matched = ACTIONS.filter((action) =>
    !q || action.keywords.some((keyword) => keyword.includes(q)) || action.label.toLowerCase().includes(q)
  );
  if (!matched.length) {
    return <CommandEmpty>No actions matching "{mode.query}"</CommandEmpty>;
  }
  return (
    <CommandGroup heading="Actions">
      {matched.map((action) => (
        <CommandItem
          key={action.id}
          value={'action-' + action.id}
          onSelect={() => action.onSelect(ctx, mode.query)}
          className="gap-2"
        >
          {action.icon}
          <span>{action.label}</span>
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
  if (isNerdFontIconQuery(mode.query)) {
    const icons = searchNerdFontIcons(mode.query, 120);
    if (!icons.length) {
      return <CommandEmpty>No icons matching "{mode.query}".</CommandEmpty>;
    }
    return (
      <>
        {groupNerdFontIcons(icons).map(([categoryLabel, entries]) => (
          <CommandGroup key={categoryLabel} heading={categoryLabel}>
            {entries.map((entry) => (
              <CommandItem
                key={entry.id}
                value={`icon-${entry.id}`}
                onSelect={() => {
                  window.dispatchEvent(new CustomEvent('cmdbar:insert', { detail: { text: entry.glyph } }));
                  ctx.close();
                }}
                className="gap-3"
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-[18px] leading-none"
                  style={{ fontFamily: "'Pure Nerd Font', PureNerdFont, monospace" }}
                  aria-hidden="true"
                >
                  {entry.glyph}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{entry.nameLabel}</span>
                  <span className="block truncate text-xs text-muted-foreground">{entry.id}</span>
                </span>
                <CommandShortcut className="tracking-normal">{formatNerdFontHexCode(entry.hexCode)}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </>
    );
  }
  const snippets = generateSnippets(mode.query, ctx.dateFormat);
  if (!snippets.length) {
    return <CommandEmpty>No snippets matching "{mode.query}". Try <span className="font-mono">/</span> to browse.</CommandEmpty>;
  }
  return (
    <CommandGroup heading={mode.query ? 'Insert' : 'Available snippets'}>
      {snippets.map((snippet, index) => (
        <CommandItem
          key={index}
          value={'snippet-' + snippet.label}
          onSelect={() => {
            window.dispatchEvent(new CustomEvent('cmdbar:insert', { detail: { text: snippet.text } }));
            ctx.close();
          }}
          className="gap-2"
        >
          <Type className="size-4 shrink-0 opacity-60" />
          <span className="flex-1">{snippet.label}</span>
          <CommandShortcut className="font-mono text-[10px]">{snippet.preview}</CommandShortcut>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function CommandBarModeContent({ mode, ctx }: { mode: Mode; ctx: RenderCtx }) {
  switch (mode.type) {
    case 'search':
      return renderSearch(mode, ctx);
    case 'math':
      return renderMath(mode);
    case 'action':
      return renderActions(mode, ctx);
    case 'tag':
      return renderTag(mode, ctx);
    case 'fileType':
      return renderFileType(mode, ctx);
    case 'nameSearch':
      return renderNameSearch(mode, ctx);
    case 'insert':
      return renderInsert(mode, ctx);
  }
}

export function CommandBarModeHints({ current }: { current: Mode['type'] }) {
  const hints: Array<{ label: string; prefix: string; mode: Mode['type'] }> = [
    { label: 'Search', prefix: '', mode: 'search' },
    { label: '= Math', prefix: '=', mode: 'math' },
    { label: '> Action', prefix: '>', mode: 'action' },
    { label: '#Tag', prefix: '#', mode: 'tag' },
    { label: ':Type', prefix: ':', mode: 'fileType' },
    { label: 'name:', prefix: 'name:', mode: 'nameSearch' },
    { label: '/Insert', prefix: '/', mode: 'insert' },
  ];
  return (
    <div className="flex flex-wrap gap-1 border-t border-border/40 px-2 py-1.5">
      {hints.map((hint) => (
        <span
          key={hint.mode}
          className={`rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
            current === hint.mode
              ? 'bg-primary/20 text-primary'
              : 'bg-muted/60 text-muted-foreground'
          }`}
        >
          {hint.label}
        </span>
      ))}
    </div>
  );
}
