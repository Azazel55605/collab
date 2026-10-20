# Vault Listing And Search Performance

Implemented 2026-10-20 for desktop audit O17–O28. Validation is recorded in
[Performance Batch 5](../plans/desktop-audit-fixes.md).

Known file events retain their paths across the 150ms debounce. Local listing
returns replacements for those paths; note indexing reads changed Markdown files
only. Folder changes reconcile the subtree, deletion removes descendants, rename
batches include both paths, and unknown/missed-event scope falls back to a full
reconciliation. A batch keeps pending paths until its result publishes, so an
invalidated delta cannot silently lose an earlier change. Deltas declare full
reconciled path scopes and republish their metadata, even when native state
already advanced; this also repairs deletions missed by the frontend. Scope includes hosted
server identity. Hosted manifests keep their existing replica-based refresh path.

The native index owns source text, case-folded text and metadata once per note,
with shared immutable snapshots and incremental reverse-link adjacency. One edit
copies map pointers and emits changed metadata rather than serializing the vault
again. Graph and Tags still receive complete metadata through the frontend store.
Source-text and folded-text retention trade memory for zero source I/O during
queries; this is not a claim of lower total RSS for text-heavy vaults. Cache
records omit folded text and recreate it at startup. Native cold/warm heap/RSS
and contention profiles remain release acceptance work under O70.

Disposable records live in `.collab/search/v1/`. Warm startup validates file
size/nanosecond modification time, record path and content hash. Watcher-directed
updates force source reads even if timestamp/size are unchanged. Unknown-scope event reconciliation forces source reads. External changes
which preserve both stamps while the watcher is stopped need a forced
`buildNoteIndex(true)` invalidation; stamp validation is not an independent filesystem integrity proof.
Corrupt records fall back to source reads. Encrypted vaults encrypt records with
the native vault key; plaintext records are removed before encryption is enabled,
under the root mutation lock shared by cache writers. Lock/scope changes retire
native index ownership. These records are disposable, never authoritative files.

Search uses stable score-descending/path-ascending ordering. The sidebar displays
50 results per page; native pages cap at 100 and include total/next offset.
A heap stores lightweight candidates up to offset plus page size, bounded by the
number of matching notes; only the returned page builds excerpts/IPC results.
Deep offsets can retain more candidate pointers, without copying note contents.
Quick-open gets the first 100. Hosted search retains its existing server-side
50-result limit; adding server continuation is separate API work.

Two process-wide permits cover blocking listing, indexing and local search.
Obsolete queued/scanning index jobs reject publication, scans check ownership
between entries, and the search UI shows processed-note progress. Individual
filesystem reads are not forcibly interrupted. Notify backends which support
unwatching descendants prune generated/hidden directories; all backends filter
generated events. Known editor staging paths can still reconcile visible parents,
and final visible file events are retained.

The sidebar mounts a fixed-height visible window with eight-row overscan and
retains keyboard focus and HTML drag-source ownership when their rows scroll
offscreen. Full visible ordering
supports range selection. Tree rows retain native/internal drop attributes,
context menus, disclosure and ARIA tree positions. Keyboard arrows/Home/End
scroll and focus the next row. Actual OS file drags, mixed DPI/Wayland behavior,
screen-reader behavior and installed platform responsiveness remain native
acceptance checks.

WeakMap indexes follow immutable tree/manifest revisions and permit old trees to
be collected. Kanban attachment promises are cached per board revision with
three reader slots across overlapping passes; unchanged boards do not reread,
removed/superseded queued revisions skip I/O, and read failures remain isolated.
