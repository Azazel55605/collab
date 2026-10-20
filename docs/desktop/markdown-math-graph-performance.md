# Markdown, Math And Graph Performance

Implemented 2026-10-20: desktop audit **O29–O36**, Performance Batch 6.
The [implementation tracker](../plans/desktop-audit-fixes.md#performance-batch-6--markdown-math-and-graph)
records verification and outstanding installed-app acceptance.

## Editor And Preview Ownership

`MarkdownEditor` can publish immutable CodeMirror `Text` transactions. `NoteView`
keeps the newest snapshot and materializes a string at most once per 120 ms
window, rather than on every keystroke. Dirty state is immediate. A local
checkpoint acknowledges a snapshot without replacing newer text or disturbing
composition/undo. External document adoption still replaces the editor through
its normal revision/conflict rules, without echoing it as a new local edit.

`DocumentSessionController.flushPendingChanges` checkpoints before save, remote
comparison/merge, conflict choices, retained-session capture and disposal. It also
runs after an awaited write, so typing during a backend merge remains recoverable.
Tag transforms flush first. Live notes continue to persist through Yjs.

Reading previews use deferred content. Parsing, cross-block Markdown semantics and
sanitization remain revision-level; this is not an incremental Markdown parser.
Only sanitized top-level blocks enter DOM reconciliation. Identical blocks retain
hydrated images, syntax highlighting and Mermaid output; duplicates retain
occurrence identity. Theme/accent changes invalidate Mermaid rendering. Image
requests use document/client scope and revision-indexed file identity; unrelated
edits do not fetch them again. Plot keys follow content rather than array position.
Moving the editor cursor within one source line also retains its decoration set.

## Math And Renderer Budgets

Nerdamer solving and plot sampling run in module workers. Parsing plot directives
stays lightweight and does not import Nerdamer into the UI module. The shared
math pool admits two active jobs and at most 24 active/queued jobs, times out a
running job after eight seconds, terminates cancelled/stuck workers and reuses
successful workers for up to 15 idle seconds. Expressions are limited to 8,192
characters. Existing 1,200-point 2D / 90-by-90 3D sampling limits remain.

New requests cancel superseded work. Results must still match their originating
editor, immutable document and request. Variable selection follows the same rule.
Loading and calculation failures are visible; unavailable workers do not fall back
to heavy synchronous computation. Samples have a 12-entry LRU, independent of
renderer size. Offscreen sampling stops; successful cached samples can be reused.

3D plots redraw only after camera, size, spec or appearance changes. No continuous
animation loop remains. Visibility/document hiding releases renderers. At most
three WebGL leases are active, each bounded to two million physical pixels (six
million aggregate). A visible waiting plot offers **Activate plot**, which takes
priority over an older lease. Camera state survives eviction; reset remains
explicit. Unmount, replacement and failed setup dispose allocated GPU resources.
2D plots also defer sampling while offscreen.

## Graph And Icon Search

Graph adjacency is cached per source and invalidated when target lookup semantics
change. Content-only index refreshes retain graph identity. Keyed SVG joins retain
nodes, selection, zoom and pan; fresh callbacks do not restart the layout. D3 force
simulation runs in a persistent worker with retained positions, generation checks,
coalesced position publication, resize/pin messages and hidden-document suspension.
Failures/timeouts expose a retry. Workers and frame callbacks stop on unmount.

The existing 500-note graph cap remains; displayed edges are additionally bounded
to 5,000, with the limit exposed in the note/link count tooltip. SVG retains node
hit testing, keyboard activation and accessible labels. Search now dims unmatched
nodes without rebuilding layout. A canvas migration is deferred: this bounded
SVG surface passed the 500-node/1,000-edge interaction check; unbounded/dense
rendering is not claimed.

Icon search preserves exact/prefix/word/substring ordering. A character/trigram
posting index narrows candidates and score buckets retain only the requested top
results. Index construction runs in 100-icon background slices, with a bounded
registry scan until ready, so the first query avoids a single long indexing task.
The query LRU retains at most 64 keys / 8,192 result references; result limits are
clamped to 1,000 and query length to 512. Zero/negative limits return no results.
The measured typed-array index occupies **2,630,852 bytes**, excluding Map/string
and object overhead. Cache keys have at most 32,768 query characters;
result reference storage is bounded independently of registry entries.

## Rendered Evidence And Acceptance

Regular Playwright was used because the Browser plugin is unavailable. Chromium
used real module workers and software WebGL; Linux WebKitGTK **2.54.1** used real
workers and synthetic Tauri IPC. These exercise integrated source components,
not an installed Tauri process or a physical Android device.

- Chromium and WebKit: worker evaluation returns `4` for `2+2`; malformed input
  reports an error. Surrounding text changes retain the image and diagram DOM;
  asset reads stay at **one**, rather than increasing after the edit.
- Both engines: **500 nodes / 1,000 links** lay out off-thread and retain node DOM
  after an index update. Chromium retains zoom/pan, filters matches and supports
  node dragging. Dense-graph regression coverage enforces the 5,000-edge limit.
- Chromium: **12 plots**, at most **three canvases** before/after scrolling; each
  measured canvas uses **191,040 pixels**. An idle **600 ms** sample produces
  **zero draw calls**. This is a redraw invariant, not native GPU/CPU profiling.
- Chromium: 500 repeated typed-query lookups across seven queries take about
  **15 ms cold / 2 ms warm** on this host. This is an observational sample, not
  a cross-platform latency guarantee or an uncached-query benchmark.
- Regression tests cover immutable transactions, composition-tagged changes,
  keyboard evaluation/undo, stale evaluation/domain cancellation, save/merge
  checkpoints, retained resources, renderer admission/idle scheduling, graph
  identity and icon ranking/cache bounds.

Still required under **O70**: installed Windows/Linux/macOS typing/IME, native
WebGL/context recovery and physical memory/CPU/GPU measurements on representative
large notes and dense graphs. Existing Android acceptance remains separate.
