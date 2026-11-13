# Media Playback Phase 0

This experiment uses the same Tauri WebView family as desktop Collab. It is a
separate executable with generated fixtures. It has no Collab IPC commands,
vault access or production window.

## Reproduce

From the repository root, generate the fixture set with FFmpeg (including
libx264, libvpx, libopus and libmp3lame), then run the native example. Pass a new
directory to the generator and keep the files unchanged during playback.

```sh
fixtures="$(mktemp -d)/fixtures"
./scripts/media-playback-fixtures.sh "$fixtures"
cargo test --locked -p collab --example media-playback
cargo run --locked -p collab --example media-playback -- "$fixtures" --verify
```

The generator also runs in Bash on a machine separate from the test target.
Copy the resulting directory to the test machine as needed. On Windows, run
Cargo in PowerShell and pass the fixture directory as a native Windows path.
Use `cargo build --locked -p collab --example media-playback --release` to
build a release-mode probe. For Flatpak, build against the same GNOME SDK as the
[Collab manifest](../../flatpak/com.azazel.collab.yml) and run inside an
equivalent application sandbox with the fixture directory readable. Record the
runtime, codec extensions, and network and file grants along with the result.

The example prints a `MEDIA_PLAYBACK_REPORT` line with the runtime user agent,
playback results, track observations and source counters. Without `--verify`,
the fixture picker, Play/pause, Seek, tabs and track selectors allow manual
checks. Start a fresh process when recording the large-file byte counters.
Verify that captions appear on screen and alternate audio changes from the
440 Hz tone to the 880 Hz tone when exposed. The automated track check records
active cues and selected track state.

## Source And Playback Decisions

- Use the platform WebView player for the initial local-file candidate. Target
  MP4 (H.264/AAC), WebM (VP9/Opus), MP3, PCM WAV and FLAC, plus sidecar WebVTT.
  Normalize SRT into bounded WebVTT during Phase 1. Embedded tracks are
  capability-dependent. Evaluate a native backend if embedded audio/subtitle
  switching becomes a release requirement and the packaged WebViews cannot
  provide it.
- The probe serves regular allowlisted fixture files over HTTP on a random
  IPv4 loopback port. A per-process random URL token and exact Host check scope
  access. The page and media are same-origin. Rust reads file offsets directly
  from open handles and streams 64 KiB chunks with at most four concurrent
  response bodies. The server retains no complete asset. WebView buffering and
  decoded frames have separate platform-dependent costs.
- Carry the measured range approach into Phase 1 as a candidate. Production
  playback needs revocable handles bound to the active profile, vault, revision
  and player lifetime. Start with one actively playing decoder and at most four
  range bodies globally. Retain paused tab state separately from the decoder
  when resources need to be reclaimed. Profile memory and sustained seeking
  before expanding the budget.
- Pause audio and video on tab switch by default. Preserve the position and
  require an explicit resume. Closing the tab or leaving or locking the vault
  should release the source. Background audio and restart resume can be
  evaluated after the local baseline is verified.

Platform WebView families follow the
[Tauri WebView runtime reference](https://v2.tauri.app/reference/webview-versions/).

## Native Evidence

The standalone Tauri example ran on Arch Linux x86_64 with WebKitGTK 2.54.2
and GStreamer 1.28.9. It also ran inside the GNOME 50 Flatpak SDK sandbox
with WebKitGTK 2.54.1, network sharing and read-only fixture access. Both
runs produced the following results with their installed codecs.

| Case                                                 | Observed                                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 180-second MP4, H.264/AAC, 340,685,283 bytes         | Played, sought to 75% through a new nonzero byte range, retained paused position after switching tabs, and resumed.                                                                     |
| MP4, two AAC tracks and an embedded timed-text track | Both audio tracks and the embedded track appeared in the DOM. The second audio track became enabled. Both the sidecar and embedded caption reported an active cue at the test position. |
| WebM VP9/Opus, MP3, PCM WAV, FLAC                    | Playback advanced for every fixture.                                                                                                                                                    |

The first native run read 268,435,456 bytes before the seek and
305,987,584 bytes by seek completion. The first SDK run read 303,497,216
and 331,415,552 bytes at those points. The final native run again issued a
new range before cumulative reads reached the file size. The final SDK
run issued a new range and completed the seek after cumulative reads had
already exceeded the file size. The counter includes overlapping reads,
so it measures I/O volume rather than unique byte coverage or retained
memory.

Before shipping, measure WebView/process memory and compare seek
responsiveness and repeated reads with a bounded prefetch policy. The
64 KiB chunk size caps the source's per-read allocation. It does not cap
WebView prefetch or cumulative I/O.

| Release target       | Qualification                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Linux native package | Standalone WebKitGTK probe passed. Installed package and manual caption/audio checks pending. |
| Linux Flatpak        | GNOME 50 SDK sandbox probe passed. App bundle and manual caption/audio checks pending.        |
| macOS                | Pending packaged WKWebView run and manual caption/audio checks.                               |
| Windows              | Pending packaged WebView2 run and manual caption/audio checks.                                |
