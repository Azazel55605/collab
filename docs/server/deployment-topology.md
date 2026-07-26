# Deployment Topology and Upgrade Compatibility

This document defines the deployment shapes the collaboration server supports,
how the pieces are expected to be wired, and the compatibility rules that make
upgrades safe.

## Supported Topology

The server is designed for a **single-host, single-instance** deployment behind
one reverse-proxy gateway. The reference stack is the published Compose file
(`docker-compose.yml`); the development/self-build stack is `compose.yaml`.

```text
                    Internet / LAN
                         │
                  (TLS, optional)
                         │
                ┌────────▼────────┐
                │  Gateway/Proxy  │   Caddy (bundled) or an upstream proxy.
                │  (port 8788)    │   Terminates TLS, sets X-Forwarded-For,
                └────────┬────────┘   serves /admin/, applies security headers.
                         │ private network
                ┌────────▼────────┐
                │  collab-server  │   Single Axum process (port 8787).
                │  (one instance) │   Holds in-memory live-CRDT rooms,
                └───┬─────────┬───┘   awareness, and the rate-limiter state.
                    │         │
         ┌──────────▼──┐  ┌───▼───────────┐
         │ PostgreSQL  │  │ Blob storage  │  Content-addressed files on a
         │ (private)   │  │ (volume)      │  persistent volume.
         └─────────────┘  └───────────────┘
```

### Required properties

- **Exactly one `collab-server` instance.** Live-collaboration rooms,
  y-protocols awareness, and the per-IP rate limiter are in-process state. The
  server is **not** horizontally scalable today: running two instances behind a
  load balancer would split CRDT rooms and rate-limit counters and is
  unsupported. Scale vertically (CPU/RAM) instead.
- **The gateway is the only public entry point.** PostgreSQL (`5432`) and the
  internal app port (`8787`) must never be exposed to untrusted networks. Only
  the gateway port (`8788` by default, or `443` when TLS is terminated here) is
  published.
