# Notification System Plan

## Summary

Add one privacy-aware notification system for desktop and Android. It should
deliver calendar reminders, task deadlines, collaboration activity, invitations,
and actionable sync failures while preserving the current multi-server and
offline model.

Notification policy, deduplication, and delivery state should be shared. Native
desktop notifications and Android notification channels are platform adapters;
React toasts remain foreground UI and are not the durable notification system.

## Current State

- Calendar items already store relative and absolute reminders.
- `CalendarReminderScheduler` and `CalendarReminderScheduleEntry` define a
  platform-neutral scheduling connector.
- Desktop and Android now use the native ledger connector; the no-op
  implementation remains available only for isolated consumers and tests.
- Phase 0 now defines and validates the shared notification envelope, stable
  identity, typed destinations/actions, privacy presentation, foreground
  suppression, preferences, and content-free push invalidations.
- Desktop and mobile now reconcile calendar reminders into the shared native
  inbox/schedule ledger.
- Desktop permission handling, native delivery, tray-hidden dispatch, the
  status-bar inbox, and notification settings are implemented and in testing.
- Android channels, permission recovery, per-profile alarms, native delivery,
  safe actions, deep links, lifecycle restoration, settings, and the durable
  mobile inbox are implemented and in testing.
- Hosted calendar invitations and chat mentions now enter an owner-scoped
  server event feed. Android may receive a content-free FCM invalidation, while
  authenticated foreground and WorkManager catch-up remain authoritative.
- Desktop and Android now persist profile-local delivery preferences for the
  master switch, categories, source-scope overrides, lock-screen privacy,
  quiet hours, urgent bypass, and burst summaries. The native scheduler
  enforces those preferences without removing durable inbox records.
- Server administrators can send a privacy-bounded self-test through the real
  authenticated notification feed; the admin API never exposes device tokens
  or permits targeting another user.
- Server removal and account disabling now cancel matching pending deliveries,
  concurrent notification actions have a single winner, and the administration
  overview exposes aggregate-only delivery health without private content.
- Local calendar reminders do not require a server or push provider.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 0. Notification contract and privacy model | Testing | Define notification types, channels, IDs, preferences, redaction, and deep-link behavior. |
| 1. Shared notification inbox and scheduler | Testing | Persist deduplicated delivery state and activate the calendar reminder connector. |
| 2. Desktop native delivery | Testing | Deliver native notifications while Collab is open, hidden, or running in the tray. |
| 3. Android native delivery | Testing | Add channels, runtime permission, scheduled reminders, actions, and deep links. |
| 4. Server-originated activity delivery | Testing | Add privacy-minimal invalidation delivery for hosted invitations, mentions, and selected activity. |
| 5. Preferences, quiet hours, and inbox UX | Testing | Give users per-account, per-calendar, per-vault, and per-type control. |
| 6. Hardening and release | Testing | Lifecycle cleanup, concurrency, DST/timezone coverage, and privacy-safe aggregate delivery metrics are implemented; packaged desktop and physical Android validation remain. |

## Notification Types

Initial supported categories:

- calendar event reminder
- task start, deadline, and overdue reminder
- birthday reminder
- hosted calendar invitation, update, cancellation, and RSVP
- mention or direct collaboration activity
- sync conflict, repeated sync failure, or authentication required
- completed foreground upload/download when the user left the app

Later candidates:

- shared-vault activity summaries
- server administration alerts
- application update availability
- user-defined automation notifications

Low-value background churn must not generate notifications. Successful routine
syncs belong in the sync menu and history, not the operating-system notification
center.

## Shared Domain

```ts
type NotificationCategory =
  | 'calendar.reminder'
  | 'calendar.invitation'
  | 'collaboration.mention'
  | 'sync.action-required'
  | 'transfer.complete';

interface NotificationEnvelope {
  id: string;
  category: NotificationCategory;
  accountKey?: string;
  sourceId: string;
  occurrenceKey?: string;
  scheduledAt?: string;
  createdAt: string;
  title: string;
  body?: string;
  deepLink?: string;
  actions?: NotificationAction[];
  privacy: 'full' | 'title-only' | 'hidden';
}
```

The exact implementation may be Rust rather than TypeScript, but these
properties are required:

- stable IDs for idempotent replacement and cancellation
- source and occurrence keys for recurring calendar entries
- account/server origin without exposing credentials
- native deep link and bounded action descriptors
- a privacy mode selected before platform rendering

## Delivery Model

### Local Scheduling

