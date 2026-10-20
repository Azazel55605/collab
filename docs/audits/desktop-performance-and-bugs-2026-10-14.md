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
      entries regenerate; source/renderer checks remain. Native storage QA and disk
      retention (O44) remain open.
- [x] **R05:** Bounded serial OCR queue owns initialization, language transitions,
      per-worker progress and idle termination. Failures release ownership and do not
      poison later jobs. Native OCR process limits remain O46.
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

Checklist reconciled **2026-10-20**: **O01–O36, O39, O47 and O64 are implemented;
O48 is superseded by R08**. These 40 implementation items are checked off; the
other **30 entries remain open or partial**. Native release acceptance is tracked
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
      no OCR asset request occurred before recognition. Broad native OCR limits
      and worker-memory soak remain O46/O70 work.
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

- [ ] **O37 / P1 — Replace large asset data URLs over JSON IPC with scoped binary transport.**
      **Status: Open.**
      [files.rs](../../src-tauri/src/commands/files.rs), hosted asset commands and
      [vaultClient](../../src/lib/vaultClient.ts) read/encode whole files; PDF paths
      decode into another byte array. Use an authenticated vault-scoped stream/
      protocol or binary buffer bridge with encryption/range policy intact. Measure
      transfer copies, peak RSS/heap and large-PDF first-page latency.
- [ ] **O38 / P1 — Share one bounded preview scheduler across every consumer.**
      **Status: Partial — bounded category queues and revision caches implemented; universal shared-job ownership/priority remains.**
      [pdfPreview](../../src/lib/pdfPreview.ts), canvas preview rendering and hover
      previews have separate execution paths. Deduplicate by account/vault/file/revision,
      prioritize visible work, cap concurrency and cancel obsolete work. Verify no
      authorization bypass and fair progress across simultaneous grid panes.
- [x] **O39 / P2 — Reuse the standard PDF preview service in canvas cards.**
      **Status: Implemented — shared versioned PDF-card pipeline.**
      [useCanvasPreviews](../../src/components/canvas/useCanvasPreviews.ts) reads a PDF
      and calls its separate 520px renderer instead of the shared persistent helper.
      Share versioned preview results with an explicit size variant. Measure repeated
      hovers/card loads; fix B04/B07 first.
- [ ] **O40 / P1 — Avoid full-resolution image reads/decodes for tiny hover previews.**
      **Status: Open.**
      [FileTreeHoverPreviewPopover](../../src/components/previews/FileTreeHoverPreviewPopover.tsx)
      reads the original image data URL. Add bounded thumbnail generation/delivery
      with decoder limits and correct revision/authentication. Measure a 40MP photo
      hover vs thumbnail; server rendering remains a separate deployment decision.
- [ ] **O41 / P2 — Make hover cancellation stop work, not just ignore its result.**
      **Status: Open.**
      The same component sets `cancelled`, but backend read/render work continues.
      Reference-count shared jobs and cancel when there are no consumers. Test rapid
      pointer movement without cancelling a preview still used by another pane.
- [ ] **O42 / P2 — Give PDF caches byte budgets and a vault/account lifecycle.**
      **Status: Partial — PDF source cache has entry/byte limits; total decoded/GPU budgets and lifecycle acceptance remain.**
      [PdfView](../../src/views/PdfView.tsx) has a 12-entry PNG object-URL LRU;
      [pdfPreview](../../src/lib/pdfPreview.ts) bounds source-string length, not all
      output/decoded memory. Account for actual resources, clear sensitive entries on
      close/lock/logout as policy requires, and preserve eviction revocation.
- [ ] **O43 / P2 — Make the global PDF render queue cancellable and prioritized.**
      **Status: Open.**
      [pdfRenderQueue](../../src/views/pdfRenderQueue.ts) serializes jobs in a promise
      chain. Single execution is useful, but obsolete queued jobs still occupy their
      closures and delay current pages. Add latest/visibility scheduling and fairness;
      test repeated zoom/page changes in multiple PDFs.
- [ ] **O44 / P2 — Bound local preview-cache disk retention.**
      **Status: Open.**
      [sidecars.rs](../../src-tauri/src/commands/files/sidecars.rs) stores per-path cache
      files without a global byte quota/age GC. Add disposable-cache accounting and
      rename/delete cleanup, preserving encrypted storage. Measure growth across
      thousands of visited files; never GC authoritative sidecars as thumbnails.
