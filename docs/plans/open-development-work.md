# Open Development Work

Last reviewed: 2026-08-13

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

| Project | Current status | Remaining work | Canonical document |
| --- | --- | --- | --- |
| Advanced Tables | Testing | Build the native `.sheet` domain, desktop editor, formulas, data tools, hosted collaboration, mobile experience, and final bounded XLSX/CSV conversion phase. | [Advanced Tables Plan](./advanced-tables-plan.md) |
| Android companion app | In progress / deferred expansion | Finish Phase 7 device lifecycle QA, signing, release packaging, and operational documentation. Phase 8 remains a deferred expansion bucket; background execution has its own active plan and the notification system is complete. | [Android Companion App Plan](./android-companion-app-plan.md) |
| Electronic circuit simulation | In progress / planned | Finish remaining schema/runtime details and AC integration, then mixed-signal simulation, derived-result caching/collaboration policy, numerical hardening, and release validation. | [Electronic Circuit Simulation Plan](./electronic-circuit-simulation-plan.md) |
| Logic and circuit diagram editor | In progress umbrella | Phases 0-5.1 are complete. Phase 6 is the circuit-simulation program above and should not be counted as a separate implementation stream. | [Logic And Circuit Diagram Editor Plan](./logic-circuit-diagram-plan.md) |
| User calendar | Testing | Complete the Phase 9 maintained external-client CalDAV interoperability matrix. Cross-location mirroring, hardening/restore drills, and notification delivery are complete. | [User Calendar Feature Plan](./user-calendar-feature-plan.md) |
| Background running | Testing | Phase 5 automated hardening is implemented. Complete the packaged desktop/physical Android matrix, then add notification-backed Android foreground transfers. | [Background Running Plan](./background-running-plan.md) |
| Collab Presentations | Planned | Complete the `.deck` Phase 0 proofs for scene/text fidelity, deck-specific live text collaboration, and compatible PPTX export before beginning the editor. | [Collab Presentations Plan](./presentation-tool-plan.md) |
| Digital ink and annotation | Phases 0-3 complete, device gate open | The `.ink` contract, shared domain, vault lifecycle, and desktop editor are done: pressure-sensitive brushes, three erasers, selection and transforms, layers, pages, clipboard, undo/redo, and autosave. Run `tools/ink-input-probe.html` on real pens and tablets to close the Phase 0 device gate — it also gates the Phase 3 hardware validation and the outliner choice. Phase 4 is the mobile and tablet editor. | [Digital Ink And Annotation Plan](./digital-ink-and-annotation-plan.md), [Phase 0 Contract](./digital-ink-phase0-contract.md) |
| Flatpak distribution | Planned | Choose self-hosted Flatpak versus direct Flathub, remove build-time network dependence for Flathub, audit permissions, add publishing/signing, and write public-channel installation docs. | [Flatpak Distribution Plan](./flatpak-distribution-plan.md) |

## Recommended Dependency Order

1. Finish Android Phase 7 lifecycle and release validation that does not depend
   on new background behavior.
2. Validate the desktop tray and production Android WorkManager coordinator on
   real target platforms.
3. Route future server/native feed, map, webhook, or preview integrations
   through the completed shared outbound-network policy.
4. Run the packaged desktop and physical Android matrix from the background
   running release-validation guide.
5. Add Android foreground transfer handling using the completed notification
   system's persistent channel and permission flow.
6. Complete the calendar Phase 9 maintained external-client interoperability
   matrix.

Circuit simulation and Flatpak distribution can proceed independently, subject
to normal release and platform capacity.

Advanced Tables is also an independent product stream. Its Phase 0 technical
proof should precede any editor implementation because formula-engine,
virtualization, and licensing choices determine the feasible workbook limits.

Collab Presentations is a planned follow-on product stream. Its Phase 0 must
prove cross-platform text layout, a deck-specific rich-text CRDT representation,
and compatible PPTX export before `.deck` routing or editor implementation.

Digital Ink and Annotation is a planned cross-platform product stream. Its
Phase 0 must prove real pen/tablet input, bounded low-latency stroke rendering,
and deterministic vector/raster export. The standalone `.ink` editor should be
implemented before existing PDF and image annotations migrate to its shared
engine.

## Project Details

### Android Companion App

Open tracker entries:

- Phase 7, **In progress**: lifecycle, device matrix, signing, reproducible
  release packaging, crash/error strategy, and public reverse-proxy validation.
- Phase 8, **Deferred**: richer mobile editing, iOS, capture flows, and other
  post-MVP expansion.

Background sync remains tracked by its cross-platform plan. Push notification
delivery is complete and documented in the archive rather than implemented as
an Android-only fork.

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

- Phase 0, **Not started**: freeze the native `.deck` schema and resource
  limits; prove shared scene rendering, rich-text editing, same-text-box live
  collaboration, and PowerPoint-compatible export.
- Phases 1-7, **Planned**: native vault integration, desktop editing, themes and
  layouts, visual objects, presentation mode, hosted/offline collaboration, and
  compatible PPTX export.
- Phases 8-10, **Planned**: mobile viewing/presentation, bounded animation, and
  release hardening.
- Phase 11, **Deferred**: bounded PPTX import into a new `.deck`; import is not
  required for the first production release.

### Digital Ink And Annotation

Open tracker entries:

- Phase 0, **Not started**: freeze the `.ink` schema and prove pen, touch,
  drawing-tablet, mouse, and touchpad capture plus pressure rendering and
  deterministic export on real desktop and Android hardware.
- Phases 1-7, **Planned**: shared ink domain, first-class New Drawing lifecycle,
  desktop/mobile editors, advanced tools, hosted/offline collaboration, and
  source-linked PNG/SVG/PDF export.
- Phases 8-10, **Planned**: migrate PDF/image annotations to the shared engine,
  extend the anchored annotation contract to other viewers, and complete
  release hardening.
- Phase 11, **Deferred**: optional handwriting/math recognition and InkML
  interchange.

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

### Background Running

Background execution owns bounded scheduling and headless sync. The completed
notification system consumes that foundation but remains independently
documented in the archive. Background running still tracks its own packaged
desktop/physical Android matrix and notification-backed foreground transfers.

### Flatpak Distribution

The local Flatpak build is a working packaging baseline. Public distribution is
unfinished. Resume by choosing the target channel, then update the plan with a
status tracker once that decision has been made.

## Completed Plans

These documents are retained for architecture and implementation history but
have no open tracked phases:

- [Document Session And Collaboration Stability Plan](../archive/document-session-collaboration-plan.md)
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