- **The gateway sets `X-Forwarded-For`.** Anonymous REST and WebSocket client-IP
  identification trusts the last `X-Forwarded-For` hop appended by the trusted
  proxy; authenticated REST requests use an isolated bearer-session digest.
  If you front the server with your own proxy, it must overwrite (not append to)
  client-supplied `X-Forwarded-For`, or IP-scoped limiting can be spoofed. See
  [Security, Operations, and Compatibility](./security-operations.md#rate-limiting).
- **Persistent volumes.** `postgres-data`, `blob-data`, and `backups` must be on
  durable storage. A blob volume and its PostgreSQL database are a matched pair:
  never restore one without the other (see [Backups](./backups.md)).

### Reverse-proxy variations

- **Bundled Caddy (default).** Terminates nothing by default (HTTP on `8788`);
  enable TLS with `deploy/Caddyfile.tls.example`. See
  [TLS, Security Headers, and Secret Rotation](./tls-and-secrets.md).
- **Upstream proxy (Traefik, nginx, a NAS reverse proxy, Cloudflare Tunnel).**
  Point it at the gateway and let Caddy keep serving `/admin/`, the redirect, and
  the baseline security headers, **or** bypass Caddy and target `collab-server`
  directly — in which case the upstream proxy must reproduce the security
  headers, the `/ → /admin/` redirect, a correct `X-Forwarded-For`, and
  WebSocket upgrade forwarding for `/ws/v1/*`.
- **HTTPS is required for production.** Set `COLLAB_BROWSER_SECURE_COOKIES=true`
  whenever the public origin is HTTPS so browser admin cookies get the `Secure`
  attribute.

#### nginx WebSocket forwarding

When nginx sits in front of the bundled Caddy gateway or the `collab-server`
process, it must proxy WebSocket upgrades. Normal browser/admin traffic may use
HTTP/2 at the public TLS edge, but the live-collaboration WebSocket itself uses
the standard HTTP/1.1 `Upgrade` handshake on `GET /ws/v1/vaults/{vaultId}`.
Classic WebSocket upgrades do not run over HTTP/2; RFC 8441 extended CONNECT is
a different transport path and is not supported by the current Axum
`WebSocketUpgrade` / native `reqwest-websocket` client stack. If nginx forwards
the request but strips the `Connection: Upgrade` hop-by-hop header, the server
rejects the request with `400 Bad Request` and a body like
`Connection header did not include 'upgrade'`.

Use an nginx `map` plus HTTP/1.1 upstream proxying for the WebSocket path. The
public listener can still advertise HTTP/2 for regular HTTPS requests:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl http2;
    server_name collab.example.com;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```

## Resource Sizing

These are starting points for a small/medium self-hosted team; measure with
[load testing](./load-testing.md) for your own content and concurrency.

| Deployment | vCPU | RAM | Notes |
| --- | --- | --- | --- |
| Evaluation / a few users | 1 | 1 GiB | PostgreSQL + server + gateway co-resident. |
| Small team (≤ ~25 active) | 2 | 2–4 GiB | Headroom for live rooms and ZIP import/export. |
| Medium team (≤ ~100 active) | 4 | 8 GiB | Watch storage quota and live-room counts on the dashboard. |

Memory drivers to watch: in-memory ZIP import/export (bounded by
`COLLAB_MAX_IMPORT_*`), live-CRDT rooms (one `yrs` document per open file), and
PostgreSQL's own cache. Disk is dominated by deduplicated blob storage; cap it
with `COLLAB_STORAGE_QUOTA_BYTES` and watch `COLLAB_STORAGE_WARNING_BYTES`.

## Network and Ports

| Port | Service | Exposure |
| --- | --- | --- |
| `8788` (`COLLAB_HTTP_PORT`) | Gateway | Public entry point (bind with `COLLAB_HTTP_BIND`). |
| `8787` | `collab-server` | Private network only. |
| `5432` | PostgreSQL | Private network only. |

Set `COLLAB_HTTP_BIND=127.0.0.1` to keep the gateway host-local (e.g. when an
external reverse proxy on the same host fronts it); the default `0.0.0.0`
publishes on all interfaces.

## Upgrade Model

Releases are published as multi-architecture images to GHCR and tagged by
semantic version, plus moving `MAJOR.MINOR` and `latest` tags (see
[Multi-Architecture Server Images](./container-images.md)).

### How to upgrade

1. **Pin a version** in `.env` (`COLLAB_SERVER_IMAGE=ghcr.io/<owner>/collab-server:X.Y.Z`).
   Production should never track `latest`, so that upgrades are deliberate.
2. **Back up first.** Run `pnpm server:upgrade:preflight` — it creates and
   verifies a full backup, records the current migration state, and prints the
   exact rollback command. See
   [Upgrade and Failed-Migration Recovery](./upgrade-recovery.md).
3. Optionally enable **maintenance mode** from `/admin/settings` for the window
   (mutations return `503 maintenance_mode`; reads and admin stay up).
4. Bump the tag, then `docker compose -f docker-compose.yml pull` and
   `... up -d`. The new server runs ordered SQL migrations under an advisory
   lock before serving traffic; a failed migration stops startup without serving.
5. Verify `/health/ready`, `/api/v1/auth/bootstrap-status`, the dashboard, and a
   representative hosted vault, then disable maintenance mode.

### Compatibility rules

- **Migrations are forward-only.** The server refuses to run against a schema
  newer than it supports, and down migrations are not relied upon — rollback
  means restoring the pre-upgrade database **and** blob backup together.
- **Step through minor versions.** Upgrade one `MAJOR.MINOR` at a time rather
  than jumping across several minors; the server supports the current native
  client protocol and at least one previous compatible minor during an upgrade.
- **Protocol negotiation.** The live WebSocket protocol version is negotiated in
  the handshake (`authenticate`/`ready`); an incompatible client refuses the
  live session and falls back to the REST optimistic-write path rather than
  corrupting state. Mixed client/server minor versions are expected briefly
  during a rollout.
- **No silent downgrades.** Do not point an older server image at a database
  migrated by a newer one. If you must roll back, restore the matched
  pre-upgrade backup pair.
- **Exports stay portable.** Hosted ZIP exports remain compatible with the local
  vault layout across versions, and existing local vaults are never silently
  converted into hosted replicas.

## Out of Scope (current release)

- Horizontal scaling / multi-instance clustering of `collab-server`.
- External/managed PostgreSQL is possible (point `COLLAB_DATABASE_URL` at it) but
  backups, migrations, and the storage quota still assume the server owns its
  blob volume; the bundled backup tooling targets the Compose Postgres service.
- Defense against a malicious server operator — hosted vault content is
  server-readable by design (see the [threat model](./security-operations.md#threat-model)).
