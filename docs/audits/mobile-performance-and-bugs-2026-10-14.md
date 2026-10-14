# Android Performance, Memory And Bug Audit

Reviewed: **2026-10-14**. Source baseline:
`c9fbdb7897a603eccee47f2534cda83936eaba98` (`main`, mobile `0.8.7`, versionCode
`8007`). This is an audit/backlog; application behavior has not been changed.

The inventory contains **69 entries: 9 bugs, 10 investigation items and 50
optimization opportunities**. Scope includes the mobile React shell/screens,
shared document/chat components, Tauri adapters, hosted replicas, native
background work, notifications, widgets, Android storage and build inputs.
Independent local vaults and full editor parity remain planned in the
[full mobile app overhaul](../plans/mobile-full-app-plan.md); they are not
regressions in the existing companion. iOS is outside this Android audit.

This is a comprehensive source-backed first pass, not proof that no other issue
exists. Discovery inventoried **96 TS/TSX files and 35,612 lines**, including
tests, under `apps/mobile-android/src`, plus relevant shared/Rust/Kotlin paths.
Lifecycle, save/load, identity, large-document, transfer and background boundaries
received manual review. Physical-device profiling must establish actual CPU,
heap, native memory, frame time, thermal and battery costs.

## Reported Regression Follow-Up

The [2026-10-14 reported-issue reconciliation](./reported-regressions-2026-10-14.md)
tracks all 13 subsequent user reports against these inventories, including PDF
state reset, cache-first reads/automatic freshness, slow/basic previews, component
consistency, drop targeting, legacy chat/sidebar behavior, Kanban scrolling,
mobile drawing and canvas performance/save failures. Existing IDs/counts remain
unchanged; the supplement separates reported symptoms from verified mechanisms
and adds acceptance targets for gaps. Fixes and platform reproduction remain
outstanding.

## Evidence And Baseline

**Reproduced** means a focused Vitest/jsdom probe exercised current helpers,
store actions or components with controlled native responses. **Source-confirmed**
means a concrete code path establishes the behavior, without a quantified
production incidence. **Investigation** requires additional lifecycle, platform
or product-contract evidence. **Opportunity** is a proposed measurable
improvement, not an already established speedup.

| Check                                                                                                | Result                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Mobile's own Vitest config, one worker                                                               | **256/256 passed**, 39 files                                           |
| Mobile TypeScript, `tsc --noEmit -p apps/mobile-android/tsconfig.json`                               | Passed                                                                 |
| Mobile Vite production frontend build                                                                | Passed; reported **1.75 seconds**                                      |
| Temporary observational probes                                                                       | **5/5 passed**; retained outside the repository, removed before commit |
| APK/AAB, Android JVM/instrumentation, physical device, native memory/battery and full Rust workspace | Not run for this documentation audit                                   |

The frontend build emitted **95 files totaling 15,823,334 bytes**. The eager JS
entry was **4,489,830 bytes**, or 1,377,233 bytes with offline Python gzip; CSS
was **213,834 bytes**, or 46,370 bytes with the same compression. Other emitted
assets include a 2.40 MB PDF worker, 5.49 MB Mermaid script, 973 KB Nerd Font and
723 KB Three.js chunk. Emitted assets are not evidence that all scripts execute
or fonts load at startup. Android packages local frontend assets, so gzip sizes
are comparison metrics rather than mobile network-transfer measurements.
Frontend size is not APK size or runtime RSS; build time is not cold startup.

The build reports large chunks. The test config also reports a future native
config-loader incompatibility with `__dirname`; the current build/tests pass.
Direct local CLIs were used, equivalent to the frontend checks in
[mobile-build-frontend.mjs](../../scripts/mobile-build-frontend.mjs).

## Bugs

P1 findings should precede general tuning; P2 findings belong in the initial
correctness/platform batch. Priority is based on consequence, not a measured
rate of occurrence.

