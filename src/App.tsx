import { useEffect } from 'react';
import './App.css';
import { TooltipProvider } from './components/ui/tooltip';
import { useVaultStore } from './store/vaultStore';
import { useUiStore, ACCENT_COLORS, EDITOR_FONTS } from './store/uiStore';
import VaultPicker from './components/vault/VaultPicker';
import AppShell from './components/layout/AppShell';
import SettingsModal from './components/settings/SettingsModal';
import VaultManagerModal from './components/vault/VaultManagerModal';
import VaultUnlockModal from './components/vault/VaultUnlockModal';
import { Toaster } from './components/ui/sonner';
import { tauriCommands } from './lib/tauri';
import { useUpdateStore } from './store/updateStore';
import { toast } from 'sonner';

/** Theme-base CSS overrides applied on top of the default dark palette */
const THEME_VARS: Record<string, Record<string, string>> = {
  dark: {
    '--background':       'oklch(0.17 0.015 264)',
    '--foreground':       'oklch(0.93 0.01 264)',
    '--card':             'oklch(0.20 0.015 264)',
    '--card-foreground':  'oklch(0.93 0.01 264)',
    '--popover':          'oklch(0.19 0.018 264)',
    '--muted':            'oklch(0.23 0.015 264)',
    '--muted-foreground': 'oklch(0.62 0.02 264)',
    '--accent':           'oklch(0.26 0.02 264)',
    '--accent-foreground':'oklch(0.93 0.01 264)',
    '--border':           'oklch(1 0 0 / 11%)',
    '--input':            'oklch(1 0 0 / 13%)',
    '--sidebar':          'oklch(0.15 0.018 264)',
    '--glass-bg':         'rgba(30, 32, 52, 0.80)',
    '--glass-bg-strong':  'rgba(24, 26, 42, 0.93)',
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
  const { vault, isVaultLocked } = useVaultStore();
  const { theme, accentColor, editorFont, fontSize, scale, isSettingsOpen, isVaultManagerOpen } = useUiStore();
  const { checkForUpdate } = useUpdateStore();

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
    // Editor selection colours — referenced by CodeMirror theme via var().
    // Computed here alongside --primary so they always track the accent colour
    // without requiring color-mix() or relative-color CSS syntax in the theme.
    root.style.setProperty('--editor-selection',     `oklch(${accent.oklch} / 0.35)`);
    root.style.setProperty('--editor-selection-dim', `oklch(${accent.oklch} / 0.18)`);

    // Font
    const font = EDITOR_FONTS[editorFont];
    root.style.setProperty('--font-sans', font.css);
    root.style.setProperty('--font-mono', font.css);

    // Font size
    root.style.setProperty('--base-font-size', `${fontSize}px`);
    root.style.fontSize = `${fontSize}px`;

  }, [theme, accentColor, editorFont, fontSize]);

  // Block browser-level zoom (Ctrl+scroll, pinch, Ctrl+±/0) — zoom must not affect the entire UI.
  // D3 graph zoom and canvas zoom use SVG/CSS transforms and are unaffected.
  // Use capture phase on document so WebKit sees the preventDefault before native gesture handling.
  useEffect(() => {
    const blockZoomWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const blockZoomKeys = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
        e.preventDefault();
      }
    };
    // gesturestart/gesturechange fire on WebKit for touchpad pinch — block them entirely.
    const blockGesture = (e: Event) => e.preventDefault();

    document.addEventListener('wheel', blockZoomWheel, { passive: false, capture: true });
    document.addEventListener('keydown', blockZoomKeys, { capture: true });
    document.addEventListener('gesturestart', blockGesture, { capture: true });
    document.addEventListener('gesturechange', blockGesture, { capture: true });
    return () => {
      document.removeEventListener('wheel', blockZoomWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener('keydown', blockZoomKeys, { capture: true } as EventListenerOptions);
      document.removeEventListener('gesturestart', blockGesture, { capture: true } as EventListenerOptions);
      document.removeEventListener('gesturechange', blockGesture, { capture: true } as EventListenerOptions);
    };
  }, []);

  // Optional AppImage blur fallback. Enable with COLLAB_APPIMAGE_DISABLE_BLUR=1
  // for systems where AppImage WebKitGTK compositing is unstable.
  useEffect(() => {
    Promise.allSettled([
      tauriCommands.isAppImage(),
      tauriCommands.shouldDisableBlur(),
    ]).then(([appImageResult, disableBlurResult]) => {
      const isAppImage = appImageResult.status === 'fulfilled' ? appImageResult.value : false;
      const shouldDisableBlur = disableBlurResult.status === 'fulfilled' ? disableBlurResult.value : false;
      if (isAppImage && shouldDisableBlur) {
        document.documentElement.dataset.appimage = '';
      } else {
        delete document.documentElement.dataset.appimage;
      }
    });
  }, []);

  // Background update check: runs 3 s after startup, then every 6 hours.
  useEffect(() => {
    const run = async () => {
      await checkForUpdate();
      // Read latest state after the async call resolves
      const { status, updateInfo } = useUpdateStore.getState();
      if (status === 'available') {
        toast.info(`Update available: v${updateInfo?.version}`, {
          description: 'Open Settings → About to install.',
          duration: 8000,
        });
      }
    };

    const timeout = setTimeout(run, 3000);
    const interval = setInterval(run, 6 * 60 * 60 * 1000);
    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, []);

  // Apply HiDPI zoom. Routes through set_ui_zoom so the Rust side records the
  // intended level before setting it — this prevents the gesture-blocking signal
  // handler from immediately resetting our own intentional zoom change.
  useEffect(() => {
    tauriCommands.setUiZoom(scale / 100).catch(console.error);
  }, [scale]);

  return (
    <TooltipProvider delayDuration={300}>
      {vault
        ? isVaultLocked
          ? <VaultUnlockModal />
          : <AppShell />
        : <VaultPicker />
      }
      {isSettingsOpen && <SettingsModal />}
      {isVaultManagerOpen && <VaultManagerModal />}
      <Toaster richColors position="bottom-right" />
    </TooltipProvider>
  );
}
