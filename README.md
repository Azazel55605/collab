# collab

[![Build](https://github.com/Azazel55605/collab/actions/workflows/build.yml/badge.svg)](https://github.com/Azazel55605/collab/actions/workflows/build.yml)
[![Server Container Build](https://github.com/Azazel55605/collab/actions/workflows/server-container-build.yml/badge.svg)](https://github.com/Azazel55605/collab/actions/workflows/server-container-build.yml)
[![Security Scan](https://github.com/Azazel55605/collab/actions/workflows/security-scan.yml/badge.svg)](https://github.com/Azazel55605/collab/actions/workflows/security-scan.yml)

Local-first vault-based knowledge work for Markdown notes, canvases, Kanban boards,
PDFs, images, and collaboration.

`collab` is a Tauri 2 desktop app built with React 19, TypeScript, Rust, and
CodeMirror 6. Local vaults remain first-class and stay on disk. Existing
shared-folder collaboration works through vault metadata, and a self-hosted
collaboration server provides authenticated users, hosted vaults, server-backed
permissions, live co-editing, and offline synchronization.

The server foundation, authentication, administration, hosted-vault content,
live co-editing, and offline-sync phases are implemented. They include
PostgreSQL-backed identities, Argon2id credentials, secure browser and native
sessions, expiring invitations, audit events, a Collab-style admin web
interface, a desktop server connection flow, server-backed CRDT live editing
over WebSocket, and a native offline replica with reconnect convergence.
Published multi-architecture (AMD64/ARM64) server images are released to GitHub
Container Registry and run with a single production Compose file.

## Highlights

- Markdown notes with live preview, wikilinks, backlinks, autosave, optimistic conflict handling, and rich insertion tools
- First-class vault files for `.md`, `.canvas`, `.kanban`, images, and PDFs
- Canvas boards with note/file/text/web cards, edge labels/styles/arrows, PDF thumbnails, and link previews/embeds
- Kanban boards with drag-and-drop columns/cards, calendar and timeline views, attachments, assignees, tags, archive, and templates
- Dedicated PDF reader with single-page, long-scroll, and side-by-side layouts plus fit and custom zoom modes
- Dedicated image viewer/editor with additive annotation overlays and permanent crop/rotate/resize/export flows
- Shared-folder collaboration with presence, chat, per-file history snapshots, permissions, and conflict dialogs
- Hosted vaults on a self-hosted server with server-backed roles, fine-grained permissions, and authenticated native/browser sessions
- Live co-editing of hosted notes, Kanban boards, canvases, and logic diagrams over a server-held CRDT, with live presence and safe REST fallback when no live session is available
- Offline synchronization for hosted vaults through a native replica with reconnect convergence and a status-bar sync/conflict indicator
- User calendars with desktop and Android offline sync, iCalendar import/export and subscriptions, plus hosted CalDAV access through revocable app passwords
- Self-hosted Docker Compose server with PostgreSQL, persistent blob storage, Caddy gateway, health checks, automatic migrations, backups, quotas, and rate limiting
- Published multi-architecture (AMD64/ARM64) server images on GitHub Container Registry for one-command production deployment
- Server administration web interface with first-admin bootstrap, invitations, dashboard, user/password/session lifecycle management, activity inspection, and audit views
- Vault encryption with Argon2id + AES-256-GCM
- Theming, font, motion, calendar, zoom, and web preview settings
- Native desktop packaging through Tauri, including Flatpak support and in-app updates where supported

## Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 19, Vite, TypeScript |
| Styling | Tailwind CSS v4, shadcn/ui, Radix UI |
| Editor | CodeMirror 6 |
| Canvas | `@xyflow/react` |
| Kanban drag/drop | `dnd-kit` |
| Graph view | D3 |
| PDF rendering | `pdfjs-dist` |
| State | Zustand |
| Desktop backend | Rust, Tauri commands |
| Collaboration server | Rust, Axum, SQLx, PostgreSQL |
| Admin web | React 19, Vite |
| Deployment | Docker Compose, Caddy |

## Current Features

### Notes

- CodeMirror-based Markdown editing with GFM support
- Live inline formatting previews for common Markdown constructs
- Wikilinks with vault-wide autocomplete and backlink indexing
- Autosave with optimistic locking and conflict resolution
- Auto-rename to match the first H1 heading
- Toolbar actions for headings, formatting, links, images, tables, task lists, math, code blocks, and more
- Shift-click editor dialogs for visual table, task-list, math-block, and fenced-code editing
- Nerd Font icon picker and command-bar insertion actions
- Sidebar search and tag browsing

### Vault Files And Views

- Notes (`.md`)
- Canvases (`.canvas`)
- Kanban boards (`.kanban`)
- Images, including additive overlay annotations stored under `.collab/image-overlays/`
- PDFs opened in a custom in-app reader
- Multi-tab editing with dirty-state tracking and drag-reorder
- Grid workspace view for arranging multiple views side by side

### Navigation And Discovery

- D3 graph view for wikilink relationships across notes
- File tree with folders, managed media, drag-and-drop moves, and context actions
- Command bar for search, quick actions, note creation, math evaluation, and editor insertions
- Vault-wide text search and tag browsing in the sidebar
- Shared document top-bar pattern across note, image, PDF, canvas, and Kanban views

### Canvas

- Node types: note, file, text, and web
- Drag files from the file tree onto the canvas
- Rich card previews for notes, text-like files, images, PDFs, and websites
- Web cards with preview/embed modes, optional auto-load, and global preview controls
- Styled edges with labels, solid/dashed/dotted lines, animation, and start/end arrows
- Viewport persistence and optimistic save/reload handling

### Kanban

- Multi-column drag-and-drop boards
- Card attachments to vault files
- Assignees, tags, checklists, due-date oriented views, and archived cards
- Calendar and timeline views
- Default column tags and optional auto-apply-on-move behavior
- Built-in, vault, and app-level Kanban templates
- Import/export/copy/apply template flows

### PDFs And Images

- PDF reader with single, scroll, and spread layouts
- Fit-width, fit-height, fit-page, `100%`, and custom zoom controls
- Rotation and keyboard shortcut support in the PDF viewer
- Image viewer with additive annotations like pen, arrows, text, crop overlays, and erasing
- Permanent image edits for crop, rotate, resize, flattening, overwrite, or save-as-new-image

### Collaboration

- Presence stored in `{vault}/.collab/presence/`
- Active-file awareness and peer presence in the UI
- Sidebar collaboration panel with peers, chat, and history tabs
- Typing indicators in chat
- Snapshots stored under `{vault}/.collab/snapshots/` with compare and restore flows
- Vault member roles: viewer, editor, admin
- Conflict dialogs for concurrent edits

### Self-Hosted Server And Administration

- Standalone Rust collaboration server with structured configuration and logging
- Docker Compose stack containing PostgreSQL, the collaboration server, and Caddy
- Persistent PostgreSQL, blob-storage, backup, and gateway volumes
- Liveness and readiness endpoints plus automatic SQL migrations
- Content-addressed filesystem blob storage behind a storage abstraction
- PostgreSQL-backed users, credentials, browser/native sessions, invitations, and audit events
- Canonical hosted-vault and membership storage with authenticated lifecycle,
  role-management, activity, and administration inventory APIs
- Stable-ID hosted file manifests, portable hosted-path validation, and
  optimistic text-document revisions backed by content-addressed blobs
- Integrity-checked hosted binary assets with deduplicated blob storage,
  authenticated downloads, and configurable per-file upload limits
- Idempotent stable-ID rename, move, trash, restore, and admin-only purge
  operations with manifest conflict detection
- Hosted text revision history, labeled snapshots, historical comparison
  content, and optimistic snapshot restore as a new revision
- Ranked hosted-note search backed by a self-repairing PostgreSQL full-text
  index with title, frontmatter-tag, and excerpt results
- Admin-only bounded local-vault ZIP import and active-current-content ZIP
  export compatible with the normal local vault layout
- Argon2id password hashing, one-time administrator bootstrap, CSRF protection, and login rate limiting
- Collab-style shadcn admin web interface served at `/admin/`, with persisted
  theme, accent, and density settings
- Dashboard storage/warning summaries, user creation/invitations, password reset, disable/re-enable/delete controls, session revocation, activity inspection, and redacted audit views
- Desktop server login in Settings with memory-only access tokens and refresh tokens stored in the OS credential store
- Live co-editing of hosted notes, Kanban boards, canvases, and logic diagrams backed by a
  per-document server-held `yrs` CRDT, relayed over an authenticated WebSocket
  with single-use tickets, live awareness/presence, and REST optimistic-write
  fallback when no live session is available
- Offline synchronization through a native per-vault replica store with a
  pending-operation queue, CRDT-state caching, integrity checks, reconnect
  convergence, and a status-bar sync/conflict recovery indicator
- Operational hardening: server-wide storage quota and warnings, isolated
  authenticated REST plus IP-scoped anonymous/WebSocket rate limiting, and a
  retention/compaction maintenance worker
- Published multi-architecture (AMD64/ARM64) images on GitHub Container Registry,
  built and vulnerability-scanned per platform before release tags are assigned
- TLS certificates are verified by default. Private servers using self-signed
  certificates can explicitly enable **Allow untrusted TLS certificates** in
  Server Settings; installing the private CA on the device remains the safer
  production approach.

Server architecture, operations, and release guidance are tracked in
[docs/server/README.md](./docs/server/README.md).

### Vault Management And Security

- Create, open, rename, export, and switch vaults
- Recent vault history with validation/pruning of missing paths
- AES-256-GCM vault encryption with Argon2id-derived keys
- Unlock, enable, disable, and change-password flows
- App-managed `Pictures/` folder for imported image assets

### UI And Customization

- Themes: `dark`, `midnight`, `warm`, `light`
- Accent colors: `violet`, `blue`, `emerald`, `rose`, `orange`, `cyan`
- Interface fonts: `geist`, `inter`, `serif`, `mono`
- Editor fonts: `codingMono`, `jetbrainsMono`, `firaCode`
- Separate interface/editor font sizes
- UI scale controls
- Animation and motion controls
- Date format and week-start settings
- Web preview and hover-preview toggles
- In-app shortcuts reference and command bar

## Project Structure

```text
apps/
  admin-web/         Focused browser administration interface

crates/
  collab-calendar/   Shared calendar model, recurrence, iCalendar, and native store
  collab-circuit/    Shared circuit model, compiler, and simulation numerics
  collab-core/       Shared hashing and relative-path rules
  collab-protocol/   Shared server DTOs, error codes, and protocol versions
  collab-replica/    Shared native hosted-vault offline replica store
  collab-server/     Axum server, authentication, migrations, and blob storage

src/
  components/
    collaboration/   Presence, chat, history, conflict UI
    command-bar/     Global command/search/action palette
    editor/          Markdown editor, toolbar, preview helpers, editor dialogs
    graph/           D3 graph view
    grid/            Multi-workspace layout UI
    kanban/          Board, columns, cards, templates, calendar, timeline
    layout/          App shell, activity bar, sidebar, tab bar, status bar
    previews/        Web preview popovers
    settings/        Settings and shortcuts UI
    ui/              shadcn/ui primitives
    vault/           Vault picker, file tree, boards panel, dialogs
  lib/
    tauri.ts         Typed Tauri IPC wrappers
    collabTransport.ts
  store/
    vaultStore.ts
    editorStore.ts
    uiStore.ts
    noteIndexStore.ts
    collabStore.ts
    gridStore.ts
    kanbanStore.ts
    updateStore.ts
  types/
    canvas.ts
    kanban.ts
    image.ts
    note.ts
    template.ts
    vault.ts
  views/
    NoteView.tsx
    ImageView.tsx
    PdfView.tsx
    GraphPage.tsx
    CanvasPage.tsx
    KanbanPage.tsx
    GridView.tsx
    SettingsPage.tsx

src-tauri/src/commands/
  vault.rs
  files.rs
  templates.rs
  index.rs
  watcher.rs
  collab.rs
  crypto.rs
  ui.rs
  update.rs
  web.rs
  server.rs
  replica.rs            Native hosted-vault offline replica store

docker-compose.yml    Production/release stack (published GHCR image)
compose.yaml          Local build stack for development and testing
Dockerfile.server     Cached multi-stage server and admin-web image
```

## Requirements

- Node.js 20+
- `pnpm` 10+
- Rust stable toolchain
- Tauri 2 system dependencies for your platform
- Docker with Docker Compose for the collaboration server
- `curl` for server smoke tests

Linux packaging and install notes live in
[docs/build/linux-install.md](./docs/build/linux-install.md).

## Build Instructions

Install JavaScript dependencies once:

```bash
pnpm install
```

### Desktop App

Run the complete desktop app in development:

```bash
pnpm tauri dev
```

Build a production desktop bundle:

```bash
pnpm tauri build
```

Run only the browser frontend without the Tauri shell:

```bash
pnpm dev
```

### Admin Web Interface

Run the focused server administration interface locally:

```bash
pnpm admin:dev
```

Build and type-check its production bundle:

```bash
pnpm admin:build
```

The development server proxies API requests to a collaboration server listening
on `127.0.0.1:8787`.

### Collaboration Server With Docker Compose

The repository ships two Compose files:

| File | Use it for | Image |
| --- | --- | --- |
| `docker-compose.yml` | **Production / releases (recommended for most users)** | Pulls the published GHCR image; never builds |
| `compose.yaml` | Self-building, local development, and testing | Builds the server from source |

Both bring up PostgreSQL, the collaboration server, and a Caddy gateway, share
the same `.env` configuration, and use the same persistent volumes.

#### Run a published release (recommended)

`docker-compose.yml` is self-contained: the only file you need beside it is a
`.env`. The Caddy gateway config is embedded inline, and the backup/restore
helpers are baked into the published image, so there are no host bind mounts to
provide. Download just `docker-compose.yml` (and `.env.example` for reference),
then:

```bash
# Create .env with at least a strong POSTGRES_PASSWORD, e.g.:
#   POSTGRES_PASSWORD=replace-with-a-long-random-password
docker compose -f docker-compose.yml up -d
```

This pulls `ghcr.io/azazel55605/collab-server:latest`. For production, pin an
exact version in `.env` so upgrades are deliberate:

```bash
# .env
COLLAB_SERVER_IMAGE=ghcr.io/azazel55605/collab-server:0.4.8
```

Upgrade later by bumping that tag and re-pulling:

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

#### Build from source (development / testing)

```bash
docker compose up --build --wait
```

The source image uses `cargo-chef` to cache Rust dependencies, and the admin-web
image stage caches JavaScript dependency installation separately from source
changes.

#### Access, networking, and lifecycle

The gateway listens on port `8788` on all host interfaces by default:

- Admin interface: `http://<server-address>:8788/` (redirects to `/admin/`)
- Liveness: `http://127.0.0.1:8788/health/live`
- Readiness: `http://127.0.0.1:8788/health/ready`

On first launch, open the admin interface to bootstrap the initial
administrator account.

Set `COLLAB_HTTP_BIND=127.0.0.1` to keep the gateway local-only. Public
deployments should place the gateway behind HTTPS and set
`COLLAB_BROWSER_SECURE_COOKIES=true`; see
[docs/server/tls-and-secrets.md](./docs/server/tls-and-secrets.md) and
`deploy/Caddyfile.tls.example`.

Automated backups are available through the optional `backup` profile (and
restore through the `restore` profile); see
[docs/server/backups.md](./docs/server/backups.md).

Stop the containers while preserving data (add `-f docker-compose.yml` for the
release stack):

```bash
docker compose down
```

Delete the containers and their persistent volumes:

```bash
docker compose down --volumes
```

### Flatpak

Build the local Flatpak package:

```bash
./flatpak/build-local.sh
```

### Verification

Run the full project verification set:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm admin:test
pnpm admin:build
cargo test --workspace
cargo check --workspace
docker compose config
./scripts/server-smoke.sh
```

The live PostgreSQL server tests require a disposable database:

```bash
COLLAB_TEST_DATABASE_URL=postgres://collab:password@127.0.0.1:5432/collab_test \
  cargo test -p collab-server
```

The authentication lifecycle test truncates the Phase 2 identity tables, so do
not point it at a database containing valuable data.

## Security Advisories

Dependencies are scanned in CI by the `Security Scan` workflow
(`cargo audit`, `pnpm audit`, and Trivy over the server image). Any advisory
that cannot yet be fixed by an upgrade is an explicit, documented risk
acceptance rather than a silent suppression: the machine-readable ignore list
lives in [`.cargo/audit.toml`](./.cargo/audit.toml), and every entry there has a
matching explanation — dependency path, why it is not reachable, why it is
unfixed, and the condition to drop it — in
[docs/build/security-advisories.md](./docs/build/security-advisories.md).

Currently accepted: `RUSTSEC-2023-0071` (`rsa`, reachable only through the
unused MySQL backend) and `RUSTSEC-2026-0194` / `RUSTSEC-2026-0195` (`quick-xml`,
build-time macOS bundling only, blocked on an upstream `plist` release).
Non-failing `unmaintained`/`unsound` warnings are tracked in the doc but are
deliberately kept out of the ignore list. Keep the tracking doc in sync whenever
`.cargo/audit.toml` changes.

## Useful Documents

### Project And Contribution Guides

- [Documentation index](./docs/README.md) - plans, archived work, and platform/build documentation
- [Open development work](./docs/plans/open-development-work.md) - consolidated status and remaining work across active, testing, planned, and deferred projects
- [Rust crate boundary refactor](./docs/plans/rust-crate-boundary-refactor-plan.md) - phased extraction of portable Rust domains from server and Tauri adapters
- [Security advisory tracking](./docs/build/security-advisories.md) - accepted/ignored dependency advisories and why they are unresolved

### Collaboration Server

- [Server architecture index](./docs/server/README.md) - entry point for server architecture documents
- [Server development and Compose](./docs/server/development.md) - local operation, configuration, and verification
- [Deployment topology and upgrade compatibility](./docs/server/deployment-topology.md) - supported topology, sizing, and upgrade rules
- [Server backups](./docs/server/backups.md) - Compose backup worker, manual backup, retention, and artifact layout
- [Upgrade and failed-migration recovery](./docs/server/upgrade-recovery.md) - preflight backup, migration-state capture, and rollback procedure
- [TLS, security headers, and secret rotation](./docs/server/tls-and-secrets.md) - HTTPS deployment, gateway hardening, and credential/session rotation
- [Dependency and container vulnerability scanning](./docs/server/vulnerability-scanning.md) - local and CI scans for dependencies and server images
- [Load testing](./docs/server/load-testing.md) - capacity/rate-limit load test harness and results template
- [Release security review](./docs/server/security-review.md) - threat-model coverage, findings, and sign-off
- [Multi-architecture server images](./docs/server/container-images.md) - AMD64/ARM64 Buildx builds and CI artifacts
- [Admin web interface](./docs/server/admin-web.md) - scope, security model, and testing expectations
- [REST and WebSocket protocol](./docs/server/protocol.md) - versioned API and synchronization contracts
- [Hosted vault domain model](./docs/server/hosted-vault-domain.md) - identities, permissions, revisions, and vault structure
- [Security, operations, and compatibility](./docs/server/security-operations.md) - threat model, migrations, secrets, and backups
- [Workspace and verification](./docs/server/workspace-verification.md) - crate boundaries and acceptance checks

### Packaging And Installation

- [Versioning and releases](./docs/build/versioning-and-releases.md)
- [Mobile companion docs](./docs/mobile/README.md)
- [Linux installation](./docs/build/linux-install.md)
- [macOS installation](./docs/build/macos-install.md) - unsigned Apple Silicon build and the Gatekeeper workaround
- [Flatpak guide](./docs/build/flatpak.md)

## Notes For Contributors

- Frontend code should go through typed wrappers in `src/lib/tauri.ts` instead of calling Tauri plugins directly from components
- Paths crossing the IPC boundary are relative to the vault root
- Normal file listing/indexing excludes `.collab/` and generated dependency/build directories
- `write_note` uses optimistic locking via `expected_hash`
- Shared document-style viewers should follow the `DocumentTopBar` pattern
