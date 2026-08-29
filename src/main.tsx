import React from 'react';

import ReactDOM from 'react-dom/client';

import App from './App';

const BOOT_THEME_VARS: Record<string, Record<string, string>> = {
  dark: {
    '--background': 'oklch(0.17 0.015 264)',
    '--foreground': 'oklch(0.93 0.01 264)',
    '--card': 'oklch(0.20 0.015 264)',
    '--card-foreground': 'oklch(0.93 0.01 264)',
    '--popover': 'oklch(0.19 0.018 264)',
    '--muted': 'oklch(0.23 0.015 264)',
    '--muted-foreground': 'oklch(0.62 0.02 264)',
    '--accent': 'oklch(0.26 0.02 264)',
    '--accent-foreground': 'oklch(0.93 0.01 264)',
    '--border': 'oklch(1 0 0 / 11%)',
    '--input': 'oklch(1 0 0 / 13%)',
    '--sidebar': 'oklch(0.15 0.018 264)',
  },
  midnight: {
    '--background': 'oklch(0.07 0.00 0)',
    '--foreground': 'oklch(0.90 0.00 0)',
    '--card': 'oklch(0.10 0.00 0)',
    '--card-foreground': 'oklch(0.90 0.00 0)',
    '--popover': 'oklch(0.09 0.005 264)',
    '--muted': 'oklch(0.14 0.00 0)',
    '--muted-foreground': 'oklch(0.55 0.01 264)',
    '--accent': 'oklch(0.16 0.01 264)',
    '--accent-foreground': 'oklch(0.90 0.00 0)',
    '--border': 'oklch(1 0 0 / 8%)',
    '--input': 'oklch(1 0 0 / 10%)',
    '--sidebar': 'oklch(0.08 0.00 0)',
  },
  warm: {
    '--background': 'oklch(0.11 0.02 60)',
    '--foreground': 'oklch(0.92 0.02 60)',
    '--card': 'oklch(0.14 0.02 60)',
    '--card-foreground': 'oklch(0.92 0.02 60)',
    '--popover': 'oklch(0.13 0.02 60)',
    '--muted': 'oklch(0.18 0.02 60)',
    '--muted-foreground': 'oklch(0.60 0.03 60)',
    '--accent': 'oklch(0.20 0.03 60)',
    '--accent-foreground': 'oklch(0.92 0.02 60)',
    '--border': 'oklch(1 0 0 / 9%)',
    '--input': 'oklch(1 0 0 / 12%)',
    '--sidebar': 'oklch(0.12 0.025 60)',
  },
  light: {
    '--background': 'oklch(0.97 0 0)',
    '--foreground': 'oklch(0.14 0 0)',
    '--card': 'oklch(1 0 0)',
    '--card-foreground': 'oklch(0.14 0 0)',
    '--popover': 'oklch(1 0 0)',
    '--muted': 'oklch(0.94 0 0)',
    '--muted-foreground': 'oklch(0.45 0.01 264)',
    '--accent': 'oklch(0.93 0.01 264)',
    '--accent-foreground': 'oklch(0.14 0 0)',
    '--border': 'oklch(0 0 0 / 10%)',
    '--input': 'oklch(0 0 0 / 10%)',
    '--sidebar': 'oklch(0.94 0 0)',
  },
};

const BOOT_ACCENTS: Record<string, string> = {
  violet: '0.68 0.22 293',
  blue: '0.65 0.19 237',
  emerald: '0.72 0.17 162',
  rose: '0.66 0.22 13',
  orange: '0.72 0.18 50',
  cyan: '0.74 0.14 200',
};

const BOOT_INTERFACE_FONTS: Record<string, string> = {
  geist: "'Geist Variable', sans-serif",
  inter: "'Inter Variable', 'Inter', system-ui, sans-serif",
  serif: "'Georgia', 'Times New Roman', serif",
  mono: "'JetBrains Mono', 'Fira Code', 'Geist Mono Variable', 'Courier New', monospace",
};

