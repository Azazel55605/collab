import type { PersistStorage, StorageValue } from 'zustand/middleware';

/** Defer JSON serialization itself, not just the localStorage call. */
export function createDeferredPersistence<T extends object>(
  name: string,
  storage: () => Storage = () => localStorage,
  delay = 300,
) {
  let latest: StorageValue<T> | undefined;
  let written: StorageValue<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!latest) return;
    try {
      storage().setItem(name, JSON.stringify(latest));
      written = latest;
      latest = undefined;
    } catch (error) {
      // Keep the pending value available for a later explicit/lifecycle flush.
      console.error(`Could not persist ${name}`, error);
    }
  };
  const adapter: PersistStorage<T> = {
    getItem: () => {
      if (latest) return latest;
      try {
        const raw = storage().getItem(name);
        return raw ? (JSON.parse(raw) as StorageValue<T>) : null;
      } catch {
        return null;
      }
    },
    setItem: (_key, value) => {
      const previous = latest ?? written;
      if (
        previous &&
        value.version === previous.version &&
        Object.keys(value.state).length === Object.keys(previous.state).length &&
        Object.keys(value.state).every((key) =>
          Object.is(value.state[key as keyof T], previous.state[key as keyof T]),
        )
      )
        return;
      latest = value;
      // A fixed window bounds staleness even during continuous panning/typing.
      if (timer === undefined) timer = setTimeout(flush, delay);
    },
    removeItem: () => {
      clearTimeout(timer);
      timer = undefined;
      latest = written = undefined;
      storage().removeItem(name);
    },
  };
  return { storage: adapter, flush };
}
