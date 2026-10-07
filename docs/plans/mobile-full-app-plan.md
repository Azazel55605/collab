# Full Mobile App Overhaul

Reviewed: 2026-10-07. Status: **Planned**; source audit complete, implementation
has not started. [Open Development Work](./open-development-work.md) owns the
consolidated status. This plan supersedes the expansion bucket in the
[Android Companion App Plan](./android-companion-app-plan.md), while retaining
its outstanding device and release gates.

## Product Direction

Make Android a daily-use Collab application that works without a server and
adds hosted collaboration when connected. Keep Tauri, the mobile React shell,
shared Rust document models, and the existing native authentication/replica
boundaries. A desktop shell copied onto a phone would not meet this goal.

Android is the first delivery target. iOS gets a separate feasibility decision;
its storage, background execution, sharing, notifications, signing, and release
requirements need their own implementation and device evidence.

A full mobile product means:

- Create, import, browse, edit, search, recover, and back up local vaults without
  signing in. Existing local calendars remain usable independently.
- Use all internal document formats through deliberate phone/tablet workflows,
  with honest limits and safe preservation of unsupported content.
- Keep edits durable through process death, storage failures, and reconnect;
  explain saved, pending, blocked, conflicted, and read-only states.
- Connect multiple servers, manage the correct server account, use permitted
  offline copies, and collaborate without mixing identities or cached data.
- Receive and share files through Android, support accessible touch and keyboard
  input, and remain usable on small phones and larger tablets.

The teams/chat/library program is scheduled before this overhaul so the mobile
app consumes its shared contracts. Its mobile integration is governed by the
[Teams, Chats, And Shared File Libraries Plan](./teams-chat-and-file-sharing-plan.md).
Live voice/video calls remain deferred. A SharePoint-like browser portal is a
separate product stream, not a prerequisite for standalone mobile delivery.

## Audited Starting Point

The current app has five tabs: Servers, Vaults, Files, Calendar, and Settings.
Vault selection is a hosted server/vault pair; document screens load and save
through hosted wrappers. Offline replicas are server copies, not independent
local vaults. Native local commands being registered on Android does not prove
that their desktop path assumptions or lifecycle are Android-safe.

| Area                          | Existing behavior                                                                              | Required expansion                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Vaults and files              | Hosted browsing/search, creation, uploads, selections, ZIP download, offline copies and replay | App-private vault catalog, local operations, recovery, source-aware navigation and portable backups     |
| Notes and Kanban              | Editable mobile screens with hosted/offline behavior                                           | Local adapters; richer note references, embeds, authoring and export; preserve board workflows          |
| `.sheet`                      | Values/formulas, formatting, touch grid and range summaries                                    | Structure, charts, protection, data tools and bounded conversion workflows                              |
| `.ink`                        | Drawing, eraser, pan, undo/redo, page/layer controls                                           | Audit remaining object, transform, stylus and export workflows; deepen existing controls                |
| `.deck`                       | Viewing, presenting, speaker notes, following and remote control                               | Touch authoring for slides, text, objects and layout; retain presentation behavior                      |
| Canvas, logic, SVG            | Canvas viewer; logic rendering and bounded electrical-property/analysis editing                | Canvas authoring, schematic construction/wiring, dedicated SVG editing                                  |
| PDF and images                | Viewing, PDF page rendering/navigation and asset caching                                       | Annotation, OCR, image editing and explicit export workflows                                            |
| Accounts                      | Server-specific profile editing, avatar/password changes and server switching                  | Preserve account scope across new navigation and incoming links; account remains optional for local use |
| Calendars and system features | Local calendar definitions, hosted synchronization, notifications, widgets and background jobs | Local document attachments, location-aware routes, device validation and lifecycle hardening            |
| Previews                      | Shared internal summary renderer and server cache exist                                        | Android file-list thumbnails, bounded client caching and measured mobile performance                    |

Evidence: `apps/mobile-android/src/MobileApp.tsx`, `state/store.ts`,
`mobileTauri.ts`, `screens/{Files,Note,Kanban,Sheet,Ink,Deck,RichFileViewer,Calendar,Settings}Screen.tsx`,
`src/lib/vaultClient.ts`, and `src-tauri/src/commands/vault.rs`.
The current Android manifest and `MainActivity.kt` route launcher, widget and
notification intents; general incoming document/share routing is still needed.

## Architecture Decisions

### Vault and document boundaries

Use a discriminated local/hosted location with a stable vault key. A document
reference contains location, relative path, kind and revision; a hosted UUID is
optional transport identity. Account and server identity must be part of hosted
cache/session keys. Define rename/move semantics explicitly so recent files,
calendar attachments, widgets and references retain valid targets.

Start from the existing `src/lib/vaultClient.ts` local/hosted capability contract.
Extract portable contracts where necessary instead of building a competing
mobile protocol or importing desktop stores into the mobile shell. Android
storage adapters live behind typed native wrappers. Shared domain crates stay
free of Tauri, concrete storage, Axum and SQLx. Live sessions, permissions,
offline replicas and server membership are hosted capabilities.

