# Presentation Release Validation

This is the release gate for `.deck` authoring, presenting, collaboration, and
export. It separates repository checks from evidence that can only come from
real operating systems, mobile hardware, assistive technology, and third-party
presentation applications. A green build is not evidence that a package,
screen reader, projector, or PowerPoint installation was exercised.

## Automated gate

Run from the repository root:

```bash
pnpm presentation:release:check
pnpm exec tsc --noEmit
pnpm mobile:test
cargo test --workspace
cargo check --workspace
pnpm rust:boundaries
pnpm versions:check
```

On a slower shared runner, set `COLLAB_DECK_BUDGET_SCALE` instead of changing
the published time ceilings. Structural, file-size, text, image, chart, JSON,
and object limits never scale.

The presentation release command covers:

- the 300-slide validation, serialization, parse, resolve, SVG, and PowerPoint
  budgets, plus image-heavy, text-heavy, chart-heavy, and hostile documents;
- client/server validation, repair, schema/newer-version protection, reading
  order, stable semantic labels, alternative text, contrast, and font fallback;
- keyboard authoring, presentation navigation, animation builds, second-display
  recovery, stable formatting-row geometry, blank-canvas arrow navigation,
  physical main/audience fullscreen sizing, mobile touch/view state, and
  Android process recreation;
- deterministic PDF/image/print planning and the first-party OOXML writer;
- reversible operations, crash-repair paths, and a sustained two-client Yjs
  convergence soak including accessibility-order edits;
- the shared vault capability tests for encrypted local vaults, optimistic
  conflicts, offline replicas, immutable history, and snapshot restore.

## Accessibility gate

Record this gate with a keyboard and screen reader on at least one desktop
platform, then repeat the viewing/presenting subset with TalkBack on Android.

1. Reach the slide rail, canvas, toolbar, notes, design inspector, export, and
   presentation controls without a pointer. Focus must remain visible at 200%
   UI zoom and at 320 CSS pixels wide.
2. Use Tab/Shift+Tab to select objects; arrow keys to nudge; Shift+Arrow to
   nudge by ten points; keyboard shortcuts to insert, group, order, duplicate,
   delete, undo, and redo.
3. In **Accessibility**, confirm every object has a useful name, images and
   linked previews have alternative text, and reading-order moves do not change
   visual z-order. Large slides show at most 50 inspector rows at once.
4. Confirm the audit reports deterministic low text contrast, text over an
   image/transparent background for manual review, and missing fonts with the
   actual fallback preview family.
5. Present using only the keyboard. Exercise next/previous, object builds,
   slide links, blank screen, overview, notes, audience-window recovery, and
   Escape. Confirm slide contents are announced in the authored reading order.
6. Confirm animations and transitions become cuts with Collab motion disabled
   and with the operating system's reduced-motion preference.

The slide stays one visual SVG for deterministic output. Assistive technology
receives a bounded ordered companion list—one entry per resolved object, never
one node per glyph, table cell, or chart point.

## Platform, packaging, and output matrix

Fill this table for the exact release commit. Attach package names, OS/WebView
versions, screenshots or recordings, and exported fixtures to the release
issue. Do not carry a pass forward from another commit.

| Target                                   | Required presentation checks                                                         | Status before physical run |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| Linux x86_64 native and portable package | Create/save/reopen, WebKit text probe, keyboard/screen reader, show, print/PDF/PPTX  | Unverified                 |
| Linux ARM64 native or portable package   | Create/save/reopen, show, asset loading, PDF/PPTX                                    | Unverified                 |
| Linux Flatpak                            | Portal open/save/export/print, fonts/assets, fullscreen and audience window          | Unverified                 |
| Windows x86_64 MSI                       | WebView2 text probe, Narrator/NVDA, show/audience window, print/PDF, PowerPoint      | Unverified                 |
| macOS Apple Silicon DMG                  | WKWebView text probe, VoiceOver, show/audience window, print/PDF, Keynote/PowerPoint | Unverified                 |
| macOS Intel DMG                          | Open/save/show/export smoke and package signature                                    | Unverified                 |
| Android ARM64 APK/AAB phone              | TalkBack, rotation/process recreation, offline view, touch show, remote              | Unverified                 |
| Android ARM64 APK/AAB tablet             | TalkBack, large-screen layout, rotation, touch show, remote                          | Unverified                 |
| Printed page and generated PDF           | Slide/handout geometry, notes, links, searchable text, missing-font report           | Unverified                 |
| Microsoft PowerPoint desktop             | Fixture opens without repair; masters, charts, notes, transitions, fonts             | Unverified                 |
| Google Slides import                     | Fixture import and presentation; conversion differences recorded                     | Unverified                 |
| LibreOffice Impress                      | Fixture render comparison and presentation                                           | Automated baseline passed  |
| Apple Keynote                            | Fixture import and presentation, when macOS is available                             | Unverified                 |

Package checks must also verify icons, MIME registration for `.deck`, file
associations, bundled OCR/static assets, upgrade install, uninstall, and launch
without a development checkout.

## Recovery, security, history, and soak gate

- Force termination during an unsaved local edit, a hosted offline edit, and a
  reconnect. Reopen the deck and confirm the last durable revision remains
  available, queued work is either replayed or exposed for recovery, and no
  empty replacement document is written.
- Open repaired v1 documents and a synthetic newer-schema document. Repairs
  must be listed; newer content must remain byte-for-byte read-only.
- Create/open/save/history-restore a deck in an encrypted local vault, lock and
  unlock it, and inspect temporary/export paths for unexpected plaintext.
- Restore an older hosted revision and verify history remains immutable and a
  new current revision is created through the normal vault history workflow.
- Run two desktop clients plus one Android client for two hours. Include
  concurrent text/object/slide/reading-order edits, 15 minutes offline per
  client, reconnect in different orders, presenting while another client
  edits, and one forced termination during queued work.
- Record peak resident memory, idle/active CPU, open/save/export/reconnect
  latency, replica bytes, Android battery change, and thermal state. No content
  loss, unbounded retry, repeated warning, or silent repair is acceptable.

## Known validation boundaries

- Automated contrast checks are conclusive only for text over deterministic
  solid colours. Image and translucent backgrounds are flagged for manual
  review instead of producing a false pass.
- Fonts are referenced, not embedded. Collab previews the chosen fallback and
  reports missing families; layout may still differ in another application.
- Object animations are played by Collab but remain omitted from PowerPoint
  export with a visible report. Fade, push, and wipe transitions are exported
  using PowerPoint's nearest duration preset.
- Automated CRDT convergence does not prove radio loss, operating-system
  suspend, projector/display drivers, screen-reader behavior, battery drain,
  or thermal throttling. Those remain unverified until this matrix is attached.

## Release sign-off

- [ ] Automated gate passed on the release commit.
- [ ] Keyboard and screen-reader gate attached.
- [ ] Every supported package/platform row has evidence or a release exclusion.
- [ ] Print/PDF and third-party presentation fixtures attached.
- [ ] Crash, encrypted-vault, history, offline, and multi-client soak attached.
- [ ] Known boundaries copied into the release notes.