| ID   | Priority / evidence                                            | Finding and source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fix acceptance                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MB01 | P1 / reproduced                                                | **Late vault loads overwrite the current vault.** `loadFiles` captures a selection, then publishes results/error/busy state without verifying it remains current. A probe selected A then B, resolved B first, then A: selection remained B but A's files replaced B's list. Replica fallback has the same publication gap. [Store][store].                                                                                                                                                                                            | Key loads by server/vault/account and request generation. Delayed A may not change B's rows, errors, cache flags or busy indicator. Cover clear/disconnect and background reloads too.                                                                      |
| MB02 | P1 / reproduced for ink; source-confirmed for sheet            | **Autosave retries permanent failures without backoff.** InkScreen and SheetScreen call `flushSave` again whenever the document still differs from saved content, even after the catch handles a conflict/permission/validation error. An ink probe rejected unchanged writes with “Revision conflict” and observed four immediate attempts, holding the fourth to bound the probe. The same loop can continue after unmount. [Ink][ink], [Sheet][sheet].                                                                              | A failed revision is blocked with explicit recovery; unchanged failed content is not retried in a tight loop. Distinguish a newer queued edit after success from failure. Verify offline queue failure and unmount as well as 409/403.                      |
| MB03 | P2 / reproduced                                                | **Picker URI controls binary-versus-document routing.** `pickAndUploadFiles` classifies the last URI segment before native `DISPLAY_NAME` lookup. A `content://provider/document/12345` whose display name is `photo.png` takes the text-document path. The probe observed a document creation request with decoded image bytes instead of asset upload; actual server rejection/acceptance depends on payload validity. An upload-only account can be wrongly denied first. [Transfer][transfer], [native file reader][native-files]. | Resolve provider metadata before deciding route, without reading the full body just to get the name. Test opaque URI PNG/PDF, document URIs, cloud providers and capability-specific permissions.                                                           |
| MB04 | P1 / source-confirmed                                          | **Manual-save note edits disappear on navigation.** When no live session exists, content is component state and saving is explicit. The Back button calls `closeSheet`; store Back clears the active sheet and tab changes unmount FilesScreen. No dirty prompt or durable draft/flush covers these exits. [Note][note], [Store][store], [Shell][shell].                                                                                                                                                                               | Edit a REST/offline note and use header Back, hardware Back, sidebar/tab navigation and exit: save/keep draft or explicit discard is required. Do not claim live-cache durability covers this fallback path.                                                |
| MB05 | P2 / source-confirmed                                          | **Presentation discovery polls while hidden and overlaps.** The shell's interval always calls `refresh`; visibility is checked only for focus/visibility events. Every connected server is queried every three seconds, even when no show exists, with no single-flight guard. [Shell][shell], [active presentation helper][presentation].                                                                                                                                                                                             | Hidden/suspended WebView does not initiate discovery work; foreground resumes once. Slow discovery stays bounded and cannot publish an older result over a newer one.                                                                                       |
| MB06 | P2 / reproduced, conditional identity collision                | **Requested server is ignored for an already-open matching vault ID.** `openVaultTarget` finds the requested server but `alreadyOpen` compares only vault ID. A probe with the same vault ID on two servers requested B and returned “opened” while retaining A's selection. This does not demonstrate bypassing server permissions. [Store][store].                                                                                                                                                                                   | Use server/account/vault identity consistently. Test cloned/restored identifiers across servers and ambiguous destinations lacking provenance; never select an arbitrary match.                                                                             |
| MB07 | P2 / source-confirmed                                          | **Failed downloads leave a partial/truncated destination.** Native entry/export download commands open with `truncate(true)` and write response chunks directly to the chosen destination. A later network/write error returns without a staging/commit or cleanup path. Existing content can already be overwritten. [Native gateway][gateway].                                                                                                                                                                                       | Test failure after several chunks, ENOSPC and provider revocation. Use safe staging/commit where supported; for SAF providers explain partial state and cleanup semantics without deleting a pre-existing document blindly. Streaming itself should remain. |
| MB08 | P2 / reproduced for busy dismissal; source-confirmed for focus | **Busy confirmation still dismisses from the backdrop.** ConfirmSheet disables buttons when busy but its backdrop still calls `onCancel`. A probe confirmed cancellation while Cancel was disabled. It also lacks modal focus isolation/restoration. [UI][ui].                                                                                                                                                                                                                                                                         | Pending operations obey one consistent dismissal policy; hardware/backdrop/key actions agree. Validate topmost modal behavior, TalkBack and external keyboard focus. Closing UI must not falsely claim cancellation of server work.                         |
| MB09 | P2 / source-confirmed                                          | **Background response limit is checked after full buffering for unknown length.** `request_bytes` rejects a declared oversized body before reading, but otherwise awaits `response.bytes()` then checks length. A chunked/incorrectly declared response can allocate beyond the intended bound before rejection. Accepted responses are then copied with `to_vec`; the asset cap is 512 MiB. [Native sync][native-sync].                                                                                                               | Enforce a cumulative byte limit while reading chunks, including absent/false Content-Length, and account for simultaneous jobs/decryption copies. Reject before exceeding the phone's budget; preserve integrity checks.                                    |

## Investigations And Product Contracts

