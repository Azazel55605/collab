import { useEffect, useState } from 'react';
import { LayoutDashboard, Trash2 } from 'lucide-react';

import type { CalendarDefinition } from '../../../../src/types/calendar';
import type { WidgetConfiguration, WidgetPrivacy } from '../../../../src/types/widget';
import { mobileCalendarProfileId } from '../lib/calendarSync';
import {
  listProfileCalendars,
  widgetActiveProfileSet,
  widgetConfigurationDelete,
  widgetConfigurationList,
  widgetConfigurationSave,
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
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    Promise.all([
      widgetActiveProfileSet(profileId),
      widgetConfigurationList(profileId),
      listProfileCalendars(profileId),
    ])
      .then(([, nextConfigurations, nextCalendars]) => {
        if (cancelled) return;
        setConfigurations(nextConfigurations);
        setCalendars(nextCalendars.filter((calendar) => !calendar.deletedAt && !calendar.archived));
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

  const save = async (configuration: WidgetConfiguration) => {
    const previous = configurations;
    const next = { ...configuration, updatedAt: new Date().toISOString() };
    setConfigurations((current) => current.map((entry) =>
      entry.configurationId === next.configurationId ? next : entry));
    setError(null);
    try {
      const saved = await widgetConfigurationSave(profileId, next);
      setConfigurations((current) => current.map((entry) =>
        entry.configurationId === saved.configurationId ? saved : entry));
    } catch (reason) {
      setConfigurations(previous);
      setError(String(reason));
    }
  };

  const remove = async (configurationId: string) => {
    const previous = configurations;
    setConfigurations((current) => current.filter((entry) => entry.configurationId !== configurationId));
    setError(null);
    try {
      await widgetConfigurationDelete(profileId, configurationId);
    } catch (reason) {
      setConfigurations(previous);
      setError(String(reason));
    }
  };

  return (
    <section className="card">
      <div className="card-title">
        <LayoutDashboard size={18} aria-hidden />
        <span>Mobile widgets</span>
      </div>
      {busy ? <p className="footnote">Loading widget configurations…</p> : null}
      {!busy && configurations.length === 0 ? (
        <p className="footnote">
          Add the Collab Agenda widget from your Android launcher. Its configuration will appear here.
        </p>
      ) : null}
      {configurations.map((configuration, index) => (
        <div className="widget-settings-entry" key={configuration.configurationId}>
          <div className="setting-row">
            <div>
              <strong>Agenda {index + 1}</strong>
              <span>{configuration.selectedSourceIds.length === 0 ? 'All calendars' : `${configuration.selectedSourceIds.length} calendars`}</span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={`Delete Agenda ${index + 1} configuration`}
              onClick={() => void remove(configuration.configurationId)}
            >
              <Trash2 size={17} aria-hidden />
            </button>
          </div>
          <div className="setting-row stacked">
            <div><strong>Privacy</strong><span>Controls content persisted for the launcher.</span></div>
            <div className="segmented-control">
              {PRIVACY_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={configuration.privacy === value ? 'selected' : ''}
                  onClick={() => void save({ ...configuration, privacy: value })}
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
                        const baseline = allSelected ? calendars.map((entry) => entry.id) : configuration.selectedSourceIds;
                        const selectedSourceIds = event.currentTarget.checked
                          ? [...new Set([...baseline, calendar.id])]
                          : baseline.filter((id) => id !== calendar.id);
                        void save({ ...configuration, selectedSourceIds });
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
                  onClick={() => void save({
                    ...configuration,
                    display: { ...configuration.display, maxItems },
                  })}
                >
                  {maxItems}
                </button>
              ))}
            </div>
          </div>
        </div>
      ))}
      {error ? <p className="footnote error-text">{error}</p> : null}
    </section>
  );
}
