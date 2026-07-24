# macOS Install Guide

The macOS build targets **Apple Silicon (arm64)**. Download either the `.dmg` or
the `.app.tar.gz` from the release page.

## Important: the app is not signed or notarized

collab is currently distributed **without an Apple code signature or
notarization**. macOS Gatekeeper blocks unsigned, downloaded apps by default, so
on first launch you will likely see one of:

- "collab is damaged and can't be opened. You should move it to the Trash."
- "collab can't be opened because Apple cannot check it for malicious software."

The app is not actually damaged — this is Gatekeeper reacting to the
`com.apple.quarantine` attribute that macOS adds to anything downloaded from the
internet. Clear it once and the app runs normally.

## Install steps

1. Open the `.dmg` (or extract the `.app.tar.gz`) and drag **collab.app** into
   `/Applications`.
2. Remove the quarantine flag from the installed app:

   ```bash
   xattr -cr /Applications/collab.app
   ```

3. Launch collab from Launchpad or `/Applications` as usual.

If you extracted the `.app` somewhere other than `/Applications`, point `xattr`
at that path instead.

### Alternative: right-click Open

For a single app you can also right-click (or Control-click) **collab.app** in
Finder, choose **Open**, and confirm in the dialog. This still requires
acknowledging the unsigned-developer warning and does not always succeed on
recent macOS versions, so the `xattr -cr` step above is the reliable method.

## Why signing is not enabled yet

Signing and notarization require a paid Apple Developer Program membership and a
Developer ID certificate. Until that is in place, the `xattr -cr` workaround is
the supported way to run the macOS build. Only run it on the official collab
download from this project's releases.

## Updates

The in-app updater downloads signed update artifacts (verified with the bundled
minisign public key), but the same Gatekeeper quarantine handling applies to a
freshly downloaded `.dmg`/`.app` until the app is code-signed and notarized.