| ID   | Evidence / source                                                                                                                                                                                                                                                                                                                                                  | Required next step                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MR01 | **Offline availability can describe partial content.** `refreshVaultOfflineContents` catches individual cache failures but still sets `offlineAvailableAt` and advances manifest sequence. This may intentionally mean a usable partial replica. [Replica][replica].                                                                                               | Specify partial/complete/stale states; fail every body read and test the resulting badges. Retain failed-file counts and retry targets rather than implying all files are available.                                                                                  |
| MR02 | **Cache fallback conflates connectivity and authorization failures.** Several asset/document readers fall back after any network error. Existing offline-copy policy may permit retained reads, so this is not automatically a confidentiality bug. [Assets][assets], [Notes helper][notes-helper], [Deck helper][deck-helper].                                    | Exercise revoked membership/disabled accounts/403 versus airplane mode; define cache retention, removal and stale warnings consistently with server policy.                                                                                                           |
| MR03 | **Saved/live labels precede confirmed disk durability.** Live note changes mark content saved while caching is fire-and-forget; live CRDT persistence is debounced and errors are swallowed. Ink/sheet unmount flushing is asynchronous. [Note][note], [Live][live], [Ink][ink], [Sheet][sheet].                                                                   | Kill the process during save/debounce, deny storage and exhaust disk. Establish acknowledged durable checkpoints and recovery UI; component cleanup cannot guarantee process-death persistence.                                                                       |
| MR04 | **Push catch-up KEEP can drop later invalidation payloads.** Kotlin uses one global unique catch-up work name with KEEP and embeds the invalidation in inputData. A second event while work is active may not be queued. Whether this loses required catch-up depends on what native invalidation processing drains. [Worker][worker].                             | Send different account/vault invalidations during one run; inspect authoritative cursor draining and enqueue a durable dirty-target union/follow-up if necessary. Do not infer message loss solely from WorkManager KEEP.                                             |
| MR05 | **Cold shortcuts can run before restoration is ready.** Pending routes are consumed in an effect independent of `restore`; `openVaultTarget` resolves only currently loaded inventories. Zero-delay DOM handoffs also depend on destination screen readiness. [Shell][shell], [Store][store].                                                                      | Start a killed app from widget/capture/notification under slow restore. Keep the durable route until the target confirms handling; verify unavailable versus not-yet-loaded states.                                                                                   |
| MR06 | **Foreground lifecycle events can launch overlapping catch-up.** Focus, online and visibility all run a sequential status/notification/reconcile/background request chain without a shell-level in-flight guard. Native resource deduplication exists; UI work can still duplicate. [Shell][shell], [Native background][native-background].                        | Emit a resume burst and measure duplicate IPC/DB/network work, ordering and queued-job counts; coalesce equivalent triggers.                                                                                                                                          |
| MR07 | **Formula evaluation/release ordering needs a native stress test.** The hook suppresses stale responses and releases on unmount, but does not cancel an evaluation already dispatched. [Formula][formula].                                                                                                                                                         | Close/reopen while a slow evaluation is running; verify no runtime is recreated/leaked after release and that results stay with the correct workbook.                                                                                                                 |
| MR08 | **Long PDF scrolling retains rendered pages.** IntersectionObserver marks a page visible once and disconnects; canvases are not evicted when scrolled away. All page wrappers exist and scroll handling measures their bounds. Existing task/document teardown and DPR clamp are present. [Viewer][viewer].                                                        | Scroll a long PDF end-to-end and back, inspect retained canvas/worker memory and rendering concurrency; choose a measured visible/nearby-page budget.                                                                                                                 |
| MR09 | **Avatar retry budget is consumed by failures/old revisions.** VaultChat's requested Set is capped at eight; failed requests remain marked and later user/version keys can exhaust the budget. This deliberately bounds work but may leave fallback avatars for the rest of a visit. [Chat][chat].                                                                 | Test eight failures then recovery and avatar version changes. Use a bounded success cache and retry policy if product expects recovery; avoid unlimited requests on every message refresh.                                                                            |
| MR10 | **Release WebView policy deserves a dedicated security pass.** Android Tauri config has `csp: null`; remote document renderers, links, permissions and native IPC boundaries must be assessed together. Existing sanitizers and native account checks mean this alone is not an exploit finding. [Android config][android-config], [Viewer][viewer], [Note][note]. | Inventory trusted/local/data/remote sources and script execution; test untrusted fixtures and propose a compatible CSP. Verify release merged manifest, cleartext exceptions, provider exposure and Keystore/backup behavior without weakening local-network support. |

## Optimization Inventory

Each entry names a source boundary and a validation target. Shared findings
should be implemented once with the desktop/web contracts, not as divergent
mobile copies. Changes to persistence, permissions or encrypted storage need
correctness evidence before a performance claim.

