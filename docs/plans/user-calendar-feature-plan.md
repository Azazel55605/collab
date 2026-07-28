# User Calendar Feature Plan

## Summary

Add an account-level calendar system to Collab across desktop, Android, and the
standalone server. Calendars are user resources, not vault documents:

- Local calendars belong to the desktop user's local Collab profile and live in
  native app-config storage.
- Hosted calendars belong to the authenticated user account on one Collab
  server and are available to every client signed in to that server.
- A client may be connected to several servers at once and present calendars
  from all of them in one view without merging the server identities.
- Every hosted calendar has an offline local replica so desktop and Android can
  browse and edit it while disconnected.
- Users may explicitly mirror a calendar between local storage and one or more
  servers. Servers do not exchange credentials or synchronize directly; a
  signed-in Collab client bridges the selected locations.
- Kanban cards assigned to the current user appear through a generated
  "Assigned tasks" calendar without copying the card into an unrelated event.
- iCalendar (`.ics`) import/export and subscriptions are supported. Full
  bidirectional third-party synchronization is handled through CalDAV or a
  provider API, because iCalendar by itself is a file/feed format rather than a
  two-way synchronization protocol.

The target experience should feel familiar to users of Google Calendar, while
keeping Collab's multi-server model, offline behavior, and native token boundary
intact.

## Effort And Delivery Shape

This is a large cross-client feature, not a single calendar component.

- Core MVP: local and hosted calendars, offline sync, desktop month/week/day and
  agenda views, complete event editing, hosted Collab-user attendees, linked and
  uploaded attachments, Android view/edit support, and private admin usage
  metrics: approximately 18-26 engineer-weeks.
- Full target in this plan: cross-location mirroring, Kanban task projection,
  reminders/notifications, robust recurrence, location lookup, iCalendar feeds,
  CalDAV interoperability, and production hardening: approximately 32-46
  engineer-weeks.
- Shared calendars, meeting invitations, free/busy lookup, room booking, and
  provider-specific OAuth integrations should follow as separate expansions.

The work should land in independently testable phases. Desktop and Android must
share the domain and sync implementation instead of creating separate calendar
models.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 0. Domain contract and interoperability spike | Complete | RFC 5545 selection, fixtures, bounded recurrence, and deterministic edit-scope operations are implemented. |
| 1. Shared calendar domain and local profile store | Complete | Canonical model, native profile database, bounded recurrence queries, migrations, tombstones, and operation log are implemented. |
| 2. Hosted server calendar domain | Complete | User-owned PostgreSQL storage, authenticated APIs, invitations, attachments, quotas, private aggregate usage, maintenance, and live database coverage are implemented. |
| 3. Multi-server offline sync | Complete | Desktop and Android sync independent hosted replicas with durable cursors, queued/conflicted operations, lifecycle triggers, progress, and guarded cache removal. |
| 4. Desktop calendar experience | Complete | Global Calendar navigation, everyday event/task workflows, hosted collaboration controls, typed attachments, defaults, and accessibility coverage are implemented. |
| 5. Android calendar experience | Complete | Phone-first multi-server views, profile storage, offline editing/deletion, recurrence scopes, collaboration, attachments, management, and actionable recovery are implemented. |
| 6. Cross-location calendar mirroring | Testing | Mirror groups, deterministic client bridging, tombstones, isolated retryable failures, global progress visibility, and desktop/Android conflict resolution are implemented; physical-device end-to-end validation remains. |
| 7. Kanban assigned-task integration | Complete | Local and hosted assignment projection, generated read-only calendars, REST/live materialization, narrow date/completion/recurrence write-through, source lifecycle handling, and access-loss privacy cleanup are implemented and covered. |
| 8. iCalendar import, export, and subscriptions | Complete | Desktop range/item export, desktop and Android bounded import/export, local and hosted read-only HTTPS subscriptions, scheduled conditional refresh, revocable publication links, safe extension preservation, provider/time-zone fixtures, and SSRF/parser hardening are implemented. |
| 9. CalDAV and external two-way sync | Testing | Hosted discovery, collections, reports, sync tokens, ETags, writes/deletes, recurrence resources, revocable app passwords, and shared change-log convergence are implemented; maintained external-client interoperability testing remains. |
| 10. Admin overview, privacy verification, and hardening | Testing | Aggregate-only administration, runtime quota/rate controls, usage warnings, subscription health, bounded recurrence, retention coverage, and deterministic multi-server soak tests are implemented; physical-device and full restore drills remain. |
| 11. Reminder delivery and notifications | Testing | Shared native inbox/schedule persistence, bounded reminder reconciliation, desktop delivery, and Android native delivery are implemented; packaged desktop and physical Android validation remain. |

Phase 11 is detailed in the cross-platform
[Notification System Plan](./notification-system-plan.md), with lifecycle and
scheduled execution supplied by the
[Background Running Plan](./background-running-plan.md).

### Implementation Status (2026-07-23)

Landed in the first implementation slice:

- Added the shared TypeScript calendar contract in `src/types/calendar.ts` for
  local, hosted, subscription, and generated Kanban locations; event, task, and
  birthday items; date-only and timed values; reminders; recurrence payloads;
  source bindings; and idempotent operations.
- Added strict date, offset timestamp, IANA time-zone, all-day range, size, and
  bounded-query validation with focused Vitest coverage.
- Added the shared `collab-calendar` Rust crate and a profile-scoped SQLite store
  at `{app_config_dir}/profiles/{profileId}/calendar.sqlite`.
- Added structured calendar/item indexes, pending operations, sync-state schema,
  read-only enforcement, atomic item-plus-operation writes, operation retry
  idempotency, and optimistic revision conflict checks.
- Registered typed native commands and matching desktop/Android wrappers for
  listing/saving calendars, range queries, item writes/deletes, bounded search,
  pending-operation acknowledgement, and sync-state persistence.
- Added atomic item tombstones, sync cursor/error round-tripping, and operation
  acknowledgement coverage to the shared Rust store.
- Added a shared Zustand calendar store with profile initialization, a default
  local calendar, visible-calendar filtering, range loading, event creation,
  and tombstone-backed deletion.
- Added the first desktop Calendar activity entry and a store-backed month view
  with multiple local calendars, a selected-day agenda, visibility controls,
  event creation, and event deletion.
- Kept the desktop Calendar inside the vault-open application shell by product
  decision. Android remains the client where calendars must be available
  without opening a vault.
- Made the desktop layout container-responsive so narrow work areas no longer
  squeeze the month grid between fixed panels, and bounded month-row growth on
  tall windows.
- Added touchpad/mouse-wheel period navigation plus Month, Week, Agenda, and
  Year views.
- Replaced the placeholder Week columns with a 24-hour schedule, a sticky
  all-day lane, overlap-safe timed event columns, a current-time marker,
  keyboard/double-click creation at a specific hour, and working-hours initial
  positioning.
- Added a dedicated timed Day view using the same all-day, overlap, current-time,
  keyboard creation, and working-hours behavior while preserving Agenda as the
  compact selected-day list.
- Added 15-minute drag-to-reschedule for timed events and tasks across Day and
  Week columns, preserving event/task duration and due-only task semantics.
  Recurring drops require an explicit occurrence, following, or series scope
  before saving through the normal offline/sync mutation path.
- Extended drag-to-reschedule to all-day events, tasks, and birthdays. Multi-day
  events preserve both their span and the specific visible segment grabbed by
  the user when moved between Week lanes.
- Added 15-minute timed resize handles in Day and Week views. Pointer dragging
  shows a live duration preview, keyboard arrows adjust the focused handle, task
  resizing updates its deadline, and recurring changes use the same explicit
  edit-scope confirmation.
- Bounded calendar drag previews to a compact, interface-scale-aware footprint
  so long events and tasks no longer obscure the active drop-time indicator.
- Restricted timed-item dragging to the event body so the separate duration
  handle always starts a resize rather than a native element drag.
- Kept the optimistic resize preview visible until the saved calendar item
  reflects the new duration, removing the flash back to the previous time range.
- Isolated item-editor form hydration from background calendar-store updates so
  sync progress and refreshed calendar metadata cannot overwrite an in-progress
  event, task, or birthday draft.
- Added date and item context menus for creating events, tasks, and birthdays,
  and for editing or deleting existing entries.
- Added SQLite busy-wait handling, serialized profile initialization, and range
  loading only after initialization to prevent concurrent startup locks.
- Added calendar management in the desktop sidebar. Writable calendars can be
  renamed, recolored, archived, and restored; archived calendars remain
  recoverable without contributing visible items.
- Moved the new-calendar default time zone into the main Calendar settings and
  added a searchable selector backed by the runtime's supported IANA time-zone
  list. Existing calendars retain their stored time zone.
- Added an atomic calendar-definition-plus-operation write boundary so hosted
  calendar setting and archive changes remain replayable when the server is
  offline, while local calendar changes remain profile-local.
- Added bounded profile-wide desktop search across cached local and hosted
  events, tasks, and birthdays with calendar color and origin context.
