import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsCanvasSection from './SettingsCanvasSection';

describe('SettingsCanvasSection', () => {
  it('handles web card mode and auto-load settings', () => {
    const setCanvasWebCardDefaultMode = vi.fn();
    const setCanvasWebCardAutoLoad = vi.fn();

    render(
      <SettingsCanvasSection
        canvasWebCardDefaultMode="preview"
        setCanvasWebCardDefaultMode={setCanvasWebCardDefaultMode}
        canvasWebCardAutoLoad={true}
        setCanvasWebCardAutoLoad={setCanvasWebCardAutoLoad}
        webPreviewsEnabled={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    expect(setCanvasWebCardDefaultMode).toHaveBeenCalledWith('embed');

    fireEvent.click(screen.getByRole('switch'));
    expect(setCanvasWebCardAutoLoad).toHaveBeenCalledWith(false);
  });
});
