import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { DeckAssetRef } from '../../types/deck';
import { bytesDataUrl } from '../assetBytes';
import { registerMediaCleanup } from '../mediaLifecycle';
import { previewIdentity } from '../previewIdentity';
import { previewScheduler } from '../previewScheduler';
import type { VaultClient } from '../vaultClient';

type Entry = {
  controller: AbortController;
  url: string | null;
  cost: number;
  used: number;
  failed?: boolean;
  retry?: ReturnType<typeof setTimeout>;
  owners: Set<symbol>;
};
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let notification = false;
const BUDGET = 96 * 1024 * 1024;
function notify() {
  if (notification) return;
  notification = true;
  queueMicrotask(() => {
    notification = false;
    version++;
    for (const listener of listeners) listener();
  });
}
function remove(key: string) {
  const entry = entries.get(key);
  entry?.controller.abort();
  clearTimeout(entry?.retry);
  entries.delete(key);
}
function retryLater(key: string, entry: Entry) {
  entry.failed = true;
  entry.retry = setTimeout(() => {
    if (entries.get(key) === entry) {
      remove(key);
      notify();
    }
  }, 30000);
}
registerMediaCleanup(() => {
  for (const key of entries.keys()) remove(key);
  notify();
});
export function deckMediaStats() {
  return { entries: entries.size, bytes: [...entries.values()].reduce((n, e) => n + e.cost, 0) };
}
function request(client: VaultClient, asset: DeckAssetRef, owner: symbol) {
  const key = previewIdentity(client, asset.path, `deck:1920:${asset.sha256 ?? ''}`);
  const existing = entries.get(key);
  if (existing) {
    existing.used = Date.now();
    existing.owners.add(owner);
    return existing.url;
  }
  const entry: Entry = {
    controller: new AbortController(),
    url: null,
    cost: 0,
    used: Date.now(),
    owners: new Set([owner]),
  };
  while (entries.size >= 64) {
    const oldest = [...entries].find(([, e]) => !e.owners.size);
    if (!oldest) return null;
    remove(oldest[0]);
  }
  entries.set(key, entry);
  void previewScheduler
    .run(
      key,
      async (signal) => {
        if (!client.readAssetBytes) return client.readAssetDataUrl(asset.path);
        const bytes = await client.readAssetBytes(asset.path, signal, true, 1920);
        return bytesDataUrl(bytes, /\.svg$/i.test(asset.path) ? 'image/svg+xml' : 'image/png');
      },
      { signal: entry.controller.signal },
    )
    .then(
      (url) => {
        if (entry.controller.signal.aborted || entries.get(key) !== entry) return;
        const scale = Math.min(
          1,
          1920 / Math.max(1, asset.pixelWidth),
          1440 / Math.max(1, asset.pixelHeight),
        );
        let width = Math.ceil(asset.pixelWidth * scale),
          height = Math.ceil(asset.pixelHeight * scale);
        if (url.startsWith('data:image/png;base64,')) {
          const header = atob(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 33));
          if (header.length >= 24) {
            const view = new DataView(Uint8Array.from(header, (c) => c.charCodeAt(0)).buffer);
            width = view.getUint32(16);
            height = view.getUint32(20);
          }
        } else if (url.startsWith('data:image/svg')) {
          width = 1920;
          height = 1440;
        }
        const cost = url.length * 2 + width * height * 4;
        let occupied = deckMediaStats().bytes;
        for (const [id, old] of entries) {
          if (occupied + cost <= BUDGET) break;
          if (id !== key && !old.owners.size) {
            occupied -= old.cost;
            remove(id);
          }
        }
        if (occupied + cost <= BUDGET) {
          entry.url = url;
          entry.cost = cost;
        } else retryLater(key, entry);
        notify();
      },
      () => {
        if (!entry.controller.signal.aborted) {
          retryLater(key, entry);
          notify();
        }
      },
    );
  return null;
}
/** Only assets actually requested by mounted slide/rail/presenter renderers are loaded. */
export function useDeckMedia(client: VaultClient | null) {
  useSyncExternalStore(
    useCallback((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []),
    () => version,
  );
  const owner = useMemo(() => Symbol('deck media'), [client]);
  const owned = useRef(new Set<string>());
  const rendered = new Set<string>();
  const release = (key: string) => {
    const entry = entries.get(key);
    entry?.owners.delete(owner);
    if (entry && !entry.owners.size) remove(key);
  };
  useEffect(() => {
    for (const key of owned.current) if (!rendered.has(key)) release(key);
    owned.current = rendered;
  });
  useEffect(
    () => () => {
      for (const key of owned.current) release(key);
    },
    [owner],
  );
  return (asset: DeckAssetRef) => {
    if (!client) return null;
    rendered.add(previewIdentity(client, asset.path, `deck:1920:${asset.sha256 ?? ''}`));
    return request(client, asset, owner);
  };
}