- [ ] **O45 / P1 — Move image filters/OCR preprocessing off the main thread.**
      **Status: Open.**
      [ocr](../../src/lib/ocr.ts) allocates full-size canvases and loops over every RGBA
      pixel; [ImageView](../../src/views/ImageView.tsx) has full-resolution image edit
      paths. Use bounded downsampling where valid, workers/tiles and cancellation.
      Verify OCR accuracy, original export fidelity and pixel/byte ceilings.
- [ ] **O46 / P1 — Bound native OCR subprocess time and job concurrency.**
      **Status: Open.**
      [ocr.rs](../../src-tauri/src/commands/ocr.rs) uses blocking `Command::output()`
      within spawn_blocking. Add a job semaphore, cancellation, process timeout and
      bounded output handling. Test hung/huge OCR jobs and navigation away; preserve
      the existing RAII temp-file/temp-dir cleanup.
- [x] **O47 / P2 — Serialize/single-flight WASM OCR workers safely.**
      **Status: Implemented — one worker owns serialized recognition, language changes and progress; at most eight active/queued jobs; idle termination waits for the queue. Native peak-WASM memory/real-engine soak remains acceptance.**
      [ocr](../../src/lib/ocr.ts) already has a three-minute idle shutdown, but R05's
      concurrent job/init policy is missing. Use an explicit worker owner/job queue
      with per-job progress and language transitions. Measure peak WASM memory and
      idle release; do not just terminate a worker serving another request.
- [x] **O48 / P2 — Bound and reuse OCR result storage connections.**
      **Status: Superseded by R08 memory-only retention:** no result-storage
      connections remain; the in-memory LRU has entry/byte/age limits. The
      historical evidence and original proposal follow.
      [ocrCache](../../src/lib/ocrCache.ts) opens/closes IndexedDB for every operation,
      has a versioned key but no age/size eviction, and retains older-version records.
      Add bounded GC and a version-change-safe shared connection. Define R08 retention
      first; test quota errors, upgrade and corrupted entries.
- [ ] **O49 / P2 — Stream language downloads under a hard size ceiling.**
      **Status: Open.**
      [ocr.rs](../../src-tauri/src/commands/ocr.rs), `install_ocr_language_pack`, checks
      Content-Length but then collects the full body before the actual byte check.
      Use bounded chunk reads with timeout/cancellation and atomic publish. Test
      chunked oversized responses and missing headers; network/VPN certificate
      failures are not evidence of a product regression.
- [ ] **O50 / P2 — Bound web-preview lifetime and prefetch concurrency.**
      **Status: Partial — web-preview TTL/LRU and concurrency limits implemented; cancellation/visible priority remain.**
      [webPreviewCache](../../src/lib/webPreviewCache.ts) retains successful/error
      entries indefinitely; `prefetchWebPreviews` starts each distinct URL without a
      shared concurrency budget. Add TTL/LRU, negative-cache retry and cancellation/
      visible priority. Measure a note with hundreds of links; preserve URL safety.
- [ ] **O51 / P2 — Bound avatar memory and refresh stale mounted consumers.**
      **Status: Open.**
      [userAvatars](../../src/lib/userAvatars.ts) stores data-URL promises by server/user/
      version. TTL governs a future lookup, not eviction of old keys or automatic
      refresh of a mounted hook; `clearUserAvatars` has no production caller in this
      baseline. Add byte/entry eviction, account-aware cleanup and refresh policy.
      Test profile changes, many senders, logout and absent-avatar caching.

### Structured Editors, History And Export

- [ ] **O52 / P1 — Avoid serializing whole structured documents for every gesture update.**
      **Status: Partial — canvas gestures defer serialization; logic/ink/deck/sheet work remains.**
      `markLocalChange` in [documentSessionController](../../src/lib/documentSessionController.ts)
      immediately serializes; logic, ink, deck and sheets feed document changes into
      it. Track revisions/operations and serialize at safe checkpoints. Retain exact
      conflict/base content semantics; measure drag/stroke workloads before/after.
- [ ] **O53 / P1 — Send incremental formula requests/results over IPC.**
      **Status: Open.**
      [useSheetFormulaEngine](../../src/lib/sheet/useSheetFormulaEngine.ts) rebuilds
      positions, expands names and sends all populated cells, despite the native
      engine's incremental recalculation. Send revision/delta inputs and changed
      outputs with a full-seed recovery path. Compare payload bytes, build time and
      correctness for large sheets; do not replace the formula engine.
