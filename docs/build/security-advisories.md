# Security Advisory Tracking

This document tracks every dependency security advisory that the project's
automated scans currently surface but that is **not yet resolved by an upgrade**,
along with the reasoning for each accepted risk. It is the human-readable
companion to the machine-readable ignore list in
[`.cargo/audit.toml`](../../.cargo/audit.toml): every advisory ignored there must
have a corresponding entry here explaining *why* and *what would let us drop the
ignore*.

Keep the two in sync. When you add or remove an entry in `.cargo/audit.toml`,
update the matching row below in the same change.

## How scanning works

The `Security Scan` workflow (`.github/workflows/security-scan.yml`) runs:

- `cargo audit` over the Rust workspace lockfile, honoring the ignore list in
  `.cargo/audit.toml`. A **vulnerability** fails the job (exit 1);
  **informational** advisories (`unsound`, `yanked`) are reported as
  non-failing warnings.
- `pnpm audit --audit-level high --ignore-registry-errors` over the JavaScript
  dependencies, using the pinned pnpm 11 toolchain.
- Trivy over the built server container image (`HIGH`/`CRITICAL`, fixable only).

Prefer fixing an advisory with a dependency upgrade. Only add an ignore when
there is genuinely no upgrade path (the fix is unreleased, or a pinned upstream
crate blocks it) **and** the vulnerable code path is not reachable in a way that
matters for this project.

## Accepted (ignored) advisories

These are the advisories currently listed in `ignore = [...]` in
`.cargo/audit.toml`. They fail the scan unless ignored, so each one is an
explicit, documented risk acceptance.

### RUSTSEC-2023-0071 — `rsa` 0.9.10 (Marvin timing side-channel)

- **Severity:** 5.9 (medium). Potential RSA private-key recovery via a timing
  side channel (Marvin attack).
- **Dependency path:** `rsa` is pulled in only through `sqlx-mysql`.
- **Why it is not reachable here:** `sqlx-macros-core` resolves every database
  backend for its compile-time macros, but collab-server enables the PostgreSQL
  backend only. The vulnerable `rsa` code is reachable solely through the MySQL
  backend, which is not compiled into the server binary. The desktop app does
  not depend on `rsa` at all.
- **Why it is not fixed:** there is no fixed **stable** `rsa` release. The fix
  landed only in `0.10.0-rc.*` prereleases; the latest stable remains `0.9.10`.
- **Remove the ignore when:** a stable `rsa` release (>= 0.10.0) is published and
  `sqlx` depends on it — or `sqlx` stops pulling `rsa` into the resolved graph
  for the PostgreSQL-only build.

## Informational warnings (non-failing)

`cargo audit` also reports `unsound`, `unmaintained`, and `yanked` advisories as
**warnings**. These do **not** fail the scan, so they are deliberately **not**
added to the `.cargo/audit.toml` ignore list — suppressing them would only hide
future signal without changing CI. We still fix any that have an upgrade path and
track the rest here.

### Resolved by upgrade

- **RUSTSEC-2026-0190 — `anyhow` (`unsound`).** `anyhow` 1.0.102 was bumped to
  **1.0.103** (patched in `>= 1.0.103`). `anyhow` is a direct workspace
  dependency, so this was a clean fix.
- **RUSTSEC-2026-0097 — `rand` (`unsound`).** The workspace resolves three `rand`
  versions; the advisory is fixed in `>= 0.8.6` / `>= 0.9.3` / `>= 0.10.1`.
  `rand` 0.8.5 was bumped to **0.8.6** and `rand` 0.9.4 is already patched (the
  residual 0.7.3 instance is tracked below).
- **`unicode-segmentation` `yanked`.** Bumped from the yanked `1.13.1` to
  **1.13.3**.
- **RUSTSEC-2026-0194 and RUSTSEC-2026-0195 — `quick-xml` (XML parsing DoS).**
  Bumped Tauri's transitive `plist` from **1.8.0** to **1.10.0**, which moves
  `quick-xml` from **0.38.4** to **0.41.0** (patched in `>= 0.41.0`). The
  matching ignores were removed from `.cargo/audit.toml`.
- **`spin` `yanked`.** Bumped from the yanked **0.9.8** to **0.9.9**.

### Remaining warnings with no upgrade path

