# Source Editor

**Status — Draft for review**

Open plain-text and source files in ordinary Collab document tabs. Keep the
Markdown editor’s tab strip, document header, typography, theme, and sidebar
behavior. Give source files an editing surface built around fast keyboard
navigation, syntax highlighting, and predictable saves to their original paths.

## What Collab already has

| Area               | Existing foundation                                                                                                                                                                                                                                                                                                                                                                                                                                       | Work for the source editor                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editing surface    | The Markdown code-block dialog has a CodeMirror 6 surface with line numbers, undo and redo, indentation, highlighting, and completion. It shares editor preferences and completion icons with the database SQL editor. [Code-block editor](../../src/components/editor/CodeBlockEditorDialog.tsx), [SQL editor](../../src/components/database/SqlEditor.tsx)                                                                                              | Extract the reusable surface from the dialog and give it a document lifecycle. Keep Markdown-specific features in the note editor.                                             |
| Language support   | The installed CodeMirror catalog loaded JSON, Python, C, C++, C#, and the proposed follow-on languages below. C and C++ use a shared grammar. C# uses a tokenizer that provides highlighting with a smaller feature set. [Existing language loader](../../src/components/editor/codeBlockUtils.ts)                                                                                                                                                        | Detect the language by filename, load it lazily, and allow a manual language override. Test features per language.                                                             |
| Document lifecycle | The shell already routes document tabs, and the document session controller handles dirty state and save coordination. The vault client has local hash-based and hosted revision-based text reads and writes. [Shell](../../src/components/layout/AppShell.tsx), [Session controller](../../src/lib/documentSessionController.ts), [Vault client](../../src/lib/vaultClient.ts)                                                                           | Add a source tab, carry cursor and viewport state across tab switches, and verify raw-text fidelity and conflict handling across vault modes.                                  |
| File acceptance    | Desktop Add Files has a separate import classifier. The local file tree and hosted ZIP import use the shared Rust document classifier. The frontend routes unmatched paths to the note editor. SQL scripts already use text storage. [Import](../../src/lib/vaultFileImport.ts), [Document classifier](../../crates/collab-documents/src/lib.rs), [Hosted ZIP](../../crates/collab-server/src/api/archive.rs), [Tab routing](../../src/lib/vaultLinks.ts) | Agree on supported filenames and make import, listing, storage, search results, and tab routing use the same rules. Review older hosted clients before adding a protocol type. |

## Proposed file coverage

