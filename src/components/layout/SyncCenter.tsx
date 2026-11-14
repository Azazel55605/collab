import { type ReactNode, useState } from 'react';

import {
  AlertTriangle,
  ArrowUp,
  CalendarDays,
  Check,
  CloudCheck,
  CloudOff,
  Download,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  WifiOff,
} from 'lucide-react';

import { hostedCalendarOriginKey } from '../../lib/calendarSync';
import type { BackgroundJobRecord } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { getVaultDocumentTitle } from '../../lib/vaultLinks';
import type { PendingOperation } from '../../lib/vaultReplica';
import type { RegisteredDocumentStatus } from '../../store/documentStatusStore';
import { type SyncTransfer, transferPercent } from '../../store/syncTransferStore';
import { useUiStore } from '../../store/uiStore';
import { ReauthenticateServerDialog } from '../server/ReauthenticateServerDialog';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Progress } from '../ui/progress';

import { ReviewDialog, useDocumentReconciliation } from './DocumentReconciler';
import {
  calendarOperationLabel,
  calendarProgressLabel,
  mirrorProgressLabel,
  useCalendarSync,
} from './sync/useCalendarSync';
import { useServerConnection } from './sync/useServerConnection';
import { useVaultSync } from './sync/useVaultSync';

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'not yet';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'not yet';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function fileName(operation: PendingOperation): string {
  const path = operation.relativePath ?? operation.fileId ?? 'item';
  return path.split('/').pop() ?? path;
}

const PENDING_VERB: Record<PendingOperation['kind'], string> = {
  create: 'created',
  edit: 'edited',
  rename: 'renamed',
  move: 'moved',
  trash: 'moved to trash',
  restore: 'restored',
  delete: 'deleted',
  assetUpload: 'added',
  logicComponentSave: 'component saved',
  logicComponentDelete: 'component deleted',
  pdfAnnotations: 'PDF ink',
  viewAnnotations: 'ink',
};

type ChipTone = 'quiet' | 'busy' | 'pending' | 'attention' | 'offline' | 'danger';

const CHIP_CLASS: Record<ChipTone, string> = {
  quiet: 'border-transparent text-muted-foreground hover:text-foreground',
  busy: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  pending: 'border-transparent text-amber-600 hover:text-amber-500 dark:text-amber-300',
  attention: 'border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300',
  offline: 'border-border bg-muted/60 text-foreground/80',
  danger: 'border-destructive/40 bg-destructive/12 text-destructive',
};

const BADGE_CLASS: Record<ChipTone, string> = {
  quiet: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  busy: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  attention: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  offline: 'bg-muted text-foreground/80',
  danger: 'bg-destructive/15 text-destructive',
};

/**
 * One status-bar chip for everything that syncs: the open hosted vault, hosted
 * calendars, the server connection and the active document's remote changes.
 * The chip shows only the worst state; its panel answers, in order, what needs
 * you, what is moving, and whether everything else is fine.
 */
