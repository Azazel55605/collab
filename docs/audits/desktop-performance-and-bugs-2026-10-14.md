# Desktop Performance, Memory And Bug Audit

Reviewed: **2026-10-14**. Source baseline: `a5ecaccfac806005233b11c1a7a203fe2051f7ed`
(`main`, desktop package `0.8.7`). The findings below retain that historical baseline. Current implementation
status is tracked in the checklists below; this is not a blanket release sign-off.

The inventory contains **88 entries: 8 bugs, 10 investigation items, and 70
performance opportunities**. It covers the desktop shell, editors, React stores,
Tauri IPC, local files/indexing, rendering/media, collaboration/replicas,
calendar/background work, build inputs and observability. Shared crates and
hosted adapters are included where the desktop calls them. Independent Android,
admin-web and server product audits are outside this first pass.

“Every optimization” cannot mean proof that no other issue exists in a large
codebase. This is a comprehensive source-backed first-pass inventory, including
small and conditional improvements; native profiling must establish their actual
cost. Source discovery inventoried 862 TS/TSX/Rust files and 244,405 lines under
`src/` and `src-tauri/src/`, including tests, plus the relevant shared-crate paths.
Hotspots and lifecycle boundaries received manual review; this is not a claim
that every line or every platform was exercised.

## Implementation Progress

Updated **2026-10-19**, through implementation batches 1–9 in
[Desktop Audit Fixes](../plans/desktop-audit-fixes.md). Keep these checkboxes current
with each implementation batch. `[x]` means the described correction is
implemented; it does not substitute for native acceptance or close adjacent
requirements. `[ ] Partial` and `[ ] Open` retain unfinished scope. The original
88 findings and source evidence below remain the pre-fix inventory.

### Bug Corrections

- [x] **B01:** Save-before-navigation/tab/page/vault and grid transitions, including
      responsive pane removal, plus a native close/tray/system-quit save handshake.
      Every mounted pane participates. Live document controllers also await their available native CRDT checkpoint.
      Forced process death and durable draft recovery remain separate follow-up work; native quit and broader canvas acceptance stay open below.
- [x] **B02:** Unicode-safe search excerpts.
- [x] **B03:** Stale search responses rejected.
- [x] **B04:** PDF loading-task cleanup and bounded resource reuse.
- [x] **B05:** Late native listener registration safely cleaned up.
- [x] **B06:** Unique staging files and atomic document/sidecar publication.
- [x] **B07:** PDF thumbnail publication checks the rendered source hash.
- [x] **B08:** Canvas backing dimensions obey the pixel ceiling after rounding.

Native storage/GPU/lifecycle soak and the platform matrix remain release
acceptance. The user's external-drop fix is confirmed working. **User retest, 2026-10-19:**
after merging PR #96 and updating the installed git build, the recurring canvas
live-edit/save issue is no longer observed. The user also reports a substantially
faster, snappier app, particularly from avoiding repeated/stale loading. This is
observed installed-app feedback, not measured performance. Explicit navigation,
reopen/restart, offline/failure and broader platform acceptance remain open.
**Hosted non-live saving user-retested, 2026-10-19:** the user reports the issue
appears fixed on the updated test server. Close the reported recurring-conflict
symptom; no additional persistence change was needed for this follow-up.

### Investigation Follow-Up

- [x] **R01:** Frontend/native index scope/generation guards, obsolete-scan checks,
      coalesced refreshes and scoped backlinks/search. Native crypto transition QA
      remains open.
- [x] **R02:** Identity-keyed grid editor lifetime and save-gated replacement,
      workspace/layout/swap/resize transitions. Same-file registrations are retained
      independently. Shared same-file sessions remain O15.
- [x] **R03 native coordination:** One process-local coordinator reserves vault
      namespaces through compare/merge/write, rename/reference rewrites, folder
      deletion, trash/restore, creation/import, image/sidecar writes, snapshot
      restore and encryption transitions. Overlapping absolute exports participate;
      separate vaults stay independent. Creation never truncates an existing note.
      Stale/deleted-file checks remain. Arbitrary external-editor races and durable
      recovery have a separate [policy and follow-up](../plans/local-file-external-writer-recovery.md);
      this checkbox does not promise cross-process compare-and-swap or rollback
      of partial multi-file operations. Native platform acceptance remains open.
- [x] **R04:** One atomic, encrypted-as-needed preview record contains metadata
      and image bytes, with a complete-record integrity check. Legacy/missing/corrupt
      entries regenerate; source/renderer checks remain. O44 disk retention is now
      implemented in Performance Batch 7; installed storage QA remains open.
- [x] **R05:** Bounded serial OCR queue owns initialization, language transitions,
      per-worker progress and idle termination. Failures release ownership and do not
      poison later jobs. O46 native process limits are now implemented in Performance
      Batch 7; real-engine soak acceptance remains open.
- [x] **R06:** Shared desktop/Android formula owners await submitted native work
      before releasing, cancel pending work and isolate workbook/StrictMode lifetimes.
      A mounted workbook retains at most one active and one latest trailing request.
      Native execution/release stress and process-death acceptance remain open.
- [x] **R07:** Scope/epoch ownership for snippet lists and mutations.
- [x] **R08:** OCR result text is memory-only, bounded to 64 entries / 8 MiB
      for at most 30 minutes, scoped to the current vault/account lifetime.
      Close/lock/logout/membership changes clear it and invalidate pending writes.
      The old plaintext IndexedDB database is deleted; blocked deletion is retried
      and the Settings clear action reports failures. Installed language packs and
      saved annotations are unaffected. Native profile-upgrade acceptance remains.
- [x] **R09 investigation:** Confirmed a capability gap: hosted manifests cannot
      supply content-derived tags, links or word counts. The full-text server index
      is separate. Hosted Graph/Tags/Backlinks parity remains **planned feature work**,
      not a completed correction or a full content index.
- [x] **R10:** Escaped Markdown renderer-error fallback; regression covers markup
      in an exception, without claiming a demonstrated production exploit.

### Optimization Checklist

Every O01–O70 item below has its own checkbox. O39's shared PDF-card pipeline and
O47's WASM worker/job ownership are implemented. Partial entries identify the narrower completed work; unchecked
items still need implementation and/or the requested measurements. No native
startup, RSS, FPS, GPU or latency speedup is claimed from unit tests.
O64 now uses one bounded merge engine across native and server saves; the
opt-in synthetic benchmark is an initial O70 measurement fixture, not a native
performance release gate.

## Reported Regression Follow-Up

