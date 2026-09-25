# Standalone Full Mobile App Assessment

## Decision Summary

Turning the Android companion into a server-independent Collab app is feasible
without replacing Tauri or rewriting the current mobile shell. The native
desktop vault and file commands are already registered in the Android binary,
and the mobile app already has editable notes, Kanban boards, bounded
spreadsheets, ink drawings, calendars, and parts of circuit editing.

The main obstacle is not document rendering. It is that mobile navigation,
identity, persistence, offline queues, and every save path currently assume a
hosted vault identified by `serverUrl + vaultId` and files identified by server
UUIDs. A standalone app needs a first-class local-vault adapter rather than
pretending an offline replica is a local vault.

Recommended direction:

1. Add app-private local vaults first.
2. Put local and hosted vaults behind one mobile `VaultClient` interface.
3. Reuse the existing Rust local-vault commands and shared document libraries.
4. Add Android Storage Access Framework import/export after app-private storage
   is reliable; do not use a long-lived arbitrary filesystem path as the core
   storage model.
5. Treat desktop feature parity as a sequence of editor projects, not as part of
   the local-storage milestone.

## What Can Be Reused

| Existing area                     | Current state                                                                                                                               | Reuse value                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Tauri Android shell               | Shipping mobile-specific React entrypoint and Android packaging                                                                             | Keep unchanged                                                   |
| Native local vault/file commands  | Vault creation/open, file listing, reads/writes, folders, trash, references, sidecars, OCR, and export are registered in the Android binary | High, after Android path/config fixes                            |
| Hosted replica                    | Durable cache and pending-operation queue keyed by server and vault                                                                         | Keep for hosted vaults; do not make it the local source of truth |
| Notes and Kanban                  | Editable online/offline mobile screens                                                                                                      | Replace hosted save calls with the shared client boundary        |
| `.sheet` and `.ink`               | Editable mobile screens using shared document logic                                                                                         | Replace hosted load/save calls; retain mobile-specific UI        |
| Logic/circuit view                | Real renderer plus bounded electrical-property and analysis editing                                                                         | Extend incrementally                                             |
| PDF/image/canvas                  | Mobile viewers, cached asset loading, PDF navigation, and canvas rendering                                                                  | Add editing on top of current viewers                            |
| Calendar/notifications/background | Already local profile stores with hosted synchronization adapters                                                                           | Mostly independent today                                         |

## Required Architecture Work

### 1. Mobile vault abstraction

Introduce a mobile-facing interface with local and hosted implementations:

```text
MobileVaultClient
  listFiles / readDocument / readAsset
  createDocument / writeDocument / import / export
  trash / restore / references / history
  capabilities / readOnly / liveSession(optional)
```

Screens must stop accepting `serverUrl`, hosted capabilities, and
`HostedFileEntry` directly. Use a common file identity containing a stable
client key, relative path, kind, version, and optional hosted ID. Live sessions
and replay queues remain optional hosted capabilities.

### 2. Android-safe local vault lifecycle

The desktop vault backend currently stores recents through desktop environment
variables and assumes ordinary filesystem paths. Android needs commands that:

- create app-private vaults below `app_data_dir`;
- persist the vault catalog below the app configuration/data directory;
- open, rename, duplicate, archive, and delete those vaults safely;
- support encrypted-vault unlock with keys held in Android Keystore-backed
  storage;
- expose ZIP export/import and explicit backup/restore;
- optionally import/export through Storage Access Framework `content://` URIs.

App-private storage should be authoritative. A picked document-tree URI can be
an import/export or later synchronization target, but making it the primary
vault introduces revocable URI permissions, provider-specific rename semantics,
and non-atomic writes.

### 3. Local save/session adapter

Local documents do not need WebSockets, server capabilities, replica cache
warming, or pending hosted operations. They do need the existing optimistic
hash/version behavior, conflict handling, autosave status, crash-safe writes,
history, trash, and sidecars. Extract these concerns from each screen into
shared mobile document-session hooks backed by `MobileVaultClient`.

### 4. Search, indexing, and file operations

The hosted server currently provides manifest identity and some server-side
operations. Local mobile vaults need bounded native search/indexing, reference
lookup, rename/move previews, duplicate, trash, import, export, and asset
handling. Most Rust behavior exists, but the mobile UI and app-private path
boundary do not.

### 5. Feature-parity editor work

Standalone operation and full desktop parity are different milestones.
Remaining substantial mobile UI includes:

- full Canvas editing and node inspectors;
- full logic/schematic construction, not only selected circuit properties;
- PDF highlights, comments, ink annotations, OCR controls, and annotated export;
- image additive/permanent editing and annotation sidecars;
- SVG vector editing;
- full spreadsheet structure, charts, protection, conversion, and data tools;
- desktop-level ink object/layer/page/export tools;
- richer note authoring integrations, references, snippets, and export;
- local history/recovery and cross-vault workflows;
- settings parity and accessibility/large-tablet layouts.

The desktop shell itself should not be ported. Phone and tablet editors should
continue using mobile navigation, sheets, touch targets, and bounded rendering.

## Suggested Delivery Plan

| Stage                        | Deliverable                                                                          | Rough effort |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| 0. Contract                  | Freeze common vault/file/session interfaces and local identity rules                 | 1-2 weeks    |
| 1. Local vault core          | App-private create/open, catalog, local file browser, notes, import/export, backup   | 4-7 weeks    |
| 2. Existing editor migration | Local save paths for Kanban, sheet, ink, logic, assets; trash/history/references     | 4-7 weeks    |
| 3. Standalone hardening      | Encryption, crash recovery, storage pressure, backup/restore, physical-device matrix | 3-6 weeks    |
| 4. Rich editor parity        | Canvas, PDF/image annotations, SVG, broader logic/sheet/ink/note features            | 3-6 months   |
| 5. Release hardening         | Tablet layouts, accessibility, performance, migration and store-release QA           | 4-8 weeks    |

A useful server-independent mobile release is therefore approximately **8-14
engineering weeks** before extended device testing. Broad desktop-equivalent
feature parity is closer to **5-9 engineer-months**, depending on how much of the
desktop editor depth is required on phones. These are engineering estimates,
not release commitments.

## Highest Risks

- Android document providers do not behave like ordinary filesystems.
- A local-vault catalog and encryption keys must survive process death without
  leaking material into the WebView.
- Refactoring existing hosted screens can regress proven offline/replay paths if
  the common interface erases hosted-specific states.
- Large PDFs, canvases, sheets, and ink documents require mobile-specific
  budgets even when the desktop implementation is shared.
- Full desktop controls transferred directly to a phone would technically add
  features while producing an unusable editor.

## Recommended Next Decision

Approve only the **local vault core** first. Its acceptance test should be:

1. Create an app-private vault without configuring a server.
2. Create, close, reopen, edit, rename, trash, restore, export, and re-import a
   note, board, sheet, and drawing.
3. Survive process death and device restart.
4. Open the same hosted vaults as before without changing their replica or live
   collaboration behavior.

Once that boundary is stable, each rich editor can be prioritized from actual
mobile usage rather than bundled into one high-risk rewrite.
