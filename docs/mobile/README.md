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
  signing, Play Console rollout, and policy checklist.
- [Versioning and releases](../build/versioning-and-releases.md) — how the mobile
  `versionName` and Play `versionCode` are decoupled from desktop, server, and
  admin-web versions.

## Current Boundaries

- Mobile supports hosted server login/session restore, hosted vault browsing,
  offline copies, notes, Kanban, queued offline edits, reconnect sync replay, and
  mobile live-session plumbing for supported text documents.
- Mobile does not support local filesystem vaults, desktop-style workspaces,
  native file drag/drop, full rich-file editing, or admin-web workflows.
- Android-native behavior that must survive project regeneration is documented
  in [Android companion build](./android-companion-build.md), including
  `MainActivity.kt`, Android Keystore-backed token/replica secret storage, and
  Play signing/version wiring.
