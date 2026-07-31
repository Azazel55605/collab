# Android Companion App Plan

## Summary

Build an Android-first companion app for hosted Collab vaults. The mobile app is
not intended to replace the desktop client. Its job is to make common hosted
workflows available away from a workstation: sign in to servers, keep selected
hosted vaults available offline, read and edit notes, read and edit Kanban
boards, and view richer vault files such as PDFs, images, canvases, and logic
diagrams.

iOS is explicitly out of scope for the initial implementation. The architecture
should not block iOS later, but the first production target is Android.

## Product Scope

### Included In The Initial Mobile Product

- Android app distributed as a companion client.
- Hosted server login, session restore, token refresh, and disconnect.
- Hosted vault list and vault switching.
- Local offline copies for selected hosted vaults, based on the current desktop
  replica model.
- File browsing and search suitable for phone screens.
- Note viewing and editing.
- Kanban viewing and editing.
- PDF, image, canvas, and logic diagram viewing.
- Sync status, manual sync, retry failed operations, and discard queued
  operations.
- Read-only enforcement for hosted viewer permissions.
- Shared visual language with the desktop app: themes, accent colors, typography,
  status chips, document top-bar language, and restrained operational styling.

### Explicitly Out Of Scope For The Initial Product

- iOS builds, signing, App Store distribution, and iOS-specific QA.
- Local filesystem vaults.
- Admin web features.
- Desktop-style multi-tab workspace.
- Full canvas editing.
- Full logic diagram editing.
- SVG/vector editing.
- PDF annotations/highlights/comments editing.
- Image additive or permanent editing.
- Native file drag/drop, external file import, and OS file-manager integration.
- Desktop-equivalent live editing polish for every document type. Notes and
  Kanban now use the hosted WebSocket/CRDT path on mobile, but rich-file viewers
  and all desktop-only authoring integrations remain outside the initial mobile
  product.

## Technology Direction

Use Tauri 2 mobile for the first spike and likely MVP.

Rationale:

- The desktop app already uses Tauri 2, React, Vite, Rust commands, and a Rust
  hosted replica implementation.
- The current hosted security model intentionally keeps bearer tokens and refresh
  tokens on the native side. A Tauri mobile client can preserve that boundary.
- The native replica store, hashing rules, offline queue, and hosted request
  proxy are easier to share through Rust crates than to rewrite in a React Native
  stack.
- The frontend can still be a mobile-specific React app that reuses shared design
  tokens, stores, DTOs, and selected rendering components.

Capacitor remains a fallback if the Tauri mobile spike fails on WebView,
packaging, plugin, or Android lifecycle constraints. React Native/Expo should be
treated as a larger rewrite option, not the default path, because it would require
duplicating the Rust-native replica and hosted token boundary in JavaScript or
native modules.

## Architecture Target

### Repository Shape

Preferred structure:

```text
apps/mobile-android/
  Android-first Tauri mobile app shell

src/
  Existing desktop frontend

crates/
  collab-core
  collab-protocol
  collab-replica           shared offline replica implementation

src-tauri/src/
  hosted_client.rs         shared hosted request/client helpers
  hosted_session.rs        shared native session orchestration
  server_token_store.rs    platform-specific refresh-token persistence boundary
```

The mobile app does not import the desktop `AppShell`. It uses a mobile shell
built around drill-in navigation:

- Server/vault switcher.
- Vault file browser.
- Document viewer/editor screen.
- Sync/activity screen.
- Settings/account screen.

### Shared Code Boundaries

Reuse:

- `collab-core` path/name/hash primitives and `collab-documents` reference rules.
- `collab-protocol` DTOs and error codes.
- Hosted server auth/session concepts.
- Hosted vault API client semantics.
- Offline replica schema and pending-operation model.
- Note markdown render pipeline where practical.
- Kanban document schema and mutation helpers where practical.
- Design tokens, themes, accent colors, and common controls after extraction.

Do not reuse directly:

