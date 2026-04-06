#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/build.sh — local build helper for collab
#
# Usage:
#   ./scripts/build.sh                      # build native target only
#   ./scripts/build.sh linux-x86_64         # specific target
#   ./scripts/build.sh linux-aarch64        # needs Docker (uses 'cross')
#   ./scripts/build.sh all                  # native + linux-aarch64 if Docker available
#
# Windows and macOS targets cannot be compiled from Linux without a licensed
# macOS SDK / Windows SDK.  Use GitHub Actions for those:
#   git tag v1.0.0 && git push origin v1.0.0
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT_DIR/dist-builds"

# ── Colour helpers ────────────────────────────────────────────────────────────
B='\033[1m'; R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; C='\033[0;36m'; N='\033[0m'
step()  { echo -e "\n${B}${C}▶ $*${N}"; }
ok()    { echo -e "${G}✔ $*${N}"; }
warn()  { echo -e "${Y}⚠ $*${N}"; }
die()   { echo -e "${R}✖ $*${N}" >&2; exit 1; }

# ── Detect host ───────────────────────────────────────────────────────────────
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
case "$HOST_OS-$HOST_ARCH" in
  Linux-x86_64)  NATIVE_TARGET="x86_64-unknown-linux-gnu"  ;;
  Linux-aarch64) NATIVE_TARGET="aarch64-unknown-linux-gnu" ;;
  Darwin-x86_64) NATIVE_TARGET="x86_64-apple-darwin"       ;;
  Darwin-arm64)  NATIVE_TARGET="aarch64-apple-darwin"      ;;
  *) die "Unknown host: $HOST_OS-$HOST_ARCH" ;;
esac

cd "$ROOT_DIR"
mkdir -p "$OUT_DIR"

# ── Dependency checks ─────────────────────────────────────────────────────────
check_deps() {
  for cmd in cargo pnpm rustup; do
    command -v "$cmd" &>/dev/null || die "'$cmd' not found. Install it first."
  done
}

package_linux_portable() {
  local triple="$1" label="$2"
  local release_dir="src-tauri/target/${triple}/release"
  local binary="$release_dir/collab"
  local staging="$OUT_DIR/.portable-${label}"
  local archive="$OUT_DIR/$label/collab-${label}-portable.tar.gz"

  if [ ! -f "$binary" ]; then
    warn "Portable binary not found: $binary"
    return
  fi

  rm -rf "$staging"
  mkdir -p "$staging"
  cp "$binary" "$staging/collab"
  cat > "$staging/README.txt" <<'EOF'
collab portable Linux build

This archive uses the host system WebKitGTK/GTK libraries instead of AppImage's
bundled runtime. Use it when the AppImage has touchpad scrolling, blur, or
fractional-scaling issues on your distro.

Run:
  ./collab

Requirements:
  Install the normal Tauri/WebKitGTK runtime packages for your distro.
EOF

  mkdir -p "$OUT_DIR/$label"
  tar -C "$staging" -czf "$archive" .
  rm -rf "$staging"
  ok "Portable archive → $archive"
}

# ── Install a Rust target if not present ──────────────────────────────────────
ensure_target() {
  local triple="$1"
  if ! rustup target list --installed | grep -q "^${triple}$"; then
    step "Installing Rust target $triple"
    rustup target add "$triple"
  fi
}

# ── Copy build artifacts into dist-builds/<label>/ ────────────────────────────
collect() {
  local triple="$1" label="$2"
  local bundle_dir="src-tauri/target/${triple}/release/bundle"
  local dest="$OUT_DIR/$label"

  if [ ! -d "$bundle_dir" ]; then
    warn "Bundle directory not found: $bundle_dir"
    return
  fi

  mkdir -p "$dest"
  find "$bundle_dir" \( \
       -name "*.deb" -o -name "*.rpm" -o -name "*.AppImage" \
    -o -name "*.msi" -o -name "*.exe" \
    -o -name "*.dmg" -o -name "*.app.tar.gz" \
    \) -exec cp -v {} "$dest/" \;

  case "$triple" in
    x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
      package_linux_portable "$triple" "$label"
      ;;
  esac

  ok "Artifacts → $dest/"
}

