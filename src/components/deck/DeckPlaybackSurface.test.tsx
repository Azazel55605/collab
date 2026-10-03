import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '../../App.css';

import { DeckPlaybackSurface } from './DeckPlaybackSurface';

const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1_920,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 1_080,
  });
});

afterEach(() => {
  cleanup();
  if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDescriptor);
  if (heightDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', heightDescriptor);
});

describe('DeckPlaybackSurface', () => {
  it('stretches the generated SVG through the animation wrapper', () => {
    const { container } = render(
      <DeckPlaybackSurface
        markup='<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720"/></svg>'
        aspect={16 / 9}
        blank={null}
        ended={false}
        ink=""
        inkViewBox={[1, 1]}
        laser={null}
      />,
    );

    const svg = container.querySelector<SVGSVGElement>('.deck-playback-animation-scope > svg');
    expect(svg).not.toBeNull();
    expect(getComputedStyle(svg!).display).toBe('block');
    expect(getComputedStyle(svg!).width).toBe('100%');
    expect(getComputedStyle(svg!).height).toBe('100%');
  });
});