export default function SyncCenter({
  document,
}: {
  /** The active document's registration, for remote changes and conflicts. */
  document?: { relativePath: string; status: RegisteredDocumentStatus } | null;
}) {
  const vault = useVaultSync();
  const calendars = useCalendarSync();
  const connection = useServerConnection();
  const setActiveView = useUiStore((state) => state.setActiveView);
  const [open, setOpen] = useState(false);
  const registration = document?.status;
  const reconciling = useDocumentReconciliation(
    registration?.readOnly ? null : (registration?.controller ?? null),
    registration?.readOnly ? null : (registration?.snapshot ?? null),
    registration?.onSaveAsNew,
  );
  const documentName = document ? getVaultDocumentTitle(document.relativePath) : undefined;
  // Views without a session controller still report remote changes and conflicts.
  const legacyDocumentIssue =
    !reconciling.reconciliation &&
    !registration?.readOnly &&
    (registration?.status === 'remote-pending' || registration?.status === 'conflict') &&
    (registration.onLoadRemote || registration.onKeepLocal)
      ? registration
      : null;
  const documentIssue = reconciling.reconciliation || legacyDocumentIssue ? 1 : 0;

  const hosted = !!vault.hostedVault;
  const anyTransfers = vault.activeTransfers.length > 0 || vault.recentTransfers.length > 0;
  if (!hosted && !calendars.active && !documentIssue && !anyTransfers) return null;

  const attentionCount =
    (vault.accessLost ? 0 : vault.failed.length) +
    calendars.issueCount +
    calendars.mirrorConflicts.length +
    documentIssue;
  const busy = vault.rollup === 'syncing' || calendars.busy || vault.activeTransfers.length > 0;
  const onlyTransfer = vault.activeTransfers.length === 1 ? vault.activeTransfers[0] : null;
  const onlyPercent = onlyTransfer ? transferPercent(onlyTransfer) : null;
  const offline = hosted && connection.state !== 'online';

  let chip: { tone: ChipTone; icon: ReactNode; label: string };
  if (vault.accessLost) {
    chip = {
      tone: 'danger',
      icon: <Lock />,
      label: vault.access === 'revoked' ? 'Access revoked' : 'Vault unavailable',
    };
  } else if (attentionCount > 0) {
    chip = {
      tone: 'attention',
      icon: <AlertTriangle />,
      label:
        vault.failed.length > 0 && attentionCount === vault.failed.length
          ? `${vault.failed.length} conflict${vault.failed.length === 1 ? '' : 's'}`
          : `${attentionCount} need${attentionCount === 1 ? 's' : ''} you`,
    };
  } else if (offline) {
    chip = {
      tone: 'offline',
      icon: <WifiOff />,
      label: connection.state === 'expired' ? 'Session expired' : 'Offline',
    };
  } else if (busy) {
    chip = {
      tone: 'busy',
      icon: <RefreshCw className="app-spin-soft" />,
      label: onlyPercent !== null ? `Syncing ${onlyPercent}%` : 'Syncing…',
    };
  } else if (vault.pending.length > 0) {
    chip = { tone: 'pending', icon: <ArrowUp />, label: `${vault.pending.length} pending` };
  } else if (calendars.waitingMirrors.length > 0) {
    chip = {
      tone: 'pending',
      icon: <Link2 />,
      label: `${calendars.waitingMirrors.length} mirror${calendars.waitingMirrors.length === 1 ? '' : 's'} waiting`,
    };
  } else {
    chip = { tone: 'quiet', icon: <Check />, label: 'Synced' };
  }

  const title = vault.accessLost
    ? chip.label
    : attentionCount > 0
      ? `${attentionCount} thing${attentionCount === 1 ? '' : 's'} need${attentionCount === 1 ? 's' : ''} you`
      : offline
        ? connection.state === 'expired'
          ? 'Your session ended'
          : 'Working offline'
        : busy
          ? 'Syncing'
          : vault.pending.length > 0
            ? `${vault.pending.length} change${vault.pending.length === 1 ? '' : 's'} waiting to send`
            : 'Everything is synced';
  const subtitle = offline
    ? vault.pending.length > 0
      ? `${vault.pending.length} change${vault.pending.length === 1 ? ' is' : 's are'} kept here and sent when you reconnect`
      : 'Changes are kept here and sent when you reconnect'
    : `Last synced ${timeAgo(vault.lastSyncedAt ?? calendars.latest)}`;

  const syncEverything = () => {
    if (hosted) void vault.syncNow();
    if (calendars.connectedOrigins.length > 0) void calendars.sync();
  };
  const syncDisabled =
    vault.isSyncing ||
    calendars.syncing ||
    vault.accessLost ||
    (!hosted && calendars.connectedOrigins.length === 0);

  const inProgress =
    vault.activeTransfers.length > 0 || vault.activeBackgroundJobs.length > 0 || calendars.busy;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Sync status"
            className={cn(
              'flex h-[18px] items-center gap-1 rounded-full border px-2 text-[10.5px] transition-colors app-motion-fast [&_svg]:size-[11px]',
              CHIP_CLASS[chip.tone],
            )}
          >
            <span key={chip.label} className="flex items-center gap-1 app-chip-change">
              {chip.icon}
              <span>{chip.label}</span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="w-[400px] gap-0 p-0 text-xs app-fade-scale-in"
        >
          <div className="flex items-center gap-2.5 px-3.5 py-3">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-4',
                BADGE_CLASS[chip.tone],
              )}
            >
              {chip.tone === 'quiet' ? <Check /> : chip.icon}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
              <p className="truncate text-[11.5px] text-muted-foreground">{subtitle}</p>
            </div>
            {offline ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                disabled={connection.reconnecting}
                onClick={() => void connection.reconnect()}
              >
                {connection.reconnecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Reconnect
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                disabled={syncDisabled}
                title={vault.accessLost ? 'Syncing is unavailable for this vault.' : undefined}
                onClick={syncEverything}
              >
                {vault.isSyncing || calendars.syncing ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Sync now
              </Button>
            )}
          </div>

          <div className="max-h-[min(60vh,520px)] overflow-y-auto">
            {(vault.accessLost || attentionCount > 0) && (
              <Section title="Needs attention">
                {vault.accessLost && (
                  <AttentionCard
                    tone="danger"
                    title={chip.label}
                    detail={
                      vault.access === 'revoked'
                        ? 'Your access to this vault was revoked on the server. The copy on this device and any unsent changes stay here until you remove them.'
                        : 'This vault is no longer on the server; it may have been deleted or archived. The copy on this device stays until you remove it.'
                    }
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        setOpen(false);
                        void vault.removeOfflineCopy();
                      }}
                    >
                      <Trash2 /> Remove offline copy
                    </Button>
                  </AttentionCard>
                )}
                {reconciling.reconciliation && (
                  <AttentionCard
                    tone={reconciling.reconciliation.kind === 'conflict' ? 'danger' : 'warning'}
                    title={
                      reconciling.reconciliation.kind === 'conflict'
                        ? `${documentName} changed on both sides`
                        : `A newer version of ${documentName} arrived`
                    }
                    detail="You have edits here too. Review both versions, or decide straight away."
                  >
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setOpen(false);
                        reconciling.setReviewOpen(true);
                      }}
                    >
                      Review…
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={reconciling.keepMine}
                    >
                      Keep mine
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={reconciling.loadRemote}
                    >
                      Use theirs
                    </Button>
                  </AttentionCard>
                )}
                {legacyDocumentIssue && (
                  <AttentionCard
                    tone={legacyDocumentIssue.status === 'conflict' ? 'danger' : 'warning'}
                    title={
                      legacyDocumentIssue.status === 'conflict'
                        ? `${documentName} changed on both sides`
                        : `A newer version of ${documentName} arrived`
                    }
                    detail="Keep your version or load the newer one."
                  >
                    {legacyDocumentIssue.onKeepLocal && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={legacyDocumentIssue.onKeepLocal}
                      >
                        Keep mine
                      </Button>
                    )}
                    {legacyDocumentIssue.onLoadRemote && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={legacyDocumentIssue.onLoadRemote}
                      >
                        Use theirs
                      </Button>
                    )}
                  </AttentionCard>
                )}
                {!vault.accessLost &&
                  vault.failed.map((recovery) => (
                    <AttentionCard
                      key={recovery.operation.id}
                      tone="danger"
                      title={`${fileName(recovery.operation)} couldn’t be ${PENDING_VERB[recovery.operation.kind]} on the server`}
                      detail={recovery.failure.message}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={vault.busyOp === recovery.operation.id}
                        onClick={() => void vault.recover(recovery.operation.id, 'retry')}
                      >
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={vault.busyOp === recovery.operation.id}
                        onClick={() => void vault.recover(recovery.operation.id, 'discard')}
                      >
                        Discard my change
                      </Button>
                    </AttentionCard>
                  ))}
                {calendars.conflicts.map((conflict) => {
                  const id = conflict.operation.clientOperationId;
                  return (
                    <AttentionCard
                      key={id}
                      tone="warning"
                      title={`${calendarOperationLabel(conflict.operation)} couldn’t sync`}
                      detail={conflict.lastError}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={calendars.activeConflict != null || calendars.syncing}
                        onClick={() => void calendars.retry(id)}
                      >
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={calendars.activeConflict != null || calendars.syncing}
                        onClick={() => void calendars.discard(id)}
                      >
                        Discard my change
                      </Button>
                    </AttentionCard>
                  );
                })}
                {calendars.failures.map((result) => (
                  <AttentionCard
                    key={`failure:${result.serverUrl}`}
                    tone="warning"
                    title={`Calendars on ${new URL(result.serverUrl).host} couldn’t sync`}
                    detail={result.error ?? undefined}
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={calendars.syncing}
                      onClick={() => void calendars.sync()}
                    >
                      Retry
                    </Button>
                  </AttentionCard>
                ))}
                {calendars.mirrorGroups
                  .filter((group) => {
                    const status = calendars.mirrorStatuses.find(
                      (entry) => entry.groupId === group.id,
                    );
                    return (
                      status?.state === 'error' ||
                      status?.state === 'conflict' ||
                      calendars.mirrorConflicts.some((entry) => entry.groupId === group.id)
                    );
                  })
                  .map((group) => {
                    const status = calendars.mirrorStatuses.find(
                      (entry) => entry.groupId === group.id,
                    );
                    const conflicted = status?.state !== 'error';
                    return (
                      <AttentionCard
                        key={`mirror:${group.id}`}
                        tone="warning"
                        title={
                          conflicted
                            ? `Mirror “${group.name}” has conflicting changes`
                            : `Mirror “${group.name}” couldn’t sync`
                        }
                        detail={
                          conflicted ? 'Choose which version wins in Calendar.' : status?.error
                        }
                      >
                        {conflicted ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => {
                              setOpen(false);
                              setActiveView('calendar');
                            }}
                          >
                            Review in Calendar
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={calendars.syncing || calendars.connectedOrigins.length === 0}
                            onClick={() => void calendars.sync()}
                          >
                            Retry
                          </Button>
                        )}
                      </AttentionCard>
                    );
                  })}
              </Section>
            )}

            {inProgress && (
              <Section title="In progress">
                {vault.activeTransfers.map((transfer) => (
                  <TransferRow key={transfer.id} transfer={transfer} />
                ))}
                {vault.activeBackgroundJobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
                {calendars.origins.map((origin) => {
                  const progress = calendars.progress[hostedCalendarOriginKey(origin)];
                  if (!progress || progress.phase === 'complete' || progress.phase === 'error')
                    return null;
                  return (
                    <StatusRow
                      key={`cal-progress:${hostedCalendarOriginKey(origin)}`}
                      icon={<Loader2 className="animate-spin" />}
                      tone="busy"
                      title={`Calendars · ${new URL(origin.serverUrl).host}`}
                      detail={calendarProgressLabel(progress)}
                    />
                  );
                })}
                {calendars.mirrorGroups.map((group) => {
                  const progress = calendars.mirrorProgress[group.id];
                  if (progress?.phase !== 'checking' && progress?.phase !== 'applying') return null;
                  return (
                    <StatusRow
                      key={`mirror-progress:${group.id}`}
                      icon={<Loader2 className="animate-spin" />}
                      tone="busy"
                      title={`Mirror · ${group.name}`}
                      detail={mirrorProgressLabel(progress) ?? 'Syncing'}
                    />
                  );
                })}
              </Section>
            )}

            {vault.pending.length > 0 && (
              <Section title={offline ? 'Waiting to send' : 'Pending changes'}>
                {vault.pending.slice(0, 6).map((operation) => (
                  <StatusRow
                    key={operation.id}
                    icon={<Upload />}
                    tone="pending"
                    title={fileName(operation)}
                    detail={
                      operation.status === 'inflight' ? 'sending…' : PENDING_VERB[operation.kind]
                    }
                  />
                ))}
                {vault.pending.length > 6 && (
                  <p className="px-1 pt-0.5 text-[11.5px] text-muted-foreground">
                    and {vault.pending.length - 6} more
                  </p>
                )}
              </Section>
            )}

            <Section title="Everything">
              {hosted && (
                <StatusRow
                  icon={vault.accessLost ? <Lock /> : <CloudCheck />}
                  tone={vault.accessLost ? 'danger' : offline ? 'offline' : 'quiet'}
                  title={vault.hostedVault!.name}
                  detail={[
                    'Vault',
                    `synced ${timeAgo(vault.lastSyncedAt)}`,
                    vault.offlineAvailableAt ? 'offline copy' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              )}
              {hosted && connection.host && (
                <StatusRow
                  icon={connection.state === 'online' ? <Server /> : <CloudOff />}
                  tone={connection.state === 'online' ? 'quiet' : 'offline'}
                  title={connection.host}
                  detail={
                    connection.state === 'online'
                      ? `Online${connection.account ? ` · signed in as ${connection.account}` : ''}`
                      : connection.state === 'expired'
                        ? 'Session expired'
                        : 'Not reachable'
                  }
                  action={
                    connection.state !== 'online' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={connection.reconnecting}
                        onClick={() => void connection.reconnect()}
                      >
                        Reconnect
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {calendars.origins.map((origin) => {
                const key = hostedCalendarOriginKey(origin);
                const result = calendars.results.find(
                  (entry) => entry.serverUrl === origin.serverUrl,
                );
                const connected = calendars.connectedOriginKeys.has(key);
                return (
                  <StatusRow
                    key={`cal:${key}`}
                    icon={<CalendarDays />}
                    tone={result?.error ? 'attention' : connected ? 'quiet' : 'offline'}
                    title={`Calendars · ${new URL(origin.serverUrl).host}`}
                    detail={
                      result?.error
                        ? 'Needs attention above'
                        : result
                          ? `Synced ${timeAgo(result.completedAt)} · ${result.replayedOperations} up, ${result.appliedChanges} down`
                          : connected
                            ? 'Waiting for first sync'
                            : 'Cached offline'
                    }
                    action={
                      !connected ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                          disabled={calendars.syncing || calendars.activeConflict != null}
                          title="Remove cached calendars"
                          onClick={() => void calendars.removeCache(origin)}
                        >
                          Remove cache
                        </Button>
                      ) : undefined
                    }
                  />
                );
              })}
              {calendars.mirrorGroups.map((group) => {
                const status = calendars.mirrorStatuses.find((entry) => entry.groupId === group.id);
                const waiting = status?.state === 'waiting';
                return (
                  <StatusRow
                    key={`mirror:${group.id}`}
                    icon={<Link2 />}
                    tone={waiting ? 'pending' : 'quiet'}
                    title={`Mirror · ${group.name}`}
                    detail={
                      waiting
                        ? 'Waiting for every server connection'
                        : !group.enabled || status?.state === 'disabled'
                          ? 'Paused'
                          : status?.lastBridgedAt
                            ? `Up to date · ${timeAgo(status.lastBridgedAt)}`
                            : 'Ready for first sync'
                    }
                  />
                );
              })}
              {!hosted && !calendars.active && (
                <p className="px-1 py-1 text-[11.5px] text-muted-foreground">
                  This vault is stored on this device.
                </p>
              )}
            </Section>

            {vault.recentTransfers.length > 0 && (
              <Section
                title="Recent"
                action={
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={vault.clearFinishedTransfers}
                  >
                    Clear
                  </button>
                }
              >
                {vault.recentTransfers.map((transfer) => (
                  <TransferRow key={transfer.id} transfer={transfer} />
                ))}
              </Section>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {reconciling.reconciliation && (
        <ReviewDialog
          open={reconciling.reviewOpen}
          onOpenChange={reconciling.setReviewOpen}
          reconciliation={reconciling.reconciliation}
          documentName={documentName}
          onLoadRemote={reconciling.loadRemote}
          onKeepMine={reconciling.keepMine}
          onSaveAsNew={reconciling.saveAsNew}
          savingAsNew={reconciling.savingAsNew}
        />
      )}
      <ReauthenticateServerDialog
        server={connection.signInServer}
        onOpenChange={(next) => !next && connection.setSignInServer(null)}
      />
    </>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="border-t border-border/60 px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center">
        <h3 className="flex-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {title}
        </h3>
        {action}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function AttentionCard({
  tone,
  title,
  detail,
  children,
}: {
  tone: 'warning' | 'danger';
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-[9px] border px-2.5 py-2',
        tone === 'danger'
          ? 'border-destructive/30 bg-destructive/[0.06]'
          : 'border-amber-500/30 bg-amber-500/[0.06]',
      )}
    >
      <p className="text-[12.5px] font-medium text-foreground">{title}</p>
      {detail && (
        <p className="mt-0.5 line-clamp-3 text-[11.5px] text-muted-foreground" title={detail}>
          {detail}
        </p>
      )}
      {children && <div className="mt-2 flex flex-wrap gap-1.5 [&_svg]:size-3.5">{children}</div>}
    </div>
  );
}

const ROW_TONE: Record<ChipTone, string> = {
  quiet: 'text-emerald-600 dark:text-emerald-400',
  busy: 'text-sky-600 dark:text-sky-400',
  pending: 'text-amber-600 dark:text-amber-400',
  attention: 'text-amber-600 dark:text-amber-400',
  offline: 'text-muted-foreground',
  danger: 'text-destructive',
};

function StatusRow({
  icon,
  tone,
  title,
  detail,
  action,
  children,
}: {
  icon: ReactNode;
  tone: ChipTone;
  title: string;
  detail?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 py-0.5">
      <span className={cn('mt-0.5 shrink-0 [&_svg]:size-3.5', ROW_TONE[tone])}>{icon}</span>
      <div className="min-w-0 flex-1 leading-snug">
        <p className="truncate text-[12.5px] text-foreground">{title}</p>
        {detail && (
          <p className="truncate text-[11.5px] text-muted-foreground" title={detail}>
            {detail}
          </p>
        )}
        {children}
      </div>
      {action}
    </div>
  );
}

function TransferRow({ transfer }: { transfer: SyncTransfer }) {
  const percent = transferPercent(transfer);
  const count =
    transfer.total !== null
      ? `${Math.min(transfer.completed, transfer.total)} of ${transfer.total}`
      : null;
  const icon =
    transfer.status === 'failed' ? (
      <AlertTriangle />
    ) : transfer.status === 'completed' ? (
      <Check />
    ) : transfer.direction === 'upload' ? (
      <Upload />
    ) : transfer.direction === 'download' ? (
      <Download />
    ) : (
      <RefreshCw className="app-spin-soft" />
    );
  const tone: ChipTone =
    transfer.status === 'failed' ? 'danger' : transfer.status === 'completed' ? 'offline' : 'busy';
  const detail =
    transfer.error ??
    ([transfer.vaultName, transfer.detail].filter(Boolean).join(' · ') || undefined);
  return (
    <StatusRow
      icon={icon}
      tone={tone}
      title={transfer.label}
      detail={detail}
      action={
        transfer.status === 'active' && (percent !== null || count) ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {percent !== null ? `${percent}%` : count}
          </span>
        ) : undefined
      }
    >
      {transfer.status === 'active' &&
        (percent !== null ? (
          <Progress value={percent} className="mt-1 h-1" />
        ) : (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-primary/20">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
        ))}
    </StatusRow>
  );
}

function JobRow({ job }: { job: BackgroundJobRecord }) {
  const total = job.progress.total;
  const percent =
    total && total > 0 ? Math.min(100, Math.round((job.progress.completed / total) * 100)) : null;
  const label =
    job.kind === 'replica_sync'
      ? 'Vault sync'
      : job.kind === 'calendar_sync'
        ? 'Calendar sync'
        : job.kind === 'notification_sync'
          ? 'Notification sync'
          : 'Maintenance';
  return (
    <StatusRow
      icon={<RefreshCw className="app-spin-soft" />}
      tone="busy"
      title={label}
      detail={job.progress.detail ?? job.summary ?? job.status.replace(/_/g, ' ')}
    >
      {percent !== null ? (
        <Progress value={percent} className="mt-1 h-1" />
      ) : (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-primary/20">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      )}
    </StatusRow>
  );
}
