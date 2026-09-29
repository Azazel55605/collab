/**
 * Asset discovery for rendering: every vault image a deck draws, wherever it
 * is referenced — image elements, image fills and backgrounds, and embed
 * previews. Mirrors the field roles `collect_deck_references` uses on the
 * Rust side, so the renderer and reference tracking agree on what a deck uses.
 */
import type { DeckAssetRef, DeckDocument } from '../../types/deck';

function isAsset(value: unknown): value is DeckAssetRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DeckAssetRef).path === 'string' &&
    typeof (value as DeckAssetRef).mediaType === 'string'
  );
}

function visit(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, found);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'asset' || key === 'preview') && isAsset(child)) found.add(child.path);
    else visit(child, found);
  }
}

/** Vault paths of every image the deck can draw, sorted and de-duplicated. */
export function collectDeckAssetPaths(deck: DeckDocument): string[] {
  const found = new Set<string>();
  visit(deck.themes, found);
  visit(deck.masters, found);
  visit(deck.layouts, found);
  visit(deck.slides, found);
  return [...found].sort();
}
