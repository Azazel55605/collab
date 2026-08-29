# Load Testing

The load test exists to size a deployment and to confirm that the gateway,
health checks, rate limiting, and authenticated hosted-vault reads behave under
concurrency. It is a coarse capacity check, not a synthetic full-collaboration
benchmark (live WebSocket co-editing convergence is covered by the server's
two-client `ws::` integration tests).

## Running It

Start the server first, then drive load against the gateway:

```bash
docker compose up --wait            # or: docker compose -f docker-compose.yml up -d
pnpm server:load-test
```

Equivalent script:

```bash
./scripts/server-load-test.sh
```

The script preflights `/health/ready`, then runs read load against the
liveness, readiness, bootstrap-status, and admin-SPA endpoints. It uses the
first available load generator (`oha`, then `hey`, then `wrk`) and falls back to
a portable concurrent `curl` loop with coarse timing when none is installed.

### Include authenticated traffic

Provide credentials to also load the authenticated hosted-vault list
(`GET /api/v1/vaults`):

```bash
COLLAB_LOAD_USERNAME=admin \
COLLAB_LOAD_PASSWORD='…' \
  pnpm server:load-test
```

### Tuning

| Variable                                        | Default                 | Purpose                                      |
| ----------------------------------------------- | ----------------------- | -------------------------------------------- |
| `COLLAB_LOAD_URL`                               | `http://127.0.0.1:8788` | Target gateway URL.                          |
| `COLLAB_LOAD_DURATION`                          | `30s`                   | Duration per endpoint (`oha`/`hey`/`wrk`).   |
| `COLLAB_LOAD_CONCURRENCY`                       | `50`                    | Concurrent connections/workers.              |
| `COLLAB_LOAD_REQUESTS`                          | `1000`                  | Total requests for the `curl` fallback only. |
| `COLLAB_LOAD_USERNAME` / `COLLAB_LOAD_PASSWORD` | unset                   | Enables the authenticated phase.             |

## Interpreting Results

- **Health and admin endpoints are never rate limited.** Sustained throughput
  here reflects raw proxy + process capacity.
- **`/api/v1/*` traffic is rate limited** by `COLLAB_REST_RATE_LIMIT_PER_MINUTE`
  (default 1200/min). Authenticated sessions receive separate buckets;
  authenticated traffic from one IP also shares an aggregate bucket at eight
  times that limit, while anonymous load uses the base IP bucket. A capacity run
  that exceeds its applicable bucket will show `429 RATE_LIMITED` responses —
  that is the limiter working, not a failure. To measure raw capacity instead,
  raise or disable (`0`) the limit in a disposable environment; to verify the
  limiter, keep the default and confirm `429`s with a `Retry-After` header
  appear.
- **Calendar traffic has a second budget.** `/api/v1/calendars*`,
  `/api/v1/calendar-feeds*`, and `/caldav*` also consume
  `COLLAB_CALENDAR_RATE_LIMIT_PER_MINUTE` (default `600/min`). Test calendar
  capacity with both limits recorded; a request must satisfy both. Include
  bounded range queries, subscription refreshes, incremental sync pages, and
  CalDAV reports when sizing a calendar-heavy deployment.
- Watch the admin dashboard during the run: storage pressure, live-room counts,
  and CRDT compaction backlog are the operational signals that matter under
  load.

## Results Template

Record a dated run when validating a release or sizing a host:

```text
Date:            2026-06-20
Image:           ghcr.io/<owner>/collab-server:X.Y.Z
Host:            <vCPU> vCPU / <RAM> GiB, <storage>
Generator:       oha 1.x
Concurrency:     50      Duration: 30s
REST limit:      1200/min (default) | raised to <n> | disabled
Calendar limit:  600/min (default) | raised to <n> | disabled

Endpoint                         req/s     p50      p95      errors
health/ready                     …         …        …        0
bootstrap-status                 …         …        …        0
admin SPA                        …         …        …        0
hosted vault list (auth)         …         …        …        <429s expected if > limit>
calendar range query (auth)       …         …        …        <429s expected if > either limit>

Observations:    <CPU/RAM ceiling, limiter behavior, dashboard warnings>
```

## Relationship to Other Checks

- Functional/regression load on live collaboration is exercised by
  `cargo test -p collab-server ws::` (two-client convergence, viewer denial,
  permission rechecks).
- Backup/restore under a realistic dataset is covered by
  `./scripts/server-backup-restore-smoke.sh`.
- This load test complements the [deployment topology](./deployment-topology.md)
  sizing table — use measured numbers to move between its tiers.
