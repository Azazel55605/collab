import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedFileEntry } from '../mobileTauri';

import { isCanvasFile, parseCanvasContent, readCanvasDocument } from './canvas';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const SERVER = 'https://collab.example.com';
const VAULT = 'v1';

const CANVAS_FILE: HostedFileEntry = {
  id: 'canvas-1',
  parentId: null,
  name: 'Map.canvas',
  relativePath: 'Map.canvas',
  kind: 'document',
  documentType: 'canvas',
  state: 'active',
  updatedAt: null,
  sizeBytes: 10,
  contentHash: 'hash',
  revisionSequence: 4,
};

const CONTENT = JSON.stringify({
  nodes: [
    {
      id: 'n1',
      type: 'process',
      title: 'Plan work',
      body: 'Break the feature into slices.',
      position: { x: 100, y: 200 },
      width: 240,
      height: 140,
      planning: { status: 'in_progress', priority: 'high', tags: ['mobile'] },
    },
    {
      id: 'n2',
      type: 'file',
      relativePath: 'Docs/spec.pdf',
      description: 'Supporting PDF',
      position: { x: 480, y: 220 },
      width: 220,
      height: 120,
    },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2', lineStyle: 'dashed' }],
  viewport: { x: -30, y: 12, zoom: 0.9 },
});

describe('mobile canvas documents', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('recognizes canvas documents', () => {
    expect(isCanvasFile(CANVAS_FILE)).toBe(true);
    expect(isCanvasFile({ ...CANVAS_FILE, documentType: null, name: 'Sketch.canvas' })).toBe(true);
    expect(isCanvasFile({ ...CANVAS_FILE, documentType: 'note', name: 'Note.md' })).toBe(false);
    expect(isCanvasFile({ ...CANVAS_FILE, kind: 'asset', name: 'Sketch.canvas' })).toBe(false);
  });

  it('parses and normalizes canvas content', () => {
    const parsed = parseCanvasContent(CONTENT);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.viewport.zoom).toBe(0.9);

    const fallback = parseCanvasContent(JSON.stringify({ nodes: [{ type: 'text' }], edges: [{}] }));
    expect(fallback.nodes[0]).toMatchObject({
      id: 'node-1',
      position: { x: 0, y: 0 },
      width: 220,
      height: 132,
    });
    expect(fallback.edges).toEqual([]);
  });

  it('reads a canvas online and warms the replica cache', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') {
        return Promise.resolve({
          file: { ...CANVAS_FILE, currentRevision: { sequence: 4 } },
          content: CONTENT,
        });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readCanvasDocument(SERVER, VAULT, CANVAS_FILE, true);
    expect(loaded.source).toBe('network');
    expect(loaded.canvas.nodes).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_document',
      expect.objectContaining({ fileId: 'canvas-1' }),
    );
  });

  it('falls back to the cached canvas when offline', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'replica_read_cached_document') return Promise.resolve(CONTENT);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readCanvasDocument(SERVER, VAULT, CANVAS_FILE, false);
    expect(loaded.source).toBe('cache');
    expect(loaded.canvas.edges[0].source).toBe('n1');
  });
});
