import { Check, Moon, Sun, Sunset } from 'lucide-react';

import {
  ACCENT_COLORS,
  INTERFACE_FONTS,
  INTERFACE_FONT_SIZE_OPTIONS,
  type AccentColor,
  type InterfaceFont,
  type Theme,
} from '../../store/uiStore';
import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { OptionRow, PillSelect, SectionLabel } from './settingsControls';

const THEMES: Array<{ id: Theme; label: string; icon: React.ReactNode; desc: string }> = [
  { id: 'dark', label: 'Dark', icon: <Moon size={16} />, desc: 'Deep dark with blue tint' },
  { id: 'midnight', label: 'Midnight', icon: <Moon size={16} />, desc: 'Pure black, high contrast' },
  { id: 'warm', label: 'Warm', icon: <Sunset size={16} />, desc: 'Amber-tinted dark' },
  { id: 'light', label: 'Light', icon: <Sun size={16} />, desc: 'Light mode' },
];

type Props = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accentColor: AccentColor;
  setAccentColor: (accentColor: AccentColor) => void;
  interfaceFont: InterfaceFont;
  setInterfaceFont: (font: InterfaceFont) => void;
  interfaceFontSize: number;
  setInterfaceFontSize: (fontSize: typeof INTERFACE_FONT_SIZE_OPTIONS[number]) => void;
};

export default function SettingsAppearanceSection({
  theme,
  setTheme,
  accentColor,
  setAccentColor,
  interfaceFont,
  setInterfaceFont,
  interfaceFontSize,
  setInterfaceFontSize,
}: Props) {
  return (
    <div>
      <SectionLabel>Base Theme</SectionLabel>
      <div className="grid grid-cols-2 gap-2 mb-5">
        {THEMES.map((themeOption) => (
          <button
            key={themeOption.id}
            onClick={() => setTheme(themeOption.id)}
            className={cn(
              'relative flex items-start gap-3 p-3 rounded-lg border text-left transition-all',
              theme === themeOption.id
                ? 'border-primary/50 bg-primary/8'
                : 'border-border/40 hover:border-border hover:bg-accent/30',
            )}
          >
            <span className={cn('mt-0.5', theme === themeOption.id ? 'text-primary' : 'text-muted-foreground')}>
              {themeOption.icon}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{themeOption.label}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{themeOption.desc}</p>
            </div>
            {theme === themeOption.id && (
              <Check size={13} className="absolute top-2.5 right-2.5 text-primary" />
            )}
          </button>
        ))}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Accent Color</SectionLabel>
      <div className="flex gap-2.5 flex-wrap">
        {(Object.entries(ACCENT_COLORS) as [AccentColor, typeof ACCENT_COLORS[AccentColor]][]).map(
          ([key, value]) => (
            <button
              key={key}
              onClick={() => setAccentColor(key)}
              title={value.label}
              aria-label={`Accent ${value.label}`}
              className={cn(
                'group relative w-8 h-8 rounded-full border-2 transition-all',
                accentColor === key
                  ? 'border-white/60 scale-110'
                  : 'border-transparent hover:border-white/30 hover:scale-105',
              )}
              style={{ backgroundColor: value.hex }}
            >
              {accentColor === key && (
                <Check size={12} className="absolute inset-0 m-auto text-white drop-shadow" strokeWidth={3} />
              )}
            </button>
          ),
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div
          className="w-4 h-4 rounded-full border border-border/50"
          style={{ backgroundColor: ACCENT_COLORS[accentColor].hex }}
        />
        <span className="text-xs text-muted-foreground">{ACCENT_COLORS[accentColor].label}</span>
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Interface Font Family</SectionLabel>
      <div className="space-y-1.5 mb-5">
        {(Object.entries(INTERFACE_FONTS) as [InterfaceFont, typeof INTERFACE_FONTS[InterfaceFont]][]).map(
          ([key, value]) => (
            <button
              key={key}
              onClick={() => setInterfaceFont(key)}
              className={cn(
                'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                interfaceFont === key
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-border/40 hover:border-border hover:bg-accent/30',
              )}
            >
              <div>
                <p className="text-sm font-medium">{value.label}</p>
                <p className="text-[12px] text-muted-foreground mt-0.5" style={{ fontFamily: value.css }}>
                  The quick brown fox jumps over the lazy dog
                </p>
              </div>
              {interfaceFont === key && <Check size={14} className="text-primary shrink-0 ml-2" />}
            </button>
          ),
        )}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Interface Font Size</SectionLabel>
      <OptionRow label="Interface font size" description="Changes the interface text size without affecting note editors">
        <PillSelect
          options={INTERFACE_FONT_SIZE_OPTIONS}
          value={interfaceFontSize as typeof INTERFACE_FONT_SIZE_OPTIONS[number]}
          onChange={setInterfaceFontSize}
          getLabel={(value) => `${value}px`}
        />
      </OptionRow>

      <div
        className="mt-3 p-3 rounded-lg bg-accent/20 border border-border/30 text-muted-foreground"
        style={{ fontSize: `${interfaceFontSize}px`, fontFamily: INTERFACE_FONTS[interfaceFont]?.css ?? INTERFACE_FONTS.geist.css }}
      >
        Preview: Interface typography now changes independently from the editor.
      </div>
    </div>
  );
}
