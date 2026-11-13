# Media Playback And Library Plan

Status: **Phase 1 local desktop implementation. Native qualification in progress.**
See the [Phase 0 evidence and decisions](./media-playback-phase0.md) and
[local player guide](../desktop/media-playback.md).
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
  Resume across app restarts is a separate preference, stored locally by
  profile, vault and file identity, with a revision check before reuse.
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
- [ ] Confirm the candidate format/track baseline and buffering budget on packaged
      builds. The prototype records the initial backend and background-playback defaults.

### Phase 1 — Local Desktop File Tabs

- [x] Add media detection, file icons and tab routing with the existing file
      navigation and tab lifecycle.
- [x] Implement bounded local playback, shared player controls, separate audio
      and video layouts, keyboard access and accessible playback status.
- [x] Add sidecar subtitles, capability-aware track controls, resume state and
      clear fallback/error behavior. If the chosen baseline requires a backend
      change for embedded tracks, resolve that before claiming support.
- [ ] Verify seek, tab reopen, media replacement, permission loss and cleanup
      when closing the player or leaving its vault.
- [ ] Qualify sustained playback and seeks on a high-bitrate 4K HEVC/E-AC-3
      movie. Record decoder selection, dropped frames, audio and colour output.

### Phase 2 — Hosted And Offline Sources

- [ ] Add authorized range serving and a native playback source with bounded
      buffering, cancellation and revision-aware cache identity.
- [ ] Validate first play and seeks before complete download, reconnect and
      permission changes, and offline playback from explicitly downloaded files.
- [ ] Establish the encrypted playback boundary and test lock/revocation cleanup.
      Keep unsupported large encrypted cases explicit until a safe source exists.

### Phase 3 — Media Library

- [ ] Add a lazy Media view for the active vault with image/SVG/video/audio filters,
      search, list/gallery layouts and optional folder grouping.
- [ ] Reuse indexed file metadata; load duration, artwork and posters on demand.
      Cache derived previews by file revision and renderer version. Do not start a
      decoder or fetch a full asset for every visible tile.
- [ ] Add an optional Continue watching/listening section using local resume
      state. Every library item opens or focuses the regular file tab.

### Phase 4 — Follow-on Surfaces And Polish

- [ ] Decide whether to extend the player to Android and web after desktop
      acceptance. Validate their authentication, offline, focus and lifecycle rules
      separately.
- [ ] Consider playlists/queues, chapters, picture-in-picture, waveform previews,
      subtitle offsets, OS media controls and richer format support based on use.

## Open For Feedback

- Which containers, codecs and embedded audio/subtitle formats must work in the
  first release?
- Should background audio default on, and should it continue after leaving the
  active vault or only while its player tab remains open?
- Should the library default to a gallery or list? Should it include favorites,
  playlists, recent files or a cross-vault view later?
- Should resume positions persist across restarts? How should multiple open
  player tabs behave when a second item starts playing?
- Is hosted playback required in the first public release, or can local playback
  ship while hosted and encrypted sources are validated?

Run implementation checks at each completed batch's end. Track packaged playback,
seek behavior, memory bounds, captions, track switching and audio lifecycle
separately from browser/unit coverage. Update the main tracker and desktop
architecture documentation as the work lands.