// Apply dark mode synchronously before first paint to avoid flash
let theme: string = 'dark';
let accentColor: string = 'violet';
let interfaceFont: string = 'geist';
try {
  const stored = localStorage.getItem('ui-storage');
  const parsed = JSON.parse(stored ?? '{}');
  theme = parsed?.state?.theme ?? 'dark';
  accentColor = parsed?.state?.accentColor ?? 'violet';
  interfaceFont = parsed?.state?.interfaceFont ?? 'geist';
} catch {}
// dark, midnight and warm are all dark-mode variants
document.documentElement.classList.toggle('dark', theme !== 'light');
const themeVars = BOOT_THEME_VARS[theme] ?? BOOT_THEME_VARS.dark;
for (const [key, value] of Object.entries(themeVars)) {
  document.documentElement.style.setProperty(key, value);
}
const accent = BOOT_ACCENTS[accentColor] ?? BOOT_ACCENTS.violet;
document.documentElement.style.setProperty('--primary', `oklch(${accent})`);
document.documentElement.style.setProperty(
  '--primary-foreground',
  theme === 'light' ? 'oklch(1 0 0)' : 'oklch(0.10 0 0)',
);
document.documentElement.style.setProperty('--ring', `oklch(${accent})`);
document.documentElement.style.setProperty('--glow-primary', `oklch(${accent} / 30%)`);
document.documentElement.style.setProperty('--glow-primary-sm', `oklch(${accent} / 15%)`);
document.documentElement.style.setProperty(
  '--app-font-sans',
  BOOT_INTERFACE_FONTS[interfaceFont] ?? BOOT_INTERFACE_FONTS.geist,
);

// ── Global error overlay ───────────────────────────────────────────────────
// Shows a visible red overlay instead of a blank screen so crashes are
// debuggable without opening DevTools.

function showErrorOverlay(message: string) {
  const existing = document.getElementById('__err_overlay__');
  if (existing) {
    existing.querySelector('pre')!.textContent += '\n\n' + message;
    return;
  }
  const el = document.createElement('div');
  el.id = '__err_overlay__';
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:99999',
    'background:#1a0000',
    'color:#ff9999',
    'font:13px/1.5 monospace',
    'padding:24px',
    'overflow:auto',
    'white-space:pre-wrap',
  ].join(';');
  el.innerHTML = `<b style="font-size:15px;color:#ff4444">⚠ Uncaught Error</b>\n\n`;
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all';
  pre.textContent = message;
  el.appendChild(pre);
  document.body.appendChild(el);
}

function isIgnorableBrowserError(message: string) {
  return (
    message.includes('ResizeObserver loop completed with undelivered notifications.') ||
    message.includes('ResizeObserver loop limit exceeded')
  );
}

window.addEventListener('error', (e) => {
  const errorName = e.error?.name ? `${e.error.name}: ` : '';
  const errorMessage = e.error?.message ?? e.message;
  const stack = e.error?.stack;
  const msg = stack ?? `${errorName}${errorMessage}\n  at ${e.filename}:${e.lineno}:${e.colno}`;
  if (isIgnorableBrowserError(e.message ?? '') || isIgnorableBrowserError(msg)) {
    e.preventDefault();
    return;
  }
  showErrorOverlay(msg);
});

window.addEventListener('unhandledrejection', (e) => {
  const reasonName = e.reason?.name ? `${e.reason.name}: ` : '';
  const reasonMessage = e.reason?.message;
  const msg =
    e.reason?.stack ?? (reasonMessage ? `${reasonName}${reasonMessage}` : String(e.reason));
  if (isIgnorableBrowserError(msg)) {
    e.preventDefault();
    return;
  }
  showErrorOverlay('Unhandled Promise Rejection:\n' + msg);
});

// Replace the browser's default context menu with our custom one.
// Radix UI's ContextMenu components intercept the contextmenu event on their
// own triggers before it reaches this handler, so custom menus still appear.
document.addEventListener('contextmenu', (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  const bootScreen = document.getElementById('boot-screen');
  if (!bootScreen) return;

  const removeBootScreen = (event?: TransitionEvent) => {
    if (event && event.target !== bootScreen) return;
    bootScreen.removeEventListener('transitionend', removeBootScreen);
    bootScreen.remove();
  };

  bootScreen.addEventListener('transitionend', removeBootScreen);

  requestAnimationFrame(() => {
    bootScreen.setAttribute('data-card-hidden', 'true');
    window.setTimeout(() => {
      bootScreen.setAttribute('data-hidden', 'true');
    }, 90);
  });
});
