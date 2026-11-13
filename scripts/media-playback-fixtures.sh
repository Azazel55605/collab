#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z $1 ]]; then
  echo "Usage: $0 NEW_FIXTURE_DIRECTORY" >&2
  exit 2
fi
mkdir -- "$1"
cd -- "$1"

encode() {
  ffmpeg -hide_banner -loglevel error -nostdin -n "$@"
}

# Deterministic noisy video keeps the file large enough to distinguish a seek
# from preloading the whole file. Fast-start puts the MP4 index at the front.
encode -f lavfi -i 'testsrc2=size=1280x720:rate=24,noise=alls=24:allf=t+u:all_seed=12' \
  -f lavfi -i 'sine=frequency=440' -t 180 -c:v libx264 -preset ultrafast \
  -threads:v 4 -pix_fmt yuv420p -b:v 15M -maxrate 15M -bufsize 30M -g 48 \
  -c:a aac -movflags +faststart large.mp4

cat > sidecar.vtt <<'CAPTIONS'
WEBVTT

00:00:01.000 --> 00:00:18.000
Sidecar caption
CAPTIONS

encode -f lavfi -i 'testsrc2=size=640x360:rate=24' \
  -f lavfi -i 'sine=frequency=440' -f lavfi -i 'sine=frequency=880' \
  -f webvtt -i <(sed 's/Sidecar caption/Embedded caption/' sidecar.vtt) \
  -map 0:v -map 1:a -map 2:a -map 3:s -t 20 -c:v libx264 -preset ultrafast \
  -pix_fmt yuv420p -c:a aac -c:s mov_text -metadata:s:a:0 language=eng \
  -metadata:s:a:1 language=fra -metadata:s:s:0 language=eng -movflags +faststart tracks.mp4

encode -f lavfi -i 'testsrc2=size=640x360:rate=24' -f lavfi -i 'sine=frequency=440' \
  -t 5 -c:v libvpx-vp9 -deadline realtime -c:a libopus video.webm
encode -f lavfi -i 'sine=frequency=440' -t 5 -c:a libmp3lame tone.mp3
encode -f lavfi -i 'sine=frequency=440' -t 5 -c:a pcm_s16le tone.wav
encode -f lavfi -i 'sine=frequency=440' -t 5 -c:a flac tone.flac
