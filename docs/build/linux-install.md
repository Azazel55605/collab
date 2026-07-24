# Linux Install Guide

Use the Linux package that matches your system first. This app behaves best when it runs against the host GTK/WebKitGTK stack.

## Recommended Download Order

1. `.deb` for Debian, Ubuntu, Linux Mint, Pop!_OS, and similar systems
2. `.rpm` for Fedora, Nobara, openSUSE, RHEL, and similar systems
3. `.flatpak` for a sandboxed universal Linux install
4. `collab-linux-*-portable.tar.gz` for other desktop distros when you want host-library behavior without Flatpak

## Install By Distro Family

### Debian / Ubuntu

```bash
sudo apt install ./collab_<version>_amd64.deb
```

If APT reports missing dependencies, run:

```bash
sudo apt -f install
```

### Fedora

```bash
sudo dnf install ./collab-<version>.x86_64.rpm
```

### openSUSE

```bash
sudo zypper install ./collab-<version>.x86_64.rpm
```

### Arch Linux

An AUR source package is planned. See the
[stable AUR package guide](./aur-stable.md); draft packaging metadata lives in
[`packaging/aur/collab`](../../packaging/aur/collab) until the AUR account and
package repository are ready.

Until then, use the Flatpak bundle or the portable tarball. Arch systems need the
normal Tauri runtime stack, especially `webkit2gtk-4.1` and `gtk3`.

## Portable Tarball

Use the portable archive when your distro is not covered by the native packages and you still want native scrolling, scaling, and rendering behavior.

```bash
tar -xzf collab-linux-x86_64-portable.tar.gz
cd <extracted-directory>
chmod +x collab
./collab
```

You still need the normal Tauri runtime libraries for your distro, especially GTK 3 and WebKitGTK.

Typical package names:

- Debian / Ubuntu: `libwebkit2gtk-4.1-0`, `libgtk-3-0`
- Fedora: `webkit2gtk4.1`, `gtk3`
- Arch: `webkit2gtk-4.1`, `gtk3`
- openSUSE: `webkit2gtk3`, `gtk3`

## Flatpak

Builds installed through Flatpak use Flatpak's own update path instead of the app's built-in updater.

Install a bundle:

```bash
flatpak install --user ./collab-flatpak-x86_64.flatpak
flatpak run com.azazel.collab
```

If you installed from a standalone `.flatpak` bundle, update by installing a newer bundle again:

```bash
flatpak install --user ./collab-flatpak-x86_64.flatpak
```

If `collab` is later distributed through Flathub or a custom Flatpak repository, normal `flatpak update com.azazel.collab` updates will work through that configured remote.

Flatpak development/build notes are in the [Flatpak guide](./flatpak.md).

## AppImage

AppImage builds are no longer produced. Earlier releases shipped an `.AppImage`, but it had worse touchpad scrolling, blur/compositing, and fractional-scaling behavior than the native packages, the Flatpak bundle, and the portable tarball, so it was retired in favor of those.

If a user reports Linux-specific rendering or input issues, the first recommendation should be: use the native package for the distro, the Flatpak bundle, or the portable tarball if no native package applies.
