# Digital Ink Phase 0 Contract

## Status

Phase 0 is **complete except for its physical-device gate**. This document
freezes the `.ink` product contract, the coordinate and quantization rules, the
resource limits, the rendering architecture, and the collaboration transaction
model that Phases 1-11 of `docs/plans/digital-ink-and-annotation-plan.md` build
on.

The executable half of this contract lives in:

- `src/types/ink.ts` — the `.ink` schema, limits, quantization ranges, presets
- `src/lib/ink/samples.ts` — capture, stabilization, simplification, quantization
- `src/lib/ink/codec.ts` — the compact delta-encoded sample storage
- `src/lib/ink/stroke.ts` — the first-party outliner and the adapter seam
- `src/lib/ink/strokeAdapters.ts` — the `perfect-freehand` alternative
- `src/lib/ink/tiles.ts` — the renderer-free tile, dirty-region, and eviction model
- `src/lib/ink/svg.ts` — deterministic SVG export from the scene
- `src/lib/ink/transaction.ts` — the stroke-to-transaction and preview rules
- `src/lib/ink/pointer.ts` — the Pointer Events adapter and contact arbitration
- `src/lib/ink/budgets.ts` — the executable form of the budget table below
- `src/lib/ink/fixture.ts` — deterministic fixtures
- `tools/ink-input-probe.html` — the physical-device input probe

Nothing here delivers a user-visible drawing surface. There is no `InkView`, no
`.ink` routing, no vault integration, and no toolbar; that work starts in
Phase 2.

Phase 1 has since built the shared domain on top of this contract —
`document.ts`, `operations.ts`, `spatialIndex.ts`, `renderer.ts`, `raster.ts`,
`fixtureShapes.ts`, and `crates/collab-documents/src/ink.rs`. The decisions and
limits below are what it was built against and remain authoritative.

## Decisions

| Decision               | Outcome                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Extension              | `.ink`                                                                                           |
| Media type             | `application/vnd.collab.ink+json`                                                                |
| Document kind          | `collab-ink`                                                                                     |
| Initial schema version | `1`                                                                                              |
| Coordinate unit        | Integer **ink units**, 1/64 pt (`INK_UNITS_PER_POINT = 64`)                                      |
| Sample storage         | Structure-of-arrays, delta-encoded, inside the JSON document                                     |
| Input boundary         | Pointer Events, via `src/lib/ink/pointer.ts`                                                     |
| Stroke outliner        | **First-party** (`outlineStroke`); `perfect-freehand` kept behind the adapter as the alternative |
| Renderer               | First-party tiled Canvas 2D with a DOM overlay; no third-party ink or whiteboard component       |
| Domain location        | `src/lib/ink/` and `src/types/ink.ts`, not a workspace package                                   |
| Annotation model       | The same `InkScene`, anchored to an immutable source surface                                     |
| Collaboration unit     | One completed stroke is one transaction; unfinished strokes travel through awareness only        |

### Why an integer ink unit and not CSS pixels

Stored geometry has to be stable across zoom, device pixel ratio, and platform.
A CSS pixel is none of those. 1/64 pt (~0.0055 mm) is finer than the resolution
of any input the browser hands us — professional tablets resolve about 0.005 mm
in their own device units, and the browser has already reduced that to
fractional CSS pixels before we see it — so the grid is invisible while keeping
every stored coordinate a small integer that delta-encodes well.

The world is bounded at ±2^24 units (~92 m) and a fixed page at 200 in per side,
matching PDF's own ceiling. An infinite canvas is _bounded_: unbounded
coordinates would defeat the tile model, the spatial index, and every allocation
bound downstream.

### Why samples are stored structure-of-arrays

A handwritten page is tens of thousands of samples. One object apiece —
`{"x":1234,"y":5678,"pressure":2048}` — spends most of the file on repeated key
names. Storing each channel as its own delta array measured **3.95-4.24x
smaller** on realistic strokes (see Measured Baselines), and the deltas are
small integers because a pen moves a little between samples.

