# collab

A local-first Markdown note-taking desktop app built with Tauri 2, React 19, and CodeMirror 6. Inspired by Obsidian — vaults, wikilinks, live preview, graph view, and real-time collaboration over a shared folder.

## Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 (Rust + WebKitGTK on Linux) |
| Frontend | React 19, Vite, TypeScript |
| Styling | Tailwind CSS v4, shadcn/ui, Radix UI |
| Editor | CodeMirror 6 with custom live-preview plugin |
| Graph | D3 force-directed |
| Canvas | React Flow (placeholder) |
| Kanban | dnd-kit (placeholder) |
| State | Zustand 5 (persisted via localStorage) |

## Features

- **Vault-based workflow** — open or create any folder as a vault; recent vaults remembered across sessions
- **Markdown editor** — CodeMirror 6 with GFM (tables, task lists, strikethrough), live inline preview (headings, bold, italic, code, links, math, HR), syntax highlighting, and wikilink autocompletion
- **Wikilinks** — `[[Note Title]]` autocomplete against all notes in the vault; backlink index maintained in memory
- **Auto-rename** — file is renamed to match the first H1 heading on save
- **Autosave** — 600 ms debounce after last keystroke; Ctrl+S for immediate save
- **Optimistic locking** — SHA-256 hash checked on write; conflicting external edits surface a resolve dialog (keep mine / keep theirs)
- **Graph view** — D3 force-directed graph of all notes and their wikilink connections
- **Full-text search** — fuzzy search across note titles and content via the sidebar
- **Tags panel** — sidebar panel listing all `#tags` found in the vault
- **Collaboration** — presence files written to `{vault}/.collab/presence/` every 10 s; peer avatars shown in the status bar; staleness threshold 30 s
- **Theming** — four base themes (Dark, Midnight, Warm, Light) × six accent colours (Violet, Blue, Emerald, Rose, Orange, Cyan); all colours applied as CSS variables at runtime
- **HiDPI scaling** — UI scale 75 %–200 % via Tauri's native webview zoom (Settings → Display)
- **Editor fonts** — Geist (default), Inter, Serif, Monospace
- **Font size** — 12–16 px base size with live preview
- **Confirm-delete toggle** — optional confirmation dialog before deleting notes or folders
- **Command palette** — Ctrl+K quick-open
- **Editor toolbar** — heading shortcuts, bold, italic, strikethrough, code, link, image, table, HR, math

## Project layout

```
src/
  components/
    editor/         — MarkdownEditor (CodeMirror), EditorToolbar, livePreview plugin
    collaboration/  — CollabProvider, ConflictDialog, presence avatars
    command-palette/
    graph/          — GraphPage (D3)
    layout/         — AppShell, ActivityBar, Sidebar, TabBar, StatusBar
    settings/       — SettingsModal (Appearance / Editor / Display / Profile tabs)
    ui/             — shadcn/ui primitives
    vault/          — VaultPicker
  store/
    vaultStore      — open vault, file tree
    editorStore     — open tabs, dirty/hash tracking
    uiStore         — theme, accent, font, scale (persisted)
    noteIndexStore  — note metadata, wikilink map
    collabStore     — peer presence, conflict queue
  views/
    NoteView        — loads/saves a note, wires editor ↔ store
  lib/
    tauri.ts        — typed wrappers around all Tauri IPC commands

src-tauri/
  src/
    commands/
      vault.rs      — open_vault, create_vault, get_recent_vaults, show_open_vault_dialog
      files.rs      — list_vault_files, read_note, write_note, create/delete/rename
      index.rs      — build_note_index, get_backlinks, search_notes
      watcher.rs    — watch_vault (notify-debouncer-mini), unwatch_vault
      collab.rs     — write_presence, read_all_presence, clear_presence, vault config
    models/         — shared data types (serde)
    state/          — AppState with parking_lot Mutexes
```

## Development

```bash
# Full app (Tauri window + Vite dev server)
pnpm tauri dev

# Frontend only (browser, port 1420)
pnpm dev

# Type-check frontend
pnpm exec tsc --noEmit

# Check Rust backend
cd src-tauri && cargo check

# Production bundle
pnpm tauri build
```

**Requirements:** Rust (stable), Node.js ≥ 20, pnpm, and the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS (WebKitGTK on Linux).

## Linux notes

Two WebKitGTK environment flags are set at startup to avoid blank-window crashes on certain kernel/driver combinations:

```
WEBKIT_DISABLE_DMABUF_RENDERER=1
WEBKIT_DISABLE_COMPOSITING_MODE=1
```
