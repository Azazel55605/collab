import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsProfileSection from './SettingsProfileSection';

describe('SettingsProfileSection', () => {
  it('handles name changes and save action', () => {
    const setName = vi.fn();
    const onSave = vi.fn();

    render(
      <SettingsProfileSection
        name="Azazel"
        setName={setName}
        myUserColor="#ff00ff"
        myUserId="user-123"
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'New Name' } });
    expect(setName).toHaveBeenCalledWith('New Name');

    expect(screen.getByText('user-123')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    expect(onSave).toHaveBeenCalled();
  });
});
