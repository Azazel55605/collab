/** Explicit bounded diagnostics. Never record document content, paths or tokens. */
const enabled = import.meta.env.VITE_COLLAB_PERFORMANCE_DIAGNOSTICS === '1';
type Event = { kind: string; millis: number; bytes?: number };
type NativeSnapshot = {
  appVersion: string;
  runId: string | null;
  elapsedMillis: number;
  enabled: boolean;
  platform: string;
  rssBytes: number | null;
  peakRssBytes: number | null;
  events: Array<{ operation: string; millis: number }>;
};
const events: Event[] = [];
const scenarios: Array<Record<string, unknown>> = [];
let droppedEvents = 0;
let active: { name: string; start: number; native: NativeSnapshot } | null = null;
export interface PerformanceDiagnosticsApi {
  start(name: string): Promise<void>;
  finish(): Promise<unknown>;
  export(): Promise<void>;
  report(): Promise<unknown>;
  status(): { active: string | null; scenarios: number; interactions: number };
}
let installedApi: PerformanceDiagnosticsApi | null = null;
export function getPerformanceDiagnostics() {
  return installedApi;
}
let nativeSnapshot: (() => Promise<NativeSnapshot>) | null = null;
function record(event: Event) {
  if (!enabled) return;
  if (events.length >= 2048) {
    events.shift();
    droppedEvents++;
  }
  events.push(event);
}
export function traceIpc<T>(operation: string, args: unknown, run: () => Promise<T>): Promise<T> {
  if (!enabled) return run();
  const start = performance.now();
  const estimate = (v: unknown): number =>
    typeof v === 'string'
      ? v.length * 2
      : v instanceof ArrayBuffer
        ? v.byteLength
        : ArrayBuffer.isView(v)
          ? v.byteLength
          : 0;
  const bytes =
    estimate(args) ||
    (args && typeof args === 'object'
      ? Object.values(args).reduce<number>((n, v) => n + estimate(v), 0)
      : 0);
  return run().finally(() =>
    record({ kind: `ipc:${operation}`, millis: performance.now() - start, bytes }),
  );
}
export function recordPollWake() {
  if (enabled) record({ kind: 'poll-wake', millis: 0 });
}
export function installPerformanceDiagnostics(
  snapshot: () => Promise<NativeSnapshot>,
  saveReport?: (report: unknown) => Promise<void>,
) {
  if (!enabled || typeof window === 'undefined') return;
  nativeSnapshot = snapshot;
  const firstPaint = new Promise<NativeSnapshot>((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void snapshot()
          .then(resolve)
          .catch(() => {});
      }),
    ),
  );
  let framePending = false;
  const interaction = () => {
    if (framePending) return;
    framePending = true;
    const start = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        framePending = false;
        record({ kind: 'interaction', millis: performance.now() - start });
      }),
    );
  };
  window.addEventListener('pointerdown', interaction, { passive: true });
  window.addEventListener('keydown', interaction, { passive: true });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record({ kind: 'long-task', millis: entry.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* WebKit has no long-task observer. */
  }
  const api: PerformanceDiagnosticsApi = {
    status() {
      return {
        active: active?.name ?? null,
        scenarios: scenarios.length,
        interactions: events.filter((e) => e.kind === 'interaction').length,
      };
    },
    async start(name: string) {
      if (active) throw new Error('Finish the active performance scenario first');
      if (!['cold-start', 'warm-start', 'idle', 'interaction', 'open-close-soak'].includes(name))
        throw new Error('Unknown performance scenario');
      const native = await snapshot();
      if (!native.enabled)
        throw new Error('Enable COLLAB_PERFORMANCE_DIAGNOSTICS=1 in the native process');
      events.length = 0;
      droppedEvents = 0;
      active = { name, start: performance.now(), native };
    },
    async finish() {
      if (!active) throw new Error('No performance scenario is active');
      const capture = active;
      const durationMs = capture.name.endsWith('-start')
        ? (await firstPaint).elapsedMillis
        : performance.now() - capture.start;
      const native = await snapshot();
      const sample = {
        name: capture.name,
        durationMs,
        nativeStart: capture.native,
        nativeEnd: native,
        events: [...events],
        droppedEvents,
      };
      if (scenarios.length >= 32) scenarios.shift();
      scenarios.push(sample);
      active = null;
      return sample;
    },
    async export() {
      if (!saveReport) throw new Error('Native report export is unavailable');
      await saveReport(await api.report());
    },
    async report() {
      const native = await nativeSnapshot!();
      return {
        appVersion: native.appVersion,
        schemaVersion: 1,
        platform: navigator.userAgent.includes('Windows')
          ? 'windows-webview2'
          : navigator.userAgent.includes('Mac')
            ? 'macos-webkit'
            : 'linux-webkitgtk',
        collectedAt: new Date().toISOString(),
        startupMs: performance.now(),
        native,
        scenarios: [...scenarios],
      };
    },
  };
  installedApi = api;
  Object.assign(window, { collabPerformance: api });
}
