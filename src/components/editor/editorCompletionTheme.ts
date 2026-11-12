export const editorTooltipSurface = {
  border: '1px solid color-mix(in oklch, var(--border) 60%, transparent)',
  borderRadius: '8px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
  overflow: 'hidden',
  backgroundColor: 'color-mix(in oklch, var(--popover) 92%, transparent)',
};

// Keep the editor suggestion menus consistent across languages.
export const editorCompletionTheme = {
  '.cm-tooltip.cm-tooltip-autocomplete': {
    ...editorTooltipSurface,
    color: 'var(--popover-foreground)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: "'Geist Variable', system-ui, sans-serif",
    margin: '0',
    padding: '4px',
    minWidth: 'min(220px, 95vw)',
    maxWidth: 'min(340px, 95vw)',
    maxHeight: '260px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    padding: '5px 8px',
    borderRadius: '5px',
    cursor: 'pointer',
    lineHeight: '1.4',
    gap: '8px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'color-mix(in oklch, var(--primary) 15%, transparent)',
    color: 'var(--foreground)',
  },
  '.cm-completionLabel': {
    fontSize: '13px',
    color: 'var(--foreground)',
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-completionDetail': {
    fontSize: '11px',
    color: 'var(--muted-foreground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '120px',
    textAlign: 'right',
    fontStyle: 'normal',
  },
  '.cm-collab-completion-icon': {
    width: '14px',
    height: '14px',
    flex: 'none',
    color: 'var(--muted-foreground)',
  },
};
