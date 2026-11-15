# Media Playback And Library Plan

Status: **Phase 3 desktop media library implemented. Native qualification in progress.**
See the [Phase 0 evidence and decisions](./media-playback-phase0.md) and
[desktop player guide](../desktop/media-playback.md).
[Open Development Work](./open-development-work.md) tracks project status.

## Product Direction

Open video and audio from Files in ordinary editor tabs, alongside notes, PDFs,
images and SVGs. The tab is the primary player. A later **Media** view provides
a gallery or list for finding media in the active vault. Selecting an item there
opens or focuses its regular file tab, using the same player and session.

Keep existing image and SVG editors. This feature is for playing saved media;
calling, live streaming, recording, and audio/video editing are outside the
initial scope.

## Player Experience

- **Video:** playback surface, play/pause, timeline, volume/mute, speed, fullscreen,
  keyboard shortcuts, and subtitle and audio-track controls when supported.
- **Audio:** compact layout with artwork or file details, timeline, speed and
  track information. No waveform generation is needed for the first player.
- **Subtitles:** start with explicitly selected or matching sidecar WebVTT/SRT
  files; support switching and disabling captions. Handle embedded subtitles
  and alternate audio tracks through the chosen backend's verified capabilities.
- **Continuity:** tab switches preserve position, speed and selected tracks.
  Suggested default: pause video on leaving its tab; background audio is opt-in.
  Resume across app restarts is enabled by default as a separate preference,
  stored locally by profile or hosted account, vault and file identity, with a
  revision check before reuse. Players reopen paused.
- **Clear failure states:** distinguish unsupported format or codec, missing
  file, unavailable offline copy, permission loss, and buffering. Offer an
  explicit external-player action where the platform can open the source safely.

## Technical Direction

Route media tabs through the existing file/editor flow in
`src/components/layout/AppShell.tsx`. Use shared controls and the
`DocumentTopBar` pattern. The mounted view displays a playback session owned
outside the tab component, so changing views does not reset it. Opening the
same file through Files, a link, or the library focuses the existing tab.
Closing a tab or switching/locking the vault releases its active source and
decoder as appropriate. Set explicit limits on retained players and buffers.

The [current native asset reader](../../src-tauri/src/commands/media.rs) and
[hosted download endpoint](../../crates/collab-server/src/api.rs) are whole-file
paths. Add a separate seekable media source instead of feeding large files into
React as data URLs or byte arrays. Keep credentials and file access in the native
layer. Issue narrowly scoped playback handles to the player; bind them to the
vault, file revision and playback lifetime. The prototype should decide how to
expose bounded byte reads to the WebView across supported platforms.

Start by evaluating WebView audio/video elements for playback. A compact set of
tested container/codec combinations is more useful than a broad extension list.
The candidate fixtures should include MP4 with H.264/AAC, WebM, MP3, WAV and FLAC,
plus a video with two audio tracks and an embedded subtitle. These are test
inputs, not promised support. If WebView track selection or codec coverage falls
short of the agreed baseline, evaluate a native backend before committing to
packaging and UI assumptions.

Hosted playback needs revision-pinned, authorized range reads backed by storage
that actually reads only the requested bytes. Keep upload limits and streaming
limits separate; raising the file-size cap alone is insufficient. Use verified
offline copies where available and preserve the existing permission-failure
behavior. Whole-file authenticated encryption cannot be treated as seekable
plaintext; assess a bounded decrypt strategy or chunked authenticated storage
before promising large encrypted playback. Do not silently stage plaintext.

## Proposed Phases

### Phase 0 — Playback Prototype And Decisions

- [x] Play and seek a large local video without a whole-file copy through IPC.
- [x] Switch prototype tabs and back without losing the playback position.
- [ ] Validate sidecar captions, embedded captions and alternate audio on actual
      packaged Windows, macOS and Linux builds, including Flatpak where supported.
- [x] Confirm the candidate format/track baseline and buffering budget on packaged
      builds. The prototype records the initial backend and background-playback defaults.

### Phase 1 — Local Desktop File Tabs

- [x] Add media detection, file icons and tab routing with the existing file
      navigation and tab lifecycle.
- [x] Implement bounded local playback, shared player controls, separate audio
      and video layouts, keyboard access and accessible playback status.
- [x] Add sidecar subtitles, capability-aware track controls, resume state and
      clear fallback/error behavior. If the chosen baseline requires a backend
      change for embedded tracks, resolve that before claiming support.
- [x] Show album artwork and embedded or matching LRC lyrics in the audio
      player. Apply artwork-based ambiance and synchronize timestamped lines.
- [x] Qualify album artwork and lyric sync in installed desktop builds.
- [x] Verify seek, tab reopen, media replacement, permission loss and cleanup
      when closing the player or leaving its vault in an installed build.
      Automated coverage exercises overlapping seeks, same-revision resume,
      stale track selections, permissions revoked mid-range and source teardown.
- [x] Qualify sustained playback and seeks on a high-bitrate 4K HEVC/E-AC-3
      movie. Record decoder selection, dropped frames, audio and colour output.
      Linux WebKitGTK stalled on an MP4 with 39 embedded subtitle tracks.
      A compatibility stream bypassing those tracks reached metadata and
      played the original media bytes in a standalone WebKitGTK probe.

