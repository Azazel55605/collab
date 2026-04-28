import { useState, useEffect } from 'react';
import { getAppVersion } from '../../lib/tauri';
import {
  useUiStore,
} from '../../store/uiStore';
import { useCollabStore } from '../../store/collabStore';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import { Palette, Type, User, Monitor, Info, CalendarDays, Keyboard, Search, SlidersHorizontal, Layout } from 'lucide-react';
import { toast } from 'sonner';
import AboutTab from './AboutTab';
import ShortcutsTab from './ShortcutsTab';
import SettingsAppearanceSection from './SettingsAppearanceSection';
import SettingsCalendarSection from './SettingsCalendarSection';
import SettingsCanvasSection from './SettingsCanvasSection';
import SettingsDisplaySection from './SettingsDisplaySection';
import SettingsGeneralSection from './SettingsGeneralSection';
import SettingsProfileSection from './SettingsProfileSection';
import SettingsEditorSection from './SettingsEditorSection';
import { useUpdateStore } from '../../store/updateStore';

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
    spellcheckEnabled, setSpellcheckEnabled,
    spellcheckLanguage, setSpellcheckLanguage,
    respectNoteSpellcheckLanguage, setRespectNoteSpellcheckLanguage,
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
              <SettingsGeneralSection
                restorePreviousSession={restorePreviousSession}
                setRestorePreviousSession={setRestorePreviousSession}
                webPreviewsEnabled={webPreviewsEnabled}
                setWebPreviewsEnabled={setWebPreviewsEnabled}
                hoverWebLinkPreviewsEnabled={hoverWebLinkPreviewsEnabled}
                setHoverWebLinkPreviewsEnabled={setHoverWebLinkPreviewsEnabled}
                backgroundWebPreviewPrefetchEnabled={backgroundWebPreviewPrefetchEnabled}
                setBackgroundWebPreviewPrefetchEnabled={setBackgroundWebPreviewPrefetchEnabled}
                confirmDelete={confirmDelete}
                setConfirmDelete={setConfirmDelete}
              />
            )}

            {/* ── Appearance ── */}
            {activeTab === 'appearance' && (
              <SettingsAppearanceSection
                theme={theme}
                setTheme={setTheme}
                accentColor={accentColor}
                setAccentColor={setAccentColor}
                interfaceFont={interfaceFont}
                setInterfaceFont={setInterfaceFont}
                interfaceFontSize={interfaceFontSize}
                setInterfaceFontSize={setInterfaceFontSize}
              />
            )}

            {/* ── Editor ── */}
            {activeTab === 'editor' && (
              <SettingsEditorSection
                editorFont={editorFont}
                setEditorFont={setEditorFont}
                editorFontSize={editorFontSize}
                setEditorFontSize={setEditorFontSize}
                indentStyle={indentStyle}
                setIndentStyle={setIndentStyle}
                tabWidth={tabWidth}
                setTabWidth={setTabWidth}
                showIndentMarkers={showIndentMarkers}
                setShowIndentMarkers={setShowIndentMarkers}
                showColoredIndents={showColoredIndents}
                setShowColoredIndents={setShowColoredIndents}
                showInlineColorPreviews={showInlineColorPreviews}
                setShowInlineColorPreviews={setShowInlineColorPreviews}
                colorPreviewShowSwatch={colorPreviewShowSwatch}
                setColorPreviewShowSwatch={setColorPreviewShowSwatch}
                colorPreviewTintText={colorPreviewTintText}
                setColorPreviewTintText={setColorPreviewTintText}
                colorPreviewFormats={colorPreviewFormats}
                setColorPreviewFormatEnabled={setColorPreviewFormatEnabled}
                showColorPreviewFormats={showColorPreviewFormats}
                setShowColorPreviewFormats={setShowColorPreviewFormats}
                spellcheckEnabled={spellcheckEnabled}
                setSpellcheckEnabled={setSpellcheckEnabled}
                spellcheckLanguage={spellcheckLanguage}
                setSpellcheckLanguage={setSpellcheckLanguage}
                respectNoteSpellcheckLanguage={respectNoteSpellcheckLanguage}
                setRespectNoteSpellcheckLanguage={setRespectNoteSpellcheckLanguage}
              />
            )}

            {/* ── Display ── */}
            {activeTab === 'display' && (
              <SettingsDisplaySection
                scale={scale}
                setScale={setScale}
                animationsEnabled={animationsEnabled}
                setAnimationsEnabled={setAnimationsEnabled}
                animationSpeed={animationSpeed}
                setAnimationSpeed={setAnimationSpeed}
              />
            )}

            {/* ── Canvas ── */}
            {activeTab === 'canvas' && (
              <SettingsCanvasSection
                canvasWebCardDefaultMode={canvasWebCardDefaultMode}
                setCanvasWebCardDefaultMode={setCanvasWebCardDefaultMode}
                canvasWebCardAutoLoad={canvasWebCardAutoLoad}
                setCanvasWebCardAutoLoad={setCanvasWebCardAutoLoad}
                webPreviewsEnabled={webPreviewsEnabled}
              />
            )}

            {/* ── Calendar ── */}
            {activeTab === 'calendar' && (
              <SettingsCalendarSection
                dateFormat={dateFormat}
                setDateFormat={setDateFormat}
                weekStart={weekStart}
                setWeekStart={setWeekStart}
              />
            )}

            {/* ── Profile ── */}
            {activeTab === 'profile' && (
              <SettingsProfileSection
                name={name}
                setName={setName}
                myUserColor={myUserColor}
                myUserId={myUserId}
                onSave={() => {
                  setMyProfile(myUserId, name, myUserColor);
                  toast.success('Profile saved');
                }}
              />
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