- Desktop `AppShell`.
- Desktop tab model.
- Desktop sidebar/activity bar layout.
- Desktop canvas/logic editors.
- Desktop file drag/import/export flows.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 0. Feasibility spike | Complete | Prove Android Tauri mobile can run a Collab shell, call Rust, authenticate, and persist app data. |
| 1. Shared client foundation | Complete | Extract enough auth/API/replica logic so desktop and Android do not fork core hosted behavior. |
| 2. Android mobile shell | Complete | Build phone-first navigation, server access, hosted vault list, and settings/account screens. |
| 3. Offline replica read path | Complete | Seed, cache, open, and browse hosted vault offline copies on Android. |
| 4. Notes MVP | Complete | View, edit, save, queue offline, and sync markdown notes. |
| 5. Kanban MVP | Complete | View and edit boards/cards through a mobile-first Kanban workflow. |
| 6. Viewer-only rich files | Complete | Add PDF, image, canvas, and logic diagram viewers without edit affordances. |
| 7. Android hardening and release prep | In progress | Device QA, lifecycle handling, signing, release packaging, and operational docs. |
| 8. Later expansion | Deferred | Decide whether to add push/background sync, iOS, richer viewers, or mobile capture flows. |

## Phase Details

### Phase 0: Feasibility Spike

Estimated effort: 2-3 weeks.

Goals:

- Create a minimal Android Tauri mobile target.
- Render a simple Collab-branded React mobile shell.
- Call a Rust command from the mobile WebView.
- Perform HTTPS requests to a hosted Collab server through native/Rust code.
- Store a test value in app data and retrieve it after app restart.
- Verify Android emulator and one physical Android device.

Acceptance criteria:

- A developer can run the Android app locally.
- The app can connect to a known hosted server health/auth endpoint.
- Native command invocation works from React on Android.
- App-local persistence works across restarts.
- Any blocking Tauri mobile/plugin limitation is documented before deeper work.

Current implementation notes:

- Added a mobile-specific React entrypoint in `apps/mobile-android`.
- Added `src-tauri/tauri.android.conf.json` so Android builds use the mobile
  shell and `dist-mobile` instead of the desktop app.
- Added a native server health command, native auth probe, and app-data
  persistence probe that reports whether a previous value was restored.
- Added Android build scripts and detailed APK build instructions in
  `docs/mobile/android-companion-build.md`.
- Verified on a physical Android device with a debug APK and reachable hosted
  test server.
- Android refresh-token persistence started as a compile-safe placeholder during
  Phase 0 and is replaced by Android Keystore-backed storage in Phase 1.

Exit decision:

- Continue with Tauri mobile if auth, HTTPS, filesystem/app-data persistence, and
  WebView performance are acceptable.
- Reevaluate Capacitor only if Tauri mobile blocks a required primitive.

### Phase 1: Shared Client Foundation

Estimated effort: 3-5 weeks.

Goals:

- Extract hosted native-session refresh logic from desktop command code into a
  shared Rust module or crate.
- Extract hosted request construction, digest validation helpers, and error
  normalization into a shared client layer.
- Extract the hosted replica store from desktop-only Tauri commands into a shared
  Rust crate with thin desktop/mobile command wrappers.
- Keep token storage platform-specific behind a small trait/interface.
- Preserve the invariant that bearer tokens do not enter the webview.

Acceptance criteria:

- Desktop behavior is unchanged after extraction.
- Android can call the shared auth/API/replica logic through its own commands.
- Refresh-token rotation remains serialized per server.
- Local replica data is stored in Android app-private storage.
- Existing desktop tests still pass.

Current implementation notes:

- Extracted hosted server URL validation, HTTP client construction, WebSocket
  HTTP/1.1 client construction, request error normalization, hosted request
  method/path validation, identifier validation, native-session decoding, and
  hosted JSON/error decoding into `src-tauri/src/hosted_client.rs`.
- Extracted refresh-token persistence into `src-tauri/src/server_token_store.rs`
  so Android Keystore support can replace the current mobile placeholder without
  changing hosted session orchestration.
- Added Android Keystore-backed refresh-token persistence through the generated
  Android project and a mobile restore-session probe for testing app restart
  session recovery.
- Added a mobile hosted-vault list probe through the native hosted request
  gateway, verifying that restored Android sessions can call authenticated
  hosted APIs without exposing bearer tokens to the WebView.
- Routed Android app configuration and replica storage through the app-private
  files directory, with a mobile replica-list probe to verify the native replica
  store can open on device before full offline seeding is added.
- Rewired desktop and Android Tauri commands to use the shared hosted-client and
  token-store modules while leaving live session state in the Tauri boundary for
  the next Phase 1 slice.
