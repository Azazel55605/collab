# Source Editor

Use **Files → Create → New source file** in a local or hosted vault, or add an existing
file through **Add files to vault** or drag and drop. You can also copy a file
into a local vault folder with your system file manager. The file tree and Command
Bar open it in a regular document tab.

Collab chooses the language from the filename. For the full list, see the
[supported file types](../file-types.md). The language picker changes the editor
mode for the open tab. SQL scripts open here from **Files** and can still be
loaded, saved, and run from **Databases**.

- **Save** or **Ctrl/Cmd+S** writes your changes. Switching away from a dirty
  tab uses Collab's save-before-navigation check.
- **Find / replace**, **Go to line**, and **Source file actions → Wrap lines**
  work inside the current document. Code defaults to horizontal scrolling.
  TXT wraps by default.
- **Source file actions → Version history** opens saved snapshots for local files.
  If a different application changes the file while you are editing, use the
  document status controls to review the change or **Save draft as copy**
  in the source file menu to recover your edits.

Use the gutter to fold blocks when the language grammar exposes a foldable
region. **Source file actions → Show outline** jumps to parsed declarations
in supported languages. **Syntax problems** opens the parser diagnostics
panel where available. These diagnostics report syntax errors while you type
and leave drafts saveable. Completion uses the same styling as the SQL editor.
Suggestions and snippets depend on the selected language.

Open **Search → Source files** to search literal text in the current vault.
Selecting a result opens its file and selects the match on the reported line.
Each search checks up to 200 source files, 16 MiB of text, and 100 matching
lines. Only files within the editor limits and available to the current vault
session are searched. Search results use the normal vault read path and do
not create a source index on disk.

The editor preserves UTF-8, a UTF-8 BOM, uniform LF or CRLF, and final newlines.
You can save unfinished code or JSON. Files with mixed line endings, unsupported
encoding, or sizes beyond the editor limits open with an explanation and a
read-only excerpt where available.

The editor limits are 1 MiB, 50,000 lines, and 16 KiB per line. Add Files accepts
source files up to 16 MiB. For larger files, use the system file manager to place
them in a plain local vault and open the excerpt. **Download original** streams a
copy of plain files. Encrypted originals can be copied up to 256 MiB after the
vault is unlocked and the file is authenticated.

## Hosted vaults

Update the server before creating or editing hosted source files. Hosted edits
use file permissions and revision checks. An offline replica can open cached
source files and queue permitted edits. Queued edits survive restart and sync on
reconnect. If a server revision changed in the meantime, use the conflict
controls to review it or recover the draft as a new file. Source files use
revision saves and do not participate in live co-editing.

Earlier uploads may still appear as attachments. Use **Create editable copy**
to make a sibling source document from valid UTF-8 content. The original keeps
its identity, links, history, and permissions. The copy uses the destination’s
permissions. **Download original** and vault ZIP exports preserve the stored
bytes.

See the [supported file types](../file-types.md) and
[Source Editor plan](../plans/source-editor-plan.md).
