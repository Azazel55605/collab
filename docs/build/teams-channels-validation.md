# Teams And Channels Validation

Reviewed: 2026-10-08. Phase 3 implementation is **Testing**; physical/native and
multi-device release gates below remain open. The
[collaboration plan](../plans/teams-chat-and-file-sharing-plan.md) defines scope,
including retained vault custodians and explicit library association.

## Automated Evidence

- Full desktop frontend suite: 2199 passed, one existing skip, and one sandbox
  Node subprocess failure. The affected update-manifest file passed all seven
  tests outside the sandbox. Final shared team, notification and conversation
  changes received focused regression runs.
- Android frontend: 255 tests passed. Admin-web: 81 tests passed.
- Workspace Rust tests and checks passed with a disposable PostgreSQL database.
  The live team test additionally covers admin-only creation and browser CSRF,
  native bearer creation, private-channel isolation, join/rejoin history, unread,
  UUID send deduplication, audited oversight, owner handoff/disable protection,
  removal and replay, archive/restore, required file grants, previews/history/
  search/manifests, and linked-vault deletion protection.
- Admin and Android frontend builds, production Compose configuration, isolated
  source-image server smoke, crate boundaries, version alignment and formatting
  passed. ESLint has zero errors with the existing 182 warnings.
- Real shared components rendered in Chromium at 390×844, 390×480, 768×1024 and
  1365×900, with no horizontal overflow or page/console errors. Web channel sends
  and private-member controls were exercised. Desktop/Android browser fixtures
  used mock native IPC; web used mock HTTP. These do not prove physical lifecycle
  or notification delivery. Screenshots are local review evidence, not shipped assets.

## Physical And Multi-Client Release Gates

Use disposable accounts, teams and vaults; never point database tests at real data.

1. As a server admin, open Teams and create a team with an explicitly selected
   owner. Confirm a member cannot create teams and that creating for another
   owner does not silently join the admin. As owner, add members and create
   public/private channels. Verify a nonmember admin cannot open private history.
2. Exchange channel messages between web, desktop and Android. Check unread/read
   reconciliation, generic notification text, correct server/account/team/channel
   routing, history pagination and join-time boundaries after remove/rejoin.
3. Switch between two servers and two accounts, including similarly named teams.
   Confirm no history, directory results, pending sends or destinations mix.
4. Test Android hardware Back, keyboard-visible short screens, tablets, process
   recreation and Keystore-backed pending retry/discard. Repeat offline send,
   reconnect and UUID retry without duplicating messages or notifications.
5. Remove a member while they have an active live library session. Confirm history
   clears, future sends and file/preview/search/manifest/replica/live requests fail,
   and notification opening revalidates access. Previously downloaded files remain
   subject to the existing offline-copy policy; server revocation cannot erase
   copies a user already possesses.
6. Archive and restore a team/channel. Confirm history and library access close and
   restore without resetting join boundaries. Transfer team and private-channel
   ownership before leaving, demotion, account disable or deletion.
7. Link an owned active vault to a channel. A channel member without file grants
   must still be denied. Test explicit detachment and its return to prior vault
   access rules; deletion must require detachment first. Review `team.*` audit
   entries, including the explicit admin ownership claim without private access.

Browser library browsing, organization-owned custodian transfer, folder/file ACLs,
authenticated share links and calling remain separate delivery work.
