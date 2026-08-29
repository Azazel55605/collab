import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { BackgroundStatusSnapshot } from '../../../../src/lib/tauri';

import { SyncActivityBanner, syncActivityDetail, syncProgressLabel } from './SyncActivityBanner';

function status(
  // `progress` is omitted before being re-added, because intersecting
  // `Partial<Snapshot>` with a partial `progress` demands both shapes and so
  // still requires every progress field.
  overrides: Omit<Partial<BackgroundStatusSnapshot>, 'progress'> & {
    progress?: Partial<BackgroundStatusSnapshot['progress']>;
  } = {},
): BackgroundStatusSnapshot {
  return {
    generatedAt: '2026-08-11T10:00:00Z',
    activeJobs: 1,
    attentionRequired: 0,
    lastSuccessfulAt: null,
    nextEligibleRetryAt: null,
    ...overrides,
    progress: { completed: 9, total: 12, detail: 'plan.md', ...overrides.progress },
  };
}

describe('SyncActivityBanner', () => {
  it('renders nothing when no job is running', () => {
    // An idle state does not need a row, and a banner that never leaves would
    // permanently cost a screen 60px of its list.
    const { container } = render(<SyncActivityBanner status={status({ activeJobs: 0 })} />);
    expect(container.innerHTML).toBe('');

    const { container: none } = render(<SyncActivityBanner status={null} />);
    expect(none.innerHTML).toBe('');
  });

  it('names what is syncing and how far along it is', () => {
    render(<SyncActivityBanner status={status()} />);

    expect(screen.getByText('Syncing')).toBeTruthy();
    expect(screen.getByText('plan.md · 9 of 12')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75');
  });

  it('reports an unknown total as working rather than as a proportion', () => {
    render(<SyncActivityBanner status={status({ progress: { total: null } })} />);

    const bar = screen.getByRole('progressbar');
    // A run with no total must not claim a percentage. It has no aria-valuenow
    // at all, so a screen reader announces "Working" instead of "0 percent".
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('aria-valuetext')).toBe('Working');
    expect(screen.getByText('plan.md')).toBeTruthy();
  });

  it('falls back to a generic line when the run has reported nothing', () => {
    render(<SyncActivityBanner status={status({ progress: { detail: null, total: null } })} />);

    expect(screen.getByText('Checking for changes')).toBeTruthy();
  });

  it('counts concurrent jobs in the headline', () => {
    render(<SyncActivityBanner status={status({ activeJobs: 3 })} />);

    expect(screen.getByText('Syncing · 3 jobs')).toBeTruthy();
  });

  it('shows only the last segment of a path detail', () => {
    // The folders above a file describe how someone organises their work and
    // add nothing at this size, so they are not rendered.
    expect(syncActivityDetail('Notes/Personal/Finances/plan.md')).toBe('plan.md');
    expect(syncActivityDetail('Team vault')).toBe('Team vault');
    expect(syncActivityDetail('Notes/Personal/')).toBe('Personal');
    expect(syncActivityDetail('   ')).toBeNull();
    expect(syncActivityDetail(null)).toBeNull();
  });

  it('never renders progress past its own end', () => {
    expect(syncProgressLabel(9, 12)).toBe('9 of 12');
    // A stale completed count outrunning its total would otherwise read as
    // "14 of 12" and a bar past 100%.
    expect(syncProgressLabel(14, 12)).toBe('12 of 12');
    expect(syncProgressLabel(4, null)).toBeNull();
    expect(syncProgressLabel(0, 0)).toBeNull();
  });
});
