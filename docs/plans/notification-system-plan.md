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
  inbox/schedule ledger. OS notification presentation remains Phase 2/3 work.
- The server has no general push-delivery service and should not be required for
  local calendar reminders.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 0. Notification contract and privacy model | Testing | Define notification types, channels, IDs, preferences, redaction, and deep-link behavior. |
| 1. Shared notification inbox and scheduler | Testing | Persist deduplicated delivery state and activate the calendar reminder connector. |
| 2. Desktop native delivery | Not started | Deliver native notifications while Collab is open, hidden, or running in the tray. |
| 3. Android native delivery | Not started | Add channels, runtime permission, scheduled reminders, actions, and deep links. |
| 4. Server-originated activity delivery | Not started | Add privacy-minimal invalidation delivery for hosted invitations, mentions, and selected activity. |
| 5. Preferences, quiet hours, and inbox UX | Not started | Give users per-account, per-calendar, per-vault, and per-type control. |
| 6. Hardening and release | Not started | Validate time changes, recurrence, duplicates, permissions, upgrades, and multi-device behavior. |

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

- Add permission/status handling and native notification delivery.
- Integrate notification clicks with single-instance window restore.
- Deliver while the window is hidden in the tray.
- Add settings and in-app inbox surfaces.

### Phase 3: Android Native Delivery

- Add manifest permissions, channels, and native scheduling.
- Implement deep links and action receivers.
- Reconcile schedules after reboot, app update, timezone change, and data sync.
- Add Android settings and permission recovery UI.

### Phase 4: Server-Originated Activity

- Add device registration and token rotation without exposing tokens to the
  webview.
- Add opaque push invalidations and authenticated payload fetch.
- Start with calendar invitations and mentions.
- Keep polling/catch-up as a correctness path.

### Phase 5: Preferences And Quiet Hours

- Add category/scoped controls and lock-screen privacy.
- Add quiet hours, batching, and summary behavior.
- Ensure birthdays and other item kinds retain distinct icons and semantics.

### Phase 6: Hardening And Release

- Validate recurrence edits, daylight-saving transitions, timezone changes,
  clock changes, stale schedules, duplicate push, and multi-device actions.
- Test denied/revoked permissions and OS notification-channel changes.
- Verify server removal, logout, cache removal, and account disabling cancel or
  redact pending notifications.
- Add delivery metrics that contain no private titles or descriptions.

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
