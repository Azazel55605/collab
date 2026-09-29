/**
 * Keeps the Rust validator's fixture identical to the TypeScript one, so the
 * client and the server are always tested against the same deck.
 *
 * Regenerate with `COLLAB_UPDATE_FIXTURES=1 pnpm vitest run src/lib/deck/sharedFixture.test.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildFixtureDeck } from './fixture';
import { serializeDeck } from './validate';

const FIXTURE = resolve(__dirname, '../../../crates/collab-documents/fixtures/deck-fixture.deck');

describe('shared deck fixture', () => {
  it('matches the fixture collab-documents validates', () => {
    const expected = serializeDeck(buildFixtureDeck());
    if (process.env.COLLAB_UPDATE_FIXTURES) writeFileSync(FIXTURE, expected);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(expected);
  });
});
