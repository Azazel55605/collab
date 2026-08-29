import type { CanvasData, CanvasEdge, CanvasNode } from '../../../../src/types/canvas';
import {
  type HostedFileEntry,
  readHostedDocument,
  replicaCacheDocument,
  replicaReadCachedDocument,
} from '../mobileTauri';

export type { CanvasData, CanvasEdge, CanvasNode };

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 132;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeNode(value: unknown, index: number): CanvasNode | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = typeof record.type === 'string' ? record.type : 'text';
  const position = asRecord(record.position);
  return {
    ...record,
    id: typeof record.id === 'string' && record.id ? record.id : `node-${index + 1}`,
    type,
    position: {
      x: finiteNumber(position?.x, index * 260),
      y: finiteNumber(position?.y, index * 160),
    },
    width: finiteNumber(record.width, DEFAULT_NODE_WIDTH),
    height: finiteNumber(record.height, DEFAULT_NODE_HEIGHT),
  } as CanvasNode;
}

function normalizeEdge(value: unknown, index: number): CanvasEdge | null {
  const record = asRecord(value);
  if (!record || typeof record.source !== 'string' || typeof record.target !== 'string')
    return null;
  return {
    ...record,
    id: typeof record.id === 'string' && record.id ? record.id : `edge-${index + 1}`,
    source: record.source,
    target: record.target,
  } as CanvasEdge;
}

export function isCanvasFile(file: HostedFileEntry): boolean {
  if (file.kind !== 'document') return false;
  if (file.documentType === 'canvas') return true;
  return /\.canvas$/i.test(file.name);
}

export function parseCanvasContent(content: string): CanvasData {
  if (!content.trim()) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const parsed = JSON.parse(content) as unknown;
  const record = asRecord(parsed);
  if (!record) throw new Error('The canvas document is not a JSON object.');
  const viewport = asRecord(record.viewport);
  return {
    nodes: Array.isArray(record.nodes)
      ? record.nodes.map(normalizeNode).filter((node): node is CanvasNode => node !== null)
      : [],
    edges: Array.isArray(record.edges)
      ? record.edges.map(normalizeEdge).filter((edge): edge is CanvasEdge => edge !== null)
      : [],
    viewport: {
      x: finiteNumber(viewport?.x, 0),
      y: finiteNumber(viewport?.y, 0),
      zoom: finiteNumber(viewport?.zoom, 1),
    },
  };
}

export interface LoadedCanvasDocument {
  file: HostedFileEntry;
  canvas: CanvasData;
  content: string;
  source: 'network' | 'cache';
}

export async function readCanvasDocument(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  connected: boolean,
): Promise<LoadedCanvasDocument> {
  if (connected) {
    try {
      const document = await readHostedDocument(serverUrl, vaultId, file.id);
      void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
      return {
        file: document.file,
        canvas: parseCanvasContent(document.content),
        content: document.content,
        source: 'network',
      };
    } catch (error) {
      const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id).catch(() => null);
      if (cached !== null) {
        return { file, canvas: parseCanvasContent(cached), content: cached, source: 'cache' };
      }
      throw error;
    }
  }

  const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id);
  if (cached === null) {
    throw new Error('This canvas is not cached for offline reading.');
  }
  return { file, canvas: parseCanvasContent(cached), content: cached, source: 'cache' };
}
