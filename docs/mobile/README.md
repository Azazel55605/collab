# Mobile Companion Docs

The Android companion is a hosted-vault companion client. It shares the native
hosted session, replica, and sync boundaries with the desktop client, but uses a
separate mobile React shell under `apps/mobile-android`.

## Start Here

- [Android companion plan](../plans/android-companion-app-plan.md) — product scope,
  phase status, implementation notes, and remaining mobile work.
- [Android companion build](./android-companion-build.md) — local SDK/JDK/NDK
  setup, debug builds, APK builds, and troubleshooting.
- [Android Play release](./android-play-release.md) — upload keystore, AAB
  signing, Play Console rollout, policy checklist, and the launcher-widget
  declarations, backup behaviour, and privacy disclosures Play needs.
- [Background running release validation](../build/background-running-release-validation.md)
  — WorkManager limitations, device matrix, diagnostics, and troubleshooting.
- [Mobile widgets release validation](../build/mobile-widgets-release-validation.md)
  — the eight launcher widgets: platform limitations, the physical and launcher
  matrix, and the release gates. Re-run per release.
- [Mobile widgets integration plan](../archive/mobile-widgets-plan.md) —
  archived. Delivered scope, the native snapshot boundary, and the phase history
  behind the shipped widgets.
- [Mobile widget ideas](../archive/mobile-widget-ideas.md) — archived. The
  original evaluated catalog, retained as design context should iOS widgets
  ever be picked up.
- [Versioning and releases](../build/versioning-and-releases.md) — how the mobile
  `versionName` and Play `versionCode` are decoupled from desktop, server, and
  admin-web versions.

## Current Boundaries

- Mobile supports hosted server login/session restore, hosted vault browsing,
  offline copies, notes, Kanban, queued offline edits, reconnect sync replay, and
  mobile live-session plumbing for supported text documents.
- Hosted CalDAV clients write through the server's normal calendar operation
  log, so external changes reach Android through the existing hosted-calendar
  delta sync. Android does not store CalDAV app passwords; credential setup and
  revocation currently live in the desktop Calendar view.
- Calendar synchronization has deterministic repeated disconnect/reconnect
  coverage across two independent hosted locations. Multi-day Android
  background/lifecycle validation on physical devices remains a Phase 10
  release gate and is not replaced by the in-process soak test.
- Mobile does not support local filesystem vaults, desktop-style workspaces,
  native file drag/drop, full rich-file editing, or admin-web workflows.
- Android-native behavior that must survive project regeneration is documented
  in [Android companion build](./android-companion-build.md), including
  `MainActivity.kt`, Android Keystore-backed token/replica secret storage, and
  Play signing/version wiring.
