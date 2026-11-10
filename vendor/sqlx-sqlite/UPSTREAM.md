# SQLx SQLite Dependency Backport

This directory contains the published `sqlx-sqlite` **0.9.0** crate from
[SQLx revision `003b698e99e024f3621b8043a2426fde5b741171`](https://github.com/launchbadge/sqlx/tree/003b698e99e024f3621b8043a2426fde5b741171/sqlx-sqlite).
It retains the upstream MIT/Apache-2.0 licenses. `upstream-checksums.json` records
the published archive SHA-256 and each retained file's original checksum.
The archive's nested Cargo.lock, duplicate original manifest and VCS metadata
are omitted from this checkout.

The only functional change is the `libsqlite3-sys` requirement in `Cargo.toml`:
`>=0.30.1, <0.38.0` becomes `>=0.39.0, <0.40.0`. SQLx's Rust driver source is
unchanged. The root workspace patch selects this directory; it is excluded
from workspace membership like the existing updater backport.

Reason: [RUSTSEC-2026-0459](https://rustsec.org/advisories/RUSTSEC-2026-0459.html)
affects the bundled SQLite in the old dependency. Malformed database/WAL pairs
can expose uninitialized page-cache memory. `libsqlite3-sys` 0.39 supplies fixed
SQLite 3.54; SQLx 0.9.0 is the latest published driver and its upper bound prevents
a lockfile-only upgrade. No database format, SQLite support or audit check is
disabled. Host workspace tests/checks verify driver API compatibility; native
Android/desktop database acceptance remains a release gate.

Remove this backport when a compatible upstream SQLx release supports fixed
SQLite. Remove the root patch and exclusion, regenerate Cargo.lock, and rerun
fresh audits, workspace tests/checks, SQLite calendar/local-store tests and
native database acceptance.