- Added a dedicated Tasks view with open/completed grouping, period navigation,
  compact calendar attribution, and direct task creation/editing.
- Completed task status and priority editing and preserved typed attendees,
  attachments, URLs, and source bindings when existing items are edited.
- Added the client-local system/12-hour/24-hour preference and explicit calendar
  time picker controls, the custom color/origin Calendar Select, timed event and
  task defaults, task start/deadline/all-day editing, descriptions, event
  locations, multiple relative reminders, birthday reminders, and accessible
  item-type icons.
- Replaced raw date/all-day inputs with shared shadcn-composed DatePicker and
  Checkbox controls, extracted a reusable modal TimePicker for application-wide
  migration, and added custom reminder amounts with minute/hour/day/week units.
- Added the first hosted-calendar server slice: owner-scoped PostgreSQL calendar,
  item, change-log, and idempotent-operation tables; authenticated calendar CRUD,
  bounded range query, delta cursor, and batch operation APIs; and dedicated
  native desktop/Android request wrappers that keep bearer tokens out of both
  webviews.
- Added server locations to the desktop new-calendar dialog. Hosted calendars
  are created on the selected connected server, cached in the profile database,
  and immediately push item edits through the idempotent operation endpoint;
  failed pushes remain in the durable local queue for the upcoming replay loop.
- Selected `ical.js` 2.2.1 (MPL-2.0) as the shared desktop/Android RFC 5545
  parser, serializer, and recurrence engine. Added fixtures for DST wall-time
  preservation, all-day ranges, `RDATE`/`EXDATE`, malformed rules and feeds,
  duplicate UIDs, unsupported-property preservation, and bounded infinite rules.
- Connected recurrence expansion to native range loading so the UI receives
  occurrence instances rather than unexpanded masters. Expansion is bounded by
  both iteration and aggregate-candidate limits.
- Added repeatable profile-database schema migration metadata, calendar-level
  tombstones, acknowledged-only tombstone cleanup, and typed cleanup/delete
  commands for desktop and Android.
- Added shared hosted-user and email attendee contracts, structured event
  locations with legacy-string compatibility, vault-file/Kanban/upload/link
  attachments, and the inactive reminder-scheduler connector contract required
  before native notification delivery.
- Added repeat presets plus custom RFC 5545 rules to the desktop event/task
  editor. Recurring edits explicitly target one occurrence, the selected and
  following occurrences, or the entire series; recurring deletes use `EXDATE`,
  deterministic rule truncation, or a series tombstone respectively.
- Added stable series/instance identity and exception-aware projection. Moved
  exceptions are indexed by both their original recurrence slot and rendered
  date, and PostgreSQL/SQLite now permit one UID master plus distinct recurrence
  instances without allowing duplicate instances.
- Added the first desktop multi-server sync pass. Connected origins discover
  their hosted calendars, replay only their own durable operation queue in
  bounded batches, pull bounded delta pages, and isolate failures per server.
- Added a transactional native remote-change boundary so calendar/item upserts,
  tombstones, and cursor advancement commit together. Calendar changes are
  rebound to the authenticated connected origin before entering the profile
  cache, and the visible desktop range refreshes after each sync pass.
- Moved desktop hosted-calendar synchronization into an app-level coordinator
  so it runs outside the Calendar screen on connection changes, window focus,
  browser online events, and a bounded foreground interval. Added a status-bar
  rollup with per-server upload/download counts, errors, and manual retry.
- Stabilized the coordinator's semantic origin list and made successful profile
  initialization idempotent, preventing unrelated server-store updates and
  background sync triggers from continuously restarting sync and flickering the
  status bar.
- Added durable failed-operation retention to the shared profile store. Replay
  now isolates rejected operations, keeps connectivity failures pending, avoids
  pulling over unresolved local edits, and exposes retry/discard controls in the
  desktop calendar sync status menu. Desktop and Android share the typed native
  recovery commands.
- Added shared per-origin sync progress for discovery, bounded uploads, and
  downloaded change counts. The desktop status menu shows active progress and
  keeps disconnected cached origins visible.
- Connected Android startup, reconnect, foreground/resume, and online events to
  the shared calendar replay/pull engine through mobile Tauri wrappers. Android
  retains progress, results, conflicts, and cached-origin state independently
  of any open vault.
- Added atomic hosted-origin cache removal. It removes only the selected
  server/user replica and cursor, refuses while pending or failed operations
  exist, and is available for disconnected desktop caches and Android server
  entries.
- Completed the hosted calendar domain in migration
  `0021_calendar_hosted_domain_completion.sql`: relational attendee,
  invitation, attachment/upload, and subscription records plus indexed logical
  usage accounting.
- Added same-server attendee validation, durable per-attendee invitations,
  authenticated invitation listing and RSVP write-through to the organizer's
  item/change stream, and event-level attachment download authorization.
- Added `COLLAB_CALENDAR_QUOTA_BYTES` as a per-user hosted calendar quota,
  aggregate-only calendar metrics in the existing admin overview and dashboard,
  and maintenance cleanup for expired idempotency records and abandoned uploads.
- Added a live PostgreSQL router test covering ownership isolation, cross-server
  attendee rejection, idempotent replay, invitation privacy, RSVP propagation,
  attachment authorization, admin-content privacy, and quota rejection.
- Completed the desktop hosted collaboration workflow: hosted event editors
  search only the selected server's user directory, add/remove required or
  optional attendees, display RSVP state, and expose a multi-server invitation
  inbox with accept, tentative, and decline actions.
- Added typed desktop attachment controls for vault-file references, searchable
  Kanban-card references, external links, and native-file uploads to hosted
  calendar storage. Existing uploaded attachments remain visible and removable.
- Extended application Calendar settings with validated default duration,
  default reminders, working hours, hidden weekends, and declined-item
  visibility. New items consume the duration/reminder defaults, timed views
  position near working hours, and month/week/year layouts adapt to five-day
  display without changing the queried data range.
- Completed the Phase 4 keyboard and accessibility audit across compact item
  type icons, date/time creation cells, view selection, custom date/time and
  calendar controls, attendee/attachment actions, and invitation responses.
- Verified the complete desktop slice with focused editor, navigation,
  drag/resize, settings, store, sync, recurrence, and timed-layout tests plus
  TypeScript and whitespace checks. Phase 5 Android calendar work is the next
  implementation phase.
- Started Phase 5 with a vault-independent Android Calendar destination in the
  primary navigation. It opens directly against the profile calendar database,
  creates a local Personal calendar when the profile is empty, and displays
  cached hosted calendars grouped by their visible source identity.
- Added phone-first Agenda, Month, Day, and Tasks views with compact event,
  task, and birthday icons, calendar-color indicators, month/day navigation,
  per-calendar visibility controls, sync progress, and conflict warnings.
- Added the first mobile item sheet for local and hosted events, tasks, and
  birthdays. It uses the shared calendar contract and native date control,
  persists through the durable operation queue, acknowledges local-only writes,
  and triggers hosted reconciliation without requiring an open vault.
- Added Android shell coverage proving that Calendar remains usable without a
  selected vault. Remaining Phase 5 work includes three-day/timed layouts,
  advanced attendee/attachment editing, calendar management, conflict actions,
  and Kanban attachment deep links.
- Expanded the Android month grid for portrait phones with viewport-aware
  six-week sizing, while retaining bounded compact rows in landscape and on
  short displays.
- Extended the mobile item sheet with timed and all-day event/task semantics,
  the shared editable stepper-based time modal, automatic one-hour end-time
  adjustment, daily/weekly/monthly/yearly recurrence presets, multiple standard
  and custom-minute reminders, and task needs-action/in-progress/completed/
  cancelled states. Timed item labels now render in agenda, day, and task lists.
- Added focused persistence coverage for timed event creation, default
  reminders, local operation acknowledgement, and vault-independent navigation;
  the complete Android frontend suite passes. Remaining Phase 5 work is the
  three-day/timed schedule view, advanced recurrence-instance editing, hosted
  attendees and invitations, typed attachments/Kanban deep links, calendar
  management, and actionable conflict recovery.
- Refined mobile navigation so Month consumes the remaining portrait viewport
  without scrolling, while Agenda and Tasks retain internal scrolling.
  Horizontal gestures inside Month and Day now advance their period instead of
  switching the app's primary tab. Arrow, swipe, Today, and subview changes use
  the same reduced-motion-aware directional transition, and the current date is
  highlighted and exposed through accessible current-date semantics.
- Reworked Android Month cells to the compact Google Calendar pattern: dates
  sit in the upper-right and up to three calendar-colored, ellipsized title bars
  open the associated item directly. Added the desktop Calendar preference set
  to mobile Settings, using the device time zone and persisting date/time
  format, week start, event duration/reminder defaults, working hours, weekend
  visibility, and declined-invitation visibility. Month layout, list labels,
  the shared time picker, and new-item defaults consume those preferences.
