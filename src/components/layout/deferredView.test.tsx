import { useEffect } from 'react';

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { deferredView } from './deferredView';

describe('deferred view loading', () => {
  it('does not load before mounting, and uses the latest document after a pending import', async () => {
    let finish!: (module: { default: typeof Editor }) => void;
    const mounted: string[] = [];
    function Editor({ path }: { path: string }) {
      useEffect(() => {
        mounted.push(path);
      }, [path]);
      return <p>{path}</p>;
    }
    const load = vi.fn(
      () =>
        new Promise<{ default: typeof Editor }>((resolve) => {
          finish = resolve;
        }),
    );
    const Deferred = deferredView(load);
    expect(load).not.toHaveBeenCalled();
    const view = render(<Deferred path="first.md" />);
    expect(screen.getByRole('status').textContent).toContain('Loading view');
    view.rerender(<Deferred path="second.md" />);
    await act(async () => {
      finish({ default: Editor });
    });
    expect(await screen.findByText('second.md')).toBeTruthy();
    expect(mounted).toEqual(['second.md']);
    expect(load).toHaveBeenCalledOnce();
  });

  it('keeps a rejected import local to its pane and explains recovery', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mounted = vi.fn();
    const Healthy = deferredView(async () => ({
      default: function Editor() {
        useEffect(() => {
          mounted();
        }, []);
        return <p>Healthy editor</p>;
      },
    }));
    const load = vi.fn().mockRejectedValue(new Error('Chunk unavailable'));
    const Recoverable = deferredView(load);
    render(
      <>
        <Healthy />
        <Recoverable />
      </>,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(await screen.findByText('Healthy editor')).toBeTruthy();
    expect(screen.getByText(/reopen Collab to try again/)).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
    expect(mounted).toHaveBeenCalledOnce();
  });
});