- Extracted the native hosted-session orchestration (refresh-token resolution,
  the serialized refresh-token rotation lock, access-token freshness checks, and
  `session_for`/`fresh_session_for`) out of `commands/server.rs` into the shared
  `src-tauri/src/hosted_session.rs` module. The desktop and Android command
  wrappers, plus the live-collaboration WebSocket, now share one session
  lifecycle instead of forking it, refresh-token rotation stays serialized per
  server through `AppState.server_refresh_lock`, and bearer/access tokens still
  never leave the backend. Desktop behavior and all existing backend tests are
  unchanged.
- Promoted the native hosted-vault replica store into the shared
  `crates/collab-replica` workspace crate (moved `models.rs` and `store.rs` out
  of `src-tauri/src/replica/`). The temporary `src-tauri/src/replica.rs`
  re-export was removed in the Rust crate refactor cleanup; the `replica_*`
  Tauri command wrappers now import the crate directly and remain the
  desktop/Android boundary. To avoid forking the
  `CENC` at-rest container format between desktop vault encryption and the
  replica store, the byte-level AES-256-GCM primitives (`encrypt_bytes`,
  `decrypt_bytes`, `is_encrypted_data`) moved into `collab_core::crypto`;
  `src-tauri/src/crypto.rs` re-exports them (keeping Argon2 key derivation and
  the vault.enc password helpers) and `collab-replica` consumes them directly.
- Verified the whole extraction: `cargo check --workspace` is clean, the desktop
  lib (`109`), `collab-replica` (`18`), and `collab-core` (`42`) test suites all
  pass, and the shared crates plus the full `src-tauri` lib cross-compile for
  `aarch64-linux-android`, so the desktop client, standalone server, and Android
  companion all continue to build against the shared foundation.

Phase 1 is complete: hosted auth/session refresh, the hosted request/client
layer, refresh-token storage, and the offline replica store are all shared
between the desktop and Android clients through `hosted_client`,
`hosted_session`, `server_token_store`, and the `collab-replica` /
`collab-core::crypto` crates, with token storage kept platform-specific and
bearer tokens never entering the webview.

### Phase 2: Android Mobile Shell

Estimated effort: 2-4 weeks.

Goals:

- Add a mobile-specific React shell.
- Implement hosted login, saved server list, reconnect, and disconnect.
- Show hosted vault inventory per connected server.
- Add a mobile vault switcher.
- Add a phone-first file browser.
- Add settings for theme/accent/font scale where sensible.

Acceptance criteria:

- User can sign in to a hosted server and reopen the app without retyping a
  password while the refresh token is valid.
- User can select a hosted vault and browse its active files.
- Viewer-role users see read-only affordances.
- Navigation is ergonomic on a phone without desktop sidebars or tabs.

Current implementation notes:

- Replaced the Phase 0 probe screen with a real phone-first shell in
  `apps/mobile-android/src/`: a bottom tab bar (`Servers`, `Vaults`, `Files`,
  `Settings`) with drill-in navigation (`MobileApp.tsx`), deliberately not
  importing the desktop `AppShell`, sidebar, or tab model.
- The shell has its own lightweight state layer (`state/store.ts`, a Zustand
  store) and IPC layer (`mobileTauri.ts`) that reuse the existing shared native
  commands — `connect_server`, `reconnect_server`, `disconnect_server`,
  `server_connection_statuses`, `server_has_saved_session`, and the
  bearer-hidden `hosted_vault_request` gateway — so no new Rust commands were
  needed and access/refresh tokens still never enter the web view.
- `ServersScreen` implements hosted login (URL/username/password + optional
  untrusted-certificate opt-in), a saved-server list persisted in
  `lib/servers.ts` (`collab-mobile-servers`, mirroring the desktop
  `KnownServer` shape), per-server connect/reconnect/disconnect, and online
  status dots. On launch `store.restore()` reconnects every saved server that
  has a stored refresh token, so the app reopens without re-entering a password
  while the token is valid.
- `VaultsScreen` lists the hosted vault inventory per connected server with
  storage/member/role metadata and acts as the vault switcher; `FilesScreen` is
  a phone-first browser (folder drill-in with breadcrumbs) over
  `GET /api/v1/vaults/{id}/files`, with a read-only detail sheet. Viewer-role
  vaults show a shared `Read only` badge on both the vault row and the file
  browser header, and no edit affordances are presented (editing lands in
  Phases 4–5).
