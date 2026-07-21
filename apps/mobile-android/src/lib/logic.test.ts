import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import type { HostedFileEntry } from '../mobileTauri';
import { isLogicFile, parseLogicContent, readLogicDocument, saveLogicDocument } from './logic';

const SERVER = 'https://collab.example.com';
const VAULT = 'v1';

const LOGIC_FILE: HostedFileEntry = {
  id: 'logic-1',
  parentId: null,
  name: 'Adder.logic',
  relativePath: 'Adder.logic',
  kind: 'document',
  documentType: null,
  state: 'active',
  updatedAt: null,
  sizeBytes: 10,
  contentHash: 'hash',
  revisionSequence: 4,
};

const CONTENT = JSON.stringify({
  kind: 'logic-diagram',
  nodes: [
    { id: 'a', kind: 'input', label: 'A', value: true, position: { x: 0, y: 0 } },
    { id: 'b', kind: 'input', label: 'B', value: false, position: { x: 0, y: 120 } },
    { id: 'and', kind: 'and', position: { x: 220, y: 60 } },
    { id: 'out', kind: 'output', label: 'Carry', position: { x: 440, y: 60 } },
  ],
  wires: [
    { id: 'w1', source: 'a', target: 'and', targetHandle: 'in-a' },
    { id: 'w2', source: 'b', target: 'and', targetHandle: 'in-b' },
    { id: 'w3', source: 'and', target: 'out' },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
});

describe('mobile logic documents', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('recognizes logic documents by extension', () => {
    expect(isLogicFile(LOGIC_FILE)).toBe(true);
    expect(isLogicFile({ ...LOGIC_FILE, name: 'Sketch.logic' })).toBe(true);
    expect(isLogicFile({ ...LOGIC_FILE, name: 'Sketch', relativePath: 'Diagrams/Sketch.logic', documentType: 'note' })).toBe(true);
    expect(isLogicFile({ ...LOGIC_FILE, name: 'Note.md', relativePath: 'Note.md' })).toBe(false);
    expect(isLogicFile({ ...LOGIC_FILE, kind: 'asset', name: 'x.logic' })).toBe(false);
  });

  it('parses and normalizes logic content through the shared schema helper', () => {
    const parsed = parseLogicContent(CONTENT);
    expect(parsed.kind).toBe('logic-diagram');
    expect(parsed.schemaVersion).toBe(6);
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.wires[0].targetHandle).toBe('in-a');
  });

  it('preserves rotated schematic symbols for the mobile viewer', () => {
    const parsed = parseLogicContent(JSON.stringify({
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [{ id: 'r1', kind: 'resistor', position: { x: 0, y: 0 }, rotation: 270 }],
      wires: [],
    }));

    expect(parsed.nodes[0]).toMatchObject({ kind: 'resistor', rotation: 270 });
  });

  it('reads logic online and warms the replica cache', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') {
        return Promise.resolve({ file: { ...LOGIC_FILE, currentRevision: { sequence: 4 } }, content: CONTENT });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readLogicDocument(SERVER, VAULT, LOGIC_FILE, true);
    expect(loaded.source).toBe('network');
    expect(loaded.logic.nodes).toHaveLength(4);
    expect(invoke).toHaveBeenCalledWith('replica_cache_document', expect.objectContaining({ fileId: 'logic-1' }));
  });

  it('falls back to the cached logic diagram when offline', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'replica_read_cached_document') return Promise.resolve(CONTENT);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readLogicDocument(SERVER, VAULT, LOGIC_FILE, false);
    expect(loaded.source).toBe('cache');
    expect(loaded.logic.wires[2].source).toBe('and');
  });

  it('writes the current revision and refreshes the offline cache', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') {
        return Promise.resolve({
          file: {
            ...LOGIC_FILE,
            currentRevision: { sequence: 5, contentHash: 'saved-hash', sizeBytes: CONTENT.length },
          },
          content: CONTENT,
        });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const logic = parseLogicContent(CONTENT);
    const saved = await saveLogicDocument(SERVER, VAULT, LOGIC_FILE, logic);

    expect(saved.file.revisionSequence).toBe(5);
    expect(invoke).toHaveBeenCalledWith('hosted_vault_request', expect.objectContaining({
      method: 'POST',
      path: `/api/v1/vaults/${VAULT}/files/${LOGIC_FILE.id}/revisions`,
      body: expect.objectContaining({ expectedRevisionSequence: 4 }),
    }));
    expect(invoke).toHaveBeenCalledWith('replica_cache_document', expect.objectContaining({
      fileId: LOGIC_FILE.id,
      content: expect.stringContaining('"schemaVersion": 6'),
    }));
  });
});