Calendar reminders and known task deadlines are scheduled from cached local
data. They must work offline and must not depend on a server call at fire time.

The scheduler:

- expands recurrence only within a bounded rolling horizon
- reconciles additions, edits, deletions, timezone changes, and completed tasks
- replaces matching schedules idempotently
- cancels schedules when a profile, calendar, or server is removed
- refreshes the horizon during foreground and background maintenance

### Hosted Activity

For invitations, mentions, and server-side activity, use a two-step model:

1. The server sends an opaque account-scoped invalidation containing no private
   calendar or document content.
2. The authenticated client fetches the authorized notification payload and
   stores it in the local inbox before native delivery.

This keeps push-provider payloads minimal and preserves server authorization as
the source of truth. Polling remains the fallback when push is unavailable.

### Foreground Behavior

- Native delivery is suppressed or converted to an in-app banner when the exact
  destination is already visible.
- Every delivered notification also has an inbox record unless it is a
  short-lived transfer completion.
- Opening a notification routes to the correct server, vault, calendar item,
  Kanban task, or recovery surface.

## Platform Delivery

### Desktop

- Use the Tauri notification integration for native delivery.
- Tie scheduled delivery to the background coordinator and tray lifecycle.
- Clicking a notification restores/focuses the main window and processes a
  validated deep link.
- Windows/macOS/Linux platform differences are isolated in the adapter.
- If notification permission is denied or unavailable, retain the item in the
  in-app inbox and show the state in settings.

### Android

Create stable notification channels:

- Calendar and deadlines
- Collaboration
- Sync and account action
- Transfers

Android requirements:

- request `POST_NOTIFICATIONS` at an appropriate user-triggered moment
- schedule durable reminders through native alarms/work as appropriate to the
  required precision and current Android policy
- use WorkManager for horizon reconciliation and non-exact background activity
- provide content intents/deep links and bounded actions such as Mark task done,
  Snooze, Accept, Decline, or Retry sync
- use a foreground-service notification only for qualifying user-visible long
  transfers, not for routine background existence

Exact alarms should be avoided unless product requirements and store policy
justify their permission and battery cost.

## Preferences And UX

Global settings:

- master notification switch
- lock-screen privacy: full, title only, or hidden
- quiet hours and allowed urgent categories
- default reminder behavior
- notification sound/vibration choices where the platform supports them

Scoped settings:

- per server/account
- per vault for collaboration activity
- per calendar
- per category

The in-app notification center should show unread/action-required items,
delivery failures, source account, and a direct route to relevant settings.
Preferences must synchronize only when their scope makes that appropriate;
device-specific delivery permission and channel state remain local.

## Phase Details

### Phase 0: Contract And Privacy Model

- [x] Inventory all current toast, sync error, invitation, and reminder sources
  in the [Phase 0 contract](./notification-system-phase0-contract.md).
- [x] Finalize categories, stable IDs, typed destinations, bounded actions, and
  privacy defaults.
- [x] Define the strict content-free payload that may cross a third-party push
  service.
- [x] Specify foreground suppression and multi-device deduplication behavior.
- [x] Add executable TypeScript validation, redaction, destination, push, and
  reminder-routing contract tests.

Phase 0 implementation is complete and is now in testing. No native delivery,
permission prompt, inbox storage, or OS scheduling is enabled by this phase.
Phase 1 consumes this contract and activates the existing reminder connector.

### Phase 1: Shared Inbox And Scheduler

- [x] Add a native notification store and delivery ledger.
- [x] Implement the calendar reminder connector against it.
- [x] Add bounded recurrence expansion and reconciliation.
- [x] Add read, dismiss, snooze, action-token, retry, and retention operations.
- [x] Feed scheduler reconciliation from foreground and background calendar
  sync.

Phase 1 is implemented and in testing. The profile-scoped SQLite ledger
atomically replaces stable reminder identities and cancels stale schedules.
Desktop and Android reconcile a bounded one-year occurrence horizon using the
shared calendar recurrence implementation. Headless calendar sync persists a
coalesced reconciliation request; foreground reconciliation consumes it.
Native action tokens are hashed, short-lived, allowlisted, and one-time.

Phase 1 does not display an inbox surface or issue OS notifications. Those
presentation and permission boundaries remain in desktop Phase 2 and Android
Phase 3. Until the recurrence engine has a shared Rust implementation, a
headless sync records durable reconciliation work instead of approximating
timezone-aware recurrence in the background worker.

### Phase 2: Desktop Native Delivery

- [x] Add permission/status handling and native notification delivery.
- [x] Route notification-center opens through the existing single-instance
  main-window restore path.
