const cleanup = new Set<() => void>();
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
