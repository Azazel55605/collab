import { describe, expect, it } from 'vitest';

import { lyricIndexAt, parseLyrics } from './mediaLyrics';

describe('audio lyrics', () => {
  it('sorts LRC timestamps, applies offsets, and follows seeks and instrumental breaks', () => {
    const { lines } = parseLyrics(
      '\uFEFF[ar:Artist]\r\n[00:04.5][00:01.25]A line\r\n[00:02.75]\r\n[offset:-250]',
    );
    expect(lines).toEqual([
      { time: 1, text: 'A line' },
      { time: 2.5, text: '' },
      { time: 4.25, text: 'A line' },
    ]);
    expect([4.25, 2.5, 1.8, 0.5].map((time) => lyricIndexAt(lines, time))).toEqual([2, 1, 0, -1]);
  });

  it('groups simultaneous lines, strips inline word timing and retains untimed lyrics', () => {
    expect(parseLyrics('[00:01.000]<00:01.100>Hello\n[00:01]Hola').lines).toEqual([
      { time: 1, text: 'Hello\nHola' },
    ]);
    expect(parseLyrics('[ti:Song]\nHello\n\nWorld')).toEqual({
      lines: [],
      text: 'Hello\n\nWorld',
    });
  });
});