### Phase 2 — Hosted And Offline Sources

- [x] Add authorized range serving and a native playback source with bounded
      buffering, cancellation and revision-aware cache identity.
- [x] Add explicit encrypted offline playback copies up to 32 MiB. Larger files
      can be saved to a local vault. Password-encrypted local vault playback
      remains excluded.
- [x] Automate checks for bounded tail seeks, stale revisions, authorization loss
      and authenticated offline storage.
- [x] Qualify first play and long seeks, reconnect, offline playback and lock
      cleanup in installed builds.

### Phase 3 — Media Library

- [x] Add a lazy Media view for the active vault with image/SVG/video/audio filters,
      path search, list/gallery layouts and optional folder grouping.
- [x] Reuse indexed file metadata. Generate visible small local raster thumbnails
      and load duration, artwork and video stills in an explicit preview. Cache
      by file revision and renderer version.
- [x] Add an optional Continue watching and listening section using in-session
      resume data. Every item opens or focuses its regular file tab.
- [x] Use hosted audio tags, embedded artwork and same-folder LRC in the player and library preview.
- [x] Qualify artwork and video still previews on installed desktop WebViews.

### Phase 4 — Follow-on Surfaces And Polish

- [ ] Decide whether to extend the player to Android and web after desktop
      acceptance. Validate their authentication, offline, focus and lifecycle rules
      separately.
- [x] Assess desktop playback improvements and propose an implementation order.
- [x] Add local subtitle timing, vault queues and saved playlists, local MP4
      chapters, capability-gated OS controls and picture-in-picture, short WAV
      waveforms, and an optional 4K HEVC/E-AC-3 verification fixture.
- [ ] Qualify subtitle timing, queue auto-advance, chapter seeks, picture-in-picture,
      system media controls, waveform generation, and sustained 4K playback in
      installed WebViews.

#### Proposed desktop priorities

Start with subtitle timing and qualify formats people already use. Build a
session queue next. Queue and chapter navigation will help determine which
actions Collab should expose to the operating system.

| Priority | Improvement           | First delivery and acceptance                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Subtitle offsets      | Add earlier, later and reset controls for a selected caption track. Start with local sidecars and compatible MP4 subtitles Collab already converts to WebVTT. Save timing per file revision and track. Verify seeks, reopen and fullscreen. Adjust native embedded tracks only where the WebView supports it reliably.                                                                                                                  |
| 2        | Richer format support | Build an installed-player matrix starting with the reported 4K HEVC/E-AC-3 MP4 and the existing H.264/AAC, WebM and audio fixtures. Record startup, seeking, dropped frames, audio and colour separately. Use repeatable failures to choose the next container or codec to improve. Preserve bounded streaming and revision checks.                                                                                                     |
| 3        | Playlists and queues  | Start with an active-vault session queue. Add from the library, reorder, remove, skip and advance on completion. Open each item in its regular tab and check access at playback time. Handle missing files and stop the queue on vault switch or lock. Add saved playlists after the queue behavior is established.                                                                                                                     |
| 4        | Chapters              | Read chapter names and timestamps for one verified container first. MP4 is the initial candidate because Collab already scans its metadata locally. Show a jump menu and current chapter when available. Test long seeks, bounded reads, changed file revisions and malformed chapters. Assess hosted chapter reads separately.                                                                                                         |
| 5        | OS media controls     | Prototype Media Session play, pause and seek for the active player on packaged desktops. Expose next and previous when an action is available. Verify keyboard and desktop controls, and clear metadata when playback closes or access ends. Evaluate Linux MPRIS if needed. [Media Session](https://www.w3.org/TR/mediasession/), [MPRIS player interface](https://specifications.freedesktop.org/mpris/latest/Player_Interface.html). |
| 6        | Picture-in-picture    | Prototype with the existing video element and one playback source. A floating player needs an explicit exception to pause on tab hide. Verify availability and behavior on packaged builds, including fullscreen transitions, vault lock and permission loss. [Picture-in-Picture](https://www.w3.org/TR/picture-in-picture/).                                                                                                          |
| 7        | Waveform previews     | Revisit after queue and chapter use is known. Start with opt-in previews for short local audio and cache peaks by file revision. Measure decode memory, latency and cancellation before enabling longer or hosted files. Keep the library preview's existing media read budget.                                                                                                                                                         |

## Open For Feedback

- Which containers, codecs and embedded audio/subtitle formats must work in the
  first release?
- Should background audio default on, and should it continue after leaving the
  active vault or only while its player tab remains open?
- Should the library default to a gallery or list? Should it include favorites,
  playlists, recent files or a cross-vault view later?
- How should multiple open player tabs behave when a second item starts playing?
- Is hosted playback required in the first public release, or can local playback
  ship while hosted and encrypted sources are validated?

Run implementation checks at each completed batch's end. Track packaged playback,
seek behavior, memory bounds, captions, track switching and audio lifecycle
separately from browser/unit coverage. Update the main tracker and desktop
architecture documentation as the work lands.