The [2026-10-14 reported-issue reconciliation](./reported-regressions-2026-10-14.md)
tracks all 14 subsequent user reports against these inventories, including PDF
state reset, cache-first reads/automatic freshness, slow/basic previews, component
consistency, drop targeting, legacy chat/sidebar behavior, Kanban scrolling,
mobile drawing, canvas performance/save failures and math-block evaluation
keyboard-shortcut failure (UR14, reported 2026-10-15). Existing IDs/counts remain
unchanged; the supplement separates reported symptoms from verified mechanisms
and adds acceptance targets for gaps. Its current checklist records completed
desktop work separately from partial changes, Android work and native acceptance.

UI follow-up **UR15 (2026-10-20)**: routine folder, view and settings-category
changes now remain opaque instead of replaying stacked entrance fades. A modal
follow-up also removes shared dialog/backdrop fades and Settings’ extra entrance
after the user reported remaining flashes in settings and editor builders. Rendered
reproduction/verification and remaining native confirmation are recorded in the
[reported regression reconciliation](./reported-regressions-2026-10-14.md#ur15--routine-ui-changes-flash-once).

Follow-ups **UR16–UR18 (2026-10-20)** cover viewport sizing for math/merge
dialogs, Markdown file-link previews and excess code-block height. These are
tracked separately in the [reported regressions](./reported-regressions-2026-10-14.md#ur16--math-and-merge-dialogs-exceed-the-viewport)
and implementation tracker; they do not close the remaining preview categories.

## Evidence And Interpretation

- **Reproduced**: a focused probe exercised the current code or, for the Rust
  excerpt helper, an exact extraction of it. Observational probes assert the
  current bad behavior; they are not acceptance tests for a future fix.
- **Source-confirmed**: a specific missing cleanup, colliding path or version
  check is visible in code. Its production impact is not quantified here.
- **Investigate**: a plausible fault or cost needs a controlled reproducer.
- **Opportunity**: the implementation does identifiable work that may be reduced.
  This does not establish a user-visible bottleneck or a memory leak.
- **P1**: first delivery batch; data loss, crashes, major resource growth, or a
  likely large desktop cost. **P2**: next batch. **P3**: conditional/measurement
  work after the larger issues. Priorities are audit recommendations, not measured
  speedup rankings. There are no invented percentage improvements.

### Measured Production Artifacts

A fresh Vite build wrote only to `/tmp/collab-desktop-audit-dist` and succeeded
in the build-reported **3.12 seconds**. This is build duration, not app startup.

| Artifact                  |  Raw bytes | Illustrative gzip bytes | Interpretation                                              |
| ------------------------- | ---------: | ----------------------: | ----------------------------------------------------------- |
| Initial `index-*.js`      |  6,926,495 |               2,040,748 | Large eagerly evaluated application graph                   |
| `index-*.css`             |    363,836 |                  64,908 | CSS/font declarations; inspect active rules and styles      |
| Mermaid browser bundle    |  5,493,176 |               1,565,532 | Separate asset, loaded on demand; not initial JS            |
| Three.js chunk            |    722,503 |                 181,456 | Already dynamically loaded                                  |
| PDF worker A              |  2,395,538 |                       — | Bundled worker asset                                        |
| PDF worker B              |  2,228,489 |                       — | A second worker from another PDF import path                |
| Pure Nerd Font WOFF2      |    973,228 |                       — | Distribution/font cost, not proof it loads at startup       |
| English OCR language pack | 10,923,060 |                       — | Already compressed; packaged offline OCR input              |
| All output files          | 40,187,522 |                       — | 232 files; excludes the Rust executable/native dependencies |

Gzip is an offline comparison, not the measured Tauri asset transport. Packaged
bytes, downloaded bytes, decoded images, JS heap, worker heap, GPU memory and
native RSS are different metrics. No native RSS, cold startup, power or WebKitGTK
frame-time measurements were performed in this pass. Build warnings identify
ineffective dynamic imports for the opener, Tauri window API and OCR cache; the
large-chunk warning was retained rather than hidden.

## Bugs

### B01 — P1 — Switching/closing an editor can discard a pending local edit

**Reproduced, including the real `NoteView` with mocked storage/editor input.**
[AppShell](../../src/components/layout/AppShell.tsx) renders an identity-keyed
active document and unmounts it when the document/page changes.
[DocumentSessionController](../../src/lib/documentSessionController.ts#L729),
`dispose()`, cancels autosave and clears listeners without flushing or durably
retaining the unsaved document. [TabBar](../../src/components/layout/TabBar.tsx)
closes directly; [editorStore](../../src/store/editorStore.ts) retains tab/view
metadata, not the unsaved body.

The probe loaded a local note, changed it, immediately unmounted, waited past
its debounce and reopened: **zero writes; the old saved body returned**. Local
note behavior is reproduced. Ink/deck and other consumers of the same controller
need their own acceptance cases; hosted live persistence has a different path.

Fix with a document-session owner that survives navigation, or an awaited
save/close transition plus durable draft recovery. Do not solve this by mounting
all editors forever. Test tab switch, Chats/Grid navigation, close/middle-click,
close-all, quit, write failure, conflict, locked vault and offline mode.

### B02 — P1 — Local full-text search can panic on Unicode excerpts

**Reproduced from the exact `make_excerpt` implementation** in
[index.rs](../../src-tauri/src/commands/index.rs#L132). The helper gets byte offsets
from lowercased text and slices the original text at `pos - 40`, the computed
end, and `max_len`. Neither UTF-8 boundaries nor case-fold length changes are
accounted for.

Input `"中".repeat(30) + "needle" + "中".repeat(30)`, query `needle`, limit 120:
**panic at byte 50, inside a Chinese character**. Search results can fail rather
than return an excerpt; this does not prove the entire application process exits.
Use Unicode-safe clipping and a correct mapping between case-folded and original
text. Test Chinese, emoji, accented text, Turkish dotted I, long matches and each
clipping boundary.

### B03 — P2 — An old search response overwrites results for a newer query

**Reproduced against [SearchPanel](../../src/components/vault/SearchPanel.tsx#L20).**
The 300ms timer is cleared on a new query, but a request already sent is neither
cancelled nor generation-checked. Resolve the second query first, then the first:
the UI shows the first query's results while the input still contains the second.
This can also occur around vault changes. Guard query + vault identity, cancel
where possible, and represent loading/error explicitly. Test out-of-order replies,
clearing the input, changing vault and unmounting during a request.

### B04 — P1 — Successfully opened PDFs have no matching loading-task teardown

**Source-confirmed cleanup omission** in [PdfView](../../src/views/PdfView.tsx#L1247),
the document-load effect around `getDocument`. `task` is local to its async
callback. It is destroyed only when cancellation is noticed immediately after
`task.promise`; successful loads store only `pdf`, and effect cleanup sets a
boolean. Cancellation after `getPage(1)` returns without teardown, and load errors
have no task-level `finally`. The loading-task handle is not retained for normal
unmount/replace cleanup. Closing a tab therefore lacks explicit PDF worker/source
release; actual heap retention must be measured in the native WebView.

Retain and destroy every loading task, cancel page renders, and clear backing
canvases. Also repair [CanvasPage](../../src/views/CanvasPage.tsx),
`renderPdfPreview`: it awaits `task.promise` before entering `try/finally`, so
failed loading skips `destroy()`. Test successful close, corrupt PDF, immediate
switch, cancellation during first-page lookup and repeated open/close heap slope.

### B05 — P2 — Disposal before native listener registration leaks the subscription

**Reproduced against `FileSystemTransport.onPresenceChanged`** in
[collabTransport](../../src/lib/collabTransport.ts#L58). Cleanup calls an as-yet
undefined unlisten function; when the `listen()` promise resolves later, the
subscription remains installed. `onChatUpdated` and `onConfigChanged` repeat the
pattern. [AppShell](../../src/components/layout/AppShell.tsx)'s async listener
setup and [CollabProvider](../../src/components/collaboration/CollabProvider.tsx)'s
window listeners have the same missing disposed guard.

The probe disposed before resolving registration and observed that the returned
unlisten function was never called. Introduce a shared race-safe subscription
helper; late registration must immediately unlisten. Test delayed registration,
partial setup failure, rapid vault changes and Strict Mode lifecycle cycles.

### B06 — P1 — Atomic-write temporary filenames collide and can overwrite a sibling

**Source-confirmed; path alias reproduced.**
[files.rs](../../src-tauri/src/commands/files.rs#L202), `write_vault_bytes` and
`write_note_to_path`, use `full_path.with_extension("tmp")`. `Notes/example.md`
and `Notes/example.canvas` both stage into `Notes/example.tmp`. An existing
sibling with that name is overwritten by `fs::write` and then renamed away;
concurrent writers can also share the staging path. The probe confirmed the path
collision without writing user files. This is not a concurrency stress result.

Use uniquely created sibling temp files that preserve full destination identity,
with clear cleanup/recovery rules. Test two extensions with the same stem,
pre-existing `.tmp`, concurrent writes and rename failure. Preserve same-directory
atomic rename and optimistic conflict checks.

### B07 — P2 — A PDF thumbnail can be stamped with a newer source than it rendered

**Source-confirmed version gap; timing scenario not yet executed.**
[pdfPreview](../../src/lib/pdfPreview.ts), `loadPdfPreviewDataUrl`, reads the PDF,
renders, and calls `writeCachedDocumentPreviewDataUrl` without an expected source
hash. [sidecars.rs](../../src-tauri/src/commands/files/sidecars.rs) then stamps the
cache with the source's current mtime/size. If the source changed during rendering,
the old thumbnail can be accepted as belonging to the new PDF. Internal document
previews already pass a revision in [documentPreview](../../src/lib/documentPreview.ts).

Bind the source read/render/write to one revision and reject an outdated write.
Test replacement while rendering, same-size replacement, and preserved mtime.
Consider a stronger revision than mtime/size for correctness-sensitive cache hits.

### B08 — P2 — The interactive canvas pixel ceiling is not a hard ceiling

**Reproduced against [rendering](../../src/lib/rendering.ts#L11).**
`boundedCanvasDeviceScale` applies a lower scale bound of 0.5 after calculating
the pixel-budget scale. At 8000×8000 CSS pixels, it returns 0.5, allocating
16,000,000 backing pixels despite the declared 12,000,000 maximum.

Allow a lower scale or additionally clamp backing dimensions. This is an oversized
surface case, not proof that ordinary desktop windows exceed the ceiling. Test
large dimensions, DPR extremes, non-finite input and actual backing-store rounding.

## Potential Bugs And Capability Gaps To Investigate

These are **not included in the eight established bug entries**. Each needs a
controlled reproducer before treating its impact as confirmed.

| ID / priority | Evidence and scenario                                                                                                                                                                                                                                                      | Required investigation                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 / P1      | [AppShell](../../src/components/layout/AppShell.tsx) publishes index results without a vault generation guard. [index.rs](../../src-tauri/src/commands/index.rs) keeps one global native index; `get_backlinks` ignores `_vault_path`, and `open_vault` does not clear it. | Delay indexing vault A, switch to B, then resolve A; check paths/tags/backlinks and encryption-key transitions. Scope native and frontend results to vault identity.                                      |
| R02 / P1      | [GridCell](../../src/components/grid/GridCell.tsx) renders document views without file identity keys, whereas AppShell keys them. The shared controller deliberately lives for a hook lifetime and uses mutable option proxies.                                            | Change one cell from A to B during a pending save/read. Prove whether A's acknowledgement or draft affects B; use identity-keyed controllers plus safe navigation.                                        |
| R03 / P1      | [files.rs](../../src-tauri/src/commands/files.rs) checks `expected_hash`, then later writes/renames without a per-file compare-and-write lock.                                                                                                                             | Race two grid views or an external writer against one file. Determine whether both writes can pass the same revision check; serializing a frontend controller alone is insufficient for external writers. |
| R04 / P2      | [sidecars.rs](../../src-tauri/src/commands/files/sidecars.rs) publishes preview metadata and payload as separate writes; readers may interleave.                                                                                                                           | Pause between writes, read, fail the payload write and retry. Establish a consistent publish protocol and fail-open-to-regeneration behavior.                                                             |
| R05 / P2      | [ocr](../../src/lib/ocr.ts) has one module-global `activeWorker` and `activeProgress`; `getWorker` has no single-flight initialization/job lock.                                                                                                                           | Run two OCR operations from separate grid panes, then switch language. Check duplicate workers, progress attribution and one job's idle shutdown interrupting another.                                    |
| R06 / P2      | [useSheetFormulaEngine](../../src/lib/sheet/useSheetFormulaEngine.ts) releases a runtime on unmount while previously submitted evaluations may still be pending. Native evaluation can create a runtime.                                                                   | Force release before an already-queued evaluation executes; check whether the runtime is resurrected and retained. Add runtime generation/cancellation if reproduced.                                     |
| R07 / P2      | [noteSnippetStore](../../src/store/noteSnippetStore.ts) publishes asynchronous snippet loads without a request/scope guard.                                                                                                                                                | Resolve vault A's snippet list after switching to B. Verify selection, display and mutations target the intended scope.                                                                                   |
| R08 / P2      | [ocrCache](../../src/lib/ocrCache.ts) persists plaintext recognized text/word boxes globally in IndexedDB. Call-site keys use hashes/path/document identity, not an explicit account/vault lifecycle policy.                                                               | Check encrypted vault close, hosted logout/revocation, cache browsing and deletion. Define authorized retention; identical bytes sharing a result is not itself evidence of incorrect OCR.                |
| R09 / P2      | [vaultClient](../../src/lib/vaultClient.ts), hosted `buildNoteIndex`, intentionally emits empty tags/wikilinks/word counts.                                                                                                                                                | Check hosted Graph/Tags/Backlinks behavior against local equivalents. Record a product capability gap rather than pretending the lightweight manifest is a full content index.                            |
| R10 / P2      | [MarkdownPreview](../../src/components/editor/MarkdownPreview.tsx) sanitizes success output but constructs raw HTML with `String(e)` in its error fallback.                                                                                                                | Determine whether a content-derived exception can inject markup. Escape fallback text regardless; do not claim a demonstrated XSS exploit from source inspection alone.                                   |

## Performance Opportunity Inventory

Each opportunity has a source, a concrete change and a verification target. Where
it overlaps a bug, the bug's correctness fix comes first. Items marked P3 are not
instructions to optimize code before measuring it.

Checklist reconciled **2026-10-21**: **O01–O47, O49–O70 are implemented;
O48 is superseded by R08**. All **70 implementation items are checked off**. Native release acceptance is tracked
separately below and in the implementation tracker; checkboxes do not claim
measured startup/RSS gains or certification on every platform.

### Startup, Bundles And Packaged Assets

Implementation complete **2026-10-20**. See [startup budgets and validation](../desktop/startup-performance.md)
and [Performance Batch 3](../plans/desktop-audit-fixes.md) for evidence and limits.

- [x] **O01 / P1 — Split document/page views at the application boundary.**
      One lazy registry serves shell/grid/chat/print entry points, with pane-local
      loading/error states and stable document identity. Linux WebKitGTK loaded
      all 16 view modules and rendered note/PDF fixtures; delayed-import tests
      cover replacement without stale mounts. Static JS is now about 1.20 MB
      against the audit's 7.28 MB baseline. Native cold/warm timings, installed
      asset-protocol checks and the full interaction matrix remain release QA.
- [x] **O02 / P2 — Load infrequently opened root modals separately.**
      Settings, vault management/unlock, debug controls and math controls load on
      demand. Lightweight settings and plot hosts keep requests during imports;
      Settings preserves requested tabs, and closing a pending overlay does not
      reopen it. Chromium covers shortcuts, a delayed Profile request and math
      controls. Print preview restores the previous window title when closed.
- [x] **O03 / P2 — Fix ineffective dynamic imports as graph changes, not warning suppression.**
      Window helpers and OCR-cache utilities intentionally use their already-shared
      imports. External links use the typed Tauri opener gateway. Heavy features
      stay deferred; the production build emits no ineffective-import warnings.
      Chunk warning thresholds are unchanged.
- [x] **O04 / P1 — Unify the PDF API/worker import strategy.**
      Desktop views/previews/cache and Android rich viewing share the legacy
      compatibility API/worker. Preview imports remain demand-driven. The two
      worker assets (4,624,027 bytes) become one (2,395,538 bytes). Chromium and
      Linux WebKitGTK rendered fixtures with the worker. This does not cap live
      worker counts/heaps; broad PDF features and physical-device QA remain.
- [x] **O05 / P2 — Defer icon registry initialization.**
      Query/completion helpers are separate from the mapping/sorted registry.
      `useNerdFontIcons` imports it only for an open picker/icon command, using
      the latest query after loading. Chromium verified command aliases, and
      regressions fix plural prefixes previously searched with trailing letters.
      Startup does not fetch/evaluate the icon registry.
- [x] **O06 / P2 — Reduce eager syntax-highlighter language coverage.**
      A small common grammar set replaces the eager complete Highlight.js catalog.
      Recognized uncommon fences load the complete remaining registry on demand
      to preserve aliases and embedded-language behavior. Unknown languages remain
      escaped text. Deferred highlighting is sanitized, cancellation/source-guarded
      and included in print readiness. CodeMirror's language metadata and lazy
      parser loading remain intact. Browser/unit checks cover common/rare/unknown
      fences, source preservation and stale jobs.
- [x] **O07 / P2 — Audit CSS/font distribution separately from startup fetches.**
      Generated mono/KaTeX CSS keeps every existing script, 400-normal mono subset,
      math face and font preference while retaining WOFF2 only. Default Geist and
      variable Inter remain. Duplicate WOFF/TTF payload falls by 959,012 bytes;
      total font assets are 1,625,392 bytes. Nerd Font uses swap display. Packaged
      bytes are reported separately from actual browser requests; no Latin-only
      subset or user-selected font is removed.
- [x] **O08 / P3 — Keep OCR assets optional at runtime without breaking offline use.**
      Worker/core/English assets stay bundled and demand-loaded, with optional
      language packs still installed explicitly. Preparation skips identical
      files, repairs same-size corruption atomically and writes integrity metadata.
      Build/CI verifies all four offline assets (about 17.79 MB), outside startup
      JS. Chromium recognized an English fixture with external network blocked;
      no OCR asset request occurred before recognition. Native OCR limits are now
      implemented under O46; real-engine worker-memory soak remains O70 work.
- [x] **O09 / P2 — Add bundle composition and regression budgets.**
      Every desktop build and CI check enforces measured raw/gzip JS, CSS, font,
      worker, OCR and package-byte budgets, required lazy entries, a deferred
      uncommon-language catalog and complete offline OCR assets. The report lists
      large chunks and their startup membership; CI retains it as an artifact.
      Limits live in `docs/desktop/startup-bundle-budgets.json`; native timing
      thresholds remain O70 and are not inferred from asset sizes.

### React State, Session Ownership And Navigation

Implementation batch **2026-10-20**; verification and native acceptance are
recorded in [Performance Batch 4](../plans/desktop-audit-fixes.md) and
[session ownership](../desktop/session-performance.md).

- [x] **O10 / P1 — Narrow whole-store subscriptions in shell/common surfaces.**
      Shell, root app, sidebar/activity/status/tab surfaces, grid controls,
      collaboration surfaces and command bar select their actual dependencies.
      GridView observes only the active workspace; note/ink/sheet common controls
      no longer subscribe to unrelated editor/UI state. Selector identities remain stable.
- [x] **O11 / P1 — Stop serializing persistent view state on every interaction.**
      Editor persistence captures references immediately but defers JSON encoding
      and localStorage writes to a 300 ms fixed window, deduplicating unchanged
      projections. Page hide, document suspension and the native quit save boundary
      flush pending state. This retains device-local geometry without putting it
      into shared documents; abrupt process termination may lose the last window
      of view metadata, not acknowledged document saves.
- [x] **O12 / P2 — Bound retained per-file view state.**
      Note/sheet/ink/deck maps retain 128 recent closed entries per format, plus
      pinned open files. Opening/touching promotes recency; bulk close trims released
      entries, hydration trims old oversized maps, rename migrates file/folder and
      pane keys, and deletion removes matching recent state. PDF's existing bounds remain.
- [x] **O13 / P2 — Batch close/reorder metadata updates.**
      Close-all/others call one save-gated `closeTabs` transaction. Opening a new
      tab also publishes tabs/activation together; reorder already uses one update.
      The 100-tab regression counts store notifications and durable writes after
      the gate. Save failures keep the tabs/editors open.
- [x] **O14 / P1 — Separate durable document sessions from heavyweight view mounts.**
      Scoped document panes retain serialized controller checkpoints while editor
      DOM, parsed scenes and listeners unmount. Initial reads revalidate retained
      state through the remote-change/conflict policy instead of resetting drafts;
      explicit history reload remains authoritative. Clean checkpoints are bounded
      to 64/16 MiB; exceptional unsaved recoveries are pinned rather than silently
      evicted. Live documents use their existing offline checkpoint boundary, and
      unused live providers are destroyed. Lock/logout/vault/authorization changes
      purge retained plaintext and reject stale detach callbacks.
- [x] **O15 / P2 — Deduplicate same-file sessions across grid panes.**
      VaultClient coalesces simultaneous document/asset/annotation/live-target reads
      by vault, path and access context without retaining settled results. Live
      documents share one provider/Y.Doc/offline writer per target with refcounted
      release. Structured pane-local origins deliver sibling edits without echoing
      the initiating pane. PDF's existing worker leases remain shared. REST
      controllers retain independent drafts and optimistic conflict handling;
      pane-local note/sheet/ink/deck geometry does not overwrite sibling view state.
- [x] **O16 / P3 — Reduce application-wide resize broadcasts.**
      Sidebar dragging paints local CSS geometry at most once per animation frame
      and commits one durable width on release/blur; cleanup restores body styles.
      Responsive grid observation coalesces geometry per frame and retains the
      save gate before responsive pane removal. Native layout/RSS/latency profiles
      remain acceptance work, not inferred from notification counts.

### Vault Listing, Indexing And Search

Implemented **2026-10-20**. Validation, measurements, limitations and native
acceptance are recorded in [Performance Batch 5](../plans/desktop-audit-fixes.md)
and [Vault Listing And Search](../desktop/vault-listing-performance.md).

- [x] **O17 / P1 — Replace whole-vault rebuilds for individual file changes.**
      Known watcher paths use subtree listing and note-index deltas. Rename batches
      cover old/new paths and removals; unknown gaps and missing parents reconcile
      fully. Pending paths survive overlapping invalidated reads.
- [x] **O18 / P1 — Bound indexing concurrency and reject obsolete jobs.**
      Frontend single-flight/coalescing plus native vault/request generations.
      Two process-wide listing/index/search worker slots bound retired jobs as well.
      Obsolete scans stop between entries and cannot publish into another vault.
- [x] **O19 / P1 — Use a persistent/incremental local content search index.**
      Native text/folded text is updated at changed paths; queries read no source
      files. Disposable per-note records validate source stamps, path and content
      hash; encrypted vaults encrypt records. Enabling encryption removes plaintext
      records under the same root mutation lock used by cache writers.
- [x] **O20 / P2 — Bound search result construction and delivery.**
      Local search selects lightweight top candidates and constructs excerpts only
      for a page (maximum 100, sidebar 50). Total/next offset and stable score/path
      ordering allow later pages. Quick-open retains a bounded 100-result contract.
      Hosted search retains the server's existing 50-result API limit.
- [x] **O21 / P2 — Build reverse-link lookup indexes.**
      Vault-scoped reverse adjacency updates changed edges only; lookups union
      normalized path, path-without-extension and stem matches with deduplication.
      Ambiguous stems preserve the previous all-matching behavior.
- [x] **O22 / P2 — Avoid full character-vector allocation for wikilink extraction.**
      Slice scanning allocates only link targets; UTF-8 delimiters, aliases and
      unterminated links retain their established behavior.
- [x] **O23 / P2 — Reduce redundant index copies across native/IPC/frontend layers.**
      One native metadata/text record per note, shared through immutable snapshots.
      Initial metadata is delivered once; updates send changed metadata/removals.
      Unchanged frontend metadata and tree nodes retain identity for Graph/Tags.
- [x] **O24 / P1 — Virtualize visible file-tree rows.**
      Iterative flattened visible rows, 28px geometry, eight-row overscan and a
      pinned keyboard-focus/drag-source rows. Range selection still uses the full visible order;
      rows preserve drop attributes, context menus, disclosure and tree semantics.
- [x] **O25 / P2 — Maintain path/id maps instead of repeated tree flatten/find work.**
      WeakMap revision caches supply file/path/case-folded lookups and hosted
      manifest ID/state-path maps. Sorting and subtree patching preserve unchanged
      subtrees; asset resolution preserves prior candidate precedence.
- [x] **O26 / P1 — Incrementalize kanban attachment discovery.**
      Per-board revision promises share three reader slots across overlapping
      passes. Unchanged boards reuse parsed attachments, removed revisions prune,
      obsolete queued reads skip I/O and unreadable boards fail independently.
- [x] **O27 / P2 — Stop generated-directory churn from triggering visible-vault scans.**
      Generated and unrelated hidden paths never bubble to visible parents. Known
      editor staging names still reconcile parents; final visible edits/renames
      remain observed. Supported notify backends unwatch ignored descendants;
      portable event filtering remains in place when pruning is unsupported.
- [x] **O28 / P2 — Move heavy local listing/index/search into bounded native jobs.**
      Async commands acquire the shared native budget before blocking filesystem/
      CPU work. Listing checks active vault ownership; indexing checks request
      generations, emits processed-note progress and rejects stale publication.
      Native per-platform IPC latency/RSS certification remains under O70.

### Markdown, Math And Graph

Implemented **2026-10-20**, Performance Batch 6. See
[mechanisms, budgets, rendered evidence and native acceptance](../desktop/markdown-math-graph-performance.md).

- [x] **O29 / P1 — Avoid whole-note string/render work for every keystroke.**
      Immutable editor transactions, 120 ms session checkpoints and deferred
      reading previews. Save/merge/retention boundaries flush pending edits;
      same-line cursor motion retains decorations. Revision-level Markdown
      parsing remains; IME/native typing acceptance stays under O70.
- [x] **O30 / P2 — Reconcile preview blocks/assets rather than rebuilding all DOM work.**
      Sanitized block reconciliation retains images, diagrams and highlighting;
      image jobs use client/document scope and revision-indexed file identity.
      A surrounding text edit retains both resource nodes and one asset read.
- [x] **O31 / P2 — Move expensive math sampling/solving off the UI thread.**
      Two-worker bounded pool, cancellation/termination, eight-second timeout,
      immutable editor/request checks and visible loading/errors. Sampling is
      cached separately from resizing; obsolete domain results cannot publish.
- [x] **O32 / P1 — Render static 3D plots on demand.**
      Coalesced invalidation replaces the animation loop; visibility suspends
      rendering and cleanup disposes resources. Software WebGL records zero
      draw calls during a 600 ms idle sample; native GPU profiling stays open.
- [x] **O33 / P2 — Limit simultaneously active inline plot renderers.**
      Three WebGL leases, two million physical pixels each; visibility-based
      disposal, retained camera state and explicit activation for queued plots.
      Twelve-plot scrolling stays within three canvases in the rendered check.
- [x] **O34 / P2 — Move large graph layout work off the UI thread.**
      Persistent D3 worker, retained positions, generation checks, coalesced
      publication, hidden-document suspension and retry/cleanup. SVG keeps
      accessible node activation; the view is bounded to 500 notes/5,000 links.
- [x] **O35 / P2 — Stable graph inputs and incremental adjacency updates.**
      Per-source adjacency and target-lookup invalidation, stable semantic inputs,
      keyed node/link joins and current callback refs retain camera/selection.
      Graph search now dims unmatched nodes without restarting the layout.
- [x] **O36 / P2 — Bound command/icon search caches and work.**
      Background-sliced character/trigram index, top-k buckets and a 64-key /
      8,192-reference LRU. Typed-array index: 2,630,852 bytes; observed 500
      repeated lookups: about 15 ms cold / 2 ms warm on the QA host.

### Previews, PDF, Images And OCR

Implemented **2026-10-21**, Performance Batch 7. See
[resource limits, validation and native acceptance](../desktop/previews-pdf-images-ocr-performance.md).
These checkboxes record implementation; installed latency/RSS, physical platform
and real-engine soak acceptance remain under O70.

- [x] **O37 / P1 — Scoped binary asset transport.** Native `read_vault_asset_bytes`
      returns raw IPC buffers for desktop PDF/image sources and thumbnail inputs.
      Local canonical-path/encryption checks and hosted authentication, revision
      checks, encrypted replicas and connectivity-only fallback remain enforced.
      The bridge caps each source at 256 MiB; bearer tokens remain native.
- [x] **O38 / P1 — Shared preview scheduler.** Account/vault/path/revision/variant
      keys deduplicate tree/link/canvas preview requests. Four active jobs and
      256 retained jobs, consumer leases, visible priority and background fairness
      replace independent queues. Text reads participate in admission as well.
- [x] **O39 / P2 — Standard PDF cards.** Canvas cards retain the shared versioned
      first-page preview pipeline and persistent-cache reuse.
- [x] **O40 / P1 — Bounded image thumbnails.** Raster hover/card previews receive
      native 640×480 PNGs rather than original data URLs. One decoder, 48 MP input,
      192 MiB decoder allocation limit and EXIF orientation handling; bounded SVG
      passthrough. Unsupported formats fail without loading full originals as a fallback.
- [x] **O41 / P2 — Consumer-owned cancellation.** Last-consumer cancellation
      removes queued closures and aborts native reads/HTTP, PDF loading/raster
      tasks and worker operations. Other consumers retain their leases. Native
      synchronous image codecs observe cancellation before/after decode rather
      than being forcibly interrupted inside the codec.
- [x] **O42 / P2 — PDF resource budgets and lifecycle.** PDF sources retain their
      two-entry/64 MiB idle cache, with 30-second idle worker retirement. Viewer
      page caches charge blob, decoded pixels and text bytes (64 MiB/12 entries);
      thumbnail cache is 16 MiB/32 entries. Live backing canvases share 48 million
      pixels, at most six million per page. Offscreen pages release backing stores.
      Vault/account/lock/disconnect changes clear resources and revoke URLs.
      PDF.js internal heap is not an exact byte-accounted allocation.
- [x] **O43 / P2 — Cancellable PDF raster queue.** One bounded 64-job owner
      drops obsolete queued zoom/page work, aborts active renders and supports
      visible/background priority with fairness.
- [x] **O44 / P2 — Disposable disk-cache retention.** Native atomic preview records
      are subject to a 256 MiB/4,096-record/30-day quota, with orphan cleanup on
      reads, writes and managed rename/delete/trash. Canonical namespace and
      symlink checks prevent GC escaping into authoritative sidecars.
- [x] **O45 / P1 — Image/OCR worker processing.** One worker and eight admitted
      jobs own filters, rotation/crop/resize and encoding. Previews use two million
      pixels, OCR preprocessing twelve million, source/export ceiling 48 million.
      Bounded previews preserve original export dimensions within that ceiling;
      native/webview pixel fidelity and real OCR accuracy remain acceptance.
- [x] **O46 / P1 — Bounded native OCR.** Two concurrent subprocesses, fail-fast
      overload, 60-second timeout, cancellation, bounded input/output reads,
      temporary-file output monitoring and kill/reap guards replace blocking
      unbounded output collection. Temp files/directories remain RAII-owned.
- [x] **O47 / P2 — Serialized WASM OCR ownership.** The existing single worker /
      eight-job owner remains; cancellation terminates abandoned recognition and
      never invokes native fallback or publishes a cancelled result.
- [x] **O48 / P2 — Superseded by R08 memory-only retention.** No OCR result
      storage connections remain. The bounded memory LRU and privacy cleanup
      remain authoritative; installed language models are separate resources.
- [x] **O49 / P2 — Streamed language installation.** One install, actual streamed
      80 MiB ceiling, request timeout/cancellation, incremental digest and atomic
      staging/publish. Chunked oversized responses cannot replace a working pack.
- [x] **O50 / P2 — Bounded web previews and prefetch.** Existing TTL/LRU policy
      now participates in shared cancellable priority scheduling. Four lazy
      producers visit at most 512 links per prefetch pass; visible consumers share
      existing work. Existing URL safety checks remain in the native adapter.
- [x] **O51 / P2 — Account-aware avatar retention and refresh.** Entry/byte LRU
      (128/8 MiB), five-minute success/one-minute missing-avatar TTL, focus and
      mounted expiry refresh, failed-request retry and production invalidation
      after profile/account/disconnect changes.

### Structured Editors, History And Export

Implemented **2026-10-21**, Performance Batch 8. See
[ownership, budgets, evidence and outstanding native acceptance](../desktop/structured-editors-history-export-performance.md).

- [x] **O52 / P1 — Structured serialization checkpoints.** Sheet, ink, deck and
      logic sessions coalesce immutable roots at 100 ms checkpoints; save, remote
      comparison and leave barriers materialize the latest content. Logic drag
      geometry stays transient until gesture end or a save barrier. Weakly cached
      JSON projections avoid sheet/logic stringify/parse round trips. Exact base,
      hash and conflict semantics remain; validation still runs synchronously.
- [x] **O53 / P1 — Revisioned formula deltas.** Initial/structural seed, changed
      inputs/removals, acknowledged revisions and changed outputs cross IPC.
      Missing/evicted baselines recover through one full seed. Unchanged cell
      inputs and worksheet address maps retain identity.
- [x] **O54 / P1 — Independent native formula owners.** Short registry locks,
      per-runtime locks, sixteen retained runtimes and two admitted evaluations.
      Release cancels active work and retires queued owners; engine destruction
      happens outside the registry lock.
- [x] **O55 / P2 — Obsolete-work cancellation and volatile refresh.** One active
      and latest pending evaluation per workbook; superseding/disposal signals
      native cancellation. Manual recalculation and visible-document sixty-second
      volatile refresh preserve dispatch-time time/random semantics and timeouts.
- [x] **O56 / P1 — Byte-estimated sheet undo.** Refcounted immutable DAG history
      charges shared objects once, bounded by 24 MiB and 100 steps across undo/redo.
      Remote/path boundaries clear history; oversized snapshots are not retained.
- [x] **O57 / P2 — Structural address indexes and bulk replacement.** Weakly
      cached stable-ID row/column maps serve formulas, names, validation and search.
      Replace-all scans populated cells and commits through one bulk operation.
- [x] **O58 / P2 — Sparse sheet auxiliary work.** Existing virtualization retained;
      conditional-format aggregates survive scrolling/selection while values and
      rules invalidate them. Prefix offsets bound overlay rectangle calculation.
      Charts remain demand-rendered in the analysis dialog.
- [x] **O59 / P1 — Visibility/byte-bounded canvas previews.** At most 24 nearby
      unique cards and 32 MiB estimated payload/decoded cost; obsolete leases abort
      and offscreen/removed node payload references retire. Oversized results use
      a stub. Actual browser/GPU retention remains O70 acceptance.
- [x] **O60 / P2 — Gesture-aware graph derivation.** Stable semantic projections
      keep logic evaluation independent of selection/position. Cached immutable
      node conversion and dependency-keyed edge geometry recompute affected work;
      routing sibling grouping and final serialization retain necessary scans.
- [x] **O61 / P2 — Incremental ink spatial updates.** Weak scene-change hints
      update affected bounds/tiles and preserve paint ordering. Unknown remote,
      reorder and layer paths keep conservative full-diff fallback; existing tile
      budgets and rendering architecture remain authoritative.
- [x] **O62 / P2 — Shared deck media on demand.** Mounted slide/rail/presenter
      renderers acquire independent leases; last release retires assets. Account,
      vault, revision and asset identity scope a 64-entry/96 MiB estimated cache.
      Native 1920-pixel thumbnails serve display; export/print read originals under
      a separate preparation budget.
- [x] **O63 / P2 — Transferable bounded exports.** Ink/PPTX workers receive owned
      UTF-8 snapshots and binary assets, transferring buffers rather than cloning
      object trees. Two concurrent workers, bounded snapshots/assets/preparation
      and raw binary native output with atomic publication. Cancel/error/complete
      release ownership. Worker-local parsing/encoding still allocates memory.

### Native Storage, Collaboration, Calendar And Background Work

- [x] **O64 / P1 — Replace quadratic native text merge and add resource budgets.**
      **Status: Implemented, 2026-10-20 — bounded fallback policy.**
      Native saves and server live/REST reconciliation share
      [text_merge.rs](../../crates/collab-live/src/text_merge.rs). Borrowed lines
      and trimmed unchanged boundaries avoid whole-document tables for sparse
      edits. The remaining LCS table is capped at 4 MiB, with combined input,
      line-count, cell-work and comparison-byte budgets. Oversized/overlapping
      edits return a conflict without writing; expected-hash checks remain.
      The former 10k-by-10k table's analytical ~763 MiB allocation is no longer
      allowed. Tests cover 10k sparse/unrelated inputs and actual native conflict
      preservation. End-to-end native latency/RSS and encrypted-vault acceptance
      remain part of the measurement matrix, not claimed speedups.
      Implemented **2026-10-21**, Performance Batch 9. See
      [ownership, budgets, diagnostics and release qualification](../desktop/native-background-performance.md).

- [x] **O65 / P1 — Bounded live-socket backpressure and recovery.** Native
      queues retain at most 128 frames/roughly 32 MiB including in-flight bytes,
      with sixteen connections and the existing sixteen MiB update limit.
      Frontend IPC admission is bounded by 32 submissions/64 MiB estimated bytes.
      Single-client awareness coalesces; ephemeral overload may drop awareness.
      Durable rejection/stalled sends disconnect, then Yjs state vectors replay
      retained edits. Early closure cannot resurrect a connection.
- [x] **O66 / P2 — Incremental CRDT persistence.** State-vector deltas append to
      independently encrypted, fsynced journals; full checkpoints compact at
      64 deltas/about one MiB or durable leave barriers. Per-document locks give
      coherent generations. Compaction publishes before retiring deltas; torn
      tails recover, unreadable generations are preserved and failed writes do
      not acknowledge vectors. No-op tracked JSON skips data/integrity rewrites.
      Existing pending-operation schema and quarantine rules remain intact.
- [x] **O67 / P2 — Indexed and single-flight calendar reconciliation.** Local
      board reads use immutable tree/content revisions and bounded source caches;
      unchanged projections skip native replacement/range reload. Deletion,
      unreadable-source retention, publication retry and events arriving in flight
      reconcile through one trailing pass. Privacy cleanup retires plaintext caches;
      hosted origin flights share overlapping profile/server/account requests.
- [x] **O68 / P2 — Shared polling and native deadline wakeups.** One visible/
      online clock serves chat/inbox/teams/members/presence/PDF/calendar consumers,
      with per-callback single flight, rejection backoff and event invalidation.
      Native reminders use deadlines/settings/status wakeups with a minute-scale
      inventory bound; denied permission does not spin on overdue notifications.
      Inventory/reconnect throttling remains intact.
- [x] **O69 / P2 — Result and staging lifecycle bounds.** Circuit terminal results
      have sixteen MiB/job, sixty-four MiB aggregate estimates, two-minute idle
      expiry and explicit release. Over-budget results retire arrays and fail
      visibly. Private drag directories use locked process leases, 256 MiB/32
      ownership bounds, delayed-reader grace and bounded restart/periodic GC that
      preserves active leases and skips symlinks.
- [x] **O70 / P1 — Maintained diagnostics and release qualification gate.** Opt-in
      bounded native/IPC/interaction/poll timing, process RSS/high-water counters,
      scenario capture and native report export. A checked-in budget command gates
      p95 startup/interaction, idle calls/wakes and soak retention. Desktop tags
      require version-matched Linux/Windows/macOS reports before release builds;
      missing evidence fails. Unit fixtures are not installed certification.
      Main-process counters exclude separate webview/worker/GPU processes: the
      measurement matrix below remains required native release acceptance.

## Existing Optimizations And Safety Boundaries To Preserve

The review does not recommend undoing work already present:

- HTTP clients in [hosted_client](../../src-tauri/src/hosted_client.rs) are already
  shared/static; do not claim a fresh TLS client is built for every hosted request.
- [useServerAutoReconnect](../../src/lib/useServerAutoReconnect.ts) already has
  per-server in-flight guards and slower connected inventory refresh, rather than
  a full inventory every 15 seconds.
- PDF page cache has a bounded 12-entry LRU with object-URL revocation; the
  remaining issue is byte/lifecycle coverage, not absence of any eviction.
- [documentPreview](../../src/lib/documentPreview.ts) deduplicates in-flight work
  and relies on versioned native/server caches instead of retaining completed
  previews in an unbounded map. Original internal previews already exist.
- Ink tile surfaces have byte accounting, eviction and disposal; ink/deck undo
  uses operation inverses. Sheet viewport rendering and incremental native
  formula recalculation already exist.
- Mermaid and Three.js are loaded separately/on demand; their artifact sizes do
  not prove eager startup execution. Math3D explicitly disposes geometry/materials.
- Native formula/circuit jobs have count/time limits; conversion inputs and
  parser limits exist. Audit their aggregate cost instead of deleting validation.
- Native chat outbox is encrypted and bounded; message history/read cursors,
  expected account identity and authorization-aware offline fallbacks must remain.
- Encryption, source revisions, expected-hash conflicts, readonly roles and
  no-fallback-after-permission-denial are constraints on every cache/speed change.
- Native OCR temp files/directories use RAII cleanup, unlike the separately
  identified native-drag staging. Preserve this distinction.
- Linux WebKitGTK acceleration defaults to OnDemand and canvas DPR is bounded.
  Do not switch all platforms to forced acceleration to hide a measured regression.

## Suggested Delivery Order

The original priority grouping follows. **O01–O70 are now
implemented (O48 superseded)**; use the checkboxes and
[open development work](../plans/open-development-work.md) for current scope.
All implementation categories are complete; the next step is the native release
measurement/acceptance matrix, including the new O70 qualification reports.

1. **Correctness first:** B01 autosave/session ownership; B02 Unicode; B06 staging
   collisions; B04 PDF lifetimes; B03/B05 stale requests/listeners. Validate the
   remaining bug/cache cases and R01–R03 early because they can affect data.
2. **Baseline + largest bounded-cost changes:** O70 telemetry; O64 merge budget;
   O01/O04 startup graph and PDF workers; O17–O19 incremental index/search;
   O24/O26 file tree and kanban scans; O37/O40 binary assets and thumbnails.
3. **Long-session memory:** O11–O15 view/session retention; O38/O42–O51 cache/OCR
   ownership; O56/O59/O62 history and visible assets; O65/O66 backpressure/persistence.
4. **Interaction/idle refinements:** Markdown/math, formula IPC/locking, canvas/
   ink/graph work, calendar/polling and measured P3 asset changes.

Deliver separate PRs by concern. An implementation plan should give each chosen
batch an owner, fixtures, baselines and acceptance budgets; this audit alone does
not approve a backend schema change or redefine any unfinished product plan.

## Required Native Measurement Matrix

Use synthetic, disposable local vaults and test accounts; never benchmark by
rewriting a user's documents or truncating a real server database.

| Scenario                                                               | Capture                                                           | Correctness gate                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Cold/warm launch, vault picker, locked vault, restored workspace       | Time to usable UI, evaluated JS, native/WebView RSS, CPU/IO       | Theme/restore/auth state correct                                 |
| 1k/10k/50k note vaults; one edit, rename, burst writes, Unicode search | Files read/decrypted, queue/lock time, p50/p95 query, DOM rows    | Scoped latest results, correct backlinks, no Unicode failures    |
| Type then switch/close/quit within debounce; save failure/conflict     | Write/draft lifecycle and reopen state                            | No unsaved data loss or wrong-file acknowledgement               |
| 100-page PDFs, large images, corrupt/slow PDF; repeated open-close     | Worker count, decoded/backing pixels, heap/RSS slope, first page  | Bounded release, annotations/conflicts preserved                 |
| Large sheets with formulas/rules/charts, paste/undo, two grid panes    | IPC bytes, formula build/evaluation, history bytes, scroll frames | Same values, protections, conflict and remote-history boundaries |
| Large ink/deck/canvas/logic scenes and multiple plots                  | Index/render/serialize time, GPU bytes, idle CPU, media cache     | No missing geometry/media; smooth, equivalent editing            |
| Slow socket/offline/reconnect/full replica/export                      | Queue bytes, network calls, crypto/disk work, cancellation        | Durable edits, no duplicate replay or authorization bypass       |
| Tray/hidden app, calendar reminders, many servers/teams                | Idle wakeups/power, HTTP cadence, stores/ranges read              | Timely notifications and correct lifecycle recovery              |
| Hundreds of hover/link/avatar/OCR requests then lock/logout            | Cache bytes, TTL/GC, cancellation, retained plaintext policy      | Identity/permission scoped cache access and retention            |

Use release builds and record hardware, display scale, runtime, corpus sizes,
cache state and competing workloads. Maintain assertions for byte/job bounds;
set timing budgets only after native baselines. Sandbox restrictions and saturated
parallel test workers can distort process/timing results, so reproduce outside
that boundary before calling a measured slowdown a product regression.

## Verification Performed For This Audit

- Fresh production Vite build and artifact inventory: passed; chunk warnings
  retained and recorded above.
- Four temporary observational Vitest probes: controller disposal, stale search,
  canvas ceiling and late native listener cleanup.
- A temporary test using the existing real NoteView harness: local edit immediately
  unmounted, no save, old content reopened (one selected test; other copied tests
  intentionally skipped).
- Standalone Rust probe extracted the current `make_excerpt` helper verbatim;
  observed Unicode panic and demonstrated `.with_extension("tmp")` aliasing.
- Existing controller, rendering, PDF preview and NoteView regression suites
  passed; TypeScript, audit link/ID checks and documentation formatting passed.
  No native application/GPU profiling was claimed.

Temporary observational tests are removed from application source; they should
be replaced with tests for the desired behavior in the actual fix PRs. The raw
probe/build logs are local review artifacts, not shipped implementation code.
A full workspace/mobile/server CI sweep is appropriate for implementation PRs;
this documentation-only audit does not imply those unaffected products received
a fresh functional sign-off.
