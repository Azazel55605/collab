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

function visit(value: unknown, found: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, found);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'asset' || key === 'preview') && isAsset(child))
      found.set(assetKey(child), child.path);
    else visit(child, found);
  }
}

/**
 * The cache identity of an asset: its path and, when recorded, its content
 * hash — so a file replaced at the same path (a refreshed preview, a
 * re-exported slide) is read again rather than served from cache.
 */
export function assetKey(asset: DeckAssetRef): string {
  return asset.sha256 ? `${asset.path}#${asset.sha256}` : asset.path;
}

function collect(deck: DeckDocument): Map<string, string> {
  const found = new Map<string, string>();
  visit(deck.themes, found);
  visit(deck.masters, found);
  visit(deck.layouts, found);
  visit(deck.slides, found);
  return found;
}

/** Every image the deck can draw, as cache key → vault path, sorted by key. */
export function collectDeckAssets(deck: DeckDocument): Array<{ key: string; path: string }> {
  return [...collect(deck)]
    .map(([key, path]) => ({ key, path }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Vault paths of every image the deck can draw, sorted and de-duplicated. */
export function collectDeckAssetPaths(deck: DeckDocument): string[] {
  return [...new Set(collect(deck).values())].sort();
}

/** Every image reference the deck holds (one per cache key), for export. */
export function collectDeckAssetRefs(deck: DeckDocument): DeckAssetRef[] {
  const refs = new Map<string, DeckAssetRef>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'asset' || key === 'preview') && isAsset(child))
        refs.set(assetKey(child), child);
      else walk(child);
    }
  };
  walk([deck.themes, deck.masters, deck.layouts, deck.slides]);
  return [...refs.values()];
}
