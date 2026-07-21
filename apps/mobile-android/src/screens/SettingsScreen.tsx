import { CircuitBoard, Code2, Palette, Server, Type } from 'lucide-react';

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
import { useState } from 'react';

const FONT_SCALES: { value: number; label: string }[] = [
  { value: 0.9, label: 'S' },
  { value: 1, label: 'M' },
  { value: 1.12, label: 'L' },
  { value: 1.25, label: 'XL' },
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
  const colorFormats = Object.entries(COLOR_PREVIEW_FORMAT_OPTIONS) as [
    ColorPreviewFormat,
    typeof COLOR_PREVIEW_FORMAT_OPTIONS[ColorPreviewFormat],
  ][];

  const updateColorFormat = (format: ColorPreviewFormat, enabled: boolean) => {
    onChange({
      ...prefs,
      colorPreviewFormats: {
        ...prefs.colorPreviewFormats,
        [format]: enabled,
      },
    });
  };

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <h1>Settings</h1>
          <p>Appearance & account</p>
        </div>
      </header>

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

      <p className="app-version">Collab companion · Phase 2</p>
    </div>
  );
}
