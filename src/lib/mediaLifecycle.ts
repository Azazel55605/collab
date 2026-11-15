const cleanup = new Set<() => void>();
const playbackCheckpoints = new Set<() => void>();
let generation = 0;
export function mediaGeneration() {
  return generation;
}
export function registerMediaCleanup(callback: () => void) {
  cleanup.add(callback);
  return () => {
    cleanup.delete(callback);
  };
}
export function clearMediaResources() {
  generation++;
  for (const callback of cleanup) callback();
}

export function registerPlaybackCheckpoint(callback: () => void) {
  playbackCheckpoints.add(callback);
  return () => {
    playbackCheckpoints.delete(callback);
  };
}

export function checkpointMediaPlayback() {
  for (const callback of playbackCheckpoints) callback();
}
