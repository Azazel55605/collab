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
  downloadedBytes: number | null;
  totalBytes: number | null;
  downloadSpeed: number | null; // bytes/sec, rolling 2s window
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
  downloadedBytes: null,
  totalBytes: null,
  downloadSpeed: null,
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

    set({ status: 'downloading', downloadProgress: 0, downloadedBytes: 0, totalBytes: null, downloadSpeed: null, error: null });

    // Rolling window of { bytes, time } for speed calculation
    let speedSamples: Array<{ bytes: number; time: number }> = [];
    let lastDownloaded = 0;

    const unlisten = await listen<{ downloaded: number; contentLength: number | null }>(
      'update:progress',
      (event) => {
        const { downloaded, contentLength } = event.payload;
        const now = Date.now();

        const chunk = downloaded - lastDownloaded;
        lastDownloaded = downloaded;

        // Keep only samples from the last 2 seconds for speed
        speedSamples.push({ bytes: chunk, time: now });
        speedSamples = speedSamples.filter(s => now - s.time < 2000);
        const windowBytes = speedSamples.reduce((s, x) => s + x.bytes, 0);
        const windowSec   = speedSamples.length > 1
          ? (speedSamples[speedSamples.length - 1].time - speedSamples[0].time) / 1000
          : 1;
        const speed = windowSec > 0 ? windowBytes / windowSec : 0;

        set({
          downloadedBytes: downloaded,
          totalBytes: contentLength,
          downloadProgress: contentLength ? Math.round((downloaded / contentLength) * 100) : null,
          downloadSpeed: speed,
        });
      }
    );

    try {
      set({ status: 'installing' });
      await tauriCommands.downloadAndInstall();
      // App restarts after install — this code is unreachable on success
    } catch (e) {
      set({ status: 'error', error: String(e), downloadProgress: null, downloadedBytes: null });
    } finally {
      unlisten();
    }
  },

  reset: () => set({ status: 'idle', updateInfo: null, downloadProgress: null, downloadedBytes: null, totalBytes: null, downloadSpeed: null, error: null }),
}));
