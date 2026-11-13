# Local Media Playback

Add a video or audio file with **Files → Add files**, drop it onto Files, or
place it directly in an unencrypted local vault. Select it in Files or follow
a vault link to open its player tab.

| Type             | Candidate formats                            |
| ---------------- | -------------------------------------------- |
| Video            | MP4 with H.264/AAC, WebM with VP9/Opus       |
| Audio            | MP3, PCM WAV, FLAC                           |
| Sidecar captions | UTF-8 WebVTT or SubRip, up to 1 MiB per file |

Decoding depends on the system WebView and installed codecs. HEVC and E-AC-3
are outside the qualified baseline. Smooth 4K playback and correct HDR
presentation depend on the decoder, WebView and display pipeline. When Collab
cannot decode a local file, **Open externally** hands the file to the
system's default app. Hosted attachments can be downloaded separately.
Playback from hosted vaults and encrypted vaults is outside the local player.

A caption with the same basename in the same folder appears in the
**Captions** selector. Use **Caption file** to load a different caption from
the vault. Embedded captions and alternate audio tracks appear when the
WebView exposes them. A file with a matching caption still starts with
captions off unless a previous session selected a track.

Use the timeline to seek. When the player panel has focus, Space toggles
playback and the Left and Right keys move five seconds. Buttons and sliders
can also receive focus directly. Video includes fullscreen.

Leaving the tab pauses playback and releases the native source. Returning
or reopening the same unchanged file restores position, speed, volume and
track selections while the vault stays open. Playback resumes after you
press Play. Resume data is held in memory for up to 64 recent files and
cleared when the vault changes or locks.

## Validation

Use the [generated fixtures](../plans/media-playback-phase0.md#reproduce) for
installed-app checks. Open `large.mp4`, seek past two minutes, change tabs,
return, and close and reopen the tab. Replace or remove the file, repeat
with file permissions revoked, then leave the vault during playback.
Confirm that the next vault cannot reuse the old source and that a replaced
file starts from the beginning. Open `tracks.mp4` and exercise the sidecar,
embedded caption and both tones wherever the runtime exposes the tracks.

The Rust tests exercise a range near the end of a sparse 36.1 GB fixture on
Unix, revoke an active stream, and cover replacement, missing files, path confinement,
encrypted source rejection and SubRip conversion. The Chromium UI test with
mocked IPC exercised Files routing, audio/video layouts, native source
release calls, paused resume, caption selection and keyboard seeking.
An Arch Linux debug build opened and played the 325 MiB MP4 through the native
Tauri path and exposed embedded tracks. Installed Windows, macOS, Linux and
Flatpak qualification remains open, including native seek/resume and memory
profiling.
