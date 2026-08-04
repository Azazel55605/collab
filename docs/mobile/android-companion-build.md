# Android Companion Build Instructions

These instructions build the Android companion app, not the desktop client. The
Android app uses the mobile-specific Vite entrypoint in
`apps/mobile-android` and the Tauri config override in
`src-tauri/tauri.android.conf.json`.

## Prerequisites

1. Install the normal project dependencies:

   ```bash
   pnpm install
   ```

2. Install **JDK 17 or JDK 21** and make sure `JAVA_HOME` points at it before
   running Android builds. The Android Gradle tooling used by the generated
   Tauri project does not currently work with newer Java releases such as JDK
   26.

3. Install Android Studio or the Android command-line tools.

4. Install these Android SDK packages through Android Studio SDK Manager:

   - Android SDK Platform for a recent API level.
   - Android SDK Build-Tools.
   - Android SDK Platform-Tools.
   - Android SDK Command-line Tools.
   - Android NDK.

5. Export Android environment variables. Adjust the SDK path if Android Studio
   installed it somewhere else:

   ```bash
   export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
   export ANDROID_HOME="$HOME/Android/Sdk"
   export ANDROID_SDK_ROOT="$ANDROID_HOME"
   export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -n 1)"
   export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
   ```

6. Install the Rust Android targets:

   ```bash
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```

7. Accept Android SDK licenses:

   ```bash
   sdkmanager --licenses
   ```

## One-Time Tauri Android Project Generation

Generate the native Android project after the prerequisites are installed:

```bash
pnpm android:init
```

This creates `src-tauri/gen/android/`. Most app code should live in Rust
commands or `apps/mobile-android`. A small number of generated Android project
files are intentionally committed and maintained because the companion needs
native Android behavior that Tauri's generated defaults do not provide:

- `MainActivity.kt` intercepts Android back gestures/buttons and dispatches them
  to the React shell so the app can close sheets, walk folders, and show the
  styled quit confirmation instead of randomly finishing the activity.
- `CollabTokenStore.kt` and `CollabReplicaKeyStore.kt` persist refresh tokens and
  replica encryption keys through Android Keystore-backed storage.
- `app/build.gradle.kts` contains the Play `applicationId`, version/signing
  wiring, app-specific ProGuard configuration, and the compact debug-native
  strip hook. The hook uses injected Gradle `ExecOperations`; do not restore
  the Gradle-9-incompatible `project.exec` API during regeneration.
- `buildSrc/.../BuildTask.kt` and `RustPlugin.kt` retain Tauri's Rust build task
  while injecting its working directory and Gradle `ExecOperations` during
  configuration. This avoids execution-time `Task.project` access and must be
  preserved until the generated upstream task provides the same boundary.
- `CollabNotifications.kt` owns Android channels, alarms, native actions, and
  optional Firebase Messaging token/invalidation handling.
- `CollabAgendaWidget.kt`, `CollabAppDestination.kt`, the agenda/month/birthday/
  countdown/tasks/capture/shortcuts widget manifest entries and
  `collab_*_widget_info.xml` resources,
  the kind-specific `collab_*_widget_preview.xml` launcher layouts and drawables,
  and the Glance/Compose Gradle wiring form the native mobile widget boundary.
  Regeneration must preserve these files and declarations.

The calendar-derived widgets read bounded versioned JSON snapshots from the
application-private `files/widgets/` directory. The Rust/JNI publisher builds
profile-scoped snapshots from the cached native calendar store after foreground
startup, widget configuration, lifecycle events, and WorkManager completion.
The shared `collab-calendar` recurrence projection remains authoritative. Month
snapshots contain 13 bounded six-week pages (current month plus six months in
either direction) and up to two privacy-reduced labels per day. The Glance
provider keeps only a bounded per-widget month offset, so its arrow actions can
switch these cached pages without starting the app, invoking Rust, or using the
network. Birthday and explicit countdown views reuse privacy-reduced item rows.
Glance never interprets recurrence rules. Ordinary widget rendering does not
start the Tauri webview, invoke Rust, or perform network work.

The tasks widget is the only widget that may mutate shared data, and only when
its configuration opts in. Its completion action is deliberately a two-tap
flow: the first tap stores a pending item id in per-widget Glance state, and
only the confirming tap enters Rust through `nativeCompleteTask`. Rust
re-validates current state and the displayed revision before queueing a normal
calendar pending operation, then republishes the profile's snapshots inside the
same call. Kanban assignments are never completed from the launcher because
their write-through needs the authenticated app; their rows open the board
through the opaque `kanban-card` destination instead.

The quick-capture and shortcut widgets never mutate anything. Capture tiles
open existing mobile flows, and shortcut rows are built from bounded offline
replica manifests (metadata only, no document body, no network). Every vault
row carries only opaque `vaultId`/`fileId` identifiers and resolves through the
shared `openVaultTarget` store action; a target that no longer resolves shows a
recovery notice and triggers a widget refresh rather than opening a dead
screen.

Every widget app destination includes a distinct Intent data identity because
Android PendingIntent matching ignores extras. The native activity persists a
cold-start destination until the mounted React shell retrieves and acknowledges
it through `mobile_app_destination_take_pending`; WebView creation alone must
not consume the route.

To compile the native widget and run its unit tests without building Rust native
libraries, use the documented JDK/SDK environment and run:

```bash
cd src-tauri/gen/android
./gradlew :app:testUniversalDebugUnitTest
```

