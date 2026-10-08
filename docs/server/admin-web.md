# Admin Web Interface

## Implementation Status

Phase 2 administration is implemented. It includes bootstrap, browser
login/logout, user creation and expiring invitations, disabling/re-enabling,
account deletion, password resets, session revocation, per-user activity inspection, storage and
operational summaries, read-only vault inventory, and redacted audit views.
The first bootstrapped administrator is permanently marked as the primary
administrator and cannot be disabled or deleted.

The interface now uses an admin-local shadcn-style primitive layer for buttons,
cards, inputs, badges, separators, switches, select menus, and dialogs. A
Settings category provides browser-local theme, accent-color, and
compact-density preferences. Appearance preferences may use local storage;
authentication state and secrets must never do so.

Per the [UI Guide](../desktop/ui-guide.md), the admin interface must not fall back to browser-default
controls: confirmation and text-input flows use the shared `ConfirmDialog` and
`PromptDialog` primitives instead of `window.confirm`/`window.prompt`, and
option pickers use the shared `SelectMenu` popover listbox instead of native
`<select>` elements. Confirmation dialogs focus the safe action and reserve
destructive styling for the destructive button.

The Phase 3 vault-management expansion is implemented: the vault inventory now
opens a per-vault detail view backed by the `/api/v1/admin/vaults/{vaultId}`
endpoints. It shows storage usage, active/trashed file counts, the manifest
sequence, and recent vault activity; supports adding, re-roling, and removing
members (the owner membership is protected); and provides rename plus archive,
reactivate, restore, and pending-delete lifecycle controls. The inventory can
also create new hosted vaults through `POST /api/v1/vaults`, making the
creating administrator the vault owner. Member mutations are disabled while a
vault is pending deletion. The vault detail view also exposes detailed logical
storage accounting plus bounded ZIP import for empty active vaults and ZIP
export. Server administrators have implicit operator access to every hosted
vault without being added as vault members. A linked channel library adds
active team/channel membership before content access, including for server admins;
operational inventory and lifecycle administration remain separate. The vault detail view includes a
file browser with path, kind, size, modified time, and state information plus
single-file download, move, document revision history, and restore-as-new-
revision actions.

Teams is available to ordinary signed-in users and administrators. It reuses the
browser-safe shared `TeamWorkspace` controls, backed by cookie/CSRF adapters.
Only server admins can create a team; the selected initial owner and subsequent
team owners manage membership, public/private channels, archive/restore and library
associations. Channel history uses bounded online pages and stable UUID retries;
pending browser messages remain only in the open tab. Server role never bypasses
private-channel membership. Administrative ownership claims are explicit and audited,
and do not grant private access. The separate member file-library portal remains
planned; channel libraries currently open through the desktop/Android file surfaces.

## Purpose

The self-hosted server includes a small browser-based administration interface.
It improves first-run setup and routine operation without turning the future
general-purpose web app into a Phase 2 requirement.

The interface uses the Collab visual language: existing themes, accent colors,
typography, spacing, shared control patterns, and clear document-style top bars.
It is responsive for desktop and tablet administration, but it is not a vault
editor.

## Delivery Boundary

Phase 2 delivers:

- First-administrator bootstrap and admin login.
- User creation, invitations, disabling/re-enabling, protected account deletion,
  admin-issued password reset links, and session revocation.
- A dashboard showing server health, version, uptime, storage summaries, and
  counts for users, sessions, invitations, and hosted vaults.
- Recent redacted audit events and actionable operational warnings.
- A read-only hosted-vault inventory backed by the Phase 3 canonical vault
  tables, with name, owner, member count, status, storage usage when available,
  and last activity.

Phase 3 expands the same interface with:

- Hosted-vault details and activity.
- Member and role management.
- Archive and delete actions plus storage-usage visibility.

Later phases may add collaboration metrics, backup state, and upgrade guidance.
Editing individual vault files remains outside the admin interface.

## Application Shape

The admin interface should live as a focused React application under
`apps/admin-web/`. It should reuse or extract Collab design tokens and suitable
shared UI primitives without coupling the browser bundle to Tauri APIs.

