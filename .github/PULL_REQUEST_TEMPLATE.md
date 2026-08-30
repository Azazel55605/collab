<!--
Keep the commit subject to a single line; put the explanation here instead.
Do not add authorship, tooling, or generator trailers.
-->

## What this changes

<!-- What the change does, and why. Link the issue if there is one. -->

## Components touched

<!-- Delete what does not apply. -->

- [ ] Desktop app (`src/`, `src-tauri/`)
- [ ] Android companion (`apps/mobile-android/`)
- [ ] Collaboration server (`crates/collab-server/`)
- [ ] Admin web (`apps/admin-web/`)
- [ ] Shared crates (`crates/`)
- [ ] Documentation only

## Verification

<!-- Tick what you ran. Leave unticked what does not apply to this change. -->

- [ ] `pnpm format:check`
- [ ] `pnpm exec tsc --noEmit`
- [ ] `pnpm test`
- [ ] `pnpm mobile:test` (required if the Android frontend changed)
- [ ] `pnpm admin:test` and `pnpm admin:build` (required if admin web changed)
- [ ] `cargo test --workspace` and `cargo check --workspace`
- [ ] `pnpm rust:boundaries` (required if a crate or its dependencies changed)
- [ ] `pnpm versions:check` (required if a version file changed)
- [ ] `docker compose config` and `./scripts/server-smoke.sh` (server changes)

Anything that fails and is not caused by this change — say so and why.

## Documentation

- [ ] `docs/desktop/codebase.md` updated — required for new stores, views,
      component folders, types, IPC commands, or crates
- [ ] The relevant plan tracker and `docs/plans/open-development-work.md` updated
- [ ] `docs/build/security-advisories.md` updated — required if
      `.cargo/audit.toml` changed
- [ ] Nothing here applies

## Notes for the reviewer

<!-- Anything worth pushing back on, deliberate trade-offs, or follow-up work. -->
