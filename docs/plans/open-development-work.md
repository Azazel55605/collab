# Open Development Work

Last reviewed: 2026-10-07

This is the entry point for unfinished Collab projects. Detailed requirements,
implementation notes, and acceptance criteria remain in their canonical plan
documents; this file summarizes what is still necessary and prevents completed
work from being mistaken for an active roadmap item.

## Status Vocabulary

- **In progress**: implementation is actively incomplete.
- **Testing**: implementation exists, but a stated validation gate remains.
- **Not started**: accepted work with a defined plan and no implementation yet.
- **Planned**: intended follow-on work whose implementation has not begun.
- **Deferred**: intentionally outside the current delivery sequence.
- **Ideas only**: product exploration, not a committed implementation plan.
- **Recurring**: an operational or release gate that never becomes permanently
  complete.

## Open Project Summary

| Project                           | Current status                     | Remaining work                                                                                                                                                                                                                                                                                                                                             | Canonical document                                                                                                                        |
| --------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Advanced Tables                   | Testing                            | Build the native `.sheet` domain, desktop editor, formulas, data tools, hosted collaboration, mobile experience, and final bounded XLSX/CSV conversion phase.                                                                                                                                                                                              | [Advanced Tables Plan](./advanced-tables-plan.md)                                                                                         |
| Teams, chats and shared libraries | In progress                        | Shared chat foundations and Android vault chat are under validation. Next: authenticated browser libraries, direct/group conversations and unread, admin-created teams/channels and library ownership; ACLs/sharing follow.                                                                                                                                | [Teams, Chats, And Shared File Libraries](./teams-chat-and-file-sharing-plan.md)                                                          |
| Full mobile app                   | Planned / baseline release testing | Deliver independent Android local vaults, common document adapters, touch authoring, file/preview workflows, platform integration and later text collaboration. Existing companion Phase 7 device/release checks remain prerequisites and recurring gates.                                                                                                 | [Full Mobile App Overhaul](./mobile-full-app-plan.md), [Companion Baseline](./android-companion-app-plan.md)                              |
| Electronic circuit simulation     | In progress / planned              | Finish remaining schema/runtime details and AC integration, then mixed-signal simulation, derived-result caching/collaboration policy, numerical hardening, and release validation.                                                                                                                                                                        | [Electronic Circuit Simulation Plan](./electronic-circuit-simulation-plan.md)                                                             |
| Logic and circuit diagram editor  | In progress umbrella               | Phases 0-5.1 are complete. Phase 6 is the circuit-simulation program above and should not be counted as a separate implementation stream.                                                                                                                                                                                                                  | [Logic And Circuit Diagram Editor Plan](./logic-circuit-diagram-plan.md)                                                                  |
| User calendar                     | Testing                            | Complete the Phase 9 maintained external-client CalDAV interoperability matrix. Cross-location mirroring, hardening/restore drills, and notification delivery are complete.                                                                                                                                                                                | [User Calendar Feature Plan](./user-calendar-feature-plan.md)                                                                             |
| Collab Presentations              | Phase 10 testing                   | Phases 0-10 are implemented, including bounded accessibility semantics/audits, heterogeneous performance and malformed-file gates, recovery/CRDT soak coverage, and a release-validation matrix. Physical platform, screen-reader, package, crash/encryption/history/resource-soak, Android, PowerPoint, Google Slides, and Keynote evidence remains open. | [Collab Presentations Plan](./presentation-tool-plan.md), [Release Validation](../build/presentation-release-validation.md)               |
| Digital ink and annotation        | Phase 10 testing                   | Phase 10 code and automated hardening are implemented. Complete the physical platform/input/accessibility/resource matrix and multi-client release soak before sign-off.                                                                                                                                                                                   | [Digital Ink And Annotation Plan](./digital-ink-and-annotation-plan.md), [Release Validation](../build/digital-ink-release-validation.md) |
| Flatpak distribution              | Planned                            | Choose self-hosted Flatpak versus direct Flathub, remove build-time network dependence for Flathub, audit permissions, add publishing/signing, and write public-channel installation docs.                                                                                                                                                                 | [Flatpak Distribution Plan](./flatpak-distribution-plan.md)                                                                               |

### Completed Accounts And Collaboration Expansion

Accounts and the original internal-preview delivery are complete and
[archived](../archive/accounts-and-previews-plan.md), including desktop and
Android server profile editing. Admin-issued password reset links are also
implemented. Native picker/lifecycle checks remain recurring release gates.