- Month date taps now transition directly into that date's Day view. Replaced
  the mobile Day item list with a desktop-aligned vertical 24-hour timeline
  backed by the shared overlap-layout engine, with pinned all-day items,
  calendar-colored timed blocks, a current-time indicator, and initial
  positioning near the configured working hours.
- Added accessible half-hour creation slots to the Android Day timeline.
  Tapping an empty slot opens the normal event sheet with that date and start
  time prefilled; the configured default duration determines the initial end
  time, and saving continues through the standard local/hosted operation queue.
- Completed the Android three-day timed schedule with shared hour gutters,
  independently laid-out day columns, sticky day and all-day headers,
  overlapping timed items, current-time indication, and half-hour creation
  slots. Arrow and horizontal-swipe navigation advance by three days, while
  tapping a day header drills into the single-day timeline. Remaining Phase 5
  work is advanced recurrence-instance editing, hosted attendees/invitations,
  typed attachments and Kanban deep links, calendar management, and actionable
  conflict recovery.
- Added Android calendar management without requiring a vault: users can create
  calendars on the device or any currently connected server, edit names and
  accent colors, and archive or restore writable calendars. Hosted creation
  uses the authenticated calendar API, while hosted edits are first written to
  the durable profile operation queue and then reconciled through normal
  multi-server sync.
- Completed Phase 5 by projecting stored recurring series through the shared
  recurrence engine and routing occurrence/following/series edits and deletes
  through the desktop-aligned recurrence planner. Mobile item sheets now support
  custom RRULEs, structured locations with Android map handoff, hosted user
  lookup, attendee roles and RSVP visibility, and the multi-server invitation
  inbox with accept/maybe/decline actions.
- Added typed mobile attachments for selected-vault files, stable Kanban card
  references, external links, and hosted uploads. Opening a Kanban attachment
  selects its hosted vault when available and opens the referenced board
  directly at the stored card ID.
- Replaced passive conflict counts with per-operation retry and discard
  recovery. Local and hosted create/edit/complete/delete mutations continue to
  use the durable operation queue, and the reminder lifecycle now reconciles
  through the shared no-op scheduler boundary reserved for Phase 11 native
  notification delivery.
- Verified Phase 5 with 95 Android frontend tests, including recurrence
  exceptions, attendee lookup, invitation RSVP, conflict recovery, reminder
  schedule derivation, and Kanban deep links, plus mobile/root TypeScript checks
  and a production mobile frontend build.
- Started Phase 6 with a shared mirror-group contract and schema-v5 profile
  migration for groups, per-item/member convergence anchors, and preserved
  conflict snapshots. Native desktop and Android wrappers expose bounded group,
  item, anchor, and conflict operations through the existing profile store.
- Added the shared deterministic mirror planner used by desktop and Android.
  It enforces one writable calendar per location, waits before writing unless
  every hosted location is connected, bridges local/server and server/server
  groups through the signed-in client, records source change IDs and propagation
  lineage, and propagates deletions as tombstones without echo loops.
- Concurrent changes after a common anchor now preserve every location's full
  version as one visible conflict. Desktop users can select the version to keep;
  resolution revalidates the selected snapshot and all server connections,
  propagates a deterministic resolution operation, advances anchors, and only
  then marks the conflict resolved.
- Added desktop and Android mirror management for creating, pausing, and
  deleting groups. Both clients expose waiting/conflict attention states, and
  the Android foreground sync path can perform the same bounded bridge pass as
  desktop without requiring a vault.
- Verified the initial Phase 6 slice with shared planner coverage for
  local/server and server/server convergence, echo suppression, disconnected
  waiting, concurrent conflict preservation/resolution, and tombstones; native
  persistence tests; focused desktop/mobile UI suites; root/mobile TypeScript;
  and `cargo check --workspace`. Remaining work is global sync-menu visibility,
  broader retry/failure integration coverage, and desktop/physical-device
  end-to-end validation.
- Extended Phase 6 with typed per-group checking, applying, waiting, conflict,
  complete, paused, and error progress. A failed mirror group no longer aborts
  unrelated groups, and `ready` is published only after every planned write and
  convergence anchor succeeds.
- The global hosted-calendar sync popover now rolls mirror activity into its
  status label and lists operation progress, waiting locations, errors, and
  preserved conflicts per group. Failed groups have an explicit retry action;
  conflicts open Calendar directly for resolution.
- Android now exposes active mirror progress and can resolve preserved
  conflicts from Calendar management by choosing the version to keep. The
  shared resolver still requires every hosted location to be connected and
  revalidates the chosen snapshot before applying anything.
- Added failure-injection coverage proving that one broken group does not block
  another and that a retry after a partial multi-destination write reuses the
  deterministic operation ID, avoids echoing the already-written destination,
  and commits anchors only after convergence.
- Moved Phase 6 to testing after completing global progress visibility,
  isolated retry behavior, and desktop/Android conflict resolution. Physical
  device validation remains the exit criterion.
- Started Phase 7 with a hosted assignment index and generated, read-only
  “Assigned tasks” calendars. Initial document creation, REST revisions, and
  live-CRDT materialization reconcile assigned cards in the same PostgreSQL
  transaction as the Kanban revision and publish changes through the existing
  per-user calendar change stream.
- Reassignment, archive, source trash/purge, and vault-access removal now emit
  task/calendar tombstones. Access removal also deletes historical generated
  upsert payloads before appending tombstones so a fresh sync cannot retrieve
  private card details. Desktop and Android preserve the generated Kanban
  calendar location and namespace it by server while hydrating task bindings
  with the connected server URL for deep links.
- Completed Phase 7 with local-vault projection into the profile SQLite store,
  including immediate file-watcher refresh, stable source links, unscheduled
  task visibility, recurrence mapping, and atomic removal of stale assignments
  without creating ordinary calendar operations.
- Added the narrow hosted and local write-through path for start date, deadline,
  completion, and supported recurrence. Desktop and Android keep source-owned
  titles, descriptions, assignees, and board placement read-only; hosted writes
  enforce assignment, optimistic source revision, file-write, and semantic
  Kanban edit-content capabilities.
- Restoring a Kanban source or an older Kanban revision now rebuilds generated
  assignments in the same server transaction. Focused TypeScript, Rust store,
  hosted projection, Android editor, and authenticated PostgreSQL lifecycle
  tests cover projection stability, stale removal, recurrence, privacy, and
  allowed/denied write-through.
- Started Phase 8 with bounded desktop `.ics` import and export. The import
  preview reports creates, updates, unchanged items, and conflicting duplicate
  UID/recurrence identities before applying; reimports retain stable local IDs
  and revisions instead of creating duplicate rows.
- Calendar imports commit atomically to the profile SQLite store and retain the
  normal durable operation queue. Hosted imports send operations in bounded
  500-item batches so server synchronization does not amplify one file into
  thousands of REST requests.
- Added parser and round-trip fixtures for events, tasks, recurrence, all-day
  values, relative alarms, priorities, CRLF output, provider extensions, and
  DST-sensitive time zones, plus hard byte, line, and 5,000-item limits.
- Added local-profile read-only HTTPS subscriptions with persisted ETag and
  Last-Modified validators, a 15-minute stale refresh threshold, manual refresh
  and removal controls, and independent failure handling. Successful refreshes
  atomically replace the derived calendar, while fetch or parse errors preserve
  the last good copy and surface a per-feed warning.
- Native and server feed fetching require credential-free HTTPS, revalidate every
  redirect and DNS result, pins each request to the validated addresses, blocks
  local/private/reserved targets, limits redirects and response size, and does
  not forward conditional validators across origins.
- Added revocable published feeds for hosted calendars. Owners can create and
  revoke high-entropy read-only URLs from the desktop calendar rail; only a hash
  of each raw token is stored, and the raw URL is returned only at creation.
  Anonymous feed reads remain IP rate-limited, are bounded to 5,000 items and
  5 MiB, support ETag revalidation, and cannot list or infer another user's
  calendars. A shared Rust serializer emits CRLF iCalendar feeds for events,
  tasks, birthdays, recurrence, reminders, email attendees, and external links.
- Completed Phase 8 with owner-scoped hosted subscription create/list/refresh/
  delete APIs and a bounded 15-minute background refresh worker. Refresh leases
  recover after interruption, conditional requests retain ETag and
  Last-Modified metadata, and fetch/parser failures preserve the last good copy
  while exposing the feed error.
- Desktop subscription creation can target the local profile or any connected
  server. Hosted subscription calendars and metadata hydrate through the normal
  multi-server replica path on desktop and Android.
- Desktop export now supports the whole calendar, current visible range,
  selected day, or explicit item selection. Android calendar management uses
  native document pickers for bounded `.ics` import and export, with atomic
  local staging and 500-operation hosted batches.
- Safe non-Collab `X-*` properties survive import/export within bounded count
  and length limits. Reserved Collab properties, malformed lines, and content
  line injection are rejected. Google-, Outlook-, and Apple-style fixtures
  cover unknown extensions, all-day values, recurrence, alarms, and DST zones.
