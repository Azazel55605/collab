# SQL Server Phase 0 Driver Spike

Isolated, non-shipping Cargo workspace comparing Tiberius 0.13.0 and Microsoft's
mssql-tds 0.4.0. It uses the portable `collab-database` contract. See the
[decision record](../../docs/plans/database-editor-phase0-contract.md).

Requires Rust, Docker, Python 3 and OpenSSL. After accepting Microsoft's SQL Server
Developer license, run from the repository root:

```sh
COLLAB_DB_SPIKE_ACCEPT_EULA=yes python scripts/database-driver-spike.py \
  --versions 2019 2022 2025 --output /tmp/database-phase0-evidence.json
```

Images already present are reused; missing images are pulled. Reports record
immutable image digests. `--skip-build` reuses a previously built spike binary;
`--image` permits a pinned image with exactly one selected version. Failed runs
leave partial reports with `complete: false` rather than fabricating a full pass.

The harness generates a private temporary password and CA, creates a database in
its own loopback-only Developer container, and removes only that owned container
and its volumes afterwards. Raw subprocess diagnostics are withheld because they
may contain secrets; safe executable/stage diagnostics identify failures. Fixture
credentials never belong in a report. `SSL_CERT_FILE` configures only the isolated
fixture child process, never production trust policy. The in-container sqlcmd
bootstrap bypasses certificate trust only inside the disposable fixture; both
application-driver paths must pass verified TLS and reject invalid trust.

The executable refuses to run without the disposable-fixture marker, accepts only
the fixed localhost fixture and database, and runs fixed test SQL. Do not adapt it
to production endpoints: its tests create/drop tables, commit/rollback and KILL an
owned test session. The generated SA identity is strictly fixture-only.

```sh
cargo test -p collab-database
cargo build --locked --manifest-path tools/database-driver-spike/Cargo.toml
cargo audit --file tools/database-driver-spike/Cargo.lock
```

Debug binary size and Linux host RSS are not packaged desktop measurements. There
is no UI, application IPC command, credential persistence or production adapter in
this spike. Native acceptance remains in the decision record and main tracker.
