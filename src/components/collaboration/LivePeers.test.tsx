import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LivePeer } from '../../lib/liveAwareness';
import { TooltipProvider } from '../ui/tooltip';

import LivePeers from './LivePeers';

function renderPeers(peers: LivePeer[], max?: number) {
  return render(
    <TooltipProvider>
      <LivePeers peers={peers} max={max} />
    </TooltipProvider>,
  );
}

describe('LivePeers', () => {
  it('renders nothing when there are no peers', () => {
    renderPeers([]);
    expect(screen.queryByTestId('live-peers')).toBeNull();
  });

  it('renders one avatar per unique user', () => {
    renderPeers([
      { clientId: 1, user: { id: 'a', name: 'Ann', color: '#f00' } },
      { clientId: 2, user: { id: 'a', name: 'Ann', color: '#f00' } },
      { clientId: 3, user: { id: 'bob', name: 'Bob', color: '#0f0' } },
    ]);
    const strip = screen.getByTestId('live-peers');
    expect(strip.textContent).toContain('A');
    expect(strip.textContent).toContain('B');
  });

  it('collapses overflow past the max into a +N badge', () => {
    const peers: LivePeer[] = Array.from({ length: 7 }, (_, i) => ({
      clientId: i + 1,
      user: { id: `u${i}`, name: `User ${i}`, color: '#123' },
    }));
    renderPeers(peers, 5);
    expect(screen.getByText('+2')).toBeTruthy();
  });
});
