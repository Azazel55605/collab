import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';

const tauriCommandsMock = vi.hoisted(() => ({
  isAppImage: vi.fn(),
  shouldDisableBlur: vi.fn(),
  setUiZoom: vi.fn(),
}));

vi.mock('./lib/tauri', () => ({
  tauriCommands: tauriCommandsMock,
}));

vi.mock('./components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./components/vault/VaultPicker', () => ({
  default: () => <div data-testid="vault-picker" />,
}));

vi.mock('./components/layout/AppShell', () => ({
  default: () => <div data-testid="app-shell" />,
}));

vi.mock('./components/settings/SettingsModal', () => ({
  default: () => null,
}));

vi.mock('./components/vault/VaultManagerModal', () => ({
  default: () => null,
}));

vi.mock('./components/vault/VaultUnlockModal', () => ({
  default: () => null,
}));

vi.mock('./components/ui/sonner', () => ({
  Toaster: () => null,
}));

vi.mock('./views/NotePrintView', () => ({
  default: () => null,
}));

vi.mock('./lib/browserCompat', () => ({
  subscribeMediaQueryChange: () => () => {},
}));

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
  },
}));

vi.mock('./store/vaultStore', () => ({
  useVaultStore: () => ({
    vault: null,
    isVaultLocked: false,
    openVault: vi.fn(),
    lastOpenedVaultPath: null,
  }),
}));

vi.mock('./store/editorStore', () => ({
  useEditorStore: () => ({
    sessionVaultPath: null,
    setSessionVaultPath: vi.fn(),
    resetSession: vi.fn(),
  }),
}));

vi.mock('./store/uiStore', () => ({
  ACCENT_COLORS: {
    blue: { oklch: '0.62 0.17 254' },
  },
  INTERFACE_FONTS: {
    geist: { css: 'Geist, sans-serif' },
  },
  useUiStore: () => ({
    theme: 'dark',
    accentColor: 'blue',
    interfaceFont: 'geist',
    interfaceFontSize: 14,
    scale: 100,
    animationsEnabled: true,
    animationSpeed: 'normal',
    isSettingsOpen: false,
    isVaultManagerOpen: false,
    restorePreviousSession: false,
  }),
}));

vi.mock('./store/updateStore', () => ({
  useUpdateStore: () => ({
    checkForUpdate: vi.fn(),
  }),
}));

describe('App Windows blur fallback', () => {
  const originalUserAgent = navigator.userAgent;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();
    tauriCommandsMock.isAppImage.mockResolvedValue(false);
    tauriCommandsMock.shouldDisableBlur.mockResolvedValue(false);
    tauriCommandsMock.setUiZoom.mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    }));
    delete document.documentElement.dataset.windowsWebview;
  });

  afterEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
    window.matchMedia = originalMatchMedia;
    delete document.documentElement.dataset.windowsWebview;
  });

  it('marks Windows WebView sessions for blur fallback styling', async () => {
    render(<App />);

    await waitFor(() => {
      expect(document.documentElement.dataset.windowsWebview).toBe('');
    });
  });
});
