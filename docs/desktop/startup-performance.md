# Desktop Startup And Packaged Assets

O01–O09 implementation completed **2026-10-20**. The maintained gate measures
production assets; it does not infer native launch time, evaluated JS or RSS.
See [the audit](../audits/desktop-performance-and-bugs-2026-10-14.md) and
[implementation/verification tracker](../plans/desktop-audit-fixes.md).

## Reproduce The Gate

`pnpm build` prepares local assets, checks types, emits the Vite manifest and
runs the budget gate. `pnpm bundle:check` checks an existing `dist/` build.
To preserve local build output while measuring:

```bash
node scripts/prepare-ocr-assets.mjs
node scripts/prepare-highlight-languages.mjs
node scripts/prepare-font-assets.mjs
pnpm exec vite build --manifest --emptyOutDir --outDir /tmp/collab-startup-measurement
node scripts/report-desktop-bundle.mjs /tmp/collab-startup-measurement --check-budgets
```

Use a dedicated temporary directory: `--emptyOutDir` removes its previous
contents and prevents old hashed chunks/fonts from contaminating measurements.
The report follows static imports from the entry and excludes dynamic imports
until requested. Gzip totals compress each JS file separately. It also reports
CSS, all packaged fonts, worker assets, OCR resources, total packaged bytes and
the largest JS chunks with their initial/deferred status.

[startup-bundle-budgets.json](./startup-bundle-budgets.json) defines measured asset
ceilings with headroom. CI verifies the generated catalogs, builds the desktop
frontend, enforces the gate and retains `desktop-startup-report` for seven days.
Review a threshold change against an actual report and the intended feature;
do not raise limits or suppress chunk warnings to conceal an eager import.
The gate also rejects missing deferred entries and duplicate PDF workers, even
when total bytes still fit. Large **deferred** Mermaid/plot/language chunks still
exist; their optimization is separate from startup loading.

## Feature Boundaries

- Shell/grid/chat/print views share `views/deferredViews.ts`. Module failures
  remain local to the view; browsers may require an application restart to retry
  a failed module URL. Save other work before restarting.
- Root Settings and plot hosts keep lightweight listeners mounted. Profile/tab
  and plot requests survive a pending import; Escape can close loading/error
  dialogs. Print-preview title changes are restored on unmount.
- Icon query/completion helpers are lightweight; the glyph registry loads only
  for an open picker/icon command. Both singular/plural aliases and `nf` work.
- Markdown preview registers common grammars immediately. A recognized uncommon
  fence loads the full remaining Highlight.js catalog, preserving embedded
  grammars and aliases. Unknown fences remain escaped plaintext; optional
  highlighting failure also leaves the source readable. Print readiness waits
  for this work. CodeMirror retains its existing lazy language-parser loaders.
- PDF consumers share the existing **legacy compatibility** API and matching
  local worker. One emitted asset does not mean one running worker or a heap cap.

## Fonts And Offline OCR

WOFF2 is supported by the project's modern WebViews. Generated font styles keep
all existing mono Unicode subsets, math faces, interface fonts and font choices,
and remove duplicate WOFF/TTF alternatives. Geist and Inter remain variable;
Fira Code/JetBrains Mono retain their existing 400-normal subsets and browser
bold synthesis. Nerd Font keeps both family aliases and uses `font-display: swap`.
`prepare-font-assets.mjs --check` detects dependency/style drift; the unit audit
compares every installed mono subset and KaTeX face against generated CSS.
Font files in a package are not automatically startup downloads.

Core WASM OCR and English remain **mandatory offline release assets**. Additional
language packs remain explicit optional installations through existing settings;
there is no new first-use CDN dependency or automatic language download. The
four core assets total 17,786,212 bytes, plus a small integrity manifest. They
are not counted as initial JS or fetched before an OCR request. Preparation
streams hashes, preserves identical files, stages repairs atomically and emits
`ocr-assets/manifest.json`. Build/CI validates every required size/hash, including
the English pack. These generated public binaries remain ignored by Git.

## Validation Boundaries

Chromium production smoke uses a synthetic vault and mocked Tauri IPC. It covers
command/settings shortcuts, pending Profile selection, icon aliases, common and
uncommon preview fences, math controls, PDF viewing and actual bundled WASM
English recognition with external requests blocked. Linux WebKitGTK 2.54 in an
offscreen GTK3 window loaded all 16 view modules and rendered note/PDF fixtures
with the PDF worker. This checks JSC/module/worker compatibility over a local
HTTP preview, without touching a user's vault or opening a visible application.

Native cold/warm launch timing, full restored workspaces, every editor's rendered
first use, installed Tauri asset URLs, Windows WebView2/macOS WebKit and physical
Android remain release acceptance. Broad PDF annotations/export/OCR scenarios,
long-session worker/GPU memory and font fallback on every target remain in the
native matrix. Do not report these as completed from browser tests or bundle
bytes. O70's native timing/memory release gate remains open.
