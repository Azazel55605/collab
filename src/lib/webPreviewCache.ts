import { useEffect, useMemo, useState } from 'react';
import { tauriCommands, type LinkPreviewData } from './tauri';

export interface WebPreviewCacheEntry {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  data: LinkPreviewData | null;
  error: string | null;
}

const cache = new Map<string, WebPreviewCacheEntry>();
const inflight = new Map<string, Promise<LinkPreviewData>>();
const listeners = new Map<string, Set<() => void>>();

function emit(url: string) {
  const set = listeners.get(url);
  if (!set) return;
  for (const listener of set) listener();
}

export function normalizeWebPreviewUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).toString();
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString();
    } catch {
      return trimmed;
    }
  }
}

export function getWebPreviewHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function getCachedWebPreview(url: string): WebPreviewCacheEntry {
  const normalizedUrl = normalizeWebPreviewUrl(url);
  return cache.get(normalizedUrl) ?? { status: 'idle', data: null, error: null };
}

export function subscribeWebPreview(url: string, listener: () => void) {
  const normalizedUrl = normalizeWebPreviewUrl(url);
  if (!normalizedUrl) return () => {};
  const set = listeners.get(normalizedUrl) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(normalizedUrl, set);
  return () => {
    const current = listeners.get(normalizedUrl);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(normalizedUrl);
  };
}

export async function requestWebPreview(url: string): Promise<LinkPreviewData> {
  const normalizedUrl = normalizeWebPreviewUrl(url);
  if (!normalizedUrl) throw new Error('URL is required');

  const existing = cache.get(normalizedUrl);
  if (existing?.status === 'loaded' && existing.data) return existing.data;
  if (existing?.status === 'loading') {
    const running = inflight.get(normalizedUrl);
    if (running) return running;
  }

  cache.set(normalizedUrl, {
    status: 'loading',
    data: existing?.data ?? null,
    error: null,
  });
  emit(normalizedUrl);

  const promise = tauriCommands.fetchLinkPreview(normalizedUrl)
    .then((data) => {
      cache.set(normalizedUrl, { status: 'loaded', data, error: null });
      inflight.delete(normalizedUrl);
      emit(normalizedUrl);
      return data;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      cache.set(normalizedUrl, { status: 'error', data: null, error: message });
      inflight.delete(normalizedUrl);
      emit(normalizedUrl);
      throw error;
    });

  inflight.set(normalizedUrl, promise);
  return promise;
}

export function prefetchWebPreviews(urls: Iterable<string>) {
  for (const url of urls) {
    const normalizedUrl = normalizeWebPreviewUrl(url);
    if (!normalizedUrl) continue;
    const existing = cache.get(normalizedUrl);
    if (existing?.status === 'loaded' || existing?.status === 'loading') continue;
    void requestWebPreview(normalizedUrl).catch(() => {});
  }
}

export function extractHttpUrls(text: string) {
  const results = new Set<string>();
  const markdownLinkRegex = /\[[^\]]+]\((https?:\/\/[^)\s]+)\)/gi;
  const bareUrlRegex = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

  for (const match of text.matchAll(markdownLinkRegex)) {
    const url = normalizeWebPreviewUrl(match[1] ?? '');
    if (url) results.add(url);
  }

  for (const match of text.matchAll(bareUrlRegex)) {
    const url = normalizeWebPreviewUrl(match[0] ?? '');
    if (url) results.add(url);
  }

  return [...results];
}

export function useWebPreview(url: string | null | undefined, enabled: boolean) {
  const normalizedUrl = useMemo(() => normalizeWebPreviewUrl(url ?? ''), [url]);
  const [entry, setEntry] = useState<WebPreviewCacheEntry>(() => (
    normalizedUrl ? getCachedWebPreview(normalizedUrl) : { status: 'idle', data: null, error: null }
  ));

  useEffect(() => {
    if (!enabled || !normalizedUrl) {
      setEntry({ status: 'idle', data: null, error: null });
      return;
    }

    setEntry(getCachedWebPreview(normalizedUrl));
    const unsubscribe = subscribeWebPreview(normalizedUrl, () => {
      setEntry(getCachedWebPreview(normalizedUrl));
    });

    if (getCachedWebPreview(normalizedUrl).status === 'idle') {
      void requestWebPreview(normalizedUrl).catch(() => {});
    }

    return unsubscribe;
  }, [enabled, normalizedUrl]);

  return {
    normalizedUrl,
    preview: entry.data,
    error: entry.error,
    loading: entry.status === 'loading',
  };
}
