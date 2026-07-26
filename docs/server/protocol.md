# Collaboration Server Protocol

## Versioning

- REST endpoints are rooted at `/api/v1`.
- WebSocket endpoints are rooted at `/ws/v1`.
- Clients send `X-Collab-Client-Version` and `X-Collab-Protocol-Version`.
- The server returns its supported protocol version and rejects incompatible clients with `protocol_version_unsupported`.
- Breaking changes require a new major API path. Additive fields within a major version are allowed.

## REST Conventions

- JSON uses camelCase.
- IDs are opaque strings.
- Timestamps are UTC RFC 3339 strings.
- Collection endpoints use cursor pagination with `items` and `nextCursor`.
- Mutations include `clientOperationId` where retry is possible.
- Binary transfers use dedicated upload/download endpoints. The initial bounded
  upload endpoint accepts base64 JSON; resumable streaming sessions replace it
  for larger transfers in a later phase.

Successful single-resource response:

```json
{
  "data": {}
}
```

Successful collection response:

```json
{
  "data": {
    "items": [],
    "nextCursor": null
  }
}
```

Error response:

```json
{
  "error": {
    "code": "vault_permission_denied",
    "message": "You do not have permission to modify this vault.",
    "requestId": "019...",
    "details": {}
  }
}
```

The server returns safe user-facing messages. Internal errors and secrets remain in structured server logs keyed by `requestId`.

## Stable Error Codes

Initial error families:

- `authentication_required`
- `authentication_invalid`
- `session_expired`
- `session_revoked`
- `user_disabled`
- `rate_limited`
- `resource_not_found`
- `validation_failed`
- `path_invalid`
- `path_conflict`
- `vault_permission_denied`
- `vault_archived`
- `revision_conflict`
- `manifest_conflict`
- `operation_conflict`
- `operation_already_applied`
- `upload_incomplete`
- `upload_hash_mismatch`
- `quota_exceeded`
- `protocol_version_unsupported`
- `maintenance_mode`
- `server_unavailable`

## Initial Endpoint Groups

Authentication and administration:

- `GET /api/v1/auth/bootstrap-status`
- `POST /api/v1/auth/bootstrap`

