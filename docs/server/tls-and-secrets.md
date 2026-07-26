# TLS, Security Headers, and Secret Rotation

## Recommended Topology

Production deployments should expose only the gateway. The `collab-server`
container and PostgreSQL stay on the private Compose network.

```text
internet / LAN
  -> HTTPS reverse proxy or Caddy gateway
     -> collab-server:8787
        -> postgres:5432
        -> blob volume
```

For a public deployment, terminate TLS at Caddy or at an upstream reverse proxy
and set:

```dotenv
COLLAB_BROWSER_SECURE_COOKIES=true
COLLAB_HTTP_BIND=127.0.0.1
```

Use `COLLAB_HTTP_BIND=0.0.0.0` only when the Compose gateway itself is the
network-facing component. Do not publish the internal `collab-server` port or
PostgreSQL to untrusted networks.

## Caddy TLS

The default `deploy/Caddyfile` is a plain-HTTP local/LAN profile and keeps
`auto_https off`. To let Caddy terminate TLS directly:

1. Copy `deploy/Caddyfile.tls.example` to `deploy/Caddyfile`.
2. Set `COLLAB_PUBLIC_HOST=collab.example.com` in `.env`.
3. Publish host ports 80 and 443 for the gateway service.
4. Set `COLLAB_BROWSER_SECURE_COOKIES=true`.
5. Restart the gateway with `docker compose up -d gateway`.

For private self-signed deployments, keep client TLS verification enabled by
default and explicitly opt into **Allow untrusted TLS certificates** only for
that server connection in the native app.

If an upstream proxy terminates TLS instead of Caddy, keep the Compose gateway
bound to localhost or a private interface. The upstream proxy must overwrite or
append `X-Forwarded-For` correctly; anonymous REST and WebSocket IP buckets
trust the last forwarded hop from that gateway. Authenticated REST traffic uses
separate hashed session buckets.

## Security Headers

The Rust server sets these headers on all responses, and the Caddy gateway sets
the same baseline at the edge:

- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy` disabling unused browser device APIs
- `Cross-Origin-Opener-Policy: same-origin`
- `X-Frame-Options: DENY`

The TLS example also adds `Strict-Transport-Security`. Enable HSTS only for a
real HTTPS hostname that should always be reached over TLS.

## Emergency Session Rotation

Browser sessions, native access tokens, native refresh tokens, CSRF secrets,
invitations, and WebSocket tickets are generated from operating-system
randomness and stored only as hashes in PostgreSQL. There is no shared signing
secret to rotate for those tokens. To invalidate all active tokens after a
suspected leak or administrator credential rotation, run:

```bash
pnpm server:sessions:revoke
```

For non-interactive runbooks:

```bash
COLLAB_REVOKE_SESSIONS_CONFIRM=revoke ./scripts/server-revoke-sessions.sh
```

All browser and native clients must sign in again. Expired WebSocket tickets and
sessions are also cleaned by the periodic retention worker.

## Administrator Credential Rotation

For planned rotation:

1. Enable maintenance mode in `/admin/settings`.
2. Run and verify a backup: `pnpm server:upgrade:preflight`.
3. Change administrator passwords from the admin UI.
4. Revoke sessions with `pnpm server:sessions:revoke`.
5. Disable maintenance mode after confirming login and dashboard health.

If the main admin account is suspected to be compromised, rotate the password,
revoke all sessions, and inspect audit events before disabling maintenance mode.

## PostgreSQL Password Rotation

1. Enable maintenance mode.
2. Run and verify a backup.
3. Generate a new strong database password.
4. Rotate the database role password:

   ```bash
   docker compose exec -T postgres psql -U "${POSTGRES_USER:-collab}" -d "${POSTGRES_DB:-collab}" \
     -c "ALTER USER ${POSTGRES_USER:-collab} WITH PASSWORD 'replace-with-new-password';"
   ```

5. Update `.env` with the new `POSTGRES_PASSWORD`.
6. Recreate dependent services:

   ```bash
   docker compose up -d --force-recreate collab-server backup
   ```

7. Verify `/health/ready`, then disable maintenance mode.

## TLS and Backup Credential Rotation

- Caddy-managed public certificates renew automatically. If a TLS private key is
  suspected to be exposed, revoke/reissue it with the certificate authority and
  restart the gateway.
- For mounted custom certificates, replace the mounted files atomically and run
  `docker compose restart gateway`.
- SMB/NFS/cloud backup export credentials are managed on the host or external
  mount. Rotate them there, remount the path, and use the admin Backups page to
  run a verification backup.
