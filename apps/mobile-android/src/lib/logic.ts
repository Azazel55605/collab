import type { LogicDiagramDocument } from '../../../../src/types/logicDiagram';
import { parseLogicDiagramDocument } from '../../../../src/types/logicDiagram';
import { fileEntryExtension } from './format';
import {
  type HostedFileEntry,
  type HostedTextDocument,
  readHostedDocument,
  replicaCacheDocument,
  replicaReadCachedDocument,
  writeHostedDocument,
} from '../mobileTauri';

export type { LogicDiagramDocument };

export function isLogicFile(file: HostedFileEntry): boolean {
  if (file.kind !== 'document') return false;
  return fileEntryExtension(file) === 'logic';
}

export function parseLogicContent(content: string): LogicDiagramDocument {
  if (!content.trim()) return parseLogicDiagramDocument('{"kind":"logic-diagram","nodes":[],"wires":[]}');
  return parseLogicDiagramDocument(content);
}

export function serializeLogicDocument(logic: LogicDiagramDocument): string {
  return JSON.stringify(logic, null, 2);
}

export async function saveLogicDocument(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  logic: LogicDiagramDocument,
): Promise<HostedTextDocument> {
  const content = serializeLogicDocument(logic);
  const document = await writeHostedDocument(
    serverUrl,
    vaultId,
    file.id,
    file.revisionSequence ?? 0,
    content,
  );
  await replicaCacheDocument(serverUrl, vaultId, file.id, content).catch(() => {});
  return document;
}

export interface LoadedLogicDocument {
  file: HostedFileEntry;
  logic: LogicDiagramDocument;
  content: string;
  source: 'network' | 'cache';
}

export async function readLogicDocument(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  connected: boolean,
): Promise<LoadedLogicDocument> {
  if (connected) {
    try {
      const document = await readHostedDocument(serverUrl, vaultId, file.id);
      void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
      return {
        file: document.file,
        logic: parseLogicContent(document.content),
        content: document.content,
        source: 'network',
      };
    } catch (error) {
      const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id).catch(() => null);
      if (cached !== null) {
        return { file, logic: parseLogicContent(cached), content: cached, source: 'cache' };
      }
      throw error;
    }
  }

  const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id);
  if (cached === null) {
    throw new Error('This logic diagram is not cached for offline reading.');
  }
  return { file, logic: parseLogicContent(cached), content: cached, source: 'cache' };
}
