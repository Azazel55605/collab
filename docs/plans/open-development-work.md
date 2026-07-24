# Open Development Work

Last reviewed: 2026-07-24

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
| Android companion app | In progress / deferred expansion | Finish Phase 7 device lifecycle QA, signing, release packaging, and operational documentation. Phase 8 remains a deferred expansion bucket; background execution and notifications now have dedicated plans. | [Android Companion App Plan](./android-companion-app-plan.md) |
| Electronic circuit simulation | In progress / planned | Finish remaining schema/runtime details and AC integration, then mixed-signal simulation, derived-result caching/collaboration policy, numerical hardening, and release validation. | [Electronic Circuit Simulation Plan](./electronic-circuit-simulation-plan.md) |
| Logic and circuit diagram editor | In progress umbrella | Phases 0-5.1 are complete. Phase 6 is the circuit-simulation program above and should not be counted as a separate implementation stream. | [Logic And Circuit Diagram Editor Plan](./logic-circuit-diagram-plan.md) |
| User calendar | Testing / not started | Complete physical-device validation for cross-location mirroring, then iCalendar import/export/subscriptions, CalDAV, admin privacy/hardening, and native reminder delivery. | [User Calendar Feature Plan](./user-calendar-feature-plan.md) |
| Background running | Not started | Add a shared headless coordinator, desktop tray/autostart lifecycle, Android WorkManager scheduling, persisted progress, power controls, and platform QA. | [Background Running Plan](./background-running-plan.md) |
| Notification system | Not started | Add a shared inbox/scheduler, native desktop and Android delivery, hosted activity invalidations, preferences, privacy controls, and release hardening. | [Notification System Plan](./notification-system-plan.md) |
| Flatpak distribution | Planned | Choose self-hosted Flatpak versus direct Flathub, remove build-time network dependence for Flathub, audit permissions, add publishing/signing, and write public-channel installation docs. | [Flatpak Distribution Plan](./flatpak-distribution-plan.md) |
| Mobile widgets | Ideas only | Evaluate a calendar agenda widget first after background snapshots are available; no implementation commitment or phased schedule exists yet. | [Mobile Widget Ideas](../mobile/mobile-widget-ideas.md) |

## Recommended Dependency Order

1. Finish Android Phase 7 lifecycle and release validation that does not depend
   on new background behavior.
2. Build the shared headless coordinator from the background-running plan.
3. Add desktop tray lifecycle and Android WorkManager scheduling.
4. Activate local calendar reminders through the notification system.
5. Complete calendar Phase 6 physical-device validation, then calendar
   interoperability and hardening phases in product-priority order.
6. Prototype the Android calendar agenda widget using the stable background
   snapshot boundary.

Circuit simulation and Flatpak distribution can proceed independently, subject
to normal release and platform capacity.

## Project Details

### Android Companion App

Open tracker entries:

- Phase 7, **In progress**: lifecycle, device matrix, signing, reproducible
  release packaging, crash/error strategy, and public reverse-proxy validation.
- Phase 8, **Deferred**: richer mobile editing, iOS, capture flows, and other
  post-MVP expansion.

Background sync and push notifications should be delivered through their new
cross-platform plans rather than implemented as Android-only forks.

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

- Phase 6, **Testing**: physical-device end-to-end validation for
  cross-location mirroring.
- Phase 8, **Not started**: `.ics` import/export, subscriptions, publishing,
  deduplication, and bounded refresh.
- Phase 9, **Not started**: CalDAV and external two-way synchronization.
- Phase 10, **Not started**: aggregate-only administration, privacy
  verification, migrations, load, security, and recovery coverage.
- Phase 11, **Not started**: native desktop/Android reminder delivery, now
  detailed in the notification-system plan.

### Background Running And Notifications

These are cross-platform foundations, not mobile-only features. Background
execution owns bounded scheduling and headless sync. Notifications consume
background scheduling and synchronized data but own delivery, preferences,
privacy, and actions. Keeping those responsibilities separate prevents tray,
WorkManager, calendar, and push behavior from becoming one coupled subsystem.

### Flatpak Distribution

The local Flatpak build is a working packaging baseline. Public distribution is
unfinished. Resume by choosing the target channel, then update the plan with a
status tracker once that decision has been made.

## Completed Plans

These documents are retained for architecture and implementation history but
have no open tracked phases:

- [Document Session And Collaboration Stability Plan](../archive/document-session-collaboration-plan.md)
- [OCR Implementation Plan](../archive/ocr-implementation-plan.md)

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
