# Tauri Updater ZIP Dependency Backport

This directory contains the published `tauri-plugin-updater` **2.13.1** crate,
under its original MIT / Apache-2.0 licenses (included here). Source revision:
`e51128438011755f9e7277bad29b8c0978cf281c`, `plugins/updater` in
[the upstream repository](https://github.com/tauri-apps/plugins-workspace).
`upstream-checksums.json` records the published archive SHA-256 and every retained
upstream file; the regression test verifies the retained files remain unchanged.

The only functional change is the Windows optional ZIP dependency requirement in
`Cargo.toml`: `4` becomes `9`. Collab's root Cargo patch selects this directory,
and the native dependency stays on the `~2.13.1` line to match the installed
JavaScript updater. The plugin's Rust source, permissions and build script are
unchanged. The registry's nested Cargo.lock and duplicate original manifest are
not build inputs here and are omitted.

Reason: RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369 affect ZIP 4.6.1;
upstream 2.13.1 and 2.14.0 still require ZIP 4 for Windows archive updates. The
updater calls `ZipArchive::extract`, so suppressing the findings or disabling
existing update formats is not an appropriate fix. ZIP 9.0.5 supplies the patched
extraction implementation. Collab's other direct ZIP dependencies use the same
major version.

Remove this patch when a compatible upstream updater release supports patched
ZIP. Upgrade the Rust and JavaScript updater together, remove the root patch and
workspace exclusion, regenerate Cargo.lock, and rerun updater-version,
archive/XLSX, malicious-extraction and workspace checks. Windows/macOS/Linux real
signed-update acceptance remains a release gate; host compilation is not that
acceptance.
