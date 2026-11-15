import { useSyncExternalStore } from 'react';

import type { NoteFile, VaultMeta } from '../types/vault';

import { documentVaultIdentity } from './documentPaneContext';
import { registerMediaCleanup } from './mediaLifecycle';

interface MediaResume {
  revision: string;
  position: number;
  duration: number;
  fileVersion: string | null;
  rate: number;
  volume: number;
  muted: boolean;
  caption: string;
  captionPath: string | null;
  audio: string;
  isolatedAudio: number | null;
  compatibility: boolean;
}

interface ResumeEntry extends MediaResume {
  vault: string;
  path: string;
}

const recent = new Map<string, ResumeEntry>();
const listeners = new Set<() => void>();
let snapshot: ResumeEntry[] = [];
function publish() {
  snapshot = [...recent.values()].reverse();
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

registerMediaCleanup(() => {
  if (recent.size) {
    recent.clear();
    publish();
  }
});

export function mediaFileVersion(file: NoteFile | undefined) {
  return file ? JSON.stringify([file.contentRevision, file.modifiedAt, file.size]) : null;
}

function resumeKey(vault: VaultMeta, path: string) {
  return JSON.stringify([documentVaultIdentity(vault), path]);
}

export function readMediaResume(vault: VaultMeta, path: string) {
  return recent.get(resumeKey(vault, path));
}

export function forgetMediaResume(vault: VaultMeta, path: string) {
  if (recent.delete(resumeKey(vault, path))) publish();
}

export function rememberMediaResume(vault: VaultMeta, path: string, resume: MediaResume) {
  const key = resumeKey(vault, path);
  recent.delete(key);
  recent.set(key, { ...resume, path, vault: documentVaultIdentity(vault)! });
  if (recent.size > 64) recent.delete(recent.keys().next().value!);
  publish();
}

export function useRecentMedia() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
