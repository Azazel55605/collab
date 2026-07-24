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
  wiring, and app-specific ProGuard configuration.

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
