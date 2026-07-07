/**
 * Runtime-toggleable live-collaboration tracing sink.
 *
 * The live provider (`liveDocumentSession.ts`) and structured live session
 * (`liveJsonDocument.ts`) push short, human-readable events here. When debug is
 * enabled (via the Settings toggle → {@link setLiveCollabDebug}, or the legacy
 * `localStorage.collabLiveDebug` fallback) events are mirrored to the console and
 * retained in a bounded ring buffer so the in-app Live Debug panel can render and
 * copy them — no devtools required.
 *
 * Off by default and effectively zero-cost: when disabled, {@link liveDebugPush}
 * returns immediately without allocating an event.
 */

export interface LiveDebugEvent {
  /** Monotonic id for stable React keys. */
  id: number;
  /** Wall-clock time captured when the event was recorded. */
  at: number;
  /** Short file-id prefix identifying the document/session. */
  file: string;
  /** The event message (already formatted by the caller). */
  message: string;
}

const MAX_EVENTS = 500;

let enabled = readLegacyFlag();
let nextId = 1;
const events: LiveDebugEvent[] = [];
// Immutable snapshot handed to `useSyncExternalStore`. Reassigned to a fresh
// array only when the buffer changes, so React re-renders on change but the
// reference stays stable between changes (avoiding an infinite render loop).
let snapshot: readonly LiveDebugEvent[] = events.slice();
const listeners = new Set<() => void>();

function readLegacyFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('collabLiveDebug') === '1';
  } catch {
    return false;
  }
}

/** Whether live tracing is currently on. */
export function isLiveCollabDebugEnabled(): boolean {
  return enabled;
}

/**
 * Enables or disables live tracing at runtime. Wired to the Settings toggle in
 * `App.tsx` so flipping the switch takes effect immediately for open sessions.
 */
export function setLiveCollabDebug(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  notify();
}

/** Records a trace event (and echoes to the console) when tracing is enabled. */
export function liveDebugPush(file: string, message: string): void {
  if (!enabled) return;
  const event: LiveDebugEvent = { id: nextId++, at: Date.now(), file: file.slice(0, 8), message };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  // eslint-disable-next-line no-console
  console.info(`[live ${event.file}]`, message);
  snapshot = events.slice();
  notify();
}

/** Current buffered events (newest last). */
export function getLiveDebugEvents(): readonly LiveDebugEvent[] {
  return snapshot;
}

/** Clears the buffered events. */
export function clearLiveDebugEvents(): void {
  events.length = 0;
  snapshot = events.slice();
  notify();
}

/** Subscribe to buffer/flag changes (for `useSyncExternalStore`). */
export function subscribeLiveDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}
