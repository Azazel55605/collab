import { useEffect, useMemo, useRef, useState } from 'react';

import { LayoutDashboard, RefreshCw } from 'lucide-react';

import type {
  CalendarDefinition,
  CalendarEvent,
  CalendarTask,
} from '../../../../src/types/calendar';
import type {
  WidgetCaptureAction,
  WidgetCaptureOptions,
  WidgetConfiguration,
  WidgetDiagnostics,
  WidgetPrivacy,
  WidgetShortcutOptions,
  WidgetSyncAccount,
  WidgetTaskOptions,
} from '../../../../src/types/widget';
import { mobileCalendarProfileId } from '../lib/calendarSync';
import {
  listProfileCalendarItems,
  listProfileCalendars,
  widgetActiveProfileSet,
  widgetConfigurationList,
  widgetConfigurationSave,
  widgetDiagnosticsList,
  widgetRefresh,
  widgetSyncAccounts,
} from '../mobileTauri';
import { useMobileStore } from '../state/store';

const PRIVACY_OPTIONS: Array<[WidgetPrivacy, string]> = [
  ['full', 'Full details'],
  ['titleOnly', 'Titles only'],
  ['private', 'Private'],
];

const WIDGET_KIND_LABELS = {
  agenda: 'Agenda',
  month: 'Month',
  birthday: 'Birthdays',
  countdown: 'Countdowns',
  tasks: 'Tasks',
  capture: 'Quick capture',
  shortcuts: 'Shortcuts',
  sync: 'Sync status',
} as const;

const CAPTURE_ACTIONS: Array<[WidgetCaptureAction, string]> = [
  ['note', 'New note'],
  ['task', 'New task'],
  ['event', 'New event'],
  ['files', 'Add files'],
];

const DEFAULT_CAPTURE_OPTIONS: WidgetCaptureOptions = {
  actions: ['note', 'task', 'event', 'files'],
};

const DEFAULT_SHORTCUT_OPTIONS: WidgetShortcutOptions = { pinned: [], includeRecent: true };

function captureOptions(configuration: WidgetConfiguration): WidgetCaptureOptions {
  return { ...DEFAULT_CAPTURE_OPTIONS, ...(configuration.capture ?? {}) };
}

function shortcutOptions(configuration: WidgetConfiguration): WidgetShortcutOptions {
  return { ...DEFAULT_SHORTCUT_OPTIONS, ...(configuration.shortcuts ?? {}) };
}

const DEFAULT_TASK_OPTIONS: WidgetTaskOptions = {
  includeCalendarTasks: true,
  includeKanbanTasks: true,
  includeUndated: true,
  selectedBoardIds: [],
};

/** Older configurations predate the task options, so reads normalize them. */
function taskOptions(configuration: WidgetConfiguration): WidgetTaskOptions {
  return { ...DEFAULT_TASK_OPTIONS, ...(configuration.tasks ?? {}) };
}