Provide shared mobile document-session hooks for loading, validation, autosave,
optimistic hash checks, conflicts, recovery and asset resolution. Local writes
commit to local storage; hosted writes retain the existing replica/outbox and
server authorization. A connectivity failure and a revoked permission must
remain distinguishable. Never silently overwrite a conflict or upload a local
vault when an account is connected.

### Android storage and security

Use app-private vaults as the first authoritative local storage. Persist a
versioned catalog under the Tauri app data/config directory; replace desktop
`HOME`/`APPDATA` recents assumptions through an injected platform boundary.
Define atomic file writes, catalog repair, index rebuild, history/trash retention,
low-space behavior, encryption unlock and explicit backup/restore.

Use Storage Access Framework for explicit import/export first. Provider URIs,
revocable grants and provider-specific operations require an adapter; they
cannot be passed to path-based Rust commands as ordinary paths. A future
externally backed vault needs its own feasibility gate. See
[Android document access](https://developer.android.com/training/data-storage/shared/documents-files).

Keep authentication and encryption secrets in native storage. Validate vault
paths, archive paths and incoming URIs; bound archive expansion and document
parsing. Backups must specify whether they include history, attachments and
metadata, and how encrypted vaults are restored on a different device without
the original Keystore. Document app-data deletion/uninstall consequences.
Permission changes, logout and offline-copy removal must clear the appropriate
account-scoped caches without silently losing unsynchronized edits.

### Mobile interaction and platform integration

Make local creation/import available on first launch; connecting a server is
optional. Design location switching, recents and search before deciding the
final bottom navigation. Use capability-driven actions with clear reasons for
unavailable operations. Retain the shared UI primitives and theme language;
use mobile sheets, touch targets and document toolbars rather than desktop
menus squeezed into a WebView.

Define Back, keyboard dismissal, unsaved recovery, rotation, split screen,
safe areas and tablet layouts per workflow. Incoming files and links require
explicit destination selection and validation, including when the process is
cold or an account is locked. Follow Android's
[receiving shared content guidance](https://developer.android.com/develop/ui/compose/sharing/receive).
Keep native changes reproducible through the existing Android preparation/build
scripts, rather than relying on edits lost during project regeneration.

Background work stays within the existing native job boundary. It cannot
promise continuous synchronization; use documented
[persistent-work constraints](https://developer.android.com/develop/background-work/background-tasks/persistent)
and preserve the existing widget/notification release matrices.

## Delivery Phases And Acceptance Gates

All phases below are **Not started**. Deliver focused PRs; record evidence in
this plan and move consolidated status in Open Development Work. Device,
accessibility and durability checks run throughout, not only at the end.

### Phase 0 — Contract And Device Baseline

Inventory each screen's hosted assumptions and desktop commands available on
Android. Freeze location/file/session contracts, capability rules, reference
migration, backup format and encryption recovery policy. Prototype one local
note through the native boundary. Record minimum supported devices, current
SDK/plugin constraints, low-memory fixtures and performance baselines.

Gate: local and hosted adapters satisfy the same meaningful lifecycle scenarios;
unsupported capabilities are explicit. Save/load and process recreation are
proven on a physical Android device. Confirm the sequence and size remaining
editor projects from this evidence before giving calendar estimates.

### Phase 1 — Standalone Vault Core

Implement app-private create/open/rename/delete, a durable catalog, first-launch
local onboarding, location switching, local browsing and note editing. Add
bounded import/export, backup/restore, unlock/lock and recovery. Wire local
calendar attachments to the common document identity. Use reversible deletion
or a clear confirmation and recovery boundary for destructive operations.

Gate: without a server, create and edit a note, restart/kill the process, reopen,
rename/move, trash/restore, export and import into a fresh installation. Repeat
for plain/encrypted vaults, interrupted writes, low storage and catalog repair.
Hosted login, viewer permissions, offline edits and reconnect remain green.

### Phase 2 — Existing Editor Migration

Move notes, Kanban, sheet, ink, deck viewing and rich-file viewers onto the
common document boundary. Generalize asset lookup, links, creation, editor
state and saved/pending/conflict indicators. Preserve existing hosted live
sessions, remote presentation control and server-specific account settings.

Gate: note, board, workbook and drawing create/edit/save/reopen round trips work
locally and hosted, including supported offline edits. View deck/PDF/image/
canvas/logic fixtures in each permitted source. Unsupported fields survive
editing; readonly documents cannot mutate. Test two servers with matching vault
IDs, late responses after location switching, auth expiry and pending drafts.

**Milestone: standalone core.** Android is independently useful with its
existing editors; richer authoring is still explicitly limited.

### Phase 3 — File Workflows And Previews

Add consistent organization, rename/move/duplicate, native bounded indexing and
search, references, history, trash and recovery UI. Audit what hosted file
management already offers before replacing it. Add Android file-list thumbnails
using the existing summary renderer/server cache, with visible fallback states,
virtualized loading, cancellation and bounded account-scoped caches.

Measure cold/warm generation, transfer, memory and scroll behavior before
setting budgets. Preview freshness follows revision/renderer changes; no eager
whole-vault generation on login. Honor offline permissions and cache removal.
Scene-faithful and server PDF/image preview work remains a separate dependency
in [Open Development Work](./open-development-work.md#document-preview-expansion).

Gate: search, references, history and trash work across local/hosted sources;
malformed documents and denied previews do not break browsing. Measured fixture
results demonstrate bounded memory and useful scrolling on the baseline phone.

### Phase 4 — Touch Authoring Expansion

Deliver editor projects separately, each with a support matrix and documented
limits. Prioritize notes and common document workflows first; measure usage
before locking the order of the larger visual editors.

- Notes: references/backlinks, attachments, embeds, richer authoring and export.
- PDF/image: selection, highlights/comments/ink, OCR controls, sidecar recovery,
  original preservation and explicit annotated/permanent exports.
- Sheets: structure and selection, charts/data tools/protection, `.sheet`
  persistence and bounded XLSX/CSV conversion with honest loss reports.
- Ink: remaining object/transformation, stylus, layer/page and export depth,
  building on the controls already present.
- Canvas/logic/SVG: touch selection, pan/zoom, nodes/edges, inspectors, wiring,
  transforms and safe exports; retain existing circuit-analysis boundaries.
- Decks: slide management, text/object editing, assets, layout/theme essentials,
  undo/redo, save/recovery and exports; retain mobile presentation/remote modes.

Gate per editor: meaningful authoring round trips preserve canonical data,
references and unsupported content; undo/redo and recovery survive lifecycle
changes; touch, keyboard and assistive-technology workflows work on phone and
tablet. Local/hosted/offline tests cover whichever capabilities the format
supports. Desktop scientific/export semantics stay in shared domain logic.

**Milestone: daily-use mobile app.** Core mobile authoring and recovery are
complete against an explicit support matrix, rather than a claim of unlimited
desktop parity.

### Phase 5 — Integrate Shared Collaboration

Consume vault chat, direct/group conversations and teams delivered through the
shared teams/chat program; do not rebuild their server model in this overhaul. Specify pagination, unread
state, notification routing, offline send/retry deduplication, attachment
permissions, retention and permission changes before mobile UI implementation.
Integrate shared file libraries only once their server ownership and access
contracts exist. Link backend milestones to the teams plan rather than creating
Android-only teams or treating existing administrative user groups as teams.

Gate: multi-account isolation, membership revocation, ordered reconnect,
duplicate-send protection and notifications work against disposable live server
data with two independent clients. Calling/video remain outside this phase.
This phase may follow the standalone release; it does not block local use.

### Phase 6 — Android Integration And Release

Apply release gates to every milestone. Platform integration can proceed after
Phase 2 alongside editor expansion; a standalone release does not wait for all
Phase 4 editors or Phase 5 collaboration. Required storage intake and backup
flows must already pass the Phase 1 gate.

Finish document share/open intents, SAF import/export, destination selection,
camera/media capture and cancellation, widgets/deep links and source-aware
notification routing. Add tablet/adaptive layouts, accessible labels/focus,
TalkBack, external keyboard and stylus coverage. Verify all native changes
survive Android project regeneration.

Run fresh-install/upgrade/restore and schema-migration checks, signed APK/AAB
builds, current Play policy/privacy review, public reverse-proxy checks, error
reporting policy, and physical lifecycle/network/storage/resource tests. Carry
forward the companion Phase 7 and existing calendar/sheet/ink/deck/background/
widget release matrices; reuse evidence without declaring untested rows green.

Gate: documented device evidence for process death/reboot, offline/reconnect,
expired auth, denied/revoked provider grants, canceled/duplicate imports, large
fixtures, encrypted restore and long background soaks. Release notes and user
docs explain storage, backups, sync states and format limits. Rollout has a
migration recovery path and does not make user data depend on server availability.

### Separate Decision — iOS

After the common contracts are proven, assess Tauri plugin support, sandboxed
storage and Keychain, document picker/provider integration, share extensions,
background limits, notifications, widgets, signing and App Store requirements.
Create an iOS plan and physical proof before claiming iOS support. Android
WorkManager, Keystore and intent code do not establish that proof.

## Verification And Tracking

For implementation, run the repository's frontend, admin, Rust workspace,
mobile, type/build, version and boundary checks required by `AGENTS.md`.
Storage/backend work also requires disposable PostgreSQL integration tests and
Compose/server smoke checks. Never use real identity tables for destructive
test setup. Update `docs/desktop/codebase.md` whenever shared/native structure
changes, and update mobile build/user/release documentation with each capability.

Maintain a matrix covering local plain/encrypted, hosted online, permitted
cached offline, viewer, pending/conflicted edits, account switch and permission
revocation. Automated tests establish protocol/durability behavior; browser
mocks cannot establish Android URI, Keystore, stylus or process-lifecycle behavior.

Largest risks are storage-provider semantics, encryption/backup recovery,
regressing hosted replay, large-document memory and unusable touch controls.
Mitigate through the local vertical slice, staged editor delivery and maintained
physical fixtures. Scheduling remains unestimated until Phase 0 establishes
these boundaries; the earlier assessment's rough effort figures are retired.
