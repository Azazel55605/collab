import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '../../store/uiStore';

import SettingsPresentationSection from './SettingsPresentationSection';

vi.mock('../../lib/deck/presentWindow', () => ({
  listDisplays: vi.fn(async () => []),
}));

describe('SettingsPresentationSection', () => {
  beforeEach(() => {
    useUiStore.setState({
      presentationAllowRemoteStart: false,
      presentationAlwaysAllowPhoneControl: false,
      presentationDirectControl: true,
      presentationDefaultMode: 'slideshow',
      presentationPreferredDisplayId: null,
    });
  });

  afterEach(cleanup);

  it('updates the persisted presentation safety preferences', () => {
    render(<SettingsPresentationSection />);

    fireEvent.click(screen.getByRole('switch', { name: /Always allow phone control/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Prefer direct phone connection/ }));
    fireEvent.click(
      screen.getByRole('switch', { name: /Allow presentations to start from my phone/ }),
    );

    expect(useUiStore.getState()).toMatchObject({
      presentationAlwaysAllowPhoneControl: true,
      presentationDirectControl: false,
      presentationAllowRemoteStart: true,
    });
  });
});
