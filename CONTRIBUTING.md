# Contributing to collab

Thanks for wanting to help. This document covers the practical workflow.
Implementation rules for the codebase itself live in [`AGENTS.md`](./AGENTS.md);
architecture and platform documentation lives in [`docs/`](./docs/README.md).

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Security problems must **not** be filed as public issues — follow the
[Security Policy](./SECURITY.md) instead.

## Requirements

- Node.js 20 or newer — the repository pins 22 in [`.nvmrc`](./.nvmrc), which is
  what CI uses
- `pnpm` 10 or newer — the exact version is pinned via `packageManager`, so
  `corepack enable` is enough to get the right one
- Rust stable toolchain
- Tauri 2 system dependencies for your platform
- Docker with Docker Compose, and `curl`, for anything touching the server

An [`.editorconfig`](./.editorconfig) is checked in: UTF-8, LF, final newline,
no trailing whitespace, two-space indentation except Rust and TOML at four.
[`.gitattributes`](./.gitattributes) enforces LF in the working tree on every
platform, so Windows checkouts no longer differ from CI.

## Getting started

```bash
pnpm install
```

Run the desktop app:

```bash
pnpm tauri dev
```

Run only the browser frontend, the admin interface, or the Android frontend:

```bash
pnpm dev
```

```bash
pnpm admin:dev
```

```bash
pnpm mobile:dev
```

The collaboration server runs from source with the development Compose file:

```bash
docker compose up --build --wait
```

Note that `docker-compose.yml` and `compose.yaml` are **not** interchangeable:
the former pulls the published release image, the latter builds from source.

## Formatting

Prettier owns formatting and import order. Run it before committing:

```bash
pnpm format
```

`format` is preceded automatically by `preformat`, which rewrites any `@/…`
import in `src/` back to a relative path — the Android companion bundles
modules straight out of `src/` and has no `@` alias, so alias imports there
fail to resolve. Generated shadcn primitives in `src/components/ui/` keep their
aliases and are left alone.

CI-friendly check without writing:

```bash
pnpm format:check
```

The first Prettier run touched 701 files. `.git-blame-ignore-revs` lists that
revision; configure git once so `git blame` skips it:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub applies the file automatically.

## Before opening a pull request

Run the full verification set:

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm admin:test && pnpm admin:build && cargo test --workspace && cargo check --workspace
```

`pnpm test` covers only `src/` and `scripts/`. If you touched the Android
frontend, run its suite too:

```bash
pnpm mobile:test
```

If you touched the Rust workspace or version files, run the guards:

```bash
pnpm rust:boundaries && pnpm versions:check
```

`pnpm rust:boundaries` enforces the allowed crate dependency graph — every new
workspace crate has to be added to that policy, and domain crates may not depend
on adapter, platform, or persistence frameworks.

Server changes additionally want:

```bash
docker compose config && ./scripts/server-smoke.sh
```

Live PostgreSQL tests need a disposable database. **They truncate identity
tables — never point them at a database with real data:**

```bash
COLLAB_TEST_DATABASE_URL=postgres://collab:password@127.0.0.1:5432/collab_test cargo test -p collab-server
```

## Branches, commits, and pull requests

- **Never push to `main`.** Every change goes through a branch and a pull
  request, one branch per concern.
- **Commit messages are a single line.** The history contains no multi-line
  commit bodies; keep the subject short and descriptive, for example
  `android build fix` or `improvements for the server backup workflow`.
- Do not add authorship, tooling, or generator trailers to commits or pull
  request descriptions.
- Put the explanation in the pull request description, not in the commit body.
- Keep unrelated changes out. A formatting sweep, a dependency bump, and a
  feature belong in three pull requests.

## Tests

- Frontend tests use Vitest with jsdom. Test files live next to the code they
  cover, as `foo.test.ts` beside `foo.ts`.
- `vitest.config.ts` sets explicit include roots so generated build trees are
  never picked up. Do not widen them.
- Rust tests run through `cargo test --workspace`.
- New behavior needs a test. Bug fixes should come with a test that fails
  without the fix.

## Documentation expectations

- Structural changes — new stores, views, component folders, types, IPC
  commands, or crates — must be reflected in
  [`docs/desktop/codebase.md`](./docs/desktop/codebase.md). It is the file that
  goes stale first.
- UI work follows [`docs/desktop/ui-guide.md`](./docs/desktop/ui-guide.md).
- Feature work with a plan document updates that plan's progress tracker, and
  then the summary in
  [`docs/plans/open-development-work.md`](./docs/plans/open-development-work.md).
- Changes to [`.cargo/audit.toml`](./.cargo/audit.toml) require a matching
  rationale in
  [`docs/build/security-advisories.md`](./docs/build/security-advisories.md).

## Reporting bugs and proposing features

Open an issue and include the affected component (desktop, Android,
collaboration server, admin web), the version, your platform, and reproduction
steps. For the server, include the image tag and any relevant log output with
secrets removed.

Before proposing a large feature, check
[`docs/plans/open-development-work.md`](./docs/plans/open-development-work.md) —
it lists what is already planned, in progress, deferred, or deliberately out of
scope.
