import { useState, useEffect } from 'react';
import { getAppVersion } from '../../lib/tauri';
import {
  useUiStore,
  ACCENT_COLORS, INTERFACE_FONTS, EDITOR_FONTS, INTERFACE_FONT_SIZE_OPTIONS, EDITOR_FONT_SIZE_OPTIONS, SCALE_OPTIONS, DATE_FORMAT_OPTIONS, formatDate, TAB_WIDTH_OPTIONS,
  COLOR_PREVIEW_FORMAT_OPTIONS,
  ANIMATION_SPEED_OPTIONS,
  type Theme, type AccentColor, type InterfaceFont, type EditorFont, type DateFormat, type WeekStart, type AnimationSpeed, type IndentStyle, type ColorPreviewFormat, type CanvasWebCardDefaultMode,
} from '../../store/uiStore';
import { useCollabStore } from '../../store/collabStore';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import { Palette, Type, User, Sun, Moon, Sunset, Check, Monitor, Info, CalendarDays, Keyboard, Sparkles, Search, ChevronDown, SlidersHorizontal, Layout } from 'lucide-react';
import { toast } from 'sonner';
import AboutTab from './AboutTab';
import ShortcutsTab from './ShortcutsTab';
import { useUpdateStore } from '../../store/updateStore';

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
  { id: 'general',    label: 'General',    icon: <SlidersHorizontal size={15} />, keywords: ['startup', 'session', 'files', 'delete', 'behavior'] },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} />, keywords: ['theme', 'accent', 'color', 'look'] },
  { id: 'editor',     label: 'Editor',     icon: <Type size={15} />, keywords: ['font', 'typing', 'notes', 'indent', 'color preview'] },
  { id: 'display',    label: 'Display',    icon: <Monitor size={15} />, keywords: ['scale', 'motion', 'animation', 'ui'] },
  { id: 'canvas',     label: 'Canvas',     icon: <Layout size={15} />, keywords: ['canvas', 'web card', 'embed', 'preview', 'links'] },
  { id: 'calendar',   label: 'Calendar',   icon: <CalendarDays size={15} />, keywords: ['date', 'week', 'format'] },
  { id: 'profile',    label: 'Profile',    icon: <User size={15} />, keywords: ['name', 'identity', 'presence', 'user'] },
  { id: 'shortcuts',  label: 'Shortcuts',  icon: <Keyboard size={15} />, keywords: ['keyboard', 'hotkeys', 'bindings'] },
  { id: 'about',      label: 'About',      icon: <Info size={15} />, keywords: ['version', 'update', 'app'] },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ─── Main Modal ───────────────────────────────────────────────────────────────

