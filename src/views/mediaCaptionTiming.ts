const originalTimes = new WeakMap<TextTrackCue, [number, number]>();

export function adjustCaptionTiming(track: TextTrack, offset: number) {
  for (const cue of Array.from(track.cues ?? [])) {
    const original = originalTimes.get(cue);
    if (!original && offset === 0) continue;
    const [start, end] = original ?? [cue.startTime, cue.endTime];
    if (!original) originalTimes.set(cue, [start, end]);
    const shift = offset / 1000;
    cue.startTime = Math.max(0, start + shift);
    cue.endTime = Math.max(0, end + shift);
  }
}

export function managedCaption(media: HTMLMediaElement, selection: string) {
  const track = media.textTracks[Number(selection)];
  const node =
    track && Array.from(media.querySelectorAll('track')).find((item) => item.track === track);
  if (!node) return undefined;
  // The loopback handle changes on reopen. Its final asset segment stays stable.
  const url = node.getAttribute('src') ?? '';
  const asset = url.slice(url.lastIndexOf('/') + 1);
  return { track, key: JSON.stringify([asset, node.label, node.srclang]) };
}
