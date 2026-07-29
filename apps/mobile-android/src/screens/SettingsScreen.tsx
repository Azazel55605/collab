import {
  ArrowLeft,
  Bell,
  CalendarDays,
  ChevronRight,
  CircuitBoard,
  CloudCog,
  Code2,
  Palette,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Type,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import {
  ACCENTS,
  COLOR_PREVIEW_FORMAT_OPTIONS,
  TAB_WIDTH_OPTIONS,
  THEMES,
  type ColorPreviewFormat,
  type ThemePrefs,
} from '../lib/theme';
import { useMobileStore } from '../state/store';
import { alwaysCreateOfflineCopy, setAlwaysCreateOfflineCopy } from '../lib/preferences';
import { useEffect, useState } from 'react';
import { TimeField } from '../components/TimeField';
import {
  backgroundSettingsGet,
  backgroundSettingsSave,
  reconcileAndroidBackground,
  requestAndroidBackgroundSync,
  verifyAndroidBackgroundSync,
  type BackgroundSettings,
} from '../mobileTauri';
import { mobileCalendarProfileId } from '../lib/calendarSync';
import { NotificationSettingsSection } from '../components/NotificationSettingsSection';

const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  schemaVersion: 1,
  runInBackground: false,
  backgroundSync: true,
  syncInterval: 'system_managed',
  startAtLogin: false,
  closeBehavior: 'hide_to_tray',
  paused: false,
  onlyUnmeteredNetworks: false,
  requireCharging: false,
  pauseOnLowBattery: true,
  allowRoaming: true,
};

const FONT_SCALES: { value: number; label: string }[] = [
  { value: 0.9, label: 'S' },
  { value: 1, label: 'M' },
  { value: 1.12, label: 'L' },
  { value: 1.25, label: 'XL' },
];

type SettingsCategory =
  | 'general'
  | 'background'
  | 'notifications'
  | 'appearance'
  | 'editor'
  | 'calendar'
  | 'logic'
  | 'account';

const SETTINGS_CATEGORIES: Array<{
  id: SettingsCategory;
  label: string;
  description: string;
  keywords: string;
  Icon: LucideIcon;
}> = [
  {
    id: 'general',
    label: 'General',
    description: 'Hosted vault and offline-copy defaults',
    keywords: 'vault server offline storage download',
    Icon: SlidersHorizontal,
  },
  {
    id: 'background',
    label: 'Background',
    description: 'Sync schedule, network, and battery policy',
    keywords: 'sync schedule interval wifi metered roaming charging battery',
    Icon: CloudCog,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Permission, reminder timing, and notification inbox',
    keywords: 'notification alert reminder permission alarm inbox snooze',
    Icon: Bell,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, accent color, and interface size',
    keywords: 'theme color accent font text size display',
    Icon: Palette,
  },
  {
    id: 'editor',
    label: 'Editor',
    description: 'Indentation and inline color previews',
    keywords: 'note editor tab spaces swatch preview hex rgb hsl',
    Icon: Code2,
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'Dates, time, reminders, and working hours',
    keywords: 'date time week reminder duration timezone weekend',
    Icon: CalendarDays,
  },
  {
    id: 'logic',
    label: 'Logic & circuits',
    description: 'Schematic notation and symbols',
    keywords: 'logic circuit ansi iec din schematic',
    Icon: CircuitBoard,
  },
  {
    id: 'account',
    label: 'Account',
    description: 'Server connections and session information',
    keywords: 'account profile server login connection session',
    Icon: UserRound,
  },
];