- [ ] **O54 / P1 — Separate the formula registry lock from per-runtime evaluation.**
      **Status: Open.**
      [sheet.rs](../../src-tauri/src/commands/sheet.rs) holds one registry mutex across
      build/update/evaluate/output. Grid sheet runtimes can block each other and
      release waits behind computation. Use short map locking plus per-runtime owners,
      a global job budget and cancellation. Test independent runtimes and eviction.
- [ ] **O55 / P2 — Coalesce obsolete formula work and preserve volatile semantics.**
      **Status: Partial — one active/latest trailing request per workbook; superseded pending inputs and stale results are discarded, and volatile time is bound at dispatch. Manual/periodic volatile recalculation, cancellation of already-running native work and global native scheduling remain open.**
      The formula hook's 80ms debounce and sequence guard discard stale responses but
      do not cancel native requests already submitted. Add newest-job scheduling and
      explicit recalculation for time/random functions. Test rapid edits and R06;
      maintain evaluation budgets and deterministic testing inputs.
- [ ] **O56 / P1 — Bound sheet undo by memory as well as step count.**
      **Status: Open.**
      [SheetView](../../src/views/SheetView.tsx) stores prior whole workbook roots.
      Structural sharing helps, but each edited cell dictionary/large structural
      mutation remains retained. Use operation/inverse history or a byte-estimated
      budget with checkpoints. Test large paste, structural edits and remote boundaries.
- [ ] **O57 / P2 — Reduce repeated row/column/range indexing.**
      **Status: Open.**
      [sheet search](../../src/lib/sheet/search.ts), formula request construction and
      [operations](../../src/lib/sheet/operations.ts) repeatedly build/find positions.
      Maintain indexes by worksheet structural revision. Benchmark replace-all,
      selection, validation and named-range expansion without breaking stable IDs.
- [ ] **O58 / P2 — Keep sheet rendering sparse and measure auxiliary overlays.**
      **Status: Open.**
      [SheetView](../../src/views/SheetView.tsx) already uses viewport helpers; optimize
      conditional formats, dependency highlights, chart overlays and hit testing rather
      than adding redundant generic virtualization. Measure visible-cell work and
      scrolling with formulas/rules/charts, not only an empty grid.
- [ ] **O59 / P1 — Bound canvas card assets/previews by visibility and bytes.**
      **Status: Partial — nearby canvas hydration, obsolete-result rejection and bounded retained Markdown implemented; full asset-byte/heap acceptance remains.**
      [useCanvasPreviews](../../src/components/canvas/useCanvasPreviews.ts) retains
      preview strings/content in state and fans updates across matching nodes. Load
      visible cards, retire removed/revision-obsolete entries and share decoded assets.
      Test large boards, pan-away/pan-back and node deletion heap recovery.
- [ ] **O60 / P2 — Avoid repeated full node/edge conversions and scans during gestures.**
      **Status: Partial — canvas gesture conversion reduced; broader derived-map and logic work remains.**
      [CanvasPage](../../src/views/CanvasPage.tsx) and
      [LogicDiagramView](../../src/views/LogicDiagramView.tsx) rebuild maps, normalize
      nodes and serialize affected graphs. Keep geometry transient and commit semantic
      changes at gesture boundaries, with incremental derived maps. Profile large
      drag/selection/rotation interactions; preserve collaboration operations.
- [ ] **O61 / P2 — Incrementally maintain ink spatial data and tile invalidation.**
      **Status: Open.**
      [InkCanvas](../../src/components/ink/InkCanvas.tsx) rebuilds spatial indexes from
      page identity; [renderer](../../src/lib/ink/renderer.ts) has useful byte-bounded
      tiles and dirty rectangles. Update the affected objects/layers incrementally and
      profile index/outliner/eviction cost before changing tile architecture.
- [ ] **O62 / P2 — Load deck media for visible/nearby slides with bounded sharing.**
      **Status: Open.**
      [DeckView](../../src/views/DeckView.tsx), `useDeckAssets`, starts all collected
      image reads and keeps data URLs for the view lifetime. Use an asset owner with
      concurrency, byte budget, removed/versioned-entry pruning and visible-slide
      prefetch. Test missing media, export requirements and presenter transitions.
