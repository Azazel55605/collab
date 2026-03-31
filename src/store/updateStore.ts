import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { tauriCommands } from '../lib/tauri';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up_to_date'
  | 'downloading'
  | 'installing'
  | 'error';

export interface UpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
  date: string | null;
}

interface UpdateState {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number | null; // 0–100, null when not downloading
  error: string | null;
  lastChecked: Date | null;
  checkForUpdate: () => Promise<void>;
  startDownload: () => Promise<void>;
  reset: () => void;
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  status: 'idle',
  updateInfo: null,
  downloadProgress: null,
  error: null,
  lastChecked: null,

  checkForUpdate: async () => {
    if (get().status === 'checking' || get().status === 'downloading' || get().status === 'installing') {
      return;
    }
    set({ status: 'checking', error: null });
    try {
      const info = await tauriCommands.checkForUpdate();
      set({
        status: info.available ? 'available' : 'up_to_date',
        updateInfo: info,
        lastChecked: new Date(),
      });
    } catch (e) {
      set({ status: 'error', error: String(e), lastChecked: new Date() });
    }
  },

  startDownload: async () => {
    const { updateInfo } = get();
    if (!updateInfo?.available) return;

    set({ status: 'downloading', downloadProgress: 0, error: null });

    const unlisten = await listen<{ downloaded: number; contentLength: number | null }>(
      'update:progress',
      (event) => {
        const { downloaded, contentLength } = event.payload;
        if (contentLength) {
          set({ downloadProgress: Math.round((downloaded / contentLength) * 100) });
        }
      }
    );

    try {
      set({ status: 'installing' });
      await tauriCommands.downloadAndInstall();
      // App restarts after install — this code is unreachable on success
    } catch (e) {
      set({ status: 'error', error: String(e), downloadProgress: null });
    } finally {
      unlisten();
    }
  },

  reset: () => set({ status: 'idle', updateInfo: null, downloadProgress: null, error: null }),
}));
