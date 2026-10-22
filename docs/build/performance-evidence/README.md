# Native Performance Release Evidence

Commit real exported reports under `desktop-v<version>/*.json` after qualifying a
packaged release candidate on Linux WebKitGTK, Windows WebView2 and macOS WebKit.
Reports must match the native app version. Do not copy unit-test fixtures here.

The desktop tag workflow runs:

```bash
node scripts/desktop-performance-gate.mjs --release-tag desktop-v<version>
```

Missing evidence or failed budgets blocks release publication. Use the manual
build workflow to produce candidates before creating the tag. See
[capture procedure, budgets and measurement limits](../../desktop/native-background-performance.md).
Attach inspector/process-tree/GPU traces and fixture/cache preparation notes
alongside the JSON. Native main-process RSS alone does not account for webview,
worker or GPU memory. This directory intentionally contains no invented platform
certification reports.