- **Testing**: shared cursor-based vault chat, send permissions, idempotent
  retries, native encrypted outbox and Android chat UI. Physical lifecycle and
  Keystore evidence remains a release gate.
- **Not started**: authenticated browser libraries, direct/group conversations,
  unread/notifications, admin-created teams and channel/library ownership.
- **Planned**: folder/file ACLs and authenticated share links. Anonymous guests,
  document workflows and voice/video remain **Deferred**.

The expansion sequence and open product decisions are in
[Teams, Chats, And Shared File Libraries](./teams-chat-and-file-sharing-plan.md).
Mobile delivery uses that shared model through the new full-app plan.

### Document Preview Expansion

**Planned**, outside the completed original preview scope:

1. Measure cold/warm generation, transfer, memory and Android timings against
   maintained fixtures before setting production budgets or claiming speedups.
2. Add scene-faithful deck/ink/worksheet thumbnails in bounded workers, retaining
   summaries as fallback. Do not execute document scripts or fetch arbitrary URLs.
3. Add server PDF/resized-image generation with explicit decoder dependencies,
   process isolation, time/memory limits and deployment validation.
4. Add conditional responses and bounded account-scoped client caching.
   Authorization, offline-copy permissions, logout and replica removal govern
   access and retention; cached content must not bypass permission denial.
