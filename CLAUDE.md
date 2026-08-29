# CLAUDE.md

The implementation rules for this repository live in [`AGENTS.md`](./AGENTS.md).
**Read it first** — it covers the shipped artifacts, the verification command
set, the repository-specific guard scripts, testing/git/code conventions, server
configuration, and the gotchas that cost the most time.

This file exists only so Claude Code picks the guidance up automatically. Keep
it a pointer: adding rules here instead of to `AGENTS.md` splits the source of
truth and one copy will go stale.

## Quick reference

Full verification before claiming work is done:

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm admin:test && pnpm admin:build && cargo test --workspace && cargo check --workspace
```

Mobile is not covered by `pnpm test`:

```bash
pnpm mobile:test
```

Guards that nothing else surfaces:

```bash
pnpm rust:boundaries && pnpm versions:check
```

Never push to `main`; commit messages are a single line without trailers. See
[`AGENTS.md`](./AGENTS.md) for the rest.
