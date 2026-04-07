# Linux Install Guide

Use the Linux package that matches your system first. This app behaves best when it runs against the host GTK/WebKitGTK stack instead of an AppImage runtime.

## Recommended Download Order

1. `.deb` for Debian, Ubuntu, Linux Mint, Pop!_OS, and similar systems
2. `.rpm` for Fedora, Nobara, openSUSE, RHEL, and similar systems
3. `.flatpak` for a sandboxed universal Linux install
4. `collab-linux-*-portable.tar.gz` for other desktop distros when you want host-library behavior without Flatpak
5. `.AppImage` only if the above options are not practical

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

Flatpak development/build notes are in [docs/flatpak.md](/home/azazel/Code Projects/collab/docs/flatpak.md).

## AppImage

The AppImage is still supported and still shipped. It is the easiest file to download, but it is not the best Linux experience for this app.

Known tradeoffs versus native/system-library builds:

- touchpad scrolling can feel worse
- backdrop blur/compositing can fail
- fractional scaling can be inconsistent

Run it with:

```bash
chmod +x collab-<version>.AppImage
./collab-<version>.AppImage
```

If a user reports Linux-specific rendering or input issues, the first recommendation should be: use the native package for the distro, or the portable tarball if no native package applies.
