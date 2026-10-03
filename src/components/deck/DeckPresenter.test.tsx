import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFixtureDeck } from '../../lib/deck/fixture';
import type { PlaybackAction } from '../../lib/deck/playback';
import type { AudienceCallbacks, AudienceHandle, DisplayInfo } from '../../lib/deck/presentWindow';
import { createApproximateMeasurer } from '../../lib/deck/textLayout';
import type { DeckDocument } from '../../types/deck';

import { DeckPresenter } from './DeckPresenter';
import type {
  DeckPresenterRemote,
  DeckPresenterRuntime,
  DeckPresentMode,
  DeckShowPosition,
} from './DeckPresenter';

const measurer = createApproximateMeasurer();
const SIZE = { width: 960, height: 540 };

const sizeDescriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => SIZE.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => SIZE.height,
  });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(sizeDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

const DISPLAYS: DisplayInfo[] = [
  {
    id: 'laptop',
    name: 'Laptop',
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scaleFactor: 1,
    primary: true,
  },
  {
    id: 'projector',
    name: 'Projector',
    x: 1920,
    y: 0,
    width: 1920,
    height: 1080,
    scaleFactor: 1,
    primary: false,
  },
];

function setup(
  options: {
    deck?: DeckDocument;
    mode?: DeckPresentMode;
    start?: string | null;
    runtime?: DeckPresenterRuntime;
    remote?: DeckPresenterRemote;
    onShowChange?: (show: DeckShowPosition) => void;
  } = {},
) {
  const onExit = vi.fn();
  const onNotice = vi.fn();
  const onOpenUrl = vi.fn();
  const setWindowFullscreen = vi.fn(async () => false);
  const deck = options.deck ?? buildFixtureDeck();
  render(
    <DeckPresenter
      deck={deck}
      startSlideId={options.start ?? null}
      mode={options.mode ?? 'slideshow'}
      measurer={measurer}
      resolveAsset={() => null}
      onExit={onExit}
      onNotice={onNotice}
      onOpenUrl={onOpenUrl}
      remote={options.remote}
      onShowChange={options.onShowChange}
      runtime={{
        listDisplays: async () => [],
        currentDisplayId: async () => null,
        openAudienceWindow: async () => null,
        setWindowFullscreen,
        ...options.runtime,
      }}
    />,
  );
  return { onExit, onNotice, onOpenUrl, setWindowFullscreen, deck };
}

const key = (value: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key: value, ...init });

describe('DeckPresenter: slide show', () => {
  it('goes full screen, navigates with keys, skips hidden slides, and ends', async () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-2'].hidden = true;
    const { onExit, setWindowFullscreen } = setup({ deck });
    await waitFor(() => expect(setWindowFullscreen).toHaveBeenCalledWith(true));
    expect(screen.getByRole('dialog', { name: 'Slide show' })).toBeTruthy();
    expect(screen.getByText('1 / 4')).toBeTruthy();
    key('ArrowRight');
    expect(screen.getByText('2 / 4')).toBeTruthy();
    // Slide 2 was skipped: the third slide shows, and "previous" returns to the first.
    key('ArrowLeft');
    expect(screen.getByText('1 / 4')).toBeTruthy();
    // A number reaches the hidden slide.
    key('2');
    expect(screen.getByText('Go to slide 2')).toBeTruthy();
    key('Enter');
    expect(screen.getByText('2 / 5')).toBeTruthy();
    key('End');
    key(' ');
    expect(screen.getByText(/End of slide show/)).toBeTruthy();
    key('Escape');
    expect(onExit).toHaveBeenCalledWith({ slideId: 'slide-5', ink: {} });
    // Leaving restores the window as it was.
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
  });

  it('blanks to black or white without moving, and any key brings the slide back', () => {
    setup({ start: 'slide-3' });
    key('b');
    expect(screen.getByRole('img', { name: 'Black screen' })).toBeTruthy();
    key('ArrowRight');
    expect(screen.queryByRole('img', { name: 'Black screen' })).toBeNull();
    expect(screen.getByText('3 / 5')).toBeTruthy();
    key('w');
    expect(screen.getByRole('img', { name: 'White screen' })).toBeTruthy();
  });

  it('draws temporary ink that is handed back on exit, never written to the deck', () => {
    const { onExit, deck } = setup();
    const before = JSON.stringify(deck);
    key('p', { ctrlKey: true });
    const input = screen.getByTestId('deck-playback-input');
    fireEvent.pointerDown(input, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(input, { pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(input, { pointerId: 1, clientX: 300, clientY: 200 });
    // Drawing never advances the slide.
    expect(screen.getByText('1 / 5')).toBeTruthy();
    key('Escape');
    const summary = onExit.mock.calls[0][0];
    expect(summary.ink['slide-1']).toHaveLength(1);
    expect(summary.ink['slide-1'][0]).toMatchObject({ tool: 'pen' });
    expect(summary.ink['slide-1'][0].points.length).toBeGreaterThan(1);
    expect(JSON.stringify(deck)).toBe(before);
  });

  it('clicks and taps advance, right click goes back, and a swipe navigates', () => {
    setup();
    const input = screen.getByTestId('deck-playback-input');
    fireEvent.pointerDown(input, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(input, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByText('2 / 5')).toBeTruthy();
    fireEvent.contextMenu(input);
    expect(screen.getByText('1 / 5')).toBeTruthy();
    fireEvent.pointerDown(input, { button: 0, pointerId: 2, clientX: 400, clientY: 100 });
    fireEvent.pointerUp(input, { pointerId: 2, clientX: 200, clientY: 110 });
    expect(screen.getByText('2 / 5')).toBeTruthy();
  });

  it('consumes animation build clicks before advancing the slide', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-1'].animations = [
      {
        id: 'animation-1',
        elementId: 's1-title',
        effect: 'fade',
        phase: 'entrance',
        trigger: 'click',
        durationMs: 500,
      },
    ];
    setup({ deck });
    const dialog = screen.getByRole('dialog', { name: 'Slide show' });
    expect(dialog.querySelector('style')?.textContent).toContain('visibility:hidden');
    key('ArrowRight');
    expect(screen.getByText('1 / 5')).toBeTruthy();
    expect(dialog.querySelector('style')?.textContent).toContain('deck-anim-fade-in');
    key('ArrowRight');
    expect(screen.getByText('2 / 5')).toBeTruthy();
  });

  it('keeps keys away from the editor behind it', () => {
    const outside = vi.fn();
    document.body.addEventListener('keydown', outside);
    setup();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(outside).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outside);
  });
});

