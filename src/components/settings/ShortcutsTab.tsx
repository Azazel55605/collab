import { useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';

// Read-only keyboard shortcut reference rendered in the Settings modal.

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono border border-border/50 text-foreground/80">
      {children}
    </kbd>
  );
}

interface ShortcutRow {
  label: string;
  keys: string[][];   // outer = combos joined by "+", inner = individual tokens
}

interface Group {
  heading: string;
  note?: string;
  rows: ShortcutRow[];
}

const GROUPS: Group[] = [
  {
    heading: 'Navigation',
    rows: [
      { label: 'Toggle sidebar',  keys: [['Ctrl', 'Shift', 'B']] },
      { label: 'Files view',      keys: [['Ctrl', '1']] },
      { label: 'Graph view',      keys: [['Ctrl', '2']] },
      { label: 'Kanban view',     keys: [['Ctrl', '3']] },
      { label: 'Grid view',       keys: [['Ctrl', '4']] },
      { label: 'Open Settings',   keys: [['Ctrl', 'Shift', 'S']] },
    ],
  },
  {
    heading: 'Tabs',
    rows: [
      { label: 'Close tab',       keys: [['Ctrl', 'W']] },
      { label: 'Next tab',        keys: [['Ctrl', 'Tab']] },
      { label: 'Previous tab',    keys: [['Ctrl', 'Shift', 'Tab']] },
    ],
  },
  {
    heading: 'Search & Actions',
    note: 'Prefixes below are typed into the command bar after it is open; they are not global shortcuts.',
    rows: [
      { label: 'Command bar',     keys: [['Ctrl', 'K'], ['Ctrl', 'P']] },
      { label: 'New note',        keys: [['Ctrl', 'N']] },
      { label: 'Math prefix', keys: [['Type', '=']] },
      { label: 'Action prefix', keys: [['Type', '>']] },
      { label: 'Tag prefix', keys: [['Type', '#']] },
      { label: 'Insert prefix', keys: [['Type', '/']] },
    ],
  },
  {
    heading: 'Editor',
    note: 'Only active when the editor is focused.',
    rows: [
      { label: 'Save',            keys: [['Ctrl', 'S']] },
      { label: 'Bold',            keys: [['Ctrl', 'B']] },
      { label: 'Italic',          keys: [['Ctrl', 'I']] },
      { label: 'Strikethrough',   keys: [['Ctrl', 'Shift', 'X']] },
      { label: 'Undo',            keys: [['Ctrl', 'Z']] },
      { label: 'Redo',            keys: [['Ctrl', 'Shift', 'Z']] },
      { label: 'Indent',          keys: [['Tab']] },
      { label: 'Dedent',          keys: [['Shift', 'Tab']] },
      { label: 'Open icon picker', keys: [['Ctrl', 'Alt', 'S']] },
      { label: 'Open table editor', keys: [['Ctrl', 'Alt', 'T']] },
      { label: 'Open link editor', keys: [['Ctrl', 'Alt', 'L']] },
      { label: 'Open image editor', keys: [['Ctrl', 'Alt', 'I']] },
      { label: 'Open task list editor', keys: [['Ctrl', 'Alt', 'K']] },
      { label: 'Open math block editor', keys: [['Ctrl', 'Alt', 'M']] },
      { label: 'Open code block editor', keys: [['Ctrl', 'Alt', 'C']] },
    ],
  },
  {
    heading: 'PDF Viewer',
    note: 'Only active when a PDF tab is open and an input field is not focused.',
    rows: [
      { label: 'Single page mode',  keys: [['1']] },
      { label: 'Long scroll mode',  keys: [['2']] },
      { label: 'Side by side mode', keys: [['3']] },
      { label: 'Rotate page',       keys: [['R']] },
      { label: 'Scroll up',         keys: [['Arrow Up']] },
      { label: 'Scroll down',       keys: [['Arrow Down']] },
      { label: 'Previous page',     keys: [['Arrow Left'], ['Page Up'], ['Shift', 'Space']] },
      { label: 'Next page',         keys: [['Arrow Right'], ['Page Down'], ['Space']] },
      { label: 'First page',        keys: [['Home']] },
      { label: 'Last page',         keys: [['End']] },
      { label: 'Zoom in',           keys: [['Ctrl', 'Arrow Up']] },
      { label: 'Zoom out',          keys: [['Ctrl', 'Arrow Down']] },
      { label: 'Reset zoom',        keys: [['Ctrl', '0'], ['0']] },
    ],
  },
  {
    heading: 'Image Viewer',
    note: 'Only active when an image tab is open and an input field or dialog is not focused.',
    rows: [
      { label: 'View mode',          keys: [['1']] },
      { label: 'Additive mode',      keys: [['2']] },
      { label: 'Permanent mode',     keys: [['3']] },
      { label: 'Select tool',        keys: [['S']] },
      { label: 'Text tool',          keys: [['T']] },
      { label: 'Arrow tool',         keys: [['A']] },
      { label: 'Freehand tool',      keys: [['F']] },
      { label: 'Rotate image',       keys: [['R']] },
      { label: 'Crop',               keys: [['C']] },
      { label: 'Toggle lock ratio',  keys: [['L']] },
      { label: 'Delete selection',   keys: [['Delete'], ['Backspace']] },
      { label: 'Cancel crop / clear selection', keys: [['Escape']] },
      { label: 'Scroll up',          keys: [['Arrow Up']] },
      { label: 'Scroll down',        keys: [['Arrow Down']] },
      { label: 'Zoom in',            keys: [['Ctrl', 'Arrow Up']] },
      { label: 'Zoom out',           keys: [['Ctrl', 'Arrow Down']] },
      { label: 'Reset zoom',         keys: [['Ctrl', '0'], ['0']] },
    ],
  },
  {
    heading: 'Kanban Board',
    note: 'Only active when a kanban board tab is open and an input field is not focused.',
    rows: [
      { label: 'Board view',         keys: [['1'], ['B']] },
      { label: 'Calendar view',      keys: [['2'], ['C']] },
      { label: 'Timeline view',      keys: [['3'], ['T']] },
      { label: 'Add column',         keys: [['N']] },
      { label: 'Toggle archive',     keys: [['Shift', 'A']] },
      { label: 'Scroll board left',  keys: [['Arrow Left']] },
      { label: 'Scroll board right', keys: [['Arrow Right']] },
      { label: 'Jump to board start', keys: [['Home']] },
      { label: 'Jump to board end',   keys: [['End']] },
      { label: 'Cancel new column',  keys: [['Escape']] },
    ],
  },
  {
    heading: 'Canvas',
    note: 'Only active when a canvas tab is open and an input field or picker is not focused.',
    rows: [
      { label: 'Add note',           keys: [['N']] },
      { label: 'Add file',           keys: [['F']] },
      { label: 'Add text',           keys: [['T']] },
      { label: 'Fit view',           keys: [['Shift', 'F']] },
      { label: 'Pan up',             keys: [['Arrow Up']] },
      { label: 'Pan down',           keys: [['Arrow Down']] },
      { label: 'Pan left',           keys: [['Arrow Left']] },
      { label: 'Pan right',          keys: [['Arrow Right']] },
      { label: 'Delete selection',   keys: [['Delete'], ['Backspace']] },
      { label: 'Close picker',       keys: [['Escape']] },
      { label: 'Zoom in',            keys: [['Ctrl', 'Arrow Up']] },
      { label: 'Zoom out',           keys: [['Ctrl', 'Arrow Down']] },
      { label: 'Reset zoom',         keys: [['Ctrl', '0'], ['0']] },
    ],
  },
];

