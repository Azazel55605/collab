# Digital Ink Release Validation

This is the release gate for `.ink` editing and PDF/image annotations. It
separates checks the repository can prove automatically from device behavior
that must be recorded on physical hardware. A successful package build is not
evidence that pen pressure, palm rejection, accessibility, or thermal behavior
works on that platform.

## Automated gate

Run from the repository root:

```bash
pnpm ink:release:check
pnpm exec tsc --noEmit
pnpm mobile:test
cargo test --workspace
cargo check --workspace
pnpm rust:boundaries
pnpm versions:check
```

On a slower shared runner, set `COLLAB_INK_BUDGET_SCALE` instead of changing
the published performance ceilings. The scale affects time limits only; file,
sample, object, image, cache, replay, and export-size limits remain fixed.

The ink release command covers:

- 10,000-stroke capture, cold viewport, dirty-tile, hit-test, serialization,
  parse, and SVG-export budgets;
- a 20-page notebook, long strokes, many layers, image/path validation,
  degenerate geometry, malformed content, and whole-document limits;
- object-bounded tile invalidation and bounded semantic object pagination;
- keyboard selection transforms and keyboard placement for every non-freehand
  canvas tool;
- migration, newer-schema read-only protection, optimistic conflicts, crash
  reload behavior, and mobile process recreation;
- bounded CRDT replay plus the multi-client offline edit soak in
  `collab-live`;
- desktop pointer/contact arbitration and Android pen/touch/palm policy.

## Accessibility gate

Every release candidate must pass these checks with a keyboard and a screen
reader on at least one desktop platform:

1. Reach the drawing surface, tool rail, properties, object navigator, layers,
   page controls, export, and save without a pointer.
2. Select any authored object from **Objects**. The list follows document
   reading order, exposes the layer name, and paginates in groups of 50 so a
   large notebook does not create thousands of DOM nodes.
3. Move with Arrow keys; resize with Alt+Arrow; rotate with
   Alt+Shift+Left/Right. Shift increases movement to ten screen pixels.
4. Choose a shape, connector, text, sticky, image, stamp, equation, ruler,
   protractor, compass, or guide tool and press Enter on the drawing surface to
   place it at the viewport centre.
5. Confirm page and layer names, typed text, equations, image file names,
   connector labels, stamps, shapes, groups, selection count, conflicts, and
   read-only state are announced.
6. Confirm focus is visible at 200% UI zoom and controls remain reachable at
   320 CSS pixels wide.

Freehand strokes are intentionally summarized by the canvas rather than
mirrored as permanent DOM nodes. A handwritten page can contain tens of
thousands of strokes; representing each as an accessibility node would freeze
the same assistive-technology path it is intended to help. Typed and authored
objects remain individually navigable.

## Physical platform and input matrix

Fill this table for the exact release commit. Record OS/device versions and the
package tested in the release issue; do not infer a pass from an earlier build.

| Platform/package              | Mouse/touchpad | Keyboard/screen reader | Pen pressure/tilt | Touch/palm/pinch  | Status before hardware run |
| ----------------------------- | -------------- | ---------------------- | ----------------- | ----------------- | -------------------------- |
| Linux x86_64 `.deb` or `.rpm` | Required       | Required               | Required          | If available      | Unverified                 |
| Linux ARM64 native/portable   | Required       | Required               | If available      | If available      | Unverified                 |
| Linux Flatpak                 | Required       | Required               | Required          | If available      | Unverified                 |
| Windows x86_64 MSI            | Required       | Required               | Required          | Required          | Unverified                 |
| macOS Apple Silicon DMG       | Required       | Required               | If available      | Trackpad required | Unverified                 |
| macOS Intel DMG               | Required       | Required               | If available      | Trackpad required | Unverified                 |
| Android ARM64 APK/AAB, phone  | N/A            | TalkBack basics        | If available      | Required          | Unverified                 |
| Android ARM64 APK/AAB, tablet | N/A            | TalkBack basics        | Required          | Required          | Unverified                 |
| Arch `PKGBUILD`               | Required       | Required               | If available      | If available      | Unverified                 |

For pen coverage, include at least one Wacom-compatible desktop tablet and one
device from each available Android family: Samsung S Pen and USI/MPP/AES. Use
`tools/ink-input-probe.html` to record the Pointer Events fields the device and
webview actually deliver. Never record a hardware serial number.

For each row, exercise create/open/save/reopen, a one-minute continuous stroke,
eraser-end and barrel buttons when present, hover, pressure, tilt, palm contact,
pinch/pan, selection transforms, typed objects, PDF/image annotation, export,
offline edit/reconnect, forced process termination, and recovery.

## Resource and soak gate

Use a release build, not an unoptimized Android or Rust debug build.

- Open the 20-page/10,000-stroke fixtures and edit for 30 minutes while sync is
  active. Pointer-to-preview latency should stay within one display frame under
  normal load and no input sample may disappear after save/reopen.
- Run two desktop clients plus one Android client for two hours. Include
  concurrent add/erase/transform/text/reorder, 15 minutes offline per client,
  reconnect in different orders, and a forced termination during queued work.
- Record peak resident memory, idle/active CPU, cache bytes, save latency,
  reconnect duration, battery change, and thermal state. Derived tiles may be
  evicted; vector content may not be lost.
- Repeat encrypted local-vault lock/unlock and hosted replica recovery. Verify
  that no plaintext drawing or annotation is written outside the configured
  vault/replica boundaries.
- Inspect logs after malformed-file repair and crash recovery. One actionable
  warning is acceptable; repeated toasts, retry loops, silent reset, and empty
  replacement documents are release blockers.

## Supported inputs and known limitations

- Desktop supports mouse, touchpad, keyboard, Pointer Events pen input, and
  touch when the OS/webview exposes it. Android supports pen and touch drawing;
  precision selection/arrangement remains a desktop workflow.
- Palm rejection is best effort in the application. Operating-system and
  digitizer rejection remains authoritative, and behavior varies by hardware.
- Pressure, tilt, twist, hover, eraser-end, and barrel buttons are available
  only when the platform reports them. Device-specific button remapping cannot
  be promised across every driver.
- macOS trackpad drawing has simulated pressure; Apple Pencil is not a macOS
  desktop input channel. Android stylus behavior depends on the device webview.
- The canvas is retained vector data rendered through bounded bitmap tiles.
  Freehand strokes are announced as aggregate canvas content; non-freehand
  authored objects provide individual accessible names and reading order.
- Automated collaboration soak proves bounded replay and deterministic CRDT
  convergence, not radio loss, driver behavior, battery drain, or thermal
  throttling. Those claims remain unverified until the physical matrix is
  attached to the release.
- AppImage is not a supported packaging channel. Prefer native Linux packages,
  Flatpak, the portable tarball, or the Arch package.

## Release sign-off

- [ ] Automated gate passed on the release commit.
- [ ] Accessibility gate recorded with keyboard and screen reader.
- [ ] Every required platform/package row has evidence or is explicitly
      excluded from this release.
- [ ] Physical pen/touch matrix attached.
- [ ] Resource and multi-client soak results attached.
- [ ] Known limitations copied into the release notes.