# ── Build one target ──────────────────────────────────────────────────────────
build_target() {
  local triple="$1" label="$2"
  step "Building $label ($triple)"
  ensure_target "$triple"
  pnpm tauri build --target "$triple"
  collect "$triple" "$label"
}

# ── Cross-compile Linux aarch64 via 'cross' (Docker) ─────────────────────────
build_linux_arm() {
  local triple="aarch64-unknown-linux-gnu"
  local label="linux-aarch64"

  if ! command -v docker &>/dev/null; then
    warn "Docker not found — skipping $label (install Docker to enable)"
    return
  fi

  if ! command -v cross &>/dev/null; then
    step "Installing 'cross' (Docker-based cross-compiler)"
    cargo install cross --git https://github.com/cross-rs/cross
  fi

  step "Building $label ($triple) via cross"
  ensure_target "$triple"

  # cross wraps cargo; we invoke it directly for the Rust lib then call tauri
  # with a pre-built backend.  Simplest approach: set CARGO to cross.
  CARGO=cross pnpm tauri build --target "$triple" -- --config "build.runner='cross'"  2>/dev/null || \
    pnpm tauri build --target "$triple"

  collect "$triple" "$label"
}

# ── Frontend install (once) ────────────────────────────────────────────────────
step "Installing frontend dependencies"
pnpm install --frozen-lockfile

# ── Dispatch ─────────────────────────────────────────────────────────────────
check_deps

REQUESTED="${1:-native}"

case "$REQUESTED" in
  native)
    case "$NATIVE_TARGET" in
      x86_64-unknown-linux-gnu)  build_target "$NATIVE_TARGET" "linux-x86_64"       ;;
      aarch64-unknown-linux-gnu) build_target "$NATIVE_TARGET" "linux-aarch64"      ;;
      x86_64-apple-darwin)       build_target "$NATIVE_TARGET" "mac-intel"          ;;
      aarch64-apple-darwin)      build_target "$NATIVE_TARGET" "mac-apple-silicon"  ;;
    esac ;;

  linux-x86_64)
    [[ "$HOST_OS" == "Linux" ]] || die "linux-x86_64 must be built on Linux"
    build_target "x86_64-unknown-linux-gnu" "linux-x86_64" ;;

  linux-aarch64)
    [[ "$HOST_OS" == "Linux" ]] || die "linux-aarch64 cross-compilation requires a Linux host"
    if [[ "$HOST_ARCH" == "aarch64" ]]; then
      build_target "aarch64-unknown-linux-gnu" "linux-aarch64"
    else
      build_linux_arm
    fi ;;

  mac-intel)
    [[ "$HOST_OS" == "Darwin" ]] || die "macOS targets must be built on macOS"
    build_target "x86_64-apple-darwin" "mac-intel" ;;

  mac-apple-silicon)
    [[ "$HOST_OS" == "Darwin" ]] || die "macOS targets must be built on macOS"
    build_target "aarch64-apple-darwin" "mac-apple-silicon" ;;

  windows-x86_64)
    die "Windows builds require a Windows runner.\nPush a version tag to trigger GitHub Actions:\n  git tag v1.0.0 && git push origin v1.0.0" ;;

  all)
    # Build everything possible on this host
    case "$HOST_OS" in
      Linux)
        build_target "$NATIVE_TARGET" \
          "$([[ $HOST_ARCH == aarch64 ]] && echo linux-aarch64 || echo linux-x86_64)"
        [[ "$HOST_ARCH" != "aarch64" ]] && build_linux_arm
        warn "Windows and macOS targets require GitHub Actions (push a tag)"
        ;;
      Darwin)
        build_target "x86_64-apple-darwin"    "mac-intel"
        build_target "aarch64-apple-darwin"   "mac-apple-silicon"
        warn "Linux and Windows targets require GitHub Actions (push a tag)"
        ;;
    esac ;;

  *)
    die "Unknown target '$REQUESTED'.\nValid: native | linux-x86_64 | linux-aarch64 | mac-intel | mac-apple-silicon | windows-x86_64 | all" ;;
esac

echo -e "\n${B}${G}Done.${N} Artifacts in ${B}$OUT_DIR/${N}"
