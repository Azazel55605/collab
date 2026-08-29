# CLAUDE.md

Guidance for AI coding assistants working in this repository. Keep it short —
detailed documentation lives in [`docs/`](./docs/README.md), and this file
should point there rather than duplicate it.

## What this repository ships

Four independently versioned artifacts from one workspace ([`versions.json`](./versions.json)):

| Artifact | Where | Stack |
| --- | --- | --- |
| Desktop app | `src/`, `src-tauri/` | Tauri 2, React 19, Rust |
| Android companion | `apps/mobile-android/`, `src-tauri/` | Tauri Android, own Vite/Vitest config |
| Collaboration server | `crates/collab-server/` | Axum, SQLx, PostgreSQL |
| Admin web | `apps/admin-web/` | React 19, Vite, served under `/admin/` |

Rust is a Cargo workspace of 12 crates plus `src-tauri`. Portable domain logic
lives in `crates/`; Tauri and Axum are adapters around it.

## Verification

Run the full set before claiming work is done:

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm admin:test && pnpm admin:build && cargo test --workspace && cargo check --workspace
```

Mobile has its own suite and is not covered by `pnpm test`:

```bash
pnpm mobile:test
```

Server and Compose checks:

```bash
docker compose config && ./scripts/server-smoke.sh
```

Live PostgreSQL tests need a disposable database — **they truncate identity
tables, so never point them at real data**:

```bash
COLLAB_TEST_DATABASE_URL=postgres://collab:password@127.0.0.1:5432/collab_test cargo test -p collab-server
```

## Repository-specific guards

These are easy to miss because nothing else surfaces them:

```bash
pnpm rust:boundaries   # enforces the allowed crate dependency graph via cargo metadata
pnpm versions:check    # verifies desktop/mobile/server/admin-web versions are aligned
```

Every new workspace crate must be added to the boundary policy or
`pnpm rust:boundaries` fails.

## Conventions

- **IPC**: frontend code calls typed wrappers in `src/lib/tauri.ts`, never Tauri
  plugins directly from components. Shared local/hosted file and document
  operations go through `src/lib/vaultClient.ts`.
- **Paths**: everything crossing the IPC boundary is relative to the vault root.
- **Optimistic locking**: `write_note` takes `expected_hash`; handle the
  conflict result rather than retrying blindly.
- **Excluded from listing/indexing**: `.collab/` plus hidden and generated
  dependency/build directories.
- **UI controls**: use `src/components/ui/`; never render browser- or OS-native
  control chrome directly. Missing controls get added there following
  [`docs/desktop/ui-guide.md`](./docs/desktop/ui-guide.md).
- **Document views**: follow the `DocumentTopBar` pattern in
  `src/components/layout/DocumentTopBar.tsx`.
- **Shared crates** must stay free of Tauri, Axum, SQLx, PostgreSQL, concrete
  storage backends, and OS integration. `collab-calendar` has an explicit
  SQLite-store exception.

## Gotchas

- **Android debug builds**: `Cargo.toml` sets `opt-level = 1` for workspace
  crates and `3` for dependencies on purpose. Unoptimized dependencies make the
  debug APK feel broken — AES-GCM measured ~65× slower. Do not "simplify" those
  profile settings.
- **View routing is two-layered**: `uiStore.activeView` handles page-level views
  (`grid`, `calendar`, …); the `editorStore` tab type selects document views
  (`sheet`, `ink`, `logic`, `image`, `pdf`). `SvgVectorView` is chosen over
  `ImageView` by a `/\.svg$/i` test inside the `image` tab type. See
  `src/components/layout/AppShell.tsx`.
- **OCR assets** are prepared by `scripts/prepare-ocr-assets.mjs`, which runs
  automatically before `pnpm dev` and `pnpm build`.
- **`.sheet` is the only authoritative spreadsheet format.** `.xlsx`/`.csv` are
  bounded conversion targets, never a live backing model.
- **Formula engine isolation**: nothing outside `crates/collab-sheet/src/formula.rs`
  may depend on `formualizer_*` types.
- **Security advisories** are accepted explicitly, not suppressed silently. If
  you touch [`.cargo/audit.toml`](./.cargo/audit.toml), update the matching
  rationale in [`docs/build/security-advisories.md`](./docs/build/security-advisories.md).

## Where the truth lives

- Project status, and what is actually unfinished:
  [`docs/plans/open-development-work.md`](./docs/plans/open-development-work.md)
  — trust this over any plan document's own tracker.
- Code structure, stores, types, IPC commands, crate responsibilities:
  [`docs/desktop/codebase.md`](./docs/desktop/codebase.md)
- Visual language and interaction rules: [`docs/desktop/ui-guide.md`](./docs/desktop/ui-guide.md)
- Server architecture, protocol, operations: [`docs/server/README.md`](./docs/server/README.md)

Update `docs/desktop/codebase.md` alongside any structural change — it is the
file that goes stale first.