It stays JSON rather than becoming a binary blob. A blob would be smaller again,
but opaque to the CRDT, to revision diffs, and to anyone reading a document to
debug it — and the delta arrays already recover most of the difference.

### Why `perfect-freehand` is the alternative and not the default

Both were implemented and measured against the same fixtures.

|                                    | First-party `outlineStroke` | `perfect-freehand` 1.2.3            |
| ---------------------------------- | --------------------------- | ----------------------------------- |
| Licence                            | n/a                         | MIT, zero dependencies              |
| Bundle                             | none                        | 4,532 B raw / 2,009 B gzipped (ESM) |
| Outline one 40-sample stroke       | **4.9 µs**                  | 11.1 µs                             |
| Outline points emitted             | 94                          | 116                                 |
| Deterministic                      | yes                         | yes                                 |
| Taper, dash, and highlighter needs | native                      | partial                             |

First-party wins on cost and is already written, so it is the default. The
dependency stays as a **devDependency**, imported only by `strokeAdapters.ts`
and its tests, so it adds nothing to the shipped bundle.

Keeping it is deliberate: it is the proof that `InkStrokeOutliner` is a genuine
seam rather than a type with one implementation, and `stroke.test.ts` asserts
that both satisfy the same contract and stay inside the same
adapter-independent bounds.

**What this comparison did not measure is how the two look.** That is a visual
judgement that needs a real pen on a real screen, and it is a Phase 3 decision.
Swapping the default is a one-line change if the first-party outline proves
worse to draw with.

### Domain location

`apps/mobile-android/src/` already imports desktop modules directly, as it does
for calendar, sheet, circuit, and notification types. A workspace package would
add build complexity for sharing that already works, so the shared ink domain
stays in `src/lib/ink/`. Revisit only if the mobile build boundary changes.

## Quantization

| Channel      | Stored as                        | Rationale                                     |
| ------------ | -------------------------------- | --------------------------------------------- |
| x, y         | Integer ink units, delta-encoded | 1/64 pt is below observable input resolution  |
| pressure     | Integer 0..4095, delta-encoded   | 4096 levels; error is at most 1/8190 of range |
| tiltX, tiltY | Integer degrees, -90..90         | Already integer in the Pointer Events spec    |
| twist        | Integer degrees, 0..359          | Already integer in the spec                   |
| elapsed      | Integer ms since stroke start    | Stroke-relative so the deltas stay small      |

**An unreported channel stays absent.** "No pressure data" and "pressure was
exactly half" must render differently, so nothing is defaulted in. Zero pressure
is treated as unreported because Chromium reports 0 for a held mouse button,
which is not a measurement. Simulated pressure exists but is opt-in per brush:
a mouse line that fakes pressure looks wrong more often than a uniform one does.

Wacom's Pro Pen 2 advertises 8192 levels, so 4096 halves its nominal
resolution. That loss is accepted: the browser does not deliver 8192 distinct
`PointerEvent.pressure` values in practice, and the resulting brush-width
difference is a fraction of a stored unit. The probe in
`tools/ink-input-probe.html` reports the distinct pressure levels a real device
actually produces, which is the measurement that would justify revisiting it.

## Structural Limits

Mirrored from `INK_LIMITS` in `src/types/ink.ts`. A document exceeding a limit
is rejected with a specific error — never silently truncated.

| Limit                        | Value                                |
| ---------------------------- | ------------------------------------ |
| Document size                | 64 MiB                               |
| Pages per document           | 500                                  |
| Layers per page              | 50                                   |
| Objects per page             | 50,000                               |
| Objects per document         | 500,000                              |
| Samples per committed stroke | 4,096                                |
| Samples per document         | 20,000,000                           |
| Stroke segment duration      | 30 s                                 |
| Group nesting depth          | 8                                    |
| Text length                  | 16,384 characters                    |
| Decoded image pixels / bytes | 40,000,000 / 16 MiB                  |
| World half-extent            | 16,777,216 units (~92 m)             |
| Fixed page side              | 200 in                               |
| Zoom range                   | 0.05x - 64x                          |
| Tile edge                    | 8,192 units (128 pt)                 |
| Tile backing store           | 512 px per side, 96 MiB cache budget |
| Transaction size             | 64 KiB                               |
| Awareness preview            | 2 KiB at 20 Hz                       |

