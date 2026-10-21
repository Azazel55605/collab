import { useEffect, useMemo, useState } from 'react';

import { mediaGeneration, registerMediaCleanup } from './mediaLifecycle';
import { type PreviewPriority, previewScheduler } from './previewScheduler';
import { type LinkPreviewData, tauriCommands } from './tauri';

export interface WebPreviewCacheEntry {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  data: LinkPreviewData | null;
  error: string | null;
}

const MAX_CACHE_ENTRIES = 128;
const SUCCESS_TTL_MS = 10 * 60_000;
const ERROR_TTL_MS = 30_000;
const cache = new Map<string, WebPreviewCacheEntry & { expiresAt: number }>();
function store(url: string, entry: WebPreviewCacheEntry) {
  cache.delete(url);
  cache.set(url, {
    ...entry,
    expiresAt: Date.now() + (entry.status === 'error' ? ERROR_TTL_MS : SUCCESS_TTL_MS),
  });
  let completed = [...cache.values()].filter((value) => value.status !== 'loading').length;
  for (const [key, value] of cache) {
    if (completed <= MAX_CACHE_ENTRIES) break;
    if (key !== url && value.status !== 'loading') {
      cache.delete(key);
      completed--;
    }
  }
}
function currentEntry(url: string) {
  const entry = cache.get(url);
  if (entry && entry.status !== 'loading' && entry.expiresAt <= Date.now()) {
    cache.delete(url);
    return undefined;
  }
  if (entry) {
    cache.delete(url);
    cache.set(url, entry);
  }
  return entry;
}
registerMediaCleanup(() => {
  cache.clear();
  for (const url of listeners.keys()) emit(url);
});
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
  return currentEntry(normalizedUrl) ?? { status: 'idle', data: null, error: null };
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

export async function requestWebPreview(
  url: string,
  options: { signal?: AbortSignal; priority?: PreviewPriority } = {},
): Promise<LinkPreviewData> {
  const normalizedUrl = normalizeWebPreviewUrl(url);
  if (!normalizedUrl) throw new Error('URL is required');
  const existing = currentEntry(normalizedUrl);
  if (existing?.status === 'loaded' && existing.data) return existing.data;
  if (existing?.status === 'error') throw new Error(existing.error ?? 'Preview unavailable');
  store(normalizedUrl, { status: 'loading', data: existing?.data ?? null, error: null });
  emit(normalizedUrl);
  const generation = mediaGeneration();
  return previewScheduler
    .run(
      `web:${normalizedUrl}`,
      async (signal) => {
        try {
          const data = await tauriCommands.fetchLinkPreview(normalizedUrl, signal);
          if (signal.aborted || generation !== mediaGeneration())
            throw new DOMException('Cancelled', 'AbortError');
          store(normalizedUrl, { status: 'loaded', data, error: null });
          emit(normalizedUrl);
          return data;
        } catch (error) {
          if (!previewScheduler.isCurrent(`web:${normalizedUrl}`, signal)) throw error;
          if (signal.aborted || generation !== mediaGeneration()) cache.delete(normalizedUrl);
          else
            store(normalizedUrl, {
              status: 'error',
              data: null,
              error: error instanceof Error ? error.message : String(error),
            });
          emit(normalizedUrl);
          throw error;
        }
      },
      options,
    )
    .catch((error) => {
      if (
        getCachedWebPreview(normalizedUrl).status === 'loading' &&
        !previewScheduler.has(`web:${normalizedUrl}`)
      ) {
        cache.delete(normalizedUrl);
        emit(normalizedUrl);
      }
      throw error;
    });
}

/** Lazy prefetch producers keep hundreds of links out of the scheduler's pending closures. */
export function prefetchWebPreviews(urls: Iterable<string>, signal?: AbortSignal) {
  const request = new AbortController();
  const abort = () => request.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const items = [...new Set(Array.from(urls, normalizeWebPreviewUrl).filter(Boolean))]
    .slice(0, 512)
    [Symbol.iterator]();
  const run = async () => {
    while (!request.signal.aborted) {
      const next = items.next();
      if (next.done) break;
      try {
        await requestWebPreview(next.value, { signal: request.signal, priority: 'background' });
      } catch {
        /* prefetch is optional */
      }
    }
  };
  void Promise.all(Array.from({ length: 4 }, run)).finally(() =>
    signal?.removeEventListener('abort', abort),
  );
  return abort;
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
  const [entry, setEntry] = useState<WebPreviewCacheEntry>(() =>
    normalizedUrl
      ? getCachedWebPreview(normalizedUrl)
      : { status: 'idle', data: null, error: null },
  );

  useEffect(() => {
    if (!enabled || !normalizedUrl) {
      setEntry({ status: 'idle', data: null, error: null });
      return;
    }

    setEntry(getCachedWebPreview(normalizedUrl));
    const unsubscribe = subscribeWebPreview(normalizedUrl, () => {
      setEntry(getCachedWebPreview(normalizedUrl));
    });

    const request = new AbortController();
    void requestWebPreview(normalizedUrl, { signal: request.signal, priority: 'visible' }).catch(
      () => {},
    );
    return () => {
      request.abort();
      unsubscribe();
    };
  }, [enabled, normalizedUrl]);

  return {
    normalizedUrl,
    preview: entry.data,
    error: entry.error,
    loading: entry.status === 'loading',
  };
}
