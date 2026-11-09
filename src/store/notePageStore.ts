import { create } from 'zustand';

import { DEFAULT_NOTE_PAGE_SETTINGS, type NotePageSettings } from '../lib/notePageLayout';

const STORAGE_KEY = 'collab-note-pages-v1';
const MODE_KEY = 'collab-note-pages-enabled-v1';

function loadMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

function loadSettings(): NotePageSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      paper: saved.paper === 'letter' ? 'letter' : 'a4',
      orientation: saved.orientation === 'landscape' ? 'landscape' : 'portrait',
      margins: saved.margins === 'narrow' || saved.margins === 'wide' ? saved.margins : 'normal',
    };
  } catch {
    return DEFAULT_NOTE_PAGE_SETTINGS;
  }
}

export const useNotePageStore = create<{
  paged: boolean;
  setPaged: (paged: boolean) => void;
  settings: NotePageSettings;
  setSettings: (patch: Partial<NotePageSettings>) => void;
}>((set) => ({
  paged: loadMode(),
  setPaged: (paged) => {
    try {
      localStorage.setItem(MODE_KEY, String(paged));
    } catch {
      /* Best-effort preference. */
    }
    set({ paged });
  },
  settings: loadSettings(),
  setSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Layout remains usable when local preference storage is unavailable.
      }
      return { settings };
    }),
}));