export default function SettingsModal() {
  const {
    closeSettings,
    theme, setTheme,
    accentColor, setAccentColor,
    interfaceFont, setInterfaceFont,
    interfaceFontSize, setInterfaceFontSize,
    editorFont, setEditorFont,
    editorFontSize, setEditorFontSize,
    indentStyle, setIndentStyle,
    tabWidth, setTabWidth,
    showIndentMarkers, setShowIndentMarkers,
    showColoredIndents, setShowColoredIndents,
    showInlineColorPreviews, setShowInlineColorPreviews,
    colorPreviewShowSwatch, setColorPreviewShowSwatch,
    colorPreviewTintText, setColorPreviewTintText,
    colorPreviewFormats, setColorPreviewFormatEnabled,
    restorePreviousSession, setRestorePreviousSession,
    scale, setScale,
    dateFormat, setDateFormat,
    weekStart, setWeekStart,
    confirmDelete, setConfirmDelete,
    animationsEnabled, setAnimationsEnabled,
    animationSpeed, setAnimationSpeed,
    canvasWebCardDefaultMode, setCanvasWebCardDefaultMode,
    canvasWebCardAutoLoad, setCanvasWebCardAutoLoad,
    webPreviewsEnabled, setWebPreviewsEnabled,
    hoverWebLinkPreviewsEnabled, setHoverWebLinkPreviewsEnabled,
    backgroundWebPreviewPrefetchEnabled, setBackgroundWebPreviewPrefetchEnabled,
  } = useUiStore();

  const { myUserName, myUserColor, myUserId, setMyProfile } = useCollabStore();
  const { status: updateStatus } = useUpdateStore();
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [showColorPreviewFormats, setShowColorPreviewFormats] = useState(false);
  const [name, setName] = useState(myUserName);
  const [appVersion, setAppVersion] = useState<string>('…');
  useEffect(() => { getAppVersion().then(setAppVersion).catch(() => setAppVersion('?')); }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      const requestedTab = (event as CustomEvent<{ tab?: TabId }>).detail?.tab;
      if (!requestedTab || !TABS.some((tab) => tab.id === requestedTab)) return;
      setActiveTab(requestedTab);
    };

    window.addEventListener('settings:open-tab', handler);
    return () => window.removeEventListener('settings:open-tab', handler);
  }, []);

  const normalizedSettingsQuery = settingsQuery.trim().toLowerCase();
  const filteredTabs = normalizedSettingsQuery
    ? TABS.filter((tab) => {
        const haystack = [tab.label, ...tab.keywords].join(' ').toLowerCase();
        return haystack.includes(normalizedSettingsQuery);
      })
    : TABS;

  useEffect(() => {
    if (!filteredTabs.some((tab) => tab.id === activeTab) && filteredTabs.length > 0) {
      setActiveTab(filteredTabs[0].id);
    }
  }, [activeTab, filteredTabs]);

  const THEMES: { id: Theme; label: string; icon: React.ReactNode; desc: string }[] = [
    { id: 'dark',     label: 'Dark',     icon: <Moon   size={16} />, desc: 'Deep dark with blue tint' },
    { id: 'midnight', label: 'Midnight', icon: <Moon   size={16} />, desc: 'Pure black, high contrast' },
    { id: 'warm',     label: 'Warm',     icon: <Sunset size={16} />, desc: 'Amber-tinted dark' },
    { id: 'light',    label: 'Light',    icon: <Sun    size={16} />, desc: 'Light mode' },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent className="sm:max-w-3xl w-full p-0 overflow-hidden glass-strong border-border/40 shadow-2xl shadow-black/60 gap-0 app-fade-scale-in">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-base font-semibold">Settings</DialogTitle>
        </DialogHeader>

        <div className="flex h-[520px]">
          {/* Sidebar nav */}
          <nav className="w-48 shrink-0 border-r border-border/40 p-2 flex flex-col gap-0.5">
            <div className="relative mb-2">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
              <Input
                value={settingsQuery}
                onChange={(event) => setSettingsQuery(event.target.value)}
                placeholder="Search settings..."
                className="h-9 border-border/40 bg-background/50 pl-8 text-sm"
              />
            </div>

            {filteredTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'relative flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all text-left app-motion-base',
                  activeTab === tab.id
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
              >
                {tab.icon}
                {tab.label}
                {tab.id === 'about' && updateStatus === 'available' && (
                  <span className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-orange-400" />
                )}
              </button>
            ))}

            {filteredTabs.length === 0 && (
              <div className="rounded-md border border-dashed border-border/50 px-3 py-4 text-xs text-muted-foreground">
                No settings matched "{settingsQuery}".
              </div>
            )}
          </nav>

          {/* Content */}
          <div key={activeTab} className="flex-1 overflow-y-auto p-5 space-y-1 app-fade-slide-in">

            {/* ── General ── */}
            {activeTab === 'general' && (
              <div>
                <SectionLabel>Startup</SectionLabel>
                <OptionRow
                  label="Restore previous session"
                  description="Reopen the last vault and previously open files when launching the app"
                >
                  <button
                    onClick={() => setRestorePreviousSession(!restorePreviousSession)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                      restorePreviousSession ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={restorePreviousSession}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                        restorePreviousSession ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Web Previews</SectionLabel>
                <OptionRow
                  label="Enable web previews"
                  description="Master switch for loading website previews anywhere in the app, including canvas web cards"
                >
                  <button
                    onClick={() => setWebPreviewsEnabled(!webPreviewsEnabled)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 app-motion-base',
                      webPreviewsEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={webPreviewsEnabled}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 app-motion-base',
                        webPreviewsEnabled ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <OptionRow
                  label="Hover previews for links"
                  description="Show a small website preview below external links when hovering over them"
                >
                  <button
                    onClick={() => setHoverWebLinkPreviewsEnabled(!hoverWebLinkPreviewsEnabled)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 app-motion-base',
                      hoverWebLinkPreviewsEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={hoverWebLinkPreviewsEnabled}
                    disabled={!webPreviewsEnabled}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 app-motion-base',
                        hoverWebLinkPreviewsEnabled ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <OptionRow
                  label="Background prefetch for open documents"
                  description="Warm website previews in the background for visible or open documents instead of the whole vault"
                >
                  <button
                    onClick={() => setBackgroundWebPreviewPrefetchEnabled(!backgroundWebPreviewPrefetchEnabled)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 app-motion-base',
                      backgroundWebPreviewPrefetchEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={backgroundWebPreviewPrefetchEnabled}
                    disabled={!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 app-motion-base',
                        backgroundWebPreviewPrefetchEnabled ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

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

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Interface Font Family</SectionLabel>
                <div className="space-y-1.5 mb-5">
                  {(Object.entries(INTERFACE_FONTS) as [InterfaceFont, typeof INTERFACE_FONTS[InterfaceFont]][]).map(
                    ([key, val]) => (
                      <button
                        key={key}
                        onClick={() => setInterfaceFont(key)}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                          interfaceFont === key
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
                        {interfaceFont === key && <Check size={14} className="text-primary shrink-0 ml-2" />}
                      </button>
                    )
                  )}
                </div>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Interface Font Size</SectionLabel>
                <OptionRow label="Interface font size" description="Changes the interface text size without affecting note editors">
                  <PillSelect
                    options={INTERFACE_FONT_SIZE_OPTIONS}
                    value={interfaceFontSize as typeof INTERFACE_FONT_SIZE_OPTIONS[number]}
                    onChange={setInterfaceFontSize}
                    getLabel={(v) => `${v}px`}
                  />
                </OptionRow>

                <div
                  className="mt-3 p-3 rounded-lg bg-accent/20 border border-border/30 text-muted-foreground"
                  style={{ fontSize: `${interfaceFontSize}px`, fontFamily: INTERFACE_FONTS[interfaceFont]?.css ?? INTERFACE_FONTS.geist.css }}
                >
                  Preview: Interface typography now changes independently from the editor.
                </div>
              </div>
            )}

            {/* ── Editor ── */}
            {activeTab === 'editor' && (
              <div>
                <SectionLabel>Editor Font Family</SectionLabel>
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

                <SectionLabel>Editor Font Size</SectionLabel>
                <OptionRow label="Editor font size" description="Changes note and code editors without affecting the interface">
                  <PillSelect
                    options={EDITOR_FONT_SIZE_OPTIONS}
                    value={editorFontSize as typeof EDITOR_FONT_SIZE_OPTIONS[number]}
                    onChange={setEditorFontSize}
                    getLabel={(v) => `${v}px`}
                  />
                </OptionRow>

                <div
                  className="mt-3 p-3 rounded-lg bg-accent/20 border border-border/30 text-muted-foreground"
                  style={{ fontSize: `${editorFontSize}px`, fontFamily: EDITOR_FONTS[editorFont]?.css ?? EDITOR_FONTS.codingMono.css }}
                >
                  Preview: const arrow = () =&gt; value; // editor-only typography
                </div>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Indentation</SectionLabel>
                <OptionRow
                  label="Indent with"
                  description="Choose whether pressing Tab inserts spaces or tab characters"
                >
                  <PillSelect
                    options={['spaces', 'tabs'] as const}
                    value={indentStyle}
                    onChange={setIndentStyle}
                    getLabel={(value: IndentStyle) => value === 'spaces' ? 'Spaces' : 'Tabs'}
                  />
                </OptionRow>

                <OptionRow
                  label="Tab width"
                  description="Controls tab stop width and the number of spaces inserted when using spaces"
                >
                  <PillSelect
                    options={TAB_WIDTH_OPTIONS}
                    value={tabWidth as typeof TAB_WIDTH_OPTIONS[number]}
                    onChange={setTabWidth}
                    getLabel={(value) => `${value}`}
                  />
                </OptionRow>

                <OptionRow
                  label="Show indent markers"
                  description="Display spaces as dots and tabs as arrows in leading indentation"
                >
                  <button
                    onClick={() => setShowIndentMarkers(!showIndentMarkers)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                      showIndentMarkers ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={showIndentMarkers}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                        showIndentMarkers ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <OptionRow
                  label="Show colored indents"
                  description="Display leading indentation with colored guide bands"
                >
                  <button
                    onClick={() => setShowColoredIndents(!showColoredIndents)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                      showColoredIndents ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={showColoredIndents}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                        showColoredIndents ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Inline Color Previews</SectionLabel>
                <OptionRow
                  label="Enable inline color previews"
                  description="Preview recognized color strings directly in note text"
                >
                  <button
                    onClick={() => setShowInlineColorPreviews(!showInlineColorPreviews)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                      showInlineColorPreviews ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={showInlineColorPreviews}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                        showInlineColorPreviews ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <OptionRow
                  label="Show swatches"
                  description="Render a small color block before each recognized color string"
                >
                  <button
                    onClick={() => setColorPreviewShowSwatch(!colorPreviewShowSwatch)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                      colorPreviewShowSwatch ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={colorPreviewShowSwatch}
                    disabled={!showInlineColorPreviews}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                        colorPreviewShowSwatch ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <OptionRow
                  label="Tint matching text"
                  description="Add a soft color background behind recognized color strings"
                >
                  <button
                    onClick={() => setColorPreviewTintText(!colorPreviewTintText)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                      colorPreviewTintText ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={colorPreviewTintText}
                    disabled={!showInlineColorPreviews}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                        colorPreviewTintText ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setShowColorPreviewFormats((value) => !value)}
                    disabled={!showInlineColorPreviews}
                    className={cn(
                      'w-full flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-all',
                      'border-border/40 hover:border-border hover:bg-accent/30',
                      !showInlineColorPreviews && 'opacity-50'
                    )}
                  >
                    <div>
                      <p className="text-sm font-medium">Matching formats</p>
                      <p className="text-[12px] text-muted-foreground mt-0.5">
                        Choose which kinds of color strings should trigger previews
                      </p>
                    </div>
                    <ChevronDown
                      size={16}
                      className={cn(
                        'shrink-0 text-muted-foreground transition-transform duration-200',
                        showColorPreviewFormats && 'rotate-180'
                      )}
                    />
                  </button>

                  {showColorPreviewFormats && (
                    <div className="mt-2 space-y-1.5">
                      {(Object.entries(COLOR_PREVIEW_FORMAT_OPTIONS) as [ColorPreviewFormat, typeof COLOR_PREVIEW_FORMAT_OPTIONS[ColorPreviewFormat]][]).map(([format, meta]) => (
                        <button
                          key={format}
                          onClick={() => setColorPreviewFormatEnabled(format, !colorPreviewFormats[format])}
                          disabled={!showInlineColorPreviews}
                          className={cn(
                            'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                            colorPreviewFormats[format]
                              ? 'border-primary/50 bg-primary/8'
                              : 'border-border/40 hover:border-border hover:bg-accent/30',
                            !showInlineColorPreviews && 'opacity-50'
                          )}
                        >
                          <div>
                            <p className="text-sm font-medium">{meta.label}</p>
                            <p className="text-[12px] text-muted-foreground mt-0.5">{meta.description}</p>
                          </div>
                          {colorPreviewFormats[format] && <Check size={14} className="text-primary shrink-0 ml-2" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

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

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Motion</SectionLabel>
                <OptionRow
                  label="Disable animations"
                  description="Turns off transitions, entry effects, and repeated motion across the app"
                >
                  <button
                    onClick={() => setAnimationsEnabled(!animationsEnabled)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 app-motion-base',
                      !animationsEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={!animationsEnabled}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 app-motion-base',
                        !animationsEnabled ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <OptionRow
                  label="Animation speed"
                  description="Controls how quickly interface motion runs when animations are enabled"
                >
                  <div className={cn(!animationsEnabled && 'pointer-events-none opacity-45')}>
                    <PillSelect
                      options={ANIMATION_SPEED_OPTIONS}
                      value={animationSpeed}
                      onChange={setAnimationSpeed}
                      getLabel={(value: AnimationSpeed) => value.charAt(0).toUpperCase() + value.slice(1)}
                    />
                  </div>
                </OptionRow>

                <div className="mt-3 rounded-lg border border-border/40 bg-accent/10 p-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2 text-foreground">
                    <Sparkles size={13} className="text-primary" />
                    Motion respects your system reduced-motion preference automatically.
                  </div>
                </div>
              </div>
            )}

            {/* ── Canvas ── */}
            {activeTab === 'canvas' && (
              <div>
                <SectionLabel>Web Cards</SectionLabel>
                <OptionRow
                  label="Default web card mode"
                  description="Choose whether new canvas web cards start in preview or embed mode"
                >
                  <PillSelect
                    options={['preview', 'embed'] as const}
                    value={canvasWebCardDefaultMode}
                    onChange={(value) => setCanvasWebCardDefaultMode(value as CanvasWebCardDefaultMode)}
                    getLabel={(value: CanvasWebCardDefaultMode) => value === 'preview' ? 'Preview' : 'Embed'}
                  />
                </OptionRow>

                <Separator className="bg-border/40 my-4" />

                <OptionRow
                  label="Disable web preview auto-load"
                  description="Require a manual click before canvas web cards fetch preview metadata"
                >
                  <button
                    onClick={() => setCanvasWebCardAutoLoad(!canvasWebCardAutoLoad)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 app-motion-base',
                      !canvasWebCardAutoLoad ? 'bg-primary' : 'bg-muted-foreground/30'
                    )}
                    role="switch"
                    aria-checked={!canvasWebCardAutoLoad}
                    disabled={!webPreviewsEnabled}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 app-motion-base',
                        !canvasWebCardAutoLoad ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </OptionRow>

                <div className="mt-3 rounded-lg border border-border/40 bg-accent/10 p-3 text-xs text-muted-foreground">
                  {!webPreviewsEnabled
                    ? <>Web previews are currently disabled globally, so canvas web cards and link hover previews will not fetch metadata.</>
                    : <>When auto-load is off, web cards show a manual <span className="text-foreground font-medium">Load preview</span> action instead of fetching immediately.</>}
                </div>
              </div>
            )}

            {/* ── Calendar ── */}
            {activeTab === 'calendar' && (
              <div>
                <SectionLabel>Date Format</SectionLabel>
                <p className="text-xs text-muted-foreground mb-3">
                  How dates are displayed across the app.
                </p>
                <div className="space-y-1.5 mb-5">
                  {(Object.entries(DATE_FORMAT_OPTIONS) as [DateFormat, typeof DATE_FORMAT_OPTIONS[DateFormat]][]).map(
                    ([key, val]) => (
                      <button
                        key={key}
                        onClick={() => setDateFormat(key)}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                          dateFormat === key
                            ? 'border-primary/50 bg-primary/8'
                            : 'border-border/40 hover:border-border hover:bg-accent/30'
                        )}
                      >
                        <div>
                          <p className="text-sm font-medium font-mono">{val.label}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{val.description}</p>
                        </div>
                        {dateFormat === key && <Check size={14} className="text-primary shrink-0 ml-2" />}
                      </button>
                    )
                  )}
                </div>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>First Day of Week</SectionLabel>
                <p className="text-xs text-muted-foreground mb-3">
                  Sets the starting column in the calendar view.
                </p>
                <div className="flex gap-2">
                  {([1, 0] as WeekStart[]).map(day => (
                    <button
                      key={day}
                      onClick={() => setWeekStart(day)}
                      className={cn(
                        'flex-1 py-2.5 rounded-lg border text-sm font-medium transition-all',
                        weekStart === day
                          ? 'border-primary/50 bg-primary/8 text-primary'
                          : 'border-border/40 hover:border-border hover:bg-accent/30 text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {day === 1 ? 'Monday' : 'Sunday'}
                    </button>
                  ))}
                </div>

                <Separator className="bg-border/40 my-4" />

                <SectionLabel>Preview</SectionLabel>
                <div className="rounded-lg border border-border/40 bg-accent/10 p-3 text-sm text-muted-foreground">
                  <p>Today: <span className="text-foreground font-medium">{formatDate(new Date(), dateFormat)}</span></p>
                  <p className="mt-1.5">Week starts on: <span className="text-foreground font-medium">{weekStart === 1 ? 'Monday' : 'Sunday'}</span></p>
                </div>
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

            {/* ── About ── */}
            {activeTab === 'about' && <AboutTab />}

            {/* ── Shortcuts ── */}
            {activeTab === 'shortcuts' && <ShortcutsTab />}

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