None of these fail the scan; none are in the ignore list. They persist because
they are transitive dependencies pinned by upstream (mostly Tauri) with no
maintained drop-in replacement.

- **gtk-rs GTK3 binding crates (`unmaintained` + one `unsound`).** `atk`,
  `atk-sys`, `gdk`, `gdk-sys`, `gdkwayland-sys`, `gdkx11`, `gdkx11-sys`, `gtk`,
  `gtk-sys`, `gtk3-macros` (all 0.18.2; RUSTSEC-2024-0411 through
  RUSTSEC-2024-0420) and `glib` 0.18.5 (`unsound`, RUSTSEC-2024-0429). These are
  the real Linux WebKitGTK webview runtime and are only in the Linux build graph.
  - **No upgrade exists.** gtk-rs `0.18` is the final GTK3 binding line; upstream
    gtk-rs has moved to GTK4, so there is no maintained newer GTK3 binding to
    move to.
  - **It is upstream-bound.** The bindings are pulled by `tao` (windowing),
    `muda` (menus), and `tauri-runtime`, all locked to GTK3 because Tauri 2
    stable targets `webkit2gtk-4.1` (GTK3). Clearing them requires Tauri/`wry`
    to migrate to `webkitgtk-6.0` (GTK4), which is not in a stable release. We
    are already on the latest compatible Tauri/`wry` (`tauri` 2.10.3, `wry`
    0.54.4 — `cargo update` finds nothing newer), so there is nothing to pull in.
  - **Collab also depends on `gtk`/`webkit2gtk`/`gtk-sys` directly**
    (`src-tauri/Cargo.toml`), used in `src-tauri/src/lib.rs` to force WebKit
    hardware acceleration and install a pinch-to-zoom `GestureZoom` handler on
    Linux. This is pinned to the same `0.18` line as Tauri, so removing our
    direct dependency would neither clear the advisories (`tao`/`muda` still
    pull `0.18`) nor be desirable (we would lose the gesture/HW-accel behavior).
  - `glib`'s unsound advisory is specifically about the `VariantStrIter`
    iterator impls, which Collab does not use (we only call
    `glib::translate::from_glib_none`).
  - **Clears when:** a stable Tauri release adds GTK4/`webkitgtk-6.0` support and
    we upgrade (also bumping our direct `gtk`/`webkit2gtk` deps to the GTK4
    line).
- **Tauri build-time tooling (`unmaintained`).** `fxhash` 0.2.1
  (RUSTSEC-2025-0057), `proc-macro-error` 1.0.4 (RUSTSEC-2024-0370), and the
  `unic-*` 0.9.0 crates — `unic-char-property` (RUSTSEC-2025-0081),
  `unic-char-range` (RUSTSEC-2025-0075), `unic-common` (RUSTSEC-2025-0080),
  `unic-ucd-ident` (RUSTSEC-2025-0100), `unic-ucd-version` (RUSTSEC-2025-0098).
  All are pulled by `tauri-build`/`tauri-utils`/`selectors` and run at build time
  only; none have a maintained upgrade we can select without an upstream change.
- **RUSTSEC-2026-0097 — `rand` 0.7.3 (`unsound`).** A second, older `rand`
  remains via `phf_generator` 0.8.0 → `kuchikiki`/`selectors` → `tauri-utils`
  (Tauri build tooling). It is pinned by `phf_generator 0.8.0`'s `rand = "^0.7"`
  requirement and there is no patched 0.7 release. Build-time only, and it does
  not exercise the affected custom-logger + `thread_rng` reseed pattern; it
  clears once the upstream tooling moves to a newer `phf`.
- **RUSTSEC-2025-0052 — `async-std` 1.13.2 (`unmaintained`).** Pulled only as a
  **dev-dependency** through `httpmock` (test harness). It is not compiled into
  any shipped artifact. It clears when `httpmock` drops `async-std` or is
  replaced.

## Review cadence

Re-check these entries whenever Tauri, `sqlx`, or `plist` are upgraded, and at
minimum before each tagged release. Drop any ignore whose upstream fix has
shipped, and delete the corresponding entry here. Also re-scan the non-failing
warnings for newly available upgrades (e.g. a maintained fork or a Tauri release
that moves off GTK3 / old `phf`).

_Last reviewed: 2026-07-14._