Reaching the sample or duration ceiling **splits the stroke into linked
continuation segments** rather than stopping the pen. Segments share a
`continuationId` so they select, transform, and erase as one line, and overlap
by one sample so the drawn line has no seam.

## Rendering Architecture

Retained vector scene as the source of truth; tiled Canvas 2D for the ink; DOM
overlay for selection, handles, text editing, and accessibility. The bitmap is
never authoritative and strokes are never permanent DOM nodes.

The tile model is the part Phase 0 had to justify with numbers, and the
measurement is unambiguous. On a page carrying 10,000 strokes:

|                                    | Strokes | Outline cost |
| ---------------------------------- | ------- | ------------ |
| One third of an A4 page (20 tiles) | 4,028   | **31.0 ms**  |
| One tile                           | 352     | **2.5 ms**   |

A renderer that redrew the visible region on every edit would spend nearly two
frames per stroke and could not keep up with a pen. Repainting only the tiles an
edit dirtied costs about a tenth of that and fits comfortably in a frame. This
is why `InkDirtyTiles` marks **both** the region an object vacated and the one
it now occupies — forgetting the old bounds is what leaves a ghost behind.

Bounds are computed from the centre line and radii, never from the generated
outline, so they do not change if the outliner is swapped. A bound that moved
with the adapter would invalidate every cached tile in every document.

## Collaboration Model

**One completed stroke is one transaction. An unfinished stroke is not a
transaction at all.**

Ink is the highest-frequency input in the app: a pen delivers samples faster
than the display refreshes. Appending a CRDT update per sample would push
hundreds of updates per second into the room, the revision log, and the offline
queue. Instead:

1. The local unfinished stroke renders immediately from memory.
2. A throttled, evenly thinned preview travels through **ephemeral awareness**,
   bounded at 2 KiB and 20 Hz, and is never persisted or materialized.
3. On pointer-up the simplified, quantized stroke is committed **once**.

Proven in `transaction.test.ts` against real Yjs: an 800-sample stroke produces
exactly **one** document update, a full 4,096-sample stroke encodes inside the
64 KiB transaction budget, strokes drawn concurrently by two peers both survive
the merge, and a delete wins over a concurrent restyle rather than resurrecting
the object.

The preview thins evenly rather than truncating, and always includes the live
end of the line. A truncated preview shows a peer a stroke that stopped growing.

## Measured Baselines

Recorded 2026-08-13 on the development machine (Linux, AMD Zen 4, Node via
Vitest). Fixture: one page, 10,000 strokes, 40 samples each, 4 layers. These are
the reference points Phase 10 enforces; re-measure per platform rather than
treating them as portable guarantees.

| Operation                                                               | Measurement            |
| ----------------------------------------------------------------------- | ---------------------- |
| Capture a 400-sample stroke (normalize, streamline, simplify, quantize) | 0.50 ms                |
| — resulting sample count                                                | 400 → 59               |
| Outline one 40-sample stroke                                            | 4.9 µs                 |
| Outline a viewport (20 tiles, 4,028 strokes)                            | 31.0 ms                |
| Outline one dirty tile (352 strokes)                                    | 2.5 ms                 |
| Rebuild all 10,000 stroke bounds                                        | 14.3 ms                |
| `JSON.stringify` the page                                               | 53.5 ms → **7.72 MiB** |
| `JSON.parse` plus decode every sample                                   | 165.3 ms               |
| Hit test via tile narrowing (240 candidates of 10,000)                  | 2.4 ms                 |
| Deterministic SVG export                                                | 606 ms → 15.68 MiB     |

