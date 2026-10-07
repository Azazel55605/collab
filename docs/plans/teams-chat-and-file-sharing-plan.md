# Teams, Chats, And Shared File Libraries

Reviewed: 2026-10-07. Status: **In progress**. Shared vault-chat foundations and
Android vault chat are implemented and under validation; direct/group chats,
teams/channels and browser libraries remain planned. Voice/video calls are deferred.
[Open Development Work](./open-development-work.md) owns consolidated status.

This program precedes the standalone mobile overhaul. Build conversation,
membership, unread, notification and library contracts here, then consume them
from the new mobile location/document architecture; do not implement another
Android-only collaboration model.

## Delivery Tracker

| Work                                              | Status      | Remaining gate                                                                                              |
| ------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| Shared vault-chat contract and Android chat       | Testing     | Physical Android process-death/Keystore/keyboard checks; automated/live server and browser checks completed |
| Authenticated browser library portal              | Not started | Vault-wide access first; browse/upload/download/history/trash/previews                                      |
| Direct/group conversations and unread             | Not started | Shared server model, desktop/Android inboxes, join-time history and notifications                           |
| Teams/channels and library ownership              | Not started | Admin-only team creation, explicit team roles/private channels, ownership migration                         |
| Folder/file ACLs                                  | Planned     | Same enforcement across every read/write, replica and metadata path                                         |
| Authenticated share links                         | Planned     | Scoped expiry/revocation after ACL contracts                                                                |
| Anonymous guests, document workflows, voice/video | Deferred    | Separate accepted scope required                                                                            |

## Accepted Product Rules

- Only server administrators create teams. Users can create group conversations.
  Team ownership/membership are independent roles; being server admin must not
  silently bypass private-channel membership.
- New group members start at their join sequence; earlier history is not exposed.
- Sharing starts with authenticated recipients. Anonymous external sharing is
  deferred; no guest tokens, media permissions or calling UI land implicitly.
- Accounts remain server-local and administrative permission groups remain
  distinct from teams and conversational groups.

## What Already Exists

- Hosted vaults have server-authoritative files, revisions, history, trash,
  search, memberships, user/group capability grants, offline-copy policy, and
  audit events. File storage is already independent of the desktop filesystem.
- `user_groups` and memberships are administrative permission groups. They
  are not conversational groups or Teams-style workspaces.
- `hosted_chat_messages` and vault-scoped chat APIs already persist messages.
  The desktop `ChatPanel` uses the collaboration transport; admin-web can review
  vault chat. Android now has vault chat; a direct/group conversation inbox
  remains planned.
- Shared notification delivery, native sessions, a user directory, and a
  multi-server connection registry exist. Keep server/account identifiers in
  every new cache, navigation destination, notification, and unread counter.
- The web UI currently offers administration and profile self-service. It has
  no ordinary-user file library browser.

## Product Model

Start with shared chat foundations and mobile vault chat, then direct/group
conversations, followed by teams and channels. Keep personal direct messages independent of vault access.
Team channels can associate with a hosted vault for files without moving or
copying the authoritative content.

A permission group may seed or synchronize team membership only under an
explicit policy. Permission groups and conversation membership must not be
silently equated: removing file access must not accidentally retain access to
private channel attachments, and leaving a chat must not delete vault content.

Accounts are server-local. Same usernames on two servers are different people;
there is no cross-server federation in this plan.

## Shared Foundation Delivered With Phase 1

Migration 0035 backfills deterministic chronological sequences, preserves old
message UUIDs and adds an indexed cursor. Sequences are decimal strings across
JSON/IPC to retain BIGINT precision. A per-vault transaction lock serializes
allocation through commit; gaps are allowed and reconnect cursors cannot skip a
slower preceding commit. The legacy latest-message API stays compatible.

`GET /api/v1/vaults/{id}/chat/page` returns chronological bounded pages, with
mutually exclusive `before`/`after` cursors and explicit continuation. Send
requires both `vault.read` and `chat.send` on an active vault. Built-in writers
retain sending through migration; viewers cannot send; custom grants explicitly
opt in. Identical UUID retries return the original message; changed content,
sender or vault returns a conflict without generating another mention event.

Shared TypeScript chat types, request helpers and session hook live in `src/`.
Native requests check the expected account before using a token. Android's
private unsent outbox is encrypted with a native durable key, capped at 100
messages/2 MiB, and scoped to server/account/vault. Persist before sending;
acknowledge before removing. Retrying preserves the UUID. History is not
persisted as an offline chat cache, and failed authorization clears the visible
history. Explicit reconnect/retry retains private drafts; logout does not make
them accessible to another account. Older-history browsing uses a bounded
300-message window with a return-to-latest action.

The UI uses shared controls through the mobile build's shared-source alias.
Mention notifications route by native server provenance; ambiguous legacy
notifications cannot select a same-ID vault on an arbitrary server. Physical
Android lifecycle/Keystore and keyboard validation remains a release gate.

## Phase 1: Android Vault Chat

Reuse existing vault history/send APIs and collaboration events. Add a chat
entry inside the selected vault, a paginated message list, composer, retry
state, sender profile picture/display name, and server/vault breadcrumb.
Server stamps identity/time and enforces existing chat capabilities. Existing
message UUIDs remain idempotency keys; reconnection must not duplicate sends.