Production builds emit static assets served on the same origin as the server API
through the gateway. Client-side routing lives below `/admin/`; API calls remain
under `/api/v1/admin/` for administration and the shared authenticated
`/api/v1/teams` / `/api/v1/conversations` APIs for member collaboration.

Initial routes:

- `/admin/bootstrap`
- `/admin/login`
- `/admin/`
- `/admin/users`
- `/admin/users/{userId}`
- `/admin/vaults`
- `/admin/audit`
- `/admin/settings`

## Browser Security

- Browser sessions use `Secure`, `HttpOnly`, and appropriate `SameSite` cookies.
- State-changing requests require CSRF protection.
- Admin pages and APIs require a server-verified active administrator session.
- A strict Content Security Policy forbids arbitrary scripts and remote content.
- Authentication state and secrets are never persisted in browser local storage.
- Login and native-login endpoints are rate-limited. Invitation secrets are
  random, stored only as hashes, expire, and can be accepted only once.
- Every administration mutation creates an audit event.

The browser never receives raw container logs, environment variables, stack
traces, authorization headers, cookies, refresh tokens, or password material.
The raw invitation secret is returned only once to the administrator that
creates it so it can be shared with the intended user.

## Admin-Issued Password Reset Links

Users → Reset password opens a link dialog. Create a link and share it privately
with the account owner using your existing communication channel. The server
does not send email automatically. Only active users can receive or redeem a
link. Creating a new link replaces previous outstanding links; administrators
can revoke links even after closing the dialog. Issuing a link does not change
the password or sign the user out.

Links expire after one hour and work once. The recipient opens the public reset
page, enters and confirms a password, then signs in normally. Successful
redemption changes the password, consumes the link, invalidates remaining reset
links, and revokes all browser/native sessions in one database transaction.
Any intervening password change invalidates older links as well. Invalid,
expired, revoked, used, deleted-user, and disabled-user links cannot reset an
account. A reset never changes account roles or enables a disabled account.

The secret is returned only on creation with `Cache-Control: no-store`; only its
hash is stored. The share URL carries it in a fragment, which the reset page
removes from the address bar. Redemption sends it in the POST body rather than
the request path. Nothing persists the secret or password in browser storage or
audit metadata. Public reset requests have an IP-scoped maximum of ten requests
per minute (or the lower configured REST limit), even with supplied bearer
headers; setting the REST limit to zero disables limiting as elsewhere.

The existing direct administrative reset API remains available for compatibility;
the web interface uses the recipient-controlled link flow.

## Dashboard Data

The dashboard may display:

- Liveness/readiness and degraded dependency state.
- Server, protocol, and database schema versions.
- Process uptime and last successful migration time.
- User, active-session, invitation, and hosted-vault counts.
- Database and blob-storage usage summaries.
- Live collaboration metrics: WebSocket connections, loaded rooms, awareness
  state count, hosted presence count, update rate, CRDT backlog size, compacted
  document count, compacted state bytes, and last compaction time.
- Recent redacted audit events.
- Typed operational warnings such as unavailable blob storage, missing or stale
  backups, failed backup or restore audit events, storage pressure, expired
  invitations, insecure cookie configuration, and CRDT compaction backlog.
- Server settings for runtime security/session TTLs, upload/import limits,
  storage warnings, and backup schedule/export. Values supplied through
  `COLLAB_*` environment variables are shown as locked global overrides.
- Maintenance mode controls. When enabled, the server stays readable and
  manageable but pauses hosted-vault mutations and live WebSocket sessions with
  a `503 maintenance_mode` response.

Raw log aggregation and external production alert routing remain future
operations work.

## Testing Expectations

- Component and state tests for every management workflow.
- API contract tests for every dashboard and administration endpoint.
- Authorization tests proving non-admin sessions cannot access pages or APIs.
- CSRF, cookie, rate-limit, redaction, and session-revocation tests.
- Browser-level tests for bootstrap, login, user creation, invitation,
  disabling/re-enabling, protected deletion, session revocation, logout, and
  dashboard degraded states.
- Accessibility checks for keyboard navigation, labels, focus management,
  contrast, loading states, empty states, and error states.
