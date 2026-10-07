# Teams, Chats, And Shared File Libraries

Drafted: 2026-10-07. Planning only; these features are not implemented by the
account/preview change. Voice and video calls are deferred.

## What Already Exists

- Hosted vaults have server-authoritative files, revisions, history, trash,
  search, memberships, user/group capability grants, offline-copy policy, and
  audit events. File storage is already independent of the desktop filesystem.
- `user_groups` and memberships are administrative permission groups. They
  are not conversational groups or Teams-style workspaces.
- `hosted_chat_messages` and vault-scoped chat APIs already persist messages.
  The desktop `ChatPanel` uses the collaboration transport; admin-web can review
  vault chat. Android has no conversation inbox or chat screen.
- Shared notification delivery, native sessions, a user directory, and a
  multi-server connection registry exist. Keep server/account identifiers in
  every new cache, navigation destination, notification, and unread counter.
- The web UI currently offers administration and profile self-service. It has
  no ordinary-user file library browser.

## Product Model

Start with mobile vault chat, then add direct/group conversations, followed by
teams and channels. Keep personal direct messages independent of vault access.
Team channels can associate with a hosted vault for files without moving or
copying the authoritative content.

A permission group may seed or synchronize team membership only under an
explicit policy. Permission groups and conversation membership must not be
silently equated: removing file access must not accidentally retain access to
private channel attachments, and leaving a chat must not delete vault content.

Accounts are server-local. Same usernames on two servers are different people;
there is no cross-server federation in this plan.

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
user deletion/disable, cursor ordering, and bounded offline queues. Clarify
whether new group members can see earlier history before implementing it.
Default proposal: history begins at their join sequence.

## Phase 3: Teams And Channels

Introduce teams, team roles, channels, and channel membership. Start with public
channels within a team and private channels with explicit membership. Add team
creation/invitation rules, archive/restore, member management, and last-owner
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

1. Accounts and revision-bound previews (current implementation/validation).
2. Mobile vault chat and authenticated browser file browsing, independently.
3. Direct/group conversations and unread/notification semantics.
4. Teams/channels with shared library ownership.
5. Folder/file ACLs, then optional external sharing.

Before their respective implementation phases, decide conversation history for
new members, self-created versus admin-created teams, attachment retention,
team/group synchronization, library ownership migration, and external guest
policy. These are open product decisions rather than blockers for accounts or
previews. Calling can later use a separate signaling/media system without
changing message persistence; no call UI or media permissions land now.