- Started Phase 9 with a hosted CalDAV surface at `/.well-known/caldav` and
  `/caldav/`. It exposes principal and calendar-home discovery, owner-scoped
  collections, `calendar-query`, bounded `calendar-multiget`, incremental
  `sync-collection`, collection sync tokens, and per-resource ETags.
- CalDAV `GET`, `PUT`, and `DELETE` map iCalendar resources onto the existing
  owner-scoped operation core. External writes therefore share validation,
  quotas, idempotency, revisions, tombstones, relations, and the same change
  stream already consumed by desktop and Android replicas. Recurrence masters
  and exceptions remain one stable CalDAV resource and stale write
  preconditions return `412 Precondition Failed`.
- Added revocable CalDAV app passwords. Only a SHA-256 digest is stored; the raw
  password is returned once at creation. CalDAV Basic authentication accepts
  only these credentials and never normal Collab bearer/session credentials.
  The desktop Calendar can create, list, copy, and revoke credentials for any
  connected server without exposing native bearer tokens to the webview.
- Added CalDAV-specific request limits, credential-scoped rate limiting,
  maintenance-mode write blocking, parser/property tests, and a live PostgreSQL
  lifecycle test covering discovery, create/read/delete convergence, sync
  tombstones, stale ETags, and immediate credential revocation.
- The hosted server is the standards-based two-way endpoint for this phase.
  A local-only outbound CalDAV connector is deferred until the background
  execution and secure external-credential lifecycle can support provider
  secrets without storing them in the calendar profile database.
- Started Phase 10 with admin-configurable per-user calendar quota and
  calendar-specific request budgets. Environment values remain authoritative
  when set; otherwise the administration settings page can change both at
  runtime.
- Extended the aggregate-only admin overview with anonymous largest-account,
  near-quota, and at-quota counts plus subscription refresh health. Operational
  warnings report quota pressure, failed subscriptions, and overdue refreshes
  without returning owner IDs, calendar names, item payloads, attendees, or
  attachment content.
- Added bounded explicit recurrence dates, adversarial long-range recurrence
  tests, calendar-specific rate-limit coverage, live retention coverage for
  operation deduplication records and abandoned attachment uploads, and a
  repeated two-server disconnect/reconnect convergence test.

## Current System Constraints

- The desktop shell assumes a vault is open before `AppShell` is shown. The
  desktop Calendar intentionally remains inside that shell; only Android must
  expose Calendar without an open vault.
- The desktop local collaboration identity is currently persisted in
  `localStorage`. Calendar data is too large and too important for that storage
  path and needs a native profile database under `app_config_dir()`.
- The server already stores account preferences in `users.preferences`, but
  calendar records must not be embedded in that opaque JSON column.
- Multiple server sessions already exist and are keyed by server URL. Calendar
  state and sync cursors must use the same server URL plus server user ID
  identity boundary.
- Hosted frontend calls keep bearer tokens in Rust. Calendar APIs are outside
  `/api/v1/vaults`, so they need dedicated typed Tauri commands rather than an
  expansion of the restricted generic hosted-vault request gateway.
- Android already restores several server sessions and owns app-private native
  storage. Calendar replicas should use the same native session and lifecycle
  boundaries.
- Existing desktop and Android Kanban calendar views are board-specific
  projections. They can provide visual and date-handling primitives, but they
  are not the account-level calendar store.

## Product Decisions

### Calendar Ownership And Locations

Every calendar has exactly one home location unless the user explicitly enables
mirroring:

- `local:<profileId>` for a native local-profile calendar.
- `hosted:<serverUrl>:<serverUserId>` for a personal calendar on one server.
- `subscription:<subscriptionId>` for a read-only external iCalendar feed.
- `kanban:<origin>` for a generated assigned-task calendar.

The UI groups calendars by location and uses a location badge in edit surfaces.
The same color may be reused, but calendar identity always includes its origin.
Calendar names are not assumed unique across locations.

Creating a calendar requires selecting its home. Creating a hosted calendar
never silently creates copies on other connected servers. "Mirror to..." is an
explicit action with a description of offline and conflict behavior.

### Local Profile Meaning

"Stored as part of the user's profile" means the local profile owns a native
calendar database under an app-config path such as:

```text
{app_config_dir}/profiles/{localProfileId}/calendar.sqlite
```

The profile ID remains stable across vaults. Calendar data therefore remains
available to native sync/reminder services when no vault is open, although the
desktop Calendar UI is entered through a vault workspace. Calendars are not
included in vault ZIP export, vault sync, vault encryption, or vault deletion.

Profile export/backup should optionally include an encrypted calendar archive,
but that is separate from vault export.

### Hosted Ownership

Hosted calendar rows are owned directly by `users.id`. They do not belong to a
hosted vault and do not inherit vault membership or vault permissions. A user
may access only their own calendars in the initial release.

Calendar sharing is intentionally deferred. When sharing is added, it must use
a calendar-specific ACL and must not reuse vault roles.

### Privacy Boundary

Server administrators may see only aggregate operational metadata:

- Total hosted-calendar logical bytes.
- Number of users with calendars.
- Calendar count and logical bytes per user.
- Distribution of users by calendar count.
- Quota pressure and sync-service health.

The admin API and web app must not expose calendar names, colors, descriptions,
event/task/birthday fields, recurrence rules, attendees, locations, external
feed URLs, or an export/download action. Admin audit events use opaque IDs and
action names, never event titles.

This is an application-level authorization guarantee. A server operator with
direct PostgreSQL or process-memory access can still inspect data unless a later
end-to-end-encryption design is added. Claiming protection from the database
operator would require client-side encryption, key recovery, and a different
external-feed architecture and is not part of this plan.

### Time And Time-Zone Rules

- Timed events store UTC instants plus an IANA time-zone identifier used for
  display and recurrence interpretation.
- All-day events and birthdays store date-only values and must never shift dates
  through UTC conversion.
- Tasks may have a due date/time without a start time.
- A calendar has a default time zone; an event may override it.
- DST gaps and repeated local times use a documented deterministic policy and
  are covered by fixtures.
- Recurrence uses RFC 5545 concepts: `RRULE`, `RDATE`, `EXDATE`, and
  `RECURRENCE-ID` overrides. Recurrences are expanded only for bounded query
  windows and are never materialized without a limit.

### Event Editor Requirements

- Calendar picker: use Collab's shared custom Select component, not a native
  `<select>`. Show a color swatch, calendar name, and local/server origin in
  both the trigger and options.
- Time format: add `system | 12-hour | 24-hour` beside the existing date and
  week-start settings. This is a client-display preference and does not alter
  stored instants or synchronized event data.
- Defaults: all-day is disabled for new events. Timed events start at the next
  sensible interval and use the configured default duration.
- Recurrence picker: `Does not repeat`, `Every day`, `Every week`, `Every
  month`, `Every year`, and `Custom`. Custom supports interval, selected
  weekdays, month/day rules, end date or occurrence count, and a readable
  summary. Editing or deleting a recurring item always asks for occurrence,
  this-and-following, or complete-series scope where applicable.
- Details: events support a multiline description, structured location,
  multiple reminders, attendees for hosted events, and attachments.

### Task Editor Requirements

- Calendar picker: use the same shared custom Select as events, including the
  calendar color swatch and local/server origin. Do not fall back to a native
  `<select>` in task-specific sheets or dialogs.
- Scheduling: replace the single date field with start date/time and deadline
  date/time controls. An `All day` toggle switches both values to date-only
  semantics without UTC conversion. The deadline is prominent and supports
  clearing a task back to the unscheduled list where that workflow permits it.
- Recurrence: tasks use the same `Does not repeat`, daily, weekly, monthly,
  yearly, and custom recurrence builder as events. Completing a recurring task
  advances the series according to the recurrence rule rather than completing
  every future occurrence. Edit/delete scope supports occurrence,
  this-and-following, and entire series.
- Reminders: tasks support zero or more deadline-relative or absolute reminders.
  Changing the deadline, recurrence, completion state, or calendar invokes the
  reminder scheduler connector so stale schedules can be cancelled later.
- Details: tasks support a multiline description and typed attachments.
- Kanban attachments: the attachment picker prioritizes a searchable Kanban
  task/card chooser grouped by local vault and connected hosted server. Store a
  stable `kanbanCard` reference and open the actual source card on activation.
  A related-card attachment does not imply completion/date write-through;
  write-through is enabled only for a generated task with an explicit
  `sourceBinding` and sufficient vault capability.
- File attachments: tasks may also reference supported vault files, use a
  calendar-owned upload, or attach a validated HTTPS link under the shared
  attachment authorization and quota rules.

### Birthday Editor And Rendering Requirements

- Birthdays support one or more reminders. All-day reminder delivery uses the
  user's configured local notification time rather than treating midnight as a
  UTC instant. A configurable birthday default may provide reminders such as
  one week before and on the day, but users can override or disable them.
- Birthday recurrence is annual by definition while still using the shared
  recurrence/exception representation for import/export and one-off changes.
