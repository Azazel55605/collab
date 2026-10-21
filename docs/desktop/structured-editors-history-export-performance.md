# Structured Editors, History And Export Performance

Implemented **2026-10-21**, desktop audit **O52–O63**, Performance Batch 8.
The [audit](../audits/desktop-performance-and-bugs-2026-10-14.md) and
[implementation tracker](../plans/desktop-audit-fixes.md) record implementation;
[open development work](../plans/open-development-work.md) owns release acceptance.

## Ownership And Save Boundaries

Sheet, ink, deck and logic sessions keep the latest immutable root and mark edits
unsaved immediately. They coalesce serialization at 100 ms checkpoints. Save,
remote comparison and leave barriers flush that root before capturing bytes;
expected-hash, base-content and conflict handling remain exact. Loading a new
baseline cancels obsolete pending serialization. Sheet/logic JSON projections
reuse unchanged immutable subtrees without stringify/parse round trips.
Validation still runs synchronously. Logic geometry commits at gesture end or a
save barrier; selection/position changes do not invalidate circuit semantics.

Sheet history retains immutable roots under both a step and shared-object byte
estimate. Shared children are charged once; undo/redo movement, new-edit redo
retirement and remote/path boundary clearing update ownership. A snapshot larger
than the budget is dropped from history without altering the current document.

## Formula Protocol And Derived Work

The first evaluation seeds a runtime. Later requests carry revision/baseRevision,
changed cells and removals. Responses carry changed formula values and removals;
a missing/evicted baseline triggers one bounded reseed. Structural/timezone changes
seed again. The engine remains authoritative and still scans its retained formula
outputs when constructing a response; only changed outputs cross IPC.

Each workbook owns one active and latest pending evaluation. Superseding/disposal
signals native cancellation, awaits settlement and releases once. Native owners
separate short registry map locks from per-runtime evaluation locks; retirement
also cancels work admitted before waiting for a global slot. Destruction happens
outside the registry lock. Timeouts discard incomplete runtime state; a later
request seeds again. Manual recalculation and a visible-document volatile timer
share the same dispatch-time timestamp policy.

Weak structural indexes reuse stable row/column IDs through search, names,
validation and formula construction. Replace-all visits populated cells and uses
one bulk mutation. Conditional-format aggregate caches survive viewport/selection
changes and invalidate with rules/values. Existing grid virtualization remains;
overlay rectangle sizes use prefix offsets. Charts render in the analysis dialog.

Logic/canvas immutable conversion caches and dependency-keyed edge geometry avoid
repeating heavy derivation for unchanged objects. Necessary sibling routing and
final document traversal remain. Ink operations attach weak changed-object hints;
spatial bounds, tiles and invalidation update affected objects. Unknown remote,
layer/reorder paths retain conservative fallback, without replacing tile rendering.

## Media And Export Budgets

| Resource                          | Limit / lifetime                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Structured serialization          | 100 ms checkpoint; explicit save/remote/leave barriers                               |
| Formula work                      | Two native evaluations; sixteen retained runtimes                                    |
| Formula inputs                    | One million populated cells; 200,000 formula cells; five-second engine budget        |
| Volatile formulas                 | Manual refresh; sixty-second timer while document is visible                         |
| Sheet undo/redo                   | 100 total steps / 24 MiB estimated immutable graph                                   |
| Canvas card previews              | 24 nearby unique keys / 32 MiB estimated strings and decoded pixels                  |
| Deck display media                | 64 entries / 96 MiB estimated strings and decoded pixels                             |
| Deck raster thumbnails            | Fit 1920×1440; existing one-decoder, 48 MP source guard                              |
| Export workers                    | Two concurrent ink/PPTX workers, explicit busy error                                 |
| Worker snapshots / payload        | 64 MiB UTF-16 metadata estimate / 128 MiB binary packet                              |
| Export original-media preparation | 128 MiB data URL estimate; ink uses two lazy readers                                 |
| Native binary output              | Two writes / 256 MiB each; absolute destination, private staging, atomic publication |

Canvas drops offscreen/removed payloads from both preview state and node data,
releasing obsolete scheduler leases. Oversized payloads become stubs. Deck mounted
stage, virtual rail and presenter acquire independent shared leases scoped by
account/vault/path/revision/asset identity. Last release retires work. Display uses
native thumbnails; print/export separately load original bytes within their
preparation budget. Failed/budget-limited display media can retry after thirty
seconds. Privacy cleanup clears retained display media.

Ink/PPTX export serializes metadata once into owned UTF-8 buffers and transfers
binary embedded assets into workers. Results transfer back as bytes. Native
`write_downloaded_bytes` avoids a base64 output round trip, stages privately and
publishes atomically under the canonical path mutation lock. Cancellation,
completion, construction/posting failure and worker failure release admission.
Android keeps its own export adapter; the raw binary writer is a desktop command.

These budgets bound retained owners and admitted operations, not total process
RSS. JSON snapshots, worker-local parsing/data URL reconstruction, codec internals,
browser decoding and final output buffers still allocate memory. SVG display cost
is estimated. Mounted display demand above budget may omit media until demand
shrinks. Live JSON reconciliation still traverses the projection.

## Validation And Acceptance

Regression coverage includes exact checkpoint/save/remote boundaries; 5,000-cell
one-edit payloads below one percent of the full seed; changed/removal/reseed
results; formula retirement/cancellation and independent runtime locks; shared
history estimates; sparse indexes and conditional-format reuse; canvas pruning;
1,000-edge affected-only derivation; ink spatial updates/fallback; deck shared
leases; transferable packets/admission and native atomic binary replacement.

Desktop suites pass after affected corrections, including the separate performance
suite. Admin and Android suites, frontend type checks/builds, Rust workspace
tests/check, formatting, lint, bundle limits and crate/version guards are checked
at the end of this batch. Rust advisory refresh reports zero vulnerabilities. The npm gate passes with
one patched/explicitly ignored high advisory and one moderate KaTeX advisory;
existing documented advisory rationales remain unchanged.

No browser connector was available, so installed Playwright Chromium and Linux
WebKitGTK were used against real React SheetView/DeckView and real export workers
with synthetic native IPC. A rendered 20,000-row sheet sent 900 inputs for its
seed, one for a cell edit and zero for explicit recalculation, and saved once.
Ink produced a 1,700-byte SVG with no legacy base64 output; PPTX produced a valid
ZIP signature in both engines. Deck display requested a shared 1920-pixel native
thumbnail. Exporting through the real dialog also produced a 29,342-byte PPTX
through the raw binary writer, with no missing media in its report. The harness
validates browser ownership/transport, not native formula
arithmetic or actual hosted authorization. Native unit tests cover the engine and
publication paths. Vite explicitly prebundles JSZip so its module worker also
works in development with dependency discovery disabled.

A stale Cargo cache referenced updater permission files in a removed temporary
worktree; cleaning only that cached package restored the native build. This was
an environment repair, with no source workaround or TLS weakening. Generated
`dist-mobile/index.html` remains untouched; Android frontend output goes to a
temporary directory.

**O70 acceptance remains open:** installed latency and main/worker/GPU peak memory;
large sheets with volatile dependencies and conditional formats; long canvas
pan-away/back recovery; large ink edits and export cancellation; deck transitions,
missing media, full-resolution export/print; multi-pane/multi-client gesture,
undo and conflict behavior; encrypted/hosted/account switch checks; physical
Android and platform-specific native soak. These are release checks, not claimed
benchmark improvements. O65–O70 are the next open category.
