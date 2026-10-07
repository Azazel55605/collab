# Security Advisory Tracking

This document tracks every dependency security advisory that the project's
automated scans currently surface but that is **not yet resolved by an upgrade**,
along with the reasoning for each accepted risk. It is the human-readable
companion to the machine-readable ignore lists in
[`.cargo/audit.toml`](../../.cargo/audit.toml) and
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml): every advisory ignored there
must have a corresponding entry here explaining _why_ and _what would let us
drop the ignore_.

Keep these files in sync. When you add or remove an audit ignore, update the
matching entry below in the same change.

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

These advisories fail the scan unless ignored, so each entry is an explicit,
documented decision. An ignore is not a substitute for remediation: when the
registry version remains vulnerable but the installed package is locally
patched, the patch and a regression test must be committed alongside it.

### GHSA-vfj7-8cjw-p6xm — `braces` 3.0.3 (nested-pattern stack exhaustion)

- **Severity:** high. Deeply nested brace patterns can exhaust the Node.js call
  stack in the recursive compiler and expander.
- **Dependency path:** `shadcn` → `fast-glob` → `micromatch` → `braces`, with a
  second path through `shadcn` → `ts-morph` → `@ts-morph/common`.
- **Why the installed code is fixed:** `patches/braces@3.0.3.patch` rejects brace
  nesting beyond 100 levels while parsing, before either recursive walker sees
  the AST. `scripts/security-dependency.test.ts` exercises both compiler and
  expander paths with the adversarial shape.
- **Why the audit ignore remains necessary:** no fixed `braces` release is
  published. pnpm's registry audit evaluates the `3.0.3` version label and does
  not inspect the reproducible local patch, so it otherwise reports the
  mitigated package as vulnerable.
- **Remove the ignore and patch when:** upstream publishes a fixed release and
  the `micromatch` dependency range resolves to it.

There are currently no Rust advisory ignores. The RSA dependency was removed
from the resolved graph by the SQLx upgrade described below.

## Vulnerabilities resolved in the 2026-10-07 review

- **GHSA-68fv-2mgg-jv7q — `source-map-js` (high).** Raised from **1.2.1**
  to **1.2.2**, within PostCSS and Tailwind's declared `^1.2.1` range.
- **GHSA-6qxp-vccf-f47h — `@modelcontextprotocol/sdk` (high).** Raised from
  **1.30.1** to **1.31.0**, within `shadcn`'s `^1.26.0` range. This corrects
  OAuth authorization-server credential handling in the development CLI.
- **DOMPurify's newly reported low advisories.** The old override forced
  Mermaid's sanitizer to **3.4.13**, despite the direct dependency already
  requesting **3.4.16**. Both paths now resolve to **3.4.16**.
- **Moderate `hono`, `ip-address`, and `postcss-selector-parser` findings.**
  Compatible overrides now resolve to **4.13.7**, **10.7.1**, and **7.1.6**
  respectively. No parent dependency range is overridden with an unsupported
  major version.
- **RUSTSEC-2023-0071 — `rsa` (Marvin timing side-channel).** SQLx **0.9.0**
  makes RSA authentication optional in `sqlx-mysql`. Collab uses PostgreSQL
  and SQLite, so `rsa` is no longer in `Cargo.lock`. The corresponding audit
  ignore was removed. The upgrade replaces the old combined
  `runtime-tokio-rustls` feature with `runtime-tokio` and `tls-rustls-ring`.
  SQLx 0.9 also requires literal SQL or a reviewed builder: calendar cleanup
  now uses fixed statements, retention intervals use bound parameters, and
  SQLite schema version assignment appends only the internal integer constant.
  This is dependency removal, not a claim that RSA itself has been patched:
  [RustSec](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) still lists
  no patched version, including the prerelease line. The previous statement
  that `0.10.0-rc.*` fixed the advisory was incorrect. If MySQL/RSA features
  are ever enabled, reassess the advisory rather than restoring the ignore.

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
  older 0.7.3 instance is not reported by the current advisory database).
- **`unicode-segmentation` `yanked`.** Bumped from the yanked `1.13.1` to
  **1.13.3**.
- **RUSTSEC-2026-0194 and RUSTSEC-2026-0195 — `quick-xml` (XML parsing DoS).**
  Bumped Tauri's transitive `plist` from **1.8.0** to **1.10.0**, which moves
  `quick-xml` from **0.38.4** to **0.41.0** (patched in `>= 0.41.0`). The
  matching ignores were removed from `.cargo/audit.toml`.
- **`spin` `yanked`.** Bumped from the yanked **0.9.8** to **0.9.9**.
- **RUSTSEC-2026-0221 — `event-listener` (`unsound`).** Raised from
  **5.4.1** to **5.4.2**, the first patched release. No ignore was added.

### Remaining warnings

These are the warnings emitted by the refreshed advisory database and current
lockfile. Earlier lists of GTK3/unic/rand warnings are not a substitute for a
current scan.

- **RUSTSEC-2024-0429 — `glib` 0.18.5 (`unsound`).** The affected
  `VariantStrIter` iterator is fixed in `>= 0.20.0`. Collab does not use that
  iterator. Tauri's GTK3/WebKitGTK stack, and our Linux gesture/hardware
  acceleration integration, require the 0.18 type family. Updating only our
  direct dependency to `glib` 0.22 does not update GTK's types and cannot clear
  the transitive 0.18 instance. A compatible upstream GTK runtime migration or
  reviewed backport is needed.
- **Tauri tooling (`unmaintained`).** `proc-macro-error` 1.0.4
  (RUSTSEC-2024-0370) remains through upstream dependencies; there is no
  selectable compatible maintained release. `fxhash` is absent from the
  refreshed lockfile after the Rust major migrations.
