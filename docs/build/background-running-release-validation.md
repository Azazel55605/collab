# Background Running Release Validation

## Scope

Background running is opt-in on desktop and Android. Desktop keeps the native
process available in the tray and runs bounded synchronization jobs. Android
uses WorkManager for deferrable synchronization; it does not keep an activity,
webview, or permanent service alive.

The shared native coordinator owns locking, cancellation, retry state, progress,
and the credential-free status snapshot. Closing a server session or deleting
an offline replica cancels matching work. Restoring the desktop window requests
a coalesced catch-up, and abandoned jobs receive a bounded retry time after the
next launch or upgrade.

Large explicit Android uploads and downloads are not routine background jobs.
They require the notification system's persistent foreground-transfer channel
before they can safely continue after the activity leaves the foreground.

## Platform Limitations

### Desktop

- Tray availability depends on the desktop shell. GNOME may require an
  AppIndicator/status-notifier extension.
- Flatpak builds need working status-notifier D-Bus integration. Background
  mode does not justify broad filesystem or session-bus permissions.
- Start-at-login is enabled only after the user opts in. `--background` hides
  the initial window only when background running is already enabled.
- Sleep and suspend can delay timers. The monotonic scheduler runs one bounded
  catch-up after resume instead of trying to replay every missed interval.
- Interactive document presence is not preserved merely because the process is
  in the tray.

### Android

- WorkManager intervals are minimum requests, not exact schedules. Doze, OEM
  battery policy, charging, network, roaming, low-battery, and low-storage
  constraints may delay work.
- Force-stopping Collab prevents scheduled work until the user launches it
  again. Swiping away the activity is not equivalent to force-stop.
- WorkManager persists periodic requests across reboot and package replacement,
  but cleared app data or uninstall removes schedules, credentials, ledgers,
  and offline replicas.
- Routine background synchronization requires usable saved credentials. An
  authentication-required result is terminal until the user reauthenticates.
- Android defers routine sync when storage is low. User-visible large transfers
  remain foreground-only until notification-backed transfer handling lands.

## Automated Release Checks

Run from the repository root:

```bash
cargo test -p collab background --lib
cargo check --workspace
NODE_ENV=test ./node_modules/.bin/vitest run \
  src/lib/vaultReplica.test.ts \
  src/components/settings/SettingsBackgroundSection.test.tsx \
  src/components/layout/SyncStatusIndicator.test.tsx
NODE_ENV=test ./node_modules/.bin/vitest run \
  --config apps/mobile-android/vitest.config.ts
./node_modules/.bin/tsc --noEmit
```

Run Android unit tests with JDK 17 or 21 and an installed SDK:

```bash
JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
ANDROID_HOME="$HOME/Android/Sdk" \
PATH="$JAVA_HOME/bin:$PATH" \
src-tauri/gen/android/gradlew \
  -p src-tauri/gen/android/app \
  testUniversalDebugUnitTest
```

Before a release candidate, also build the relevant packages:

```bash
pnpm tauri build
pnpm android:build:debug
pnpm android:build:aab
git diff --check
```

## Manual Desktop Matrix

Run every row against a packaged build, not only `tauri dev`.

| Scenario                                                            | Linux GNOME | Linux KDE | Hyprland | Windows | macOS |
| ------------------------------------------------------------------- | ----------- | --------- | -------- | ------- | ----- |
| Opt-in leaves current close behavior unchanged until saved          | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Close hides to tray and tray Open restores/focuses                  | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Sync now, pause, resume, and recent status work                     | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Sleep/resume performs one catch-up without a sync loop              | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Network loss/recovery preserves queued work                         | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Reauthentication recovers without removing the server               | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Removing a server or replica cancels only matching work             | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Start-at-login and explicit Quit behave correctly                   | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Saving background settings with autostart already disabled succeeds | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |
| Upgrade preserves settings and readable job history                 | [ ]         | [ ]       | [ ]      | [ ]     | [ ]   |

For Flatpak, repeat tray visibility, restore, and autostart checks inside the
sandbox. Do not add permissions solely to make a development shell behave like
a packaged desktop.

## Manual Android Matrix

Test at least one stock Android device/emulator and one OEM device with
aggressive battery management where available.

| Scenario                                                                      | Stock Android | OEM device |
| ----------------------------------------------------------------------------- | ------------- | ---------- |
| Activity dismissed while periodic sync remains eligible                       | [ ]           | [ ]        |
| Process death followed by WorkManager recreation                              | [ ]           | [ ]        |
| Reboot and package upgrade preserve scheduled work                            | [ ]           | [ ]        |
| Doze delays work and later catch-up succeeds once                             | [ ]           | [ ]        |
| Metered/unmetered and roaming policies are honored                            | [ ]           | [ ]        |
| Charging, low-battery, and low-storage constraints are honored                | [ ]           | [ ]        |
| Offline edits replay after network recovery                                   | [ ]           | [ ]        |
| Expired credentials show reauthentication without logging out other servers   | [ ]           | [ ]        |
| Removing one server/replica leaves unrelated work intact                      | [ ]           | [ ]        |
| Force-stop blocks work until Collab is launched again                         | [ ]           | [ ]        |
| Verify background sync runs WorkManager and shows one completion notification | [ ]           | [ ]        |
| Denied notification permission opens Android app notification settings        | [ ]           | [ ]        |

Useful commands:

```bash
adb shell dumpsys jobscheduler | grep -i collab
adb shell dumpsys deviceidle force-idle
adb shell dumpsys deviceidle unforce
adb shell am force-stop com.azazel.collab.companion
adb logcat -s CollabBackground
```

Use Android Settings to inspect per-app battery and background-data policy.
OEM-specific unrestricted-battery toggles must remain a user choice; Collab
must not attempt to bypass them.

## Troubleshooting

### Desktop Tray Is Missing

1. Confirm **Run in background** is enabled.
2. On GNOME, confirm a status-notifier/AppIndicator extension is available.
3. In Flatpak, inspect status-notifier D-Bus access before changing app logic.
4. Verify the packaged build includes the tray icon and that another Collab
   process is not already owning it.

### Desktop Does Not Sync While Hidden

1. Confirm background sync is enabled, not paused, and not set to Manual.
2. Open the sync popover and inspect the latest native ledger row.
3. Reauthenticate if the row reports authentication required.
4. Confirm the vault has an offline replica and the server allows background
   sync.

### Android Work Is Delayed

1. Confirm background work is enabled in Collab Settings.
2. Check network, roaming, charging, battery, and free-storage conditions.
3. Inspect WorkManager with `dumpsys jobscheduler`.
4. Check whether the app was force-stopped or restricted by OEM battery policy.
5. Launch Collab once to request a unique catch-up job.
6. Use **Settings > Background activity > Verify background sync** for a
   one-shot end-to-end check. This diagnostic requires notification permission
   and does not enable notifications for routine successful syncs.

### Upgrade Or Crash Leaves A Job Deferred

This is expected for work interrupted mid-run. The startup recovery path marks
the record deferred, preserves it for diagnostics, and assigns a retry time.
The next eligible periodic, foreground, or user-initiated request joins the same
resource lock and resumes from durable replica/calendar state.
