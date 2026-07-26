# Codebase Structured Reference

Quick-scan reference for components, features, types, and IPC. Update this file alongside `AGENTS.md` and `CLAUDE.md` after any structural change.

For the app's visual language, interaction patterns, and UI rules, see the
[UI Guide](./ui-guide.md).

**Sections:** [Views](#views) · [Components](#components) · [Stores](#stores) · [Types](#types) · [IPC Commands](#ipc-commands) · [Rust Backend](#rust-backend) · [Theming](#theming) · [Feature Map](#feature-map) · [Shadcn Components](#shadcn-components-installed)

## Testing

Frontend regression coverage uses Vitest + jsdom via `pnpm test`.

Rust workspace tests run via `cargo test --workspace`; Tauri-only tests can run
via `cd src-tauri && cargo test`.

Current regression coverage includes:

- `src/lib/documentSession.test.tsx`
- `src/store/editorStore.test.ts`
- `src/components/layout/AppShell.test.tsx`
- `src/components/collaboration/CollabProvider.test.tsx`
- `src/components/canvas/CanvasPickerDialog.test.tsx`
- `src/components/canvas/CanvasNodeTypes.test.tsx`
- `src/components/canvas/CanvasEdgeTypes.test.tsx`
- `src/components/canvas/CanvasPreviewUtils.test.ts`
- `src/components/canvas/CanvasEdgeInspector.test.tsx`
- `src/components/canvas/CanvasToolbar.test.tsx`
- `src/components/canvas/useCanvasViewportControls.test.tsx`
- `src/components/canvas/useCanvasNodeCommands.test.tsx`
- `src/components/canvas/useCanvasPreviews.test.tsx`
- `src/components/canvas/useCanvasDocumentSession.test.tsx`
- `src/components/canvas/CanvasFlowNodeUtils.test.tsx`
- `src/components/canvas/canvasPlanning.test.ts`
- `src/components/image/ImageViewUtils.test.ts`
- `src/components/image/ImageAnnotationsPopover.test.tsx`
- `src/components/image/ImageAdditiveToolbar.test.tsx`
- `src/components/image/ImageAdditiveStage.test.tsx`
- `src/components/image/ImagePermanentStage.test.tsx`
- `src/components/image/ImagePermanentToolbar.test.tsx`
- `src/components/image/useImageDocumentSession.test.tsx`
- `src/components/image/useImageInteractions.test.tsx`
- `src/components/editor/colorPreview.test.ts`
- `src/components/editor/indentationPlugins.test.tsx`
- `src/components/editor/noteAuthoring.test.ts`
- `src/components/editor/NoteSnippetsDialog.test.tsx`
- `src/components/editor/slashCommands.test.ts`
- `src/components/editor/snippetEngine.test.ts`
- `src/components/editor/markdownEditorViewConfig.test.ts`
- `src/components/editor/markdownEditorTheme.test.ts`
- `src/components/editor/useMarkdownEditorIntegrations.test.ts`
- `src/components/editor/useMarkdownEditorHandle.test.ts`
- `src/components/editor/MarkdownEditorContextMenu.test.tsx`
- `src/lib/frontmatter.test.ts`
- `src/lib/pdfWorkspace.test.ts`
- `src/components/kanban/useCardDialogDraftSession.test.tsx`
- `src/components/kanban/useCardDialogActions.test.tsx`
- `src/components/kanban/useCardDialogChecklistComments.test.tsx`
- `src/components/kanban/CardDialogSidebar.test.tsx`
- `src/components/kanban/CardDialogTagsAttachments.test.tsx`
- `src/components/kanban/CardDialogChecklistComments.test.tsx`
- `src/components/kanban/CardDialogMoveTagsPrompt.test.tsx`
- `src/components/settings/SettingsAppearanceSection.test.tsx`
- `src/components/settings/SettingsEditorSection.test.tsx`
- `src/components/settings/SettingsGeneralSection.test.tsx`
- `src/components/settings/SettingsDisplaySection.test.tsx`
- `src/components/settings/SettingsCanvasSection.test.tsx`
- `src/components/settings/SettingsCalendarSection.test.tsx`
- `src/components/settings/SettingsProfileSection.test.tsx`
- `src/components/vault/TrashPanel.test.tsx`
- `src/components/vault/FileReferencesPanel.test.tsx`
- `src/components/command-bar/commandBarUtils.test.ts`
- `src/components/command-bar/commandBarActions.test.tsx`
- `src/components/command-bar/CommandBarModeContent.test.tsx`
- `src/views/NoteView.test.tsx`
- `src/views/KanbanPage.test.tsx`
- `src/views/CanvasPage.test.tsx`

Expectation:

- new components should include tests by default
- component behavior changes should add or update tests in the same change unless the work is purely presentational
- bug fixes should include a regression test whenever the behavior is reasonably covered by the frontend test harness
- backend helper and command behavior should add or update Rust tests when the logic is reasonably covered without requiring a full Tauri runtime harness

---

## Views

Located in `src/views/`. Each view is a full-page component routed by `uiStore.activeView`.

| File | Route key | Provides | Key stores |
|------|-----------|----------|------------|
| `NoteView.tsx` | `'editor'` | — | vaultStore, editorStore, collabStore |
| `GraphPage.tsx` | `'graph'` | — | noteIndexStore, editorStore, uiStore |
| `CanvasPage.tsx` | `'canvas'` | React Flow canvas board with planning nodes, presets, and inspector panels | vaultStore, editorStore, collabStore, uiStore |
| `KanbanPage.tsx` | `'kanban'` | KanbanContext | vaultStore, collabStore, kanbanStore |
| `GridView.tsx` | `'grid'` | — | gridStore |
| `SettingsPage.tsx` | (modal) | — | collabStore, uiStore |

### KanbanPage context shape
```ts
interface KanbanContext {
  board: KanbanBoard;
  updateBoard: (updater: (prev: KanbanBoard) => KanbanBoard) => void;
  knownUsers: KnownUser[];
  relativePath: string;
}
```

### NoteView autosave flow
```
keystroke → onChange → markDirty → 600ms debounce → tauriCommands.writeNote(expectedHash)
                                                          ↓ conflict? → ConflictDialog
manual save (Ctrl+S) → immediate write + createSnapshot
```

---

## Components

### Layout

| File | Purpose | Key stores | shadcn used |
|------|---------|------------|-------------|
| `components/AppShell.tsx` | Root shell: sidebar + tabbar + main area + statusbar | vaultStore, editorStore, uiStore | ResizablePanelGroup |
| `components/ActivityBar.tsx` | Leftmost icon strip, switches activeView/sidebarPanel | uiStore | Tooltip |
| `components/Sidebar.tsx` | Dynamic panel host (files/search/tags/boards/collab) | uiStore | Sheet |
| `components/TabBar.tsx` | Open tabs with dirty dot, drag-to-reorder | editorStore, uiStore | ContextMenu |
| `components/StatusBar.tsx` | Bottom bar: vault name, file path, peer count | vaultStore, collabStore | — |

### Vault

| File | Purpose | Key stores | shadcn used |
|------|---------|------------|-------------|
| `components/vault/VaultPicker.tsx` | Initial screen: open/create vault, recents | vaultStore | Button |
| `components/vault/VaultManagerModal.tsx` | Vault settings: export, encryption, members | vaultStore, collabStore, uiStore | Dialog, Tabs, Button, Input |
| `components/vault/VaultUnlockModal.tsx` | Password prompt for encrypted vaults | vaultStore | Dialog, Input, Button |
| `components/vault/FileTree.tsx` | File/folder browser with create/rename/delete, trash mode toggle, rename/move preview flow, and contextual file-reference details | vaultStore, editorStore, uiStore | ContextMenu, Tooltip |
| `components/vault/FileReferencesPanel.tsx` | Contextual file-details section that lists incoming note/kanban/canvas references for the selected vault file | FileTree state, typed file references | — |
| `components/vault/TrashPanel.tsx` | Dedicated vault trash view for restore, purge, and purge-all flows | vaultStore | Button, Dialog |
| `components/vault/SearchPanel.tsx` | Full-text search across notes | noteIndexStore | Input |
| `components/vault/TagsPanel.tsx` | Tag filter list from note metadata | noteIndexStore | Badge |
| `components/vault/BoardsPanel.tsx` | List `.kanban` files | vaultStore, editorStore | — |
| `components/vault/VaultDialogs.tsx` | Create/rename/delete/trash confirmation dialogs plus rename/move preview and trash restore dialogs | vaultStore, uiStore | Dialog, Input, Button |

### Editor

| File | Purpose | Key inputs | shadcn/libs used |
|------|---------|-----------|-----------------|
| `components/editor/MarkdownEditor.tsx` | CodeMirror 6 wrapper | content, onChange, onSave, relativePath | — (CodeMirror only) |
| `components/editor/EditorToolbar.tsx` | Format buttons, footnote/callout insertion, and note snippet management entry points | editorRef (MarkdownEditorHandle) | Tooltip, Button, Dialog |
| `components/editor/MarkdownPreview.tsx` | Rendered markdown panel | content, relativePath | — (markdown-it + hljs) |
| `components/editor/livePreview.ts` | CodeMirror ViewPlugin for inline markdown decorations | — | — |
| `components/editor/colorPreview.ts` | Inline editor color preview plugin helpers for swatches, tinting, and match parsing | CodeMirror decorations, uiStore color formats | — |
| `components/editor/indentationPlugins.ts` | Editor indent visualization, ASCII ligature plugins, and Tab-key indentation helpers | CodeMirror decorations, indentation facets | — |
| `components/editor/noteAuthoring.ts` | Shared note-authoring helpers for callout snippets, footnotes, references sections, and slash-trigger context detection | CodeMirror view/state helpers |
| `components/editor/slashCommands.ts` | Inline slash-command source for structural markdown inserts, vault-file links, and snippet-backed authoring actions | CodeMirror autocomplete, note snippets, vault file tree, editor insertion helpers |
| `components/editor/snippetEngine.ts` | Placeholder-aware snippet parser/session engine with Tab traversal and final cursor placement | CodeMirror state, decorations, transactions |
| `components/editor/mathBlockCommands.ts` | Display-math-only CodeMirror commands for LaTeX snippets, adjacent-token wrapping, math-block selection, exact solver insertion, approximate solver insertion, and multi-variable solver chooser events | CodeMirror keymaps, snippetEngine, mathSolver |
| `components/editor/mathSolver.ts` | Shared nerdamer-backed math evaluation and equation solving abstraction for editor math blocks | nerdamer |
| `components/editor/mathPlotSpec.ts` | Parser, defaults, normalization, and sampling helpers for `%plot2d` / `%plot3d` display-math directives | nerdamer |
| `components/editor/MathPlot2D.tsx` | SVG 2D math plot preview rendered beneath KaTeX display math | d3, mathPlotSpec |
| `components/editor/MathPlot3D.tsx` | Lazy-loaded WebGL 3D surface preview rendered beneath KaTeX display math | three, mathPlotSpec |
| `components/editor/markdownEditorViewConfig.ts` | CodeMirror compartment setup, reconfigure effect builders, wiki autocomplete override, and editor-state construction helpers | CodeMirror state/extensions, note index store | — |
| `components/editor/markdownEditorTheme.ts` | Shared Markdown editor theme and syntax highlight style builders used by the main editor and code-block dialog | CodeMirror theme/highlight extensions | — |
| `components/editor/useMarkdownEditorIntegrations.ts` | Shared Markdown editor drop/import, native drag-drop bridge, and hover preview integration hook plus testable helper utilities | React hooks, Tauri drag-drop events, vault import wrappers |
| `components/previews/PdfLinkPreviewPopover.tsx` | Lightweight hover preview popover for vault-linked PDFs in the editor | pdfjs-dist, Tauri asset reads |
| `components/pdf/PdfSendTargetDialog.tsx` | Reusable choose-target dialog for sending PDF quotes and snapshots into notes or the current canvas | Dialog, Button |
| `components/editor/useMarkdownEditorHandle.ts` | Shared Markdown editor imperative handle hook and editing helpers for wrap/line/snippet/range mutations | React imperative handle, CodeMirror selection mutations |
| `components/editor/MarkdownEditorContextMenu.tsx` | Shared Markdown editor context-menu component and clipboard/formatting helpers for cut/copy/paste/select-all and inline formatting actions | Context menu primitives, clipboard integration |
| `components/editor/NoteSnippetsDialog.tsx` | CRUD dialog for vault/app reusable note snippets with placeholder-aware markdown bodies | Dialog, Button, Input, Select, Textarea |

**MarkdownEditorHandle** (ref interface):
```ts
{ insertAround(before, after), insertLine(prefix), insertSnippet(text), insertFootnote() }
```

**CodeMirror extensions active:**
- `markdown({ base: markdownLanguage, extensions: GFM, codeLanguages: languages })`
- `syntaxHighlighting(defaultHighlightStyle, { fallback: true })`
- `livePreviewPlugin` (inline decorations)
- `indentationPlugins` (indent guides, ASCII arrow ligatures, custom Tab indentation)
- `markdownEditorViewConfig` (compartment setup, state creation, and hot-reconfigure helpers)
- `snippetEngine` (placeholder-aware snippet sessions with Tab traversal)
- `mathBlockCommands` (display-math shortcuts for LaTeX structures, `Ctrl+Enter` exact solver insertion, `Ctrl+Alt+Enter` approximation, and inline variable chooser events for ambiguous equations)
- `mathSolver` (shared `nerdamer`-backed expression evaluation and equation solving)
- `mathPlotSpec` / `MathPlot2D` / `MathPlot3D` (`%plot2d`/`%plot3d` metadata parsing plus 2D SVG and lazy-loaded 3D WebGL plot panels beneath display math)
- `slashCommands` (inline `/` command menu for structure, vault-file links, callouts, footnotes, and note snippets)
- `noteAuthoring` (callout/footnote/reference insertion helpers)
- `markdownEditorTheme` (shared editor theme and highlight style builders)
- `useMarkdownEditorIntegrations` (drop/import wiring, native drag-drop bridge, and hover preview helpers)
- `useMarkdownEditorHandle` (imperative editor handle wiring and editing helpers)
- `MarkdownEditorContextMenu` (clipboard/context-menu rendering and formatting actions)
- `autocompletion` with wikilink `[[` override
- `history`, `bracketMatching`, `closeBrackets`, `indentOnInput`, `lineNumbers`
- Custom theme compartment (rebuilt on theme/font/fontSize change)

### Kanban

| File | Purpose | Props | Key stores | shadcn used |
|------|---------|-------|------------|-------------|
| `components/kanban/KanbanBoard.tsx` | Board + Calendar + Timeline tabs, archive panel | — | KanbanContext | — |
| `components/kanban/KanbanColumn.tsx` | Column with sortable cards, column settings | column: KanbanColumn | KanbanContext | DropdownMenu, Popover, Dialog |
| `components/kanban/KanbanCard.tsx` | Card visual + sortable + context menu | card, columnId, isOverlay? | KanbanContext, kanbanStore, uiStore | ContextMenu, Dialog |
| `components/kanban/CardDialog.tsx` | Full card editor modal | card, columnId, onClose | KanbanContext, kanbanStore, collabStore, noteIndexStore, editorStore, uiStore | Dialog, Popover, Calendar, Command, Select |
| `components/kanban/useCardDialogDraftSession.ts` | Shared CardDialog draft/session hook for draft restore, debounced board flush, and current-column tracking | KanbanContext updater, kanbanStore draft state | — |
| `components/kanban/useCardDialogActions.ts` | Shared CardDialog move/archive/done/delete actions hook plus move-tags prompt state and pure board-mutation helpers | KanbanContext updater, kanbanStore draft state, kanban types | — |
| `components/kanban/useCardDialogChecklistComments.ts` | Shared CardDialog checklist/comments hook for checklist mutations, comment creation/removal, linked-card title resolution, and derived progress state | KanbanContext board data, kanban draft patching | — |
| `components/kanban/CardDialogSidebar.tsx` | Shared CardDialog sidebar/meta section for priority, dates, assignees, column selection, archive/restore, and delete confirmation UI | CardDialog draft/actions props | Popover, Calendar, Select |
| `components/kanban/CardDialogTagsAttachments.tsx` | Shared CardDialog tags and attachments section for tag editing, suggested tags, and vault-file attachment picker/open/remove actions | CardDialog draft/actions props, vault file list | Popover, Command |
| `components/kanban/CardDialogChecklistComments.tsx` | Shared CardDialog checklist and comments section for checklist progress/items, linked-card subtasks, and comment thread/posting UI | CardDialog draft/actions props, board card list | Popover, Command |
| `components/kanban/CardDialogMoveTagsPrompt.tsx` | Shared CardDialog move-tags confirmation dialog for applying missing column default tags after a move | CardDialog prompt/action props | Dialog, Button |
| `components/kanban/CalendarView.tsx` | Month/week/day calendar of dated cards | — | KanbanContext, uiStore | — (react-day-picker) |
| `components/kanban/TimelineView.tsx` | 90-day Gantt-style timeline with drag-to-reschedule | — | KanbanContext, uiStore | — |

**KanbanCard context menu actions:** Edit, Mark done/incomplete, Move to column, Duplicate, Archive/Restore, Delete

**CardDialog sidebar fields:** Priority, Start date, Due date, Assignees, Column (Select), Archive/Restore, Delete

**Archive behavior:** `card.archived = true` + `card.archivedColumnId = col.id`. Card stays in column `cards[]` but is filtered from board/timeline/calendar with `!card.archived`. Archive panel in KanbanBoard shows all archived cards grouped by original column with Restore button.

**Timeline click-to-edit:** `wasMovedRef` tracks pointer movement during drag. If `endDrag` fires with zero day-delta, opens CardDialog via `setOpenCard` instead of writing dates.

**Column sort fields:** `none | name | priority | createdAt | startDate | dueDate | assignees`

### Collaboration

| File | Purpose | Key stores |
|------|---------|------------|
| `components/collaboration/CollabProvider.tsx` | Presence broadcasting, peer refresh, chat sync | collabStore, vaultStore |
| `components/collaboration/PresenceBar.tsx` | Peer avatar row | collabStore |
| `components/collaboration/PeerList.tsx` | Peer detail list | collabStore |
| `components/collaboration/ChatPanel.tsx` | Chat thread + input | collabStore |
| `components/collaboration/activity/ActivityPanel.tsx` | Unified collaboration activity feed | collabStore, vaultStore, editorStore |
| `components/collaboration/ConflictDialog.tsx` | Merge conflict resolution (ours vs theirs) | collabStore |
| `components/collaboration/HistoryPanel.tsx` | Snapshot history list with restore for active note / kanban / canvas documents | collabStore, vaultStore, editorStore |
| `components/collaboration/CollabPanel.tsx` | Sidebar panel host for collab UI | collabStore |

### Graph

| File | Purpose | Props | libs used |
|------|---------|-------|-----------|
| `components/graph/GraphView.tsx` | Force-directed note graph | notes, onNodeClick? | @xyflow/react, d3 |
| `views/LogicDiagramView.tsx` | Digital logic and rotatable electronic schematic editor with reusable components, multi-terminal wiring, explicit wire-splitting junctions, and SVG note export | VaultClient document sessions, live JSON collaboration, React Flow geometry helpers |
| `components/logic/schematicSymbols.ts` | Canonical ANSI/IEEE and IEC/DIN schematic symbol definitions, rotation-aware dimensions, terminal coordinates, and SVG transforms | logic diagram types |

### Grid

| File | Purpose | Key stores | shadcn used |
|------|---------|------------|-------------|
| `components/grid/GridCell.tsx` | Single cell rendering any view type | gridStore | — |
| `components/grid/GridLayoutPicker.tsx` | Layout selector buttons | gridStore | Tooltip |
| `components/grid/WorkspaceBar.tsx` | Workspace tabs + new workspace | gridStore | ContextMenu |
| `components/grid/SplitDropZones.tsx` | Edge drop zones for tab-drag-to-split | gridStore | — |

**Grid layout types:** `single | split-h | split-v | 2x2 | cols-3 | cols-4 | main-side | side-main`
**Grid cell content types:** `empty | note | graph | canvas | kanban | settings`

### Other

| File | Purpose | libs used |
|------|---------|-----------|
| `components/layout/DocumentTopBar.tsx` | Shared document-view header shell plus reusable top-bar button/icon-button primitives and group tokens for secondary toolbar rows | Button |
| `components/CommandPalette.tsx` | Cmd+K command palette | cmdk |
| `components/canvas/CanvasPickerDialog.tsx` | Search-and-select dialog for adding note/file cards to the canvas | Dialog, Command |
| `components/canvas/CanvasNodeTypes.tsx` | Render-only canvas node card components for content cards plus planning/diagram nodes, exported as the `nodeTypes` map | @xyflow/react, Badge, Input, Select |
| `components/canvas/CanvasEdgeTypes.tsx` | Render-only canvas edge components with curved/orthogonal routing plus flow-edge conversion helpers and exported `edgeTypes` map | @xyflow/react |
| `components/canvas/CanvasPreviewUtils.ts` | Canvas preview-state helpers for preview keys, markdown/text cleanup, and web/file preview shaping | Canvas types, web preview cache |
| `components/canvas/CanvasEdgeInspector.tsx` | Selected-connection inspector panel for label, routing, line style, animation, marker, and delete controls | Button, Checkbox, Input, Select |
| `components/canvas/CanvasNodeInspector.tsx` | Selected-node inspector for planning-node title, description, metadata, linked path, and swimlane orientation editing | Button, Input, Select, Textarea |
| `components/canvas/CanvasToolbar.tsx` | Document top-bar controls for content cards, planning-node insertion, presets, zoom, and fit/reset helpers built on the shared `DocumentTopBar` control primitives | Button, DropdownMenu, DocumentTopBar tokens |
| `components/canvas/useCanvasViewportControls.ts` | Shared canvas viewport controls and keyboard shortcut hook for pan, zoom, fit, reset, picker toggles, and delete actions | React hooks, React Flow viewport API |
| `components/canvas/useCanvasNodeCommands.ts` | Shared canvas node creation and drop/picker command hook for content cards, planning nodes, and starter presets | React hooks, React Flow positioning |
| `components/canvas/canvasPlanning.ts` | Shared planning-node labels, defaults, and starter-preset builders for the mixed diagramming canvas | Canvas types |
| `components/canvas/useCanvasPreviews.ts` | Shared canvas preview state and hydration hook for web/file/note previews, external preview requests, and preview reset behavior | React hooks, opener, Tauri wrappers, web preview cache |
| `components/canvas/useCanvasDocumentSession.ts` | Shared canvas document/session hook for initial load, external reload, autosave scheduling, conflict handling, and snapshot creation | React hooks, watcher events, Tauri wrappers, document session state |
| `components/canvas/CanvasFlowNodeUtils.ts` | Shared mapping helpers between persisted canvas nodes and React Flow node models | Canvas types, preview helpers, UI store mode |
| `components/image/ImageViewUtils.ts` | Shared image-view geometry, file/output, crop, overlay label, and dirty-state helpers | Image types |
| `components/image/ImageAnnotationsPopover.tsx` | Annotation list popover for selecting and removing additive image overlays | Popover, Button |
| `components/image/ImageAdditiveToolbar.tsx` | Additive-mode image toolbar for tool selection, color/stroke/text controls, and bake/delete actions | Button, Input, Popover, Select |
| `components/image/ImageAdditiveStage.tsx` | Additive image stage rendering for raster preview, arrow/pen/text overlays, and interaction forwarding | Image types, utility helpers |
| `components/image/ImagePermanentStage.tsx` | Permanent image preview/crop stage plus crop footer controls | Button, crop helpers |
| `components/image/ImagePermanentToolbar.tsx` | Permanent image editing toolbar for rotate/crop/resize/lock/reset/save controls | Button, Input |
| `components/image/useImageDocumentSession.ts` | Shared image document/session hook for initial load, additive overlay autosave, dirty-state syncing, permanent preview rendering, and final image save flows | React hooks, Tauri wrappers, toast |
| `components/image/useImageInteractions.ts` | Shared image interaction hook for keyboard shortcuts, additive drafting, crop dragging, and text/arrow move-resize interactions | React hooks, image geometry helpers |
| `components/settings/SettingsModal.tsx` | Settings modal wrapper with tabs and top-level composition for settings sections | Dialog |
| `components/settings/settingsControls.tsx` | Shared settings UI helpers for section labels, option rows, and pill selectors | — |
| `components/settings/SettingsAppearanceSection.tsx` | Appearance tab section for theme, accent color, interface font, and interface font size controls | Separator, shared settings controls |
| `components/settings/SettingsEditorSection.tsx` | Editor tab section for editor font, indentation, and inline color preview controls | Separator, shared settings controls |
| `components/settings/SettingsGeneralSection.tsx` | General tab section for startup, web preview, and file-operation settings | Separator, shared settings controls |
| `components/settings/SettingsDisplaySection.tsx` | Display tab section for interface scale and motion settings | Separator, shared settings controls |
| `components/settings/SettingsCanvasSection.tsx` | Canvas tab section for default web-card mode and preview auto-load settings | Separator, shared settings controls |
| `components/settings/SettingsCalendarSection.tsx` | Calendar tab section for date format, week-start, time-format, and preview settings | Separator, shared settings controls |
| `components/settings/SettingsProfileSection.tsx` | Profile tab section for collaborator identity, presence color preview, user ID, and save action | Input, Button, Separator, shared settings controls |
| `components/settings/SettingsServerSection.tsx` | Minimal hosted-server connection flow; persists only the server URL and delegates credentials to typed Tauri commands | Input, Button, shared settings controls |
| `components/command-bar/commandBarUtils.ts` | Shared command-bar parsing and helper utilities for mode detection, file/tab/view mapping, tree flattening, and mode placeholders | Command bar shell, vault file tree |
| `components/command-bar/commandBarActions.tsx` | Shared command-bar action registry and executors for view switching, document creation, settings shortcuts, and editor insertion tools | Tauri wrappers, editor toolbar action dispatcher, toast |
| `components/command-bar/CommandBarModeContent.tsx` | Shared command-bar mode-rendering layer for search, math, tags, file filters, actions, insert snippets/icons, and mode hints | Command primitives, mode helpers, action registry, Nerd Font/snippet helpers |
| `components/command-bar/useCommandBarShell.ts` | Shared command-bar shell hook for open/input state, hotkeys, programmatic open, reset behavior, debounced search wiring, and render context construction | React hooks, store selectors, Tauri search wrapper |
| `components/settings/AboutTab.tsx` | App version/info | — |
| `components/ui/AppLogo.tsx` | SVG app icon | — |

---

## Stores

### `vaultStore` (`src/store/vaultStore.ts`)
```ts
// State
vault: VaultMeta | null
isVaultLocked: boolean
fileTree: NoteFile[]
recentVaults: VaultMeta[]   // persisted local vaults
isLoading: boolean

// Actions
openVault(path) | openHostedVault(vault) | createVault(...) | unlockVault(password)
refreshFileTree() | closeVault() | loadRecentVaults() | removeRecentVault(path)
```

File-tree CRUD, trash, search, reference inspection, and version-history
read/restore flows operate through `createVaultClient(vault)` so the same UI can
select the local Tauri adapter or hosted HTTP adapter. Hosted snapshot deletion
and history clearing are intentionally hidden because hosted snapshots are immutable.

### `serverStore` (`src/store/serverStore.ts`)
```ts
// State
status: ServerConnectionStatus | null
hostedVaults: HostedVaultSummary[]
isLoading: boolean
error: string | null

// Actions
refresh() | connect(serverUrl, username, password) | reconnect(serverUrl)
disconnect() | loadHostedVaults()
```

`ServerConnectionStatus` also reports whether the current session explicitly
allows untrusted TLS certificates. Verification remains enabled by default and
the opt-in is reused for every request in that native server session.

### `editorStore` (`src/store/editorStore.ts`)
```ts
// State
openTabs: OpenTab[]         // { relativePath, title, isDirty, savedHash }
activeTabPath: string | null
forceReloadPath: string | null

// Actions
openTab(relativePath, title?) | closeTab(path) | setActiveTab(path)
markDirty(path) | markSaved(path, hash) | setSavedHash(path, hash)
updateTabTitle(path, title) | renameTab(oldPath, newPath)
reorderTabs(from, to) | setForceReloadPath(path)
```

### `uiStore` (`src/store/uiStore.ts`)
```ts
// State (persisted except modal states)
activeView: 'editor' | 'graph' | 'canvas' | 'kanban' | 'grid'
sidebarPanel: 'files' | 'search' | 'tags' | 'canvas-boards' | 'kanban-boards' | 'collab'
sidebarWidth: number        // px, min 160, max 400
isSidebarOpen: boolean
isSettingsOpen: boolean
isVaultManagerOpen: boolean
theme: 'dark' | 'midnight' | 'warm' | 'light'
accentColor: 'violet' | 'blue' | 'emerald' | 'rose' | 'orange' | 'cyan'
editorFont: 'geist' | 'inter' | 'serif' | 'mono'
fontSize: number            // px
scale: number               // UI zoom
dateFormat: DateFormat
weekStart: 0 | 1            // 0=Sunday, 1=Monday
timeFormat: system | 12-hour | 24-hour
confirmDelete: boolean

// Helper
formatDate(date, format): string
```

### `noteIndexStore` (`src/store/noteIndexStore.ts`)
```ts
notes: NoteMetadata[]
isIndexing: boolean
setNotes(notes) | updateNote(meta) | removeNote(path) | setIndexing(bool)
```

### `noteSnippetStore` (`src/store/noteSnippetStore.ts`)
```ts
snippets: NoteSnippet[]
isLoading: boolean

loadSnippets(vaultPath) | saveSnippet(vaultPath, draft) | deleteSnippet(vaultPath, scope, snippetId)
```

### `collabStore` (`src/store/collabStore.ts`)
```ts
myUserId: string            // persisted in localStorage
myUserName: string          // persisted in localStorage
myUserColor: string
peers: PresenceEntry[]
conflicts: ConflictInfo[]
chatMessages: ChatMessage[]
activityEvents: ActivityEvent[]

setPeers | addConflict | dismissConflict | setMyProfile
setChatMessages | appendChatMessage | setActivityEvents | appendActivityEvent
```

### `gridStore` (`src/store/gridStore.ts`)
```ts
workspaces: GridWorkspace[] // { id, name, layout, cells[] }
activeWorkspaceId: string

createWorkspace | deleteWorkspace | renameWorkspace | setActiveWorkspace
setLayout(wsId, layout) | setCellContent(wsId, cellIdx, content)
swapCells | reorderCells | clearCell | activateSplit
```

### `kanbanStore` (`src/store/kanbanStore.ts`)
```ts
boardPath: string | null
cardId: string | null
columnId: string | null
draft: KanbanCard | null    // in-progress edit, survives view switches

setEditing(boardPath, cardId, columnId, draft)
updateDraft(draft) | clearEditing()
```

### `updateStore` (`src/store/updateStore.ts`)
```ts
status: 'idle' | 'checking' | 'available' | 'up_to_date' | 'downloading' | 'installing' | 'error'
updateInfo: UpdateInfo | null
downloadProgress: number    // 0–100
downloadedBytes | totalBytes | downloadSpeed: number
error: string | null
lastChecked: number | null

checkForUpdate() | startDownload() | reset()
```

---

## Types

### `src/types/vault.ts`
```ts
VaultMeta       local | hosted discriminated metadata; missing kind means local
NoteFile        { relativePath, name, extension, modifiedAt, size, isFolder, children? }
NoteContent     { content, hash, modifiedAt }
WriteResult     { hash, conflict?: ConflictInfo }
RestoreConflictInfo { existingRelativePath, suggestedRelativePath }
TrashEntry      { id, originalRelativePath, deletedAt, deletedByUserId?, deletedByUserName?, itemKind, extension?, size, rootName, restoreConflict? }
PathChangePreview { oldRelativePath, newRelativePath, itemKind, operation, nestedItemCount, affectedReferencePaths[], blockedReason? }
ConflictInfo    { ourContent, theirContent, relativePath }
MemberRole      = 'viewer' | 'editor' | 'admin'
VaultMember     { userId, userName, role }
VaultConfig     { id, name, knownUsers: KnownUser[], owner?, members: VaultMember[], isEncrypted? }
KnownUser       { userId, userName, userColor, lastSeen }
```

### `src/types/note.ts`
```ts
Frontmatter     { title?, tags?, created?, modified?, assignee?, status?, [key: string]: any }
NoteMetadata    { relativePath, title, tags[], wikilinksOut[], modifiedAt, wordCount, hash }
SearchResult    { relativePath, title, excerpt, score, matchType }
```

### `src/types/noteSnippet.ts`
```ts
NoteSnippetScope = 'vault' | 'app'
NoteSnippet      { id, name, description?, scope, category?, body, updatedAt }
NoteSnippetDraft { id?, name, description?, scope, category?, body }
```

### `src/types/canvas.ts`
```ts
CanvasNode      note | file | text | web | process | decision | terminator | document | milestone | actor | group | swimlane | junction | crossing
PlanningMeta    { status?, priority?, ownerLabel?, dueDate?, milestoneLabel?, tags? }
CanvasEdge      { id, source, target, label?, routingStyle?, lineStyle?, animated?, markerStart?, markerEnd? }
CanvasData      { nodes[], edges[], viewport: { x, y, zoom } }
```

### `src/types/pdf.ts`
```ts
PdfHighlightRect { left, top, width, height }
PdfBookmark      { id, page, label?, createdAt, updatedAt }
PdfHighlight     { id, page, text, rects[], color?, note?, createdAt, updatedAt }
PdfViewerState   { lastPage?, lastZoomMode?, lastZoom?, lastLayoutMode?, lastRotation? }
PdfSidecarState  { bookmarks[], highlights[], viewerState? }
```

### `src/types/collab.ts`
```ts
PresenceEntry   { userId, userName, userColor, activeFile, cursorLine, lastSeen, appVersion, status?, transportKind?, sessionMode?, awareness? }
ChatMessage     { id, userId, userName, userColor, content, timestamp }
ActivityEvent   { id, eventType, timestamp, actorId?, actorName?, relativePath?, targetUserId?, targetUserName?, targetRole?, message?, transportKind?, sessionMode? }
SnapshotMeta    { id, relativePath, authorId, authorName, timestamp, hash, label? }
```

### `src/types/kanban.ts`
```ts
KanbanComment   { id, userId, userName, userColor, content, timestamp }
ChecklistItem   { id, text, checked, cardRef? }
KanbanCard      { id, title, description?, relativePath?, assignees[], tags[],
                  startDate?, dueDate?, createdAt?, priority?, comments[],
                  checklist[], isDone?, archived?, archivedColumnId? }
ColumnSortField = 'none' | 'name' | 'priority' | 'createdAt' | 'startDate' | 'dueDate' | 'assignees'
KanbanColumn    { id, title, color?, autoComplete?, sort?, hideFromTimeline?,
                  isDoneDestination?, defaultTags?, cards[] }
KanbanBoard     { columns[] }
```

---

## IPC Commands

All commands in `src/lib/tauri.ts → tauriCommands`. Rust handlers in `src-tauri/src/commands/`.

Shared local/hosted file and document operations go through
`src/lib/vaultClient.ts`. Construct clients with `createVaultClient`; use its
optional callable runtime capabilities for mode-specific behavior such as
filesystem watching, local encryption, external asset import, local archive
export, and authenticated hosted assets.

Circuit job contracts live in the pure `src/types/circuitRuntime.ts` module.
Desktop and Android both use `src/lib/circuitJobRunner.ts` for staged native-job
polling and `src/lib/circuitErrorText.ts` for structured diagnostics; platform
modules only provide typed Tauri command adapters and presentation.

### Vault
```
openVault(path)                                             → VaultMeta
createVault(path, name, ownerUserId?, ownerUserName?, ownerUserColor?)  → VaultMeta
getRecentVaults()                                          → VaultMeta[]
removeRecentVault(path)                                    → void
renameVault(vaultPath, newName)                            → VaultMeta
exportVault(vaultPath, destPath)                           → void
showOpenVaultDialog()                                      → string | null
showSaveDialog(defaultName)                                → string | null
```

### Encryption
```
unlockVault(vaultPath, password)                           → void
enableVaultEncryption(vaultPath, password)                 → void
disableVaultEncryption(vaultPath, password)                → void
changeVaultPassword(vaultPath, oldPassword, newPassword)   → void
```

### Files
```
listVaultFiles(vaultPath)                                  → NoteFile[]
readNote(vaultPath, relativePath)                          → NoteContent
writeNote(vaultPath, relativePath, content, expectedHash?) → WriteResult
createNote(vaultPath, relativePath)                        → NoteFile
moveNoteToTrash(vaultPath, relativePath, deletedByUserId?, deletedByUserName?) → TrashEntry
listTrashEntries(vaultPath)                                → TrashEntry[]
restoreTrashedItem(vaultPath, entryId, targetRelativePath?) → string
purgeTrashedItem(vaultPath, entryId, removeReferences?)    → void
purgeAllTrash(vaultPath)                                   → void
deleteNote(vaultPath, relativePath, removeReferences?)     → void
previewRenameMove(vaultPath, oldPath, newPath)             → PathChangePreview
renameNote(vaultPath, oldPath, newPath)                    → void
createFolder(vaultPath, relativePath)                      → void
readPdfSidecarState(vaultPath, pdfRelativePath)            → PdfSidecarState
writePdfSidecarState(vaultPath, pdfRelativePath, state)    → void
```

### Templates / Snippets
```
listKanbanTemplates(vaultPath?)                            → KanbanTemplate[]
saveKanbanTemplate(vaultPath, template)                    → KanbanTemplate
deleteKanbanTemplate(vaultPath, scope, templateId)         → void
listNoteSnippets(vaultPath?)                               → NoteSnippet[]
saveNoteSnippet(vaultPath, snippet)                        → NoteSnippet
deleteNoteSnippet(vaultPath, scope, snippetId)             → void
```

### Index
```
buildNoteIndex(vaultPath)                                  → NoteMetadata[]
getBacklinks(vaultPath, relativePath)                      → string[]
searchNotes(vaultPath, query)                              → SearchResult[]
```

### Watcher
```
watchVault(vaultPath)                                      → void  (emits: vault:file-created/deleted/renamed/modified)
unwatchVault()                                             → void
```

### UI
```
setUiZoom(zoom)                                            → void
isAppImage()                                               → boolean
```

### Update
```
checkForUpdate()                                           → UpdateInfo
downloadAndInstall()                                       → void  (emits progress events)
```

### Collab — Presence
```
writePresence(vaultPath, userId, entry: PresenceEntry)     → void
readAllPresence(vaultPath)                                 → PresenceEntry[]
clearPresence(vaultPath, userId)                           → void
```

### Collab — Vault Config / Users
```
getVaultConfig(vaultPath)                                  → VaultConfig
registerKnownUser(vaultPath, userId, userName, userColor)  → VaultConfig
```

### Collab — Chat
```
sendChatMessage(vaultPath, message: ChatMessage)           → void
readChatMessages(vaultPath, limit)                         → ChatMessage[]
```

### Collab — Activity
```
appendActivityEvent(vaultPath, event: ActivityEvent)       → ActivityEvent
readActivityEvents(vaultPath, limit, relativePath?)        → ActivityEvent[]
```

### Collab — Snapshots / History
```
createSnapshot(vaultPath, relativePath, content, authorId, authorName, label?) → SnapshotMeta
listSnapshots(vaultPath, relativePath)                     → SnapshotMeta[]
readSnapshot(vaultPath, relativePath, snapshotId)          → string
restoreSnapshot(vaultPath, relativePath, snapshotId, restoringUserId, restoringUserName) → WriteResult
```

---

## Rust Backend

The repository root is a Cargo workspace:

| Path | Responsibility |
|------|---------------|
| `crates/collab-circuit/` | First-party MIT circuit model, endpoint/junction net compiler, source maps, validation, DC/sweep/transient numerics, and the bounded linear complex AC sweep core shared by desktop and Android |
| `crates/collab-core/` | Shared local/hosted path normalization, hashing, and note/kanban/canvas reference analysis and rewrite rules |
| `crates/collab-protocol/` | Shared server response DTOs, error envelope, and protocol versions |
| `crates/collab-replica/` | Encrypted native hosted-vault offline replica, pending mutation queue, and document/asset/CRDT/logic-component caches |
| `crates/collab-calendar/` | Shared user-calendar wire model and profile-scoped SQLite store with indexed range queries, pending operations, optimistic item revisions, cross-location mirror groups/anchors/conflicts, and atomic local generated-Kanban projection replacement |
| `crates/collab-server/` | Standalone Axum server, PostgreSQL migrations, hosted-vault authorization/storage APIs, health checks, and blob storage |
| `src-tauri/` | Native Tauri application adapter and local-vault commands |
| `compose.yaml` | Local PostgreSQL, server, and Caddy gateway stack |
| `Dockerfile.server` | Cached multi-stage server image build |
| `apps/admin-web/` | Focused Collab-style server administration React app served below `/admin/` |

### Planned Crate Boundaries

The table above is the current source of truth. The
[Rust Crate Boundary Refactor Plan](../plans/rust-crate-boundary-refactor-plan.md)
proposes `collab-net-policy`, `collab-documents`, `collab-vault-domain`, and
`collab-live`, with `collab-archive` subject to a measured reuse decision. These
crates do not exist until their plan phases land.

Until then, isolate and characterize portable behavior inside its current
adapter before extracting it. Planned shared crates must remain free of Tauri,
Axum, SQLx, PostgreSQL, concrete filesystem/storage backends, and operating
system integration. `collab-core` should converge on low-level path, name,
hashing, and byte-encryption primitives rather than accepting additional
document-specific behavior.

`src-tauri/src/`

| File | Responsibility |
|------|---------------|
| `main.rs` | Windows subsystem, AppImage detection, WebKit DMA-BUF env setup, calls `collab_lib::run()` |
| `lib.rs` | Plugin registration (updater, opener, dialog, fs), all command registrations, Linux GTK gesture zoom suppression |
| `test_support.rs` | Shared backend test helpers for temp-vault setup, collab directory bootstrap, and fixture file IO |
| `state/mod.rs` | `AppState` — active vault path, file watcher handle, note index cache, bounded circuit-worker registry, and memory-only native server access session via `parking_lot` locks |
| `commands/vault.rs` | Vault CRUD, recents (~/.config/collab/recents.json, max 20), vault.json config |
| `commands/calendar.rs` | Profile-scoped calendar CRUD, bounded item/mirror queries, atomic item writes, pending operations, sync state, mirror group/anchor/conflict persistence, local generated-Kanban replacement, and transactional hosted change-page application over `collab-calendar` |
| `commands/server.rs` | Hosted-server connection/login/refresh/logout and OS credential-store refresh-token storage |
| `commands/replica.rs` | Thin Tauri command boundary over `collab-replica`, including hosted logic-component library cache reads/writes |
| `commands/circuit.rs` | Typed first-party circuit runtime over `collab-circuit`; exposes bounded native DC/sweep/transient start, staged status, cancellation, compact DC results, retained chunked sweep/transient results, explicit job disposal, plus the compatibility synchronous DC command, probe values, source maps, and topology diagnostics |
| `commands/files.rs` | File CRUD, trash/restore/purge flows, PDF sidecar persistence, rename/move previews, file-reference queries, reference rewrites, WalkDir traversal (filters .collab/, hidden files, non-.md/.canvas/.kanban), SHA256 hash |
| `commands/index.rs` | Frontmatter extraction, wikilink parsing, fuzzy search (fuzzy-matcher crate) |
| `commands/templates.rs` | Kanban template CRUD plus vault/app note snippet CRUD and scope-aware persistence |
| `commands/watcher.rs` | notify-debouncer-mini → Tauri events vault:file-{created,deleted,renamed,modified} |
| `commands/collab.rs` | Presence JSON, vault config R/W with role checks, chat files, activity log, snapshot manifest |
| `commands/crypto.rs` | AES-GCM encryption, Argon2 key derivation |
| `commands/ui.rs` | GTK zoom (Linux), AppImage detection |
| `commands/update.rs` | Tauri updater plugin, async download with progress |
| `commands/web.rs` | Remote link preview fetching with redirect controls, local-target blocking, content-type handling, and bounded HTML body reads |
| `models/` | Rust structs mirroring TypeScript types (serde Serialize/Deserialize, camelCase rename) |

**Collab file layout inside `.collab/`:**
```
.collab/
  vault.json                          VaultConfig
  presence/{userId}.json              PresenceEntry
  chat/messages.json                  ChatMessage[]
  activity/events.json                ActivityEvent[]
  history/{pathKey}/                  Snapshot index + .snap content
  templates/kanban/                   Vault-scoped kanban templates
  templates/notes/                    Vault-scoped note snippets
  pdf/{encoded}.json                  PDF bookmarks / highlights / viewer state sidecars
  trash/entries/{entryId}.json        Trash metadata
  trash/items/{entryId}/...           Trashed payloads
```

---

## Theming

Injected on `<html>` by `App.tsx`. Values use OKLCH color space.

### Themes (`uiStore.theme`)

| Theme | `--background` | `--card` | Character |
|-------|---------------|---------|-----------|
| `dark` | `oklch(0.17 0.015 264)` | `oklch(0.20 0.015 264)` | Charcoal-slate |
| `midnight` | `oklch(0.07 0.00 0)` | `oklch(0.10 0.00 0)` | True black |
| `warm` | `oklch(0.11 0.02 60)` | `oklch(0.14 0.02 60)` | Warm brown |
| `light` | `oklch(0.97 0 0)` | `oklch(1.00 0 0)` | Off-white |

### Accent colors (`uiStore.accentColor`) → `--primary`

| Key | OKLCH | Hex |
|-----|-------|-----|
| `violet` | `oklch(0.68 0.22 293)` | `#a78bfa` |
| `blue` | `oklch(0.65 0.19 237)` | `#60a5fa` |
| `emerald` | `oklch(0.72 0.17 162)` | `#34d399` |
| `rose` | `oklch(0.66 0.22 13)` | `#fb7185` |
| `orange` | `oklch(0.72 0.18 50)` | `#fb923c` |
| `cyan` | `oklch(0.74 0.14 200)` | `#22d3ee` |

### Key CSS variables (`App.css` + `App.tsx`)

```
--background          Main bg
--foreground          Main text
--card                Surface/card bg
--primary             Accent (from accentColor)
--primary-foreground  Text on accent bg
--muted               Subdued bg
--muted-foreground    Subdued text
--border              Border color
--input               Form input bg
--sidebar             Sidebar bg
--glass-bg            rgba overlay (dark: 80% opacity)
--glass-bg-strong     rgba overlay (dark: 93% opacity)
--glass-blur          12px
--editor-selection    CodeMirror selection (derived from --primary)
--editor-selection-dim  Unfocused selection
```

### Fonts (`uiStore.editorFont`)

| Key | CSS |
|-----|-----|
| `geist` | `'Geist Variable', sans-serif` |
| `inter` | `'Inter', sans-serif` |
| `serif` | `Georgia, serif` |
| `mono` | `'Geist Mono Variable', monospace` |

Body and CodeMirror fonts are kept in sync with `uiStore.editorFont`.

---

## Feature Map

How features map to source files:

| Feature | Primary files |
|---------|--------------|
| Note editing | `views/NoteView.tsx`, `components/editor/MarkdownEditor.tsx`, `components/editor/livePreview.ts`, `components/editor/slashCommands.ts`, `components/editor/snippetEngine.ts`, `components/editor/mathBlockCommands.ts`, `components/editor/mathSolver.ts`, `components/editor/mathPlotSpec.ts`, `components/editor/MathPlot2D.tsx`, `components/editor/MathPlot3D.tsx` |
| Note snippets | `components/editor/NoteSnippetsDialog.tsx`, `store/noteSnippetStore.ts`, `commands/templates.rs` |
| Footnotes / references helpers | `components/editor/noteAuthoring.ts`, `components/editor/useMarkdownEditorHandle.ts`, `components/editor/slashCommands.ts` |
| Vault file linking in notes | `lib/vaultLinks.ts`, `components/editor/slashCommands.ts`, `components/editor/useMarkdownEditorIntegrations.ts`, `components/previews/PdfLinkPreviewPopover.tsx` |
| PDF workspace tooling | `views/PdfView.tsx`, `components/pdf/PdfSendTargetDialog.tsx`, `lib/pdfWorkspace.ts`, `types/pdf.ts`, `commands/files.rs` |
| Code block syntax highlighting | `MarkdownEditor.tsx` (codeLanguages: languages from @codemirror/language-data) |
| Markdown preview | `components/editor/MarkdownPreview.tsx` (markdown-it + highlight.js + KaTeX) |
| File tree | `components/vault/FileTree.tsx`, `commands/files.rs` |
| Vault trash / restore | `components/vault/FileTree.tsx`, `components/vault/TrashPanel.tsx`, `components/vault/VaultDialogs.tsx`, `commands/files.rs` |
| File reference details | `components/vault/FileTree.tsx`, `components/vault/FileReferencesPanel.tsx`, `commands/files.rs` |
| Rename / move preview | `components/vault/FileTree.tsx`, `components/vault/VaultDialogs.tsx`, `commands/files.rs` |
| Note search | `components/vault/SearchPanel.tsx`, `commands/index.rs` (fuzzy-matcher) |
| Tag browser | `components/vault/TagsPanel.tsx`, `noteIndexStore` |
| Graph view | `views/GraphPage.tsx`, `components/graph/GraphView.tsx` (@xyflow/react) |
| Kanban board | `views/KanbanPage.tsx`, `components/kanban/KanbanBoard.tsx`, `KanbanColumn.tsx`, `KanbanCard.tsx` |
| Kanban card editing | `components/kanban/CardDialog.tsx` |
| Kanban archive | `types/kanban.ts` (archived/archivedColumnId), `KanbanBoard.tsx` (ArchivePanel), `KanbanCard.tsx` (context menu), `CardDialog.tsx` (sidebar button) |
| Kanban calendar | `components/kanban/CalendarView.tsx` (react-day-picker) |
| Kanban timeline | `components/kanban/TimelineView.tsx` |
| Timeline drag-to-reschedule | `TimelineView.tsx` (initDrag/moveDrag/endDrag, wasMovedRef for click detection) |
| Multi-workspace grid | `views/GridView.tsx`, `components/grid/`, `store/gridStore.ts` |
| Presence/collaboration | `components/collaboration/CollabProvider.tsx`, `commands/collab.rs` |
| Chat | `components/collaboration/ChatPanel.tsx`, `collabStore`, `collab.rs` |
| Activity feed | `components/collaboration/activity/ActivityPanel.tsx`, `collabStore.activityEvents`, `collab.rs` |
| Conflict resolution | `components/collaboration/ConflictDialog.tsx`, `collabStore.conflicts` |
| Snapshot history (notes / kanban / canvas) | `components/collaboration/HistoryPanel.tsx`, `collab.rs` (createSnapshot/listSnapshots/restoreSnapshot) |
| Vault encryption | `components/vault/VaultUnlockModal.tsx`, `VaultManagerModal.tsx`, `commands/crypto.rs` |
| App updates | `store/updateStore.ts`, `commands/update.rs` |
| Theming | `App.tsx` (CSS var injection), `uiStore` (theme/accentColor), `App.css` |
| Command palette | `components/CommandPalette.tsx` (cmdk) |

---

## Shadcn Components Installed

Located in `src/components/ui/`. Install new ones with `pnpm dlx shadcn@latest add <name>`.

| Component | File | Used in |
|-----------|------|---------|
| Button | `button.tsx` | Throughout |
| Input | `input.tsx` | Forms, search |
| Textarea | `textarea.tsx` | CardDialog, NoteView |
| Badge | `badge.tsx` | TagsPanel, card priority |
| Avatar | `avatar.tsx` | Presence, assignees |
| Tooltip | `tooltip.tsx` | ActivityBar, toolbars |
| Popover | `popover.tsx` | CardDialog dates, column color picker |
| Tabs | `tabs.tsx` | SettingsModal, VaultManagerModal |
| Dialog | `dialog.tsx` | CardDialog, VaultDialogs, destination picker |
| DropdownMenu | `dropdown-menu.tsx` | KanbanColumn settings |
| Sheet | `sheet.tsx` | Mobile sidebar |
| ContextMenu | `context-menu.tsx` | KanbanCard, FileTree, TabBar |
| Select | `select.tsx` | CardDialog column selector |
| Calendar | `calendar.tsx` | CardDialog date pickers |
| DatePicker | `date-picker.tsx` | Shared Calendar/Popover date field used by account Calendar and future forms |
| TimePicker | `time-picker.tsx` | Shared modal 12/24-hour time field used by account Calendar and future forms |
| Checkbox | `checkbox.tsx` | Binary form settings including all-day calendar items |
| Separator | `separator.tsx` | Menus |
| ScrollArea | `scroll-area.tsx` | Panels |
| InputGroup | `input-group.tsx` | Search inputs |
| Progress | `progress.tsx` | Update download |
| Command | `command.tsx` | CommandPalette, note/card pickers |
| Sonner | `sonner.tsx` | Toast notifications |
| ResizablePanelGroup | `resizable.tsx` | AppShell sidebar resize |