Storage, measured separately:

| Measurement                                       | Value                  |
| ------------------------------------------------- | ---------------------- |
| Delta encoding vs one object per sample           | **3.95-4.24x smaller** |
| Stored cost per sample (position, pressure, time) | 12.2-12.7 B            |
| A 100-reading stroke after capture and encoding   | 30 samples, 478 B      |

### Phase 10 budgets

Mirrored in `src/lib/ink/budgets.ts`, scalable with `COLLAB_INK_BUDGET_SCALE`
for slow runners and emulators. Byte budgets are not scaled.

| Budget                                           | Ceiling |
| ------------------------------------------------ | ------- |
| Capture one completed stroke                     | 4 ms    |
| Outline one stroke                               | 2 ms    |
| Repaint one dirty tile                           | 8 ms    |
| Outline a whole viewport (cold, on open or zoom) | 120 ms  |
| Resolve viewport and dirty tiles                 | 4 ms    |
| Open a 10,000-stroke page (parse + decode)       | 1.5 s   |
| Serialize a 10,000-stroke page                   | 750 ms  |
| Hit test through the index                       | 8 ms    |
| SVG export of a 10,000-stroke page               | 3 s     |
| Stored bytes for a 10,000-stroke page            | 24 MiB  |

## Export

Export walks the stored objects and generates outlines exactly as the editor
does. It never reads back a canvas: a screenshot of the viewport carries the
current zoom, the device pixel ratio, the selection handles, and whatever
happened to be scrolled into view.

**Determinism is a requirement.** Phase 7 re-exports source-linked assets into
notes; a generator that varied would rewrite those assets on every export and
fill the revision history with noise. So: no clock reads, no `Math.random`, no
iteration over unordered maps, fixed-precision coordinates. Paint order comes
from `objectOrder`, never from object-key enumeration — z-order is document data,
not an accident of how the JSON was written.

Every value reaching the output is XML-escaped, including colours and layer
names, because those come from documents that may have been authored elsewhere.

PNG and PDF export are Phase 7; the scene-to-geometry half they need is proven
here by the SVG path.

## Security And Privacy

Frozen in the schema and enforced from Phase 1 validation onward:

- No executable content, raw HTML, or active embedded objects in any field.
- Image objects carry a **vault-relative path**, never an external URL, so the
  renderer cannot be made to fetch from the network by document content.
- Non-finite coordinates are **dropped**, not clamped. A NaN from a driver glitch
  is not a point at the origin, and treating it as one draws a line across the
  page. Out-of-world coordinates are dropped the same way.
- Every channel is clamped into its specified range before storage.
- Handwriting is not treated as biometric identity data. No recognition happens
  implicitly, nothing is uploaded for recognition, and no signature claim is made.
- Strokes carry a **collaboration author id** and nothing about the device. No
  hardware serial, no digitizer identity, no fingerprintable device profile is
  stored — pressure, tilt, and twist are stored as drawing data, and the probe
  harness that reports device capability writes nothing and sends nothing.
- Laser pointer strokes and unfinished previews stay in ephemeral awareness and
  never enter durable history.

## Risks And Mitigations

| Risk                                                                                     | Mitigation                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The first-party outliner may simply look worse than `perfect-freehand` under a real pen  | The adapter seam is proven by test, the dependency is already installed, and switching is one line. This is an explicit Phase 3 decision, not a closed one.                                                                         |
| Palm rejection is application-level and best-effort                                      | Documented as such. OS and digitizer rejection remain authoritative where available. `InkContactArbiter` covers the platforms that deliver the contact anyway, including retiring a palm that landed _before_ the pen.              |
| Android WebView pressure and tilt fidelity is unverified                                 | This is the open exit-gate item. `tools/ink-input-probe.html` measures it per device; the quantization range can be revisited if a device reports more than 4096 usable levels.                                                     |
| A 10,000-stroke page is 7.7 MiB of JSON, and hosted documents carry it through revisions | Inside the 24 MiB budget and the 64 MiB limit, but revision compaction pressure is real. Phase 6 must confirm hosted materialization and the offline replica handle this size; the existing revision-history limit already applies. |
| SVG export of a full page is 606 ms and 15.7 MiB                                         | Above a frame and above a comfortable inline asset. Phase 7 runs heavy exports in a bounded job with progress and cancellation, which the plan already requires.                                                                    |
| Three pen implementations exist today (image overlay, PDF sidecar, ink)                  | Phases 8 and 9 migrate the first two onto `InkScene`. The annotation container is already frozen here so those migrations target a fixed shape rather than a moving one.                                                            |
| JSON is not the densest possible encoding                                                | Accepted deliberately for CRDT, diff, and debuggability. Revisit only with a measured document that exceeds the budget.                                                                                                             |

