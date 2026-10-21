# Previews, PDF, Images And OCR Performance

Implemented **2026-10-21**, desktop audit **O37–O51**, Performance Batch 7.
O39's shared PDF cards and O47's serialized WASM owner are retained; O48 remains
superseded by R08's memory-only OCR results. The [audit](../audits/desktop-performance-and-bugs-2026-10-14.md)
and [implementation tracker](../plans/desktop-audit-fixes.md) record implementation;
[open development work](../plans/open-development-work.md) owns release acceptance.

## Transport And Job Ownership

Desktop image/PDF opening and image hover/card sources use `VaultClient.readAssetBytes`
through `read_vault_asset_bytes`: a raw Tauri IPC response rather than a base64
string serialized as JSON and decoded again in JavaScript. This is a bounded
buffer bridge, not a streaming/range protocol or zero-copy guarantee. Original
sources are capped at 256 MiB, with two admitted native reads. Local paths must
resolve beneath the active canonical vault and encryption keys are checked again
before publication. Hosted tokens remain native. Matching encrypted offline
copies are used first; connectivity failure permits existing stale offline
fallback, while permission failures and cancellation never do. Native replica reads bound
ciphertext before allocation and check decrypted byte limits; the cached hash
is checked during that one read rather than through a second full cache-status
read/decrypt/hash pass. Online downloads
update a replica only under the existing offline-copy policy.

`previewScheduler` shares four active/256 retained jobs across file-tree hovers,
Markdown file links, canvas cards, internal document previews and web links.
Keys include account, vault, path, revision and variant. Each caller owns a lease;
one caller leaving cannot cancel a second pane. The last cancellation removes
queued work and aborts active native HTTP/read or PDF work. Slots remain occupied
until actual work ends. Visible requests can promote an existing background job;
a background turn after four visible jobs prevents starvation. Native job IDs
handle cancellation arriving before registration. Synchronous codecs check
cancellation before/after decoding; they are bounded rather than force-killed
mid-codec. Canvas text hydration shares admission, although its existing document
read API does not interrupt a read already in progress.

## Explicit Resource Limits

| Resource                       | Limit / lifetime                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Native asset inputs            | 256 MiB each, two active reads                                                                      |
| Native raster thumbnail decode | One active, 48 MP, dimensions ≤16,384, decoder allocation ≤192 MiB                                  |
| Thumbnail output               | Fits 640×480, PNG with EXIF orientation; SVG passthrough ≤2 MiB                                     |
| Image thumbnail cache          | 32 entries/16 MiB including estimated decoded pixels                                                |
| PDF thumbnail cache            | 32 entries/16 MiB including data URL and decoded pixels                                             |
| PDF source cache               | Two idle entries/64 MiB source bytes; 30-second idle retirement                                     |
| PDF page-image/text cache      | 12 entries/64 MiB including blob, decoded pixel and text costs                                      |
| PDF live backing canvases      | 48 million aggregate pixels, six million per page                                                   |
| PDF raster queue               | One active/64 retained, cancellable priority/fairness                                               |
| Local disposable preview cache | 256 MiB/4,096 records/30 days; oldest-first/orphan GC                                               |
| Image processing               | One worker/eight admitted jobs, 30-second operation timeout                                         |
| Image pixel ceilings           | Two MP edit previews, twelve MP OCR preprocessing, 48 MP source/export                              |
| Native OCR                     | Two processes; busy rejection; 60-second timeout; 64 MiB input data URL                             |
| Native OCR returned outputs    | Text/stdout four MiB; TSV sixteen MiB; stderr monitored at 256 KiB                                  |
| Native language install        | One active, 180-second request timeout, 80 MiB actual streamed bytes                                |
| WASM OCR                       | One worker/eight jobs; three-minute idle shutdown                                                   |
| Web previews                   | 128 entries; success ten minutes/error thirty seconds; four lazy prefetch producers, 512 links/pass |
| Avatars                        | 128 entries/eight MiB; success five minutes/missing one minute; bounded retry                       |

Native raster formats are PNG, JPEG, WebP, GIF, BMP and ICO. AVIF thumbnail
decoding is not included in this native codec build. Unsupported thumbnail
formats fail visibly instead of sending a full original as a fallback; opening
an original still uses the webview's existing format support. Large image edits
above the explicit ceiling report an error. Worker transforms avoid full-size
intermediate rotated/cropped canvases; final exports retain requested original
resolution within the ceiling, independently of downsampled previews. Existing
annotation flattening still draws vector annotations on the main canvas.

