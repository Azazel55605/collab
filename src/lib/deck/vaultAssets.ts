/**
 * The vault I/O behind Phase 4: writing generated images (linked-document
 * previews, slide exports, pasted pictures) and taking `.sheet` snapshots.
 *
 * Kept apart from the pure domain so everything else in `lib/deck` stays
 * framework- and IPC-free.
 */
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import type { NoteFile, VaultMeta } from '../../types/vault';
import { parseSheetDocument } from '../sheet/document';
import { buildSheetFormulaRequest } from '../sheet/useSheetFormulaEngine';
import { tauriCommands } from '../tauri';
import type { VaultClient } from '../vaultClient';

import { readSheetRange } from './sheetSnapshot';
import type { SheetRangeReference, SnapshotValue } from './sheetSnapshot';

/** Every file path in a (possibly nested) listing. */
export function flattenVaultPaths(files: NoteFile[]): string[] {
  const out: string[] = [];
  const visit = (entries: NoteFile[]) => {
    for (const entry of entries) {
      if (entry.isFolder) visit(entry.children ?? []);
      else out.push(entry.relativePath);
    }
  };
  visit(files);
  return out;
}

/**
 * Writes an image into the vault. With `replace`, an existing file at that
 * path is replaced in place — how slide exports and previews stay at stable
 * paths notes can link to. Without it, a free name next to `name` is chosen.
 * Returns the vault-relative path written.
 */
export async function writeVaultImage(
  client: VaultClient,
  vault: VaultMeta,
  folder: string,
  name: string,
  dataUrl: string,
  replace: boolean,
): Promise<string> {
  if (client.capabilities.nativeFilesystem) {
    return tauriCommands.saveGeneratedImage(
      vault.path,
      folder ? `${folder}/${name}` : name,
      dataUrl,
      replace,
      name,
    );
  }
  const importer = client.runtime.externalAssetImport;
  if (!importer) throw new Error('This vault cannot store images.');
  const target = folder ? `${folder}/${name}` : name;
  if (replace) {
    const existing = flattenVaultPaths(await client.listFiles()).find(
      (path) => path.toLowerCase() === target.toLowerCase(),
    );
    // Removing without rewriting references keeps every link pointing at the path.
    if (existing) await client.deletePermanently(existing, false);
  }
  return importer.importData(dataUrl, name, folder);
}

/**
 * Reads a `.sheet` range once, with formulas evaluated by the spreadsheet's
 * own engine. This is the only way a deck reads a workbook, and it runs only
 * when a person links or refreshes.
 */
export async function takeSheetSnapshot(
  client: VaultClient,
  path: string,
  reference: SheetRangeReference,
  timeZone: string,
): Promise<SnapshotValue[][]> {
  const { content } = await client.readDocument(path);
  const document = parseSheetDocument(content, path.split('/').pop() ?? 'Workbook');
  let computed: SheetFormulaValueMap = new Map();
  const hasFormula = document.worksheets.some((worksheet) =>
    Object.values(worksheet.cells).some((cell) => Boolean(cell.formula)),
  );
  if (hasFormula) {
    const runtimeId = `deck-snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
      const response = await tauriCommands.sheetFormulaEvaluate(
        buildSheetFormulaRequest(document, runtimeId, timeZone),
      );
      computed = new Map(
        response.cells.map((cell) => [
          sheetFormulaResultKey(cell.worksheetId, cell.rowId, cell.columnId),
          cell.value,
        ]),
      );
    } finally {
      void tauriCommands.sheetFormulaRelease(runtimeId).catch(() => {});
    }
  }
  return readSheetRange(document, reference, computed).grid;
}
