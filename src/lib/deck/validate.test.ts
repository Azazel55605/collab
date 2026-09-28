import { describe, expect, it } from 'vitest';

import { DECK_LIMITS } from '../../types/deck';
import type { DeckDocument } from '../../types/deck';

import { buildFixtureDeck, buildScaleDeck } from './fixture';
import { isSafeVaultPath, parseDeck, serializeDeck, validateDeck } from './validate';

function issues(mutate: (deck: DeckDocument) => void): string[] {
  const deck = buildFixtureDeck();
  mutate(deck);
  const result = validateDeck(deck);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe('validateDeck', () => {
  it('accepts the fixture and a large generated deck', () => {
    expect(issues(() => {})).toEqual([]);
    expect(validateDeck(buildScaleDeck(300)).ok).toBe(true);
  });

  it('rejects non-finite and out-of-range geometry instead of clamping it', () => {
    expect(
      issues((deck) => (deck.slides['slide-5'].elements['s5-note'].frame!.x = Number.NaN)).join(),
    ).toMatch(/finite integer/);
    expect(
      issues((deck) => (deck.slides['slide-5'].elements['s5-note'].frame!.y = 10.5)).join(),
    ).toMatch(/finite integer/);
    expect(
      issues((deck) => (deck.slides['slide-5'].elements['s5-note'].frame!.x = 10_000_000)).join(),
    ).toMatch(/outside/);
    expect(
      issues(
        (deck) => (deck.slides['slide-3'].elements['s3-arrow'].frame!.rotation = 36_000),
      ).join(),
    ).toMatch(/rotation/);
  });

  it('rejects slide sizes outside PowerPoint’s range', () => {
    expect(
      issues((deck) => (deck.size = { preset: 'custom', width: 100, height: 54_000 })).join(),
    ).toMatch(/1\.\.56 inches/);
  });

  it('rejects executable and external links', () => {
    const withLink = (href: string) =>
      issues((deck) => {
        const body = deck.slides['slide-2'].elements['s2-body'];
        if (body.type !== 'text') throw new Error('fixture changed');
        body.text.content.paragraphs[0].runs[0] = {
          kind: 'text',
          text: 'x',
          link: { kind: 'url', href },
        };
      });
    expect(withLink('javascript:alert(1)').join()).toMatch(/http\(s\) or mailto/);
    expect(withLink('data:text/html,hi').join()).toMatch(/http\(s\) or mailto/);
    expect(withLink('https://example.com/ok')).toEqual([]);
  });

  it('rejects asset paths and media types that could escape the vault or execute', () => {
    const withAsset = (path: string, mediaType = 'image/png') =>
      issues((deck) => {
        const image = deck.slides['slide-3'].elements['s3-image'];
        if (image.type !== 'image') throw new Error('fixture changed');
        image.asset = { ...image.asset, path, mediaType };
      });
    expect(withAsset('https://example.com/a.png').join()).toMatch(/vault-relative/);
    expect(withAsset('../outside.png').join()).toMatch(/vault-relative/);
    expect(withAsset('/etc/passwd').join()).toMatch(/vault-relative/);
    expect(withAsset('assets/page.html', 'text/html').join()).toMatch(/media type/);
  });

  it('rejects group cycles, shared children, and excessive nesting', () => {
    expect(
      issues((deck) => {
        const group = deck.slides['slide-3'].elements['s3-group'];
        if (group.type === 'group') group.childIds.push('s3-group');
      }).join(),
    ).toMatch(/cycle|already belongs/);

    expect(
      issues((deck) => {
        const slide = deck.slides['slide-3'];
        const depth = DECK_LIMITS.groupDepth + 2;
        let child = 's3-card';
        slide.elementOrder = slide.elementOrder.filter((id) => id !== 's3-card');
        for (let level = 0; level < depth; level += 1) {
          const id = `nest-${level}`;
          slide.elements[id] = {
            id,
            type: 'group',
            frame: { x: 0, y: 0, width: 10, height: 10 },
            childIds: [child],
          };
          child = id;
        }
        slide.elementOrder.push(child);
      }).join(),
    ).toMatch(/nested deeper/);
  });

  it('rejects broken references between slides, layouts, masters, and themes', () => {
    expect(issues((deck) => (deck.slides['slide-2'].layoutId = 'nope')).join()).toMatch(
      /missing layout/,
    );
    expect(issues((deck) => (deck.layouts['layout-content'].masterId = 'nope')).join()).toMatch(
      /missing master/,
    );
    expect(issues((deck) => (deck.themeId = 'nope')).join()).toMatch(/missing theme/);
    expect(issues((deck) => deck.slideOrder.push('slide-1')).join()).toMatch(/twice/);
    expect(issues((deck) => deck.slideOrder.pop()).join()).toMatch(/not in slideOrder/);
  });

  it('requires a frame unless a placeholder supplies one', () => {
    expect(
      issues((deck) => (deck.slides['slide-5'].elements['s5-note'].frame = undefined)).join(),
    ).toMatch(/frame/);
    expect(
      issues((deck) => (deck.slides['slide-2'].elements['s2-title'].frame = undefined)),
    ).toEqual([]);
  });

  it('enforces text and table limits', () => {
    expect(
      issues((deck) => {
        const note = deck.slides['slide-5'].elements['s5-note'];
        if (note.type === 'text') {
          note.text.content.paragraphs[0].runs = [
            { kind: 'text', text: 'x'.repeat(DECK_LIMITS.textPerBody + 1) },
          ];
        }
      }).join(),
    ).toMatch(/characters/);
    expect(
      issues((deck) => {
        const table = deck.slides['slide-4'].elements['s4-table'];
        if (table.type === 'table') table.cells['r9:c1'] = table.cells['r1:c1'];
      }).join(),
    ).toMatch(/row and column/);
  });
});

describe('serialization', () => {
  it('round-trips through JSON and is byte-stable regardless of key order', () => {
    const deck = buildFixtureDeck();
    const json = serializeDeck(deck);
    const parsed = parseDeck(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serializeDeck(parsed.deck)).toBe(json);

    const reordered = JSON.parse(json) as DeckDocument;
    const slides = Object.fromEntries(Object.entries(reordered.slides).reverse());
    expect(serializeDeck({ ...reordered, slides })).toBe(json);
  });

  it('rejects oversized and malformed input before trusting it', () => {
    expect(parseDeck('{').ok).toBe(false);
    expect(parseDeck(' '.repeat(DECK_LIMITS.documentBytes + 1)).ok).toBe(false);
  });

  it('keeps a 300-slide deck compact', () => {
    const bytes = serializeDeck(buildScaleDeck(300)).length;
    expect(bytes).toBeLessThan(DECK_LIMITS.documentBytes / 8);
  });
});

describe('isSafeVaultPath', () => {
  it('accepts ordinary relative paths only', () => {
    expect(isSafeVaultPath('assets/a.png')).toBe(true);
    for (const bad of ['', '/abs', 'a/../b', 'C:\\x', 'file:///x', 'a//b', 'blob:x']) {
      expect(isSafeVaultPath(bad)).toBe(false);
    }
  });
});
