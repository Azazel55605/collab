# Local Files And External-Writer Recovery

Status: **Planned follow-up**, 2026-10-19. This is separate from the implemented
R03 native mutation coordinator in [Desktop Audit Fixes](./desktop-audit-fixes.md).
It is not a requirement to retrofit an external editor into Collab's process lock.

## Current Contract

Collab's native process reserves a vault namespace around local mutations,
including reference rewrites, moves, folder deletion, trash/restore, imports,
image/annotation writes, snapshot restores, template creation and encryption
transitions. Overlapping absolute export destinations participate too. Separate
vaults can operate independently. Nested helpers must acquire only contained
scopes; expanding an owned scope fails instead of risking a deadlock.

This serializes app-owned operations; it does not make a multi-file rename or
reference rewrite an all-or-nothing filesystem transaction. A failed operation
can leave earlier reference updates applied. Native errors must be retained and
the affected paths reviewed; no successful rollback is claimed.

External programs and other processes do not participate in this coordinator.
Revision checks and the final source-fingerprint check detect external changes
before publication. A detected conflict retains local edits in the editor for
review or **Save mine as new**; an expected revision of a deleted note does not
recreate it. Reference rewrites also check their source revision and stop with an
error rather than knowingly replacing an intervening external edit.

An outside program can still save between the final check and atomic replacement.
No portable advisory-lock protocol can promise atomic compare-and-swap against
an application that ignores it. Atomic replacement prevents a partially written
Collab file; it does not guarantee preservation of that last-moment outside write.
This boundary remains explicit even after the recovery work below ships.

## Recovery Policy For The Follow-Up

- Before replacement, retain the outgoing local version and last observed disk
  version in a vault-local recovery journal under `.collab/recovery/`. Record
  original path, content fingerprints, operation and timestamp. Recovery writes
  must finish before replacing authoritative content; journal failure must leave
  the editor open with its edits and a visible error.
- Encrypt journal content for encrypted vaults with the active vault key. Never
  put document content in logs or global plaintext browser storage. Recovery
  material follows the vault's backup, export and key-change lifecycle.
- Keep detected conflicts and unsaved drafts until explicit recovery/discard.
  Default retention for superseded, successfully saved history is 30 days with a
  256 MiB per-vault soft budget. Exceeding that budget must request cleanup/export
  rather than silently removing unresolved recovery material.
- Restore into a new file by default; replacing an existing document requires
  an explicit action and a fresh revision check. Show original path/time and
  distinguish saved history from unsaved drafts and conflict copies.
- Explain the protection limit: the journal can recover versions Collab observed;
  it cannot promise to capture an external write in the final check/replace gap.
  Watcher events are refresh signals, not proof of writer ownership.

These journal/retention/recovery UI behaviors are **not implemented in PR #96**.
The existing manual save-as-new flow is not durable process-death recovery.

## Acceptance

- [ ] Journal publication, encryption/rekey, quota and failure handling.
- [ ] Durable draft restoration after forced termination and restart.
- [ ] Recovery UI, explicit discard, retention and backup/export coverage.
- [ ] Multi-file operation failure reporting and repair of partial reference updates.
- [ ] Windows and Linux/Wayland matrix with two external editors, in-place writes,
      atomic replacements, folder moves/deletes, aliases, storage failure and
      process interruption. Verify both local edits and all observed disk versions.

None of these checkboxes turns the external check/replace gap into a guaranteed
cross-application transaction. Do not close them using only jsdom or lock tests.
