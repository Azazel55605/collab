export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function supportsVersionHistoryTabType(type: string | null | undefined): boolean {
  return type === 'note' || type === 'kanban' || type === 'canvas' || type === 'sheet' || type === 'ink';
}

export function supportsVersionHistoryRelativePath(relativePath: string, isFolder = false): boolean {
  if (isFolder) return false;
  const extension = relativePath.split('.').pop()?.toLowerCase() ?? '';
  return extension === 'md' || extension === 'kanban' || extension === 'canvas' || extension === 'sheet' || extension === 'ink';
}
