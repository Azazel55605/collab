# Source Editor

Use **Files → Create → New source file** in a local vault, or add an existing
file through **Add files to vault** or drag and drop. You can also copy a file
into the vault folder with your system file manager. The file tree and Command
Bar open it in a regular document tab.

The starter formats are TXT, JSON, Python, C, C headers, and C#. Collab detects
the language from the filename. The language picker changes highlighting for
the open tab. The file keeps its original name and extension.

- **Save** or **Ctrl/Cmd+S** writes your changes. Switching away from a dirty
  tab uses Collab's save-before-navigation check.
- **Find / replace**, **Go to line**, and **Source file actions → Wrap lines**
  work inside the current document. Code defaults to horizontal scrolling.
  TXT wraps by default.
- **Source file actions → Version history** opens saved snapshots.
  If a different application changes the file while you are editing, use the
  document status controls to review the change or **Save draft as copy**
  in the source file menu to recover your edits.

The editor preserves UTF-8, a UTF-8 BOM, uniform LF or CRLF, and final newlines.
You can save unfinished code or JSON. Files with mixed line endings, unsupported
encoding, or sizes beyond the editor limits open with an explanation and a
read-only excerpt where available.

The editor limits are 1 MiB, 50,000 lines, and 16 KiB per line. Add Files accepts
source files up to 16 MiB. For larger files, use the system file manager to place
them in a plain local vault and open the excerpt. **Download original** streams a
copy of plain files. Encrypted originals can be copied up to 256 MiB after the
vault is unlocked and the file is authenticated.

See the [supported file types](../file-types.md) and
[Source Editor plan](../plans/source-editor-plan.md).