- `SettingsScreen` exposes theme, accent color, and text-size controls backed by
  `lib/theme.ts`, which mirrors the desktop theme/accent tokens and applies them
  as CSS custom properties so the companion shares the desktop visual language;
  preferences persist in `collab-mobile-theme`.
- Verification: `pnpm mobile:build` (tsc + Vite) is clean and a new
  `pnpm mobile:test` Vitest suite (7 tests, `apps/mobile-android/vitest.config.ts`)
  covers the format/file-tree helpers and a shell render smoke test (login form
  + bottom nav when no servers are saved; refresh-token session restore that
  lists vaults and surfaces the viewer read-only affordance). On-device/emulator
  QA across a device matrix is deferred to Phase 7.

Phase 2 is complete: the companion has a phone-first shell with hosted login,
a saved-server list, reconnect/disconnect, session restore, a per-server hosted
vault inventory and switcher, a folder-drill-in file browser, viewer read-only
affordances, and theme/accent/text-size settings — all over the shared native
command layer with tokens kept out of the web view. On-device QA across a device
matrix is tracked under Phase 7.

### Phase 3: Offline Replica Read Path

Estimated effort: 3-5 weeks.

Goals:

- Let users mark a hosted vault for offline availability.
- Seed and update the Android replica from the hosted manifest.
- Cache note/Kanban document content.
- Cache required asset bytes for images and PDFs when opened or explicitly saved
  offline.
- Support opening already-cached vaults without network.
- Add sync-status surfaces and pending-operation summaries.

Acceptance criteria:

- A seeded vault can be opened in airplane mode.
- Cached notes and Kanban boards load offline.
- File browser clearly distinguishes cached, not-yet-cached, syncing, and failed
  states.
- Removing an offline copy removes app-local replica data after confirmation.

Current implementation notes:

- Implemented the previously-stubbed Android offline-replica encryption key
  persistence — the blocker for any replica use on device. It reuses the Phase 1
  AndroidKeyStore pattern: a new Kotlin `CollabReplicaKeyStore` (AES-GCM master
  key in AndroidKeyStore, ciphertext in app-private SharedPreferences, its own
  alias/prefs separate from the refresh-token store) with matching proguard keep
  rules, called from `commands/replica.rs`. The key is durable across reboots as
  required, since losing it would orphan all cached content. The low-level JNI
  plumbing shared by both secret stores was extracted into `src-tauri/src/
  android_jni.rs` (`call_static_string`), and `server_token_store.rs` was
  refactored onto it so the two stores do not fork the class-loading logic.
- The mobile app drives the shared native `replica_*` commands directly through a
  new `lib/replica.ts`: `makeVaultAvailableOffline` seeds the manifest
  (`replica_seed` with the raw server manifest so the native store keeps full
  file entries), then downloads active document bodies and asset bytes into the
  replica cache and marks it `offlineAvailableAt`; `removeOfflineCopy` calls
  `replica_delete`; `readReplicaFiles` reads the cached manifest; `fileCacheState`
  reports per-file cache status.
- The Zustand store (`state/store.ts`) tracks offline replicas (`replica_list`),
  per-vault offline progress, and per-file cache state, and — critically — makes
  `loadFiles` fall back to the local replica manifest when the server is not
  connected or a live read fails (airplane mode), setting a `filesOffline` flag.
- UI: the Vaults screen shows an offline availability control per vault ("Save
  offline" with a live progress bar, or an "Offline ✓" chip that opens a
  confirm-to-remove sheet), gated on the `vault.offlineCopy` capability; the file
  browser shows an offline banner when served from cache, per-file `Offline` /
  `Update` cache badges, and cache status in the file detail sheet. A shared
  `ConfirmSheet` backs the destructive "Remove offline copy" confirmation.
- Verification: desktop `cargo check`/`cargo test --lib` (109) stay green, the
  full `src-tauri` lib and shared crates cross-compile for
  `aarch64-linux-android`, `pnpm mobile:build` is clean, and the
  `pnpm mobile:test` suite grew to 10 tests including offline-flow coverage
  (seed+cache+mark-available, offline `loadFiles` replica fallback, and
  remove-offline). On-device offline/airplane-mode QA is tracked under Phase 7.

