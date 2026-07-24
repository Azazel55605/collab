# OCR implementation plan

## Goals

- Keep OCR usable offline with a small bundled default.
- Support proper language selection and language-pack management.
- Avoid downloading OCR data from unknown or user-invisible sources.
- Improve PDF OCR quality and speed by extracting real PDF text first and rendering OCR input at a controlled resolution.
- Cache OCR results so repeated OCR on unchanged files is instant.
- Add region OCR for images and PDFs before building a full selectable OCR text layer.

## Tracker

| Phase | Status | Notes |
| --- | --- | --- |
| 1. OCR settings and language management | Complete | Settings UI, persisted preference, curated official pack download/remove flow, and app-data storage are implemented. |
| 2. OCR engine runtime | Complete | OCR now reads the preferred language, seeds installed app-data packs into Tesseract's cache, reuses the active worker, and idles it after a short timeout. |
| 3. PDF text-first extraction | Complete | PDF page OCR now extracts embedded text before invoking OCR. |
| 4. Controlled PDF render scale | Complete | PDF OCR now renders an offscreen page at the configured 1x/2x/3x scale with a pixel clamp. |
| 5. OCR result cache | Complete | OCR results are cached in app-local IndexedDB by file/page identity and OCR settings, with regenerate controls and a clear-cache settings action. |
| 6. Region OCR | Complete | PDF region OCR uses the existing drag selection and high-resolution OCR render; image OCR can target the active crop region. |
| 7. Conservative preprocessing | Complete | OCR preprocessing is explicit and defaults to none; grayscale, contrast, black-and-white, and invert modes are cache-keyed. |
| 8. Selectable OCR overlay | Complete | OCR word boxes now render as selectable transparent text layers on PDF pages and image surfaces after OCR. |

## Trust and language-pack source

The built-in downloadable language-pack source should be the official Tesseract OCR GitHub organization:

- Engine: <https://github.com/tesseract-ocr/tesseract>
- Fast language models: <https://github.com/tesseract-ocr/tessdata_fast>
- Best language models: <https://github.com/tesseract-ocr/tessdata_best>
- Data-file documentation: <https://github.com/tesseract-ocr/tessdoc/blob/main/Data-Files.md>

Use `tessdata_fast` as the default downloadable model set. It is the practical speed/accuracy choice for normal app use. Keep `tessdata_best` as a possible later advanced option because it is larger and slower.

The OCR settings UI should include an info box with a link to the official Tesseract repositories. Suggested copy:

> OCR language packs are downloaded from the official Tesseract OCR project on GitHub. Only install language packs from trusted sources, because OCR models are engine data consumed by the recognition runtime.

## Phase 1: OCR settings and language management

- Add an OCR section to app settings.
- Show installed language packs, bundled language packs, and available downloadable packs.
- Bundle only the small default language pack required for offline baseline OCR, currently English.
- Allow users to download and remove additional language packs.
- Store downloaded packs in app data, not inside a vault.
- Persist the preferred OCR language or language combination in `uiStore`.
- Start with a curated language list:
  - English `eng`
  - German `deu`
  - French `fra`
  - Spanish `spa`
  - Italian `ita`
  - Portuguese `por`
  - Dutch `nld`
  - Polish `pol`
- Support language combinations such as `eng+deu` once multiple packs are installed.
- Verify downloads before marking a pack installed.
  - Minimum: expected filename, content length where available, and successful Tesseract load.
  - Better: include known SHA-256 checksums for curated packs.
- Show the source URL and installed size for each pack.
- Never download from arbitrary user-provided URLs in the first implementation.

## Phase 2: OCR engine runtime

- Replace one-shot OCR calls with a small runtime manager.
- Keep the current lazy import behavior so OCR does not affect app startup.
- Reuse a worker for the active language while OCR is being used.
- Add an idle timeout, initially 2-5 minutes, after which the worker is terminated.
- Keep this automatic by default. Add a setting later only if memory usage becomes noticeable.
- Recreate the worker when language, model source, or OCR engine options change.
- Preserve the native Tesseract command as a fallback where available.