### Startup, Rendering And Document Memory

| ID   | Current cost / source                                                                                                                                                                                       | Improvement and validation                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO01 | Eager shell imports every main screen; FilesScreen eagerly imports its editors/viewer. [Shell][shell], [Files][files].                                                                                      | Lazy feature boundaries with resilient loading/retry, then measure cold launch and first file interaction on low-end hardware.                                                                                  |
| MO02 | RichFileViewer combines PDF, canvas and large circuit/property/analysis UI in one module. [Viewer][viewer].                                                                                                 | Split format-specific viewers and analysis panels; opening an image should not require circuit/PDF initialization. Compare parsed/executed bytes, not emitted chunks alone.                                     |
| MO03 | PDF/Three.js/Mermaid are substantial emitted assets; shared import paths can defeat deferred loading. [Viewer][viewer], [Note][note], [Vite][vite].                                                         | Inspect build import graph and runtime resource trace before choosing lazy worker/script boundaries; preload only likely next actions. Preserve offline packaged availability.                                  |
| MO04 | Entry CSS imports several font families, syntax and math styling; Nerd Font is large. [Main][main].                                                                                                         | Measure decoded fonts and text layout; conditional feature styles or subsets only where multilingual/icons remain correct. Do not assume every emitted font loads.                                              |
| MO05 | Root StrictMode has no feature-level error boundary. [Main][main], [Shell][shell].                                                                                                                          | Recover independently from renderer failures without remounting unrelated state; exercise malformed documents and root/feature exceptions. Keep StrictMode diagnostics rather than removing it to mask effects. |
| MO06 | Tab navigation unmounts the page via keyed view. [Shell][shell].                                                                                                                                            | Separate durable draft/session state from disposable DOM and measure remount cost. Keep only bounded lightweight state; retaining all editor DOM would increase RAM (MB04/MR03).                                |
| MO07 | Store selectors for full statuses/files/cache maps cause broad updates in FilesScreen. [Files][files], [Store][store].                                                                                      | Subscribe to active server/visible entries and preserve unchanged object identity. Profile commits during sync/cache badge updates before adding memoization.                                                   |
| MO08 | File browser scans the whole manifest then sorts the active folder; scans already yield to a 7 ms budget. [Files][files].                                                                                   | Maintain parent/ID indexes and incremental manifest updates; measure large folder scans/sorts while preserving current yielding and 60-row pages.                                                               |
| MO09 | Increasing “more” pages can grow the file DOM beyond the first bounded page. [Files][files].                                                                                                                | Virtualize sustained large lists where needed, preserving long press, selection, focus and touch targets; compare DOM count/frame time after many pages.                                                        |
| MO10 | Individual cache badge results repeatedly clone the full cache map and publish updates. [Store][store], `refreshCacheStatus`.                                                                               | Batch bounded results per frame/chunk, keep six-worker concurrency and identity checks; measure IPC calls, map copying and React commits.                                                                       |
| MO11 | PDF scroll mode mounts all page wrappers and calls getPage to measure pages even before raster visibility. [Viewer][viewer].                                                                                | Window page descriptors/metadata and cap concurrently rendered pages. Verify variable page dimensions, scroll-position accuracy and long-document memory (MR08).                                                |
| MO12 | Scrolled-to PDF canvases remain rendered after leaving the viewport. [Viewer][viewer].                                                                                                                      | Evict far canvases/page resources, retain nearby pages under pixel/byte budget and reuse on return. Measure end-to-end scroll memory, zoom and reopen cleanup.                                                  |
| MO13 | PDF scroll handler queries/measures all wrappers on every scroll event. [Viewer][viewer].                                                                                                                   | Cached page offsets and frame-throttled visible-index lookup/IntersectionObserver; measure layout reads and frame time at thousands of pages.                                                                   |
| MO14 | Assets arrive as full base64 data URLs; PDF decoding retains base64, atob binary string and byte array. Chunked copying yields but atob is still whole-buffer. [Assets][assets], [Native gateway][gateway]. | Android-safe authenticated asset stream/file adapter, avoiding multiple bridge copies. Compare peak JS/native memory at large PDF/image sizes and preserve offline authorization.                               |
| MO15 | Large image decoding/raster surfaces can dominate WebView RAM despite modest file bytes. [Viewer][viewer], [Assets][assets].                                                                                | Decode sized previews first, enforce pixel/resource budgets and tile/region decode where supported; test panoramas/animated images and orientation.                                                             |
| MO16 | Markdown preview rendering runs on the main thread after a zero-delay timeout, not in a worker. [Note][note].                                                                                               | Debounce/cancel obsolete previews and workerize portable parsing where justified; preserve sanitization, links, plots and Mermaid ordering. Measure long-note edit/preview latency.                             |
| MO17 | Circuit/canvas viewers derive large SVG/geometry/property trees and results. [Viewer][viewer].                                                                                                              | Spatial/visible-item filtering, memoized stable geometry and bounded plot samples. Profile large valid fixtures; preserve selection, crossings and reported analysis accuracy.                                  |
| MO18 | Sheet metrics and formula requests are rebuilt when worksheet/document identity changes. Grid virtualization already exists. [Grid][grid], [Formula][formula].                                              | Reuse axis metrics for cell-only edits and incremental formula inputs where native contract permits. Measure edit/pinch commits at large dimensions; retain viewport bounds.                                    |
| MO19 | Ink/sheet serialize full documents for dirty checks and save decisions, including repeated checks after completion. [Ink][ink], [Sheet][sheet].                                                             | Revision/dirty counters and one serialization per durable checkpoint; verify canonical content/conflicts. Measure stroke/cell editing allocation and blocked-save behavior (MB02).                              |
| MO20 | Ink rendering already uses shared tile cache and frame scheduling. [Ink canvas][ink-canvas].                                                                                                                | Tune tile/pixel budget for phone RAM/DPR and incremental damage, using real stylus traces. Verify renderer cleanup; do not replace existing bounded rendering with full redraws.                                |