Phase 3 is complete: users can mark a hosted vault for offline use on Android,
the manifest and active document/asset content are cached in the durable native
replica, seeded vaults open and browse without network, the file browser
distinguishes cached vs not-cached vs syncing states, and offline copies can be
removed after confirmation.

Post-Phase-3 shell polish:

- Android hardware back / back-gesture now navigates in-app instead of closing
  the app: it dismisses an open sheet or document, walks up one folder level,
  returns from a vault root to the Vaults overview, and only then shows the
  app-styled quit confirmation. Navigation state (tab, folder trail, active
  sheet) is centralized in the store. Native `MainActivity.kt` intercepts
  Android back and dispatches a `collab-android-back` DOM event into the React
  shell, avoiding fragile WebView-history behavior.
- Large folders load dynamically instead of hanging: the file list renders in
  pages of 60 with an `IntersectionObserver` "load more" sentinel, and per-file
  offline cache-status checks run only for the revealed rows with bounded
  concurrency (6) that updates each badge as it resolves, so opening a folder with
  many files no longer blocks until every status is fetched.

### Phase 4: Notes MVP

Estimated effort: 4-6 weeks.

Goals:

- Build a mobile note viewer.
- Build a mobile markdown editor.
- Reuse markdown rendering where practical.
- Add a compact mobile toolbar for common markdown actions.
- Save online through hosted document writes.
- Queue offline writes through the replica operation model.
- Preserve dirty/offline/conflict status in the document screen.

Acceptance criteria:

- User can open, edit, save, close, and reopen a note.
- Offline note edits remain visible after app restart.
- Offline edits sync when the server connection returns.
- Hosted viewer-role users cannot edit.
- Conflict or failed-sync states are visible and recoverable.

Implementation note:

CodeMirror should be tested early on Android. If keyboard/selection behavior is
poor, use a simpler textarea-based editor for the MVP and reserve CodeMirror for
later.

Current implementation notes:

- Started Phase 4 with a mobile note document screen opened from the file
  browser for hosted Markdown/note documents. The screen uses a textarea editor
  for the MVP, plus a sanitized `markdown-it` preview, so Android keyboard and
  selection behavior stays simple while the document flow is validated.
- Added typed mobile note helpers for online hosted reads/writes and cached
  replica reads. Opening a note reads through `hosted_vault_request` when online
  and warms the native document cache; when offline it falls back to
  `replica_read_cached_document` if available.
- Online saves post a new hosted text revision with the current revision
  sequence, update the file-browser entry from the server response, and refresh
  the local document cache. Viewer-role vaults can open notes but do not see edit
  or save controls.
- Hardened the mobile Markdown preview toward desktop parity for the common note
  surface: soft line breaks, KaTeX inline/display math, plot directives,
  highlighting, task lists, code highlighting, wikilinks, vault-relative links,
  cached/hosted image assets, document-backed SVG images, bundled Nerd Font
  glyphs, and tighter heading/list/table spacing.
- Added lazy, sanitized Mermaid fence rendering through the shared
  `src/lib/mermaidRenderer.ts` pipeline. Desktop rendered preview, desktop
  CodeMirror live preview, and the mobile note viewer now render `mermaid`
  fenced blocks with current theme/accent colors and retain the source as a
  readable fallback when a diagram is invalid.
- Replaced the textarea MVP with a mobile-focused CodeMirror editor. The editor
  applies desktop-aligned indentation controls (`spaces`/`tabs` and tab width),
  inline color previews, Markdown syntax highlighting, search/history basics,
  and the shared ASCII arrow ligature decorations while keeping the mobile shell
  separate from desktop-only live-preview/autocomplete integrations.
- Wired note writes into the replica pending-operation model and a sync replay
  path, completing the Phase 4 acceptance criteria. New mobile IPC wrappers
  (`replicaEnqueueOperation`, `replicaListPendingOperations`,
  `replicaUpdateOperationStatus`, `replicaRecordOperationFailure`,
  `replicaRemoveOperation` in `mobileTauri.ts`) reuse the same shared native
  `replica_*` queue the desktop uses, so both clients replay through one store.
- `lib/sync.ts` owns the offline write model: `enqueueNoteEdit` caches the edited
  body into the replica document cache (so an offline edit is visible on reopen,
  even after an app restart) and appends a coalesced `edit` operation — any
  earlier queued edit for the same file is dropped so a chain of offline edits
  never self-conflicts on its revision sequence. `replayPendingOperations`
  re-posts queued edits as hosted document revisions, removing each on success,
  leaving it queued on a connectivity error, and recording a classified,
  recoverable failure (`revision_conflict`, `permission_revoked`, etc.) when the
  server rejects it. `retryPendingOperation`/`discardPendingOperation` back the
  recovery actions.