- [x] Deliver due records while the window is hidden in the tray.
- [x] Add settings and in-app inbox surfaces.
- [x] Apply notification privacy before handing content to the operating
  system and record whether delivery used the native or in-app surface.
- [ ] Validate permission request/revocation, focused suppression, tray-hidden
  delivery, and window restoration on packaged Linux, Windows, and macOS
  builds.

The desktop adapter uses the Tauri notification plugin for permission state and
native presentation. Due records are dispatched by the existing native
background lifecycle, so hiding the webview does not stop delivery. Focused
windows retain reminders in the in-app inbox; hidden or unfocused windows use
the operating-system notification center when permission is granted.

The current desktop plugin surface does not expose portable per-notification
action callbacks. The tray **Notifications** command restores the single
instance and opens the inbox, where calendar destinations deep-link into the
appropriate day. Native action receivers, one-time action-token consumption,
and direct notification-tap routing are therefore owned by Android Phase 3
rather than emulated differently on each desktop platform.

### Phase 3: Android Native Delivery

- [x] Add manifest permissions and separate calendar, collaboration, sync, and
  transfer channels.
- [x] Schedule one bounded AlarmManager alarm per profile, using exact alarms
  when Android permits them and `setAndAllowWhileIdle` as the explicit fallback.
- [x] Deliver from the native profile ledger without requiring the activity or
  webview to be alive.
- [x] Deep-link notification taps through the single-task activity into the
  validated ledger destination, including cold-start persistence.
- [x] Add non-exported dismiss and snooze receivers backed by hashed, one-time,
  allowlisted action tokens.
- [x] Reconcile alarms after reboot, app replacement, manual clock changes,
  timezone changes, foreground data reconciliation, and WorkManager sync.
- [x] Add Android permission recovery, exact-alarm recovery, test delivery, and
  the durable notification inbox to mobile Settings.
- [ ] Validate permission denial/recovery, doze delivery, reboot/app-upgrade
  restoration, clock/timezone changes, and native tap/actions on physical
  Android 8, 12, 13, and current target-SDK devices.

Android reminders are not tied to the 15-minute WorkManager cadence. The native
ledger exposes only the next due instant for each profile; AlarmManager wakes a
bounded receiver, which obtains privacy-reduced due payloads from Rust, posts
them to the appropriate channel, marks delivery, and schedules the next alarm.
Exact-alarm access is optional: the settings screen explains and links to the
system control, while the scheduler remains functional with Android's inexact
idle-aware fallback.

Native intents contain only a profile ID, notification ID, or one-time action
token. Notification destinations are reloaded from the validated ledger before
mobile navigation. Swipe dismissal and explicit snooze/dismiss actions are
handled without exposing the receiver or embedding credentials. Source-specific
mutations such as invitation responses and task completion remain in-app until
their authenticated processors are added with the server-originated activity
work.

### Phase 4: Server-Originated Activity

- [x] Add device registration and token rotation without exposing tokens to the
  webview.
- [x] Add opaque push invalidations and authenticated payload fetch.
- [x] Start with calendar invitations and mentions.
- [x] Keep polling/catch-up as a correctness path.
- [x] Add bounded, leased server delivery attempts and deactivate provider-
  rejected tokens.
- [x] Deep-link fetched invitations and mentions into the desktop and mobile
  application surfaces.
- [ ] Validate FCM token rotation, delayed/duplicate push, logout cleanup,
  process-dead delivery, and catch-up on the physical Android matrix.

Phase 4 is implemented and in testing. Each hosted account has an append-only,
owner-scoped notification cursor. Server writes create the notification event
and its per-device outbox rows in the same PostgreSQL transaction as the
calendar invitation or chat mention. Delivery workers claim bounded leases and
retry failures without placing calendar, vault, user, title, description, or
credential data in the push payload.

Android owns its FCM installation identifier and Collab installation ID in the
native layer. Native
login/reconnect rotates registration, logout deactivates it, and the Firebase
service passes only a strictly validated invalidation into the Rust background
coordinator. The coordinator restores the native session, fetches bounded
authenticated pages, validates them through the shared notification ledger,
and reschedules local delivery. Periodic and foreground catch-up use the same
path, so push remains a latency optimization rather than a correctness
dependency.

The Collab server intentionally targets a small operator-configured HTTPS push
gateway instead of embedding provider service-account credentials or OAuth
logic. The gateway receives one opaque provider target plus one opaque
invalidation, maps the
invalidation fields to FCM string data, returns `2xx` when accepted and `410`
for a permanently invalid token. Deployments without a gateway retain
authenticated notification polling.

