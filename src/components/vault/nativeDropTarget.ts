/** Resolve visible rows by geometry, independent of portals/overlays covering them. */
export function nativeDropFolderAtPoint(
  container: HTMLElement | null,
  point: { x: number; y: number },
): string | undefined {
  if (!container) return undefined;
  for (const row of container.querySelectorAll<HTMLElement>('[data-tree-drop-folder]')) {
    const bounds = row.getBoundingClientRect();
    if (
      point.x >= bounds.left &&
      point.x < bounds.right &&
      point.y >= bounds.top &&
      point.y < bounds.bottom
    ) {
      return row.dataset.treeDropFolder || undefined;
    }
  }
  return undefined;
}
