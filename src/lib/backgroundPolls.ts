import { recordPollWake } from './performanceDiagnostics';

/** One clock and one wakeup listener set for desktop polling consumers. */
type Poll = {
  run: () => unknown;
  interval: number;
  due: number;
  failures: number;
  active: boolean;
  disposed: boolean;
};
const polls = new Set<Poll>();
let timer: ReturnType<typeof setTimeout> | undefined;
let listening = false;
const usable = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (!usable()) return;
  const next = Math.min(...[...polls].filter((p) => !p.active).map((p) => p.due));
  if (Number.isFinite(next)) timer = setTimeout(tick, Math.max(100, next - Date.now()));
}
function tick() {
  recordPollWake();
  timer = undefined;
  if (!usable()) return;
  for (const poll of polls) {
    if (poll.active || poll.due > Date.now()) continue;
    poll.active = true;
    void Promise.resolve()
      .then(poll.run)
      .then(
        () => {
          poll.failures = 0;
        },
        () => {
          poll.failures = Math.min(6, poll.failures + 1);
        },
      )
      .finally(() => {
        poll.active = false;
        poll.due = Date.now() + Math.min(300000, poll.interval * 2 ** poll.failures);
        if (!poll.disposed) schedule();
      });
  }
  schedule();
}
function wake() {
  if (!usable()) {
    schedule();
    return;
  }
  for (const poll of polls) if (!poll.active) poll.due = Math.min(poll.due, Date.now() + 100);
  schedule();
}
function listen(add: boolean) {
  if (add === listening) return;
  listening = add;
  const method = add ? 'addEventListener' : 'removeEventListener';
  window[method]('online', wake);
  window[method]('offline', wake);
  window[method]('focus', wake);
  window[method]('collab:poll-invalidate', wake);
  document[method]('visibilitychange', wake);
}
export function subscribeBackgroundPoll(run: () => unknown, interval: number, immediate = false) {
  const poll: Poll = {
    run,
    interval: Math.max(1000, interval),
    due: Date.now() + (immediate ? 0 : interval),
    failures: 0,
    active: false,
    disposed: false,
  };
  polls.add(poll);
  listen(true);
  schedule();
  return () => {
    poll.disposed = true;
    polls.delete(poll);
    if (!polls.size) listen(false);
    schedule();
  };
}
export function backgroundPollStats() {
  return {
    subscribers: polls.size,
    running: [...polls].filter((p) => p.active).length,
    timers: timer ? 1 : 0,
  };
}