### Network, IPC And Offline Synchronization

| ID   | Current cost / source                                                                                                                                                                        | Improvement and validation                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO21 | Presentation discovery is 20 requests/minute per connected server at the nominal interval, excluding resumes. [Shell][shell], [Presentation][presentation].                                  | Visibility/single-flight gating and adaptive discovery/event invalidation (MB05); compare idle battery/network cost across several servers.                                                              |
| MO22 | Foreground focus/online/visibility launch overlapping chains. [Shell][shell].                                                                                                                | Coalesced lifecycle scheduler with cancellation/generation and clear read-versus-job semantics. Measure one wake-up burst (MR06).                                                                        |
| MO23 | Restore waits for reconnect, replicas, inventories, sync/calendar/jobs and reconcile before setting restored. [Store][store].                                                                | Stage usable local/cached UI independently of long server synchronization; bound reconnect concurrency and indicate partial readiness. Measure offline/slow multi-server startup and cold routes (MR05). |
| MO24 | Restore launches loadVaults and syncServer together; loadVaults also kicks offline refresh. [Store][store].                                                                                  | Coordinate overlapping replica refresh/replay by resource/sequence; preserve existing cooldown/in-flight sets. Measure duplicate downloads and DB reads under slow restore.                              |
| MO25 | File listing refetches full collection; late writes have no generation check. [Store][store], [Native gateway][gateway].                                                                     | Identity-keyed loads/deltas and conditional snapshots with gap recovery. Test stale A/B, reconnect and background event bursts (MB01).                                                                   |
| MO26 | syncServer polls native jobGet every 150 ms while a job is queued/running. [Store][store].                                                                                                   | Reuse existing native status events with bounded fallback polling, avoiding repeated full job reads/IPC. Measure requests for minute-long jobs and lost-event recovery.                                  |
| MO27 | Foreground sync uses new random idempotency keys and iterates replicas sequentially. Native semaphore/resource guards already exist. [Store][store], [Native background][native-background]. | Coalesce same-resource triggers and use bounded scheduling rather than unbounded parallel replay. Measure latency/ledger growth with many replicas; keep deterministic per-resource ordering.            |
| MO28 | Offline refresh fetches a full manifest then checks/caches each body sequentially. [Replica][replica].                                                                                       | Delta manifests, batch cache metadata and limited I/O concurrency under byte budgets. Compare network/IPC counts while preserving hash checks and ordered outbox replay.                                 |
| MO29 | Cache-status calls inspect per-file native content state; large folders still incur many IPC calls. [Replica][replica], [Store][store].                                                      | Native batched metadata/hash status with bounded result size; avoid reading whole contents just for a badge where trusted digest metadata suffices. Verify corruption detection and stale invalidation.  |
| MO30 | Cached asset/document warm-up sends data back over IPC after native network read; small asset warm-up is already capped at 5 MiB. [Assets][assets].                                          | Native fetch-and-cache once, returning a handle/content as needed. Measure bridge bytes and duplicate encoding; retain explicit offline downloads for larger assets.                                     |
| MO31 | Live CRDT persistence encodes full state/base64 every checkpoint; live JSON conversion traverses document trees. [Live][live].                                                               | Ordered, bounded persistence with dirty/version checks and compaction strategy; incremental updates only with recoverable snapshots. Measure large ink/board edits and crash recovery (MR03).            |
| MO32 | Released live sessions are kept for a 30-second grace period; reconnection continues without visibility policy in this helper. [Live][live].                                                 | Measure retained docs/sockets after rapid file hopping; cap session cache, suspend unnecessary reconnect/awareness work on background, retain deliberate fast reopening semantics.                       |
| MO33 | Calendar synchronization and mirrors can produce frequent progress state changes and broad queries. [Store][store], [Calendar sync][calendar-sync].                                          | Coalesce progress, reuse cursor/unchanged projections and coordinate foreground/background ownership. Test conflicts, offline calendars and multiple origins; compare calls and store commits.           |
| MO34 | Calendar rendering expands/filters items and creates Intl formatters repeatedly. [Calendar][calendar].                                                                                       | Memoize range projections and formatter instances; native indexed range reads where appropriate. Measure dense recurrence months, DST/timezone changes and correct overlap/exception semantics.          |
| MO35 | Chat/team shared UI has its own loads, read marks, people searches and avatar requests. [Conversations][conversations], [Chat][chat], shared [workspace][team-workspace].                    | Reuse bounded identity-scoped caches/incremental message reads, coalesce read marks and preserve narrow phone panes. Measure idle chat traffic, search bursts and account switches; share desktop fixes. |

