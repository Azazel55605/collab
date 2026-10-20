# Desktop State, Sessions And Navigation

O10–O16 implementation batch, **2026-10-20**. The audit and Performance Batch 4
tracker distinguish automated checks from remaining native measurements.

## State And Persistence

Shell/common controls subscribe to individual store fields. GridView selects the
active workspace, so changing inactive workspaces does not invalidate its views.
View state remains in memory immediately, but editor-storage serialization and
writes happen once per 300 ms window. Identical projections produce no write.
Page hide, document visibility becoming hidden and the native quit checkpoint
flush pending metadata. This is view metadata, not document content; a hard kill
can lose the last window of viewport/selection changes. Retention accounting reads string lengths and a
small metadata allowance; it does not encode the entire cache during navigation.

Each note/sheet/ink/deck map retains 128 recently touched closed entries and pinned
open-file entries. Old persisted maps are trimmed on hydration. Grid panes append
an internal pane identifier to view-state keys, retaining independent selection
and viewport geometry. Rename migrates file/folder/pane keys; deleting a file or
folder removes its metadata. PDF retains its existing bounded recent-state cache.
`closeTabs` saves through the existing navigation gate once, then updates tabs,
activation and released metadata together; failed saves leave tabs mounted.

## Sessions And Shared Resources

Desktop `DocumentPane` identifies a vault/file/type/pane. On detach, controller
checkpoints retain serialized content, versions and reconciliation state, not
editor instances, callbacks, parsed scenes, workers or sockets. The clean LRU
keeps at most 64 entries/16 MiB (UTF-16 content/metadata estimate). Unsaved/conflicted
recovery entries are pinned: the normal save gate prevents these on navigation,
but exceptional teardown must not silently discard edits to satisfy a cache cap.
These recoveries are in-memory protection, not a new crash-recovery guarantee.

Reopening parses the retained checkpoint and revalidates against the authoritative
read using normal remote/conflict handling. Initial reads cannot overwrite a
retained dirty draft. Explicit history reload still uses force-load semantics.
Live sessions checkpoint through the existing offline path; final pane release
tears down the provider. Views continue to unmount on navigation, releasing their
DOM, renderers and listeners. PDF uses its separately bounded worker-resource cache.

Simultaneous VaultClient reads share a promise by vault/path/operation/access
context. Settled reads and failures leave the map, so subsequent reads revalidate.
Live targets share one provider/Y.Doc/offline writer while any pane uses them.
Each lease releases once; a pending open retired by logout cannot resurrect a
provider. Structured session origins are per pane, delivering sibling updates
without echoing the initiator. REST controllers remain independent and keep the
existing optimistic-lock/conflict policy; read sharing never authorizes overwrite.

Vault changes, lock, logout and account/membership/capability changes clear cached
plaintext and shared lookup identities. Mounted live holders keep their existing
save/leave ownership until final release; invalidation never destroys a provider
under an active pane, and new sessions cannot reuse a retired handle. Epochs
reject late teardown checkpoints from an
old lifetime. Rename invalidates detached document checkpoints while migrating
view metadata, avoiding reuse of a checkpoint under an obsolete path.

## Resize And Acceptance

Sidebar movement changes a local CSS variable at most once per animation frame;
release or focus loss commits the final clamped width once. Cancellation/unmount
restores prior cursor/selection styles. Grid ResizeObserver callbacks coalesce
per frame, and reducing visible panes still waits for the save boundary.

Regressions count persistence encodings/writes, 100-tab notifications, recent-state
size after 2,000 files, retained dirty/conflict behavior, shared read/provider
lifetimes and sibling updates. Browser checks use synthetic IPC and documents.
Native cold/warm reopen, layout/reflow profiles, long-session RSS, mixed-platform
window/tray lifecycle and real reconnect/offline acceptance remain the O70 matrix;
notification counts do not establish a measured native speedup.
