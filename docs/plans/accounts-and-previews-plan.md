# User Accounts And Document Previews

Reviewed: 2026-10-07. Scope: web self-service accounts, Android profiles, and
internal-document thumbnails. Teams, chats, and shared libraries have separate
[draft plans](./teams-chat-and-file-sharing-plan.md).

## Account Delivery

The server already stores usernames, display names, avatar bytes, preferences,
password credentials, browser sessions, and native sessions. Reuse those tables
and `/api/v1/users/me` operations; do not create an Android identity system.

Implemented in this change:

- Members signing into `/admin/` land on Profile. Administrative pages remain
  visible only to administrators, who still land on Dashboard and also have a
  Profile navigation item. The existing account dialog uses the same form.
- Profile edits include display name, username, picture upload/removal, password,
  and the existing web appearance preferences.
- Android Settings → Profile has editable account details and a switch between
  connected servers. Switching discards the previous form and late responses;
  changing a username updates only that server's saved login preference.
- Native GET/PATCH profile and PUT/DELETE avatar operations use bearer
  authentication. Browser mutations retain CSRF checks. Username changes and
  profile validation are atomic. Uniqueness remains enforced by PostgreSQL.
- The `hosted_account_request` IPC command permits only supported self-service
  method/path pairs. Tokens remain in Rust. Returned user changes refresh the
  selected native session's identity.
- Password changes require the current password, keep the initiating session,
  and revoke other sessions using the existing server behavior.

Validation must cover regular users as well as admins, uniqueness conflicts,
invalid patch atomicity, missing CSRF, native session authentication, password
errors, avatar limits, cross-server switching, late responses, and persistence
through reconnect. Physical Android picture selection and process recreation
remain device release checks; jsdom does not establish those behaviors.

Desktop's existing local presence identity settings remain separate from server
account management. A desktop native account editor is a follow-on surface;
web self-service is available to desktop users now.

## Preview Contract

A preview is derived data, never an authoritative document or a live editor.
The first version renders small self-contained SVG content thumbnails through
`collab-documents::preview`, shared by native and server adapters:

| Format              | Thumbnail content                                                        |
| ------------------- | ------------------------------------------------------------------------ |
| `.md`               | First non-empty lines, excluding leading YAML front matter               |
| `.sheet`            | First worksheet, at most 7 rows × 5 columns; literal values/formula text |
| `.deck`             | First slide text and object labels; no speaker notes                     |
| `.kanban`           | Column names and a bounded set of card titles                            |
| `.canvas`, `.logic` | Bounded node labels                                                      |
| `.ink`              | Bounded first-page stroke geometry, omitting hidden layers               |

These are content summaries rather than pixel-identical editor exports. Deck
layouts, chart rendering, worksheet formatting/calculated formula values,
canvas edges, logic wiring, ink pressure, transforms, and non-stroke objects
are not reproduced. No external links, assets, scripts, formulas, OCR, or
simulation execute during generation. Source input is capped at 16 MiB; output
is capped at 64 KiB. Unsupported and malformed files show an unavailable state.
Images and PDFs keep their existing client rendering path. PDF document workers
are destroyed after rendering, failed promises can retry, and the in-memory
source cache is bounded.

Desktop file-tree hovers support all seven internal formats in addition to
images/PDFs. Canvas file cards consume the same internal previews; note cards
retain their existing markdown content.

## Hosted Cache

`GET /api/v1/vaults/{vault_id}/files/{file_id}/preview` authenticates the caller,
checks `vault.read`, and requires an active file before using the cache. It
returns a data URL, source content hash, and renderer version.

Migration 0033 adds one derived cache row per file. Content hash, file name,
and renderer version determine validity. Edits, restores, renames, and renderer
upgrades cause regeneration on the next request. Foreign-key cascades remove
cache rows when their file is purged. A PostgreSQL transaction-scoped advisory
lock prevents simultaneous workers from generating the same file in parallel.
Generation is lazy; the second client reads the saved thumbnail rather than
loading the source blob and generating it again. Old versions are replaced,
so cache size does not grow with revision history. Deleting the cache is safe.

Local previews use the existing hidden `.collab/previews/documents/` encrypted
sidecar cache, with source modification time, size, and renderer version checks.
Writes of internal previews additionally compare the source hash to reject
previews produced while a document changed. Concurrent frontend requests share
one load scoped by server/account/vault/path. Hosted authorization errors never
fall back to offline content. Connectivity failures may regenerate from an
already available offline replica; pending local edits preview their draft.

## Follow-On Preview Work

1. Measure cold-generation, warm-cache, transfer, memory, and Android timings
   against maintained real fixtures before setting production latency budgets.
   The current change removes repeated server rendering by construction; no
   measured speedup is claimed without those timings.
2. Add scene-faithful thumbnails using the existing deck/ink renderers and a
   worksheet renderer in an isolated bounded worker. Keep summaries as the
   fallback. Do not execute document-provided scripts or load arbitrary URLs.
3. Introduce server PDF and resized-image generation with explicit decoder
   dependencies, process isolation, time/memory limits, and deployment checks.
   Do not assume a browser PDF renderer exists in the server image.
4. Add conditional thumbnail responses and an account-scoped bounded client
   cache, checking authorization on every retrieval. Durable offline previews
   must follow `vault.offlineCopy`, logout, and replica removal policies.
5. Add Android file-list preview affordances and optional background generation
   after revisions commit. Avoid generating the entire vault on login or hover.

## Validation Evidence

Validated on 2026-10-07:

- Desktop: 2,160 tests passed in the full rerun; one subprocess test was
  blocked by sandbox `EPERM`, then all seven tests in that file passed with
  subprocess access. One pre-existing test remains skipped.
- Admin web: 75 tests and production build passed. Android: 251 tests passed.
  Desktop, admin, and Android TypeScript checks passed.
- Rust workspace tests and checks passed, with live PostgreSQL tests pointed
  only at a disposable container/database. Boundary and version guards passed.
- Browser checks passed at 1,440 px and 390 px. A separately built live server
  also verified admin Dashboard/Profile routing, member Profile routing,
  persisted account edits, password changes, retained sessions, and reconnect.
- Compose configuration passed. The isolated container smoke build failed
  twice during Debian package-index verification (`Hash Sum mismatch`), before
  application startup; the container smoke check remains unverified.

Physical Android picture selection, process recreation, native desktop visual
QA, measured preview performance, and the follow-on work above remain open.