| Delivery              | Files                                                                                                                                                | Handling                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial set           | `.txt`, `.json`, `.py`, `.c`, `.h`, `.cs`                                                                                                            | Plain text for TXT. Syntax highlighting for the others. Default `.h` to C and offer C++ in the language picker.                                                                                                         |
| Expansion set         | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.js`, `.jsx`, `.ts`, `.tsx`, `.html`, `.css`, `.xml`, `.yaml`, `.yml`, `.toml`, `.rs`, `.go`, `.java`, `.sh`, `.sql` | Use the installed language catalog. Treat markup, scripts, and configuration as source text. Open SQL files as source in Files, and retain the existing Load Script workflow in Databases.                              |
| Candidates for review | `.ini`, `.log`, `.jsonc`, `.csproj`, selected extensionless names, selected dotfiles, raw CSV/TSV                                                    | Decide which belong in the vault catalog. Offer raw CSV/TSV through an explicit source workflow alongside workbook conversion. Review sensitive dotfiles and existing hidden-file rules before expanding that boundary. |

Apply filename rules case-insensitively and give existing native document,
sidecar, and conversion routes precedence. In particular, preserve the special
handling for PDF annotation sidecars when enabling generic JSON. A language
picker only changes the editor mode. Files keep their names, extensions, and
source text. See the [current file type matrix](../file-types.md).

## The editor

- Reuse the document top bar with the filename, folder, save state, and a
  compact actions menu. Put line and column, language, indentation, and line
  endings in a status row. Focus the editor when a document opens.
- Start with line numbers, active line and selection styling, matching brackets,
  automatic indentation where available, undo and redo, find and replace, go
  to line, toggle comment where supported, and a wrap toggle. Default to
  horizontal scrolling for code and wrapping for plain text. Reuse Collab’s
  keyboard shortcuts and editor preferences.
- Add folding, parser diagnostics, basic completions, snippets, and an optional
  symbol outline in the next pass. Offer these per language. Reuse Collab’s
  completion styling and icon set. Keep the toolbar compact by putting
  secondary actions in the menu or Command Bar.
- Treat JSON and code as editable drafts throughout. Syntax errors can appear
  in the editor while save still preserves the draft. Formatting is an explicit
  action. Project-aware completions, cross-file rename, language servers, and
  build and debug integration are separate proposals.

## Implementation phases

### Phase 0 — Contract and prototype

- Confirm the initial language set in CodeMirror with representative fixtures.
  Measure cold open, typing, switching between files, and long lines in a
  packaged desktop build. Use those results to set editable size and line
  limits and a readable fallback with download for oversized files.
- Define the text fidelity contract. Start with strict UTF-8, keep a UTF-8 BOM
  when present, and preserve LF, CRLF, and the presence of a final newline.
  Decide how to handle mixed line endings before enabling saves for them.
  Invalid UTF-8 or binary-looking input should get a clear message and a
  download option. Carry encoding and line-ending metadata through reads and
  writes if the current text adapter loses it.
- Prototype a source document kind in the shared classifier. Compare a dedicated
  hosted protocol type with the existing text representation paired with
  path-based source routing. Audit old manifests, replicas, ZIP file
  classification and older clients before changing the wire format.

### Phase 1 — Desktop local files

- Extract the CodeMirror surface with its theme, indentation preferences, and
  language loading. Preserve the Markdown code-block dialog and database editor
  behavior through their existing entry points.
- Add a source tab and an editor view. Support creating a source file, Add
  Files, desktop drag and drop, and opening files already in a local vault.
  Wire up the file tree, Command Bar filename search, links, tab restoration,
  and document focus.
- Reuse the document session for saving, read-only access, close handling,
  history where supported, and external edits. Use the expected hash on saves
  and retain unsaved text on a conflict. Verify plain and encrypted local
  vaults. Keep source content out of Markdown-specific backlinks, tags, and
  graph indexing.

### Phase 2 — Hosted vaults and replicas

- Apply the agreed classification to hosted creation, upload, ZIP import,
  revisions, and download. Keep ACLs, quotas, path validation, and the
  existing revision conflict flow. Validate source encoding and size on the
  server, and leave syntax validation to the editor.
- Verify opening, saving, export, and offline replica behavior across restart
  and reconnect. Handle previously uploaded copies that are stored as assets
  through a documented migration or an explicit editable-copy action. Preserve
  existing file IDs, links, history, and permissions for any in-place migration.
- Keep live co-editing as a separate milestone. Validate merge semantics and
  text fidelity before enabling it for source files.

### Phase 3 — IDE features, wider file coverage, and release testing

- Roll out the expansion set after checking language behavior. Add folding,
  diagnostics, completion, and outline features incrementally.
- Add bounded vault-wide source content search as a follow-up to filename
  search. Use file and line results and respect vault encryption and permissions.
- Test routing, read-only access, rename and reopen, Unicode, BOM, CRLF,
  unfinished JSON, large files, conflicts, and import or export round trips.
  Update the supported file type matrix and desktop user guide alongside
  implementation. Include packaged Linux, Windows, and macOS tests for
  shortcuts and performance.

## Decisions for review

- **Release order** — Start with desktop local editing, then enable hosted
  editing once server and replica compatibility are verified. Decide whether
  Android should start with a source viewer or wait for touch editing.
- **File coverage** — Confirm the initial and expansion sets. Decide whether
  users should be able to opt into opening additional UTF-8 extensions, and
  which extensionless names and dotfiles should be visible.
- **Editing defaults** — Decide whether source files share the note
  autosave preference or get their own. Confirm wrapping and indentation
  defaults and whether the first release needs the optional outline.