The explicit app flavor is required: the root `testDebugUnitTest` aggregate
covers the Android library modules but does not execute the companion app's
flavored tests.

## Firebase Push Setup

Push is optional and only reduces hosted invitation/mention latency. The native
foreground and WorkManager notification catch-up remains the correctness path.
Without Firebase configuration, Android builds continue to compile and use
polling.

To enable push for a build:

1. Register the Android application ID in a Firebase project.
2. Place the downloaded configuration at
   `src-tauri/gen/android/app/google-services.json`. This file is ignored by
   Git and must be supplied by the release environment.
3. Configure the Collab server's push gateway as documented in
   [Server Development and Compose](../server/development.md).

The app uses Firebase only in the native Android layer. The FCM installation
identifier, Collab installation ID, and server bearer credentials never enter
the React webview.
FCM data messages contain only the strict opaque invalidation contract; the
native Rust coordinator authenticates to each registered Collab server to fetch
and validate actual notification envelopes.

## Debug On An Emulator Or Device

1. Start an Android emulator or connect a physical Android device with USB
   debugging enabled.

2. Verify that adb sees it:

   ```bash
   adb devices
   ```

3. Run the companion app:

   ```bash
   pnpm android:dev
   ```

The development build serves the mobile frontend on port `1422` and installs a
debug app on the selected Android target.

## Build An APK

Build the mobile frontend and Android package:

```bash
pnpm android:build
```

After a successful build, inspect the generated APK directory:

```bash
find src-tauri/gen/android/app/build/outputs/apk -name "*.apk" -print
```

Typical debug or release APK paths are below `src-tauri/gen/android/app/build/outputs/apk/`,
for example:

```text
src-tauri/gen/android/app/build/outputs/apk/universal/release/
src-tauri/gen/android/app/build/outputs/apk/universal/debug/
```

Install an APK manually with:

```bash
adb install -r path/to/app.apk
```

## Build A Sideloadable Debug APK

For early phone testing, prefer a debug APK. It is signed with the Android debug
certificate and can be installed directly on a device with sideloading enabled:

```bash
pnpm android:build:debug
find src-tauri/gen/android/app/build/outputs/apk -name "*debug*.apk" -print
adb install -r path/to/debug.apk
```

The default debug command targets modern arm64 phones instead of bundling every
ABI. Rust keeps line-table debug info in the local `target/` library for
symbolization while the APK's staged copy is stripped, avoiding hundreds of
megabytes of embedded DWARF. The wrapper removes exact prior APK/idsig outputs
before packaging, and the staged native strip task always reruns for compact
debug builds. This prevents Gradle incremental state from retaining an old APK
or repackaging stale native output; consecutive arm64 builds should remain near
the same size. Use
`pnpm android:build:debug:x86_64` for the standard x86_64 emulator, or
`pnpm android:build:debug:universal` only when one APK truly needs all ABIs.
For a full native-symbol APK explicitly needed for debugger work, run:

```bash
CARGO_PROFILE_DEV_DEBUG=2 \
ORG_GRADLE_PROJECT_collabKeepNativeDebugSymbols=true \
pnpm android:build:debug
```

### Debug Build Runtime Speed

A debug APK ships the same native library as a release APK, built with Cargo's
dev profile. With Cargo's defaults that means `opt-level = 0` for every
dependency, and because every IPC call runs through that library the app feels
far slower than the release build — cryptography and parsing suffer most
(AES-GCM measured ~65x slower unoptimized). The workspace root therefore sets:

```toml
[profile.dev]
opt-level = 1

[profile.dev.package."*"]
opt-level = 3
```

Dependencies are optimized fully because they are compiled once and rarely
change; the workspace's own crates stay at a light level so incremental rebuilds
remain quick. `debug-assertions` and `overflow-checks` are untouched, so debug
builds keep their correctness checks. The cost is a slower first build after a
`cargo clean` or a dependency bump.

If a debug build ever feels dramatically slower than release again, check this
block is still present before profiling app code.

Do not use an `*-unsigned.apk` release artifact for manual installation. Android
will reject unsigned release APKs. Production release APKs need a real signing
configuration before they can be installed or distributed.

## Current Companion Scope

The Android companion currently supports hosted-server login/session restore,
hosted vault browsing, selected-vault offline availability, note editing, Kanban
editing, mobile CRDT/live-session plumbing for supported text documents, queued
offline edits, and foreground/reconnect sync replay.

The app is still a companion client. Local filesystem vaults, desktop-style
multi-tab workspaces, file import/drag-out, rich PDF/image editing, and full
canvas/logic editing remain desktop-first or later mobile work.

## Troubleshooting

### Missing Android NDK Compiler

If Cargo reports that it cannot find `aarch64-linux-android-clang`, the NDK is
installed but its LLVM toolchain is not visible to the build:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -n 1)"
export PATH="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Then verify:

```bash
which aarch64-linux-android-clang
pnpm android:build
```

### Gradle Fails With `26.0.1`

If Gradle fails while configuring `:buildSrc` with only a version-looking message
such as `26.0.1`, the active Java runtime is too new for the Android Gradle
tooling generated by Tauri. Use JDK 17 or JDK 21 for Android builds.

On Arch Linux:

```bash
sudo pacman -S jdk17-openjdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
export PATH="$JAVA_HOME/bin:$PATH"
java -version
pnpm android:build
```

If you prefer the Android Studio bundled runtime, point `JAVA_HOME` at its JBR
directory instead, then rerun `java -version` before building.
