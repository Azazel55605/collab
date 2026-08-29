# `.sheet` Conversion Support Matrix

Collab converts `.xlsx` and `.csv` **into** a new `.sheet` document, and writes
`.sheet` **out** as a separate `.xlsx` or `.csv` copy. That is the whole promise.

**Collab does not open `.xlsx` or `.csv` as an editable document, does not keep
them in sync, and does not guarantee lossless round trips.** `.sheet` is the only
editable and authoritative workbook format. The source file of an import is
never modified, and an exported copy never becomes the backing file of the open
workbook.

Implementation: `crates/collab-sheet/src/convert/`. Executable contract:
`crates/collab-sheet/tests/conversion_proof.rs`.

## Import: `.xlsx` → `.sheet`

| Feature                                                                        | Support                                                                                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Worksheet names, order, and hidden state                                       | Imported                                                                                     |
| Numbers, text, booleans, dates, times                                          | Imported                                                                                     |
| Shared strings, inline strings, rich-text runs                                 | Imported (runs are concatenated to plain text)                                               |
| Stored error values (`#REF!`, `#DIV/0!`, …)                                    | Imported as text; Collab only produces error _values_ from its own evaluation                |
| Formula source                                                                 | Imported; Collab recalculates rather than trusting the stored result                         |
| Shared formula groups                                                          | Imported, with references translated per cell                                                |
| Array and data-table formulas                                                  | **Flattened** to ordinary single-cell formulas; may compute a different result               |
| Functions outside the supported baseline                                       | **Unsupported** — source kept, cell shows an error, and each function is named in the report |
| Number formats: general, number, percent, currency, date, time, datetime, text | Imported                                                                                     |
| Other custom format codes                                                      | Imported as a declarative `custom` pattern, never evaluated                                  |
| Font family, size, bold, italic, underline, strikethrough, color               | Imported                                                                                     |
| Solid fill color                                                               | Imported (the two default `none`/`gray125` fills are ignored)                                |
| Cell borders                                                                   | Imported as thin edges; per-edge styles and colors are not mapped                            |
| Horizontal/vertical alignment, wrap, indent                                    | Imported                                                                                     |
| Merged ranges                                                                  | Imported                                                                                     |
| Column widths, row heights, hidden rows                                        | Imported (converted from character/point units to CSS pixels)                                |
| Frozen panes                                                                   | Imported                                                                                     |
| Charts                                                                         | **Skipped** — rebuild from the imported ranges with Collab's chart tools                     |
| Pivot tables and caches                                                        | **Skipped**                                                                                  |
| Conditional formatting, data validation, structured tables                     | **Skipped**                                                                                  |
| Drawings, images, shapes, embedded objects                                     | **Skipped**                                                                                  |
| Threaded comments                                                              | **Skipped**                                                                                  |
| VBA macros                                                                     | **Never imported.** Collab does not import or run macro code                                 |
| External workbook links                                                        | **Skipped**; the referencing cells keep their last stored value                              |
| External data connections, Power Query, query tables                           | **Skipped**; last refreshed values import as plain cells                                     |

Everything marked flattened, skipped, or unsupported appears in the conversion
report the user sees before relying on the result.

## Import: `.csv` → `.sheet`

CSV has no workbook model, so an import always produces exactly one worksheet
with no formulas, styles, or formatting.

| Behavior          | Detail                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Delimiter         | Sniffed from `,` `;` tab `\|`, or set explicitly                                                                          |
| Quoting           | RFC 4180: quoted fields, escaped `""`, and newlines inside quotes                                                         |
| Line endings      | LF and CRLF                                                                                                               |
| Encoding          | UTF-8 and UTF-16 byte-order marks are honored; otherwise UTF-8, falling back to Latin-1                                   |
| Type inference    | Optional, on by default. Converts unambiguous numbers, `true`/`false`, and ISO dates/datetimes                            |
| Identifier safety | A leading zero (`01234`) or a leading `+` (`+31201234567`) stays text — losing it would be data corruption, not inference |
| Header row        | Optional. The row is imported as cells and becomes a frozen row                                                           |

## Export: `.sheet` → `.xlsx`

| Feature                                                                                                                            | Support                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Worksheets, order, hidden state                                                                                                    | Exported                                                                                                |
| Numbers, text, booleans, dates, times                                                                                              | Exported (dates become serial numbers with a date format)                                               |
| Formula source                                                                                                                     | Exported; the receiving application recalculates                                                        |
| Number formats with a faithful equivalent                                                                                          | Exported                                                                                                |
| Font, fill, border, alignment, wrap, indent                                                                                        | Exported                                                                                                |
| Merged ranges                                                                                                                      | Exported                                                                                                |
| Column widths, row heights, hidden rows                                                                                            | Exported                                                                                                |
| Frozen panes                                                                                                                       | Exported                                                                                                |
| Worksheet names                                                                                                                    | Sanitized to `.xlsx`'s stricter rules (no `\ / ? * [ ] :`, 31 characters), and every rename is reported |
| Charts, conditional formatting, data validation, structured tables, named ranges, protected ranges, cell links, attachments, notes | **Not written.** Reported on every export                                                               |
| Anything executable                                                                                                                | **Never written.** No macro, connection, external-link, or query part is emitted                        |

## Export: `.sheet` → `.csv`

CSV carries values only. One worksheet or one range is written; when the
workbook has more than one worksheet, that is reported.

The export dialog asks which worksheet or range to write, states how many
worksheets will be left out, and offers the delimiter.

**Formula-injection protection is on by default.** A field starting with `=`,
`+`, `-`, `@`, or a tab is prefixed with an apostrophe so a spreadsheet opening
the file displays it instead of executing it. Writing formula _source_ instead
of values is a separate explicit choice, and even then the prefix still applies
unless the user also turns protection off — which shows a warning first.

## Limits

A conversion runs under the normal `.sheet` limits (see
`docs/desktop/sheet-reference.md`) plus these archive bounds, which exist
because reading `.xlsx` means unpacking untrusted compressed data:

| Bound                               | Value   |
| ----------------------------------- | ------- |
| Source file                         | 64 MiB  |
| Total uncompressed bytes read       | 512 MiB |
| Bytes from any single archive entry | 128 MiB |
| Archive entries                     | 4,096   |

An archive with an entry name containing `..`, a leading `/`, or a backslash is
refused outright. A file that exceeds a bound fails with a clear error; it is
never silently truncated into a partial workbook.

## Where Conversion Is Available

Desktop only. Import is reached from the Files sidebar "Add files" button and
by dropping a file onto the file tree; export is in the workbook's Export menu.
Both work for local and hosted vaults — the converted document is created
through the normal `VaultClient` — and both are unavailable to a hosted viewer,
like every other write.

The Android app does not convert. It opens `.sheet` documents that were
converted on desktop.

## Round Trips

Round trips are **lossy and not guaranteed**. The tested claim is semantic, not
binary: `conversion_proof.rs` exports a workbook, re-imports it, and compares
values, formulas, merges, frozen panes, and the style properties listed above.
It never compares bytes, and neither should anything else.

Two conversions of the same file are deterministic, but a file that has been
through another application in between may differ in ways Collab cannot see.