### Native Transfers, Background Work And Android Packaging

| ID   | Current cost / source                                                                                                                                                       | Improvement and validation                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO36 | Upload reads whole external file into Vec, hashes/encodes it, then JSON-encodes base64 in an async hosted command. [Native files][native-files], [Gateway][gateway].        | Metadata-first URI handling, byte limit before/during read, bounded blocking I/O and streamed binary protocol where supported. Measure large cloud-provider upload RAM and permission revocation (MB03). |
| MO37 | Native entry/export downloads already stream chunks directly to FilePath. [Gateway][gateway].                                                                               | Retain streaming while adding transactional/provider-aware completion, byte progress and cancellation cleanup (MB07). Test phone storage pressure and slow providers.                                    |
| MO38 | Native background assets permit 512 MiB and buffer/copy complete bodies; two jobs may run concurrently. [Native sync][native-sync], [Native background][native-background]. | Phone-specific aggregate byte budgets and encrypted streaming/staging; enforce cumulative limits before allocation (MB09). Measure peak RSS including encrypt/decrypt and simultaneous jobs.             |
| MO39 | Offline caching has no UI-level storage/quota admission decision in refresh loops. [Replica][replica], [Store][store].                                                      | Native disk quota accounting, low-space preflight and selective asset download/eviction. Never evict unsynced edits; verify offline completeness and partial failures (MR01).                            |
| MO40 | Background Worker reconciles notifications, push registration and widget rebuild after work. [Worker][worker].                                                              | Change-driven, coalesced follow-up work; measure work that found no changes and avoid rebuilding every projection unnecessarily. Preserve attention/diagnostic feedback.                                 |
| MO41 | Push catch-up KEEP is globally keyed and receives event-specific payload. [Worker][worker].                                                                                 | Durable dirty-target merging plus one drain/follow-up worker if native catch-up is not comprehensive. Verify bursts across servers and stalled workers (MR04).                                           |
| MO42 | Widget updates/lifecycle/foreground enqueue tasks on one executor; profile rebuilds may repeat. [Widget coordinator][widget-coordinator].                                   | Coalesce equivalent work per profile while preserving forced boot/time/locale redraw; bound queue length. Measure eight widgets, rapid broadcasts and launcher restarts.                                 |
| MO43 | Widget/calendar projections read snapshots/configuration and derive shared content. Existing snapshot/config/item limits are explicit. [Widgets][widgets].                  | Reuse revision-stable projections across widgets; measure DB/file reads and render CPU. Retain 24-item/42-day and snapshot byte bounds, privacy filtering and unknown-version behavior.                  |
| MO44 | Notification routes scan up to 200 inbox records to locate an ID. [Shell][shell].                                                                                           | Direct native lookup by scoped ID with bounded route queue and reliable acknowledgement; test older notifications, duplicate taps and cold start without increasing inbox read limits.                   |
| MO45 | APK includes shared native crates plus packaged web assets; release already minifies JVM code and strips symbols by default. [Gradle][gradle], [Cargo](../../Cargo.toml).   | Measure actual release ABI/native sections and packaged assets before feature-gating unused code. Preserve JNI/proguard keep rules, offline assets and deliberately optimized debug profiles.            |

### Correctness, Accessibility And Measurement

