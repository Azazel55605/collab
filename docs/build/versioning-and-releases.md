# Versioning And Releases

Collab uses one central version manifest:

```text
versions.json
```

Edit that file first, then run:

```bash
pnpm versions:sync
```

The sync step updates the version fields consumed by package managers, Cargo, and
Tauri. Use this instead of editing `package.json`, `Cargo.toml`, or Tauri config
versions by hand.

## Version Fields

```json
{
  "server": "0.6.4",
  "adminWeb": "0.6.4",
  "desktop": "0.6.4",
  "mobile": {
    "versionName": "0.6.4",
    "versionCode": 6004
  }
}
```

- `server`: standalone hosted server and shared server crates.
- `adminWeb`: admin web UI package.
- `desktop`: desktop Tauri client.
- `mobile.versionName`: Android user-facing version string.
- `mobile.versionCode`: Android/Google Play numeric build number.

Google Play requires `mobile.versionCode` to increase for every uploaded APK/AAB,
even if `mobile.versionName` stays the same.

## Local Version Bumps

For a mobile-only build:

```bash
# Edit only versions.json mobile.versionName/mobile.versionCode.
pnpm versions:sync
pnpm android:build:debug
# or
pnpm android:build:aab
```

For a desktop-only build:

```bash
# Edit only versions.json desktop.
pnpm versions:sync
pnpm tauri build
```

The sync step also updates `packaging/aur/collab/PKGBUILD` so the stable Arch
package tracks the desktop version and uses the `desktop-vX.Y.Z` release tag.
After a desktop release, regenerate `.SRCINFO` in the AUR package directory and
replace the release tarball checksum before publishing the AUR update:

```bash
cd packaging/aur/collab
updpkgsums
makepkg --printsrcinfo > .SRCINFO
```

For a server-only release candidate:

```bash
# Edit only versions.json server.
pnpm versions:sync
cargo check --workspace
```

For an admin-web-only change:

```bash
# Edit only versions.json adminWeb.
pnpm versions:sync
pnpm admin:build
```

`scripts/tauri-command.mjs` runs `pnpm versions:sync` automatically before Tauri
commands, so normal desktop and Android Tauri builds pick up `versions.json`.
Running `pnpm versions:sync` manually is still recommended before committing so
the synced files are visible in the diff.

## Release Checks

Use target-specific checks:

```bash
pnpm desktop:release:check desktop-v0.6.4
pnpm server:release:check server-v0.6.4
pnpm mobile:release:check mobile-v0.6.4
pnpm admin:release:check admin-web-v0.6.4
```

These checks compare the target tag against `versions.json` and the synced
manifest files for that target.

## Git Tags

Desktop releases use:

```bash
git tag desktop-v0.6.4
git push origin desktop-v0.6.4
```

That triggers `.github/workflows/build.yml`, builds desktop packages, creates a
GitHub Release, uploads `latest.json` for the desktop in-app updater, and
provides the source tarball used by `packaging/aur/collab/PKGBUILD`.

Server container releases use:

```bash
git tag server-v0.6.4
git push origin server-v0.6.4
```

That triggers `.github/workflows/server-container-build.yml` and publishes
container tags:

```text
0.6.4
0.6
latest
```

Mobile Play releases are built locally or in CI as AABs and uploaded to Google
Play. They do not currently use a GitHub release workflow:

```bash
pnpm android:build:aab
```

## Desktop Updater

The desktop in-app updater still works with this version system.

The desktop workflow is triggered by `desktop-vX.Y.Z`, but its generated
`latest.json` contains the plain semver version:

```json
{
  "version": "X.Y.Z"
}
```

That plain version is compared against `src-tauri/tauri.conf.json`, which is
synced from `versions.json.desktop`. The installer URLs in `latest.json` still
point at the `desktop-vX.Y.Z` GitHub Release assets.

Important: the updater endpoint is:

```text
https://github.com/Azazel55605/collab/releases/latest/download/latest.json
```

So the newest GitHub Release marked as "latest" must be a desktop release that
contains `latest.json`. Current server container releases do not create GitHub
Releases, and mobile Play releases do not use GitHub Releases, so the updater
path remains valid. If a future mobile/admin/server workflow starts creating
GitHub Releases, those releases must not replace the desktop release as GitHub's
"latest" release unless they also provide a compatible desktop `latest.json`.

## Commit Checklist

Before committing a version bump:

```bash
pnpm versions:sync
pnpm versions:check
git diff --check
```

Then run the relevant build/test command for the product you changed.
