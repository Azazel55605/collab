# Source Editor Phase 0 Contract

The Phase 0 prototype qualifies the standalone editing surface and defines its
initial file contract. The file tree, import, saves, and hosted vaults adopt the
contract in later phases. See the [Source Editor plan](./source-editor-plan.md).

## Text and filename contract

- The initial filename policy accepts `.txt`, `.json`, `.py`, `.c`, `.h`,
  and `.cs` case-insensitively. TXT is plain text. C headers default to C.
  Hidden components and names already claimed by the shared classifier are
  excluded, including the PDF annotation suffixes `.pdf.json` and
  `.pdf-sidecar.json`. Normal vault path checks still apply. File admission is
  independent of the language picker.
- Use strict UTF-8. Keep the original UTF-8 BOM, if present, as format metadata.
  Normalize the editor buffer to LF and re-encode to the original uniform line
  ending on save. LF is the default if the source has no line endings. The
  buffer retains the number of final line breaks. Preserve intentionally
  unfinished or invalid source syntax, including JSON.
- Open mixed LF/CRLF and bare-CR files read-only with an explanation. Keep the
  original bytes available for download. Detect invalid UTF-8 and binary C0
  or DEL controls before opening the editor. Tabs, line endings, and form feeds are
  valid text. Show a download action and explain the unsupported content
  when decoding fails.
- Use the original stored revision as the save precondition. For local vaults
  that means the hash of the decoded original bytes, including BOM and line
  endings. Keep the raw base version alongside the editor state and report
  a conflict if an external change would overwrite the user's draft. Verify
  fidelity after any merge before applying it.

The [shared source-text module](../../crates/collab-documents/src/source_text.rs)
prototypes classification and the format codec. Its tests cover BOM, Unicode,
newlines, edits to CRLF files, invalid UTF-8, and reserved suffixes. Local
`read_note` already preserves UTF-8 text bytes and returns their hash. The
frontend adapter needs to preserve format metadata when handing text to
CodeMirror. The current Add Files decoder defaults to replacement decoding, so
the source import path needs strict decoding.

## Editor admission and fallback

Use **1 MiB of original UTF-8 bytes**, **50,000 lines**, and **16 KiB of bytes
per line** as starting limits for an editable document. Enforce bounded reads
at the vault adapter before handing a document to the WebView. Measure these
limits again with the full editor extensions, local and hosted IPC, and
representative hardware before release.

For larger files, show the reason in the document pane and offer a bounded,
unhighlighted read-only excerpt where the vault adapter can supply one. Cap
the excerpt at 64 KiB or 200 lines, whichever comes first, and end at a valid
UTF-8 boundary. Show a download action for the original file. Encrypted mode
needs the existing authenticated read semantics before exposing any excerpt.
The spike measures editor admission after obtaining its synthetic fixture
strings. It establishes a frontend limit, leaving bounded vault I/O for
Phases 1 and 2.

## Hosted classification decision

Use a dedicated source kind in the shared document classifier when Phase 1
connects the prototype to production routing. The initial prototype keeps the
source predicate separate from `classify_path` so local listing and hosted ZIP
import retain their existing behavior during this phase.

| Hosted option                                | What the current code implies                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse the wire `note` type and route by path | Existing clients can read the enum. Older clients may route a source file through Markdown and enable note indexing or text collaboration. Hosted ZIP import, revisions, and live eligibility would each need explicit path guards.                                                                                                                                  |
| Add a dedicated wire `source` type           | Clear semantics for revisions, search, and live eligibility. A new database enum value and protocol variant are needed. Older Rust clients decode `HostedFileEntry` in manifests and deltas using a closed enum, so advertising the new value can fail the entire decode. The replica adapter and every client that consumes the manifest need a compatibility path. |

Prefer the dedicated hosted type in Phase 2, after demonstrating mixed-version
manifest and replica compatibility or coordinating a minimum client version.
Keep current hosted wire types and ZIP classification in Phase 0. Handle
existing generic attachments with an explicit editable-copy workflow unless a
migration can preserve IDs, revisions, ACLs, and replica history. Keep existing
SQL document storage and the Databases Load Script flow during that rollout.

[Protocol manifest and delta](../../crates/collab-protocol/src/lib.rs),
[hosted ZIP classifier](../../crates/collab-server/src/api/archive.rs),
[hosted revision writes](../../crates/collab-server/src/api.rs),
[server live rooms](../../crates/collab-server/src/ws.rs),
[desktop vault adapter](../../src/lib/vaultClient.ts).

## Reproduce the probe

Run from the repository root with a graphical desktop session and the existing
Tauri development dependencies. Use the temporary directory for the compiled
frontend and remove it after the run.

```bash
source_probe_dir="$(mktemp -d)"
pnpm exec vite build tools/source-editor-spike --outDir "$source_probe_dir"
cargo build -p collab --release --example source_editor
python tools/source-editor-spike/run.py "$source_probe_dir" target/release/examples/source_editor
cargo test -p collab-documents source_text --lib
rm -rf -- "$source_probe_dir"
```

On Windows, pass `source_editor.exe` as the executable. The standalone Tauri
example renders built assets in the system WebView. It serves only the fixture
directory on loopback, uses synthetic source strings, and emits a timing report
to stdout. Times cover editor work plus two animation frames, so they include
display refresh scheduling. The typing samples are CodeMirror transactions.
They exclude OS input latency and vault writes. The example measures the native
WebView before Phase 1 integrates the editor into the installed app.

## Linux evidence

On 2026-11-17 the optimized Tauri example ran twice on Linux x86-64 with
WebKitGTK 2.54.2. Both runs detected the expected mode and produced highlighted
ranges for JSON, Python, C, C headers, and C#. TXT produced zero highlighted
ranges. Both passed the editor-buffer line-ending check and rejected each of
the three independent byte, line count, and line length overflow cases.

| Measurement                           | Fixture                                  | Native results                    |
| ------------------------------------- | ---------------------------------------- | --------------------------------- |
| First editor mount                    | Plain text                               | 573–730 ms                        |
| First fixture open after editor mount | Initial highlighted modes                | 63–306 ms                         |
| Warm tab switches                     | Six retained editor states               | 109–260 ms                        |
| Large file open                       | Python, 1,011,978 bytes and 46,000 lines | 1,001–1,864 ms                    |
| Large file typing                     | Ten transactions per run                 | 159–224 ms median, 405 ms maximum |
| Long line open                        | Python, 16,370 UTF-8 bytes on one line   | 231–255 ms                        |
| Long line typing                      | Ten transactions per run                 | 144–189 ms median, 331 ms maximum |

Workspace verification and builds were running concurrently. These timings
provide a loaded-host baseline for Phase 1, with full-editor latency and
installed Linux, Windows, and macOS validation still pending.