export function SettingsScreen({
  prefs,
  onChange,
}: {
  prefs: ThemePrefs;
  onChange: (next: ThemePrefs) => void;
}) {
  const servers = useMobileStore((s) => s.servers);
  const statuses = useMobileStore((s) => s.statuses);
  const connectedCount = Object.values(statuses).filter((s) => s.connected).length;
  const [alwaysOffline, setAlwaysOffline] = useState(alwaysCreateOfflineCopy);
  const [background, setBackground] = useState(DEFAULT_BACKGROUND_SETTINGS);
  const [backgroundBusy, setBackgroundBusy] = useState(true);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null);
  const [settingsQuery, setSettingsQuery] = useState('');
  const backgroundJobs = useMobileStore((s) => s.backgroundJobs);
  const refreshBackgroundJobs = useMobileStore((s) => s.refreshBackgroundJobs);
  const colorFormats = Object.entries(COLOR_PREVIEW_FORMAT_OPTIONS) as [
    ColorPreviewFormat,
    typeof COLOR_PREVIEW_FORMAT_OPTIONS[ColorPreviewFormat],
  ][];
  const selectedCategory = SETTINGS_CATEGORIES.find((category) => category.id === activeCategory);
  const normalizedQuery = settingsQuery.trim().toLowerCase();
  const visibleCategories = normalizedQuery
    ? SETTINGS_CATEGORIES.filter((category) =>
        `${category.label} ${category.description} ${category.keywords}`.toLowerCase().includes(normalizedQuery),
      )
    : SETTINGS_CATEGORIES;

  const updateColorFormat = (format: ColorPreviewFormat, enabled: boolean) => {
    onChange({
      ...prefs,
      colorPreviewFormats: {
        ...prefs.colorPreviewFormats,
        [format]: enabled,
      },
    });
  };

  useEffect(() => {
    backgroundSettingsGet()
      .then(async (settings) => {
        setBackground(settings);
        await reconcileAndroidBackground(mobileCalendarProfileId());
        await refreshBackgroundJobs().catch(() => {});
      })
      .catch((error) => setBackgroundError(String(error)))
      .finally(() => setBackgroundBusy(false));
  }, [refreshBackgroundJobs]);

  useEffect(() => {
    const openCategory = (event: Event) => {
      const category = (event as CustomEvent<{ category?: SettingsCategory }>).detail?.category;
      if (category && SETTINGS_CATEGORIES.some((entry) => entry.id === category)) {
        setActiveCategory(category);
      }
    };
    window.addEventListener('collab-settings-open-category', openCategory);
    return () => window.removeEventListener('collab-settings-open-category', openCategory);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void refreshBackgroundJobs().catch(() => {});
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refreshBackgroundJobs]);

  const saveBackground = async (next: BackgroundSettings) => {
    const previous = background;
    setBackground(next);
    setBackgroundBusy(true);
    setBackgroundError(null);
    try {
      const saved = await backgroundSettingsSave(next);
      setBackground(saved);
      await reconcileAndroidBackground(mobileCalendarProfileId());
    } catch (error) {
      setBackground(previous);
      setBackgroundError(String(error));
    } finally {
      setBackgroundBusy(false);
    }
  };

  const syncInBackground = async () => {
    setBackgroundBusy(true);
    setBackgroundError(null);
    try {
      await requestAndroidBackgroundSync(mobileCalendarProfileId(), true);
      await refreshBackgroundJobs().catch(() => {});
    } catch (error) {
      setBackgroundError(String(error));
    } finally {
      setBackgroundBusy(false);
    }
  };

  const verifyBackground = async () => {
    setBackgroundBusy(true);
    setBackgroundError(null);
    try {
      await verifyAndroidBackgroundSync(mobileCalendarProfileId());
    } catch (error) {
      setBackgroundError(String(error));
    } finally {
      setBackgroundBusy(false);
    }
  };

  return (
    <div className="screen">
      <header className={`screen-header ${activeCategory ? 'settings-detail-header' : ''}`}>
        {activeCategory ? (
          <button
            type="button"
            className="icon-button settings-back-button"
            aria-label="Back to settings"
            onClick={() => setActiveCategory(null)}
          >
            <ArrowLeft size={20} aria-hidden />
          </button>
        ) : null}
        <div>
          <h1>{selectedCategory?.label ?? 'Settings'}</h1>
          <p>{selectedCategory?.description ?? 'Choose what you want to configure'}</p>
        </div>
      </header>

      {!activeCategory ? (
        <>
          <label className="settings-search">
            <Search size={17} aria-hidden />
            <input
              type="search"
              value={settingsQuery}
              placeholder="Search settings"
              aria-label="Search settings"
              onChange={(event) => setSettingsQuery(event.target.value)}
            />
          </label>
          <nav className="settings-category-list" aria-label="Settings categories">
            {visibleCategories.map(({ id, label, description, Icon }) => (
              <button
                key={id}
                type="button"
                className="settings-category-row"
                onClick={() => setActiveCategory(id)}
              >
                <span className="settings-category-icon"><Icon size={19} aria-hidden /></span>
                <span className="settings-category-copy">
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <ChevronRight size={18} aria-hidden />
              </button>
            ))}
            {visibleCategories.length === 0 ? (
              <div className="settings-search-empty">No settings match “{settingsQuery.trim()}”.</div>
            ) : null}
          </nav>
          <p className="app-version">Collab companion</p>
        </>
      ) : null}

      {activeCategory === 'general' ? (
      <section className="card">
        <div className="card-title">
          <Server size={18} aria-hidden />
          <span>Hosted vaults</span>
        </div>
        <label className="toggle-row">
          <span>
            <strong>Default to offline copies</strong>
            <small>Used by servers whose offline setting is set to Default.</small>
          </span>
          <input
            type="checkbox"
            checked={alwaysOffline}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setAlwaysOffline(enabled);
              setAlwaysCreateOfflineCopy(enabled);
            }}
          />
        </label>
      </section>
      ) : null}

      {activeCategory === 'background' ? (
      <section className="card">
        <div className="card-title">
          <CloudCog size={18} aria-hidden />
          <span>Background sync</span>
        </div>
        <label className="toggle-row">
          <span>
            <strong>Allow background work</strong>
            <small>Let Android keep offline vaults and hosted calendars current.</small>
          </span>
          <input
            type="checkbox"
            checked={background.runInBackground}
            disabled={backgroundBusy}
            onChange={(event) => void saveBackground({
              ...background,
              runInBackground: event.currentTarget.checked,
            })}
          />
        </label>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Sync while the app is closed</strong>
            <small>Android chooses the exact execution time based on device conditions.</small>
          </span>
          <input
            type="checkbox"
            checked={background.backgroundSync}
            disabled={!background.runInBackground || backgroundBusy}
            onChange={(event) => void saveBackground({
              ...background,
              backgroundSync: event.currentTarget.checked,
            })}
          />
        </label>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Only use unmetered networks</strong>
            <small>Wait for Wi-Fi or another unmetered connection before scheduled sync.</small>
          </span>
          <input
            type="checkbox"
            checked={background.onlyUnmeteredNetworks}
            disabled={!background.runInBackground || !background.backgroundSync || backgroundBusy}
            onChange={(event) => void saveBackground({
              ...background,
              onlyUnmeteredNetworks: event.currentTarget.checked,
            })}
          />
        </label>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Allow while roaming</strong>
            <small>When disabled, scheduled sync waits for a non-roaming network.</small>
          </span>
          <input
            type="checkbox"
            checked={background.allowRoaming}
            disabled={!background.runInBackground || !background.backgroundSync || backgroundBusy}
            onChange={(event) => void saveBackground({
              ...background,
              allowRoaming: event.currentTarget.checked,
            })}
          />
        </label>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Only while charging</strong>
            <small>Useful when offline vaults contain large files.</small>
          </span>
          <input
            type="checkbox"
            checked={background.requireCharging}
            disabled={!background.runInBackground || !background.backgroundSync || backgroundBusy}
            onChange={(event) => void saveBackground({
              ...background,
              requireCharging: event.currentTarget.checked,
            })}
          />
        </label>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Pause on low battery</strong>
            <small>Let Android defer scheduled work when battery capacity is low.</small>
          </span>
          <input
            type="checkbox"
            checked={background.pauseOnLowBattery}
            disabled={!background.runInBackground || !background.backgroundSync || backgroundBusy}
            onChange={(event) => void saveBackground({
              ...background,
              pauseOnLowBattery: event.currentTarget.checked,
            })}
          />
        </label>
        <div className="setting-row stacked">
          <div>
            <strong>Requested interval</strong>
            <span>Background execution can be deferred by Android.</span>
          </div>
          <div className="segmented-control calendar-duration-options">
            {([
              ['system_managed', 'System'],
              ['fifteen_minutes', '15m'],
              ['thirty_minutes', '30m'],
              ['hourly', '1h'],
              ['manual', 'Manual'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={background.syncInterval === value ? 'selected' : ''}
                disabled={!background.runInBackground || !background.backgroundSync || backgroundBusy}
                onClick={() => void saveBackground({ ...background, syncInterval: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Pause scheduled sync</strong>
            <small>Manual sync remains available.</small>
          </span>
          <input
            type="checkbox"
            checked={background.paused}
            disabled={!background.runInBackground || !background.backgroundSync || backgroundBusy}
            onChange={(event) => void saveBackground({
              ...background,
              paused: event.currentTarget.checked,
            })}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={backgroundBusy}
          onClick={() => void syncInBackground()}
        >
          <RefreshCw size={16} aria-hidden />
          Sync now
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={backgroundBusy}
          onClick={() => void verifyBackground()}
        >
          <Bell size={16} aria-hidden />
          Verify background sync
        </button>
        <p className="footnote">
          Schedules a real WorkManager run and posts a notification when it finishes.
        </p>
        {backgroundError ? <p className="footnote error-text">{backgroundError}</p> : null}
        {backgroundJobs.length > 0 ? (
          <div className="info-rows">
            {backgroundJobs.slice(0, 3).map((job) => (
              <div className="info-row" key={job.id}>
                <span>
                  {job.kind === 'calendar_sync'
                    ? 'Calendar'
                    : job.kind === 'replica_sync'
                      ? 'Vault'
                      : job.kind === 'notification_sync'
                        ? 'Notifications'
                        : 'Maintenance'}
                </span>
                <strong>
                  {job.status.replace(/_/g, ' ')}
                  {job.progress.total !== null
                    ? ` · ${Math.min(job.progress.completed, job.progress.total)}/${job.progress.total}`
                    : ''}
                </strong>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      ) : null}

      {activeCategory === 'notifications' ? <NotificationSettingsSection /> : null}

      {activeCategory === 'calendar' ? (
      <section className="card">
        <div className="card-title">
          <CalendarDays size={18} aria-hidden />
          <span>Calendar</span>
        </div>
        <div className="setting-row">
          <div><strong>Default time zone</strong><span>Read from this device.</span></div>
          <strong className="setting-value">{Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}</strong>
        </div>
        <div className="setting-row stacked">
          <div><strong>Date format</strong><span>Used for calendar dates across the app.</span></div>
          <div className="segmented-control calendar-date-options">
            {([
              ['MMM_D_YYYY', 'Jul 23, 2026'],
              ['D_MMM_YYYY', '23 Jul 2026'],
              ['YYYY_MM_DD', '2026-07-23'],
              ['MM_DD_YYYY', '07/23/2026'],
              ['DD_MM_YYYY', '23/07/2026'],
            ] as const).map(([value, label]) => <button key={value} type="button" className={prefs.calendarDateFormat === value ? 'selected' : ''} onClick={() => onChange({ ...prefs, calendarDateFormat: value })}>{label}</button>)}
          </div>
        </div>
        <div className="setting-row stacked">
          <div><strong>Time format</strong><span>Used by calendar labels and time controls.</span></div>
          <div className="segmented-control">
            {([['system', 'System'], ['12-hour', '12 hour'], ['24-hour', '24 hour']] as const).map(([value, label]) => <button key={value} type="button" className={prefs.calendarTimeFormat === value ? 'selected' : ''} onClick={() => onChange({ ...prefs, calendarTimeFormat: value })}>{label}</button>)}
          </div>
        </div>
        <div className="setting-row stacked">
          <div><strong>First day of week</strong><span>Controls the first Month column.</span></div>
          <div className="segmented-control">
            <button type="button" className={prefs.calendarWeekStart === 1 ? 'selected' : ''} onClick={() => onChange({ ...prefs, calendarWeekStart: 1 })}>Monday</button>
            <button type="button" className={prefs.calendarWeekStart === 0 ? 'selected' : ''} onClick={() => onChange({ ...prefs, calendarWeekStart: 0 })}>Sunday</button>
          </div>
        </div>
        <div className="setting-row stacked">
          <div><strong>Default duration</strong><span>Used when creating timed events and tasks.</span></div>
          <div className="segmented-control calendar-duration-options">
            {([15, 30, 45, 60, 90, 120] as const).map(minutes => <button key={minutes} type="button" className={prefs.calendarDefaultDurationMinutes === minutes ? 'selected' : ''} onClick={() => onChange({ ...prefs, calendarDefaultDurationMinutes: minutes })}>{minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}</button>)}
          </div>
        </div>
        <div className="setting-row stacked">
          <div><strong>Default reminder</strong><span>Applied to newly created calendar items.</span></div>
          <div className="segmented-control calendar-reminder-options">
            {([['none', 'None'], ['0', 'At start'], ['10', '10m'], ['30', '30m'], ['60', '1h'], ['1440', '1d']] as const).map(([value, label]) => {
              const selected = value === 'none' ? prefs.calendarDefaultReminderMinutes === null : prefs.calendarDefaultReminderMinutes === Number(value);
              return <button key={value} type="button" className={selected ? 'selected' : ''} onClick={() => onChange({ ...prefs, calendarDefaultReminderMinutes: value === 'none' ? null : Number(value) })}>{label}</button>;
            })}
          </div>
        </div>
        <div className="setting-row stacked">
          <div><strong>Working hours</strong><span>Used when timed schedule views open.</span></div>
          <div className="calendar-working-hours">
            <div><span>Start</span><TimeField label="Working hours start" format={prefs.calendarTimeFormat} value={prefs.calendarWorkingHoursStart} onChange={calendarWorkingHoursStart => onChange({ ...prefs, calendarWorkingHoursStart })} /></div>
            <div><span>End</span><TimeField label="Working hours end" format={prefs.calendarTimeFormat} value={prefs.calendarWorkingHoursEnd} onChange={calendarWorkingHoursEnd => onChange({ ...prefs, calendarWorkingHoursEnd })} /></div>
          </div>
        </div>
        <label className="toggle-row">
          <span><strong>Hide weekends</strong><small>Show a five-day Month layout.</small></span>
          <input type="checkbox" checked={prefs.calendarHideWeekends} onChange={event => onChange({ ...prefs, calendarHideWeekends: event.currentTarget.checked })} />
        </label>
        <label className="toggle-row">
          <span><strong>Show declined items</strong><small>Keep declined invitations visible.</small></span>
          <input type="checkbox" checked={prefs.calendarShowDeclined} onChange={event => onChange({ ...prefs, calendarShowDeclined: event.currentTarget.checked })} />
        </label>
      </section>
      ) : null}

      {activeCategory === 'appearance' ? (
      <>
      <section className="card">
        <div className="card-title">
          <Palette size={18} aria-hidden />
          <span>Theme</span>
        </div>
        <div className="option-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`option-chip ${prefs.theme === theme.id ? 'selected' : ''}`}
              onClick={() => onChange({ ...prefs, theme: theme.id })}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          <span className="accent-dot" style={{ background: `oklch(${ACCENTS.find((a) => a.id === prefs.accent)?.oklch})` }} />
          <span>Accent color</span>
        </div>
        <div className="accent-grid">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              aria-label={accent.label}
              className={`accent-swatch ${prefs.accent === accent.id ? 'selected' : ''}`}
              style={{ background: `oklch(${accent.oklch})` }}
              onClick={() => onChange({ ...prefs, accent: accent.id })}
            />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          <Type size={18} aria-hidden />
          <span>Text size</span>
        </div>
        <div className="option-grid">
          {FONT_SCALES.map((scale) => (
            <button
              key={scale.value}
              type="button"
              className={`option-chip ${Math.abs(prefs.fontScale - scale.value) < 0.01 ? 'selected' : ''}`}
              onClick={() => onChange({ ...prefs, fontScale: scale.value })}
            >
              {scale.label}
            </button>
          ))}
        </div>
      </section>
      </>
      ) : null}

      {activeCategory === 'editor' ? (
      <>
      <section className="card">
        <div className="card-title">
          <Code2 size={18} aria-hidden />
          <span>Editor</span>
        </div>
        <div className="setting-row">
          <div>
            <strong>Indent with</strong>
            <span>Controls what the note editor inserts when pressing Tab.</span>
          </div>
          <div className="segmented-control">
            {(['spaces', 'tabs'] as const).map((style) => (
              <button
                key={style}
                type="button"
                className={prefs.indentStyle === style ? 'selected' : ''}
                onClick={() => onChange({ ...prefs, indentStyle: style })}
              >
                {style === 'spaces' ? 'Spaces' : 'Tabs'}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Tab width</strong>
            <span>Matches the desktop tab stop options.</span>
          </div>
          <div className="segmented-control compact">
            {TAB_WIDTH_OPTIONS.map((width) => (
              <button
                key={width}
                type="button"
                className={prefs.tabWidth === width ? 'selected' : ''}
                onClick={() => onChange({ ...prefs, tabWidth: width })}
              >
                {width}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          <span className="accent-dot" style={{ background: 'linear-gradient(135deg, #fb7185, #facc15, #34d399)' }} />
          <span>Color previews</span>
        </div>
        <label className="toggle-row">
          <span>
            <strong>Enable color previews</strong>
            <small>Preview recognized color strings in note preview.</small>
          </span>
          <input
            type="checkbox"
            checked={prefs.showInlineColorPreviews}
            onChange={(event) => onChange({ ...prefs, showInlineColorPreviews: event.currentTarget.checked })}
          />
        </label>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Show swatches</strong>
            <small>Render a small color block before each match.</small>
          </span>
          <input
            type="checkbox"
            disabled={!prefs.showInlineColorPreviews}
            checked={prefs.colorPreviewShowSwatch}
            onChange={(event) => onChange({ ...prefs, colorPreviewShowSwatch: event.currentTarget.checked })}
          />
        </label>
        <label className="toggle-row disabled-when-off">
          <span>
            <strong>Tint matching text</strong>
            <small>Add a soft color background behind each match.</small>
          </span>
          <input
            type="checkbox"
            disabled={!prefs.showInlineColorPreviews}
            checked={prefs.colorPreviewTintText}
            onChange={(event) => onChange({ ...prefs, colorPreviewTintText: event.currentTarget.checked })}
          />
        </label>
        <div className="format-grid">
          {colorFormats.map(([format, meta]) => (
            <button
              key={format}
              type="button"
              disabled={!prefs.showInlineColorPreviews}
              className={prefs.colorPreviewFormats[format] ? 'selected' : ''}
              onClick={() => updateColorFormat(format, !prefs.colorPreviewFormats[format])}
            >
              <strong>{meta.label}</strong>
              <span>{meta.description}</span>
            </button>
          ))}
        </div>
      </section>
      </>
      ) : null}

      {activeCategory === 'logic' ? (
      <section className="card">
        <div className="card-title">
          <CircuitBoard size={18} aria-hidden />
          <span>Logic & circuits</span>
        </div>
        <div className="setting-row">
          <div>
            <strong>Schematic symbols</strong>
            <span>Choose American or German/international electrical notation.</span>
          </div>
          <div className="segmented-control">
            <button
              type="button"
              className={prefs.schematicSymbolSet === 'ansi' ? 'selected' : ''}
              onClick={() => onChange({ ...prefs, schematicSymbolSet: 'ansi' })}
            >
              ANSI
            </button>
            <button
              type="button"
              className={prefs.schematicSymbolSet === 'iec' ? 'selected' : ''}
              onClick={() => onChange({ ...prefs, schematicSymbolSet: 'iec' })}
            >
              IEC / DIN
            </button>
          </div>
        </div>
      </section>
      ) : null}

      {activeCategory === 'account' ? (
      <section className="card">
        <div className="card-title">
          <Server size={18} aria-hidden />
          <span>Account</span>
        </div>
        <div className="info-rows">
          <div className="info-row">
            <span>Connected servers</span>
            <strong>{connectedCount}</strong>
          </div>
          <div className="info-row">
            <span>Saved servers</span>
            <strong>{servers.length}</strong>
          </div>
        </div>
        <p className="footnote">
          Manage sign-in and reconnect on the Servers tab. Session tokens stay in native
          storage and never enter the web view.
        </p>
      </section>
      ) : null}
    </div>
  );
}
