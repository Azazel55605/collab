import { describe, expect, it } from 'vitest';

import {
  directRemoteConfiguration,
  directRemoteMessage,
  MAX_DIRECT_SDP_BYTES,
  parseDirectRemoteMessage,
  validDirectSdp,
} from './directRemote';

describe('direct presentation remote messages', () => {
  it('accepts bounded commands and clamps pointer coordinates', () => {
    expect(
      parseDirectRemoteMessage(directRemoteMessage({ type: 'command', action: 'next' })),
    ).toEqual({ type: 'command', action: 'next' });
    expect(
      parseDirectRemoteMessage(directRemoteMessage({ type: 'pointer', active: true, x: -2, y: 4 })),
    ).toEqual({ type: 'pointer', active: true, x: 0, y: 1 });
  });

  it('rejects malformed, oversized, and invalid goto messages', () => {
    expect(parseDirectRemoteMessage('{')).toBeNull();
    expect(parseDirectRemoteMessage('x'.repeat(1_025))).toBeNull();
    expect(
      parseDirectRemoteMessage(JSON.stringify({ type: 'command', action: 'goto', index: -1 })),
    ).toBeNull();
    expect(
      parseDirectRemoteMessage(JSON.stringify({ type: 'command', action: 'shutdown' })),
    ).toBeNull();
  });

  it('bounds signaling descriptions before passing them to WebRTC', () => {
    expect(validDirectSdp('v=0\r\n')).toBe(true);
    expect(validDirectSdp('')).toBe(false);
    expect(validDirectSdp('x'.repeat(MAX_DIRECT_SDP_BYTES + 1))).toBe(false);
  });

  it('uses STUN because WebKit can suppress host candidates without capture permission', () => {
    expect(directRemoteConfiguration()).toEqual({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      iceCandidatePoolSize: 1,
    });
  });
});