### Phase 5: Preferences And Quiet Hours

- [x] Persist profile-local master, category, and source-scope overrides.
- [x] Add lock-screen privacy that may only redact more content than the
  notification envelope permits.
- [x] Add timezone-aware quiet hours with an explicit time-sensitive bypass.
- [x] Defer native scheduling through quiet hours without removing inbox
  records, including deterministic daylight-saving gap handling.
- [x] Add bounded desktop and Android burst summaries.
- [x] Retain distinct birthday, calendar, collaboration, and sync icons and
  semantics in the desktop and mobile inboxes.
- [x] Add desktop and Android settings surfaces backed by typed Tauri commands.
- [x] Add per-server, per-vault, and per-calendar controls to desktop and
  Android notification settings using the persisted source-scope contract.
- [ ] Validate quiet-hour boundaries, DST transitions, lock-screen redaction,
  Android summaries, and source overrides on packaged desktop and physical
  Android targets.

Phase 5 is implemented and in testing. Preferences live in the native
profile-scoped notification database rather than webview storage. Desktop and
Android settings inventory saved servers, known vaults, and active calendars,
then store only explicit muted overrides. Per-server, per-vault, and
per-calendar controls use stable scope keys and are enforced whenever the
validated envelope contains that scope.
Source inventories use compact single-open accordion groups instead of nested
scroll regions. Linux native notifications explicitly request the packaged
`com.azazel.collab` icon rather than relying on executable-name discovery.

Authenticated hosted catch-up stamps each fetched envelope with its already
validated native server origin before local ingestion. This provenance never
enters third-party push payloads and cannot be supplied by an untrusted server
to redirect a scope. Vault and calendar controls continue to use their stable
domain IDs.

Quiet hours are evaluated in their saved IANA timezone. Time-sensitive items
may bypass them only when the user explicitly leaves that option enabled.
Disabled or deferred records remain available in the durable inbox, while the
platform scheduler ignores them or wakes at the quiet-hours boundary.

### Phase 6: Hardening And Release

- [x] Validate recurrence edits, daylight-saving transitions, timezone changes,
  clock changes, stale schedules, duplicate push, and multi-device actions.
- [x] Cover concurrent action consumption and deterministic duplicate
  reconciliation in the native ledger.
- [x] Verify server removal, logout, cache removal, and account disabling cancel or
  redact pending notifications.
- [x] Add delivery metrics that contain no private titles or descriptions.
- [ ] Complete packaged-desktop permission revocation and restoration checks.
- [ ] Complete physical-Android permission denial/revocation, channel changes,
  reboot, app-upgrade, timezone/clock changes, alarm fallback, and multi-device
  action checks.

Phase 6 is implemented and in **Testing**. Automated coverage now exercises
timezone and DST boundary recomputation, one-time concurrent actions,
server-scoped cancellation, account-disable delivery cleanup, and aggregate
metrics privacy. The remaining work is the packaged and physical-device matrix,
not application implementation.

## Security And Privacy

- Validate every deep link and action against the current authenticated
  account and current permission before opening or mutating content.
- Notification actions use one-time, scoped local tokens rather than bearer
  tokens embedded in intents.
- Push payloads contain opaque IDs and coarse category information only.
- Sensitive titles and descriptions are redacted according to lock-screen
  privacy before leaving the application process.
- The server cannot expose one user's private calendar content through admin
  notification tooling or aggregate usage APIs.

## Test Plan

- Scheduler tests for recurrence, edits, cancellation, snooze, and timezones.
- Idempotency tests for duplicate sync results and push invalidations.
- Desktop permission, tray, click-routing, and hidden-window tests.
- Android channel, permission, alarm/work reconciliation, reboot, and action
  tests on physical devices.
- Privacy tests for lock-screen redaction and opaque server payloads.
- Authorization tests for stale deep links and revoked server access.
- `pnpm exec tsc --noEmit`, focused Vitest suites, `cargo test --workspace`,
  Android builds, and `git diff --check`.

## Dependencies

- [Background Running Plan](./background-running-plan.md) supplies durable
  scheduling, session restoration, and background execution.
- [User Calendar Feature Plan](./user-calendar-feature-plan.md) supplies the
  reminder model and calendar synchronization.
- [Mobile Widget Ideas](../mobile/mobile-widget-ideas.md) may reuse the inbox and
  background snapshots but does not require notifications for its first slice.