5. Add Android file-list previews and optional generation after committed
   revisions, without eagerly rendering entire vaults. The Android portion is
   owned by [mobile Phase 3](./mobile-full-app-plan.md#phase-3--file-workflows-and-previews).

The archived account/preview contract remains the implemented baseline; fuller
rendering and server PDF/image support have not shipped through this plan.

## Recommended Dependency Order

1. Deliver the teams/chat/library shared contracts before the full mobile
   overhaul consumes them. Carry forward the Android lifecycle/release matrix;
   local-vault Phase 0 follows this collaboration foundation.
2. Route future server/native feed, map, webhook, or preview integrations
   through the completed shared outbound-network policy.
3. Complete the calendar Phase 9 maintained external-client interoperability
   matrix.

Circuit simulation and Flatpak distribution can proceed independently, subject
to normal release and platform capacity.

Advanced Tables is also an independent product stream. Its Phase 0 technical
proof should precede any editor implementation because formula-engine,
virtualization, and licensing choices determine the feasible workbook limits.

Collab Presentations is in Phase 10 release testing. The native `.deck` domain,
desktop editor, presentation mode, collaboration, Android viewing, export,
animation, accessibility semantics, and automated hardening are implemented.
The remaining gate is the physical platform, assistive-technology, package,
third-party application, recovery, security, and resource-soak matrix in the
[Presentation Release Validation](../build/presentation-release-validation.md).

Digital Ink and Annotation is a planned cross-platform product stream. Its
Phase 0 must prove real pen/tablet input, bounded low-latency stroke rendering,
and deterministic vector/raster export. The standalone `.ink` editor should be
implemented before existing PDF and image annotations migrate to its shared
engine.

## Project Details

### Full Mobile App

The source audit is complete; overhaul implementation has not begun. The
[full-app plan](./mobile-full-app-plan.md) owns the delivery sequence:

- Phases 0-2, **Not started**: contracts/device proof, standalone local vaults,
  backup/recovery, and migration of existing editors. This is the first release
  milestone; a server must be optional.
- Phases 3-4, **Planned**: file organization/search/recovery, Android previews and
  touch authoring depth, delivered as separate editor projects.
- Phase 5, **Planned**: text collaboration using the teams/chat server plan.
- Phase 6, **Planned / recurring release gates**: Android file integration,
  accessibility/tablet behavior, migrations, device evidence and distribution.
- iOS, **Deferred discovery**: separate feasibility and release plan required.

The old companion Phase 7 remains **Testing / release work** for lifecycle,
signing, reproducible packaging, error handling and public reverse proxies;
carry its unfinished evidence into the new release matrix. The old Phase 8
expansion bucket is superseded, not an additional implementation stream.
Background sync, notification delivery and widgets remain implemented and
archived; their physical device/release matrices must still be maintained.

### Advanced Tables

Open tracker entries:

- Phases 0-2, **Complete**: the `.sheet` schema, bounded formula boundary,
  document domain, virtualized desktop editor, and normal vault lifecycle are
  implemented.
- Phases 3-9, **Testing**: formulas, spreadsheet interactions, data tools,
  hosted/offline collaboration, charts/analysis, Collab references, note
  embeds, snapshot data connections, the mobile workbook experience, and
  release hardening are implemented and remain under integration and physical
  multi-client testing. Phase 8's remaining gate is large-sheet memory and
  process-recreation validation on physical Android devices. Phase 9's
  remaining gate is filling in the Windows, macOS, and Android rows of
  [Advanced Tables Release Validation](../build/advanced-tables-release-validation.md)
  from real runs on those platforms.
- Phase 10, **Testing**: bounded native `.xlsx`/`.csv` import into a new
  `.sheet`, `.xlsx`/`.csv` export, honest conversion reports, and CSV
  formula-injection protection are implemented, with the support matrix
  published in
  [`.sheet` Conversion Support Matrix](../desktop/sheet-conversion.md).
  External formats remain conversion targets rather than live or losslessly
  compatible document models. The remaining gate is validating conversion
  against files produced by Excel, LibreOffice, Google Sheets, and Numbers.

### Collab Presentations

Open tracker entries:

- Phase 0, **Testing**: the `.deck` schema, units, and limits are frozen, and
  shared scene rendering, text layout, same-text-box live collaboration, the
  Lexical evaluation, PDF/image output, and PowerPoint export are proven — see
  the [Phase 0 Contract](./presentation-phase0-contract.md). Open: the text
  probe in the Linux (WebKitGTK), Windows, and Android app WebViews, and the
  exported fixture in PowerPoint and Google Slides.
- Phase 1, **Complete**: `.deck` is an ordinary local and hosted vault document
  — creation, validation on client and server, references, history, sessions,
  view state, and a display-and-navigate `DeckView`.
- Phase 2, **Complete**: the desktop scene editor — slide rail, stage zoom and
  pan, selection and transforms, crop, grouping, ordering, alignment,
  snapping, rulers, keyboard, clipboard, and bounded undo/redo.
- Phase 3, **Complete**: in-place rich-text editing with a toolbar, lists,
  links, spacing, auto-fit, font-fallback display, and CJK line breaking;
  placeholder prompts, overrides, reset, and layout switching; theme editing;
  the master and layout editor; speaker-notes editing; and four built-in
  designs as ordinary deck content.
- Phase 4, **Complete**: the full shape gallery, lines with arrowheads and
  endpoint editing, images (vault, file, paste, drop), editable tables,
  charts with explicit `.sheet` range snapshots and refresh, linked-document
  previews, and stable slide exports for notes.
- Phase 5, **Complete**: slide show and presenter view (notes, timer, next
  slide, display choice, recovery when the audience window is lost), ink,
  laser, and blank screens that never change the deck unless kept, PDF with
  a searchable text layer, handouts with notes, slide images, and print.
- Phase 6, **Complete**: live hosted editing through `LiveDocumentKind::Deck`
  with a deck codec shared by desktop and server (rich text as `Y.Text`,
  atomic geometry, order repair), draft rebasing for two people in one text
  box, presence on slides and objects, viewers following live, and offline
  edits through the shared replica.
- Phase 7, **Complete**: compatible PowerPoint export through a first-party
  OOXML writer in a worker, with masters and layouts, the deck theme, groups,
  fields, native charts and tables, formatted notes, an export report, and a
  LibreOffice visual comparison. PowerPoint and Google Slides checks remain
  release validation items.
- Phase 8, **Complete except physical-device release checks**: Android viewing,
  presentation, following, and opted-in phone remote control are implemented;
  remotely enabled shows are discovered app-wide through a same-account
  floating bubble and route directly into the matching deck and remote.
  Same-LAN WebRTC control now carries commands and a calibrated Android motion
  laser directly when possible, with awareness relay fallback. Presentation
  settings persist defaults and opt-ins, and a phone may start a deck already
  open on a specifically targeted, opted-in desktop. Physical multi-vendor
  sensor and network-topology evidence remains open.
- Phase 9, **Complete**: bounded slide transitions and object animation
  timelines are authored and played across the main and audience windows;
  PowerPoint exports the compatible transition subset and reports animation
  omissions.
- Phase 10, **Testing**: automated performance, malformed-file, accessibility,
  recovery, and collaboration hardening is implemented. Complete the physical
  platform, assistive-technology, packaging, encryption/history/crash, resource
  soak, and third-party application matrix in
  [Presentation Release Validation](../build/presentation-release-validation.md).
- General-release hardening Phase 1, **Complete**: the formatting row no longer
  moves the canvas when selection changes, blank-canvas arrow navigation is
  focusable, resolved fonts gain bundled/platform fallbacks, and native
  fullscreen presentation fits the generated playback SVG through its animation
  wrapper. Multi-monitor behavior remains in the physical release matrix.
- General-release hardening Phase 2, **Complete**: a first click edits text
  boxes with keyboard focus retained by the in-place editor, object builds have
  a dedicated automatic/click-step animation tree, and playback accepts 36
  PowerPoint-aligned entrance, emphasis, and exit effects. PPTX export continues
  to report object animations as omitted until that interchange subset is
  implemented and validated.
- Phase 11, **Deferred**: bounded PPTX import into a new `.deck`; import is not
  required for the first production release.

### Digital Ink And Annotation

Open tracker entries:

- Phases 0-5, **Complete**: the frozen schema/input contract, physical device
  validation, shared ink domain, first-class New Drawing lifecycle,
  desktop/mobile editors, and advanced tools.
- Phases 6-7, **Complete**: hosted/offline collaboration and source-linked,
  deterministic PNG/SVG/PDF export.
- Phases 8-9, **Complete**: PDF and image annotations use the shared engine,
  including capability-driven anchored-view adapters, hosted/offline
  persistence, and explicit flattened-copy export.
- Phase 10, **Testing**: accessibility and targeted-rendering changes plus the
  automated malformed-content, scale, recovery, and CRDT soak gates are in;
  physical platform/input/resource evidence remains the release blocker.
- Phase 11, **Deferred after evaluation**: handwriting/math recognition has no
  suitable cross-platform offline engine, and bounded InkML interchange is not
  required for 0.8.0. Revisit only in response to concrete demand.

### Electronic Circuit Simulation

Open tracker entries:

- Phase 6.1, **In progress**: reconcile the tracker with the electrical model
  capabilities already implemented and finish any remaining document-model
  acceptance work.
- Phase 6.4, **In progress**: finish runtime integration details, including any
  progress behavior still deferred by the current polling model.
- Phase 6.6, **In progress**: nonlinear DC-bias small-signal linearization,
  retained native AC jobs, persisted analysis configuration, transfer-function
  normalization, and Bode UI.
- Phase 6.7, **Planned**: mixed-signal bridges and deterministic scheduling.
- Phase 6.8, **Planned**: local derived-result caching and collaboration rules.
- Phase 6.9, **Planned**: numerical hardening, stress/fixture coverage, platform
  budgets, documentation, and release gates.

The logic-editor plan's Phase 6 points to this same workstream.

### User Calendar

Open tracker entries:

- Phase 9, **Testing**: hosted discovery, collection/report/sync-token support,
  ETag-guarded resources, shared operation-log writes, recurrence resources, and
  revocable app passwords are implemented. DAVx5, Thunderbird, Apple Calendar,
  and one additional maintained client still require interoperability testing.

### Flatpak Distribution

The local Flatpak build is a working packaging baseline. Public distribution is
unfinished. Resume by choosing the target channel, then update the plan with a
status tracker once that decision has been made.

## Completed Plans

These documents are retained for architecture and implementation history but
have no open tracked phases:

- [Document Session And Collaboration Stability Plan](../archive/document-session-collaboration-plan.md)
- [Background Running Plan](../archive/background-running-plan.md)
- [Background Running Phase 0 Contract](../archive/background-running-phase0-contract.md)
- [Notification System Plan](../archive/notification-system-plan.md)
- [Notification System Phase 0 Contract](../archive/notification-system-phase0-contract.md)
- [OCR Implementation Plan](../archive/ocr-implementation-plan.md)
- [Rust Crate Boundary Refactor Plan](../archive/rust-crate-boundary-refactor-plan.md)
- [Rust Crate Boundary Phase 0 Baseline](../archive/rust-crate-boundary-phase0-baseline.md)

The logic editor's completed phases remain documented in its plan, while its
only open phase is represented by the circuit-simulation workstream above.

## Recurring Maintenance

The following are ongoing release/operations work rather than finite feature
projects:

- [Security Advisory Tracking](../build/security-advisories.md): accepted dependency
  advisories and removal conditions.
- [Release Security Review](../server/security-review.md): repeat before releases
  and after high-risk server changes.
- [Versioning And Releases](../build/versioning-and-releases.md): release-channel and
  version-alignment procedure.

## Keeping This Index Current

When a project phase changes:

1. Update the canonical plan's progress tracker first.
2. Update the matching summary and remaining-work text here.
3. Move fully completed plans to the completed section.
4. Do not list incidental `TODO` comments or speculative ideas as committed
   projects.
5. Review this document as part of release preparation.
