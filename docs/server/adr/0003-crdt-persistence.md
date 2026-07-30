# ADR 0003: CRDT Persistence

- Status: Accepted
- Date: 2026-06-09

## Decision

Hosted notes, Kanban boards, canvases, and sheets use Yjs-compatible CRDT documents, implemented by the Rust server with `yrs`.

- Each collaborative file has one CRDT document identified by its stable file ID.
- Notes use a shared text root.
- Kanban boards, canvases, and sheets use typed shared maps and arrays whose materialized form remains compatible with the current JSON formats.
- CRDT updates are accepted only through authenticated, authorized document sessions.
- The server stores append-only CRDT updates and periodically compacts them into a snapshot plus a shortened update tail.
- A materialized file revision is produced after a bounded idle period, on explicit snapshot/export, and before destructive structural operations.
- Materialized `.md`, `.kanban`, `.canvas`, and `.sheet` content is used for exports, search indexing, history views, and compatibility with local vaults.
- Presence, cursor state, selections, focused cards/nodes, drag state, and viewport awareness are ephemeral and are not persisted.
- Binary files, PDFs, images, and sidecars do not use CRDT documents in the initial implementation.

Before Phase 5, online hosted text documents use ordinary optimistic revisions. Phase 5 migrates each supported document to a CRDT document from its latest materialized revision.

## Rationale

CRDTs solve concurrent and offline document-content editing. Keeping materialized revisions preserves current file formats and avoids coupling indexing, exports, and history to CRDT internals.

## Consequences

- CRDT protocol and materializer versions are persisted and negotiated.
- Compaction must be crash-safe and covered by recovery tests.
- Invalid Kanban, canvas, or sheet CRDT state must not replace the last valid materialized revision.
- Structural operations remain outside the CRDT and use the manifest operation protocol.