| ID   | Current cost / source                                                                                                                                                                          | Improvement and validation                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO46 | Save/draft state varies by editor and live/REST/offline mode. [Note][note], [Ink][ink], [Sheet][sheet], [Live][live].                                                                          | Common durable save-state contract, blocked-conflict recovery and dirty navigation; prove kill/reopen/disconnect/disk-failure cases (MB02/04, MR03).                                                                    |
| MO47 | Touch gestures, custom sheets and small controls depend on phone input behavior. [Shell][shell], [UI][ui], [Grid][grid], [Viewer][viewer].                                                     | TalkBack/external-keyboard/IME and large-font tests, nested gesture arbitration and consistent busy dismissal. Preserve working hardware-back stack; verify tablet landscape and split screen.                          |
| MO48 | Server/vault/file identity is inconsistently scoped in target resolution, and asynchronous reads can outlive selection. [Store][store], [Shell][shell].                                        | Shared identity key/ticket contracts for every load, cache and notification route (MB01/06). Test cloned IDs, account replacement and provenance-free legacy routes; keep native account checks.                        |
| MO49 | Future config-loader warning and shared heavy imports create build maintenance/performance debt. [Vite][vite], [Vitest][vitest], [Build helper](../../scripts/mobile-build-frontend.mjs).      | Compatible ESM config paths, bundle graph/budgets and reproducible frontend/native release checks. Do not hide warnings by raising the chunk threshold or remove optimized debug settings.                              |
| MO50 | jsdom success does not measure Android lifecycle, energy or memory. [Mobile plan](../plans/android-companion-app-plan.md), [Release gates](../build/background-running-release-validation.md). | Maintain low/mid/high device and WebView-version performance fixtures: startup, frames, JS/native RSS, disk, idle network, wakeups, thermal and process death. Compare medians/tails and sustained trends, not one run. |

## Existing Safeguards To Preserve

- Files are displayed in 60-row pages; folder scanning yields with a time budget.
  Cache status uses up to six workers and checks current selection before publish.
  Those bounds do not protect `loadFiles`, which is the separate MB01 path.
- The sheet grid already virtualizes rows/columns. Formula responses have sequence
  guards and runtime release. Ink already has shared tiled rendering and gesture
  capture; improvements should build on those mechanisms.
- PDF loading/render tasks are cancelled; the document loading task is destroyed
  on cleanup, and raster DPR is clamped to two. MR08 concerns retained pages while
  the viewer remains open, not a claim that worker teardown is absent.
- Native downloads stream to Android FilePath/SAF handles. Do not route them
  through JS base64. Native background has a two-job semaphore, resource/ledger
  guards and runtime budgets; no proposal assumes unlimited parallel sync exists.
- WorkManager uses unique work, network/charging/battery policy, exponential
  backoff and bounded retries. The audit does not propose polling from a permanent
  service or bypassing Android scheduling restrictions.
- Tokens and replica keys use native Keystore-backed storage. Appearance and
  known-server localStorage operations already catch storage exceptions; the web
  appearance crash is not duplicated as a mobile bug.
- Chat pending sends are native/encrypted and account-scoped, with stable retry
  IDs and bounded history. Unsubmitted composer text has a different draft
  contract. Shared gateway account/provenance checks must remain.
- Widgets use bounded privacy-filtered native projections, not a background
  WebView. JVM release shrinking and intentional Rust debug optimization are
  already configured. Debug speed measurements cannot substitute for release QA.

## Suggested Delivery Order

1. **Save/identity correctness:** MB01–MB04 and MB06, failure throttling, durable
   drafts, permission/conflict states and process-death evidence. These contracts
   must also work in future standalone local vaults.
2. **Android transfer/resource safety:** URI metadata, safe download completion,
   cumulative response limits and storage admission (MB07/09). Measure existing
   copies before changing encrypted storage formats.
3. **Idle/lifecycle work:** presentation discovery, resume coalescing, event-driven
   job status, coordinated offline sync, push drains and widget deduplication.
4. **Startup/rendering:** lazy format boundaries, PDF canvas budgets, indexed
   folders, revision-based saves and measured shared renderer improvements.
5. **Release evidence:** TalkBack/IME/keyboard/tablet, actual APK size, process
   death/storage migration, background scheduling and battery/resource soak.

## Device Acceptance Matrix

