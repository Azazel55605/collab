# Standalone Full Mobile App Assessment

Source reviewed: 2026-10-07. The canonical delivery sequence and acceptance
gates now live in the [Full Mobile App Overhaul](../plans/mobile-full-app-plan.md).
This assessment describes the architectural starting point; it does not claim
that independent local vaults or full editor parity are implemented.

## Decision

Keep Tauri and the existing mobile React shell. Android already has editable
notes, Kanban, bounded spreadsheets and ink, local calendars, document viewers,
selected circuit-property/analysis editing, presentation controls, server
profiles, notifications, widgets and background synchronization.

The primary obstacle is that vault navigation, document identity and save paths
assume `serverUrl + vaultId` and server file UUIDs. A durable hosted replica is
not an independent local vault. Standalone operation needs an Android-safe
local-vault lifecycle and a common capability boundary.

## Reuse And Required Work

| Boundary                      | Existing implementation                                                             | Required work                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Mobile shell                  | `MobileApp.tsx`, `state/store.ts`, mobile screens                                   | Source-aware navigation, optional account onboarding, location/file identities                   |
| Vault client                  | Desktop `src/lib/vaultClient.ts` already separates local/hosted capabilities        | Extract portable contracts and provide Android adapters; avoid another incompatible API          |
| Native storage                | Local vault/file commands registered in `src-tauri/src/lib.rs`                      | Audit Android runtime behavior, inject catalog paths, app-private lifecycle, recovery and backup |
| Recents/catalog               | `commands/vault.rs` uses desktop environment paths                                  | Versioned app-data catalog with repair and migration                                             |
| Hosted durability             | Native replica/outbox, authentication and live sessions                             | Preserve server-scoped behavior while local writes use their own authoritative storage           |
| Existing editors              | Notes/boards, sheet values/formulas/formatting, ink strokes and page/layer controls | Common load/save/asset hooks; retain current depth and add missing authoring incrementally       |
| Rich viewers                  | Deck presentation, PDF/image/canvas views, bounded logic editing                    | Touch deck/canvas/SVG/logic construction, annotations, richer export and editing                 |
| Calendar/system               | Local calendar profiles plus hosted adapters, widgets and notifications             | Generalize document attachments/routes and validate local destinations on devices                |
| Files and Android integration | Hosted uploads/downloads and ZIP export; launcher/widget/notification routes        | Local import/export, SAF/provider adapters, document open/share intents and cold-start routing   |

Source paths in the table are relative to the repository; mobile screens live
under `apps/mobile-android/src/`. Command registration alone is not Android
lifecycle evidence. The `.sheet` screen explicitly leaves structural editing,
charts and protection to desktop; ink already has page/layer controls, so its
expansion must build on those rather than recreate them.

## Storage Direction

Use app-private local vaults first, with durable catalog, optimistic hash checks,
crash-safe writes, history, trash, indexing and explicit encrypted backup/restore.
Keep keys and tokens in native storage. Prove restoring a vault on a different
device rather than assuming its original Android Keystore key is available.

Add Storage Access Framework import/export through URI adapters. External
providers have revocable permissions and different operation semantics; they
need a separate proof before serving as authoritative vault storage. Do not
pass `content://` URIs to ordinary filesystem commands.

## Delivery Boundary

The first milestone is standalone use with existing editors: create a vault
without a server, create/edit/reopen notes, boards, sheets and drawings, survive
process death, recover/history/trash, and export/import into another installation.
Hosted permission, offline-replay and live-session behavior must remain intact.

The next milestone adds file workflows and richer phone/tablet authoring. Each
editor needs a support matrix and independent round-trip, recovery, performance
and accessibility evidence. Teams/text chat follows the shared server model;
voice/video remains deferred. iOS requires a separate platform feasibility plan.

The previous rough calendar estimates are retired. Phase 0 of the new plan
must prove storage contracts and physical-device constraints before estimating
implementation schedules. Open status is maintained in
[Open Development Work](../plans/open-development-work.md).
