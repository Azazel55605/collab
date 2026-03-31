import { useState, useEffect } from 'react';
import { getAppVersion } from '../../lib/tauri';
import {
  useUiStore,
  ACCENT_COLORS, EDITOR_FONTS, FONT_SIZE_OPTIONS, SCALE_OPTIONS,
  type Theme, type AccentColor, type EditorFont,
} from '../../store/uiStore';
import { useCollabStore } from '../../store/collabStore';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import {
  Palette, Type, User, Sun, Moon, Sunset, Check, Monitor,
} from 'lucide-react';
import { toast } from 'sonner';

// ─── Section helpers ─────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">
      {children}
    </p>
  );
}

function OptionRow({ label, description, children }: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ─── Pill selector ────────────────────────────────────────────────────────────

function PillSelect<T extends string | number>({
  options, value, onChange, getLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  getLabel?: (v: T) => string;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={cn(
            'px-2.5 py-1 rounded-md text-[12px] font-medium border transition-all',
            value === opt
              ? 'bg-primary/15 border-primary/40 text-primary'
              : 'bg-transparent border-border/50 text-muted-foreground hover:text-foreground hover:border-border',
          )}
        >
          {getLabel ? getLabel(opt) : opt}
        </button>
      ))}
    </div>
  );
}

// ─── Tabs sidebar ─────────────────────────────────────────────────────────────

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: <Palette  size={15} /> },
  { id: 'editor',     label: 'Editor',     icon: <Type     size={15} /> },
  { id: 'display',    label: 'Display',    icon: <Monitor  size={15} /> },
  { id: 'profile',    label: 'Profile',    icon: <User     size={15} /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ─── Main Modal ───────────────────────────────────────────────────────────────

export default function SettingsModal() {
  const {
    closeSettings,
    theme, setTheme,
    accentColor, setAccentColor,
    editorFont, setEditorFont,
    fontSize, setFontSize,
    scale, setScale,
    confirmDelete, setConfirmDelete,
  } = useUiStore();

  const { myUserName, myUserColor, myUserId, setMyProfile } = useCollabStore();
  const [activeTab, setActiveTab] = useState<TabId>('appearance');
  const [name, setName] = useState(myUserName);
  const [appVersion, setAppVersion] = useState<string>('…');
  useEffect(() => { getAppVersion().then(setAppVersion).catch(() => setAppVersion('?')); }, []);

  const THEMES: { id: Theme; label: string; icon: React.ReactNode; desc: string }[] = [
    { id: 'dark',     label: 'Dark',     icon: <Moon   size={16} />, desc: 'Deep dark with blue tint' },
    { id: 'midnight', label: 'Midnight', icon: <Moon   size={16} />, desc: 'Pure black, high contrast' },
    { id: 'warm',     label: 'Warm',     icon: <Sunset size={16} />, desc: 'Amber-tinted dark' },
    { id: 'light',    label: 'Light',    icon: <Sun    size={16} />, desc: 'Light mode' },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent className="sm:max-w-3xl w-full p-0 overflow-hidden glass-strong border-border/40 shadow-2xl shadow-black/60 gap-0">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-base font-semibold">Settings</DialogTitle>
        </DialogHeader>

        <div className="flex h-[520px]">
          {/* Sidebar nav */}
          <nav className="w-48 shrink-0 border-r border-border/40 p-2 flex flex-col gap-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all text-left',
                  activeTab === tab.id
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-1">

            {/* ── Appearance ── */}
            {activeTab === 'appearance' && (
              <div>
                <SectionLabel>Base Theme</SectionLabel>
                <div className="grid grid-cols-2 gap-2 mb-5">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      className={cn(
                        'relative flex items-start gap-3 p-3 rounded-lg border text-left transition-all',
                        theme === t.id
                          ? 'border-primary/50 bg-primary/8'
                          : 'border-border/40 hover:border-border hover:bg-accent/30'
                      )}
                    >
                      <span className={cn('mt-0.5', theme === t.id ? 'text-primary' : 'text-muted-foreground')}>
                        {t.icon}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t.label}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{t.desc}</p>
                      </div>
                      {theme === t.id && (
                        <Check size={13} className="absolute top-2.5 right-2.5 text-primary" />
                      )}
                    </button>
                  ))}
                </div>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Accent Color</SectionLabel>
                <div className="flex gap-2.5 flex-wrap">
                  {(Object.entries(ACCENT_COLORS) as [AccentColor, typeof ACCENT_COLORS[AccentColor]][]).map(
                    ([key, val]) => (
                      <button
                        key={key}
                        onClick={() => setAccentColor(key)}
                        title={val.label}
                        className={cn(
                          'group relative w-8 h-8 rounded-full border-2 transition-all',
                          accentColor === key
                            ? 'border-white/60 scale-110'
                            : 'border-transparent hover:border-white/30 hover:scale-105'
                        )}
                        style={{ backgroundColor: val.hex }}
                      >
                        {accentColor === key && (
                          <Check
                            size={12}
                            className="absolute inset-0 m-auto text-white drop-shadow"
                            strokeWidth={3}
                          />
                        )}
                      </button>
                    )
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div
                    className="w-4 h-4 rounded-full border border-border/50"
                    style={{ backgroundColor: ACCENT_COLORS[accentColor].hex }}
                  />
                  <span className="text-xs text-muted-foreground">{ACCENT_COLORS[accentColor].label}</span>
                </div>
              </div>
            )}

            {/* ── Editor ── */}
            {activeTab === 'editor' && (
              <div>
                <SectionLabel>Font Family</SectionLabel>
                <div className="space-y-1.5 mb-5">
                  {(Object.entries(EDITOR_FONTS) as [EditorFont, typeof EDITOR_FONTS[EditorFont]][]).map(
                    ([key, val]) => (
                      <button
                        key={key}
                        onClick={() => setEditorFont(key)}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                          editorFont === key
                            ? 'border-primary/50 bg-primary/8'
                            : 'border-border/40 hover:border-border hover:bg-accent/30'
                        )}
                      >
                        <div>
                          <p className="text-sm font-medium">{val.label}</p>
                          <p className="text-[12px] text-muted-foreground mt-0.5" style={{ fontFamily: val.css }}>
                            The quick brown fox jumps over the lazy dog
                          </p>
                        </div>
                        {editorFont === key && <Check size={14} className="text-primary shrink-0 ml-2" />}
                      </button>
                    )
                  )}
                </div>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Font Size</SectionLabel>
                <OptionRow label="Base font size" description="Affects the editor and all UI text">
                  <PillSelect
                    options={FONT_SIZE_OPTIONS}
                    value={fontSize as typeof FONT_SIZE_OPTIONS[number]}
                    onChange={setFontSize}
                    getLabel={(v) => `${v}px`}
                  />
                </OptionRow>

                <div
                  className="mt-3 p-3 rounded-lg bg-accent/20 border border-border/30 text-muted-foreground"
                  style={{ fontSize: `${fontSize}px` }}
                >
                  Preview: The quick brown fox jumps over the lazy dog. 1234567890.
                </div>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>File Operations</SectionLabel>
                <OptionRow
                  label="Confirm before deleting"
                  description="Show a confirmation dialog before permanently deleting notes or folders"
                >
                  <button
                    onClick={() => setConfirmDelete(!confirmDelete)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                      confirmDelete ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={confirmDelete}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                        confirmDelete ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>
              </div>
            )}

            {/* ── Display ── */}
            {activeTab === 'display' && (
              <div>
                <SectionLabel>Interface Scale</SectionLabel>
                <OptionRow
                  label="UI scale"
                  description="Zoom the entire interface for HiDPI displays"
                >
                  <PillSelect
                    options={SCALE_OPTIONS}
                    value={scale as typeof SCALE_OPTIONS[number]}
                    onChange={setScale}
                    getLabel={(v) => `${v}%`}
                  />
                </OptionRow>
                <p className="text-[11px] text-muted-foreground mt-2">
                  100% is native pixel density. Increase for HiDPI / high-resolution displays.
                </p>
              </div>
            )}

            {/* ── Profile ── */}
            {activeTab === 'profile' && (
              <div>
                <SectionLabel>Your Identity</SectionLabel>
                <p className="text-xs text-muted-foreground mb-4">
                  Shown to collaborators when editing a shared vault.
                </p>

                <div className="space-y-4">
                  <OptionRow label="Display name" description="Visible to other users in real time">
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-44 h-8 text-sm bg-input/50"
                      placeholder="Your name"
                    />
                  </OptionRow>

                  <Separator className="bg-border/40" />

                  <OptionRow label="Presence color" description="Your avatar color in the status bar">
                    <div
                      className="w-7 h-7 rounded-full border-2 border-border/60"
                      style={{ backgroundColor: myUserColor }}
                    />
                  </OptionRow>

                  <Separator className="bg-border/40" />

                  <div>
                    <p className="text-sm font-medium mb-1">User ID</p>
                    <p className="text-[11px] text-muted-foreground font-mono bg-muted/40 px-2 py-1.5 rounded-md border border-border/30 break-all">
                      {myUserId}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    onClick={() => {
                      setMyProfile(myUserId, name, myUserColor);
                      toast.success('Profile saved');
                    }}
                    className="mt-2"
                  >
                    Save Profile
                  </Button>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border/40 bg-muted/10">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px] font-mono">collab v{appVersion}</Badge>
          </div>
          <Button size="sm" variant="outline" onClick={closeSettings} className="h-7 text-xs">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
