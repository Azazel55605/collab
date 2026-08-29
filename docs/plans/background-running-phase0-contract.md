# Background Running Phase 0 Contract

## Status

**Testing.** The native desktop and Android proofs compile and the shared Rust
probe passes its unit tests. Real tray behavior still needs validation on Linux,
Windows, and macOS, and the WorkManager bridge still needs a physical Android
device run before Phase 0 can be marked complete.

The original proofs no longer define production behavior. Phase 2 replaced the
desktop probe with the opt-in tray lifecycle, and Phase 3 replaced the debug
Android probe scheduling with the production WorkManager coordinator bridge.
The Phase 0 probe code remains only as a narrow diagnostic and historical
feasibility check.

## Lifecycle Contract

| Condition                | Desktop contract                                                                                                                                    | Android contract                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Main UI hidden           | When background running is later enabled, hide to tray and stop interactive document presence. Bounded native jobs may continue.                    | The activity and webview may be destroyed. Durable work must not depend on either one.                                                         |
| Close                    | Phase 0 keeps close-means-quit. Phase 2 may hide instead only when the user enables background running and chooses that close behavior.             | System Back or task dismissal closes the visible activity; already-enqueued eligible work remains OS-managed.                                  |
| Explicit quit / sign out | Cancel or stop owned jobs, close live sessions, remove the relevant in-memory state, then exit. Sign out also cancels that server's scheduled jobs. | Cancel profile/server work before clearing credentials. Explicit app exit does not promise that unrelated OS-scheduled work runs immediately.  |
| Suspend / Doze           | The OS may freeze the process. Timers are not treated as elapsed execution time; resume requests bounded catch-up.                                  | WorkManager and its constraints decide when work is eligible. Doze and battery policy may defer it.                                            |
| Resume / foreground      | Reconcile the job ledger, refresh stale sessions, and request catch-up without duplicating an active job.                                           | Request unique immediate catch-up and surface persisted failures or authentication requirements.                                               |
| Reboot / login           | No work runs until launch unless the user has explicitly enabled start-at-login.                                                                    | WorkManager persists and reschedules eligible work after reboot. Force-stop is different and blocks work until the user launches Collab again. |
| Application update       | Stop cleanly before replacement. Durable job records must be schema-versioned and recoverable after restart.                                        | WorkManager reconciles persisted requests after package replacement; workers and native ledger formats must remain upgrade compatible.         |
| Process kill / crash     | In-process work stops. The next launch marks abandoned jobs and retries only retryable, idempotent work.                                            | The worker can be recreated by WorkManager. Every operation must be bounded and idempotent because process death can occur at any point.       |
| Uninstall / clear data   | Remove local scheduler state with the application. Server sessions remain revocable server-side.                                                    | Android removes WorkManager state, app-private ledgers, and credentials with application data.                                                 |

[WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent)
is appropriate for persistent, deferrable sync and maintenance, not an
always-running process. Android also gives ordinary workers a bounded execution
window; large user-visible transfers belong in explicit foreground work with a
persistent notification. Repeated scheduling uses
[unique work](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work)
so foregrounding the app cannot create duplicate pending probes or later sync
jobs.

## Implemented Proofs

### Shared Native Probe

`src-tauri/src/commands/background.rs` owns an IO-only probe that:

- runs without `AppHandle`, React, or a webview
- writes `background-phase0-probe.json` under the native app configuration root
- records a bounded trigger, timestamp, process ID, and monotonic run count
- serializes concurrent calls within the process
- is callable through typed Tauri IPC and the Android JNI bridge

This proves that a platform scheduler can enter bounded Rust code directly. The
file is a feasibility ledger, not the production job ledger planned for Phase 1.

### Desktop Tray

The desktop proof adds Tauri's tray feature and a menu with **Open Collab** and
**Quit**. It is created only when `COLLAB_BACKGROUND_PROBE=1`. The main window's
close request still exits explicitly, so this proof cannot silently change the
current product lifecycle.