- Replay is triggered automatically when a vault's own server (re)connects:
  `store.syncServer` replays every replica belonging to a connected server and is
  called from `restore` (startup), `connect`, `reconnect`, and on app foreground
  (`MobileApp` focus/visibility), matching the "sync on foreground and explicit
  action" guidance since Android may suspend background work.
- `NoteScreen` now saves offline: a save while disconnected (or a live write that
  fails purely for connectivity) queues the edit and clears the dirty state,
  showing a "Queued offline" banner; a failed sync shows a "Couldn’t sync this
  note" banner with the failure reason and Retry/Discard actions. The header
  status reflects `Queued to sync` / `Sync failed`. Viewer-role vaults still see
  no edit or save controls. The Vaults screen surfaces per-vault pending counts.
- Verification: `pnpm mobile:build` (tsc + Vite) is clean and `pnpm mobile:test`
  grew to 28 tests, adding `lib/sync.test.ts` (connectivity vs. real-failure
  classification, offline enqueue + coalescing + content caching, successful
  replay removal, recorded conflict failure, connectivity requeue, and per-file
  pending listing). Two-client offline-convergence device QA is tracked under
  Phase 7.

### Phase 5: Kanban MVP

Estimated effort: 3-5 weeks.

Goals:

- Build a mobile-first Kanban board view.
- Prefer column drill-in and card detail screens over desktop-style wide boards.
- Support card title, description, status/column, checklist, tags, due dates, and
  comments if already represented in the document schema.
- Support online save and offline queued mutation.
- Keep drag-and-drop optional; buttons/menus are acceptable for v1.

Acceptance criteria:

- User can view boards on a phone without horizontal desktop-board dependence.
- User can create/edit/move cards with touch-friendly controls.
- Offline card edits queue and sync.
- Viewer-role users cannot mutate boards.

Current implementation notes:

- Added a mobile-first Kanban board screen (`screens/KanbanScreen.tsx`) opened
  from the file browser for `.kanban` documents. It deliberately avoids the
  desktop wide-board layout: columns are a horizontally scrollable chip strip
  (each with a card count), and the selected column's active cards render as a
  vertical, touch-friendly list. Tapping a card opens a bottom-sheet detail
  editor. There is no horizontal desktop-board dependence.
- The board document model is shared, not forked: `lib/kanban.ts` reads/writes
  the `.kanban` JSON text document through the same hosted text-document +
  offline-replica path the notes MVP uses, and reuses the desktop
  `src/types/kanban.ts` schema, `normalizeKanbanBoard`, and `setCardDoneState`
  (recurring-card spawning included). Only small, pure, touch-oriented board
  mutation helpers (add/move/remove card, tags, checklist, comments,
  done-toggle) live in the mobile lib, and they are unit-tested.
- Card detail supports title, description, column move, priority, start date,
  due date, done state, tags (add/remove chips), a checkable checklist with
  add/remove, and comments (view + add, authored with the effective hosted
  identity from the connected server session and a deterministic presence color
  via the shared `userColorForId`). Drag-and-drop is intentionally omitted for
  v1 — moving a card is a column chooser in the detail sheet — matching the
  "buttons/menus are acceptable" guidance.
- Touch-first board interactions: swiping the card area left/right pages between
  columns with a direction-aware slide-in animation (reduced-motion opt-out).
  Only the active column is rendered, so the pager height always matches the
  current column — the bottom dot indicator sits directly beneath it with no
  dead scroll on short columns. The top column chip strip scrolls the active
  column into view as you paginate; a header
  filter/sort panel applies a view-local text filter and a sort (priority, due
  date, title, created, or manual) without mutating stored order; priority is
  shown as a colored chip on cards and the priority selector colors itself per
  level; column chips, the move-to-column chooser, and the column dots all
  reflect each column's own color; and the tag editor suggests existing board
  tags (filtered by what you type) for one-tap reuse.
- Dates use a custom in-app calendar (`components/DateField.tsx`) styled to the
  app's sheet/visual language rather than the platform `<input type="date">`
  chrome — a month grid with prev/next navigation, min/max range enforcement
  (start ≤ due), and Today/Clear actions.
