# Collaboration Server Architecture

This directory is the entry point for the implemented self-hosted collaboration
server: architecture, operations, security, release, and recovery guidance.

The collaboration server is a separate Rust service that becomes authoritative for hosted vaults. Existing local vaults remain owned by the Tauri application and continue to use the current filesystem-backed behavior.

## Documents

- [Hosted Vault Domain Model](./hosted-vault-domain.md)
- [REST and WebSocket Protocol](./protocol.md)
- [Security, Operations, and Compatibility](./security-operations.md)
- [Workspace and Verification](./workspace-verification.md)
- [Rust Crate Boundary Refactor Plan](../archive/rust-crate-boundary-refactor-plan.md)
- [Server Development and Compose](./development.md)
- [Deployment Topology and Upgrade Compatibility](./deployment-topology.md)
- [Server Backups](./backups.md)
- [Upgrade and Failed-Migration Recovery](./upgrade-recovery.md)
- [TLS, Security Headers, and Secret Rotation](./tls-and-secrets.md)
- [Dependency and Container Vulnerability Scanning](./vulnerability-scanning.md)
- [Load Testing](./load-testing.md)
- [Release Security Review](./security-review.md)
- [Multi-Architecture Server Images](./container-images.md)
- [Admin Web Interface](./admin-web.md)
- [ADR 0001: Authentication and Sessions](./adr/0001-authentication-and-sessions.md)
- [ADR 0002: Hosted Vault Storage](./adr/0002-hosted-vault-storage.md)
- [ADR 0003: CRDT Persistence](./adr/0003-crdt-persistence.md)
- [ADR 0004: Offline Synchronization](./adr/0004-offline-synchronization.md)

## Core Boundary

Hosted vault synchronization has two independent authorities:

1. Document content for notes, Kanban boards, and canvases is synchronized through CRDT documents.
2. Vault structure is synchronized through an ordered server manifest and idempotent structural operations.

Binary assets are immutable blobs referenced by file revisions. Presence and rich awareness are ephemeral and never become canonical vault content.

## Current Implementation Boundary

The server is authoritative for hosted vault identity, membership, file
manifests, revisions, binary blobs, audit/activity, live CRDT rooms, and
offline-replica synchronization state. Local filesystem vaults remain owned by
the Tauri client and keep their filesystem-backed behavior.

Live CRDT collaboration is implemented for supported structured documents.
Vault structure remains outside document CRDTs and is synchronized through the
ordered server manifest plus idempotent structural operations.

The server API and WebSocket modules remain the current adapters. Their internal
modularization and the proposed shared domain crates are planned, not yet
implemented. Follow the crate-boundary plan without changing routes, wire
formats, database semantics, or authorization boundaries as a side effect.

## Self-Service Accounts And Content Previews

The web interface routes ordinary signed-in users to Profile; administrators
keep their dashboard and have the same Profile tab. `/api/v1/users/me` supports
browser and native authentication. Browser writes require CSRF; native writes
use bearer sessions. Display name, username, preferences, avatar, and password
operations are scoped to the authenticated account.

`GET /api/v1/vaults/{vault_id}/files/{file_id}/preview` returns an authenticated,
revision-bound SVG content thumbnail for internal documents. Migration 0033
stores the latest derived preview per file; no manual deployment migration step
is needed beyond the server's normal startup migrations. File purge cascades to
its cache. Cache loss is harmless and triggers lazy regeneration. Preview bytes
live in PostgreSQL and its backups, not the content-addressed blob store or file
revision storage totals. The cache adds at most 64 KiB per previewed file.

See [the account/preview contract](../archive/accounts-and-previews-plan.md) and
[the teams, chat, and library draft](../plans/teams-chat-and-file-sharing-plan.md)
for current fidelity limits, validation, and future scope.

## Vault Chat Contract

`GET /api/v1/vaults/{id}/chat/page?limit=50` returns a chronological page with
`nextBefore`, `nextAfter` and `hasMore`. Use `before` for older history or `after`
for reconnect catch-up; they are mutually exclusive. Limits are 1–100. Sequences
are decimal strings, not JavaScript numbers. Advance catch-up to the last
returned sequence; never jump to an unseen head when more pages remain. The
legacy `/chat?limit=...` array response remains available to existing clients.

Migration 0035 preserves deterministic historical order and indexes cursor
queries. Per-vault locking serializes append cursors through commit. Send
requires active-vault `vault.read` and `chat.send`. Built-in editor/admin
permissions gain sending; custom grants must opt in explicitly. Viewer history
access does not imply sending. Requests supply UUID/content; the server stamps
identity/time. An identical retry returns 200; first send returns 201. Reusing
an ID with different sender, vault or content returns 409. Mention delivery runs
only on the original insert.

Android now consumes this contract with a native encrypted retry outbox. Offline
chat history caching and browser libraries remain
separate work in the [collaboration plan](../plans/teams-chat-and-file-sharing-plan.md).
Only server admins create teams; users may create group chats. Permission
groups are not teams, and account identity never crosses server boundaries.