## Exit Gate Assessment

The plan's gate: _the same fixture must draw, reopen, zoom, export, and preserve
pressure faithfully on desktop and Android without frame-long UI stalls._

| Exit-gate requirement                                                                 | Status                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Freeze extension, MIME, schema, units, page modes, channels, quantization, limits     | **Met** — `src/types/ink.ts`                                                  |
| Compare first-party stroke generation with an isolated `perfect-freehand` adapter     | **Met** — both implemented, measured, seam proven by test                     |
| Tiled Canvas 2D rendering with ≥10,000 representative strokes                         | **Met at model level** — see below                                            |
| Deterministic PNG and SVG output from the scene, not the viewport                     | **SVG met**; PNG deferred to Phase 7 with the same scene walk                 |
| Simplification stays inside a documented visual tolerance and materially reduces size | **Met** — deviation ≤ 24 units + rounding, 400 → 59 samples, 4x encoding gain |
| One completed stroke maps to one bounded collaboration transaction                    | **Met** — proven against real Yjs                                             |
| Record latency, memory, bundle, and licence findings                                  | **Met** — see Measured Baselines and the outliner table                       |
| Capture Pointer Events from real pens, tablets, touch, mouse, and touchpad            | **Not met — open**                                                            |

### What is proven by model, not by pixels

There is no canvas in Phase 0. The tiling proof is a measurement of the _work_ a
tiled renderer does versus an untiled one — stroke outlining, tile resolution,
dirty-region tracking, eviction — not of GPU paint, compositing, or text
shaping. Frame-time validation against a real canvas belongs to Phase 3 and is
measured against the budgets above.

Likewise the input pipeline is proven against synthesized and recorded readings.
`InkContactArbiter` and `readingsFromEvent` are fully tested, but no test can
tell you whether a particular Android WebView reports tilt.

### The open item

Phase 0 cannot close without running `tools/ink-input-probe.html` on real
hardware. It is a standalone, dependency-free page — open it, draw for a few
seconds with each input, copy the report. It measures pointer types, distinct
pressure levels, tilt, twist, eraser end, barrel button, contact geometry,
coalesced-event support and rate, sample rate, concurrent contacts, and
pointer-cancel behaviour.

Devices that need a report before Phase 1 renderer work is committed:

- [ ] Android phone with an active pen (S Pen / USI / MPP)
- [ ] Android tablet, finger and pen
- [ ] Linux desktop with a drawing tablet
- [ ] Linux desktop, mouse and touchpad
- [ ] Windows pen or tablet, if available
- [ ] macOS tablet, if available

The findings belong in this document under a new "Device Findings" section. Two
results would change decisions already frozen here: a device reporting more than
4,096 usable pressure levels would reopen the quantization range, and a platform
that does not deliver `getCoalescedEvents` would need the capture rate measured
before the simplification tolerance is trusted.

## Verification

```bash
pnpm vitest run src/lib/ink        # capture, codec, outline, tiles, export, transactions, scale,
                                   # plus the Phase 1 document, operations, index, and renderer suites
cargo test -p collab-documents     # the shared `.ink` trust boundary
pnpm exec tsc --noEmit
```
