import type { BackgroundStatusSnapshot } from '../../../../src/lib/tauri';

import { Spinner } from './ui';

/**
 * Reduces a job's progress detail to something worth reading.
 *
 * The executors report either a vault name or a vault-relative file path. A
 * path's directories say nothing useful at this size, so only the last segment
 * is kept — the same reduction the sync widget applies, for the same reason.
 */
export function syncActivityDetail(detail: string | null | undefined): string | null {
  const trimmed = detail?.trim();
  if (!trimmed) return null;
  const last = trimmed
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .pop();
  return last || null;
}

/** The "12 of 40" line, or null when the run cannot state a total. */
export function syncProgressLabel(completed: number, total: number | null): string | null {
  if (total === null || total <= 0) return null;
  return `${Math.min(completed, total)} of ${total}`;
}

/**
 * What background sync is doing right now.
 *
 * Sync used to run entirely silently — the only visible progress in the app was
 * the one-off "make available offline" bar — so a long reconciliation looked
 * like the app had simply stopped responding. This is fed by the coordinator's
 * own `background:status` events, so it reports work the app itself did not
 * start, including a WorkManager run already in flight when the app opened.
 *
 * It renders nothing when nothing is running: an idle state does not need a row.
 */
export function SyncActivityBanner({ status }: { status: BackgroundStatusSnapshot | null }) {
  if (!status || status.activeJobs < 1) return null;

  const detail = syncActivityDetail(status.progress.detail);
  const progress = syncProgressLabel(status.progress.completed, status.progress.total);
  const total = status.progress.total;
  // A run that never stated a total gets an indeterminate track rather than an
  // invented percentage.
  const percent =
    total !== null && total > 0
      ? Math.round((Math.min(status.progress.completed, total) / total) * 100)
      : null;

  return (
    <div className="sync-activity" role="status" aria-live="polite">
      <div className="sync-activity-head">
        <Spinner size={15} />
        <div className="sync-activity-text">
          <strong>
            {status.activeJobs === 1 ? 'Syncing' : `Syncing · ${status.activeJobs} jobs`}
          </strong>
          <span>{[detail, progress].filter(Boolean).join(' · ') || 'Checking for changes'}</span>
        </div>
      </div>
      <div
        className="progress-track sync-activity-track"
        role="progressbar"
        {...(percent === null
          ? { 'aria-valuetext': 'Working' }
          : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
      >
        <div
          className={`progress-fill ${percent === null ? 'indeterminate' : ''}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