function countdownDateLabel(event: CalendarEvent) {
  const value = event.start.kind === 'date' ? event.start.date : event.start.dateTime;
  const date = new Date(event.start.kind === 'date' ? `${value}T00:00:00` : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : value;
}

/** What a widget's selected sources mean depends on its kind: calendars for the
 * calendar family, hosted accounts for the sync rollup. */
export function widgetSourceSummary(configuration: WidgetConfiguration): string {
  const noun = configuration.kind === 'sync' ? 'accounts' : 'calendars';
  const count = configuration.selectedSourceIds.length;
  if (count === 0) return `All ${noun}`;
  return `${count} ${count === 1 ? noun.slice(0, -1) : noun}`;
}

export function WidgetSettingsSection() {
  const profileId = mobileCalendarProfileId();
  const [configurations, setConfigurations] = useState<WidgetConfiguration[]>([]);
  const [calendars, setCalendars] = useState<CalendarDefinition[]>([]);
  const [countdownEvents, setCountdownEvents] = useState<CalendarEvent[]>([]);
  const [kanbanTasks, setKanbanTasks] = useState<CalendarTask[]>([]);
  const [diagnostics, setDiagnostics] = useState<WidgetDiagnostics[]>([]);
  const [syncAccounts, setSyncAccounts] = useState<WidgetSyncAccount[]>([]);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configurationsRef = useRef<WidgetConfiguration[]>([]);
  const saveQueuesRef = useRef(new Map<string, Promise<void>>());
  const saveVersionsRef = useRef(new Map<string, number>());
  const diagnosticsById = useMemo(
    () => new Map(diagnostics.map((entry) => [entry.configurationId, entry])),
    [diagnostics],
  );
  const countdownCandidates = useMemo(() => {
    const byId = new Map<string, CalendarEvent>();
    countdownEvents.forEach((event) => {
      const selectionId = event.recurrenceSeriesId ?? event.id;
      if (!byId.has(selectionId)) byId.set(selectionId, event);
    });
    return [...byId.entries()].slice(0, 24);
  }, [countdownEvents]);
  /** Boards are derived from cached Kanban assignments, so the picker only ever
   * lists boards this profile already has authorized tasks in. */
  const boardCandidates = useMemo(() => {
    const byFileId = new Map<string, string>();
    kanbanTasks.forEach((task) => {
      const binding = task.sourceBinding;
      if (binding?.kind !== 'kanban' || byFileId.has(binding.fileId)) return;
      const label = binding.path
        ?.split('/')
        .pop()
        ?.replace(/\.kanban$/, '');
      byFileId.set(binding.fileId, label || 'Kanban board');
    });
    return [...byFileId.entries()].slice(0, 24);
  }, [kanbanTasks]);
  // Pins are offered from the vault the user currently has open in Files, so
  // this screen never has to enumerate every server's contents.
  const selectedVault = useMobileStore((state) => state.selected);
  const vaultFiles = useMobileStore((state) => state.files);
  const pinCandidates = useMemo(
    () => vaultFiles.filter((entry) => entry.state === 'active').slice(0, 40),
    [vaultFiles],
  );

  const applyConfigurations = (next: WidgetConfiguration[]) => {
    configurationsRef.current = next;
    setConfigurations(next);
  };

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const rangeStart = new Date();
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(rangeEnd.getDate() + 366);
    Promise.all([
      widgetActiveProfileSet(profileId),
      widgetConfigurationList(profileId),
      listProfileCalendars(profileId),
      widgetDiagnosticsList(profileId),
      listProfileCalendarItems(
        profileId,
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
        2_000,
        false,
      ),
      // Accounts are only needed by the sync widget, and a failure here must not
      // stop the rest of the widget settings from loading.
      widgetSyncAccounts().catch(() => [] as WidgetSyncAccount[]),
    ])
      .then(([, nextConfigurations, nextCalendars, nextDiagnostics, nextItems, nextAccounts]) => {
        if (cancelled) return;
        setSyncAccounts(nextAccounts);
        applyConfigurations(nextConfigurations);
        setCalendars(nextCalendars.filter((calendar) => !calendar.deletedAt && !calendar.archived));
        setDiagnostics(nextDiagnostics);
        setCountdownEvents(
          nextItems.filter((item): item is CalendarEvent => item.kind === 'event'),
        );
        setKanbanTasks(
          nextItems.filter(
            (item): item is CalendarTask =>
              item.kind === 'task' && item.sourceBinding?.kind === 'kanban',
          ),
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const save = (
    configurationId: string,
    update: (configuration: WidgetConfiguration) => WidgetConfiguration,
  ) => {
    const previous = configurationsRef.current.find(
      (entry) => entry.configurationId === configurationId,
    );
    if (!previous) return;
    const next = { ...update(previous), updatedAt: new Date().toISOString() };
    applyConfigurations(
      configurationsRef.current.map((entry) =>
        entry.configurationId === configurationId ? next : entry,
      ),
    );
    setError(null);
    const version = (saveVersionsRef.current.get(configurationId) ?? 0) + 1;
    saveVersionsRef.current.set(configurationId, version);
    const priorQueue = saveQueuesRef.current.get(configurationId) ?? Promise.resolve();
    const queued = priorQueue
      .catch(() => {})
      .then(async () => {
        try {
          const saved = await widgetConfigurationSave(profileId, next);
          if (saveVersionsRef.current.get(configurationId) !== version) return;
          applyConfigurations(
            configurationsRef.current.map((entry) =>
              entry.configurationId === saved.configurationId ? saved : entry,
            ),
          );
          setDiagnostics(await widgetDiagnosticsList(profileId));
        } catch (reason) {
          if (saveVersionsRef.current.get(configurationId) === version) {
            applyConfigurations(
              configurationsRef.current.map((entry) =>
                entry.configurationId === configurationId ? previous : entry,
              ),
            );
            setError(String(reason));
          }
        }
      });
    saveQueuesRef.current.set(configurationId, queued);
  };

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      setDiagnostics(await widgetRefresh(profileId));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="card">
      <div className="card-title">
        <LayoutDashboard size={18} aria-hidden />
        <span>Mobile widgets</span>
        <button
          type="button"
          className="icon-button widget-refresh-button"
          aria-label="Refresh widgets"
          disabled={busy || refreshing || configurations.length === 0}
          onClick={() => void refresh()}
        >
          <RefreshCw size={17} aria-hidden className={refreshing ? 'spin' : ''} />
        </button>
      </div>
      {busy ? <p className="footnote">Loading widget configurations…</p> : null}
      {!busy && configurations.length === 0 ? (
        <p className="footnote">
          Add the Collab Agenda widget from your Android launcher. Its configuration will appear
          here.
        </p>
      ) : null}
      {configurations.map((configuration, index) => {
        const status = diagnosticsById.get(configuration.configurationId);
        return (
          <div className="widget-settings-entry" key={configuration.configurationId}>
            <div className="setting-row">
              <div>
                <strong>
                  {WIDGET_KIND_LABELS[configuration.kind]} {index + 1}
                </strong>
                <span>{widgetSourceSummary(configuration)}</span>
              </div>
              <span className="widget-live-label">Changes apply live</span>
            </div>
            <div
              className="widget-diagnostics"
              aria-label={`${WIDGET_KIND_LABELS[configuration.kind]} ${index + 1} status`}
            >
              <span>
                {status?.lastSuccessAt
                  ? `Updated ${new Date(status.lastSuccessAt).toLocaleString()}`
                  : 'Waiting for first update'}
              </span>
              {status ? (
                <span>
                  {status.itemCount} items · {Math.ceil(status.serializedBytes / 1024)} KB ·{' '}
                  {status.generationDurationMs} ms
                  {status.truncated ? ' · limited' : ''}
                </span>
              ) : null}
              {status?.lastError ? <span className="error-text">{status.lastError}</span> : null}
              {status && (status.staleSources > 0 || status.unavailableSources > 0) ? (
                <span>
                  {status.staleSources} stale · {status.unavailableSources} unavailable sources
                </span>
              ) : null}
            </div>
            {configuration.kind === 'countdown' ? (
              <div className="setting-row stacked">
                <div>
                  <strong>Countdown events</strong>
                  <span>Select up to 24 upcoming events.</span>
                </div>
                <div className="widget-calendar-options">
                  {countdownCandidates.length === 0 ? (
                    <span className="footnote">No upcoming events available.</span>
                  ) : null}
                  {countdownCandidates.map(([selectionId, event]) => (
                    <label className="toggle-row" key={selectionId}>
                      <span>
                        <strong>{event.title}</strong>
                        <small>{countdownDateLabel(event)}</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={(configuration.selectedItemIds ?? []).includes(selectionId)}
                        onChange={(changeEvent) =>
                          save(configuration.configurationId, (current) => ({
                            ...current,
                            selectedItemIds: changeEvent.currentTarget.checked
                              ? [...new Set([...(current.selectedItemIds ?? []), selectionId])]
                              : (current.selectedItemIds ?? []).filter((id) => id !== selectionId),
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            {configuration.kind === 'capture' ? (
              <div className="setting-row stacked">
                <div>
                  <strong>Capture actions</strong>
                  <span>Each tile opens the matching Collab flow.</span>
                </div>
                <div className="widget-calendar-options">
                  {CAPTURE_ACTIONS.map(([action, label]) => {
                    const actions = captureOptions(configuration).actions;
                    const checked = actions.includes(action);
                    return (
                      <label className="toggle-row" key={action}>
                        <span>
                          <strong>{label}</strong>
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          // The last remaining tile stays on: an empty capture
                          // widget would have nothing to tap.
                          disabled={checked && actions.length === 1}
                          onChange={(event) =>
                            save(configuration.configurationId, (current) => {
                              const options = captureOptions(current);
                              const next = event.currentTarget.checked
                                ? CAPTURE_ACTIONS.map(([value]) => value).filter(
                                    (value) => options.actions.includes(value) || value === action,
                                  )
                                : options.actions.filter((value) => value !== action);
                              return { ...current, capture: { ...options, actions: next } };
                            })
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {configuration.kind === 'shortcuts' ? (
              <>
                <div className="setting-row">
                  <div>
                    <strong>Fill with recent files</strong>
                    <span>Uses offline vault metadata only. Pins always come first.</span>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Fill with recent files"
                    checked={shortcutOptions(configuration).includeRecent}
                    onChange={(event) =>
                      save(configuration.configurationId, (current) => ({
                        ...current,
                        shortcuts: {
                          ...shortcutOptions(current),
                          includeRecent: event.currentTarget.checked,
                        },
                      }))
                    }
                  />
                </div>
                <div className="setting-row stacked">
                  <div>
                    <strong>Pinned files</strong>
                    <span>
                      {selectedVault
                        ? `Pin from ${selectedVault.vault.name}.`
                        : 'Open a vault in Files to pin from it.'}
                    </span>
                  </div>
                  <div className="widget-calendar-options">
                    {pinCandidates.map((entry) => {
                      const pinned = shortcutOptions(configuration).pinned;
                      const checked = pinned.some(
                        (pin) => pin.vaultId === selectedVault?.vault.id && pin.fileId === entry.id,
                      );
                      return (
                        <label className="toggle-row" key={entry.id}>
                          <span>
                            <strong>{entry.name}</strong>
                          </span>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(changeEvent) =>
                              save(configuration.configurationId, (current) => {
                                const options = shortcutOptions(current);
                                const vaultId = selectedVault!.vault.id;
                                const next = changeEvent.currentTarget.checked
                                  ? [...options.pinned, { vaultId, fileId: entry.id }].slice(0, 16)
                                  : options.pinned.filter(
                                      (pin) =>
                                        !(pin.vaultId === vaultId && pin.fileId === entry.id),
                                    );
                                return { ...current, shortcuts: { ...options, pinned: next } };
                              })
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}
            {configuration.kind === 'tasks' ? (
              <>
                <div className="setting-row stacked">
                  <div>
                    <strong>Task sources</strong>
                    <span>Kanban assignments come from your cached boards.</span>
                  </div>
                  <div className="widget-calendar-options">
                    {(
                      [
                        ['includeCalendarTasks', 'Calendar tasks'],
                        ['includeKanbanTasks', 'Kanban assignments'],
                        ['includeUndated', 'Tasks without a due date'],
                      ] as Array<[keyof WidgetTaskOptions, string]>
                    ).map(([key, label]) => (
                      <label className="toggle-row" key={key}>
                        <span>
                          <strong>{label}</strong>
                        </span>
                        <input
                          type="checkbox"
                          checked={taskOptions(configuration)[key] as boolean}
                          onChange={(event) =>
                            save(configuration.configurationId, (current) => ({
                              ...current,
                              tasks: {
                                ...taskOptions(current),
                                [key]: event.currentTarget.checked,
                              },
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                </div>
                {taskOptions(configuration).includeKanbanTasks && boardCandidates.length > 0 ? (
                  <div className="setting-row stacked">
                    <div>
                      <strong>Kanban boards</strong>
                      <span>All boards when none are selected.</span>
                    </div>
                    <div className="widget-calendar-options">
                      {boardCandidates.map(([fileId, label]) => {
                        const selected = taskOptions(configuration).selectedBoardIds;
                        return (
                          <label className="toggle-row" key={fileId}>
                            <span>
                              <strong>{label}</strong>
                            </span>
                            <input
                              type="checkbox"
                              checked={selected.length === 0 || selected.includes(fileId)}
                              onChange={(event) =>
                                save(configuration.configurationId, (current) => {
                                  const options = taskOptions(current);
                                  const baseline =
                                    options.selectedBoardIds.length === 0
                                      ? boardCandidates.map(([id]) => id)
                                      : options.selectedBoardIds;
                                  const selectedBoardIds = event.currentTarget.checked
                                    ? [...new Set([...baseline, fileId])]
                                    : baseline.filter((id) => id !== fileId);
                                  return { ...current, tasks: { ...options, selectedBoardIds } };
                                })
                              }
                            />
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="setting-row">
                  <div>
                    <strong>Complete from the widget</strong>
                    <span>
                      Adds a confirmed complete action for your own calendar tasks. Kanban tasks
                      always open Collab.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Complete from the widget"
                    checked={configuration.actions.toggleTask}
                    onChange={(event) =>
                      save(configuration.configurationId, (current) => ({
                        ...current,
                        actions: { ...current.actions, toggleTask: event.currentTarget.checked },
                      }))
                    }
                  />
                </div>
              </>
            ) : null}
            {configuration.kind === 'sync' ? (
              <div className="setting-row stacked">
                <div>
                  <strong>Accounts</strong>
                  <span>All accounts when none are selected. The widget shows counts only.</span>
                </div>
                <div className="widget-calendar-options">
                  {syncAccounts.length === 0 ? (
                    <span className="footnote">No accounts with offline data yet.</span>
                  ) : null}
                  {syncAccounts.map((account) => {
                    const allSelected = configuration.selectedSourceIds.length === 0;
                    const checked =
                      allSelected || configuration.selectedSourceIds.includes(account.accountId);
                    return (
                      <label className="toggle-row" key={account.accountId}>
                        <span>
                          <strong>{account.label}</strong>
                          <small>
                            {account.vaults === 1 ? '1 vault' : `${account.vaults} vaults`}
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            save(configuration.configurationId, (current) => {
                              const baseline =
                                current.selectedSourceIds.length === 0
                                  ? syncAccounts.map((entry) => entry.accountId)
                                  : current.selectedSourceIds;
                              const selectedSourceIds = event.currentTarget.checked
                                ? [...new Set([...baseline, account.accountId])]
                                : baseline.filter((id) => id !== account.accountId);
                              return { ...current, selectedSourceIds };
                            })
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {configuration.kind !== 'month' ? (
              <div className="setting-row stacked">
                <div>
                  <strong>Privacy</strong>
                  <span>Controls content persisted for the launcher.</span>
                </div>
                <div className="segmented-control">
                  {PRIVACY_OPTIONS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={configuration.privacy === value ? 'selected' : ''}
                      onClick={() =>
                        save(configuration.configurationId, (current) => ({
                          ...current,
                          privacy: value,
                        }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {configuration.kind === 'sync' ? null : (
              <div className="setting-row stacked">
                <div>
                  <strong>Calendars</strong>
                  <span>Select sources included by this widget.</span>
                </div>
                <div className="widget-calendar-options">
                  {calendars.map((calendar) => {
                    const allSelected = configuration.selectedSourceIds.length === 0;
                    const checked =
                      allSelected || configuration.selectedSourceIds.includes(calendar.id);
                    return (
                      <label className="toggle-row" key={calendar.id}>
                        <span>
                          <strong>{calendar.name}</strong>
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            const current =
                              configurationsRef.current.find(
                                (entry) => entry.configurationId === configuration.configurationId,
                              ) ?? configuration;
                            const currentAllSelected = current.selectedSourceIds.length === 0;
                            const baseline = currentAllSelected
                              ? calendars.map((entry) => entry.id)
                              : current.selectedSourceIds;
                            const selectedSourceIds = event.currentTarget.checked
                              ? [...new Set([...baseline, calendar.id])]
                              : baseline.filter((id) => id !== calendar.id);
                            save(configuration.configurationId, (entry) => ({
                              ...entry,
                              selectedSourceIds,
                            }));
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="setting-row stacked">
              <div>
                <strong>Maximum items</strong>
                <span>Launcher size may show fewer.</span>
              </div>
              <div className="segmented-control compact">
                {[3, 6, 10].map((maxItems) => (
                  <button
                    key={maxItems}
                    type="button"
                    className={configuration.display.maxItems === maxItems ? 'selected' : ''}
                    onClick={() =>
                      save(configuration.configurationId, (current) => ({
                        ...current,
                        display: { ...current.display, maxItems },
                      }))
                    }
                  >
                    {maxItems}
                  </button>
                ))}
              </div>
            </div>
            <p className="footnote widget-remove-guidance">
              To remove this widget, touch and hold it on the home screen, then choose Remove.
            </p>
          </div>
        );
      })}
      {error ? <p className="footnote error-text">{error}</p> : null}
    </section>
  );
}
