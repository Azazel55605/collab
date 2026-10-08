import { beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_CHAT_PREFERENCES, sanitizeChatPreferences } from './chatPreferences';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it('keeps only known values and falls back to defaults', () => {
  expect(
    sanitizeChatPreferences({ density: 'compact', textSize: 'huge', showPreviews: 'yes', x: 1 }),
  ).toEqual({ ...DEFAULT_CHAT_PREFERENCES, density: 'compact' });
  expect(sanitizeChatPreferences(null)).toEqual(DEFAULT_CHAT_PREFERENCES);
});
it('carries the earlier layout toggle over and persists changes', async () => {
  localStorage.setItem('collab.chat-layout', 'separate');
  const { useChatPreferences } = await import('./chatPreferences');
  expect(useChatPreferences.getState().sidebarLayout).toBe('separate');
  useChatPreferences.getState().setChatPreference('messageStyle', 'flat');
  expect(JSON.parse(localStorage.getItem('collab.chat-preferences')!).state.messageStyle).toBe(
    'flat',
  );
  useChatPreferences.getState().resetChatPreferences();
  expect(useChatPreferences.getState().messageStyle).toBe('bubbles');
});
