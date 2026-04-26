import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsDisplaySection from './SettingsDisplaySection';

describe('SettingsDisplaySection', () => {
  it('handles scale and motion controls', () => {
    const setScale = vi.fn();
    const setAnimationsEnabled = vi.fn();
    const setAnimationSpeed = vi.fn();

    render(
      <SettingsDisplaySection
        scale={100}
        setScale={setScale}
        animationsEnabled={true}
        setAnimationsEnabled={setAnimationsEnabled}
        animationSpeed="normal"
        setAnimationSpeed={setAnimationSpeed}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '125%' }));
    expect(setScale).toHaveBeenCalledWith(125);

    fireEvent.click(screen.getByRole('switch'));
    expect(setAnimationsEnabled).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Fast' }));
    expect(setAnimationSpeed).toHaveBeenCalledWith('fast');
  });
});