| Scenario                                                                            | Evidence needed                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fresh/warm launch with 0, 1 and several servers, offline/slow network               | Time to usable cached UI, peak JS/native RSS, network/IPC counts, restore/route ordering                         |
| Vault A/B switching, cloned IDs, account replacement and background reload          | Correct identity/results, no stale busy/error/cache state and safe notification provenance                       |
| Edit while REST/live/offline; conflict, permission loss, full disk and process kill | Durable recovered content, bounded retries, clear saved/pending/blocked states and outbox integrity              |
| 1,000 / 10,000 / 100,000 file entries, many cache badges                            | Main-thread stalls, list/frame time, IPC count, DOM/cache bounds and selection correctness                       |
| Long PDFs, large decoded images, long Markdown, large sheets/ink/circuits/decks     | Peak retained canvas/worker/native memory, latency/frame tails, thermal behavior and cleanup after reopen        |
| Opaque SAF/cloud URIs and transfers near size limits                                | Correct type/capability route, memory budget, byte progress, cancellation and truthful partial destination state |
| Visible idle, background, Doze/restricted battery and resume bursts                 | Requests/minute, wakeups, job deduplication, stale indicators and recovery under scheduler constraints           |
| Eight widgets, rapid push events and cold notification/shortcut taps                | Snapshot/job queue bounds, complete catch-up and acknowledged routing with killed WebView                        |
| Phone/tablet landscape, split screen, large font, TalkBack, keyboard/IME and stylus | Focus/back behavior, gesture isolation, usable targets and preservation of edits                                 |
| Signed release APK/AAB on maintained and older supported WebViews                   | Startup/native sections/asset sizes, JNI/shrinker compatibility, storage migration and security policy           |

Implementation remains **not started**. The [open-work index](../plans/open-development-work.md)
owns status. The [full-app overhaul](../plans/mobile-full-app-plan.md) owns local
vaults/editor expansion; this correctness/performance backlog supplies its
acceptance contracts rather than changing that delivery sequence. Shared fixes
should reconcile the [desktop](./desktop-performance-and-bugs-2026-10-14.md)
and [web](./web-interface-performance-and-bugs-2026-10-14.md) audits.

[shell]: ../../apps/mobile-android/src/MobileApp.tsx
[main]: ../../apps/mobile-android/src/main.tsx
[store]: ../../apps/mobile-android/src/state/store.ts
[files]: ../../apps/mobile-android/src/screens/FilesScreen.tsx
[note]: ../../apps/mobile-android/src/screens/NoteScreen.tsx
[ink]: ../../apps/mobile-android/src/screens/InkScreen.tsx
[sheet]: ../../apps/mobile-android/src/screens/SheetScreen.tsx
[viewer]: ../../apps/mobile-android/src/screens/RichFileViewerScreen.tsx
[chat]: ../../apps/mobile-android/src/screens/ChatScreen.tsx
[conversations]: ../../apps/mobile-android/src/screens/ConversationsScreen.tsx
[calendar]: ../../apps/mobile-android/src/screens/CalendarScreen.tsx
[ui]: ../../apps/mobile-android/src/components/ui.tsx
[grid]: ../../apps/mobile-android/src/components/SheetTouchGrid.tsx
[ink-canvas]: ../../apps/mobile-android/src/components/InkTouchCanvas.tsx
[formula]: ../../apps/mobile-android/src/lib/sheetFormula.ts
[presentation]: ../../apps/mobile-android/src/lib/activePresentation.ts
[transfer]: ../../apps/mobile-android/src/lib/fileTransfer.ts
[assets]: ../../apps/mobile-android/src/lib/assets.ts
[replica]: ../../apps/mobile-android/src/lib/replica.ts
[live]: ../../apps/mobile-android/src/lib/liveNote.ts
[notes-helper]: ../../apps/mobile-android/src/lib/notes.ts
[deck-helper]: ../../apps/mobile-android/src/lib/deck.ts
[calendar-sync]: ../../apps/mobile-android/src/lib/calendarSync.ts
[gateway]: ../../src-tauri/src/commands/server.rs
[native-files]: ../../src-tauri/src/commands/files.rs
[native-sync]: ../../src-tauri/src/background/sync.rs
[native-background]: ../../src-tauri/src/background/mod.rs
[widgets]: ../../src-tauri/src/widgets.rs
[worker]: ../../src-tauri/gen/android/app/src/main/java/com/azazel/collab/companion/CollabBackgroundWorker.kt
[widget-coordinator]: ../../src-tauri/gen/android/app/src/main/java/com/azazel/collab/companion/CollabWidgetCoordinator.kt
[android-config]: ../../src-tauri/tauri.android.conf.json
[gradle]: ../../src-tauri/gen/android/app/build.gradle.kts
[team-workspace]: ../../src/components/teams/TeamWorkspace.tsx
[vite]: ../../apps/mobile-android/vite.config.ts
[vitest]: ../../apps/mobile-android/vitest.config.ts
