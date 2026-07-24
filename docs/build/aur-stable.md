# AUR package prep for collab

This directory is a draft AUR package for the desktop app. It is not ready to push
until the items below are resolved.

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
- Use a unique package name. `collab` is suitable if it is available on AUR when
  registration returns. If it is taken, prefer a clearer project-specific name
  over a conflicting one.
- Confirm the app is not already present in the official Arch repositories. If
  it ever is, do not submit a duplicate AUR package; flag/report issues upstream
  through the official package instead.
- Confirm the package is useful to more than just this development checkout. The
  desktop app qualifies because it installs a general user-facing executable,
  desktop metadata, icons, and documentation.
- Only submit x86_64 support for now. AUR packages that do not support x86_64
  are not allowed, and this draft has not been validated for other Arch
  architectures.
- Keep `pkgver` equal to the upstream release version and reset `pkgrel` to `1`
  for each new upstream version.
- Keep `pkgdesc` short, non-self-referential, and close to 80 characters.
- The stable package should use immutable upstream release sources and real
  checksums. The draft PKGBUILD therefore targets the GitHub desktop release tag
  tarball for `desktop-v${pkgver}` and has a checksum placeholder.
- Prefer HTTPS sources and PGP/source verification where upstream provides it.
  If Git tags become signed, consider building from the signed tag object hash
  rather than a mutable tag name.
- Keep generated build output, vendored dependency directories, package archives,
  and local machine state out of the AUR repository.
- Do not publish duplicate packages. Before creating the AUR repository, search
  for an existing `collab` package and pick a non-conflicting name if necessary.
- Keep the stable package named `collab`. Use suffixes only for distinct package
  types, such as `collab-git` for a VCS build or `collab-bin` for a binary
  repackage.
- Do not use `replaces` unless the package is being renamed. For alternate
  package variants, use `conflicts`/`provides` only when appropriate.
- Regenerate `.SRCINFO` after every `PKGBUILD` metadata change with:

  ```bash
  makepkg --printsrcinfo > .SRCINFO
  ```

- Test locally before pushing:

  ```bash
  updpkgsums
  makepkg --clean --syncdeps --rmdeps
  namcap PKGBUILD
  namcap collab-*.pkg.tar.zst
  ```

- Validate direct dependencies rather than relying on transitive packages:

  ```bash
  ldd target/release/collab
  readelf -d target/release/collab
  ```

- Optionally check reproducibility after a successful build with `makerepropkg`
  from `devtools` or `repro` from `archlinux-repro`.

## Current blockers before publishing

1. Create or confirm the upstream `desktop-v${pkgver}` tag/release tarball, then replace
   `TODO_REPLACE_WITH_RELEASE_TARBALL_SHA256` in `PKGBUILD`.
2. Generate `.SRCINFO` from the final `PKGBUILD`. Do not hand-edit it.
3. Reconcile project licensing metadata. The workspace Cargo metadata says
   `MIT`, while `flatpak/com.azazel.collab.metainfo.xml` currently says
   `Proprietary`, and there is no root `LICENSE` file. The AUR `license=()`
   field should match the upstream project license and use SPDX identifiers.
   A license file should be shipped if the license is custom or not otherwise
   present in Arch's common licenses.
4. Verify the dependency set on a clean Arch system or clean chroot. The draft
   follows Tauri's Arch dependency guidance plus `libsecret` for the native
   credential-store integration.
5. Check whether `collab` is available as an AUR package name once account
   registration works again, and also check the official package database.
6. License the AUR packaging repository itself according to the Arch package
   sources guidance: add the Arch-recommended `0BSD` package-source `LICENSE`,
   add `REUSE.toml`, then run `pkgctl license check`.
7. Configure an AUR-specific SSH key and profile entry. The submission
   guidelines recommend a dedicated key, e.g. `ssh-keygen -f ~/.ssh/aur`, with
   `Host aur.archlinux.org`, `User aur`, and `IdentityFile ~/.ssh/aur` in
   `~/.ssh/config`.
8. Decide which Git identity should author the AUR commits before the first
   push. AUR history is hard to rewrite after publishing, so use per-repo
   `git config user.name` / `git config user.email` if needed.

## Build strategy

The draft builds from source with `pnpm tauri build --no-bundle`, then installs
the compiled Tauri binary plus the desktop entry, AppStream metadata, icons, and
README directly into the package image. `--no-bundle` compiles the release binary
without producing an installer (Tauri's `-b` only accepts `deb`/`rpm`/`appimage`,
so there is no `-b none`); the AUR package assembles its own `pkgdir` from the
loose binary and metadata.

This is preferred over unpacking a project `.deb`/`.rpm` because it keeps the AUR
package transparent and source-based. If build time becomes too painful, a
separate binary-style package can be prepared later, but it should use a distinct
name such as `collab-bin`.

The offline `pnpm install` deliberately disables pnpm's optimistic repeat
shortcut after `pnpm fetch`. This converts the fetch-only virtual store into
complete project dependency links and repairs reused `makepkg` trees that would
otherwise report an incomplete `node_modules` directory as already up to date.

## Publishing later

Once AUR account registration is available:

```bash
git -c init.defaultBranch=master clone ssh://aur@aur.archlinux.org/collab.git
cp PKGBUILD .SRCINFO LICENSE REUSE.toml /path/to/aur/collab/
cd /path/to/aur/collab
git config user.name "Azazel"
git config user.email "TODO: aur-email"
git add PKGBUILD .SRCINFO LICENSE REUSE.toml
git commit -m "Initial import"
git push
```

If `collab` is unavailable, clone the chosen AUR package name instead and update
`pkgname` before generating `.SRCINFO`.

The AUR repository should contain only the packaging sources needed by AUR. Do
not copy this whole project checkout, dependency caches, release artifacts, or
the built package archive into the AUR Git repository.

The AUR only accepts pushes to the `master` branch. If your local branch has a
different name, rename it before pushing.

After publication, keep watching AUR comments and update the package when
upstream releases, dependencies, or build steps change. Do not add a comment for
every version bump; reserve comments for useful maintainer/user discussion.
