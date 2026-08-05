import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (message: { payload: unknown }) => void;

const handlers = new Map<string, Handler[]>();
const unlistened: string[] = [];

const listen = vi.fn(async (event: string, handler: Handler) => {
  handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  return () => {
    unlistened.push(event);
    handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: Parameters<typeof listen>) => listen(...args),
}));

const { BACKGROUND_STATUS_EVENT, BACKGROUND_VAULT_SYNCED_EVENT, listenToBackgroundEvents } =
  await import('./backgroundEvents');

function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

/** Lets the pending `listen()` promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('native background events', () => {
  beforeEach(() => {
    handlers.clear();
    unlistened.length = 0;
    listen.mockClear();
  });

  it('delivers status and vault-synced payloads to their handlers', async () => {
    const onStatus = vi.fn();
    const onVaultSynced = vi.fn();

    listenToBackgroundEvents({ onStatus, onVaultSynced });
    await settle();

    emit(BACKGROUND_STATUS_EVENT, { activeJobs: 1, progress: { completed: 4, total: 9 } });
    emit(BACKGROUND_VAULT_SYNCED_EVENT, {
      serverUrl: 'https://collab.example',
      vaultId: 'vault-1',
      changed: 3,
    });

    expect(onStatus).toHaveBeenCalledWith({ activeJobs: 1, progress: { completed: 4, total: 9 } });
    expect(onVaultSynced).toHaveBeenCalledWith({
      serverUrl: 'https://collab.example',
      vaultId: 'vault-1',
      changed: 3,
    });
  });

  it('only subscribes to the events it was given a handler for', async () => {
    listenToBackgroundEvents({ onStatus: vi.fn() });
    await settle();

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0][0]).toBe(BACKGROUND_STATUS_EVENT);
  });

  it('stops delivering after dispose', async () => {
    const onStatus = vi.fn();
    const dispose = listenToBackgroundEvents({ onStatus });
    await settle();

    dispose();
    emit(BACKGROUND_STATUS_EVENT, { activeJobs: 1 });

    expect(onStatus).not.toHaveBeenCalled();
    expect(unlistened).toContain(BACKGROUND_STATUS_EVENT);
  });

  it('unsubscribes a listener that finished registering after dispose', async () => {
    // React strict mode mounts and unmounts an effect immediately, so dispose
    // routinely runs before `listen()` has resolved. Leaking there would leave a
    // handler bound to an unmounted tree for the life of the process.
    const dispose = listenToBackgroundEvents({ onStatus: vi.fn() });
    dispose();
    await settle();

    expect(unlistened).toContain(BACKGROUND_STATUS_EVENT);
    expect(handlers.get(BACKGROUND_STATUS_EVENT) ?? []).toHaveLength(0);
  });
});