export default function ShortcutsTab() {
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const normalizedQuery = query.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return GROUPS;

    return GROUPS.map((group) => ({
      ...group,
      rows: group.rows.filter((row) => {
        const keyText = row.keys.map((combo) => combo.join(' ')).join(' ');
        return `${group.heading} ${row.label} ${keyText}`.toLowerCase().includes(normalizedQuery);
      }),
    })).filter((group) => group.rows.length > 0 || group.heading.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery]);

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search shortcuts..."
          className="h-9 border-border/40 bg-background/50 pl-8 text-sm"
        />
      </div>

      {filteredGroups.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/50 px-4 py-8 text-center text-sm text-muted-foreground">
          No shortcuts matched "{query}".
        </div>
      )}

      {filteredGroups.map((group) => (
        <section key={group.heading}>
          {(() => {
            const isCollapsed = !normalizedQuery && !!collapsedGroups[group.heading];

            return (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedGroups((current) => ({
                      ...current,
                      [group.heading]: !current[group.heading],
                    }))
                  }
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors app-motion-fast hover:bg-accent/35"
                >
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {group.heading}
                    </p>
                    {group.note && (
                      <p className="mt-1 text-[12px] text-muted-foreground/70">{group.note}</p>
                    )}
                  </div>
                  <ChevronDown
                    size={15}
                    className={cn(
                      'shrink-0 text-muted-foreground transition-transform app-motion-fast',
                      !isCollapsed && 'rotate-180',
                    )}
                  />
                </button>

                {!isCollapsed && (
                  <div className="mt-2 divide-y divide-border/30">
                    {group.rows.map((row) => (
                      <div key={row.label} className="flex items-center justify-between py-2">
                        <span className="text-sm text-foreground/80">{row.label}</span>
                        <div className="flex items-center gap-2">
                          {row.keys.map((combo, ci) => (
                            <span key={ci} className="flex items-center gap-1">
                              {ci > 0 && (
                                <span className="mx-0.5 text-[11px] text-muted-foreground/50">or</span>
                              )}
                              {combo.map((token, ti) => (
                                <span key={ti} className="flex items-center gap-0.5">
                                  {ti > 0 && (
                                    <span className="text-[11px] text-muted-foreground/40">+</span>
                                  )}
                                  <Key>{token}</Key>
                                </span>
                              ))}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </section>
      ))}
    </div>
  );
}
