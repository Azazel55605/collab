# Flatpak

`collab` now has an in-repo Flatpak manifest for local builds and CI bundle generation.

Current scope:

- Phase 1/2 uses a network-enabled Flatpak build sandbox so `pnpm` and Cargo can resolve dependencies during the build.
- This is suitable for local testing and CI artifacts.
- It is not Flathub-ready yet; later packaging work needs vendored/generated sources instead of live dependency downloads during the build.

## Local Build

Requirements:

- `flatpak`
- `flatpak-builder`

Build a local Flatpak bundle:

```bash
./flatpak/build-local.sh
```

This script will:

1. add the Flathub remote if needed
2. install the GNOME 48 runtime/SDK and the Node/Rust SDK extensions
3. stage a filtered source tree under `.flatpak-builder/source-tree` so local builds do not copy `node_modules`, `dist`, `src-tauri/target`, or other large artifacts into the Flatpak source mirror
4. build the app with `flatpak-builder`
5. export a local repository
6. generate `dist-builds/flatpak/collab-flatpak-x86_64.flatpak`

Run the bundle:

```bash
flatpak install --user dist-builds/flatpak/collab-flatpak-x86_64.flatpak
flatpak run com.azazel.collab
```

## Runtime Behavior

- Flatpak builds disable the in-app updater.
- Standalone `.flatpak` bundle installs are updated by installing a newer bundle again.
- Repo- or Flathub-based installs should update through their Flatpak remote or software center.
- The initial sandbox grants `--filesystem=home` so vault folders behave the same way as the native Linux packages during early testing.

## CI

GitHub Actions builds a testable Flatpak bundle artifact from the same manifest. This is intended for Phase 2 validation before deciding whether to publish to Flathub or your own Flatpak repository.

Distribution planning notes for those later phases live in [docs/flatpak-distribution-plan.md](/home/azazel/Code%20Projects/collab/docs/flatpak-distribution-plan.md).
