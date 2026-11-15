import { useMemo, useSyncExternalStore } from 'react';

import { useCollabStore } from '../store/collabStore';
import { useServerStore } from '../store/serverStore';
import { MEDIA_RESUME_STORAGE_KEY, useUiStore } from '../store/uiStore';
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

const MAX_ENTRIES = 64;
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

export function mediaResumeAccount(vault: VaultMeta | null) {
  if (!vault) return null;
  if (vault.kind !== 'hosted') return useCollabStore.getState().myUserId;
  const user = useServerStore.getState().statusFor(vault.serverUrl)?.user;
  return user?.status === 'active' ? user.id : null;
}

export function useMediaResumeAccount(vault: VaultMeta | null) {
  const localProfile = useCollabStore((state) => state.myUserId);
  const hostedAccount = useServerStore((state) => {
    const user = vault?.kind === 'hosted' ? state.statusFor(vault.serverUrl)?.user : null;
    return user?.status === 'active' ? user.id : null;
  });
  return vault?.kind === 'hosted' ? hostedAccount : localProfile;
}

function resumeScope(vault: VaultMeta, account: string | null) {
  return JSON.stringify([documentVaultIdentity(vault), vault.id, account]);
}

function resumeKey(scope: string, path: string) {
  return JSON.stringify([scope, path]);
}

function isResumeEntry(value: unknown): value is ResumeEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ResumeEntry>;
  return (
    typeof entry.vault === 'string' &&
    typeof entry.path === 'string' &&
    typeof entry.revision === 'string' &&
    typeof entry.duration === 'number' &&
    Number.isFinite(entry.duration) &&
    entry.duration > 0 &&
    typeof entry.position === 'number' &&
    entry.position >= 0 &&
    entry.position <= entry.duration &&
    typeof entry.rate === 'number' &&
    entry.rate >= 0.25 &&
    entry.rate <= 4 &&
    typeof entry.volume === 'number' &&
    entry.volume >= 0 &&
    entry.volume <= 1 &&
    typeof entry.muted === 'boolean' &&
    typeof entry.compatibility === 'boolean' &&
    typeof entry.caption === 'string' &&
    typeof entry.audio === 'string' &&
    (entry.fileVersion === null || typeof entry.fileVersion === 'string') &&
    (entry.captionPath === null || typeof entry.captionPath === 'string') &&
    (entry.isolatedAudio === null ||
      (typeof entry.isolatedAudio === 'number' &&
        Number.isSafeInteger(entry.isolatedAudio) &&
        entry.isolatedAudio >= 0))
  );
}

function readStoredEntries() {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(MEDIA_RESUME_STORAGE_KEY) ?? '[]');
    if (Array.isArray(data)) return data.slice(0, MAX_ENTRIES).filter(isResumeEntry);
  } catch {
    // Playback is still available when storage is missing or invalid.
  }
  return [];
}

function writeStoredEntries(entries: ResumeEntry[]) {
  try {
    localStorage.setItem(MEDIA_RESUME_STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // The in-session position is still available.
  }
}

function canPersist(vault: VaultMeta, account: string | null) {
  return !vault.isEncrypted && (vault.kind !== 'hosted' || account !== null);
}

export function readMediaResume(vault: VaultMeta, path: string) {
  const account = mediaResumeAccount(vault);
  const scope = resumeScope(vault, account);
  return (
    recent.get(resumeKey(scope, path)) ??
    (useUiStore.getState().rememberMediaOnRestart && canPersist(vault, account)
      ? readStoredEntries().find((entry) => entry.vault === scope && entry.path === path)
      : undefined)
  );
}

export function forgetMediaResume(vault: VaultMeta, path: string) {
  const account = mediaResumeAccount(vault);
  const scope = resumeScope(vault, account);
  const removed = recent.delete(resumeKey(scope, path));
  if (useUiStore.getState().rememberMediaOnRestart && canPersist(vault, account)) {
    const entries = readStoredEntries();
    const remaining = entries.filter((entry) => entry.vault !== scope || entry.path !== path);
    if (entries.length !== remaining.length) {
      writeStoredEntries(remaining);
      publish();
      return;
    }
  }
  if (removed) publish();
}

export function rememberMediaResume(vault: VaultMeta, path: string, resume: MediaResume) {
  const account = mediaResumeAccount(vault);
  const scope = resumeScope(vault, account);
  const key = resumeKey(scope, path);
  const entry = { ...resume, path, vault: scope };
  recent.delete(key);
  recent.set(key, entry);
  if (recent.size > MAX_ENTRIES) recent.delete(recent.keys().next().value!);
  if (useUiStore.getState().rememberMediaOnRestart && canPersist(vault, account)) {
    const entries = readStoredEntries();
    writeStoredEntries([
      entry,
      ...entries.filter((other) => other.vault !== scope || other.path !== path),
    ]);
  }
  publish();
}

export function useRecentMedia(vault: VaultMeta) {
  const session = useSyncExternalStore(subscribe, () => snapshot);
  const enabled = useUiStore((state) => state.rememberMediaOnRestart);
  const account = useMediaResumeAccount(vault);
  return useMemo(() => {
    const scope = resumeScope(vault, account);
    const entries = session.filter((entry) => entry.vault === scope);
    if (!enabled || !canPersist(vault, account)) return entries;
    const paths = new Set(entries.map((entry) => entry.path));
    return entries.concat(
      readStoredEntries().filter((entry) => entry.vault === scope && !paths.has(entry.path)),
    );
  }, [account, enabled, session, vault]);
}
