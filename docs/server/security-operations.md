# Security, Operations, and Compatibility

## Threat Model

The first server targets a trusted self-hosted organization, but clients and network traffic are not trusted.

The server must defend against:

- Forged identities and client-reported roles.
- Unauthorized REST and WebSocket access.
- Path traversal and access to host filesystem paths.
- Malicious archives, oversized uploads, and decompression bombs.
- Credential stuffing and token theft.
- Duplicate/replayed mutations.
- Server-side request forgery through preview fetching.
- Accidental data loss during concurrent edits, structural conflicts, upgrades, and restores.

The first version does not defend against a malicious server operator. Hosted vault content is server-readable.

## Trust Boundaries

- TLS terminates at the deployment gateway.
- The gateway forwards only to the private server network.
- PostgreSQL and blob storage are not publicly exposed.
- Server authorization is authoritative; client-side role checks improve UX only.
- The server resolves storage keys internally from opaque IDs.
- Remote web-preview fetching retains the existing private-network, redirect, credential, and response-size protections.

## Secrets and Configuration

- Secrets are supplied through environment variables or mounted secret files, never committed configuration.
- Required secrets include PostgreSQL credentials, first-bootstrap credentials
  during initialization, TLS private keys when Caddy is not managing them, and
  any external backup-target credentials mounted by the host.
- Logs redact authorization headers, cookies, passwords, refresh tokens, WebSocket tickets, and invitation secrets.
- Configuration is validated before migrations or network listeners start.
- Browser sessions, native tokens, CSRF secrets, invitations, and WebSocket
  tickets are opaque random values stored only as PostgreSQL hashes. Rotate them
  by revoking sessions/tickets rather than by replacing a shared signing key.
  See [TLS, Security Headers, and Secret Rotation](./tls-and-secrets.md).

## Security Headers and TLS

- The server and gateway set a baseline `Content-Security-Policy`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, and `X-Frame-Options` on all responses.
- Production deployments should terminate HTTPS at the gateway or at an
  upstream reverse proxy and set `COLLAB_BROWSER_SECURE_COOKIES=true`.
- HSTS belongs only on a real HTTPS hostname. The TLS Caddy example enables it;
  the default local/LAN HTTP gateway intentionally does not.
- Do not expose the internal app port or PostgreSQL to untrusted networks.

## Vulnerability Scanning

- Dependency and image scans are release gates for the hosted server. Run
  `pnpm server:security:scan` locally and keep the GitHub `Security Scan`
  workflow green.
- The gate covers `pnpm audit`, RustSec advisories through `cargo-audit`, and
  high/critical findings in the built `Dockerfile.server` image.
- Scanner exceptions must be time-limited and documented with the advisory ID,
  impact assessment, owner, and removal condition. Prefer upgrading or replacing
  the vulnerable dependency over suppressing the finding.

## Admin Web Interface

- The administration interface is served on the same origin below `/admin/`.
- Browser admin sessions use `Secure`, `HttpOnly`, and appropriate `SameSite`
  cookies plus CSRF protection for state-changing requests.
- A strict Content Security Policy limits scripts, connections, frames, and
  remote content.
- Admin authorization is enforced by the server for every page-data request and
  mutation; hiding controls in the browser is never an authorization boundary.
- The interface consumes typed, redacted audit events and operational summaries.
  It never exposes raw container logs, environment variables, stack traces,
  request headers, cookies, tokens, password material, or invitation secrets.
- Every administration mutation emits an audit event containing the acting user,
  action, target identifiers, result, request ID, and sanitized metadata.
- Browser session and CSRF secrets are generated from operating-system
  randomness and stored in PostgreSQL only as SHA-256 digests.
- Passwords are stored only as Argon2id hashes with per-password salts.

## Database Migrations

- Use ordered, immutable SQL migrations in the server crate.
- Migrations run under an advisory lock so only one server instance migrates.
- The server refuses to run against a schema newer than it supports.
- Forward-compatible additive migrations are preferred.
- Destructive or irreversible migrations require a verified backup and explicit operator opt-in.
- A failed migration stops startup without serving traffic.
- Rollback means restoring the pre-upgrade database and blob backup; down migrations are not relied upon.
- Operators should run `pnpm server:upgrade:preflight` before upgrading. It
  creates and verifies a full backup, records the current migration table, and
  prints the exact restore command for rollback.