- Editing reuses the Phase 4 offline write model end to end. Board mutations
  schedule a debounced (`500ms`), serialized save that posts a hosted revision
  when connected and otherwise queues a coalesced `edit` operation through the
  shared native replica queue via the generalized `enqueueDocumentEdit`
  (`enqueueNoteEdit` is now a thin alias — the queue is content-agnostic, so
  notes and boards replay through one store). Offline board edits are cached to
  the replica document cache (visible on reopen after restart) and replay
  automatically when the vault's server reconnects (`store.syncServer`). The
  header shows `Saving…` / `Saved` / `Queued to sync` / `Sync failed` / `Cached
  board`, and a failed sync surfaces the same Retry/Discard recovery banner as
  notes.
- Viewer-role vaults open boards fully read-only: no add-card control, no
  move/priority/tag/checklist/comment/delete affordances, inputs are
  `readOnly`, and `commitBoard`/save are guarded so a viewer never attempts a
  write.
- Verification: `pnpm mobile:build` (tsc + Vite) is clean and `pnpm mobile:test`
  grew to 37 tests, adding `lib/kanban.test.ts` (document recognition,
  parse/serialize round-trip with normalization and invalid-content fallback,
  add/move/remove cards, tags/checklist/done/comment mutations, board-tag
  collection plus non-mutating view filter/sort, online read with replica
  cache-warming, offline cache fallback, and hosted-revision save against the
  current sequence). Two-client offline-convergence device QA remains tracked
  under Phase 7.

### Phase 6: Viewer-Only Rich Files

Estimated effort: 3-6 weeks.

Goals:

- Add image viewer with pinch/zoom/pan and cached asset reads.
- Add PDF viewer with basic page navigation and zoom.
- Add canvas viewer using a read-only, pan/zoom-friendly renderer.
- Add logic diagram viewer using the existing source/export rendering concepts.
- Avoid edit controls for these file types in the initial mobile product.

Acceptance criteria:

- PDFs, images, canvases, and logic diagrams can be opened from the mobile file
  browser.
- Viewers work with cached content where available.
- Unsupported or uncached files fail clearly rather than pretending to be synced.
- No viewer exposes edit/save actions in the MVP.

Current implementation notes:

- Started Phase 6 with a shared mobile asset-loading path
  (`apps/mobile-android/src/lib/assets.ts`) used by both markdown previews and
  standalone rich-file viewers. Asset-backed files load through the native hosted
  asset command when connected, warm the replica asset cache, and fall back to
  cached replica bytes when offline. Document-backed SVGs load through hosted
  document reads and fall back to the cached document body, matching how note
  images resolve SVGs.
- Added a read-only rich-file viewer route from the mobile file browser and from
  note vault links. Images open in a full-screen viewer with zoom controls and
  two-finger pinch zoom. PDFs open in a pdf.js-backed canvas viewer with shared
  zoom controls. Both surfaces show clear loading, cached-copy, and error states;
  they expose no edit/save actions.
- Added the first landscape pass for the mobile shell: wide screens use the full
  display width and move primary navigation to a left rail so document viewers
  have usable horizontal space. PDF pages now fit to the viewer stage by default
  and zoom from that fitted size instead of rendering at raw PDF units.
- Refined the mobile PDF viewer toward the desktop interaction model: the PDF
  layout can switch between `Single` and `Scroll`, fit-width is the default page
  scale, previous/next buttons were removed, and single-page mode changes pages
  with horizontal swipe gestures.
- Reduced rich-file blocking in large folders: eager offline cache-status checks
  skip large assets so folders full of multi-megabyte PDFs do not decrypt/hash
  every visible PDF just to draw badges. Large assets are still checked/loaded on
  open, and explicit offline availability still caches them. PDF base64 decode
  now yields between chunks to avoid one long UI-thread loop when opening larger
  files.
- The current Phase 6 slice intentionally covers real visual viewers only:
  raster/SVG images and PDFs. Canvas and logic diagram viewers remain the next
  Phase 6 slices because they need actual read-only node/wire rendering with
  pan/zoom rather than a misleading JSON fallback.

### Post-Phase 6: Mobile Management And Kanban Parity

Status: Complete.