Acceptance:

- Desktop ↔ Android messages persist and appear after reconnect/process restart.
- Opening the same vault ID on two servers never mixes messages or identities.
- Viewers lacking send permission see history but cannot compose.
- Membership/capability removal closes subscriptions and prevents reads/sends.
- Network interruption exposes pending/failed sends with deliberate retry.
- History loads in pages, not an unbounded DOM or full-history request.

Audit the existing history ordering/cursor and realtime replay behavior first;
add a shared contract where the current vault API lacks pagination or replay.

## Phase 2: Direct And Group Conversations

Add server-owned conversations, participants, messages, and per-user read
positions. Use a monotonic message sequence/cursor for pagination, event replay,
and unread counts; UUIDs provide client-send idempotency. Direct conversations
have one canonical pair per server; groups have a name, optional picture,
owners, and explicit member invitation/removal rules.

Define shared protocol DTOs and repository/domain boundaries before adapters.
Rust portable policy code cannot depend on SQLx, Axum, or Tauri. PostgreSQL and
WebSocket delivery remain server adapters; native gateways retain tokens.
Implement explicit conversation events rather than attaching personal messages
to a vault WebSocket that requires unrelated vault access.

Deliver desktop and Android inboxes against the same APIs. The browser may
start with an inbox for signed-in members after the profile foundation, rather
than exposing administrative chat review to ordinary users.

Acceptance: two-person and group sends, duplicate retry deduplication, unread
reconciliation after reconnect, last-owner protection, membership revocation,
user deletion/disable, cursor ordering, and bounded offline queues. New group members
see history from their join sequence; cursor/replay/unread queries enforce that
boundary rather than merely hiding older messages in the UI.

## Phase 3: Teams And Channels

Introduce teams, team roles, channels, and channel membership. Start with public
channels within a team and private channels with explicit membership. Allow only server admins to create teams; add team
invitation rules, archive/restore, member management, and last-owner
protection. A team channel can link one library vault; access is checked both
at the channel and file boundaries. Do not reuse server-admin as team-owner.

Acceptance: role changes, private-channel isolation, team removal, nested
notification destinations, channel archive, audit history, and consistent
web/desktop/mobile affordances. Implement administrative oversight as an
explicit capability with audit records, not an implicit bypass.

## Notifications And Attachments

Integrate existing notification infrastructure after unread/read-position
semantics are stable. Preferences cover conversation mute, mentions, and lock
screen privacy. Collapse notifications by conversation and validate destination
membership again when opening them.

Attachments reference the canonical hosted file/revision and reuse preview,
upload validation, quotas, and storage accounting. A message must not reveal
an inaccessible file's name or thumbnail. Direct/group attachments without a
vault need a defined conversation-owned storage namespace and retention policy;
do not quietly grant participants the sender's personal vault.

## Shared Libraries: SharePoint-Like Direction

Proposed MVP: team-associated hosted vaults presented as shared libraries with
browser browsing, folders, upload/download, internal-file previews, search,
revision history, trash/recovery, and existing user/group grants. Reuse the
hosted file lifecycle and optimistic locking; do not create a second file store.

1. **Authenticated browser library portal.** Add Files for members; list only
   accessible libraries, then files/folders, upload progress, version history,
   and previews. Gate actions by effective capabilities. Start with vault-wide
   permissions already shipped. Native document editing stays in the app;
   browser view/edit support expands format by format with honest UI.
2. **Team ownership and library administration.** Define a team-owned library
   policy independent of a single user's lifetime. Migrate/transfer ownership
   explicitly and preserve history and audit records.
3. **Fine-grained sharing.** Design inherited folder/file ACLs, permission
   inspection, and broken-inheritance behavior before adding share buttons.
   Apply the same rules to list/search/history/previews/download/archive,
   realtime subscriptions, offline replicas, and cached metadata. Whole-vault
   grant logic currently cannot safely stand in for folder-level ACLs.
4. **Share links and guests.** Optional subsequent phase with random scoped
   tokens, expiry, revocation, password/rate limits if required, and download
   policy. Default proposal: authenticated recipients only; anonymous external
   sharing requires a separately accepted product/security policy.
5. **Document workflows.** Optional metadata columns, approval/check-out,
   retention, and integrations only after browsing and permissions are stable.
   Full SharePoint compatibility is outside the MVP.

Acceptance must include attempted access through every alternate endpoint,
concurrent edits/conflicts, bulk actions with partial failures, large uploads,
quota/storage reconciliation, trash/restore, group permission changes, cache
revocation, and backup/restore. Never test migrations against real user data.

## Sequence And Decisions

Recommended delivery order:

1. Accounts and revision-bound previews (complete and archived).
2. Shared chat pagination/identity/retry/permission foundations, Android vault
   chat, and authenticated browser file browsing as focused deliveries.
3. Direct/group conversations and unread/notification semantics.
4. Teams/channels with shared library ownership.
5. Folder/file ACLs, then optional external sharing.

Conversation history, team creation and the initial recipient policy are
recorded above. Before their respective later phases, define attachment
retention, optional team/group synchronization and library ownership migration.
These do not block vault chat; they must be resolved before corresponding
storage or permission mutations are implemented. Calling can later use a separate signaling/media system without
changing message persistence; no call UI or media permissions land now.