- **RUSTSEC-2026-0215 — `smallstr` 0.3.1 (`unmaintained`).** Pulled by `yrs`
  0.28.0 in the shipped collaboration runtime. Replacing it requires upstream
  `yrs` changes or a reviewed fork; `compact_str`/`smol_str` are different APIs,
  not drop-in lockfile substitutions. This is not a build-time-only dependency.

The `httpmock` 0.8 migration removes `async-std` and its
RUSTSEC-2025-0052 warning. No new Rust audit ignores were added. GLib stays
on the GTK3-compatible 0.18 family; JNI stays on 0.21 because 0.22 requires
a separate migration of Android native entrypoints and reference lifetimes.

## npm advisories below the failing threshold

`pnpm audit` fails CI at `high` and above. The project currently reports **no
unmitigated high or critical** npm advisory. The patched high advisory above and
the moderate/low remainder are recorded here so they remain visible decisions
rather than background noise.

Transitive fixes are applied through the `overrides` block in
`pnpm-workspace.yaml` (pnpm 11 no longer reads `pnpm.overrides` from
`package.json`). The rule for that block: an override may only raise a package to
a version its own parent's declared semver range **already permits** — that is a
forced dedupe, not an unsupported upgrade. An advisory whose fix falls outside
the parent's range needs the parent upgraded instead, and does not belong there.

The previously documented moderate `shadcn` subtree findings and low
`esbuild`/`@babel/core` findings are absent from the current scan. Compatible
fixes remain in the lockfile/override policy. `shadcn` stays installed because
`src/App.css` imports `shadcn/tailwind.css`; its CLI code is not shipped.

### `diff` — GHSA-73rr-hh4g-fpgx (ReDoS in `parsePatch`/`applyPatch`)

- **Severity:** low.
- **Dependency path:** direct dependency, used by `src/lib/textMerge.ts`,
  `DocumentReconciler`, and `VersionHistoryModal`.
- **Why it is not reachable here:** the advisory is in patch **string parsing**.
  `textMerge` never calls `parsePatch`; it passes `applyPatch` a structured patch
  object produced in-process by `merge`, so the vulnerable parsing path is not
  entered.
- **Why it is not fixed:** the fix is in `diff` >= 8.0.3, and `diff` 8.0.0
  **removed the `merge` export** that `mergeText` is built on. Upgrading means
  reimplementing the frontend three-way merge that mirrors the backend's
  non-overlapping auto-merge.
- **Remove this entry when:** `mergeText` is rewritten against the 8.x API (or
  onto another three-way merge), and `diff` is raised to >= 8.0.3.

### `katex` — GHSA-238p-pmpm-9mq7 (trust bypass after prototype pollution)

- **Severity:** low. Pre-existing prototype pollution can bypass KaTeX trust
  restrictions; this advisory does not itself provide prototype pollution.
- **Dependency paths:** direct `katex` **0.16.47** and `mermaid` **11.17.2**
  → `katex` **0.16.47**.
- **Fix:** `katex >= 0.18.2`. Mermaid 11's `^0.16.9` range does not permit
  that release. Do not force an incompatible override; upgrade the parent and
  validate Markdown/math/diagram behavior together. The grouped npm major PR
  has unrelated compilation failures and is not ready to provide this fix.
- **Remove this entry when:** both direct and Mermaid paths resolve to a
  patched release after that migration.

## Initial Dependabot PR review (2026-10-07)

The table preserves the initial review, before the compatibility repairs in
#76 and #78. Current remediation is described above and in those PRs.
Compatible Rust updates merged separately as #80.

| PR                                                                            | Local evidence                                                                                                                                                                                      | Recommendation                                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [#75](https://github.com/Azazel55605/collab/pull/75), Rust compatible updates | Workspace compilation passed. Its older container scan reported 29 fixable OS findings; PR #79's later container scan passed with the same Dockerfile.                                              | Rebase/rebuild against the security fixes and require fresh security checks before merge.                     |
| [#76](https://github.com/Azazel55605/collab/pull/76), Rust major updates      | `cargo check --workspace --locked` fails: quick-xml 0.42 changes `local_name()` from bytes to text, breaking SVG validation in `collab-documents`. Further native/API migrations remain unverified. | Split into reviewed migrations; do not merge as-is. Frontend/boundary CI does not establish Rust compilation. |
| [#77](https://github.com/Azazel55605/collab/pull/77), npm compatible updates  | TypeScript 5.9 rejects the inferred `Uint8Array<ArrayBuffer>` assignment in `src/lib/ink/transaction.test.ts:193`. Its failed dependency job was interrupted while installing cargo-audit.          | Fix the test type, rebase security fixes, then run all frontend surfaces and fresh scans.                     |
| [#78](https://github.com/Azazel55605/collab/pull/78), npm major updates       | Type checks fail for removed `diff.merge`, MarkdownIt typing, Nerdamer parser APIs, and DayPicker props/class names. CI runs were cancelled.                                                        | Split tooling/editor/UI migrations; preserve three-way merge behavior before upgrading `diff`.                |

## Review cadence

Re-check these entries whenever Tauri, `sqlx`, `plist`, `vite`, or `mermaid` are
upgraded, and at minimum before each tagged release. Drop any ignore whose upstream fix has
shipped, and delete the corresponding entry here. Also re-scan the non-failing
warnings for newly available upgrades (e.g. a maintained fork or a Tauri release
that moves off GTK3 / old `phf`).

_Last reviewed: 2026-10-07._
