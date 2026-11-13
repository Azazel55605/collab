# Supported File Types

Collab uses editable vault documents, binary assets, and import/export copies.
The same extension can have different handling in a dedicated workflow. For
example, desktop workbook import converts a CSV to `.sheet`, and the database
workspace exports query results as CSV.

## Vault Documents

| Type        | Desktop                                                                                                                                                              | Android companion                                                      | Hosted vault                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.md`       | Native Markdown editor, including editable Pages mode and per-page print preview.                                                                                    | Create, edit and browse notes.                                         | Text document with revisions and supported live editing.                                                   |
| `.markdown` | Accepted by Add files as text with the original filename. Use `.md` for the full local file-tree, search and shared classifier workflow.                             | Hosted Markdown documents open in the note editor.                     | A client can create it as a note. ZIP import uses the shared extension classifier, which recognizes `.md`. |
| `.canvas`   | Native canvas editor.                                                                                                                                                | Read-only canvas viewer.                                               | Structured document.                                                                                       |
| `.kanban`   | Native board editor.                                                                                                                                                 | Create and edit boards.                                                | Structured document.                                                                                       |
| `.sheet`    | Authoritative Collab workbook format.                                                                                                                                | Create and edit supported workbook content.                            | Structured document with revisions and supported live editing.                                             |
| `.ink`      | Native drawing editor.                                                                                                                                               | Create and edit drawings.                                              | Structured document with revisions and supported live editing.                                             |
| `.logic`    | Native logic and electronic schematic editor with local simulation.                                                                                                  | Read-only diagram viewer with supported simulation tools.              | Structured text document.                                                                                  |
| `.deck`     | Native presentation authoring and presenting.                                                                                                                        | Viewer and presenter workflows.                                        | Structured document with revisions and supported live editing.                                             |
| `.svg`      | Vector editor backed by the SVG text document.                                                                                                                       | Image viewing.                                                         | SVG text document with revisions.                                                                          |
| `.sql`      | Save or load SQL scripts through **Databases**. Scripts are text and require a user action and a bound database session to run. Add files does not offer SQL import. | Hosted scripts open in the note editor. SQL execution is desktop-only. | Text document. Connections, passwords, execution state and results stay outside the script.                |

A document's editor, live collaboration, offline availability and edit
permissions depend on the client and vault mode. The Android external upload
picker accepts Markdown, canvas, Kanban, logic, sheet, SVG, PDF and the common
raster formats below. Creating an ink drawing and opening a hosted deck use
their dedicated screens.

## Binary Assets And Local Databases

| Type                                                              | Handling                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`, `.avif` | Vault image assets. Desktop and Android can display them subject to decoder support. Desktop provides annotation and raster transforms. Permanent edits use supported output encoders and can flatten a frame.                      |
| `.apng`                                                           | Recognized by the Android hosted image viewer when supplied as a compatible asset. The separate extension is outside the desktop and Android Add files filters.                                                                     |
| `.pdf`                                                            | Binary document in the PDF viewer. Annotations and bookmarks are stored separately from the original. PDF exports are independent files.                                                                                            |
| `.sqlite`, `.sqlite3`, `.db`                                      | Open a local SQLite database in **Databases**. Explicit desktop vault import takes a consistent SQLite snapshot. Hosted storage treats it as a binary attachment. **Save SQLite copy…** produces a separate local file for editing. |
| `.mp4`, `.webm`                                                   | Native desktop video tabs in unencrypted local vaults. The system WebView supplies decoding.                                                                                                                                        |
| `.mp3`, `.wav`, `.flac`                                           | Native desktop audio tabs in unencrypted local vaults.                                                                                                                                                                              |
| `.vtt`, `.srt`                                                    | Desktop caption sidecars for local playback. UTF-8 SubRip is converted to WebVTT for playback only.                                                                                                                                 |
| `.lrc`                                                            | Desktop lyrics sidecar for audio in an unencrypted local vault. A matching basename supplies timed or plain lyrics in the audio player.                                                                                             |
| Other binary attachments                                          | Hosted vaults can carry generic downloadable assets through supported upload or ZIP workflows. Storage and download do not imply an in-app editor or player.                                                                        |

SQLite WAL, shared-memory and journal sidecars belong with the live database.
Export or import a standalone SQLite snapshot. SQL Server and MariaDB are
network connections, independent of vault file handling. See the
[database workspace](./desktop/database-workspace.md).

## Imports, Conversions And Exports

| Type               | Direction and handling                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.xlsx`            | Desktop spreadsheet import converts to `.sheet`. Workbook export produces a separate XLSX copy with a compatibility report.                                                                                 |
| `.xlsm`            | Desktop import extracts supported workbook content into `.sheet`. Macros are not carried into Collab or run.                                                                                                |
| `.csv`             | Desktop spreadsheet import converts delimited text into a `.sheet` workbook. Export from a workbook produces a CSV for the chosen sheet. Database results and supported circuit sweeps can also export CSV. |
| `.tsv`             | Desktop delimited-text import into `.sheet`.                                                                                                                                                                |
| `.pptx`            | Desktop presentation export from `.deck` with a conversion report. PowerPoint import is outside the current workflow.                                                                                       |
| `.pdf`             | Notes can print through the OS, including Save as PDF where provided. Presentations and drawings offer PDF export. Exported PDF can be brought back as a PDF asset.                                         |
| `.png`, `.svg`     | Export copies from presentations and drawings. SVG is also used for schematic, circuit plot and note-embed outputs.                                                                                         |
| `.jpg`, `.webp`    | Supported desktop raster edit output alongside PNG. JPEG output commonly uses `.jpg`.                                                                                                                       |
| `.json`            | Typed database results and desktop performance reports can export JSON. Kanban templates can import and export JSON. Generic JSON has no dedicated vault editor.                                            |
| `.kanban-template` | Accepted by the desktop Kanban template importer. Template exports use `.json`.                                                                                                                             |
| `.ics`             | Calendar iCalendar import, export and feeds. Hosted CalDAV uses iCalendar resources.                                                                                                                        |
| `.zip`             | Vault archive transport through the applicable vault import or download workflow. The hosted importer classifies entries individually.                                                                      |

## Server Backup Files

Server backup and restore use gzip-compressed tar archives containing database
metadata, a PostgreSQL dump, and blob data. The admin UI downloads `.tar.gz`
and accepts both `.tar.gz` and `.tgz` in its restore picker. These archives are for server operations.
A vault ZIP exports current vault content and has a different restore workflow.
See the [server backup guide](./server/backups.md).

See the [workbook conversion matrix](./desktop/sheet-conversion.md) and the
[PowerPoint export matrix](./desktop/presentation-pptx-export.md) for fidelity and
format-specific limits. The [local media playback guide](./desktop/media-playback.md)
describes codecs, captions and tab behavior.
