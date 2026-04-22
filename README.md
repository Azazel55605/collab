# collab

Local-first vault-based knowledge work for Markdown notes, canvases, Kanban boards, PDFs, images, and shared-folder collaboration.

`collab` is a Tauri 2 desktop app built with React 19, TypeScript, Rust, and CodeMirror 6. It is designed around local files first: your vault stays on disk, the app builds structure around it, and collaboration works through shared vault metadata instead of a hosted backend.

## Highlights

- Markdown notes with live preview, wikilinks, backlinks, autosave, optimistic conflict handling, and rich insertion tools
- First-class vault files for `.md`, `.canvas`, `.kanban`, images, and PDFs
- Canvas boards with note/file/text/web cards, edge labels/styles/arrows, PDF thumbnails, and link previews/embeds
- Kanban boards with drag-and-drop columns/cards, calendar and timeline views, attachments, assignees, tags, archive, and templates
- Dedicated PDF reader with single-page, long-scroll, and side-by-side layouts plus fit and custom zoom modes
- Dedicated image viewer/editor with additive annotation overlays and permanent crop/rotate/resize/export flows
- Shared-folder collaboration with presence, chat, per-file history snapshots, permissions, and conflict dialogs
- Vault encryption with Argon2id + AES-256-GCM
- Theming, font, motion, calendar, zoom, and web preview settings
- Native desktop packaging through Tauri, including Flatpak support and in-app updates where supported

## Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 19, Vite, TypeScript |
| Styling | Tailwind CSS v4, shadcn/ui, Radix UI |
| Editor | CodeMirror 6 |
| Canvas | `@xyflow/react` |
| Kanban drag/drop | `dnd-kit` |
| Graph view | D3 |
| PDF rendering | `pdfjs-dist` |
| State | Zustand |
| Backend | Rust |

## Current Features

### Notes

- CodeMirror-based Markdown editing with GFM support
- Live inline formatting previews for common Markdown constructs
- Wikilinks with vault-wide autocomplete and backlink indexing
- Autosave with optimistic locking and conflict resolution
- Auto-rename to match the first H1 heading
- Toolbar actions for headings, formatting, links, images, tables, task lists, math, code blocks, and more
- Shift-click editor dialogs for visual table, task-list, math-block, and fenced-code editing
- Nerd Font icon picker and command-bar insertion actions
- Sidebar search and tag browsing

### Vault Files And Views

- Notes (`.md`)
- Canvases (`.canvas`)
- Kanban boards (`.kanban`)
- Images, including additive overlay annotations stored under `.collab/image-overlays/`
- PDFs opened in a custom in-app reader
- Multi-tab editing with dirty-state tracking and drag-reorder
- Grid workspace view for arranging multiple views side by side

### Navigation And Discovery

- D3 graph view for wikilink relationships across notes
- File tree with folders, managed media, drag-and-drop moves, and context actions
- Command bar for search, quick actions, note creation, math evaluation, and editor insertions
- Vault-wide text search and tag browsing in the sidebar
- Shared document top-bar pattern across note, image, PDF, canvas, and Kanban views

### Canvas

- Node types: note, file, text, and web
- Drag files from the file tree onto the canvas
- Rich card previews for notes, text-like files, images, PDFs, and websites
- Web cards with preview/embed modes, optional auto-load, and global preview controls
- Styled edges with labels, solid/dashed/dotted lines, animation, and start/end arrows
- Viewport persistence and optimistic save/reload handling

### Kanban

- Multi-column drag-and-drop boards
- Card attachments to vault files
- Assignees, tags, checklists, due-date oriented views, and archived cards
- Calendar and timeline views
- Default column tags and optional auto-apply-on-move behavior
- Built-in, vault, and app-level Kanban templates
- Import/export/copy/apply template flows

### PDFs And Images

