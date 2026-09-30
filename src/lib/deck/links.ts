import type { DeckLink } from '../../types/deck';

/**
 * A web address as a deck link, or null when it is not one a deck may hold.
 * A bare domain gets `https://`; only `http(s)` and `mailto` are accepted, the
 * same rule `validateDeck` enforces.
 */
export function parseLinkAddress(input: string): DeckLink | null {
  const value = input.trim();
  if (!value) return null;
  let href = value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) href = `mailto:${value}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) href = `https://${value}`;
  try {
    const url = new URL(href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
  } catch {
    return null;
  }
  return href.length <= 2_048 ? { kind: 'url', href } : null;
}
