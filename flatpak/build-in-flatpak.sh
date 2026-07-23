#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/lib/sdk/node22/bin:/usr/lib/sdk/rust-stable/bin:${PATH}"
export CARGO_HOME="${PWD}/.flatpak-cargo"
export npm_config_cache="${PWD}/.flatpak-npm"
export CARGO_REGISTRIES_CRATES_IO_PROTOCOL="sparse"
export COREPACK_HOME="${PWD}/.flatpak-corepack"
export CI="true"

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Flatpak build requires Node.js >=22.13, found ${process.version}`);
  }
'

corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm tauri build --no-bundle --config '{"build":{"beforeBuildCommand":""}}'

install -Dm755 "target/release/collab" "${FLATPAK_DEST}/bin/collab"
install -Dm644 "flatpak/com.azazel.collab.desktop" "${FLATPAK_DEST}/share/applications/com.azazel.collab.desktop"
install -Dm644 "flatpak/com.azazel.collab.metainfo.xml" "${FLATPAK_DEST}/share/metainfo/com.azazel.collab.metainfo.xml"
install -Dm644 "src-tauri/icons/128x128.png" "${FLATPAK_DEST}/share/icons/hicolor/128x128/apps/com.azazel.collab.png"