describe('DeckPresenter: presenter view', () => {
  function audienceRuntime() {
    const sent: unknown[] = [];
    let callbacks: AudienceCallbacks | null = null;
    const handle: AudienceHandle = {
      display: DISPLAYS[1],
      sendSlide: (frame) => sent.push(frame),
      sendOverlay: () => {},
      close: vi.fn(async () => {}),
    };
    const openAudienceWindow = vi.fn(async (_display: DisplayInfo, next: AudienceCallbacks) => {
      callbacks = next;
      return handle;
    });
    return {
      sent,
      handle,
      openAudienceWindow,
      callbacks: () => callbacks!,
      runtime: {
        listDisplays: async () => DISPLAYS,
        currentDisplayId: async () => 'laptop',
        openAudienceWindow,
      } satisfies DeckPresenterRuntime,
    };
  }

  it('shows notes, next slide, and timer, and sends slides to the other display', async () => {
    const audience = audienceRuntime();
    setup({ mode: 'presenter', start: 'slide-2', runtime: audience.runtime });
    expect(screen.getByRole('dialog', { name: 'Presenter view' })).toBeTruthy();
    expect(screen.getByText(/export never changes the backing format/)).toBeTruthy();
    expect(screen.getByText('Next: slide 3')).toBeTruthy();
    expect(screen.getByLabelText('Elapsed time').textContent).toMatch(/^0:0\d$/);
    await waitFor(() => expect(audience.openAudienceWindow).toHaveBeenCalled());
    expect(audience.openAudienceWindow.mock.calls[0][0].id).toBe('projector');
    await screen.findByLabelText('Display for slides');
    expect(audience.sent.length).toBeGreaterThan(0);
    // Keys pressed on the audience display drive the show.
    act(() =>
      audience
        .callbacks()
        .onKey({ key: 'ArrowRight', ctrl: false, meta: false, alt: false, shift: false }),
    );
    expect(screen.getByText('Slide 3 of 5')).toBeTruthy();
  });

  it('continues the show in this window when the audience window is lost', async () => {
    const audience = audienceRuntime();
    const { onNotice } = setup({ mode: 'presenter', runtime: audience.runtime });
    await screen.findByLabelText('Display for slides');
    key('ArrowRight');
    act(() => audience.callbacks().onClosed());
    expect(await screen.findByRole('dialog', { name: 'Slide show' })).toBeTruthy();
    expect(screen.getByText('2 / 5')).toBeTruthy();
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/continues on this screen/));
  });

  it('rehearses in one window when there is no second display', async () => {
    setup({
      mode: 'presenter',
      runtime: { listDisplays: async () => [DISPLAYS[0]], currentDisplayId: async () => 'laptop' },
    });
    expect(await screen.findByText(/No second display/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show slides here' }));
    expect(screen.getByRole('dialog', { name: 'Slide show' })).toBeTruthy();
  });
});

describe('DeckPresenter: phone remote', () => {
  it('applies remote commands, reports where the show is, and toggles the opt-in', () => {
    let deliver: ((action: PlaybackAction) => void) | null = null;
    const onAllowedChange = vi.fn();
    const onShowChange = vi.fn();
    setup({
      onShowChange,
      remote: {
        allowed: false,
        onAllowedChange,
        subscribe: (listener) => {
          deliver = listener;
          return () => {
            deliver = null;
          };
        },
      },
    });
    expect(onShowChange).toHaveBeenLastCalledWith({
      slideId: 'slide-1',
      position: 1,
      total: 5,
      blank: null,
    });
    act(() => deliver!({ type: 'next' }));
    expect(screen.getByText('2 / 5')).toBeTruthy();
    act(() => deliver!({ type: 'blank', blank: 'black' }));
    expect(onShowChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ slideId: 'slide-2', blank: 'black' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allow phone remote' }));
    expect(onAllowedChange).toHaveBeenCalledWith(true);
  });

  it('shows no remote button without a live session', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Allow phone remote' })).toBeNull();
  });
});
