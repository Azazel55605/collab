# Presentations Phase 0 Contract

## Status

Phase 0 is **complete except for its external-application and cross-platform
gates**. This document freezes the `.deck` product contract, the coordinate
model, the resource limits, the scene and text architecture, the live
collaboration encoding, and the PowerPoint export boundary that Phases 1-11 of
[`presentation-tool-plan.md`](./presentation-tool-plan.md) build on.

The executable half of this contract lives in:

- `src/types/deck.ts` — the `.deck` schema, units, limits, and size presets
- `src/lib/deck/units.ts` — the only unit conversions (deck units, px, pt, EMU, rotation)
- `src/lib/deck/validate.ts` — the trust boundary, limits, and deterministic serialization
- `src/lib/deck/resolve.ts` — the shared scene resolver (theme, master, layout, placeholders, fields)
- `src/lib/deck/textLayout.ts` — text layout behind a pluggable measurer
- `src/lib/deck/geometry.ts` — preset shape outlines mapped to OOXML presets
- `src/lib/deck/svg.ts` — deterministic SVG output and slide fitting
- `src/lib/deck/exportPdf.ts` — the slide image and PDF path
- `src/lib/deck/liveText.ts` — the `Y.Text` rich-text encoding
- `src/lib/deck/pptx/` — the isolated PptxGenJS exporter and export report
- `src/lib/deck/budgets.ts` — the executable form of the budget table below
- `src/lib/deck/fixture.ts` — the deterministic five-slide fixture and scale decks
- `src/lib/deck/lexicalEvaluation.test.ts` — the Lexical evaluation
- `tools/deck-text-probe.html` — the cross-platform text-measurement probe

Nothing here delivers a user-visible editor. There is no `DeckView`, no `.deck`
routing, no vault integration, and no server validation; that starts in
Phase 1.

## Decisions

| Decision               | Outcome                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Extension              | `.deck`                                                                                                              |
| Media type             | `application/vnd.collab.deck+json`                                                                                   |
| Document kind          | `collab-deck`                                                                                                        |
| Initial schema version | `1`                                                                                                                  |
| Coordinate unit        | Integer **deck units**, 1/100 pt (`DECK_UNITS_PER_POINT = 100`), exactly 127 EMU                                     |
| Font size unit         | The same: hundredths of a point, which is also what OOXML stores                                                     |
| Rotation               | Integer hundredths of a degree in [0, 36000); exactly 600 OOXML angle units each                                     |
| Default size           | Widescreen 16:9, 96,000 x 54,000 units (13.333 in x 7.5 in), PowerPoint's own preset                                 |
| Identity               | Stable ids everywhere; ordered collections are an id array beside an id-keyed map                                    |
| Rich text              | Collab-owned paragraph/run model; not HTML, not Lexical state                                                        |
| Inheritance            | One resolver: theme → master text styles → master placeholder → layout placeholder → slide                           |
| Groups                 | Children stay in the flat element map with absolute geometry; the group lists ids                                    |
| Renderer               | One `ResolvedSlide` for every output; SVG in deck units is the drawing adapter for thumbnails, playback, images, PDF |
| Live text              | One `Y.Text` per text body; paragraph ends carry id and style                                                        |
| Text editing adapter   | **First-party** `contenteditable` adapter over `liveText.ts`; Lexical not adopted (see below)                        |
| PowerPoint export      | **PptxGenJS 4.0.1** behind `src/lib/deck/pptx/`, lazy-loaded, plus a Collab XML repair pass                          |
| Domain location        | `src/lib/deck/` and `src/types/deck.ts`, shared with mobile the same way ink is                                      |

### Why 1/100 pt

It is the largest unit for which every conversion that matters is exact:
`914,400 EMU per inch / 7,200 units per inch = 127` exactly, so export never
rounds, and OOXML already stores font sizes in hundredths of a point. It is
fine enough for editing (1 unit is 1/75 CSS pixel at 100% zoom) and small
enough that a 56 in slide side is 403,200 units — comfortably integer. Every
conversion goes through `units.ts`; `units.test.ts` round-trips every unit
through EMU without drift and pins the standard sizes to PowerPoint's EMU.

### Why the resolved scene is the seam

The plan's rule is that editor, thumbnails, playback, image, PDF, and export
may use different output adapters but must not fork layout resolution.
`resolveSlide()` produces a scale-free `ResolvedSlide` in deck units with
inheritance, theme colours, fonts, fields, group flattening, and paint order
already decided. Both the SVG renderer and the PowerPoint exporter consume it.

