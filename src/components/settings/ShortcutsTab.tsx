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
      { label: 'Toggle sidebar',  keys: [['Ctrl', '\\']] },
      { label: 'Files view',      keys: [['Ctrl', '1']] },
      { label: 'Graph view',      keys: [['Ctrl', '2']] },
      { label: 'Kanban view',     keys: [['Ctrl', '3']] },
      { label: 'Grid view',       keys: [['Ctrl', '4']] },
      { label: 'Open Settings',   keys: [['Ctrl', ',']] },
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
    rows: [
      { label: 'Command bar',     keys: [['Ctrl', 'K'], ['Ctrl', 'P']] },
      { label: 'New note',        keys: [['Ctrl', 'N']] },
    ],
  },
  {
    heading: 'Editor',
    note: 'Only active when the editor is focused.',
    rows: [
      { label: 'Save',            keys: [['Ctrl', 'S']] },
      { label: 'Bold',            keys: [['Ctrl', 'B']] },
      { label: 'Italic',          keys: [['Ctrl', 'I']] },
      { label: 'Undo',            keys: [['Ctrl', 'Z']] },
      { label: 'Redo',            keys: [['Ctrl', 'Shift', 'Z']] },
      { label: 'Indent',          keys: [['Tab']] },
      { label: 'Dedent',          keys: [['Shift', 'Tab']] },
    ],
  },
];

export default function ShortcutsTab() {
  return (
    <div className="space-y-6">
      {GROUPS.map((group) => (
        <section key={group.heading}>
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">
            {group.heading}
          </p>
          {group.note && (
            <p className="text-[12px] text-muted-foreground/70 mb-2 -mt-1">{group.note}</p>
          )}
          <div className="divide-y divide-border/30">
            {group.rows.map((row) => (
              <div key={row.label} className="flex items-center justify-between py-2">
                <span className="text-sm text-foreground/80">{row.label}</span>
                <div className="flex items-center gap-2">
                  {row.keys.map((combo, ci) => (
                    <span key={ci} className="flex items-center gap-1">
                      {ci > 0 && (
                        <span className="text-[11px] text-muted-foreground/50 mx-0.5">or</span>
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
        </section>
      ))}
    </div>
  );
}
