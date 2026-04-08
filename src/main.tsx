import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Apply dark mode synchronously before first paint to avoid flash
const stored = localStorage.getItem('ui-storage');
let theme: string = 'dark';
try {
  const parsed = JSON.parse(stored ?? '{}');
  theme = parsed?.state?.theme ?? 'dark';
} catch {}
// dark, midnight and warm are all dark-mode variants
document.documentElement.classList.toggle('dark', theme !== 'light');

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
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:#1a0000', 'color:#ff9999',
    'font:13px/1.5 monospace', 'padding:24px',
    'overflow:auto', 'white-space:pre-wrap',
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
  const msg = e.error?.stack ?? `${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}`;
  if (isIgnorableBrowserError(e.message ?? '') || isIgnorableBrowserError(msg)) {
    e.preventDefault();
    return;
  }
  showErrorOverlay(msg);
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.stack ?? String(e.reason);
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
