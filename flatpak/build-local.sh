#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST="$SCRIPT_DIR/com.azazel.collab.yml"
STATE_DIR="$ROOT_DIR/.flatpak-builder"
SOURCE_DIR="$STATE_DIR/source-tree"
LOCAL_MANIFEST="$STATE_DIR/com.azazel.collab.local.yml"
BUILD_DIR="${1:-$STATE_DIR/build}"
REPO_DIR="${2:-$STATE_DIR/repo}"
BUNDLE_PATH="${3:-$ROOT_DIR/dist-builds/flatpak/collab-flatpak-x86_64.flatpak}"

mkdir -p "$(dirname "$BUNDLE_PATH")"
mkdir -p "$STATE_DIR"

rsync -a --delete \
  --exclude '.git' \
  --exclude '.flatpak-builder' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'dist-builds' \
  --exclude 'flatpak-build' \
  --exclude 'flatpak-repo' \
  --exclude 'src-tauri/target' \
  --exclude '*.flatpak' \
  --exclude '.codex' \
  --exclude '.claude' \
  "$ROOT_DIR"/ "$SOURCE_DIR"/

sed 's|path: ..|path: source-tree|' "$MANIFEST" > "$LOCAL_MANIFEST"

flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.gnome.Platform//48 org.gnome.Sdk//48 org.freedesktop.Sdk.Extension.node20//24.08 org.freedesktop.Sdk.Extension.rust-stable//24.08

flatpak-builder --user --install-deps-from=flathub --force-clean "$BUILD_DIR" "$LOCAL_MANIFEST"
flatpak-builder --repo="$REPO_DIR" --force-clean "$BUILD_DIR" "$LOCAL_MANIFEST"
flatpak build-bundle "$REPO_DIR" "$BUNDLE_PATH" com.azazel.collab --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo

echo "Bundle written to $BUNDLE_PATH"
