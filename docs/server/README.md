# Collaboration Server Architecture

This directory is the entry point for the implemented self-hosted collaboration
server: architecture, operations, security, release, and recovery guidance.

The collaboration server is a separate Rust service that becomes authoritative for hosted vaults. Existing local vaults remain owned by the Tauri application and continue to use the current filesystem-backed behavior.

## Documents

- [Hosted Vault Domain Model](./hosted-vault-domain.md)
- [REST and WebSocket Protocol](./protocol.md)
- [Security, Operations, and Compatibility](./security-operations.md)
- [Workspace and Verification](./workspace-verification.md)
- [Rust Crate Boundary Refactor Plan](../archive/rust-crate-boundary-refactor-plan.md)
- [Server Development and Compose](./development.md)
- [Deployment Topology and Upgrade Compatibility](./deployment-topology.md)
- [Server Backups](./backups.md)
- [Upgrade and Failed-Migration Recovery](./upgrade-recovery.md)
- [TLS, Security Headers, and Secret Rotation](./tls-and-secrets.md)
- [Dependency and Container Vulnerability Scanning](./vulnerability-scanning.md)
- [Load Testing](./load-testing.md)
- [Release Security Review](./security-review.md)
- [Multi-Architecture Server Images](./container-images.md)
- [Admin Web Interface](./admin-web.md)
- [ADR 0001: Authentication and Sessions](./adr/0001-authentication-and-sessions.md)
- [ADR 0002: Hosted Vault Storage](./adr/0002-hosted-vault-storage.md)
- [ADR 0003: CRDT Persistence](./adr/0003-crdt-persistence.md)
- [ADR 0004: Offline Synchronization](./adr/0004-offline-synchronization.md)

## Core Boundary

Hosted vault synchronization has two independent authorities:

1. Document content for notes, Kanban boards, and canvases is synchronized through CRDT documents.
2. Vault structure is synchronized through an ordered server manifest and idempotent structural operations.

Binary assets are immutable blobs referenced by file revisions. Presence and rich awareness are ephemeral and never become canonical vault content.

## Current Implementation Boundary

The server is authoritative for hosted vault identity, membership, file
manifests, revisions, binary blobs, audit/activity, live CRDT rooms, and
offline-replica synchronization state. Local filesystem vaults remain owned by
the Tauri client and keep their filesystem-backed behavior.

Live CRDT collaboration is implemented for supported structured documents.
Vault structure remains outside document CRDTs and is synchronized through the
ordered server manifest plus idempotent structural operations.

The server API and WebSocket modules remain the current adapters. Their internal
modularization and the proposed shared domain crates are planned, not yet
implemented. Follow the crate-boundary plan without changing routes, wire
formats, database semantics, or authorization boundaries as a side effect.
