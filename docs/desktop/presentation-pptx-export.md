# PowerPoint (`.pptx`) Export Support Matrix

Collab writes a presentation **out** as a separate, editable `.pptx` copy. The
`.deck` stays the only editable and authoritative presentation format: export
never changes it, and an exported copy never becomes the backing file of the
open deck. Collab does not import `.pptx` (deferred, see the
[plan](../plans/presentation-tool-plan.md)).

Export: **Export or print** (Ctrl+P) → **PowerPoint (.pptx)**. It runs in a
background worker with progress and can be cancelled. After every export a
report lists what was written exactly and every entry that was approximated,
flattened, omitted, or missing, with the slides it applies to and the fonts
the file uses.

Implementation: `src/lib/deck/pptx/` (a first-party Office Open XML writer).
Executable contract: `exportDeckToPptx.test.ts` (package structure and
semantics) and `compatibility.test.ts` (renders in LibreOffice Impress and
compares with Collab's rendering).

## What is exported

| Deck feature                                                    | In the `.pptx`                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Slide size (any preset or custom)                               | Exact (EMU; one deck unit is exactly 127 EMU)                                                      |
| Slide order, names, sections                                    | Exported                                                                                           |
| Hidden slides                                                   | Exported as hidden slides                                                                          |
| Theme: twelve colours, heading and body fonts                   | The file's theme, slot for slot                                                                    |
| Masters and layouts: artwork, backgrounds, placeholders         | PowerPoint slide masters and layouts; "show master artwork" kept                                   |
| Placeholder prompts                                             | Custom layout prompts                                                                              |
| Slide placeholders (title, subtitle, body, date, footer, …)     | Linked to the layout's placeholder; position and formatting kept on the slide                      |
| Slide numbers                                                   | Live slide-number fields                                                                           |
| Backgrounds (colour, image)                                     | Exported                                                                                           |
| Rich text: font, size, bold, italic, underline, strike, colour  | Exported, fully resolved on every run                                                              |
| Superscript, subscript, language                                | Exported                                                                                           |
| Alignment, line spacing, space before/after, indents            | Exported                                                                                           |
| Bullets and numbering, list levels                              | Exported (numbering continues and restarts as in Collab)                                           |
| Soft line breaks                                                | Exported                                                                                           |
| Text box insets, vertical alignment, wrap                       | Exported                                                                                           |
| Auto-fit: shrink                                                | Exported with Collab's computed scale, so every viewer draws the same size                         |
| Auto-fit: grow                                                  | Exported ("resize shape to fit text")                                                              |
| Web and e-mail links                                            | Exported                                                                                           |
| Links to another slide                                          | Exported as slide jumps (when that slide is exported)                                              |
| Shapes (all fourteen presets), fill, outline, dash, opacity     | Exported                                                                                           |
| Rotation and flips                                              | Exported                                                                                           |
| Lines and arrows, both ends                                     | Exported as connectors with arrowheads                                                             |
| Groups (nested)                                                 | Exported as groups                                                                                 |
| Images: PNG, JPEG, GIF                                          | Exported, with crop, opacity, and border                                                           |
| Images: SVG                                                     | Exported as SVG with a high-resolution picture fallback for viewers without SVG                    |
| Alt text and object names                                       | Exported                                                                                           |
| Tables: cells, merged cells, header row, fills, borders, insets | Exported as native tables                                                                          |
| Charts: column, bar, line, area, pie                            | Native, editable charts with an embedded workbook; data, series colours, title, legend, fonts kept |
| Speaker notes                                                   | Exported with formatting                                                                           |

## Approximated, flattened, or omitted

Each of these is listed in the export report when it applies.

| Deck feature                        | In the `.pptx`                                                                                      | Report       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ |
| Chart axis spacing and ticks        | The viewer's own chart layout                                                                       | Approximated |
| Rotated tables or charts            | Exported upright (PowerPoint cannot rotate them)                                                    | Approximated |
| Fonts not installed on this machine | The file asks for the deck's font; viewers without it substitute, which can change where lines wrap | Approximated |
| SVG with no picture fallback        | Only when the fallback cannot be drawn; older PowerPoint versions cannot show it                    | Approximated |
| Linked documents                    | Their preview picture                                                                               | Flattened    |
| Links to vault files                | Plain text (they have no meaning outside Collab)                                                    | Omitted      |
| Transition duration                 | Fade, push, and wipe are native; the exact duration maps to PowerPoint's nearest preset speed       | Approximated |
| Object animations                   | Base objects remain visible; cues are outside the physically proven OOXML subset                    | Omitted      |
| Images that were not available      | A grey placeholder of the same size                                                                 | Missing      |

## Validated in

| Application                      | Status                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| LibreOffice Impress 24.2         | Rendered and compared slide by slide with Collab: the fixture and all four built-in designs (29 slides). |
| python-pptx (independent reader) | Opens the file; masters, layouts, placeholders, groups, tables, charts, and notes read back as written.  |
| Microsoft PowerPoint             | Not yet validated on a machine with PowerPoint; release validation item.                                 |
| Google Slides                    | Not yet validated; release validation item.                                                              |
| Apple Keynote                    | When a macOS validation machine is available.                                                            |

Run the LibreOffice comparison with
`COLLAB_PPTX_RENDER=1 pnpm vitest run src/lib/deck/pptx/compatibility.test.ts`
(needs `soffice` with Impress, `pdftoppm`, and `rsvg-convert`); set
`COLLAB_DECK_FIXTURE_OUT=<dir>` to keep the `.pptx` files and renders.
