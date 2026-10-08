import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';

import { useChatPreferences } from '../../store/chatPreferences';

import SettingsChatsSection from './SettingsChatsSection';

beforeEach(() => useChatPreferences.getState().resetChatPreferences());

it('changes chat preferences and reflects them in the live preview', () => {
  const view = render(<SettingsChatsSection />);
  fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
  fireEvent.click(screen.getByRole('button', { name: 'Flat' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Send with Enter' }));
  const state = useChatPreferences.getState();
  expect(state.density).toBe('compact');
  expect(state.messageStyle).toBe('flat');
  expect(state.enterToSend).toBe(false);
  const preview = view.container.querySelector('.conversation-style-preview')!;
  expect(preview.getAttribute('data-density')).toBe('compact');
  expect(preview.getAttribute('data-message-style')).toBe('flat');
  fireEvent.click(screen.getByRole('button', { name: 'Reset chat settings' }));
  expect(useChatPreferences.getState().density).toBe('comfortable');
});