- Hosted server entries can be edited, including URL and the explicit untrusted
  TLS certificate opt-in. Re-authentication is required when applying changes.
- The mobile settings include the same always-create-offline-copy preference;
  selecting an eligible hosted vault automatically starts replica creation.
- The file browser can create notes, upload the supported Collab file types,
  download individual files, download folders as ZIP archives, and export the
  full vault. Every action is hidden or rejected according to the current
  hosted capability grant.
- Android picker sources and destinations use Tauri's Android-aware filesystem
  API so Storage Access Framework `content://` locations work for uploads and
  downloads.
- Kanban columns can be added, renamed, recolored, configured, reordered, and
  deleted when empty. Cards can be archived/restored, and the mobile board now
  includes Calendar, Timeline, and Archive views.
- Follow-up mobile polish keeps server editing attached to its server row,
  supports per-server Default/Always/Never offline-copy behavior, and replaces
  per-row download controls with long-press multi-selection. Kanban view and
  column controls remain compact, while Calendar and Timeline use real month
  and day-scale layouts. Scrollable sheets render above the bottom navigation.

### Phase 7: Android Hardening And Release Prep

Estimated effort: 4-8 weeks.

Goals:

- Test app lifecycle: foreground, background, kill, restart, network loss,
  airplane mode, and device sleep.
- Maintain Android build and signing/release documentation
  (`android-companion-build.md`, `android-play-release.md`).
- Add basic crash/error logging strategy.
- Validate hosted TLS/session behavior against public reverse proxies.
- Add device matrix testing for small/large phones and tablets.
- Add release checklist and user-facing limitations.

Acceptance criteria:

- Android release build can be produced reproducibly.
- Manual QA checklist covers login, offline open, offline edit, sync recovery,
  viewer files, and permission boundaries.
- Known limitations are documented.
- The app is safe to distribute to a small internal/beta group.

Current background-lifecycle hardening is in testing. Shared coordinator
recovery now survives old settings/ledger records, server and replica removal
cancel only matching work, WorkManager defers routine sync for low storage, and
worker errors are bounded and redacted. The packaged/physical matrix and
troubleshooting steps live in
[Background Running Release Validation](../build/background-running-release-validation.md).
Notification-backed foreground transfers remain a release dependency for large
explicit uploads/downloads and are not implemented as unrestricted routine
WorkManager jobs.

### Phase 8: Later Expansion

Deferred until the Android MVP proves useful.

Candidates:

- Broader live editing for rich file types if mobile authoring demand justifies
  it.
- Android background sync with OS constraints respected, tracked
  cross-platform in the [Background Running Plan](./background-running-plan.md).
- iOS feasibility and build pipeline.
- Better PDF search/annotations.
- Lightweight canvas or logic editing, only if mobile usage justifies it.
- Mobile capture flows such as quick note, share-to-vault, and camera/image
  upload.

## Major Risks

- **Tauri mobile maturity:** the spike must prove the exact primitives Collab
  needs, not just that a demo app runs.
- **Mobile editor ergonomics:** markdown editing is only useful if keyboard,
  selection, toolbar, and scrolling behave well on real devices.
- **Offline correctness:** queued operations and conflict states must remain
  boring and reliable; this is more important than feature count.
- **Background sync limits:** Android may delay or stop background work. The MVP
  should sync on foreground and explicit user action first.
- **Large file performance:** PDFs, canvases, and images may need mobile-specific
  render limits.
- **Code sharing pressure:** sharing business logic is good; sharing desktop UI
  layout is not.

## Recommended Implementation Order

1. Land Phase 0 as a spike branch and record the result in this document.
2. If Tauri mobile is viable, extract shared Rust client/replica crates before
   building feature UI.
3. Build Android shell and server/vault access.
4. Implement offline read-only vault browsing.
5. Add note editing.
6. Add Kanban editing.
7. Add viewer-only rich files.
8. Harden for beta distribution.

## Definition Of A Useful MVP

The mobile companion is useful when a hosted-vault user can:

1. Open the Android app without re-entering credentials.
2. Open a hosted vault.
3. Read notes and Kanban boards offline.
4. Edit a note offline.
5. Edit a Kanban card offline.
6. Reconnect and sync those edits without manual recovery in the normal case.
7. Open PDFs, images, canvases, and logic diagrams as read-only references.

Anything beyond that should wait until the companion workflow is proven in real
daily use.