Bootstrap-status responses use `Cache-Control: no-store` so browsers and
gateways cannot replay the initial first-run result after an administrator has
been created or the server has restarted.
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/native/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/native/logout`
- `POST /api/v1/auth/invitations/{token}/accept`
- `POST /api/v1/auth/ws-ticket`
- `GET /api/v1/users/me`
- `POST /api/v1/users/me/password`
- `GET|POST /api/v1/admin/users`
- `PATCH|DELETE /api/v1/admin/users/{userId}`
- `POST /api/v1/admin/users/{userId}/revoke-sessions`
- `POST /api/v1/admin/users/{userId}/reset-password`
- `GET /api/v1/admin/users/{userId}/activity`
- `GET|POST /api/v1/admin/invitations`
- `POST /api/v1/admin/invitations`
- `GET /api/v1/admin/overview`
- `GET /api/v1/admin/audit-events`
- `GET /api/v1/admin/operational-warnings`
- `GET /api/v1/admin/vaults`
- `GET|PATCH|DELETE /api/v1/admin/vaults/{vaultId}`
- `GET|POST /api/v1/admin/vaults/{vaultId}/members`
- `PATCH|DELETE /api/v1/admin/vaults/{vaultId}/members/{userId}`
- `GET /api/v1/admin/vaults/{vaultId}/activity`

Browser administration uses the same administration resources but authenticates
with a hardened same-origin browser session and CSRF protection. Native clients
use short-lived opaque access tokens and rotating opaque refresh tokens. Reuse
of a rotated refresh token revokes its native session. The desktop keeps access
tokens in memory and refresh tokens in the operating system credential store.
Administration collection endpoints return only typed, redacted data.
The first bootstrapped administrator is marked as the primary administrator;
status updates cannot disable it and the user deletion endpoint rejects it.
The admin overview includes live-collaboration metrics for open WebSocket
connections, loaded document rooms, active awareness states, recent CRDT update
rate, pending update-log size, compacted document count/bytes, and the last
compaction timestamp.

Administration vault endpoints act with server-operator authority and do not
require vault membership. `GET /admin/vaults/{vaultId}` returns a
`HostedVaultAdminDetail` with status, manifest sequence, member count,
active/trashed file counts, and storage usage. `PATCH` renames or moves a vault
between `active` and `archived` (including restoring a pending-delete vault);
`DELETE` marks it pending deletion. Member endpoints add, re-role, and remove
members but never modify the owner membership, and member mutations are
rejected while a vault is pending deletion. Every administration vault mutation
records both an audit event and a vault activity event flagged
`byServerAdmin`.

Active server administrators also receive implicit vault-admin access on
hosted-vault content endpoints. This lets the administration interface browse,
download, move, import/export, and inspect or restore document revisions in
every vault without creating operator memberships. Implicit access never makes
the operator the distinguished vault owner.

Vault management:

- `GET|POST /api/v1/vaults`
- `GET|PATCH|DELETE /api/v1/vaults/{vaultId}`
- `GET|POST /api/v1/vaults/{vaultId}/members`
- `PATCH|DELETE /api/v1/vaults/{vaultId}/members/{userId}`
- `GET /api/v1/vaults/{vaultId}/templates`
- `GET|POST /api/v1/vaults/{vaultId}/logic-components`
- `PUT|DELETE /api/v1/vaults/{vaultId}/logic-components/{componentId}`
- `GET /api/v1/vaults/{vaultId}/storage`
- `POST /api/v1/vaults/{vaultId}/import`
- `GET|POST /api/v1/vaults/{vaultId}/chat`
- `GET /api/v1/vaults/{vaultId}/export`

The initial import/export implementation is admin-only. Import accepts a
bounded base64-encoded ZIP into an empty active hosted vault, validates the
entire archive before metadata commit, ignores runtime `.collab/` content, and
generates stable hosted IDs and initial revisions. Export returns an
`application/zip` containing active folders and current file content.

The viewer-readable storage endpoint reports current active and trash bytes,
retained revision bytes, unique per-vault blob bytes, and file, revision, and
snapshot counts. `storageBytes` on vault summaries remains the retained
revision byte total for compatibility with administration views.

`POST /api/v1/vaults/{vaultId}/files/{fileId}/revisions/{revisionId}` restores
an older text-document revision by creating a new current revision. It requires
the expected current revision sequence and never rewinds or deletes history.

The initial Phase 3 vault-management slice is implemented. Creating a vault
makes the authenticated user its owner and administrator. Listings expose only
vaults where the authenticated user has a persisted membership. Vault
administrators can rename vaults and manage viewer/editor memberships; only the
owner can grant or remove administrators, archive a vault, or mark it pending
deletion. Archived and pending-delete vaults reject membership mutations.

`PATCH /api/v1/vaults/{vaultId}/members/{userId}` accepts one of `role`,
`capabilities` (an explicit fine-grained override), `templateId` (a permission
template assignment), or `resetToRoleDefault: true`. A `role` change requires
`vault.manageMembers` and clears any override; capability/template/reset edits
require `vault.managePermissions`. The member DTO carries the effective
membership-level `capabilities`, the `customCapabilities` override (when set),
and the assigned `templateId`/`templateName`. A non-owner administrator cannot
remove their own `vault.manageMembers`/`vault.managePermissions` capabilities
(self-lockout guard). `GET /api/v1/vaults/{vaultId}/templates` is readable with
`vault.managePermissions` so vault administrators can assign templates from the
native client; template CRUD and group grants remain server-admin-only under
`/api/v1/admin`.

Reusable logic components are vault-scoped JSON payloads under
`/api/v1/vaults/{vaultId}/logic-components`. Listing requires `vault.read`;
create, update, and delete require `file.write` on an active vault. `POST`
upserts by component name and increments the stored version for existing names,
while `PUT` updates a specific component id and rejects duplicate names.

Files and history:

- `GET /api/v1/vaults/{vaultId}/manifest`
- `GET|POST /api/v1/vaults/{vaultId}/files`
- `GET|PATCH|DELETE /api/v1/vaults/{vaultId}/files/{fileId}`
- `GET|POST /api/v1/vaults/{vaultId}/files/{fileId}/revisions`
- `GET /api/v1/vaults/{vaultId}/files/{fileId}/revisions/{revisionId}`
- `GET|POST /api/v1/vaults/{vaultId}/files/{fileId}/snapshots`
- `POST /api/v1/vaults/{vaultId}/files/{fileId}/snapshots/{snapshotId}/restore`
- `POST /api/v1/vaults/{vaultId}/operations`
- `POST /api/v1/vaults/{vaultId}/operations/preview`
- `GET /api/v1/vaults/{vaultId}/files/{fileId}/references`
- `POST /api/v1/vaults/{vaultId}/uploads`
- `GET /api/v1/vaults/{vaultId}/files/{fileId}/content`
- `GET /api/v1/vaults/{vaultId}/activity`
- `GET /api/v1/vaults/{vaultId}/search`

The Phase 3 manifest and text-revision slice implements:

- `GET /manifest` and `GET /files` with stable file IDs and derived relative
  paths.
- `POST /files` for folders and text-backed note, Kanban, and canvas documents.
- `GET /files/{fileId}` for the current materialized text content.
- `GET|POST /files/{fileId}/revisions` for history and optimistic writes using
  `expectedRevisionSequence`.

Each successful create or text revision increments the vault manifest sequence
and records vault activity. Text payloads use the content-addressed blob store.
Viewer reads are allowed; mutations require editor access and an active vault.

`GET /manifest/delta?since={sequence}` is viewer-readable and supports native
offline replicas. It returns the current vault manifest sequence plus only file
entries whose manifest-visible state changed after `since`; clients merge those
entries by stable file ID into their cached manifest. Existing rows are marked
conservatively at migration time, so an older replica may receive a one-time
catch-up delta containing all known file entries.

`GET /search?q={query}` is viewer-readable and searches the current active
hosted note revisions. Results include stable file IDs, derived paths, titles,
frontmatter tags, excerpts, and full-text relevance ranks. The server repairs
missing or stale persisted index rows from current note revisions before
querying, so existing hosted vaults do not require a manual reindex operation.

The binary and structural-operation slice also implements:

- `POST /uploads` for bounded base64 assets with a required SHA-256 digest,
  content-addressed blob deduplication, and a configurable per-file limit.
- `GET /files/{fileId}/content` for authenticated raw content downloads with
  digest verification.
- `POST /operations` for idempotent rename, move, trash, restore, and purge.
  Operations target stable file IDs and include `clientOperationId` and
  `baseManifestSequence`; stale manifests return `manifest_conflict`.
- Editor access for rename, move, trash, and restore. Purge requires vault
  administrator access.
- `GET /revisions/{revisionId}` returns immutable historical text content for
  comparison views.
- `GET|POST /snapshots` lists or labels immutable revisions. Snapshot creation
  does not advance the manifest because it does not change file content.
- `POST /snapshots/{snapshotId}/restore` requires
  `expectedRevisionSequence`, creates a new immutable revision, advances the
  vault manifest, and preserves the intervening history.

The reference-impact slice also implements:

- `GET /files/{fileId}/references` lists where an active file is referenced by
  note links and wikilinks, Kanban attachments, and canvas file/note nodes.
  Viewer access is sufficient because the listing is read-only.
- `POST /operations/preview` returns a non-mutating
  `HostedStructuralOperationPreview` with the old and new relative paths, the
  nested active item count, the documents whose references would be rewritten,
  and a `blockedReason` instead of an error when the operation cannot apply
  (for example a destination collision). Preview requires the same role the
  previewed operation would require.
- Rename and move operations rewrite affected references in other active
  documents inside the same transaction. Each rewritten document receives a
  new revision attributed to the acting user, and a `file.references_rewritten`
  activity event records the rewritten document IDs. Trash accepts an optional
  `removeReferences` flag that removes references instead. Reference analysis
  and rewriting share `collab-core` logic with the native local-vault flows;
  unparseable board or canvas documents are skipped rather than blocking the
  operation.
- `HostedStructuralOperationResult` now includes `rewrittenDocumentIds`, which
  is preserved for idempotent replays of the same `clientOperationId`.

Resumable streaming upload sessions remain a later Phase 4 task.

## WebSocket Protocol

Connection (implemented in Phase 5):

1. Obtain a single-use ticket with `POST /api/v1/auth/ws-ticket` (body
   `{ "vaultId": "..." }`). The caller authenticates with its normal browser
   session or native access token and must already hold read access to the
   vault. The ticket is stored hashed, is bound to that one vault and user,
   expires quickly (`COLLAB_WS_TICKET_TTL_SECONDS`, default 30s), and is
   single-use. Bearer tokens never travel in the WebSocket URL.
2. Connect to `/ws/v1/vaults/{vaultId}`.
3. Send an `authenticate` control frame containing the ticket (optionally a
   `protocolVersion`).
4. The server checks `protocolVersion` first and, on a mismatch, closes with
   `protocol_version_unsupported` **before** consuming the ticket, so the still
   single-use ticket can be retried by a compatible client. Otherwise it
   validates and consumes the ticket, re-resolves the user's vault capabilities,
   and returns `ready` with the current manifest sequence, the caller's derived
   role, and the negotiated `protocolVersion` (which the client validates before
   subscribing) — or an `error` frame and closes.

Two frame shapes travel over the socket:

* **JSON text frames** carry control messages, tagged by `type`:

  ```json
  { "type": "document.subscribe", "fileId": "019..." }
  ```

* **Binary frames** carry CRDT and awareness traffic with a fixed header:
  `[tag: u8][fileId: 16-byte UUID][payload]`. Payloads are Yjs v1 encoded bytes
  (a state vector for `SYNC_STEP1`, an update for `SYNC_UPDATE`, or a
  y-protocols awareness update for `AWARENESS`), wire-compatible with the
  browser's Yjs documents.

Implemented control messages:

- `authenticate` (client) / `ready` (server)
- `document.subscribe` (client) / `document.subscribed` (server)
- `document.unsubscribe` (client)
- `ping` (client) / `pong` (server)
- `error` (server)

Implemented binary message tags: `SYNC_STEP1` (1), `SYNC_UPDATE` (2), and
`AWARENESS` (3).

Authorization is enforced on every message: a session needs read access to
subscribe and editor (`file.write`) access on an active vault to apply a
`SYNC_UPDATE`; viewers receive a read-only stream and a `SYNC_UPDATE` from a
viewer is rejected with `vault_permission_denied` and never persisted. Document
updates are persisted to an append-only per-file log and broadcast to other
subscribed sessions; a freshly connected client recovers state through the
`SYNC_STEP1`/`SYNC_UPDATE` handshake. Native live providers do not expose a
session to document editors until the initial state-vector response has been
applied, preventing an empty local CRDT from briefly becoming authoritative.
Handshake/no-op updates remain in the CRDT log for convergence but do not wake
the materializer or create normal document revisions.

Structured `.kanban` and `.canvas` JSON numbers are encoded as Yjs numbers, not
Yjs BigInt. Native clients normalize legacy BigInt values to ordinary JSON
numbers at the live-transport boundary so numeric validation and serialization
remain compatible with normal JSON.

Canvas live subscriptions are enabled with destructive-write guards: the server
reseeds degenerate rooms from the canonical REST revision and refuses to
materialize a node-losing canvas over populated content. The native client also
waits for live hydration before writing and falls back to REST when a live root
is empty or loses canonical nodes.

Awareness updates are allowed for every subscribed reader, including viewers,
and are relayed only to other sessions subscribed to the same document. The
server retains the latest payload from each active session in memory so a late
subscriber can immediately render current peers; awareness is never written to
the CRDT update log, materialized revision, or vault content. Oversized
awareness payloads are ignored, and clients ignore malformed peer awareness
without interrupting the durable document session.

Hosted chat is exposed through `GET|POST /api/v1/vaults/{vaultId}/chat`.
Clients send only `{ id, content }`; `id` is an idempotency UUID and the server
stamps the authenticated user id, display name, deterministic color, and
timestamp. Listing requires `vault.read`; sending requires `vault.read` on an
active vault. Planned for later Phase 6/7 units: `manifest.updated` /
`operation.conflict` notifications and separate rate limits for awareness and
chat versus durable document updates.

## Calendars And CalDAV

Native Collab clients use the owner-scoped JSON calendar API below
`/api/v1/calendars`. Those requests keep normal bearer credentials behind the
dedicated native `hosted_calendar_request` boundary.

External calendar clients use the separate CalDAV surface:

- `GET /.well-known/caldav` redirects to `/caldav/`.
- `/caldav/principals/{userId}/` is the authenticated principal.
- `/caldav/calendars/{userId}/` is the calendar home.
- `/caldav/calendars/{userId}/{calendarId}/` is an owner-scoped collection.
- `.ics` children support `GET`, ETag-guarded `PUT`, and ETag-guarded `DELETE`.
- Collections support `PROPFIND`, `calendar-query`, bounded
  `calendar-multiget`, and incremental `sync-collection` reports.

CalDAV authenticates with revocable app passwords over HTTP Basic
authentication. These credentials are distinct from normal Collab sessions:
only a SHA-256 digest is stored, the raw password is returned once, revocation
does not invalidate native clients, and normal bearer/session credentials are
not accepted as CalDAV passwords. Owners manage credentials through:

- `GET|POST /api/v1/calendars/caldav-credentials`
- `DELETE /api/v1/calendars/caldav-credentials/{credentialId}`

CalDAV mutations use the same calendar operation/change-log transaction as
native writes. Desktop and Android therefore receive external changes through
their existing delta synchronization path. Resource ETags are derived from the
canonical iCalendar payload; failed `If-Match` or `If-None-Match` preconditions
return `412` and never overwrite newer data.

## Idempotency and Concurrency

- The server records accepted `clientOperationId` values and returns the original result for safe retries.
- REST content writes before CRDT migration require an expected revision.
- Structural operations use stable file IDs and a base manifest sequence.
- The server may rebase a stale structural operation only when its result is unambiguous.
- Conflicts return structured recovery data and never silently discard content.