## Personal Direct And Group Conversations

Personal chats are server-local and independent of vault permissions. Any active
user can create a direct pair or a named group of 2–50 active users. Direct pairs
are canonical. Group owners add/remove members, assign owner/member roles, rename
and set PNG pictures (64 KiB, at most 1024×1024 pixels). New/rejoining members see
messages starting after joining. Server administrators have no read/member bypass.
Transfer the last active group's ownership before leaving, demotion, account disable
or deletion. Deleted senders are labelled `Deleted user`; direct sends require both
accounts to remain available.

- `GET/POST /api/v1/conversations`: paged inbox/create; `limit` 1–100 (default 50),
  optional `before` activity cursor or `conversation` UUID filter. The filter always
  checks membership, including notification destinations outside the first page.
- `PATCH /api/v1/conversations/{id}`: owner-managed group name/picture.
- `GET/POST /api/v1/conversations/{id}/messages`: bounded chronological cursor pages
  (`before`/`after` mutually exclusive), or UUID-idempotent sends. Exact retries
  return 200, first sends 201, changed actor/content/conversation returns 409.
- `POST /api/v1/conversations/{id}/read`: monotonic decimal-string read sequence,
  bounded by the committed head. Unread excludes the reader's own sends and
  inaccessible pre-join history.
- `GET/POST /api/v1/conversations/{id}/members`: member listing/owner adds.
  `PATCH/DELETE .../members/{userId}`: owner role/removal or a member's own leave.
- `GET /api/v1/conversations/events?after=...`: recipient-scoped bounded event
  replay (`created`, `message`, `members`, `updated`, `read`, `removed`). Current
  membership and join boundaries apply; former members receive only removal events.

Migration 0036 preserves existing vault chat and introduces a commit-order lock for
personal mutations/events. Cursors use decimal strings across JSON/IPC. Ordinary
browser mutations require CSRF; native requests require bearer authentication.
Generic message notifications use the existing collaboration delivery/preferences
and disclose no chat content or participant/group names. Native opening validates
source-server/account identity and current membership. History is online-authorized;
only private unsent drafts are persisted encrypted in native clients. Fine-grained
conversation mute/collapsing and attachments remain planned.

## Teams, Channels And Linked Libraries

Migration 0037 builds channels on the conversation history/unread/events contract.
Teams are independent of permission groups; server-admin status is independent of
team owner/member roles. Active membership and non-archived team/channel state are
required for channel history, sends, read positions, notifications and linked files.

- `GET /api/v1/teams?after={uuid}`: membership-only pages of 100 ordered by UUID.
- `POST /api/v1/teams`: server-admin-only `{name, ownerId}`; the selected active
  account becomes owner. Creation does not join the administrator automatically.
- `PATCH /api/v1/teams/{id}`: owner `{name, archived}` rename/archive/restore.
- `GET/POST .../{id}/members`: team roster or owner add/role `{userId, role}`.
  `DELETE .../{id}/members/{userId}` removes a member or leaves the team.
- `GET/POST .../{id}/channels`: visible channels or owner create
  `{name, private, members}`. Public membership follows the team; private joins
  require an active team account. New/rejoining members start after the current head.
- `PATCH .../{id}/channels/{channelId}`: channel/team owner `{name, archived}`.
- `POST .../{id}/channels/{channelId}/members`: private-channel add/remove
  `{userId, role: "member" | "remove"}`. Team roles determine channel roles.
- `POST .../{id}/channels/{channelId}/library`: `{vaultId}` links a library;
  `null` explicitly detaches it. Requires both channel ownership and vault custodian
  identity, including for the previous vault when replacing a link.
- `POST .../{id}/oversight`: explicit server-admin ownership claim, audited as
  `team.oversight.claimed` with `team.oversight`. Grants public access at join time,
  never private access. Normal membership/history routes have no admin bypass.

Team changes are transactional and audited. Browser mutations enforce CSRF; native
bearer requests use the same APIs. Limits are 500 team members and 100 channels.
The last active owner of the team and each private channel is protected from
removal/demotion and account disable/delete, including database account triggers.
Restore archived teams before changing their channels. Archives retain history;
restoring preserves members' existing join boundaries.

An existing vault opts into one channel association without copying content or
changing its custodian/file grants. The central capability resolver requires active
team/channel membership **and** existing file permissions, before owner/admin
shortcuts. This applies to previews, history, search, manifests, replicas and live
access as well as direct file URLs. Only the custodian may detach; this explicitly
restores the vault's previous access rules and creates an audit event. Existing
server operational administration is separate from private channel content access.
Browser Files, organization-owned custodian transfer, folder/file ACLs and share
links remain separate work in the [collaboration plan](../plans/teams-chat-and-file-sharing-plan.md).

Linked library vaults must be detached before soft or permanent vault deletion.
Association and deletion lock the vault row to prevent a concurrent link from
leaving a pending-delete library. Restore archived vaults before detaching them.