`svg.test.ts` proves the "identical scene output" requirement directly: the
editor size (1280 px), a thumbnail (192 px), and presentation mode (3840 px)
produce byte-identical SVG apart from the root element's pixel size, for every
fixture slide. `fitSlide()` is the one placement function for all three.

## Structural Limits

Mirrored from `DECK_LIMITS` in `src/types/deck.ts`. A document exceeding a
limit is rejected with a specific error — never silently truncated.

**Phase 1 amendment.** Phase 0 froze 32 MiB without checking the server:
hosted vaults run every structured document through
`collab_documents::DEFAULT_PARSER_LIMITS` first — 16 MiB, 100,000 JSON entries,
128 levels. A 1,000-slide deck of simple slides is about 132,000 entries, so
the server would have refused decks the client happily created. The client now
enforces the same three caps (`documentBytes`, `jsonEntries`, `jsonDepth`), so
it can never save a deck the server refuses. In practice that is roughly 750
simple slides; the 1,000-slide cap remains as the structural ceiling, and
raising the hosted parser caps per document kind is a Phase 10 decision.

| Limit                        | Value                        |
| ---------------------------- | ---------------------------- |
| Document size                | 16 MiB (amended in Phase 1)  |
| JSON entries / nesting depth | 100,000 / 128 (Phase 1)      |
| Slides                       | 1,000                        |
| Sections                     | 200                          |
| Themes / masters / layouts   | 16 / 16 / 128                |
| Elements per slide / deck    | 2,000 / 100,000              |
| Characters per text body     | 32,768                       |
| Characters per deck          | 2,000,000                    |
| Paragraphs per body          | 2,000                        |
| Runs per paragraph           | 500                          |
| List levels                  | 9 (as OOXML)                 |
| Group nesting depth          | 8                            |
| Decoded image pixels / bytes | 40,000,000 / 32 MiB          |
| Table rows / columns / cells | 500 / 64 / 10,000            |
| Chart series / points        | 32 / 1,000 per series        |
| Animations per slide         | 200, each at most 60 s       |
| Clipboard payload            | 8 MiB                        |
| Slide side                   | 1 in to 56 in (PowerPoint's) |
| Canvas overscan              | 56 in beyond the slide       |
| Font size                    | 1 pt to 4,000 pt (as OOXML)  |
| Raster export edge           | 8,192 px per slide           |

## Security Rules

Frozen in the schema and enforced by `validateDeck()`, with tests for each:

- No macros, scripts, HTML, or executable objects exist in the schema at all.
- Geometry must be finite integers inside the canvas. `NaN`, fractions, and
  out-of-range values are **rejected, not clamped**.
- Assets are vault-relative paths (no scheme, no leading `/`, no `..`, no `\`)
  with an allowlisted image media type. `svg.ts` additionally refuses to emit
  any `href` that is not `data:image/...` or `blob:`, so even a misbehaving
  asset resolver cannot make a renderer fetch from the network.
- URL links must be `http(s)` or `mailto`; `javascript:` and `data:` fail.
- Group cycles, shared children, and nesting past 8 are rejected; the resolver
  independently refuses to recurse into a self-containing group.
- Every document string reaching SVG is XML-escaped and stripped of characters
  XML cannot carry.
- `parseDeck()` checks the byte limit before calling `JSON.parse`.

## Text Layout

Layout lives in `textLayout.ts`: greedy word wrap, soft breaks, hanging list
labels, alignment, line spacing (`1.2 x size x spacing%`), vertical alignment,
and auto-fit — `shrink` in whole-percent steps down to 25%, as PowerPoint's
`fontScale` does, and `grow` reporting the height the box needs. Width is the
only platform input and comes from a `DeckTextMeasurer`: the canvas measurer
in the app, the deterministic approximate measurer in tests and fallbacks.

### Measured: engine versus the browser's own layout

`tools/deck-text-probe.html` lays the same text out with the engine and with
the platform's DOM, over 4 texts x 6 font stacks x 4 sizes x 2 widths x
regular/bold. First run, 2026-09-28, Chromium 154 on Linux (all test fonts
installed, DPR 1.33):

| Text      | Cases | Identical line breaks |
| --------- | ----- | --------------------- |
| English   | 96    | 95                    |
| German    | 96    | 96                    |
| Numbers   | 96    | 96                    |
| CJK       | 96    | 72                    |
| **Total** | 384   | **359 (93.5%)**       |

Largest width disagreement on a line both layouts agree on: **0.66 px**.

Two findings follow:

1. **Latin text agrees except at knife edges.** The one English mismatch is a
   line canvas `measureText` puts at 420.25 px and DOM layout at 419.81 px in a
   420 px box. No measurement fix removes that: canvas and DOM layout disagree
   by about 0.1%. (Measuring each line as one string instead of summing word
   widths, which the engine now does, removes kerning error but not this.)
   **Consequence for Phase 2/3:** every non-editing output uses the engine. The
   `contenteditable` surface shown while a box is being edited uses browser
   layout, and on a knife-edge line may wrap one word differently until
   editing ends. That is accepted and must be measured again in the real
   editor; the alternative — positioning editing text from engine lines — is
   the fallback if it proves visible in practice.
2. **CJK needs real line-breaking rules.** The engine only breaks CJK as an
   over-long word and applies no kinsoku rules; browsers do not start a line
   with `。` or `，` and pull the previous character down. Phase 3 must add
   `Intl.Segmenter`-based break opportunities and the common kinsoku sets
   before CJK decks can be called supported.

The approximate measurer is visibly wrong against real fonts (for example the
gap in "Read the plan" in the rsvg rendering of the fixture). It exists for
tests and must never lay out output that real fonts will draw.

## Live Collaboration

`liveText.ts` encodes one text body as one `Y.Text`. Characters carry run
formatting as one Yjs attribute per style key; each paragraph ends in `\n`
carrying the paragraph's stable id and style; a soft break is U+2028. The live
form never reaches disk — Phase 6 materialization writes plain `DeckRichText`.

Proven against real Yjs in `liveText.test.ts`, with two independent documents
exchanging only state-vector diffs:

- every fixture body round-trips losslessly;
- concurrent typing at different places in one paragraph merges;
- concurrent insertion at the same position keeps both, identically ordered;
- one peer bolding a word while another types inside it keeps both;
- one peer's bold and another's italic over overlapping ranges both survive;
- a peer splitting a paragraph while another types after the split point puts
  the typing into the new paragraph instead of losing it — the reason for one
  `Y.Text` per body rather than one per paragraph;
- a paragraph restyle merges with concurrent typing in that paragraph;
- a delete racing a format converges identically on both peers;
- a 100-operation offline session on each side reconciles on reconnect;
- one typed character is an incremental update under 64 bytes.

Structure outside text bodies (slides, elements, order) keeps the plan's
`Y.Map`/`Y.Array` design and is Phase 6 work.

## Text Editing Adapter: Lexical Evaluated, Not Adopted

| Finding                           | Result                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Licence                           | MIT (0.51.0)                                                                             |
| Bundle for an editing stack       | ~109 KB gzipped (core 63 KB, yjs 14 KB, rich-text, selection, utils, clipboard, html)    |
| Can hold `.deck` text losslessly  | **Yes**, with deck data in `NodeState` on every node (proven headless for every fixture) |
| Keeps runs differing only in deck | Yes; merge checks node state equivalence                                                 |
| `@lexical/yjs` CRDT shape         | `Y.XmlText`/`XmlElement` keyed by Lexical internals (`__type`, `__state`, `__textStyle`) |

The plan's condition was that Lexical state must not become the `.deck`
schema. The stored schema is safe either way, but `@lexical/yjs` would make
Lexical's node model the **live** collaboration schema, and Phase 6 server
materialization would have to parse Lexical internals to produce `.deck`
JSON — a hard dependency of the server on an editor library's private format.
Keeping `liveText.ts` as the live schema means binding Lexical to it by hand,
which is the same work as a first-party adapter while still paying 109 KB.

**Decision:** a first-party `contenteditable` adapter bound to `liveText.ts`.
Lexical stays a devDependency used only by the evaluation test, as
`perfect-freehand` does for ink, so the comparison remains reproducible.
Revisit only if IME, accessibility, or clipboard work in Phase 3 proves
substantially harder than expected — that is the risk this decision accepts.

## PowerPoint Export

`src/lib/deck/pptx/` maps the resolved scene onto PptxGenJS. PptxGenJS types
do not leave that directory; the module is imported lazily.

### What the proof covers

`exportDeckToPptx.test.ts` unzips the generated file and checks OOXML
semantics, not bytes: slide count and order; slide size in exact EMU; element
offsets in exact EMU; rotation (`rot="900000"` for 15°); preset geometry;
dashes; arrowheads; image crop (`srcRect`); inherited font size, weight, and
colour; bullets and list levels; text insets; speaker notes; sections; tables;
chart type and values; and the report. Missing images export as a placeholder
and are reported rather than failing.

### Opened in a real application

The fixture was exported and converted by **LibreOffice Impress** (headless,
this machine) to PDF, then compared page by page with the SVG renderer's
output for all five slides. Backgrounds, geometry, rotation, colours, the
dashed line and arrowhead, crop, grouped objects, the table, the slide number,
and chart data and colours all matched. Speaker notes were checked
structurally (the render does not show them). Differences found:

- **PptxGenJS bug:** it writes an `<a:pPr>` before _every run_ of a multi-run
  paragraph. OOXML allows one, first. LibreOffice applied the last one
  (`buNone`, no margin) and silently dropped first-level bullets and indents.
  `repairParagraphXml()` now keeps only each paragraph's first `<a:pPr>`, and
  a test asserts every exported paragraph has at most one, first.
- Wrap points differ where the requested font (Inter) was substituted
  differently by each renderer. This is expected and is why the report lists
  every referenced font.
- Chart axes, gridlines, legend position, and axis maximum are LibreOffice's
  own, not Collab's. This is the "chart styling approximated" report entry.

### PptxGenJS quirks the adapter pins

| Quirk                                                                 | Handling                                           |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| `<a:pPr>` repeated per run                                            | Post-write repair pass, tested                     |
| Text `margin` array is `[left, right, bottom, top]`, contrary to docs | `margin()` reorders; insets asserted in EMU        |
| A change of `align` between runs starts a new paragraph               | Every run of a paragraph repeats its alignment     |
| Crop is "draw full image at w,h and show box x,y,w,h"                 | Full size derived from the crop; `srcRect` checked |

### Findings

| Finding             | Result                                                                |
| ------------------- | --------------------------------------------------------------------- |
| Licence             | MIT (PptxGenJS 4.0.1, JSZip 3.10)                                     |
| Bundle              | 140 KB gzipped ESM + 28 KB JSZip, only on first export (lazy)         |
| Worker feasibility  | **Yes** — exports with no `document`/`window` (node-environment test) |
| 300-slide export    | 384 ms, 834 KB                                                        |
| Masters and layouts | Flattened into slides in Phase 0; reported on every export            |
| Speaker notes       | Supported as plain text; formatting flattened and reported            |
| Groups              | Exported as individual objects; reported                              |
| Slide-number field  | Exported as fixed text; reported                                      |

**Decision for Phase 7:** proceed with PptxGenJS behind the adapter, with the
repair pass. Phase 7 must evaluate `defineSlideMaster` for real master/layout
export; if that — or further XML repairs — proves unreliable, the fallback is
a first-party OOXML writer behind the same `exportDeckToPptx` signature, which
the resolved-scene seam makes a contained change.

## PDF And Slide Images

`exportPdf.ts` renders each visible slide resolved scene → SVG → raster →
JPEG page, reusing the ink exporter's bounded PDF writer. Pages have the
slide's physical size (960 x 540 pt for widescreen, confirmed by `pdfinfo`),
the raster edge is bounded at 8,192 px, hidden slides are skipped unless
requested, and export is cancellable between slides. The fixture's SVGs
render correctly in an independent SVG engine (rsvg), and match LibreOffice's
rendering of the exported `.pptx` in layout and colour.

Raster pages make PDF text unselectable. **Open decision for Phase 5:** a
vector PDF writer (real text with embedded fonts) for handouts and
accessibility, or raster pages with an invisible text layer.

## Measured Baselines

Recorded 2026-09-28 on the development machine (Linux, AMD Zen 4, Node via
Vitest), best of five runs. Deck: 300 content slides, each a title, a
five-paragraph body, and four shapes.

| Operation                         | Measurement             |
| --------------------------------- | ----------------------- |
| Validate                          | 1.3 ms                  |
| Serialize (sorted, deterministic) | 9.0 ms → **1.49 MB**    |
| Parse and validate                | 9.0 ms                  |
| Resolve every slide               | 4.6 ms                  |
| One slide to SVG                  | 0.5 ms                  |
| Every slide to SVG                | 148 ms                  |
| Export to `.pptx`, 50 slides      | 303 ms cold, 71 ms warm |
| Export to `.pptx`, 300 slides     | 384 ms → 834 KB         |

### Budgets

Mirrored in `src/lib/deck/budgets.ts`, scalable with
`COLLAB_DECK_BUDGET_SCALE`; byte budgets are not scaled. Timings are best of
several runs, so a busy machine does not fail a healthy build.

| Budget (300-slide deck) | Ceiling |
| ----------------------- | ------- |
| Validate                | 20 ms   |
| Serialize               | 100 ms  |
| Parse and validate      | 150 ms  |
| Resolve every slide     | 50 ms   |
| One slide to SVG        | 8 ms    |
| Every slide to SVG      | 1.5 s   |
| Export to `.pptx`       | 5 s     |
| Stored bytes            | 4 MiB   |

## Risks And Mitigations

| Risk                                                                      | Mitigation                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Editing text wraps differently from rendered text at knife edges          | Measured (1 in 288 Latin cases on Chromium). Re-measure in the real editor; engine-positioned editing text is the fallback. |
| CJK line breaking is not implemented                                      | Recorded as a Phase 3 requirement; CJK is not a supported claim until it lands.                                             |
| The probe has only run in Chromium, but the Linux app is WebKitGTK        | Running it in the Tauri WebView on each platform is the open exit-gate item below.                                          |
| PptxGenJS needs XML repair and may need more                              | Repairs are isolated, tested, and reported; a first-party writer is a contained fallback.                                   |
| Preset shapes approximate OOXML formulas                                  | Exact `presetShapeDefinitions` ports are Phase 4; the difference is inside the documented export tolerance until then.      |
| Missing fonts change wrapping between Collab, PowerPoint, and LibreOffice | The export report lists every referenced font; font-missing diagnostics are Phase 10.                                       |
| A first-party text adapter must handle IME, accessibility, clipboard      | Accepted in exchange for owning the live schema; Lexical evaluation stays reproducible if the decision needs revisiting.    |

## Exit Gate Assessment

The plan's gate: _no editor implementation begins until text layout, CRDT text,
coordinate conversion, and PPTX export are demonstrably feasible._

| Exit-gate requirement                                                         | Status                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Freeze extension, media type, schema, units, limits, compatibility language   | **Met** — `src/types/deck.ts`, this document                            |
| 3-5 slide renderer proof: text, shapes, image crop, tables, theme inheritance | **Met** — five-slide fixture through `resolve.ts` and `svg.ts`          |
| Identical scene output in editor, thumbnail, and presentation mode            | **Met** — byte-identical SVG apart from output size                     |
| Compare text measurement/wrapping on Linux, Windows, and Android WebView      | **Partly met** — Chromium on Linux measured; other engines open         |
| Evaluate Lexical versus a first-party adapter                                 | **Met** — Lexical proven viable, not adopted, for the stated reason     |
| Same-text-box collaboration with `Y.Text` formatting                          | **Met** — ten concurrency cases against real Yjs                        |
| PPTX fixtures through an isolated PptxGenJS adapter                           | **Met** — structural tests plus a real LibreOffice render               |
| Inspect PPTX in PowerPoint, LibreOffice, and Google Slides                    | **Partly met** — LibreOffice done; PowerPoint and Google Slides open    |
| PDF and slide-image output                                                    | **Met** — SVG and PDF path; raster step proven with an injected encoder |
| Dependency licences, bundle impact, worker feasibility                        | **Met** — see the Lexical and PowerPoint findings                       |

### The open items

Two things cannot be done from the development machine alone.

**Text probe on the real WebViews.** Serve `tools/deck-text-probe.html`, open
it inside each target WebView, press Run, and copy the report into a "Device
Findings" section here:

- [ ] Linux desktop app (WebKitGTK) — the engine the Linux build actually uses
- [ ] Windows desktop app (WebView2)
- [ ] Android app (Android System WebView)
- [ ] macOS (WKWebView), if available

A Latin mismatch rate materially above Chromium's 1 in 288 on any of them
reopens the text architecture decision above.

**The generated file in other applications.** Export the fixture with
`COLLAB_DECK_FIXTURE_OUT=<dir> pnpm vitest run src/lib/deck/pptx` and open
`deck-fixture.pptx`:

- [x] LibreOffice Impress (headless render, this document)
- [ ] Microsoft PowerPoint desktop — including whether it offers to repair the file
- [ ] Google Slides import
- [ ] Apple Keynote, if a macOS machine is available

## Verification

```bash
pnpm vitest run src/lib/deck        # schema, units, resolver, layout, SVG, validation,
                                    # live text, Lexical evaluation, PDF, PPTX, budgets
pnpm exec tsc --noEmit
```
