# Publishing the Android Companion to Google Play

This covers going from the source tree to a signed release on the Google Play
Store. It assumes you can already build the app locally (see
`docs/mobile/android-companion-build.md`) and have a Google Play Developer account.

The app's package name (Play "application ID") is **`com.collab.companion`**
(the `applicationId` in `src-tauri/gen/android/app/build.gradle.kts`). **This is
permanent once published** — you can never change it or reuse it for another app.

Note: the *internal* code package (`namespace`, and the Tauri `identifier` in
`src-tauri/tauri.android.conf.json`) intentionally stays
`com.azazel.collab.companion`. Android allows the public `applicationId` to differ
from the code namespace, and Tauri/wry + our JNI class lookups resolve against the
namespace at compile time, so only `applicationId` is the user-facing/Play name.

## Overview

1. Create an **upload keystore** (one-time) and point Gradle at it.
2. Build a **signed Android App Bundle (`.aab`)**.
3. Create the app in the Play Console and enrol in **Play App Signing**.
4. Upload the AAB to the **Internal testing** track and roll out.
5. Complete the required store listing / policy declarations before production.

## 1. Create your upload keystore (one-time)

Google Play uses **Play App Signing**: Google holds the real *app signing key*;
you sign uploads with your own *upload key*. Generate the upload key once and
keep it safe — losing it means you must ask Google to reset it.

```bash
keytool -genkey -v \
  -keystore ~/keystores/collab-upload.jks \
  -alias collab-upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Store the keystore **outside the repo** (the example uses `~/keystores/`) and
back it up somewhere durable (password manager / offline copy). Remember the
store password and key password.

## 2. Point Gradle at the keystore

Create `src-tauri/gen/android/key.properties` (already git-ignored — never commit
it):

```properties
storeFile=/home/you/keystores/collab-upload.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=collab-upload
keyPassword=YOUR_KEY_PASSWORD
```

`app/build.gradle.kts` reads this file and signs the release build with it. When
the file is absent (e.g. CI without secrets) the release build stays unsigned and
nothing else changes, so this is safe to leave wired up.

## 3. Set the version

The mobile app version is independent from the desktop client. Edit
`versions.json`:

```json
{
  "mobile": {
    "versionName": "0.6.4",
    "versionCode": 6004
  }
}
```

Then sync generated manifests:

```bash
pnpm versions:sync
```

The sync step writes the mobile `versionName` to
`src-tauri/tauri.android.conf.json` and the explicit Play `versionCode` to
`bundle.android.versionCode`.

**Play requires a strictly increasing `versionCode` for every upload.** Bump the
mobile `versionCode` before each Play upload. You can bump only the mobile
version without changing the desktop client, admin web UI, or server versions.

## 4. Build a signed AAB

Play distributes **App Bundles**, not APKs:

```bash
# Make sure JAVA_HOME points at JDK 17/21 and the Android SDK/NDK env is set
# (see docs/mobile/android-companion-build.md).
pnpm android:build:aab
```

Release builds run an R8 mapping check after packaging. It verifies that the
Kotlin notification and WorkManager methods called by Rust retain their exact
JNI names; the build fails instead of producing an AAB with release-only broken
notifications or background scheduling.

The command also warns when
`src-tauri/gen/android/app/google-services.json` is absent. Such a build still
supports scheduled notification polling, but FCM push invalidations are not
included. Supply the Firebase file in the release environment when push latency
is required.

The signed bundle is written to:

```text
src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

(Exact path can vary by ABI split settings; search with
`find src-tauri/gen/android/app/build/outputs/bundle -name "*.aab"`.)

Confirm it is signed with your upload key (not the Android debug key):

```bash
jarsigner -verify -verbose -certs \
  src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab \
  2>/dev/null | grep -i "CN=" | head
```

## 5. Create the app in the Play Console

In <https://play.google.com/console>:

1. **Create app** → name, default language, "App", "Free/Paid".
2. Accept the developer program declarations.
3. Under **Setup → App integrity → App signing**, keep **Play App Signing
   enabled** (the default). When you upload your first AAB, Google generates and
   holds the app signing key; your `collab-upload.jks` is registered as the
   upload key.

## 6. Upload to Internal testing first

1. **Testing → Internal testing → Create new release**.
2. Upload the `.aab`.
3. Add release notes, review, **Start rollout to Internal testing**.
4. Add tester emails (an internal testing list), share the opt-in link, install
   from Play on a real device, and verify:
   - Sign in to your hosted server (must be **HTTPS** — release builds set
     `usesCleartextTraffic=false`, so plain-`http://` servers other than
     `localhost` will not connect).
   - Session restore after force-quit.
   - Offline vault save, airplane-mode browse, remove offline copy.

Promote Internal → Closed → Production when you are satisfied.

## 7. Required declarations before Production

Play will not let you ship to production until these are complete (Console shows
a checklist under **Policy** / **App content**):

- **Privacy policy URL** — required because the app handles accounts and stores
  credentials. Host a short policy and paste its URL.
- **Data safety form** — declare what the app collects/stores. For this app:
  it stores your server session (refresh token) and cached vault content **on
  the device** (Android Keystore + app-private storage); it transmits your
  credentials/content only to **the hosted Collab server you configure**. It does
  not share data with third parties or use ad SDKs.
- **App access** — since everything is behind a login, provide test credentials
  (a demo account on a reachable hosted server) so Google's reviewers can sign
  in, or explain the self-hosted requirement.
- **Content rating** questionnaire.
- **Target audience** and ads declarations (no ads).
- **Target API level** — Play requires a recent `targetSdk`; the project targets
  API 36, which is current.

## Versioning cheat-sheet for future releases

```text
1. Bump versions.json mobile.versionName and mobile.versionCode.
2. pnpm versions:sync
3. pnpm android:build:aab
4. Play Console → Testing/Production → Create new release → upload AAB → roll out.
```

## Notes and gotchas

- **Keep `key.properties` and the `.jks` out of git.** Both are already ignored
  under `src-tauri/gen/android/`. Losing the upload key is recoverable via Google
  (upload-key reset); losing it *and* not using Play App Signing would not be.
- If you ever re-run `pnpm android:init`, re-check that the signing block in
  `app/build.gradle.kts` (and the `CollabTokenStore` / `CollabReplicaKeyStore`
  Kotlin classes + `proguard-collab.pro`) are still present; they are committed,
  but a regeneration could overwrite generated Gradle files.
- The app is a **companion to a hosted Collab server**, not standalone. The store
  listing should say so, and reviewers need a reachable HTTPS server + account to
  exercise it.
