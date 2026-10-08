import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';

import { useChatPreferences } from '../../../../src/store/chatPreferences';

import { ChatSettingsSection } from './ChatSettingsSection';

beforeEach(() => useChatPreferences.getState().resetChatPreferences());

it('updates the shared chat preferences from the Android settings', () => {
  render(<ChatSettingsSection />);
  fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
  fireEvent.click(
    screen
      .getByRole('radiogroup', { name: 'Group chats' })
      .querySelector('[role="radio"]:last-child')!,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /Message previews/ }));
  const state = useChatPreferences.getState();
  expect(state.density).toBe('compact');
  expect(state.groupChats).toBe('separate');
  expect(state.showPreviews).toBe(false);
  expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true');
});
