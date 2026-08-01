import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutDashboard, RefreshCw } from 'lucide-react';

import type { CalendarDefinition } from '../../../../src/types/calendar';
import type { WidgetConfiguration, WidgetDiagnostics, WidgetPrivacy } from '../../../../src/types/widget';
import { mobileCalendarProfileId } from '../lib/calendarSync';
import {
  listProfileCalendars,
  widgetActiveProfileSet,
  widgetDiagnosticsList,
  widgetConfigurationList,
  widgetConfigurationSave,
  widgetRefresh,
} from '../mobileTauri';

const PRIVACY_OPTIONS: Array<[WidgetPrivacy, string]> = [
  ['full', 'Full details'],
  ['titleOnly', 'Titles only'],
  ['private', 'Private'],
];

export function WidgetSettingsSection() {
  const profileId = mobileCalendarProfileId();
  const [configurations, setConfigurations] = useState<WidgetConfiguration[]>([]);
  const [calendars, setCalendars] = useState<CalendarDefinition[]>([]);
  const [diagnostics, setDiagnostics] = useState<WidgetDiagnostics[]>([]);
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

  const applyConfigurations = (next: WidgetConfiguration[]) => {
    configurationsRef.current = next;
    setConfigurations(next);
  };

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    Promise.all([
      widgetActiveProfileSet(profileId),
      widgetConfigurationList(profileId),
      listProfileCalendars(profileId),
      widgetDiagnosticsList(profileId),
    ])
      .then(([, nextConfigurations, nextCalendars, nextDiagnostics]) => {
        if (cancelled) return;
        applyConfigurations(nextConfigurations);
        setCalendars(nextCalendars.filter((calendar) => !calendar.deletedAt && !calendar.archived));
        setDiagnostics(nextDiagnostics);
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
    const previous = configurationsRef.current.find((entry) =>
      entry.configurationId === configurationId);
    if (!previous) return;
    const next = { ...update(previous), updatedAt: new Date().toISOString() };
    applyConfigurations(configurationsRef.current.map((entry) =>
      entry.configurationId === configurationId ? next : entry));
    setError(null);
    const version = (saveVersionsRef.current.get(configurationId) ?? 0) + 1;
    saveVersionsRef.current.set(configurationId, version);
    const priorQueue = saveQueuesRef.current.get(configurationId) ?? Promise.resolve();
    const queued = priorQueue.catch(() => {}).then(async () => {
      try {
        const saved = await widgetConfigurationSave(profileId, next);
        if (saveVersionsRef.current.get(configurationId) !== version) return;
        applyConfigurations(configurationsRef.current.map((entry) =>
          entry.configurationId === saved.configurationId ? saved : entry));
        setDiagnostics(await widgetDiagnosticsList(profileId));
      } catch (reason) {
        if (saveVersionsRef.current.get(configurationId) === version) {
          applyConfigurations(configurationsRef.current.map((entry) =>
            entry.configurationId === configurationId ? previous : entry));
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
          Add the Collab Agenda widget from your Android launcher. Its configuration will appear here.
        </p>
      ) : null}
      {configurations.map((configuration, index) => {
        const status = diagnosticsById.get(configuration.configurationId);
        return (
        <div className="widget-settings-entry" key={configuration.configurationId}>
          <div className="setting-row">
            <div>
              <strong>Agenda {index + 1}</strong>
              <span>{configuration.selectedSourceIds.length === 0 ? 'All calendars' : `${configuration.selectedSourceIds.length} calendars`}</span>
            </div>
            <span className="widget-live-label">Changes apply live</span>
          </div>
          <div className="widget-diagnostics" aria-label={`Agenda ${index + 1} status`}>
            <span>{status?.lastSuccessAt
              ? `Updated ${new Date(status.lastSuccessAt).toLocaleString()}`
              : 'Waiting for first update'}</span>
            {status ? (
              <span>
                {status.itemCount} items · {Math.ceil(status.serializedBytes / 1024)} KB · {status.generationDurationMs} ms
                {status.truncated ? ' · limited' : ''}
              </span>
            ) : null}
            {status?.lastError ? <span className="error-text">{status.lastError}</span> : null}
            {status && (status.staleSources > 0 || status.unavailableSources > 0) ? (
              <span>{status.staleSources} stale · {status.unavailableSources} unavailable sources</span>
            ) : null}
          </div>
          <div className="setting-row stacked">
            <div><strong>Privacy</strong><span>Controls content persisted for the launcher.</span></div>
            <div className="segmented-control">
              {PRIVACY_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={configuration.privacy === value ? 'selected' : ''}
                  onClick={() => save(configuration.configurationId, (current) => ({
                    ...current,
                    privacy: value,
                  }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row stacked">
            <div><strong>Calendars</strong><span>Select sources included by this widget.</span></div>
            <div className="widget-calendar-options">
              {calendars.map((calendar) => {
                const allSelected = configuration.selectedSourceIds.length === 0;
                const checked = allSelected || configuration.selectedSourceIds.includes(calendar.id);
                return (
                  <label className="toggle-row" key={calendar.id}>
                    <span><strong>{calendar.name}</strong></span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        const current = configurationsRef.current.find((entry) =>
                          entry.configurationId === configuration.configurationId) ?? configuration;
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
          <div className="setting-row stacked">
            <div><strong>Maximum items</strong><span>Launcher size may show fewer.</span></div>
            <div className="segmented-control compact">
              {[3, 6, 10].map((maxItems) => (
                <button
                  key={maxItems}
                  type="button"
                  className={configuration.display.maxItems === maxItems ? 'selected' : ''}
                  onClick={() => save(configuration.configurationId, (current) => ({
                    ...current,
                    display: { ...current.display, maxItems },
                  }))}
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
