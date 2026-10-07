# Mobile App Docs

The Android companion is a hosted-vault companion client. It shares the native
hosted session, replica, and sync boundaries with the desktop client, but uses a
separate mobile React shell under `apps/mobile-android`. The standalone Android
expansion is planned; local vaults and full rich-file authoring are not shipped.

## Start Here

- [Full mobile app overhaul](../plans/mobile-full-app-plan.md) — audited gaps,
  local storage architecture, staged editor expansion and acceptance gates.
- [Android companion plan](../plans/android-companion-app-plan.md) — product scope,
  the implemented hosted baseline and outstanding device/release evidence.
- [Standalone full app assessment](./standalone-full-app-assessment.md) — current
  reuse boundary, local-vault architecture, feature gaps and storage risks.
- [Presentation companion](./presentation-companion.md) — viewing, presenting, and
  remote-controlling `.deck` presentations on Android, and its physical-device
  release gate.
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
  offline copies, editable notes/Kanban, bounded sheet/ink editing, queued
  offline edits, reconnect replay and supported live sessions. Rich-file viewing
  includes PDF, image, canvas and logic; logic also has bounded circuit-property
  and analysis editing. Decks support viewing, presenting and remote control.
- Vault chat supports bounded earlier history, reconnect catch-up, read-only
  chat and deliberate retry/discard of native encrypted pending sends. History
  requires online authorization; unsent drafts are private to the original
  server account and can be recovered after reconnect. Teams, group inboxes
  and browser libraries are still planned in the
  [shared collaboration program](../plans/teams-chat-and-file-sharing-plan.md).
- Settings includes server-specific profile, username, password and picture
  editing with a connected-server switch. Local use in the new roadmap must
  remain independent of those accounts.
- Local calendars already exist alongside hosted calendars, notifications,
  widgets and background jobs. Document attachments still need the planned
  local/hosted identity boundary. Hosted file upload/download exists today;
  standalone local vault import/export and general Android share/open routing
  are separate planned additions.
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

## Roadmap Ownership

The teams/chat/library program comes first and supplies shared contracts for
the mobile overhaul. The full-app plan replaces the companion plan's deferred expansion bucket.
Device lifecycle and release checks remain open or recurring in their existing
matrices. The completed [accounts/previews plan](../archive/accounts-and-previews-plan.md)
is archived; optional preview expansion is tracked in
[Open Development Work](../plans/open-development-work.md#document-preview-expansion).
Android comes first; iOS discovery and live voice/video are deferred.
