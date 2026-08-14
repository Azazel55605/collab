import { describe, expect, it } from 'vitest';

import {
  INK_BRUSH_ORDER,
  INK_DEFAULT_PEN_BUTTONS,
  INK_SHORTCUTS,
  defaultToolState,
  drawsBehindInk,
  penButtonTool,
  resolveInkCommand,
} from './tools';
import { INK_DEFAULT_BRUSHES } from './document';

function key(
  value: string,
  modifiers: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {},
) {
  return {
    key: value,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: modifiers.meta ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
  };
}

describe('defaultToolState', () => {
  it('starts on the pen with a real brush preset', () => {
    const state = defaultToolState();
    expect(state.tool).toBe('pen');
    expect(state.brush).toEqual(INK_DEFAULT_BRUSHES.ballpoint);
  });

  it('does not share the preset object, so editing the tool cannot restyle it', () => {
    const state = defaultToolState();
    state.brush.color = '#ff0000';
    expect(INK_DEFAULT_BRUSHES.ballpoint.color).not.toBe('#ff0000');
  });
});

describe('brush presets', () => {
  it('every brush the rail offers exists', () => {
    for (const kind of INK_BRUSH_ORDER) {
      expect(INK_DEFAULT_BRUSHES[kind]).toBeTruthy();
      expect(INK_DEFAULT_BRUSHES[kind].kind).toBe(kind);
    }
  });

  it('puts the highlighter behind normal ink', () => {
    // Not a rendering special case bolted on later — it is what a highlighter
    // is. Drawn over the top it would obscure the writing it marks.
    expect(drawsBehindInk(INK_DEFAULT_BRUSHES.highlighter)).toBe(true);
    expect(drawsBehindInk(INK_DEFAULT_BRUSHES.ballpoint)).toBe(false);
  });

  it('gives the highlighter partial opacity so ink shows through', () => {
    expect(INK_DEFAULT_BRUSHES.highlighter.opacity).toBeLessThan(1);
  });

  it('only simulates pressure where the brush opts in', () => {
    expect(INK_DEFAULT_BRUSHES.ballpoint.simulatePressure).toBeFalsy();
    expect(INK_DEFAULT_BRUSHES.pencil.simulatePressure).toBe(true);
  });

  it('gives the technical pen a uniform line', () => {
    expect(INK_DEFAULT_BRUSHES.technical.thinning).toBe(0);
  });
});

describe('resolveInkCommand', () => {
  it('resolves plain tool keys', () => {
    expect(resolveInkCommand(key('p'))).toBe('tool.pen');
    expect(resolveInkCommand(key('e'))).toBe('tool.eraser');
    expect(resolveInkCommand(key('v'))).toBe('tool.select');
  });

  it('treats Ctrl and Cmd as the same modifier', () => {
    expect(resolveInkCommand(key('z', { ctrl: true }))).toBe('edit.undo');
    expect(resolveInkCommand(key('z', { meta: true }))).toBe('edit.undo');
  });

  it('prefers the more specific binding over one that would shadow it', () => {
    // Ctrl+Shift+Z must be redo, not undo.
    expect(resolveInkCommand(key('z', { ctrl: true, shift: true }))).toBe('edit.redo');
    expect(resolveInkCommand(key('y', { ctrl: true }))).toBe('edit.redo');
  });

  it('distinguishes a bare key from its modified form', () => {
    expect(resolveInkCommand(key('v'))).toBe('tool.select');
    expect(resolveInkCommand(key('v', { ctrl: true }))).toBe('edit.paste');
  });

  it('is case-insensitive, so Shift-held letters still resolve', () => {
    expect(resolveInkCommand(key('P'))).toBe('tool.pen');
  });

  it('returns null for an unbound key', () => {
    expect(resolveInkCommand(key('b'))).toBeNull();
    expect(resolveInkCommand(key('p', { alt: true }))).toBeNull();
  });

  it('binds only layout-independent keys', () => {
    // The repo's rule: no punctuation or symbol shortcuts, because they move
    // between keyboard layouts. Letters, digits, and named keys only.
    for (const shortcut of INK_SHORTCUTS) {
      const isNamedKey = shortcut.key.length > 1;
      const isAlphanumeric = /^[a-z0-9]$/i.test(shortcut.key);
      expect(
        isNamedKey || isAlphanumeric,
        `"${shortcut.key}" is not layout-independent`,
      ).toBe(true);
    }
  });

  it('has no two bindings competing for the same chord', () => {
    const seen = new Map<string, string>();
    for (const shortcut of INK_SHORTCUTS) {
      const chord = [
        shortcut.ctrl ? 'ctrl' : '',
        shortcut.shift ? 'shift' : '',
        shortcut.alt ? 'alt' : '',
        shortcut.key.toLowerCase(),
      ].join('+');
      const existing = seen.get(chord);
      // Two entries may share a chord only if they mean the same thing.
      if (existing) expect(existing).toBe(shortcut.command);
      seen.set(chord, shortcut.command);
    }
  });
});

describe('pen buttons', () => {
  it('maps the barrel button and eraser end to erasing by default', () => {
    expect(INK_DEFAULT_PEN_BUTTONS.barrel).toBe('erase');
    expect(penButtonTool(INK_DEFAULT_PEN_BUTTONS.barrel)).toBe('eraser');
    expect(penButtonTool(INK_DEFAULT_PEN_BUTTONS.eraserEnd)).toBe('eraser');
  });

  it('is configurable to other tools', () => {
    expect(penButtonTool('lasso')).toBe('lasso');
    expect(penButtonTool('select')).toBe('select');
  });

  it('keeps the current tool when mapped to nothing', () => {
    expect(penButtonTool('none')).toBeNull();
  });
});