PDF.js internal worker/decoder heap is not exactly accounted by these limits;
source cache limits apply to idle resources, and mounted documents remain owned
by their panes. Continuous visibility tracking releases offscreen page canvases
and text DOM while retaining page placeholders. Budget exhaustion presents a
retryable rendering error. OCR subprocess output is monitored in temporary files
every 25 ms, so on-disk output can briefly exceed a threshold before kill/reap;
returned reads remain bounded. No output pipe is collected without a limit.

## Cache And Privacy Lifecycle

Vault replacement/lock, server disconnect and account changes abort/clear scoped
media resources. PDF URLs are revoked, PDF.js documents destroyed, worker jobs
cancelled and derived caches cleared. Identity/revision guards reject obsolete
results. OCR cancellation terminates recognition and cannot trigger native
fallback or write a cancelled result. Owned preprocessing canvases are released
when recognition ends; caller-owned inputs are preserved.

Disposable preview GC operates only in a verified canonical
`.collab/previews/documents` directory. Atomic `.entry` records and legacy
`.json`/`.bin` files are disposable; annotations/history are not. Symlinks,
unknown files and directories are excluded. Reads cadence-limit scans; writes
and managed rename/delete/trash sweep orphans. Encryption and atomic record
publication remain intact. Language downloads stream into private staging with
incremental hashing; an oversized/cancelled download cannot replace a working
model pack.

Avatar keys include connected account identity. TTL refreshes mounted consumers,
focus/visibility triggers revalidation, errors retry and profile updates actively
invalidate affected server avatars. Disconnect/account cleanup also notifies
mounted consumers. Link prefetch cleanup releases leases rather than retaining
hundreds of promises after the note closes.

## Validation

End-of-batch validation:

- Desktop/scripts suite plus correction reruns pass; the five separate performance
  test files pass (26 tests). One existing intentional desktop test is skipped.
  Initial concurrent runs hit timeout failures in DeckView, sheet fixture shapes
  and one admin workflow; affected isolated reruns pass, including the previously
  failed PowerPoint export case. Timeout reruns used a 20-second harness limit;
  application/performance assertions were not relaxed.
- Admin frontend: 81 tests pass across the suite/correction run, production build
  and types pass. Android frontend: 258 tests, types and build pass; build output
  used a temporary directory to preserve unrelated generated files.
- Rust workspace: **722 tests passed / one benchmark ignored**, including the
  final bounded encrypted-replica read regression; final workspace check/fmt pass.
  No disposable PostgreSQL URL was supplied: live database tests are not claimed.
- Desktop production build and packaged asset budgets, all frontend type checks,
  formatting, lint (zero errors; existing warnings), crate boundaries and version
  alignment pass. Rust formatting/workspace check pass.
- The initial cached `cargo audit --no-fetch` missed three newly published TLS
  advisories subsequently found by CI. The PR follow-up upgrades `rustls-webpki`
  to 0.103.16 and both root packages to 1.0.10; the refreshed audit reports no
  denied advisories and six existing allowed warnings. See
  [advisory remediation](../build/security-advisories.md).

Rendered integration uses the real shared React hover component, PDF.js and
image-processing worker with synthetic native IPC. No browser plugin was
available in the tool inventory, so installed Playwright/Chromium and a local
WebKitGTK harness were used. Fixture URL: `http://127.0.0.1:1426/__media-qa`, title
**Collab media performance QA**. This fixture and temporary screenshots are QA
artifacts, not new shipped application UI.

- Chromium, 1250×850 and 390×700: image preview 640×480; real first-page PDF
  256×320; internal SVG preview 300×180. Popovers remain within the viewport.
  Binary thumbnail/full-PDF requests were observed; no old asset-data-URL request.
- Linux WebKitGTK **2.54.1**, software rendering, 1250×850: the same three preview
  dimensions, real PDF.js and real image workers pass. Invert filtering returns
  `[131,197,18,255]` for the test source; 90° rotation and PNG encoding preserve
  the expected 1200×1600 dimensions in both engines.
- Chromium mounted avatar invalidation updates purple to green without remount;
  screenshots were inspected. No page JavaScript errors. The fixture proxy does
  not forward Vite HMR WebSockets and has no favicon; those development-only
  console network messages are excluded from application error conclusions.

## Outstanding Native Acceptance (O70)

Installed Tauri binary IPC, encrypted lock races, authenticated hosted role
changes/offline/reconnect and actual server/native transport still need installed
checks. Synthetic IPC does not certify those paths. Measure 40 MP photo hover
latency, large-PDF first page/scroll/zoom and actual peak RSS/heap/GPU across Linux,
Windows and Android before claiming numerical performance gains. Validate real
OCR accuracy after downsampling, large-image export color/orientation fidelity,
process cancellation, model downloads and extended multi-pane soak. Android
frontend checks cover shared code, not a physical-device or APK qualification.
