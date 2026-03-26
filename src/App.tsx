import { useEffect } from 'react';
import './App.css';
import { TooltipProvider } from './components/ui/tooltip';
import { useVaultStore } from './store/vaultStore';
import { useUiStore, ACCENT_COLORS, EDITOR_FONTS } from './store/uiStore';
import VaultPicker from './components/vault/VaultPicker';
import AppShell from './components/layout/AppShell';
import SettingsModal from './components/settings/SettingsModal';
import { Toaster } from './components/ui/sonner';

/** Theme-base CSS overrides applied on top of the default dark palette */
const THEME_VARS: Record<string, Record<string, string>> = {
  dark: {
    '--background':       'oklch(0.10 0.01 264)',
    '--foreground':       'oklch(0.92 0.01 264)',
    '--card':             'oklch(0.13 0.01 264)',
    '--card-foreground':  'oklch(0.92 0.01 264)',
    '--popover':          'oklch(0.12 0.015 264)',
    '--muted':            'oklch(0.17 0.01 264)',
    '--muted-foreground': 'oklch(0.60 0.02 264)',
    '--accent':           'oklch(0.20 0.02 264)',
    '--accent-foreground':'oklch(0.92 0.01 264)',
    '--border':           'oklch(1 0 0 / 9%)',
    '--input':            'oklch(1 0 0 / 11%)',
    '--sidebar':          'oklch(0.11 0.015 264)',
    '--glass-bg':         'rgba(17, 18, 30, 0.80)',
    '--glass-bg-strong':  'rgba(13, 14, 22, 0.92)',
  },
  midnight: {
    '--background':       'oklch(0.07 0.00 0)',
    '--foreground':       'oklch(0.90 0.00 0)',
    '--card':             'oklch(0.10 0.00 0)',
    '--card-foreground':  'oklch(0.90 0.00 0)',
    '--popover':          'oklch(0.09 0.005 264)',
    '--muted':            'oklch(0.14 0.00 0)',
    '--muted-foreground': 'oklch(0.55 0.01 264)',
    '--accent':           'oklch(0.16 0.01 264)',
    '--accent-foreground':'oklch(0.90 0.00 0)',
    '--border':           'oklch(1 0 0 / 8%)',
    '--input':            'oklch(1 0 0 / 10%)',
    '--sidebar':          'oklch(0.08 0.00 0)',
    '--glass-bg':         'rgba(10, 10, 14, 0.85)',
    '--glass-bg-strong':  'rgba(7, 7, 10, 0.94)',
  },
  warm: {
    '--background':       'oklch(0.11 0.02 60)',
    '--foreground':       'oklch(0.92 0.02 60)',
    '--card':             'oklch(0.14 0.02 60)',
    '--card-foreground':  'oklch(0.92 0.02 60)',
    '--popover':          'oklch(0.13 0.02 60)',
    '--muted':            'oklch(0.18 0.02 60)',
    '--muted-foreground': 'oklch(0.60 0.03 60)',
    '--accent':           'oklch(0.20 0.03 60)',
    '--accent-foreground':'oklch(0.92 0.02 60)',
    '--border':           'oklch(1 0 0 / 9%)',
    '--input':            'oklch(1 0 0 / 12%)',
    '--sidebar':          'oklch(0.12 0.025 60)',
    '--glass-bg':         'rgba(25, 18, 12, 0.82)',
    '--glass-bg-strong':  'rgba(18, 13, 8, 0.93)',
  },
  light: {
    '--background':       'oklch(0.97 0 0)',
    '--foreground':       'oklch(0.14 0 0)',
    '--card':             'oklch(1 0 0)',
    '--card-foreground':  'oklch(0.14 0 0)',
    '--popover':          'oklch(1 0 0)',
    '--muted':            'oklch(0.94 0 0)',
    '--muted-foreground': 'oklch(0.45 0.01 264)',
    '--accent':           'oklch(0.93 0.01 264)',
    '--accent-foreground':'oklch(0.14 0 0)',
    '--border':           'oklch(0 0 0 / 10%)',
    '--input':            'oklch(0 0 0 / 10%)',
    '--sidebar':          'oklch(0.94 0 0)',
    '--glass-bg':         'rgba(255, 255, 255, 0.75)',
    '--glass-bg-strong':  'rgba(250, 250, 252, 0.92)',
  },
};

export default function App() {
  const { vault } = useVaultStore();
  const { theme, accentColor, editorFont, fontSize, scale, isSettingsOpen } = useUiStore();

  // Apply theme class + CSS variables whenever settings change
  useEffect(() => {
    const root = document.documentElement;
    const isLight = theme === 'light';

    // Dark/light class
    root.classList.toggle('dark', !isLight);

    // Theme base vars
    const vars = THEME_VARS[theme] ?? THEME_VARS.dark;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }

    // Accent color (primary)
    const accent = ACCENT_COLORS[accentColor];
    root.style.setProperty('--primary', `oklch(${accent.oklch})`);
    root.style.setProperty('--primary-foreground', isLight ? 'oklch(1 0 0)' : 'oklch(0.10 0 0)');
    root.style.setProperty('--ring', `oklch(${accent.oklch})`);
    root.style.setProperty('--glow-primary',    `oklch(${accent.oklch} / 30%)`);
    root.style.setProperty('--glow-primary-sm', `oklch(${accent.oklch} / 15%)`);

    // Font
    const font = EDITOR_FONTS[editorFont];
    root.style.setProperty('--font-sans', font.css);
    root.style.setProperty('--font-mono', font.css);

    // Font size
    root.style.setProperty('--base-font-size', `${fontSize}px`);
    root.style.fontSize = `${fontSize}px`;

    // Zoom / display scale
    (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = `${scale}%`;
  }, [theme, accentColor, editorFont, fontSize, scale]);

  return (
    <TooltipProvider delayDuration={300}>
      {vault ? <AppShell /> : <VaultPicker />}
      {isSettingsOpen && <SettingsModal />}
      <Toaster richColors position="bottom-right" />
    </TooltipProvider>
  );
}