- Every rendered calendar item carries a compact type icon in month, week,
  agenda, year detail, search, reminder, and editor surfaces: calendar/event,
  check/task, gift-or-cake/birthday, and link/card for generated or Kanban-bound
  tasks. Calendar accent color continues to communicate calendar origin; the
  icon communicates item type.
- Icons include accessible labels/tooltips and are never the only indicator of
  completion, RSVP, reminder, or conflict state.

### Hosted Attendees And Invitations

Hosted events may include active users from the event's home Collab server.
The attendee picker uses the existing authenticated server user-directory
boundary and must not enumerate users from unrelated connected servers.

- The organizer can add/remove server users and see pending/accepted/declined/
  tentative status.
- Invited users receive an invitation projection/inbox entry and may accept,
  decline, or mark tentative. Acceptance may add a read-only or attendee-owned
  projection to their calendar without sharing the organizer's calendar.
- Event updates and cancellations advance the organizer change sequence and
  each affected attendee's invitation sequence atomically or through a durable
  outbox.
- Attendees receive only event fields allowed by the invitation visibility
  policy. Adding an attendee never grants access to a referenced vault, file,
  Kanban board, or attachment source.
- Local-only events cannot add server attendees until moved or mirrored to a
  hosted calendar. Cross-server attendees and arbitrary email guests are
  deferred.

### Locations And Address Lookup

Store location data as a structured optional value: display label, normalized
address, optional latitude/longitude, optional provider/place ID, and optional
join URL. Manual text entry must always work and event saving must never depend
on an online geocoder.

Address search and map picking use a provider adapter so desktop and Android can
share normalized results without hard-coding Google, Apple, or OpenStreetMap
terms into the domain. The selected provider must be configurable, respect its
usage/licensing policy, rate limits, attribution, and privacy requirements, and
avoid logging address queries. Mobile should support opening the stored
coordinates/address in the user's chosen maps application. Public community
geocoding endpoints must not be treated as an unrestricted production API.

### Calendar Attachments

Attachments are typed references with stable IDs and display metadata:

- `vaultFile`: local vault identity plus relative path, or hosted server/vault
  plus stable file ID and optional revision.
- `kanbanCard`: server/local vault identity, stable board file ID/path, and card
  ID.
- `calendarUpload`: calendar-owned uploaded file with digest, MIME type, size,
  and storage object ID.
- `externalLink`: validated HTTPS URL with an optional label.

Notes, canvases, PDFs, images, and other supported vault files use `vaultFile`;
they do not need separate attachment kinds. References do not copy the source
unless the user explicitly chooses a calendar upload. Renames should resolve by
stable ID where available. Missing or unauthorized sources remain visible as
unavailable references instead of silently disappearing. Attendees do not gain
source-vault access; calendar-upload downloads require organizer/attendee
authorization, quotas, size/type limits, digest verification, and safe download
headers.

## Shared Domain Model

Add a shared calendar package/module used by both frontends and native code. The
TypeScript model belongs in `src/types/calendar.ts`; protocol DTOs belong in
`collab-protocol`; persistence and sync logic should live in a new
`collab-calendar` crate or a clearly isolated module shared by desktop and
Android.

### Calendar

