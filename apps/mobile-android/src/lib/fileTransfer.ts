import { parseLogicDiagramDocument } from '../../../../src/types/logicDiagram';
import type { HostedFileEntry, HostedVault } from '../mobileTauri';
import {
  createHostedDocument,
  downloadHostedEntry,
  downloadHostedVault,
  readFileForUpload,
  showMobileOpenFiles,
  showMobileSaveDialog,
  uploadHostedFile,
} from '../mobileTauri';

export const MOBILE_UPLOAD_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'svg', 'pdf', 'md', 'markdown', 'canvas', 'kanban', 'logic',
];

function extension(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLowerCase();
}

function decodeUtf8Base64(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function documentTypeForExtension(ext: string): 'note' | 'kanban' | 'canvas' {
  if (ext === 'kanban') return 'kanban';
  if (ext === 'canvas') return 'canvas';
  return 'note';
}

function validateTextDocument(content: string, ext: string): void {
  if (ext === 'logic') {
    parseLogicDiagramDocument(content);
    return;
  }
  if (ext !== 'canvas' && ext !== 'kanban') return;
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`The .${ext} file must contain a JSON object.`);
  }
  if (ext === 'canvas' && (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges))) {
    throw new Error('The .canvas file must contain nodes and edges arrays.');
  }
  if (ext === 'kanban' && !Array.isArray(parsed.columns)) {
    throw new Error('The .kanban file must contain a columns array.');
  }
}

export interface MobileTransferResult {
  completed: HostedFileEntry[];
  failed: { name: string; error: string }[];
}

export async function pickAndUploadFiles(
  serverUrl: string,
  vault: HostedVault,
  parentId: string | null,
): Promise<MobileTransferResult> {
  const sourcePaths = await showMobileOpenFiles(MOBILE_UPLOAD_EXTENSIONS);
  const result: MobileTransferResult = { completed: [], failed: [] };
  for (const sourcePath of sourcePaths) {
    const fallbackName = sourcePath.split(/[/\\]/).pop() ?? sourcePath;
    try {
      const ext = extension(fallbackName);
      const binary = ext === 'pdf' || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext);
      if (binary) {
        if (!vault.capabilities.includes('file.uploadAsset')) {
          throw new Error('You do not have permission to upload assets.');
        }
        result.completed.push(await uploadHostedFile(serverUrl, vault.id, parentId, sourcePath));
        continue;
      }
      if (!vault.capabilities.includes('file.create')) {
        throw new Error('You do not have permission to create documents.');
      }
      const payload = await readFileForUpload(sourcePath);
      const content = decodeUtf8Base64(payload.contentBase64);
      const payloadExt = extension(payload.name);
      validateTextDocument(content, payloadExt);
      result.completed.push(await createHostedDocument(
        serverUrl,
        vault.id,
        parentId,
        payload.name,
        documentTypeForExtension(payloadExt),
        content,
      ));
    } catch (error) {
      result.failed.push({ name: fallbackName, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export async function downloadEntry(
  serverUrl: string,
  vault: HostedVault,
  entry: HostedFileEntry,
): Promise<boolean> {
  if (!vault.capabilities.includes('vault.read')) {
    throw new Error('You do not have permission to download files from this vault.');
  }
  const defaultName = entry.kind === 'folder' ? `${entry.name}.zip` : entry.name;
  const destination = await showMobileSaveDialog(defaultName);
  if (!destination) return false;
  await downloadHostedEntry(serverUrl, vault.id, entry.id, entry.kind === 'folder', destination);
  return true;
}

export async function downloadEntireVault(serverUrl: string, vault: HostedVault): Promise<boolean> {
  if (!vault.capabilities.includes('vault.export')) {
    throw new Error('You do not have permission to export this vault.');
  }
  const safeName = vault.name.replace(/[^a-zA-Z0-9._ -]+/g, '_').trim() || 'vault';
  const destination = await showMobileSaveDialog(`${safeName}.zip`);
  if (!destination) return false;
  await downloadHostedVault(serverUrl, vault.id, destination);
  return true;
}

export function normalizedNoteName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a note name.');
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}