- [ ] **O63 / P2 — Reduce export-worker structured-clone copies.**
      **Status: Open.**
      [ink exportClient](../../src/lib/ink/exportClient.ts) and
      [PPTX exportClient](../../src/lib/deck/pptx/exportClient.ts) post full document/
      asset records. Transfer binary buffers where ownership permits, stage large
      output outside the UI heap and budget concurrent exports. Existing termination
      on cancel/completion must remain; measure peak main + worker memory.

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
- [ ] **O65 / P1 — Add bounded native live-socket backpressure.**
      **Status: Open.**
      [live_ws.rs](../../src-tauri/src/commands/live_ws.rs) uses an unbounded outbound
      channel. A stalled socket can retain arbitrary queued frames. Bound bytes and
      messages, coalesce replaceable awareness and preserve/replay durable document
      updates under explicit semantics. Test slow send, disconnect and reconnect;
      silently dropping arbitrary CRDT frames is not an acceptable memory fix.
- [ ] **O66 / P2 — Reduce full-state replica/CRDT persistence churn.**
      **Status: Partial — native live checkpoints serialize/coalesce; full-state replica/CRDT churn remains.**
      [liveDocumentSession](../../src/lib/liveDocumentSession.ts) periodically encodes
      full Yjs state; [ReplicaStore](../../crates/collab-replica/src/store.rs) reads/
      writes encrypted JSON/document payloads. Measure state growth, manifest parsing,
      queue rewrites and crypto copies; introduce delta/checkpoint storage only with
      durability, quarantine and account-scoping tests intact.
- [ ] **O67 / P2 — Incrementalize and single-flight calendar projection/sync.**
      **Status: Open.**
      [CalendarSyncCoordinator](../../src/components/layout/CalendarSyncCoordinator.tsx)
      relists/reads local kanbans, replaces generated items and reloads a range on
      refresh; focus/online/timer triggers can overlap. Reuse the attachment/revision
      index and coalesce per-profile/origin jobs. Test assignments, deletions, mirrors
      and events arriving during a sync; preserve reminder delivery.
- [ ] **O68 / P2 — Consolidate desktop polling and background wakeups.**
      **Status: Partial — replica synchronization coalesced; consolidated polling/wakeup policy remains.**
      [collabTransport](../../src/lib/collabTransport.ts),
      [useHostedChat](../../src/lib/useHostedChat.ts), team/inbox/member surfaces,
      PDF sidecar polling and [background_lifecycle](../../src-tauri/src/background_lifecycle.rs)
      use independent cadences. The latter wakes every two seconds even though some
      decisions are minute-scale. Coordinate visibility/connection-aware scheduling,
      backoff and event-driven invalidation. Count idle wakeups/network calls and test
      tray/notification/reconnect correctness. Keep existing inventory throttling.
- [ ] **O69 / P2 — Bound completed simulation resources and native staging retention.**
      **Status: Open.**
      [circuit.rs](../../src-tauri/src/commands/circuit.rs) caps job counts and chunk
      sizes but retained jobs may hold large results. Add aggregate retained-byte/TTL
      policy and explicit release. Separately, [files.rs](../../src-tauri/src/commands/files.rs)
      stages plaintext native-drag exports in process-named temp paths without a
      matching cleanup here. Define lifecycle/scavenging without deleting active
      transfers. Test circuit navigation/cancel and stale staging after restart.
- [ ] **O70 / P1 — Make performance measurements a maintained release gate.**
      **Status: Partial — opt-in synthetic text-merge benchmark added; native release gate open.**
      Run `cargo run --release -p collab-live --example text_merge_benchmark` for
      1k/10k sparse and unrelated line fixtures, exact-result assertions and CSV
      p50/p95 timings over 25 runs. This measures the portable core only.
      Startup batch also adds reproducible static-import/worker artifact checks
      under O09; native release telemetry and timing gates are still open.
      Existing fixture budgets and [rendering](../../src/lib/rendering.ts) are useful,
      but build warnings/test durations are not native performance telemetry. Add
      cold/warm startup, idle power/network, p95 interaction, heap/RSS/worker/GPU,
      cache/disk and open-close soak fixtures. Correlate IPC job/bytes/lock timings
      with UI traces; report Linux WebKitGTK, Windows WebView2 and macOS WebKit
      separately. Keep instrumentation disabled/bounded outside explicit diagnostics.

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

The original priority grouping follows. **O01–O36, O39/O47 and O64 are now
implemented (O48 superseded)**; use the checkboxes and
[open development work](../plans/open-development-work.md) for current scope.
The next category is **Previews, PDF, Images And OCR (O37–O41)**; O39 is already implemented.

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
