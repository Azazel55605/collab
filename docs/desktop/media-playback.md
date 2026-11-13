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

If an MP4 stalls before reporting its duration, Collab retries once in
**Compatible subtitles** mode. Supported embedded MP4 timed text is read on
selection and exposed as plain WebVTT. WebVTT and SubRip sidecars also stay
available. Styled or bitmap subtitle tracks may require the external player.
If the WebView exposes fewer audio tracks than the MP4 contains, Collab can
reopen the stream with the selected track while preserving the playback position.
These operations leave the original file intact.

Use the timeline to seek. When the player panel has focus, Space toggles
playback and the Left and Right keys move five seconds. Buttons and sliders
can also receive focus directly. Video fills the available space while
preserving its aspect ratio. Use the fullscreen button or F while the player
has focus. Escape returns to the tab.
Fullscreen controls float over the video and hide after about two seconds of
inactivity. Move the pointer or use the keyboard to reveal them. The dock stays
visible while you use the controls or an open menu.

**Ambiance mode** blends colours from the video into the background and removes
the player outline. It samples a frame when the video loads, after seeks and on
pause. Collab remembers the preference on this device.

The player uses the WebView's automatic decoder selection. On Linux, WebKitGTK
can use a GStreamer hardware decoder when the matching codec plugin, driver,
and GPU device are available to the app. The WebKit compositor setting
controls rendering. On a hybrid-GPU Linux system, the Tauri probe played a
4K HEVC Main 10 sample with NVIDIA NVDEC selected automatically. The same
probe played with AMD VA-API when preferred via GStreamer's
[feature ranks](https://gstreamer.freedesktop.org/documentation/gstreamer/running.html).
These checks cover decoder selection and playback startup. Sustained HDR
playback and packaged runtime support remain part of native qualification.

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
