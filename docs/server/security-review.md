# Release Security Review

A pre-release security review of the self-hosted collaboration server, covering
the threat model in [Security, Operations, and Compatibility](./security-operations.md)
against the implemented controls. It is a recurring release gate: re-run it when
the auth, authorization, upload, preview, or live-collaboration surfaces change.

- **Review date:** 2026-06-20
- **Scope:** `crates/collab-server`, `crates/collab-core`, `crates/collab-protocol`,
  the native hosted client surface in `src-tauri/src/commands/{server,web,replica}.rs`,
  the admin web app (`apps/admin-web`), and the Compose/gateway deployment.
- **Out of scope:** a malicious server operator (hosted content is
  server-readable by design), and end-to-end encryption of hosted vaults.

## Method

1. Map each threat-model item to the concrete control(s) that mitigate it and
   the test(s) that exercise it.
2. Run the automated security gates (dependency + container scanning).
3. Review the high-risk surfaces by hand: authentication/session lifecycle,
   REST/WebSocket authorization, upload/import limits, SSRF in preview fetching,
   and rate limiting.
4. Record residual risks and required-before-release findings.

## Automated Gates

| Gate | Command | Status |
| --- | --- | --- |
| JS dependency advisories | `pnpm audit --audit-level high --ignore-registry-errors` | Run via `pnpm server:security:scan` |
| Rust advisories | `cargo audit` | Run via `pnpm server:security:scan` |
| Container image (HIGH/CRITICAL) | Trivy/Grype/Scout on `Dockerfile.server` | `pnpm server:security:scan container` + CI `Security Scan` workflow |
| Published image scan | Per-platform Trivy scan by digest before tagging | `.github/workflows/server-container-build.yml` |

Scanner exceptions must be time-limited and documented with the advisory ID,
impact, owner, and removal condition (see
[Vulnerability Scanning](./vulnerability-scanning.md)).

## Threat → Control Coverage

| Threat | Control | Evidence |
| --- | --- | --- |
| Forged identities / client-reported roles | Server-authoritative auth; capabilities derived from persisted membership + owner relation; client checks are UX only | `resolve_vault_capabilities`; live-PG authorization-matrix tests |
| Unauthorized REST access | Every `/api/v1/vaults/*` route re-checks vault read/write/admin authority per request | api.rs route handlers; viewer/editor denial tests |
| Unauthorized WebSocket access | Single-use hashed `ws_tickets` (short TTL), read-access to subscribe, `file.write` to apply updates, viewers read-only | `ws.rs`; `ws::` tests (viewer-write denial, reused/foreign ticket rejection, role-change recheck) |
| Path traversal / host path access | Strict portable-name validation; stable file IDs; storage keys resolved internally from opaque IDs | `collab_core` path rules; path-rejection tests |
| Malicious archives / decompression bombs | Per-file, compressed, expanded-size, entry-count, symlink, and portable-path validation before commit | ZIP import validation tests; `COLLAB_MAX_IMPORT_*` |
| Oversized uploads | `COLLAB_MAX_FILE_BYTES` enforced post-base64; SHA-256 digest verified before metadata commit; body limit derived from configured limits | upload tests; storage-quota tests |
| Storage exhaustion | Hard `COLLAB_STORAGE_QUOTA_BYTES` against deduplicated content; `507 QUOTA_EXCEEDED` before bytes are written; soft warning threshold | quota math/threshold tests |
| Credential stuffing / brute force | Per-username login limiter (5/min, reset on success); coarse per-IP REST/WS limiter | `LoginRateLimiter`/`RateLimiter`; burst→429 tests |
| Token theft | Argon2id password hashing; opaque random session/native/CSRF/ticket/invitation secrets stored only as SHA-256 hashes; native access tokens memory-only client-side, refresh in OS credential store | `auth.rs`; native client `server.rs` |
| Duplicate / replayed mutations | `clientOperationId` idempotency on structural ops and chat; manifest-sequence conflict detection | structural idempotency tests; chat idempotency |
| SSRF via preview/feed fetching | Shared `collab-net-policy` rejects loopback/private/link-local/multicast/reserved/localhost targets and credentials, validates every DNS answer before address-pinned execution, revalidates bounded redirects, strips cross-origin conditionals, and caps streamed bodies | `crates/collab-net-policy`; native `commands/web.rs`; server `calendar_feeds.rs`; shared policy and adapter tests |
| CSRF on admin mutations | CSRF token validation for state-changing browser requests; `Secure`/`HttpOnly`/`SameSite` cookies | `auth.rs`/`api.rs` CSRF; browser-admin lifecycle test |
| Data loss (concurrent edits, conflicts, upgrades) | Optimistic locking + auto-merge; CRDT convergence; forward-only migrations under advisory lock; backup/restore + upgrade preflight | `ws::` convergence; backup/restore smoke; `upgrade-recovery.md` |
| Information disclosure in logs/admin | Logs redact auth headers, cookies, passwords, refresh tokens, tickets, invitation secrets; admin UI consumes redacted summaries only | logging policy (security-operations.md); admin web tests |

## Manual Review Notes

- **Authentication/session lifecycle.** Bootstrap is one-time; disabled users
  and revoked sessions are rejected; native refresh tokens rotate with
  reuse-detection. Self-lockout of the last admin permission is blocked in both
  the server handler and the admin UI.
- **Authorization.** Server administrators have implicit content access without
  membership and must never modify owner membership; every admin mutation
  records audit + `byServerAdmin` activity. Verified the WS path reuses the REST
  capability resolver so a viewer cannot apply CRDT updates.
- **Transport/headers.** Baseline CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and
  `Cross-Origin-Opener-Policy` are set at the gateway; HSTS is reserved for the
  TLS gateway example. `COLLAB_BROWSER_SECURE_COOKIES=true` is required for HTTPS.
- **Rate limiting trust.** Authenticated REST sessions have isolated hashed
  buckets. Anonymous REST and WebSocket traffic trust the last
  `X-Forwarded-For` hop from the gateway for their per-IP buckets. This is safe
  only when the internal app port is not exposed directly; documented in the
  deployment topology.

## Findings

No findings block release at the current scope.

### Residual risks (accepted / documented)

1. **Single-instance only.** Live rooms, awareness, and the rate limiter are
   in-process; the server is not horizontally scalable. Documented in
   [deployment topology](./deployment-topology.md). *Mitigation:* scale
   vertically; do not run multiple instances behind a balancer.
2. **In-memory ZIP import/export.** Bounded by `COLLAB_MAX_IMPORT_*`, but large
   imports still consume memory proportional to expanded size. *Mitigation:*
   keep limits aligned with container memory; streaming/staged import is future
   work.
3. **`X-Forwarded-For` trust.** Spoofable if the app port is exposed without a
   header-overwriting proxy. *Mitigation:* topology doc forbids exposing `8787`.
4. **Operator trust.** Hosted vault content is server-readable. *Mitigation:*
   documented in the threat model; out of scope for this release.

### Recommended follow-ups (non-blocking)

- Add concurrent-upload-per-user/server caps (called out as required in
  `security-operations.md` before high-exposure deployments).
- Add an automated assertion that no `Authorization`/`Set-Cookie`/token value
  appears in emitted logs, to lock the redaction policy against regressions.
- Periodically re-run `pnpm server:load-test` against a release candidate and
  record results in [load testing](./load-testing.md).

## Sign-off

Release security review complete for this scope: automated gates available and
green, threat-model controls mapped to code and tests, residual risks accepted
and documented, and no blocking findings. Re-run this review when the
authentication, authorization, upload/import, preview-fetch, or live-collaboration
surfaces change.
