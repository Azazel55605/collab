# Notification System Phase 0 Contract

## Status

Phase 0 implementation is complete and in testing.

This document freezes the shared notification identity, privacy, destination,
action, foreground, and push-invalidation rules used by later desktop, Android,
inbox, and server phases. It does not deliver or persist notifications.

The executable frontend contract lives in:

- `src/types/notification.ts`
- `src/lib/notificationContract.ts`
- `src/lib/notificationContract.test.ts`

The Phase 1 calendar reminder connector now consumes this contract through the
native inbox/schedule ledger. Schedule entries include calendar ID and item kind
so task, event, and birthday notifications do not infer behavior from display
text.

## Source Inventory

Inventory reviewed on 2026-07-28.

### Durable Notification Candidates

| Current source | Current behavior | Notification kind | Phase |
| --- | --- | --- | --- |
| `calendarReminderScheduler.ts` | Reconciles event/task/birthday reminder entries into a no-op connector. | Event, task, and birthday reminders | 1-3 |
| `CalendarRelations.tsx` invitations | Polls hosted invitations and shows an in-calendar badge/popover. | Calendar invitation/update | 1 and 4 |
| `CollabProvider.tsx` incoming chat | Shows a foreground toast when chat is not visible. | Collaboration message | 1-4 |
| Future parsed direct mentions | No separate mention parser or durable source exists yet. | Collaboration mention | 4 |
| `SyncStatusIndicator.tsx` pending-operation failures | Shows a toast when new conflicts require attention. | Sync conflict | 1-3 |
| Background coordinator terminal outcomes | Persists authentication-required, permission-denied, conflict, and failed outcomes. | Sync action required | 1-3 |
| Hosted session recovery | Shows foreground reconnect and reauthentication errors. | Authentication required after a durable/background failure | 1-3 |
| `syncTransferStore.ts` completed user-visible transfers | Keeps bounded foreground transfer history. | Transfer complete only after its UI is no longer visible | 1-3 |

### Foreground-Only Feedback

The following remain React toasts, inline errors, status indicators, or dialogs.
They do not enter the notification inbox or OS notification center:

- successful routine synchronization and background no-op runs
- normal save/create/delete/rename/import/export confirmations
- editor validation, malformed-document, and command-precondition errors
- clipboard, color, template, OCR, and settings confirmations
- vault unlock/password validation
- active transfer progress while the initiating surface is visible
- ordinary server connect/disconnect success
- presence, typing, peer joins/leaves, and live-debug events
- updater availability until a separate update-notification policy is accepted
- one-off network errors already visible in the active view

Relevant toast families were audited in `App.tsx`, `views/`,
`components/layout/`, `components/calendar/`, `components/collaboration/`,
`components/vault/`, `components/editor/`, `components/kanban/`,
`components/image/`, `components/settings/`, and `components/server/`.

Foreground toasts must not be mechanically mirrored into durable
notifications. A source graduates only when it is actionable after the current
surface disappears, time-sensitive, or produced while Collab is not visible.

## Categories, Kinds, And Channels

Stable categories:

- `calendar.reminder`
- `calendar.invitation`
- `collaboration.message`
- `collaboration.mention`
- `sync.action-required`
- `transfer.complete`

Stable platform channels:

- `calendar`: reminders and invitations
- `collaboration`: messages and mentions
- `sync`: conflicts, authentication, and permission changes
- `transfers`: qualifying user-visible transfer completion

Exact kinds select icons, generic hidden titles, default privacy, and allowed
actions. A kind has exactly one category and channel; validation rejects
mismatched combinations.

Successful routine sync is deliberately absent. It remains visible in sync
history and status surfaces.

## Stable Identity

Every notification ID is derived from:

```text
category + accountKey + sourceId + occurrenceKey + deliveryKey
```

The versioned textual form is:

```text
notification:v1:{encoded category}:{encoded account key}:{encoded source ID}:
{encoded occurrence or "-"}:{encoded delivery key}
```

Identity fields:

- `accountKey`: stable opaque profile/account key, never a token, username,
  email address, or raw server URL
- `sourceId`: authoritative calendar item, invitation, chat message, sync
  recovery, background job, or transfer source
- `occurrenceKey`: recurring occurrence identity where applicable
- `deliveryKey`: distinguishes separate reminders or notice variants for the
  same source/occurrence

Reconciliation replaces an existing record with the same ID. It does not append
a duplicate. Snooze creates a new bounded schedule for the same source while
retaining lineage to the original notification in the Phase 1 ledger.

## Destinations And Deep Links

Notification sources store typed destinations, not arbitrary URL strings:

