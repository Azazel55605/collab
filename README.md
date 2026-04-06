# collab

A local-first Markdown note-taking desktop app built with Tauri 2, React 19, and CodeMirror 6. Inspired by Obsidian — vaults, wikilinks, live preview, graph view, real-time collaboration over a shared folder, and AES-256-GCM vault encryption.

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
| Encryption | AES-256-GCM · Argon2id key derivation |

## Features

### Editor
- **Markdown editor** — CodeMirror 6 with GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks)
- **Live inline preview** — Obsidian-style: headings resize, bold/italic/code/links/wikilinks render, tables replaced with a proper HTML table widget, math rendered via KaTeX, horizontal rules replaced with a visual divider; cursor line always shows raw markdown
- **Wikilinks** — `[[Note Title]]` autocomplete against all notes in the vault; backlink index maintained in memory
- **Auto-rename** — file is renamed to match the first H1 heading on save; new notes open with `# filename` pre-filled
- **Autosave** — 600 ms debounce after last keystroke; Ctrl+S for immediate save
- **Optimistic locking** — SHA-256 hash checked on write; conflicting external edits surface a resolve dialog (keep mine / keep theirs)
- **Editor toolbar** — heading shortcuts, bold, italic, strikethrough, highlight, code, inline math, blockquote, lists, task list, link, image, table, HR, math block
- **Keyboard shortcuts** — Ctrl+B bold, Ctrl+I italic, Ctrl+Z/Shift+Z undo/redo, Tab indent, Ctrl+S save

### Vault management
- **Vault manager** — accessible from the ActivityBar (vault icon) or by clicking the vault name in the status bar
- **Create vaults** — pick a folder and name it; a new vault is initialised with `vault.json` and a `.collab/` directory
- **Import folders** — open any existing folder as a vault (vault config is created automatically on first open)
- **Export vaults** — ZIP the entire vault to a user-chosen path (presence files excluded)
- **Recent vaults** — up to 20 recent vaults remembered; open, rename, export, or remove any entry from the list
- **Switch vaults** — open a different vault at any time from within the app; tabs and state reset cleanly

### Encryption
- **AES-256-GCM at rest** — every note, canvas, and kanban file is encrypted individually with a fresh 12-byte random nonce per write
- **Argon2id key derivation** — the AES key is derived from the vault password using Argon2id; the password is never stored
- **Per-vault salt** — a 32-byte random salt stored in `{vault}/.collab/vault.enc` ensures keys are unique across vaults even with the same password
- **Unlock screen** — encrypted vaults show a password prompt before the editor is accessible; file tree is not loaded until unlocked
- **Enable / disable** — encryption can be toggled from Vault Manager → Encryption; all files are re-encrypted or decrypted in place
- **Change password** — re-keys all files atomically (decrypt → new salt → re-encrypt)
- **Transparent to the rest of the app** — search, index, backlinks, and conflict detection all work identically on encrypted and plaintext vaults

### Collaboration
- **Presence** — presence files written to `{vault}/.collab/presence/{userId}.json` every 10 s; peer avatars shown in the status bar; staleness threshold 30 s
- **Conflict resolution** — when two peers write the same note concurrently the app surfaces a diff dialog (keep mine / keep theirs)
- **Permissions** — per-vault role assignments (Viewer / Editor / Admin) stored in `vault.json`; managed from Vault Manager → Permissions

### Views

| View | Status |
|------|--------|
| Markdown editor (CodeMirror 6) | ✅ implemented |
| Graph view (D3 force-directed) | ✅ implemented |
| Grid / workspace view | ✅ implemented |
| Canvas (React Flow) | 🔲 placeholder |
| Kanban (dnd-kit) | 🔲 placeholder |

### Navigation & UI
- **Graph view** — D3 force-directed graph of all notes and their wikilink connections; click a node to open the note
- **Grid / workspace** — split-pane workspace; drag tabs between cells to arrange multiple notes and views side by side
- **Tabbed editing** — multiple notes open simultaneously with dirty-state indicators; drag tabs to reorder
- **Command palette** — Ctrl+K quick-open across all notes in the vault
- **Full-text search** — fuzzy search across note titles and content via the sidebar
- **Tags panel** — sidebar panel listing all `#tags` found in the vault with per-tag note counts
- **File tree** — hierarchical file browser with drag-and-drop move, context menu (rename, delete, new note/folder), and presence avatars on actively-edited files

