import type * as d3 from 'd3';

import type { NoteMetadata } from '../../types/note';

export const GRAPH_LINK_LIMIT = 5000;

export interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  title: string;
  relativePath: string;
  tags: string[];
  linkCount: number;
}

export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

function normalizeGraphLinkTarget(value: string) {
  return value.trim().split(/[?#]/, 1)[0]?.replace(/\\/g, '/').toLowerCase() ?? '';
}

function stripMarkdownExtension(relativePath: string) {
  return relativePath.replace(/\.md$/i, '');
}

function buildUniqueLookup(entries: Array<readonly [string, string]>) {
  const counts = new Map<string, { path: string; count: number }>();

  for (const [rawKey, path] of entries) {
    const key = normalizeGraphLinkTarget(rawKey);
    if (!key) continue;
    const existing = counts.get(key);
    if (!existing) {
      counts.set(key, { path, count: 1 });
      continue;
    }
    if (existing.path !== path) existing.count += 1;
  }

  return new Map(
    Array.from(counts.entries())
      .filter(([, value]) => value.count === 1)
      .map(([key, value]) => [key, value.path] as const),
  );
}

export function createGraphDataBuilder() {
  let lookupRevision = '';
  const adjacency = new Map<string, { source: string; links: GraphLink[] }>();
  const previousNodes = new Map<string, GraphNode>();
  let previous: { nodes: GraphNode[]; links: GraphLink[] } | undefined;
  return (notes: NoteMetadata[]) => {
    const revision = JSON.stringify(notes.slice(0, 500).map((n) => [n.relativePath, n.title]));
    if (lookupRevision !== revision) {
      adjacency.clear();
      lookupRevision = revision;
    }

    const visibleNotes = notes.slice(0, 500);
    const exactRelativePathToPath = new Map<string, string>();
    const exactRelativeStemToPath = new Map<string, string>();

    for (const note of visibleNotes) {
      exactRelativePathToPath.set(normalizeGraphLinkTarget(note.relativePath), note.relativePath);
      exactRelativeStemToPath.set(
        normalizeGraphLinkTarget(stripMarkdownExtension(note.relativePath)),
        note.relativePath,
      );
    }

    const basenameToPath = buildUniqueLookup(
      visibleNotes.map(
        (note) => [note.relativePath.split('/').pop() ?? '', note.relativePath] as const,
      ),
    );
    const stemToPath = buildUniqueLookup(
      visibleNotes.map(
        (note) =>
          [
            stripMarkdownExtension(note.relativePath.split('/').pop() ?? ''),
            note.relativePath,
          ] as const,
      ),
    );
    const titleToPath = buildUniqueLookup(
      visibleNotes.map((note) => [note.title, note.relativePath] as const),
    );

    const nodes: GraphNode[] = visibleNotes.map((n) => {
      const old = previousNodes.get(n.relativePath);
      if (
        old &&
        old.title === n.title &&
        old.tags.join('\0') === n.tags.join('\0') &&
        old.linkCount === n.wikilinksOut.length
      )
        return old;
      const node: GraphNode = {
        id: n.relativePath,
        title: n.title,
        relativePath: n.relativePath,
        tags: n.tags,
        linkCount: n.wikilinksOut.length,
      };
      previousNodes.set(n.relativePath, node);
      return node;
    });

    const nodeIds = new Set(nodes.map((node) => node.id));
    const linkKeys = new Set<string>();
    const links: GraphLink[] = [];

    for (const path of previousNodes.keys())
      if (!nodeIds.has(path)) {
        previousNodes.delete(path);
        adjacency.delete(path);
      }
    for (const note of visibleNotes) {
      if (links.length >= GRAPH_LINK_LIMIT) break;
      const source = JSON.stringify(note.wikilinksOut);
      const cached = adjacency.get(note.relativePath);
      if (cached?.source === source) {
        links.push(...cached.links.slice(0, GRAPH_LINK_LIMIT - links.length));
        continue;
      }
      const sourceLinks: GraphLink[] = [];
      for (const wikilink of note.wikilinksOut) {
        const normalizedTarget = normalizeGraphLinkTarget(wikilink);
        if (!normalizedTarget) continue;

        const targetPath =
          exactRelativePathToPath.get(normalizedTarget) ??
          exactRelativeStemToPath.get(normalizedTarget) ??
          basenameToPath.get(normalizedTarget) ??
          stemToPath.get(normalizedTarget) ??
          titleToPath.get(normalizedTarget);

        if (targetPath && targetPath !== note.relativePath && nodeIds.has(targetPath)) {
          const linkKey = `${note.relativePath}->${targetPath}`;
          if (linkKeys.has(linkKey)) continue;
          linkKeys.add(linkKey);
          sourceLinks.push({ source: note.relativePath, target: targetPath });
        }
      }
      adjacency.set(note.relativePath, { source, links: sourceLinks });
      links.push(...sourceLinks.slice(0, GRAPH_LINK_LIMIT - links.length));
    }
    if (
      previous &&
      previous.nodes.length === nodes.length &&
      previous.links.length === links.length &&
      nodes.every((node, i) => node === previous!.nodes[i]) &&
      links.every((link, i) => link === previous!.links[i])
    )
      return previous;
    previous = { nodes, links };
    return previous;
  };
}
export function buildGraphData(notes: NoteMetadata[]) {
  return createGraphDataBuilder()(notes);
}