- exact calendar item/occurrence
- calendar invitations
- vault chat
- stable vault file ID
- sync recovery, optionally narrowed to a vault/operation
- notification, server, or background settings
- notification center

The OS notification carries only a short-lived local delivery/action token.
The destination remains in the native inbox/ledger. It is resolved after Collab
starts or restores its window.

Before opening or mutating:

1. Consume and invalidate the local action token.
2. Resolve the opaque account key on this device.
3. Restore the required account/vault/profile if available.
4. Recheck current authentication and capabilities.
5. Resolve the stable source/item/file ID.
6. Refuse stale, removed, inaccessible, malformed, or cross-account targets.

Raw `http:`, `https:`, `file:`, filesystem paths, bearer credentials, refresh
tokens, and server-provided commands are never accepted as notification deep
links.

## Actions

Actions are declarative and selected from a fixed allowlist:

- open
- dismiss
- snooze for 1 minute through 7 days
- complete calendar task
- accept, tentatively accept, or decline calendar invitation
- retry sync
- open server reauthentication

Each notification kind has a bounded action allowlist and at most four unique
actions. Platform labels and icons come from trusted local mappings. A server
cannot provide an arbitrary action label, command, URL, or payload.

Phase 1 stores one-time local action tokens. Actions always reauthorize against
current state and are idempotent where the source operation supports it.

## Privacy Model

Privacy levels:

- `full`: show title and body
- `title-only`: show title, suppress body
- `hidden`: show a local generic kind title, suppress source title and body

Default reminder, invitation, message, and mention privacy is `title-only`.
Generic sync/transfer notifications default to `full` because their accepted
content must already be non-sensitive. The user's lock-screen preference may
only reduce disclosure relative to the source envelope.

Privacy is applied before content reaches a platform adapter. Platform adapters
receive a `NotificationPresentation`, not an unrestricted source object.
Diagnostic logs use category, kind, outcome, and opaque IDs only.

Descriptions, message bodies, attendee details, locations, attachment names,
vault paths, server URLs, usernames, and calendar names are never included in
third-party push payloads.

## Third-Party Push Boundary

Third-party push is optional and only supports:

- calendar invitation invalidation
- collaboration message invalidation
- collaboration mention invalidation
- sync action-required invalidation

The strict payload contains:

```ts
{
  schemaVersion: 1;
  invalidationId: string;
  accountKey: string;
  category: PushInvalidationCategory;
  cursor?: string;
  createdAt: string;
}
```

Identifiers must be opaque. Unknown fields are rejected, specifically
preventing titles, bodies, item IDs, vault IDs, server URLs, destinations, and
actions from crossing the push provider.

After receipt, the client restores the account and fetches authorized inbox
content from Collab. Polling/catch-up remains the correctness path. Push is only
a latency optimization.

Local calendar reminders never require push or a reachable server at fire time.

## Foreground Suppression

Delivery decisions:

- app not visible: native notification
- app visible at the exact typed destination: suppress native delivery
- app visible elsewhere: in-app banner/inbox update

Destination equality includes the exact calendar occurrence, vault/file, chat,
sync operation, or settings section. Merely having Collab focused does not
suppress an actionable notice for a different destination.

Transfer completion is suppressed while its initiating transfer UI remains
visible. Successful routine work remains status-only.

## Multi-Device Deduplication

- Stable notification IDs are identical for the same hosted source,
  occurrence, and delivery variant when devices resolve the same opaque account
  key.
- Delivery state is device-local; read/action source state synchronizes through
  its authoritative calendar, invitation, message, or sync operation.
- Duplicate push invalidations replace by invalidation ID/cursor and trigger one
  authenticated catch-up.
- An action that already succeeded on another device converges as a no-op or
  current-source response, not a second mutation.
- Local-only calendars have no cross-device deduplication requirement.
- Dismissal is device-local unless a later category explicitly defines synced
  dismissal.

## Preference Contract

Phase 0 defines, but does not yet persist, these device-local defaults:

- notifications enabled
- lock-screen privacy: `title-only`
- every initial category enabled
- no quiet-hours interval
- time-sensitive reminders may bypass future quiet hours

Phase 5 adds global and scoped persistence. OS permission/channel state remains
device-local and is never synchronized as an account preference.

## Phase 1 Handoff

Phase 1 may now implement:

- native inbox and delivery ledger using this envelope
- stable-ID replacement and retention
- one-time action tokens
- reminder-entry to envelope conversion
- bounded recurrence horizon reconciliation
- cancellation on profile/server/cache removal
- read, dismiss, snooze, action, retry, and failure state
- background coordinator hooks

Phase 1 must not expand the category/action/push surface without updating this
contract and its validation tests first.