Manual check:

```bash
COLLAB_BACKGROUND_PROBE=1 pnpm tauri dev
```

Verify that the tray menu restores and focuses the window, **Quit** exits, and
the normal window close still terminates the process.

### Android WorkManager

The original debug build enqueued one uniquely named probe request.
`CollabBackgroundWorker` now supersedes it: Kotlin passes the application
context, trigger, and profile ID to `CollabBackgroundBridge`, which loads
`collab_lib` and runs the production native coordinator without starting
`MainActivity` or constructing a webview. The retained probe JNI entry can still
write the Phase 0 ledger when invoked directly, but app startup no longer
schedules it.

Physical-device check:

```bash
adb logcat -s CollabBackgroundProbe
adb shell run-as com.collab.companion \
  cat files/collab/background-phase0-probe.json
```

Enable background work in mobile Settings, cache a hosted vault, press Home,
and confirm a `CollabBackground` worker plus a terminal native-ledger row.
Repeat after process death and reboot, without force-stopping the application.
A force-stopped Android application is intentionally not expected to run
scheduled work until it is launched again.

## Headless Session Feasibility

Native credential access and session refresh are already independent of React:
`server_token_store` owns durable refresh-token access and `hosted_session`
owns serialized rotation. Actual restoration is not yet headless for two
reasons:

1. live sessions and the refresh lock are owned by Tauri-managed `AppState`
2. the known-server list and its TLS/persistence choices are stored in webview
   local storage

Phase 1 must therefore introduce a process-owned `BackgroundCoordinator` shared
by Tauri commands and Android JNI workers. Its agreed boundary is:

- a native registry of known servers, certificate policy, profile identity, and
  eligible offline replicas/calendars
- one shared hosted-session registry and refresh lock per process
- a persistent, schema-versioned job ledger with per-resource locks
- bounded `BackgroundJobRequest` and `BackgroundJobOutcome` models
- adapters for foreground commands, desktop scheduling, and WorkManager
- optional progress publication when a webview is present

Credentials remain in platform credential stores. The coordinator must not own
notification presentation, widget rendering, live document presence, or React
state. Notifications and widgets consume compact coordinator outcomes and
snapshots through later adapters.

## Packaging Findings

- **AppImage/Linux:** enabling Tauri tray support adds the existing
  `libappindicator` path. Availability and behavior must be tested under
  GNOME, KDE, and Hyprland; some shells require a status-notifier extension.
- **Flatpak:** validate status-notifier D-Bus access and tray visibility in the
  sandbox before adding permissions. Background mode does not justify broad
  filesystem or session-bus access.
- **Windows:** validate Explorer restart, multiple launches, restore/focus, and
  installer upgrades while a tray process is running.
- **macOS:** validate Dock versus menu-bar behavior, reopen activation, and
  signed update replacement. Do not switch to an accessory-only application in
  Phase 0.
- **APK/AAB:** WorkManager `2.11.0` supports the app's API 24 minimum and uses
  AndroidX Startup through manifest merging. No custom boot receiver or
  always-on service is required for the probe.
- **Android toolchain:** WorkManager `2.11.0` carries Kotlin 2.1 metadata. The
  generated project now uses Kotlin Gradle plugin `2.0.21`, which compiles the
  complete debug Kotlin source set with the current Android Gradle plugin.

## Verification Recorded

- `cargo test -p collab background --lib`
- `cargo check -p collab`
- `cargo check -p collab --target aarch64-linux-android` with the installed NDK
  compiler configured
- `pnpm exec tsc --noEmit`
- `:app:compileUniversalDebugKotlin` with JDK 21 and the installed Android SDK
- `:app:testUniversalDebugUnitTest` with JDK 21 and the installed Android SDK

The remaining Phase 0 validation is deliberately manual because a successful
compile cannot prove shell tray integration, Android process death behavior,
Doze scheduling, or reboot recovery.