## Phase 3: PDF text-first extraction

- Before OCRing a PDF page, ask `pdf.js` for the page text content.
- If real text exists, return that immediately and mark the result as extracted text rather than OCR text.
- Offer a "Force OCR" action for scanned-looking PDFs with bad embedded text.
- Cache text extraction separately from OCR results.
- Keep copy behavior the same for users.

## Phase 4: Controlled PDF render scale

- Render PDF pages for OCR at a controlled internal scale instead of using the visible viewer zoom.
- Start with an OCR scale of `2x`.
- Add a bounded option for `1x`, `2x`, and `3x`.
- Clamp maximum canvas dimensions to avoid huge memory spikes on large pages.
- Use the same high-resolution render path for full-page OCR and region OCR.
- Include render scale in the OCR cache key.

## Phase 5: OCR result cache

- Cache OCR results by stable document identity and OCR settings.
- Cache key fields:
  - vault identity and file path or stable hosted file id
  - file hash, revision, or manifest sequence
  - page number for PDFs
  - selected region, if any
  - language or language combination
  - model source
  - render scale
  - preprocessing mode
  - OCR engine/runtime version marker
- Store cache data in app data for hosted vaults and local vaults.
- Do not write OCR cache data into the vault by default.
- Add a settings action to clear OCR cache.
- Add bounded cache cleanup by total size and last-used time.

## Phase 6: Region OCR

- Add region selection mode to the image viewer.
- Add region selection mode to the PDF viewer.
- For PDFs, map the visible selection rectangle back to page coordinates.
- Render the selected region from the PDF at OCR scale, then OCR only the cropped canvas.
- For images, crop from the natural image dimensions where possible, not from a scaled display bitmap.
- Store region coordinates in the cache key.
- Keep the initial UI simple:
  - OCR full page/image
  - OCR selected region
  - Copy result

## Phase 7: Conservative preprocessing

- Keep "none" as the default preprocessing mode.
- Add optional retry modes after the core OCR path is stable:
  - grayscale
  - contrast boost
  - black-and-white threshold
  - invert colors
- Make preprocessing explicit so a bad mode does not silently reduce accuracy.
- Include preprocessing mode in the cache key.
- Consider a small preview only if the controls become hard to reason about.

## Completed: Selectable OCR Overlay

Selectable OCR overlays use word bounding boxes, coordinate mapping,
text-layer rendering, and zoom synchronization across PDF and image surfaces.
This section is retained as implementation history for Phase 8.

## Completed Implementation Order

1. Add OCR settings, language metadata, and language-pack storage commands.
2. Add official Tesseract download/install/remove flow for curated packs.
3. Teach OCR runtime to use installed packs and language combinations.
4. Add PDF text-first extraction.
5. Add controlled OCR render scale for PDF pages.
6. Add OCR cache with clear-cache settings action.
7. Add region OCR for images and PDFs.
8. Add optional worker reuse idle policy if not already covered by the runtime manager.
9. Add conservative preprocessing modes.

## Verification checklist

- App starts without loading OCR code.
- OCR works offline with the bundled default language.
- German OCR works after installing `deu`.
- `eng+deu` works when both packs are installed.
- Downloaded packs survive app restart.
- Removing a pack prevents it from being selected.
- PDF pages with embedded text return text without OCR.
- Force OCR still works on PDFs with embedded text.
- Full-page PDF OCR uses the configured render scale.
- Region OCR maps accurately at different viewer zoom levels.
- OCR cache returns instant results for unchanged files.
- Cache invalidates when the file changes.
- Cache invalidates when language, render scale, region, or preprocessing changes.
- `pnpm test`, `pnpm exec tsc --noEmit`, and `cargo check --workspace` pass.
