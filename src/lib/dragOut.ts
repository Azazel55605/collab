import { startDrag } from '@crabnebula/tauri-plugin-drag';

import { tauriCommands } from './tauri';

// A 1x1 transparent PNG used as the native drag preview. The plugin requires an
// icon and accepts a `data:image/png;base64,...` string, so we avoid needing a
// real file on disk; the OS typically shows its own file-drag affordance anyway.
const DRAG_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Starts a native OS drag carrying real filesystem paths, so vault files can be
 * dragged out to the desktop, the file manager, or another app instance (whose
 * file-drop importer then receives them). Must be called synchronously from a
 * `dragstart` handler — the OS drag has to begin within the user's gesture.
 */
export async function startFileDragOut(absolutePaths: string[]): Promise<void> {
  if (absolutePaths.length === 0) return;
  try {
    await startDrag({ item: absolutePaths, icon: DRAG_ICON, mode: 'copy' });
  } finally {
    await Promise.allSettled(absolutePaths.map((path) => tauriCommands.releaseDragTempFile(path)));
  }
}

/** Join a native vault root with a vault-relative path using the OS separator. */
export function nativeVaultPath(vaultPath: string, relativePath: string): string {
  const sep = vaultPath.includes('\\') ? '\\' : '/';
  const root = vaultPath.replace(/[\\/]+$/, '');
  const rel = relativePath.split('/').join(sep);
  return `${root}${sep}${rel}`;
}