### Appearance & settings
- **Themes** — Dark, Midnight, Warm, Light
- **Accent colours** — Violet, Blue, Emerald, Rose, Orange, Cyan; applied as CSS variables at runtime
- **Editor fonts** — Geist (default), Inter, Serif, Monospace
- **Font size** — 12–16 px base size
- **HiDPI scaling** — UI scale 75 %–200 % via Tauri's native webview zoom
- **Confirm-delete toggle** — optional confirmation dialog before deleting notes or folders

## Project layout

```
src/
  components/
    editor/         — MarkdownEditor (CodeMirror 6), EditorToolbar, livePreview plugin, MarkdownPreview
    collaboration/  — CollabProvider, ConflictDialog, PresenceBar
    command-palette/
    graph/          — GraphView (D3)
    grid/           — WorkspaceBar, GridCell, SplitDropZones, CellContentPicker
    layout/         — AppShell, ActivityBar, Sidebar, TabBar, StatusBar
    settings/       — SettingsModal (Appearance / Editor / Display / Profile tabs)
    ui/             — shadcn/ui primitives
    vault/          — VaultPicker, VaultManagerModal, VaultUnlockModal, FileTree, VaultDialogs
  store/
    vaultStore      — open vault, file tree, locked state
    editorStore     — open tabs, dirty/hash tracking
    uiStore         — theme, accent, font, scale, modal state (persisted)
    noteIndexStore  — note metadata, wikilink map
    collabStore     — peer presence, conflict queue
  views/
    NoteView        — loads/saves a note, wires editor ↔ store
    GraphPage       — graph view host
    GridView        — workspace/grid view host
  lib/
    tauri.ts        — typed wrappers around all Tauri IPC commands

src-tauri/
  src/
    commands/
      vault.rs      — open_vault, create_vault, rename_vault, remove_recent_vault,
                      export_vault, show_open_vault_dialog, show_save_dialog
      files.rs      — list_vault_files, read_note, write_note, create/delete/rename
                      (encryption-aware: decrypts on read, encrypts on write)
      index.rs      — build_note_index, get_backlinks, search_notes (decrypts before indexing)
      watcher.rs    — watch_vault (notify-debouncer-mini, emits vault:file-modified events)
      collab.rs     — write_presence, read_all_presence, clear_presence, get/update_vault_config
      crypto.rs     — unlock_vault, enable_vault_encryption, disable_vault_encryption,
                      change_vault_password
    crypto.rs       — AES-256-GCM + Argon2id primitives, vault.enc helpers, bulk encrypt/decrypt
    models/         — VaultMeta, VaultConfig (owner, members, isEncrypted), NoteFile,
                      NoteContent, WriteResult, ConflictInfo, NoteMetadata, PresenceEntry,
                      MemberRole, VaultMember
    state/          — AppState (active vault, file watcher, note index, encryption key) via parking_lot locks
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

# Add shadcn/ui components
pnpm dlx shadcn@latest add <component>
```

**Requirements:** Rust (stable), Node.js ≥ 20, pnpm, and the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS (WebKitGTK on Linux).

## Linux notes

Linux builds are split by use case:

- `.deb` / `.rpm` are the preferred packages when your distro matches them.
- `collab-linux-*-portable.tar.gz` is the preferred fallback for other distros if you want the app to use your system WebKitGTK/GTK stack.
- `.AppImage` remains available, but it uses a bundled Linux runtime and can still have worse touchpad scrolling, blur/compositing, and fractional-scaling behavior than native/system-library builds.
- Install details and distro-specific commands are in [docs/linux-install.md](/home/azazel/Code Projects/collab/docs/linux-install.md).

Touchpad pinch-to-zoom is intercepted at the GTK gesture layer to prevent WebKitGTK from applying its own zoom, which bypasses the app's controlled scaling. On Linux, smooth scrolling is explicitly enabled and swipe-navigation gestures are disabled to reduce touchpad conflicts inside the webview.