```ts
interface CalendarDefinition {
  id: string;
  globalId: string;
  owner: CalendarOwner;
  name: string;
  color: string;
  defaultTimeZone: string;
  archived: boolean;
  readOnly: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

`globalId` is a stable UUID used by explicit mirror groups. `id` is the
location-local database identifier. The origin remains part of every cache and
React key.

### Calendar Item

Use one discriminated item family with shared recurrence and reminder fields:

- `event`: title, description, location, availability, start/end, all-day,
  time zone, recurrence, reminders, attendees, attachments, and optional URL.
- `task`: title, description, deadline/due value, optional start value, all-day
  date semantics, priority, completion state/time, recurrence, reminders,
  attachments, and optional source link.
- `birthday`: person label, date, optional birth year, yearly recurrence, and
  reminders.

Every item includes:

- UUID `id` and portable RFC 5545 `uid`.
- Calendar ID and item kind.
- Item revision and updated timestamp.
- Creation/update origin IDs.
- Optional recurrence-series parent and recurrence-instance ID.
- Soft-delete tombstone metadata.
- Optional `sourceBinding` for Kanban or external records.
- Optional structured location, attendee records, and typed attachments.

Keep indexed scheduling fields structured. Do not store the complete domain as
an opaque JSON blob. A bounded extension JSON object may preserve unsupported
iCalendar properties for loss-aware round trips.

### Operation Contract

All mutations use operations with:

- Stable `clientOperationId` for idempotency.
- Calendar and item IDs.
- Expected item/calendar revision.
- Device/replica ID.
- Mutation type and validated payload.
- Optional source change ID and propagation lineage for mirror loop prevention.

Conflicting expected revisions return both versions. Clients retain the local
draft and offer keep-local, keep-remote, or duplicate-as-new. Silent
last-writer-wins is not acceptable for edits made independently in two places.

## Local Native Storage

Use SQLite or the existing native database approach, not `localStorage` or one
JSON file. The local store contains:

- Calendar definitions and items.
- Tombstones.
- Per-origin delta cursors.
- Pending outbound operations.
- Applied operation IDs.
- Mirror-group mappings and per-pair sync anchors.
- iCalendar subscription state, ETags, and refresh timestamps.
- Reminder scheduling state.
- Attachment metadata and local calendar-upload payloads.

Expose typed Tauri commands in `src/lib/tauri.ts` and mobile equivalents for:

- List/create/update/archive/delete calendars.
- Query a bounded date range and agenda page.
- Create/update/delete/complete items.
- Search items.
- Read sync status and pending conflicts.
- Trigger sync for one origin or all connected origins.
- Import/export iCalendar data.

Local writes commit the item mutation and outbound operation in one
transaction. Queries use indexed range fields and bounded recurrence expansion.

## Hosted Server Model

Add PostgreSQL migrations for at least:

- `calendars`: owner, display metadata, revision, logical usage, archived state.
- `calendar_items`: structured scheduling fields, recurrence data, item revision,
  source binding, and tombstone state.
- `calendar_attendees`: organizer event, attendee user, RSVP state,
  visibility, invitation revision, and timestamps.
- `calendar_invitations`: durable attendee projection and RSVP state without
  exposing event content in operational logs or administration APIs.
- `calendar_attachments`: typed reference metadata and optional deduplicated
  calendar-upload blob linkage.
- `calendar_change_log`: monotonic per-user sequence for bounded delta sync.
- `calendar_client_operations`: idempotency records with retention.
- Aggregate usage is calculated from indexed logical-size columns without
  selecting calendar names, item payloads, attendee data, or attachment content.
- `calendar_subscriptions`: external feed configuration and refresh state.
- `calendar_publish_tokens`: hashed, revocable read-only feed tokens.
- `kanban_task_assignments`: generated assignment projection for hosted boards.

Recommended personal API surface:

```text
GET    /api/v1/calendars
POST   /api/v1/calendars
GET    /api/v1/calendars/{calendarId}
PATCH  /api/v1/calendars/{calendarId}
DELETE /api/v1/calendars/{calendarId}
GET    /api/v1/calendars/changes?cursor=...&limit=...
POST   /api/v1/calendars/operations
GET    /api/v1/calendars/query?from=...&to=...&cursor=...
GET    /api/v1/calendars/invitations
POST   /api/v1/calendars/invitations/{invitationId}/response
POST   /api/v1/calendars/import
POST   /api/v1/calendars/{calendarId}/export
POST   /api/v1/calendars/{calendarId}/attachments
GET    /api/v1/calendars/attachments/{attachmentId}
```

The API derives ownership from the authenticated session and never accepts an
owner user ID as authority. Batch sizes, item sizes, query windows, recurrence
expansion, and retained tombstones are bounded.

Add dedicated native commands such as `hosted_calendar_request` and
`hosted_calendar_export`. They select the session by server URL and reuse the
existing TLS, refresh-token, and invalid-certificate settings. Bearer tokens
must not enter either webview.

## Synchronization Model

### Layer 1: Device Replica Sync

Every hosted calendar is cached in the native local store. Sync follows the
existing replica principles but uses an account calendar cursor rather than a
vault manifest sequence:

1. Replay pending local operations in order.
2. Pull bounded changes after the stored cursor.
3. Apply changes and cursor advancement transactionally.
4. Preserve unresolved conflicts and continue syncing unrelated items.
5. Update visible per-server and aggregate progress.

Desktop reconnect and Android foreground/resume paths trigger calendar sync for
all connected servers. Android background work may add opportunistic refresh,
but correctness cannot depend on the OS granting background execution.

Each server has an independent sync state keyed by normalized server URL and
server user ID. Disconnecting one server does not remove its cached calendars.
The user may explicitly remove that offline calendar cache after reviewing
pending operations.

### Layer 2: Cross-Location Mirroring

Mirroring is opt-in and creates a sync group containing at most one replica per
location. Examples:

- Local profile and Server A.
- Server A and Server B.
- Local profile, Server A, and Server B.

The client performs bridging only while authenticated to the involved hosted
locations. No server receives credentials for another server. Any desktop or
mobile client connected to all group locations may bridge it.

Use stable item `uid` values, source change IDs, propagation lineage, and
idempotent destination operations to prevent echo loops. Store the last synced
revision/hash for each item and location pair. If both replicas changed after
their last common anchor, create a visible conflict rather than selecting a
winner from wall-clock timestamps.

Deletion propagates as a tombstone. Tombstones remain long enough for the
documented maximum offline period and are compacted only after retention and
sync-anchor rules permit it.

### Sync Visibility

The calendar UI and global sync menu show:

- Per-server connection and last-sync state.
- Calendar currently being uploaded/downloaded.
- Operation counts and item counts; byte progress only where transport exposes
  real byte callbacks.
- Offline pending changes.
- Conflicts and external-feed errors.
- Mirror groups waiting for another server connection.

## Desktop Experience

Calendar is a primary view in the activity bar inside the normal vault-open
desktop workspace. Requiring an open vault is acceptable on desktop because the
vault workspace is the main application context. Calendar data remains
profile-scoped and independent of the open vault. Android Calendar must not
require a vault to be open.

### Layout

- Left panel: mini month, Create button, searchable calendars grouped under
  Local, each connected server, Subscriptions, and Assigned tasks.
- Main toolbar: Today, previous/next, current range, search, view switcher, and
  calendar visibility controls.
- Main views: day, week, month, year, schedule/agenda, and tasks.
- Event editor: responsive sheet/dialog for type, calendar location, title,
  date/time, all-day, time zone, recurrence, attendees, reminders, structured
  location, description, attachments, priority/completion for tasks, and source
  information for linked items.
- Calendar selection uses the shared custom Select component. Every option and
  the selected value show the calendar color plus its local/server origin.
- All-day is off by default. New timed events use the configured default
  duration and the client time-format preference.

### Interaction

- Click/drag empty time to create an event.
- Drag events between times/days and resize timed events.
- Move an item to another writable calendar with explicit confirmation when the
  destination changes server/location.
- Quick-create text entry plus complete edit mode.
- Multi-calendar color overlays and visibility toggles.
- Current-time indicator, all-day lane, overlapping-event layout, keyboard
  navigation, focus states, and screen-reader labels.
- Compact item-type icons in every density mode so events, tasks, birthdays,
  and Kanban-bound tasks remain distinguishable independently of calendar color.
- Search across locally cached calendars, with origin and offline-state badges.
- Recurring edit choices: this occurrence, this and following, or entire series.
- Right-click empty dates/times to create an event, task, or birthday; right-
  click existing items to edit, duplicate, move, or delete them.

Reuse date formatting and week-start preferences from the existing Calendar
settings section. Add a client preference for `system`, `12-hour`, or `24-hour`
time display and use `Intl.DateTimeFormat` consistently in pickers and rendered
views. Extend Calendar settings with default calendar, default duration,
working hours, time zone, reminder defaults, hidden weekends, and declined-item
visibility.

## Android Experience

Add Calendar as a first-class bottom-navigation destination. Reevaluate the
existing five-destination limit by moving infrequent server management into a
switcher/settings route if necessary; do not compress six labeled tabs into an
unusable bar.

Mobile provides:

- Agenda as the compact default, plus month, three-day, day, and task views.
- Day dots and expandable agenda behavior consistent with the improved Kanban
  mobile calendar, backed by the account calendar domain.
- Create/edit/complete/delete workflows through bottom sheets that always clear
  the system and app navigation bars.
- Calendar management grouped by local cache and each server.
- Offline editing with pending/conflict indicators.
- Manual sync and per-server last-sync state.
- Calendar/location selection when creating an item.
- Recurrence-instance editing and reminder controls.
- Full task start/deadline time controls, all-day tasks, descriptions, file and
  Kanban-card attachments, and recurring-task completion behavior.
- Birthday reminder controls and the same accessible item-type icon language as
  desktop.
- The same system/12-hour/24-hour formatting preference and recurrence presets
  as desktop.
- Hosted attendee management, structured location entry/search, map-app handoff,
  descriptions, and attachment viewing/upload where platform permissions allow.
- Deep links from generated Kanban tasks to the source vault/card when the vault
  is available.

Hosted calendars remain readable from cache after disconnect. Mutations queue
only when a valid offline replica and prior authorization state exist, following
the same conservative policy as hosted vault replicas.

## Kanban Assigned-Task Integration

Do not duplicate assigned cards into ordinary calendar events. Expose a
generated `Assigned tasks` calendar per origin:

- Local boards project cards assigned to the local profile identity.
- Hosted boards project cards assigned to the authenticated user ID on that
  server.
- Unassigned cards do not appear.
- Start/due dates define the displayed range; cards without either date appear
  in the unscheduled task list.
- Completed, recurring, archived, and reassigned cards update or disappear
  deterministically.

For hosted boards, maintain a server-side assignment projection whenever a
Kanban revision is materialized, including live CRDT persistence. This ensures
the assignee's mobile calendar updates even if the assignee never opens that
board. The projection endpoint checks both the assignment and current vault
access before returning source details.

Calendar edits use narrow write-through rules:

- Start date, due date, completion state, and supported recurrence fields may
  write back to the Kanban card when the user has the required capability.
- Title, description, assignees, and board placement remain source-owned and
  open the card editor instead of being silently rewritten from Calendar.
- Read-only or unavailable sources show cached task data and a clear warning.
- Every binding uses server URL, vault ID, stable file ID, card ID, and source
  revision; relative paths are display metadata only.

## iCalendar And External Applications

### Phase 1 Interoperability: `.ics`

- Import a local `.ics` file into a selected writable calendar.
- Export one calendar, a selected range, or selected items as valid RFC 5545.
- Preserve `UID`, recurrence exceptions, time zones, all-day semantics, status,
  alarms where supported, and unknown safe properties needed for round trips.
- Deduplicate imports by `UID` plus recurrence instance, then show create/update/
  conflict counts before applying.
- Provide a read-only subscription to an external HTTPS iCalendar URL.
- Allow a hosted Collab calendar to publish a revocable, unguessable read-only
  iCalendar feed URL for use in other applications.

Subscription refresh uses ETag/Last-Modified when available and surfaces stale
or failed state. Imported files and feeds have strict byte, item, recurrence,
line-length, and parse-time limits.

### Phase 2 Interoperability: CalDAV

For genuine two-way sync, implement CalDAV rather than describing an `.ics` URL
as bidirectional:

- Hosted Collab servers expose a per-user CalDAV endpoint with discovery,
  calendar collections, ETags, sync tokens, bounded calendar-query reports,
  and item `PUT`/`DELETE`.
- External clients authenticate with revocable calendar app passwords/tokens,
  never the user's normal password or native refresh token.
- The server maps CalDAV resources onto the same calendar operation log so
  desktop, Android, and external clients share conflict and tombstone behavior.
- Local-only calendars may connect outward to a remote CalDAV account through
  the native client. A local desktop calendar is not exposed as a network server
  by default.

Provider-specific OAuth connectors can follow where standards support is
insufficient. Credentials and refresh tokens stay in OS-native secure storage
for client-side connectors or encrypted server secret storage for explicitly
server-managed connectors.

### External Fetch Security

Server-side feed refresh must defend against SSRF:

- HTTPS by default, bounded redirects, DNS/IP revalidation, and blocked private,
  loopback, link-local, metadata, and Unix-socket targets.
- Bounded response size, decompression ratio, duration, and content type.
- No feed URL, credential, or event content in admin output or normal logs.
- User-triggered refresh rate limits and server-wide worker concurrency limits.

## Reminders And Notifications

- Store zero or more relative or absolute reminders per item.
- Introduce the connector boundary during the core calendar work:
  `CalendarReminderScheduler.reconcile(profileId, changedItems)`, `cancel`,
  `rescheduleAll`, permission-state reporting, and activation callbacks that
  deep-link to the exact event. CRUD, sync, recurrence changes, sign-out, cache
  removal, time-zone changes, and clock changes call this boundary even while
  the initial implementation is a no-op connector.
- After the core calendar implementation, desktop activates a native connector
  that schedules notifications for locally cached items.
- Android activates a platform connector using alarms/work APIs and restores
  schedules after reboot, app upgrade, permission changes, and time-zone change.
- Notification payloads are minimal on locked devices and respect a privacy
  setting for showing titles.
- The UI exposes notification permission state and failed scheduling without
  blocking event saves. Reconciliation is idempotent and bounded; stale
  occurrences and deleted events are cancelled.
- Server email/push reminders are deferred until delivery infrastructure and
  user opt-in exist; device reminders must not depend on an always-running
  server connection.

## Admin Calendar Overview

Expose a dedicated aggregate section in the admin dashboard through the existing
admin overview endpoint:

```text
GET /api/v1/admin/overview
```

Response fields should be limited to:

- users with calendars, total calendars/items/uploads, and logical storage bytes
- anonymous count-distribution buckets
- configured per-user quota

The endpoint reads count and logical-size columns, not calendar-item payload
columns. Tests assert that calendar names, item titles, descriptions, attendees,
and attachment content never appear. The UI has no row expansion, calendar
link, content drill-down, export, or impersonation action.

Calendar logical bytes should be reported separately from the existing blob
quota while database size continues to include the physical rows. Add a
configurable per-user calendar quota and clear `QUOTA_EXCEEDED` responses.

## Phase Details

### Phase 0: Domain Contract And Interoperability Spike

Estimated effort: 1-2 weeks.

Tasks:

- Freeze the event/task/birthday, date-only, timed, recurrence, reminder, and
  conflict contracts plus structured locations, attendees, attachments, and
  reminder-scheduler connector interfaces.
- Test a vetted RFC 5545 parser/serializer and recurrence engine against a
  fixture corpus; do not hand-roll RFC parsing.
- Decide whether calendar persistence lives in a new crate or a module inside
  the shared replica crate based on dependency isolation.
- Prototype bounded range queries and recurrence expansion with realistic data.
- Record the application-level admin privacy threat model and E2EE non-goal.

Acceptance criteria:

- Shared fixtures cover DST, all-day events, recurring exceptions, malformed
  feeds, duplicate UIDs, and unsupported properties.
- Recurrence presets and custom rules round-trip through the same RFC 5545
  representation and produce deterministic edit-scope operations.
- Desktop and Android can call one native spike query over the same local store.
- The protocol DTO and error-code proposal is reviewed before migrations land.

### Phase 1: Shared Domain And Local Profile Store

Estimated effort: 3-4 weeks.

Tasks:

- Implement shared types, validators, date helpers, recurrence queries, and
  operation application.
- Add typed attendee, location, attachment, and reminder-scheduler connector
  contracts without requiring active notification delivery yet.
- Add the native profile calendar database, migrations, indexes, tombstones,
  pending operations, and search.
- Add typed desktop/mobile Tauri wrappers.
- Migrate the existing local identity into an explicit local profile record
  without changing its ID.
- Add local calendar CRUD and item CRUD tests before UI work.

Acceptance criteria:

- Local calendars survive restart and are independent of vault lifecycle.
- Range/agenda/search queries remain bounded with large recurrence fixtures.
- An interrupted write cannot persist an item without its operation record.
- Schema migrations are repeatable and preserve existing profiles.

### Phase 2: Hosted Server Calendar Domain

Estimated effort: 3-5 weeks.

Tasks:

- Add PostgreSQL schema, DTOs, error codes, personal APIs, operation idempotency,
  delta sequence, tombstone retention, usage rollups, and quotas.
- Add hosted attendee/invitation records, RSVP operations, durable invitation
  projection delivery, and calendar-upload attachment storage/download routes.
- Add dedicated desktop/mobile native hosted-calendar commands.
- Add backup, restore, retention, and maintenance handling for calendar tables.
- Add ownership, disabled-user, rate-limit, body-limit, and malformed-recurrence
  tests plus attendee privacy and attachment authorization tests.

Acceptance criteria:

- A user cannot address another user's calendar by guessing IDs.
- Every accepted mutation advances the account change sequence atomically.
- Repeated client operation IDs are harmless and return the original result.
- Admin APIs have no route capable of returning private calendar content.
- Inviting a user does not grant vault access, cross-server users cannot be
  selected, and attachment downloads require event-level authorization.

### Phase 3: Multi-Server Offline Sync

Estimated effort: 3-4 weeks.

Tasks:

- Implement per-server cursors, pull paging, queued replay, conflict retention,
  retry/backoff, and cache cleanup.
- Integrate reconnect, manual sync, desktop global sync status, Android resume,
  and server disconnect/remove-cache flows.
- Add per-calendar and aggregate sync progress.
- Test two connected servers with overlapping calendar names and IDs.

Acceptance criteria:

- Server A failures never block Server B or local calendars.
- Offline edits replay after reconnect without duplicates.
- Disconnect preserves readable cache and pending operations until explicit
  removal.
- Cursor advancement and data application are atomic.

### Phase 4: Desktop Calendar Experience

Estimated effort: 4-6 weeks.

Tasks:

- Add activity-bar navigation, calendar sidebar, day/week/month/year/agenda/task
  views, quick create, complete editor, search, visibility, and drag/resize.
- Add recurring-event edit choices and conflict UI.
- Replace native selects with the shared color/origin-aware Calendar Select;
  add system/12-hour/24-hour settings and timed-event defaults.
- Add recurrence presets/custom builder, descriptions, multiple reminders,
  hosted attendee/RSVP controls, structured location/manual address entry,
  provider-backed optional lookup, and typed attachments.
- Complete task editing with the custom color/origin Calendar Select, start and
  deadline date/time pickers, all-day mode, recurrence, reminders,
  descriptions, file attachments, and a Kanban-card chooser.
- Add birthday reminders and accessible per-item type icons across all calendar
  views and search/editor surfaces.
- Wire event mutations to the no-op reminder scheduler connector so native
  notification delivery can be activated later without changing editor flows.
- Extend calendar settings and integrate sync transparency.

Acceptance criteria:

- Core workflows are keyboard accessible and screen-reader labeled.
- Overlapping events, all-day lanes, time-zone changes, and narrow windows render
  without overlap or clipping.
- Local and several hosted origins can be edited in one session.
- Calendar requires the normal desktop vault workspace, while its data remains
  profile-scoped across vault changes.
- Local-only controls never imply hosted attendees are available; hosted
  attendee, attachment, and recurrence changes survive sync and conflict flows.
- New task flows use the custom calendar selector, preserve date-only all-day
  values, and round-trip start/deadline, recurrence, reminders, description,
  and file/Kanban attachments.
- Birthday reminders round-trip and event/task/birthday/Kanban type icons remain
  legible at compact month density and with calendar colors disabled.

### Phase 5: Android Calendar Experience

Estimated effort: 3-5 weeks.

Tasks:

- Add the Calendar destination and restructure mobile navigation if needed.
- Build agenda/month/three-day/day/task views and mobile edit sheets.
- Add offline state, sync progress, conflict resolution, and source grouping.
- Add recurrence, attendee, location/map handoff, description, attachment, and
  reminder editor controls using the shared contracts.
- Match desktop task scheduling/deadline/all-day/recurrence behavior, expose the
  Kanban-card attachment chooser, and render compact type icons including the
  birthday marker.
- Wire calendar mutations/lifecycle events to the no-op reminder connector;
  activate Android notification delivery in Phase 11.

Acceptance criteria:

- All sheets remain above the bottom/system navigation areas.
- Multi-server calendars remain distinguishable on phone-sized screens.
- Offline create/edit/complete/delete works and later reconciles.
- Large months render without page scrolling and agendas scroll smoothly on
  representative physical devices.
- Calendar opens and remains usable without opening a vault.
- Task and birthday editor fields match desktop semantics, and tapping an
  attached Kanban task opens the actual card when its vault is available.

### Phase 6: Cross-Location Mirroring

Estimated effort: 3-5 weeks.

Tasks:

- Add mirror-group setup, location eligibility checks, sync anchors, lineage,
  idempotent propagation, deletion handling, and conflict UI.
- Allow any fully connected desktop/mobile client to bridge a configured group.
- Show waiting-for-location and conflict states.

Acceptance criteria:

- Local to server and server-to-server mirroring converge without echo loops.
- Concurrent edits at two locations produce one visible conflict and preserve
  both versions.
- A client missing one server leaves the group pending rather than deleting or
  overwriting data.

### Phase 7: Kanban Assigned Tasks

Estimated effort: 3-4 weeks.

Tasks:

- Add local projection and hosted assignment indexes.
- Update REST and live-CRDT Kanban materialization paths.
- Add generated task calendars and narrow write-through operations.
- Add permission loss, reassignment, archive, recurrence, and source deletion
  handling.

Acceptance criteria:

- Assignment changes made by another user reach the assignee's Android calendar.
- Dates/completion write through only with permission.
- Generated tasks never become duplicate ordinary events.
- Removing vault access removes private source details from future responses.

### Phase 8: iCalendar Import, Export, And Feeds

Estimated effort: 3-5 weeks.

Tasks:

- [x] Implement bounded desktop `.ics` import preview/application and
  full-calendar export.
- [x] Add selected-range and selected-item export plus Android import/export.
- [x] Preserve supported safe unknown properties and broaden time-zone fixtures.
- [x] Add local-profile external read-only subscriptions and conditional stale
  refresh.
- [x] Add hosted external subscription APIs and refresh workers.
- [x] Add revocable published Collab feed tokens.
- [x] Add security limits, SSRF controls, parser fixtures, and round-trip tests.

Acceptance criteria:

- Representative exports import correctly into major calendar applications.
- Reimporting the same UID updates/deduplicates predictably.
- Feed failures never corrupt the last good local copy.
- Revoking a publish token immediately blocks further reads.

### Phase 9: CalDAV And External Two-Way Sync

Estimated effort: 4-7 weeks.

Tasks:

- [x] Implement hosted CalDAV discovery, collections, reports, sync tokens, ETags,
  writes, deletes, and app-password lifecycle.
- [x] Connect CalDAV mutations to the same operation/change-log core.
- [x] Establish the outbound-connector boundary: hosted Collab CalDAV is the
  two-way endpoint; local-only remote-account connectors wait for secure
  background credential management.
- [ ] Test against a maintained interoperability matrix including DAVx5,
  Thunderbird, Apple Calendar, and at least one additional actively maintained
  CalDAV client.

Acceptance criteria:

- External create/update/delete and recurrence exceptions converge on desktop
  and Android.
- Stale ETags produce conflicts rather than lost updates.
- Revoked app passwords stop access without invalidating normal Collab sessions.

### Phase 10: Admin, Privacy, And Production Hardening

Estimated effort: 2-3 weeks after the earlier vertical slices.

Tasks:

- [x] Add aggregate admin API/view, runtime quota settings, usage warnings, and
  operational subscription-worker health.
- [x] Add calendar-specific rate limits plus live retention coverage for
  calendar operation records and abandoned attachment uploads.
- [x] Run privacy response assertions, bounded adversarial recurrence tests,
  and deterministic repeated two-server offline/reconnect soak coverage.
- [x] Update `AGENTS.md`, `docs/desktop/codebase.md`, server protocol, backup,
  security, load-testing, and mobile documentation.
- [ ] Complete a full deployment backup/restore drill and verify calendars,
  change sequences, CalDAV mappings, and tombstones after restore.
- [ ] Complete multi-day physical desktop and Android lifecycle testing across
  two independently hosted servers.

Acceptance criteria:

- Admin UI and API cannot retrieve names or item content.
- Backup/restore preserves calendars, change sequences, and tombstones.
- Query and recurrence limits remain stable under adversarial inputs.
- Desktop and Android pass multi-day offline/reconnect tests across two servers.

Current testing note: the API privacy boundary, rate limiting, retention,
recurrence bounds, and deterministic two-server convergence are covered
automatically. The destructive restore drill and multi-day physical-device
matrix remain manual release gates, so this phase stays in **Testing**.

### Phase 11: Reminder Delivery And Notifications

Estimated effort: 2-4 weeks after core desktop/Android calendar workflows.

The shared notification system's Phases 0-5 are implemented and in testing.
Calendar reminders now reconcile a bounded one-year horizon with typed item
routing, stable replacement, stale cancellation, snooze/action tokens, retry,
and retention. Desktop delivery includes native permission handling,
tray-hidden dispatch, focused in-app suppression, settings, and a status-bar
inbox. Android delivery includes separate channels, runtime permission and
exact-alarm recovery, per-profile native scheduling with an inexact fallback,
safe action receivers, cold-start deep links, lifecycle restoration, and a
mobile inbox. Hosted invitations now enter the attendee's owner-scoped
notification feed transactionally and use opaque FCM invalidations with
authenticated native catch-up.
Profile-local calendar-reminder controls, lock-screen privacy,
timezone-aware quiet hours, urgent bypass, and burst summaries are now enforced
by the native scheduler without removing deferred reminders from the inbox.

Tasks:

- Validate the desktop native notification scheduler, permission-state API,
  tray-hidden delivery, and inbox deep links on packaged target systems.
- Validate Android alarm scheduling, exact-alarm fallback behavior,
  reboot/app-upgrade/time-zone restoration, notification deep links, and native
  actions on the physical-device matrix.
- Reconcile schedules after CRUD, recurrence exceptions, hosted sync, conflict
  resolution, sign-out, and cache removal.
- Validate privacy controls, quiet-hour boundaries, and bounded diagnostics for
  failed schedules on packaged desktop and physical Android targets.

Acceptance criteria:

- Creating, editing, snoozing, completing, or deleting an item produces exactly
  the expected future notifications without duplicates.
- Recurring-event exceptions cancel/reschedule only the intended occurrences.
- Offline notifications fire from cached data and do not require a reachable
  Collab server.
- Reboot, time-zone changes, permission revocation/restoration, and app upgrades
  converge through idempotent reconciliation.

## Test Plan

### Shared Domain

- Date-only and time-zone conversion tests across DST boundaries.
- Recurrence generation, exclusions, overrides, and bounded expansion.
- Recurrence preset/custom-rule round trips and occurrence/following/series
  mutation scopes.
- Task completion and recurring-task behavior.
- Task start/deadline validation, all-day date preservation, recurrence advance
  after completion, reminder cancellation/rescheduling, descriptions, and
  attachment round trips.
- Birthday annual recurrence and all-day reminder scheduling at the configured
  local notification time.
- Structured location normalization, manual-only fallback, attendee/RSVP state,
  and attachment-reference validation.
- Operation idempotency, revision conflict, tombstone, and mirror lineage tests.
- iCalendar fixture parse/serialize/round-trip and malformed-input tests.

### Native Store And Sync

- Migration, transaction interruption, range query, search, and cleanup tests.
- Offline queue replay and cursor atomicity.
- Independent Server A/Server B failures and reconnect ordering.
- Mirror echo prevention and concurrent-edit preservation.
- Subscription ETag, stale cache, backoff, and feed replacement tests.

### Server

- Ownership isolation for every endpoint.
- Disabled account, expired session, quota, body, batch, and recurrence limits.
- Delta paging and idempotent operation retries.
- Admin response snapshots proving private fields are absent.
- Kanban assignment projection under REST and live materialization.
- Hosted attendee lookup/isolation, invitation projection, RSVP, cancellation,
  and event-field visibility tests.
- Attachment upload digest/size/type/quota checks and organizer/attendee/source-
  vault authorization tests.
- Backup/restore and retention integration tests against PostgreSQL.

### Desktop And Android

- Calendar creation by location, visibility, search, and origin grouping.
- Day/week/month/year/agenda/task rendering.
- Quick create, drag, resize, recurring edit scope, reminders, and conflicts.
- Custom calendar Select rendering with color/origin, timed-event default,
  system/12-hour/24-hour formatting, recurrence presets/custom builder,
  descriptions, locations, attendees, and attachments.
- Task custom Select, timed/all-day start and deadline editing, recurring-series
  completion, reminders, description, file attachments, and searchable
  Kanban-card attachment selection.
- Item-type icon rendering and accessible labels for events, tasks, birthdays,
  and Kanban-bound/generated tasks in compact and expanded views.
- Manual location entry with unavailable geocoder, provider result selection,
  attribution, and mobile map-app handoff.
- Reminder connector calls on CRUD/sync/lifecycle changes before delivery is
  activated, followed by notification permission/reboot/time-zone tests in
  Phase 11.
- Offline mutation and reconnect.
- Android bottom-sheet safe areas, back behavior, lifecycle restore, and physical
  device performance.
- Source-linked Kanban task navigation and permission loss.

### Verification Gates

- Focused Vitest suites for shared domain, desktop views, and Android views.
- Rust unit/integration tests for local persistence, server APIs, and sync.
- `pnpm exec tsc --noEmit`.
- `cargo check --workspace` and `cargo test --workspace`.
- `pnpm admin:test` and `pnpm admin:build`.
- Android debug build and physical-device smoke test.
- `git diff --check`.

## Deferred Features

These are compatible with the model but should not expand the first release:

- Shared calendars and per-calendar ACLs.
- Cross-server/external-email invitations, free/busy lookup, room/resource
  scheduling, and email delivery. Hosted Collab-user attendees and in-app RSVP
  are part of the core hosted calendar work.
- Contact synchronization and an automatically managed contacts birthday
  calendar; the initial birthday type is manual/imported.
- Provider-specific OAuth integrations where CalDAV or iCalendar is inadequate.
- End-to-end encryption against the server/database operator.
- Server push notifications and email reminders; Phase 11 delivers local native
  desktop/Android notifications from cached data.
- A public web calendar client separate from the admin application.

## Assumptions To Confirm Before Phase 0 Exits

- "Admins have no access" means no product/API access to private calendar data,
  not protection against an operator with direct database access.
- Hosted calendars remain personal in the first release; hosted event attendees
  receive invitation/event projections, not shared access to the organizer's
  calendar.
- Manual locations always work. Online address validation/map search is an
  optional provider integration and must not block event creation.
- Attachments support vault/Kanban references, calendar-owned uploads, and HTTPS
  links. Referencing a protected source never grants its permissions.
- iCalendar URL subscriptions are read-only. Two-way external synchronization
  uses CalDAV or a provider-specific API.
- Cross-server mirroring occurs through a signed-in Collab client and is not
  guaranteed while no client can reach every selected location.
- Kanban assigned tasks are a generated linked calendar, not copied events.
- Local calendar data belongs to the Collab profile and is not stored in or
  exported with any vault.