- PDF reader with single, scroll, and spread layouts
- Fit-width, fit-height, fit-page, `100%`, and custom zoom controls
- Rotation and keyboard shortcut support in the PDF viewer
- Image viewer with additive annotations like pen, arrows, text, crop overlays, and erasing
- Permanent image edits for crop, rotate, resize, flattening, overwrite, or save-as-new-image

### Collaboration

- Presence stored in `{vault}/.collab/presence/`
- Active-file awareness and peer presence in the UI
- Sidebar collaboration panel with peers, chat, and history tabs
- Typing indicators in chat
- Snapshots stored under `{vault}/.collab/snapshots/` with compare and restore flows
- Vault member roles: viewer, editor, admin
- Conflict dialogs for concurrent edits

### Vault Management And Security

- Create, open, rename, export, and switch vaults
- Recent vault history with validation/pruning of missing paths
- AES-256-GCM vault encryption with Argon2id-derived keys
- Unlock, enable, disable, and change-password flows
- App-managed `Pictures/` folder for imported image assets

### UI And Customization

- Themes: `dark`, `midnight`, `warm`, `light`
- Accent colors: `violet`, `blue`, `emerald`, `rose`, `orange`, `cyan`
- Interface fonts: `geist`, `inter`, `serif`, `mono`
- Editor fonts: `codingMono`, `jetbrainsMono`, `firaCode`
- Separate interface/editor font sizes
- UI scale controls
- Animation and motion controls
- Date format and week-start settings
- Web preview and hover-preview toggles
- In-app shortcuts reference and command bar

## Project Structure

```text
src/
  components/
    collaboration/   Presence, chat, history, conflict UI
    command-bar/     Global command/search/action palette
    editor/          Markdown editor, toolbar, preview helpers, editor dialogs
    graph/           D3 graph view
    grid/            Multi-workspace layout UI
    kanban/          Board, columns, cards, templates, calendar, timeline
    layout/          App shell, activity bar, sidebar, tab bar, status bar
    previews/        Web preview popovers
    settings/        Settings and shortcuts UI
    ui/              shadcn/ui primitives
    vault/           Vault picker, file tree, boards panel, dialogs
  lib/
    tauri.ts         Typed Tauri IPC wrappers
    collabTransport.ts
  store/
    vaultStore.ts
    editorStore.ts
    uiStore.ts
    noteIndexStore.ts
    collabStore.ts
    gridStore.ts
    kanbanStore.ts
    updateStore.ts
  types/
    canvas.ts
    kanban.ts
    image.ts
    note.ts
    template.ts
    vault.ts
  views/
    NoteView.tsx
    ImageView.tsx
    PdfView.tsx
    GraphPage.tsx
    CanvasPage.tsx
    KanbanPage.tsx
    GridView.tsx
    SettingsPage.tsx

src-tauri/src/commands/
  vault.rs
  files.rs
  templates.rs
  index.rs
  watcher.rs
  collab.rs
  crypto.rs
  ui.rs
  update.rs
  web.rs
```

## Development

```bash
pnpm install
pnpm tauri dev
```

Useful commands:

```bash
pnpm dev
pnpm exec tsc --noEmit
cd src-tauri && cargo check
pnpm tauri build
pnpm dlx shadcn@latest add <component>
./flatpak/build-local.sh
```

## Requirements

- Node.js 20+
- `pnpm`
- Rust stable toolchain
- Tauri 2 system dependencies for your platform

Linux packaging and install notes live in [docs/linux-install.md](/home/azazel/Code Projects/collab/docs/linux-install.md).

## Notes For Contributors

- Frontend code should go through typed wrappers in `src/lib/tauri.ts` instead of calling Tauri plugins directly from components
- Paths crossing the IPC boundary are relative to the vault root
- Normal file listing/indexing excludes `.collab/` and generated dependency/build directories
- `write_note` uses optimistic locking via `expected_hash`
- Shared document-style viewers should follow the `DocumentTopBar` pattern

For deeper project conventions, see [AGENTS.md](/home/azazel/Code Projects/collab/AGENTS.md).