## Maintenance Mode

Maintenance mode is toggled from `/admin/settings` and persists in the server
data/backup volume. It is intended for short upgrade, backup, restore, or
operator-maintenance windows.

While enabled:

- Health checks, authentication, admin pages, backup/restore controls, settings,
  and read-only REST requests remain available.
- Hosted-vault mutations, WebSocket ticket issuance, and live WebSocket upgrades
  return `503 maintenance_mode` with a `Retry-After` header.
- The admin dashboard shows a `maintenance_mode` operational warning using the
  operator-supplied message.

Disable maintenance mode after the upgrade or maintenance action is complete and
the dashboard is healthy.

## Backups

A valid backup contains:

- A transactionally consistent PostgreSQL backup.
- Every referenced blob and its digest.
- Server configuration excluding replaceable runtime secrets.
- A manifest recording versions, timestamps, and checksums.

Backup and blob retention must prevent garbage collection from deleting content needed by an in-progress backup. Restore testing is required before production readiness.

## Rate Limiting

- Authentication endpoints keep a per-username login attempt limiter (5 attempts
  per minute) that resets on success.
- A coarse limiter protects all `/api/v1/*` (REST) and `/ws/v1/*` (WebSocket
  upgrade) traffic, tuned by `COLLAB_REST_RATE_LIMIT_PER_MINUTE` (default 1200)
  and `COLLAB_WS_RATE_LIMIT_PER_MINUTE` (default 120); either set to `0`
  disables that limiter. Authenticated REST traffic is isolated by a one-way
  digest of its bearer session, preventing users behind one NAT or proxy from
  consuming a shared budget. Anonymous REST and WebSocket upgrades remain
  client-IP scoped. Authenticated REST also has an aggregate IP cap at eight
  times the configured session limit, preventing unverified bearer rotation
  from bypassing the coarse guard. Exceeding a limit returns
  `429 RATE_LIMITED` with a `Retry-After` header. Health checks, the admin SPA,
  and the root redirect are never rate limited.
- IP-scoped traffic uses the last `X-Forwarded-For` hop appended by the trusted
  reverse proxy (falling back to `X-Real-IP`, then the socket peer). This trusts
  the front proxy to set `X-Forwarded-For`; do not expose the server port
  directly to untrusted clients without a proxy that overwrites that header.
- Each authenticated WebSocket additionally has a generous per-connection inbound
  message flood guard (2,000 frames per 10 seconds) that disconnects a runaway or
  hostile socket; the client reconnects and re-syncs through the state-vector
  handshake. Ping/pong keepalives are exempt.

## Import and Upload Limits

Configurable limits apply to:

- Total vault import size.
- Single file size.
- Archive entry count.
- Compressed-to-expanded size ratio.
- Request body size.
- Concurrent uploads per user and server.

The initial hosted asset endpoint enforces `COLLAB_MAX_FILE_BYTES` after base64
decoding and verifies the supplied SHA-256 digest before committing metadata.
The HTTP JSON body limit is derived from `COLLAB_MAX_FILE_BYTES` with base64
and envelope overhead so valid asset and ZIP imports are accepted without
falling through Axum's smaller default body limit. Concurrent-upload limits
remain required before production exposure.

Future streaming archive import should extract into an isolated staging
location, validate every entry, and commit metadata only after validation
succeeds.

The initial hosted ZIP endpoint validates entries in memory before commit,
rejects symlinks and unsafe portable paths, limits archives to 1,000 entries,
limits individual files with `COLLAB_MAX_FILE_BYTES`, compressed archives with
`COLLAB_MAX_IMPORT_BYTES`, and total expanded content with
`COLLAB_MAX_IMPORT_EXPANDED_BYTES`. Defaults are 256 MiB per file, 512 MiB
compressed, and 2 GiB expanded. Operators must keep these limits aligned with
available container memory until import becomes streaming/staged.

## Compatibility Policy

- API and WebSocket protocol major versions are explicit.
- The server supports the current native client protocol and at least one previous compatible minor release during normal upgrades.
- Database schema and CRDT materializer versions are recorded.
- Exports remain compatible with the existing local vault layout.
- Existing local vaults are never silently converted into hosted replicas.
