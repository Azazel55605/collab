# AUR package prep for collab-git

This directory is a draft AUR package for the **VCS (git) build** of the desktop
app. It tracks the upstream default branch (`main`) instead of a fixed release
tag, so it always builds the latest committed state. It is not ready to push
until the items below are resolved.

## Relationship to the stable `collab` package

- `collab` (see the [stable package guide](./aur-stable.md)) builds an immutable upstream release tarball with a
  real checksum. `collab-git` builds from the live Git repository.
- The two are mutually exclusive: `collab-git` declares `provides=('collab')` and
  `conflicts=('collab')`, so only one can be installed at a time.
- Keep the VCS suffix convention: this package is named `collab-git`. A binary
  repackage, if ever needed, would be `collab-bin`.

## What the guidelines imply for this project

- Submit a small AUR Git repository containing packaging metadata only:
  `PKGBUILD`, generated `.SRCINFO`, and any tiny local install/helper files if
  they become necessary.
- The AUR contains build scripts, not binary package archives. Never commit
  `*.pkg.tar.*`, filelists, or generated release bundles to the AUR repository.
- Keep the `PKGBUILD` conventional and boring: no `/usr/local`, no makepkg
  private helper calls, no unnecessary custom variables/functions, quoted
  `"$srcdir"`/`"$pkgdir"`-style paths, and roughly 100-character line lengths.
- Keep maintainer and contributor comments at the top of `PKGBUILD`. Use the
  Arch format, for example `# Maintainer: Name <address at domain dot tld>`.
- Confirm the app is not already present in the official Arch repositories. If
  it ever is, do not submit a duplicate AUR package; flag/report issues upstream
  through the official package instead.
- Only submit x86_64 support for now. AUR packages that do not support x86_64
  are not allowed, and this draft has not been validated for other Arch
  architectures.
- Keep `pkgdesc` short, non-self-referential, and close to 80 characters.
- Prefer HTTPS sources. The draft uses `git+https://…`; if signed tags become
  available, consider verifying against the signed tag/commit object.

## VCS-specific rules

- The version is computed by `pkgver()`, not hand-set. It derives from
  `git describe` against `desktop-v*` tags, falling back to legacy `v*` tags, and renders as
  `<lasttag>.r<commits-since-tag>.g<shorthash>` (for example
  `0.5.6.r12.gabc1234`). The literal `pkgver=` line in the `PKGBUILD` is only a
  placeholder that `makepkg` overwrites during build.
- Do **not** add checksums for the VCS source; `sha256sums=('SKIP')` is correct
  because the clone target is mutable.
- `pkgrel` stays `1` unless the packaging itself changes without a new upstream
  commit.
- `git` is a build dependency for the VCS source.

## Current blockers before publishing

1. Fill in the `# Maintainer` email in `PKGBUILD`.
2. Generate `.SRCINFO` from the final `PKGBUILD`. Do not hand-edit it.
3. Verify the dependency set on a clean Arch system or clean chroot. The draft
   follows Tauri's Arch dependency guidance plus `libsecret` for the native
   credential-store integration.
4. Check whether `collab-git` is available as an AUR package name once account
   registration works, and also check the official package database.
5. License the AUR packaging repository itself according to the Arch package
   sources guidance: add the Arch-recommended `0BSD` package-source `LICENSE`,
   add `REUSE.toml`, then run `pkgctl license check`.
6. Configure an AUR-specific SSH key and profile entry. The submission
   guidelines recommend a dedicated key, e.g. `ssh-keygen -f ~/.ssh/aur`, with
   `Host aur.archlinux.org`, `User aur`, and `IdentityFile ~/.ssh/aur` in
   `~/.ssh/config`.
7. Decide which Git identity should author the AUR commits before the first
   push. AUR history is hard to rewrite after publishing, so use per-repo
   `git config user.name` / `git config user.email` if needed.

Note: unlike the stable package, the licensing metadata is already reconciled —
the project ships a root `LICENSE` (`MIT`) and the AppStream metadata declares
`MIT`, so `license=('MIT')` is correct here.

## Build strategy

The draft builds from source with `pnpm tauri build --no-bundle`, then installs
the compiled Tauri binary plus the desktop entry, AppStream metadata, icons,
README, and license directly into the package image. `--no-bundle` skips the
throwaway installer/bundler step and just produces the release binary (Tauri's
`-b` only accepts `deb`/`rpm`/`appimage`, so there is no `-b none`).

The offline `pnpm install` deliberately disables pnpm's optimistic repeat
shortcut after `pnpm fetch`. This converts the fetch-only virtual store into
complete project dependency links and repairs reused `makepkg` trees that would
otherwise report an incomplete `node_modules` directory as already up to date.

## Testing locally

Because the source is a live clone, a plain `makepkg` builds the current `main`:

```bash
makepkg --printsrcinfo > .SRCINFO
makepkg --clean --syncdeps --rmdeps
namcap PKGBUILD
namcap collab-git-*.pkg.tar.zst
```

Validate direct dependencies rather than relying on transitive packages:

```bash
ldd target/release/collab
readelf -d target/release/collab
```

## Publishing later

Once AUR account registration is available:

```bash
git -c init.defaultBranch=master clone ssh://aur@aur.archlinux.org/collab-git.git
cp PKGBUILD .SRCINFO LICENSE REUSE.toml /path/to/aur/collab-git/
cd /path/to/aur/collab-git
git config user.name "Azazel"
git config user.email "TODO: aur-email"
git add PKGBUILD .SRCINFO LICENSE REUSE.toml
git commit -m "Initial import"
git push
```

The AUR repository should contain only the packaging sources needed by AUR. Do
not copy this whole project checkout, dependency caches, release artifacts, or
the built package archive into the AUR Git repository.

The AUR only accepts pushes to the `master` branch. If your local branch has a
different name, rename it before pushing.

For a VCS package you do not bump `pkgver` on every upstream commit — the version
is recomputed at build time. Push packaging updates to the AUR only when the
`PKGBUILD`, dependencies, or build steps actually change.
