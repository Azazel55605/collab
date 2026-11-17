import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toggleComment } from '@codemirror/commands';
import { gotoLine, openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { listen } from '@tauri-apps/api/event';
import { Download, FileCode2, History, Save } from 'lucide-react';
import { toast } from 'sonner';

import { VersionHistoryModal } from '../components/collaboration/history/VersionHistoryModal';
import { CODE_BLOCK_LANGUAGE_OPTIONS } from '../components/editor/codeBlockUtils';
import { CodeEditorSurface } from '../components/editor/CodeEditorSurface';
import { DocumentStatusPill } from '../components/layout/DocumentStatusPill';
import {
  DocumentMoreMenu,
  DocumentTopBar,
  DocumentTopBarButton,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { Button } from '../components/ui/button';
import { DropdownMenuCheckboxItem, DropdownMenuItem } from '../components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { useCollabIdentity } from '../lib/collabIdentity';
import { saveConflictedCopy } from '../lib/conflictedCopy';
import { useDocumentViewKey } from '../lib/documentPaneContext';
import {
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  useDocumentSessionController,
} from '../lib/documentSessionController';
import { decodeSourceBuffer, encodeSourceBuffer, sourceLanguageForPath } from '../lib/sourceFiles';
import { tauriCommands } from '../lib/tauri';
import { createVaultClient } from '../lib/vaultClient';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { type NoteEditorViewState, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';

const PLAIN_TEXT_VALUE = 'plain-text';

export default function SourceView({ relativePath }: { relativePath: string }) {
  const vault = useVaultStore((state) => state.vault);
  const refreshFileTree = useVaultStore((state) => state.refreshFileTree);
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const viewKey = useDocumentViewKey(relativePath);
  const view = useRef<EditorView | null>(null);
  const initialPosition = useRef<NoteEditorViewState | undefined>(
    useEditorStore.getState().noteViewStates[viewKey],
  );
  const forceReloadPath = useEditorStore((state) => state.forceReloadPath);
  const indentStyle = useUiStore((state) => state.indentStyle);
  const tabWidth = useUiStore((state) => state.tabWidth);
  const { userId, userName } = useCollabIdentity();
  const defaultLanguage = sourceLanguageForPath(relativePath) ?? '';
  const [language, setLanguage] = useState(defaultLanguage);
  const [wrap, setWrap] = useState(defaultLanguage === '');
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [fallback, setFallback] = useState<{ reason: string; preview: string | null } | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const title = getDocumentBaseName(relativePath, 'Source file');

  const { controller, snapshot } = useDocumentSessionController<string>({
    serialize: (raw) => raw,
    deserialize: (raw) => raw,
    applyDocument: () => setFallback(null),
    write: async ({ content, expectedVersion, baseContent }) => {
      if (!client?.writeSourceFile || !expectedVersion)
        throw new Error('Reload the source file before saving.');
      const saved = await client.writeSourceFile(relativePath, content, expectedVersion);
      if (saved.conflict) {
        return {
          version: expectedVersion,
          conflict: {
            theirContent: saved.conflict.content,
            theirVersion: saved.conflict.version,
            baseContent,
          },
        };
      }
      if (saved.version !== expectedVersion) {
        void client.createSnapshot(relativePath, content, userId, userName).catch(() => {});
      }
      return { version: saved.version };
    },
  });

  // Source files use explicit saves and the shared save-before-navigation guard.
  useEffect(() => controller.pauseAutosave(), [controller]);

  useEffect(() => {
    if (!client) return;
    const readFile = client.readSourceFile?.bind(client);
    if (!readFile) {
      setFallback({ reason: 'Source editing is available in local vaults.', preview: null });
      return;
    }
    let active = true;
    let sequence = 0;
    const load = async (replace = false) => {
      const request = ++sequence;
      try {
        const result = await readFile(relativePath);
        if (!active || sequence !== request) return;
        if (result.content === null || result.version === null) {
          const reason = result.reason ?? 'Could not open the source file.';
          if (controller.getSnapshot().dirty || controller.getSnapshot().saving)
            setLoadWarning(reason);
          else setFallback({ reason, preview: result.preview });
          return;
        }
        setFallback(null);
        setLoadWarning(null);
        if (replace || controller.getSnapshot().currentContent === null) {
          controller.initialize(result.content, result.version, 'rest');
        } else {
          controller.handleRemoteCandidate({
            document: result.content,
            content: result.content,
            version: result.version,
            source: 'rest',
          });
        }
      } catch (error) {
        if (!active || sequence !== request) return;
        if (controller.getSnapshot().dirty || controller.getSnapshot().saving)
          setLoadWarning(String(error));
        else setFallback({ reason: String(error), preview: null });
      } finally {
        if (replace && active && sequence === request)
          useEditorStore.getState().setForceReloadPath(null);
      }
    };
    const restoring = forceReloadPath === relativePath;
    void load(restoring);
    const unlisten = listen<{ path: string; vaultPath?: string }>(
      'vault:file-modified',
      (event) => {
        if (
          event.payload.path === relativePath &&
          (!event.payload.vaultPath || event.payload.vaultPath === vault?.path)
        ) {
          void load(restoring);
        }
      },
    );
    return () => {
      active = false;
      void unlisten.then(
        (cleanup) => cleanup(),
        () => {},
      );
    };
  }, [client, controller, forceReloadPath, relativePath, vault?.path]);

  const readOnly = !!fallback || !client?.writeSourceFile;
  const buffer = useMemo(
    () => (snapshot.currentContent === null ? null : decodeSourceBuffer(snapshot.currentContent)),
    [snapshot.currentContent],
  );

  useEffect(() => {
    const store = useEditorStore.getState();
    if (snapshot.dirty) store.markDirty(relativePath);
    else if (snapshot.loadedVersion) store.markSaved(relativePath, snapshot.loadedVersion);
  }, [relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const saveCopy = useCallback(
    async (content: string) => {
      if (!client || client.kind !== 'local') return;
      await saveConflictedCopy(client, relativePath, content);
      await refreshFileTree();
    },
    [client, refreshFileTree, relativePath],
  );

  const status = useMemo(
    () => ({
      status: snapshot.status,
      snapshot: snapshot as DocumentSessionSnapshot<unknown>,
      controller: controller as DocumentSessionController<unknown>,
      readOnly,
      onSaveAsNew: saveCopy,
    }),
    [controller, readOnly, saveCopy, snapshot],
  );
  useDocumentStatusRegistration(relativePath, buffer ? status : null);

  const save = () => {
    if (readOnly) return;
    void controller
      .requestSave('manual')
      .catch((error) => toast.error('Could not save source file', { description: String(error) }));
  };

  const download = async () => {
    if (!client) return;
    try {
      const target = await tauriCommands.showDownloadDialog(title);
      if (target && client.saveSourceCopy) await client.saveSourceCopy(relativePath, target);
      else if (target)
        await tauriCommands.writeDownloadedBytes(target, await client.readAssetBytes(relativePath));
    } catch (error) {
      toast.error('Could not download source file', { description: String(error) });
    }
  };

  const captureView = useCallback(
    (editor: EditorView) => {
      const { anchor, head } = editor.state.selection.main;
      const line = editor.state.doc.lineAt(head);
      const column = head - line.from + 1;
      setPosition((previous) =>
        previous.line === line.number && previous.column === column
          ? previous
          : { line: line.number, column },
      );
      useEditorStore.getState().setNoteViewState(viewKey, {
        selectionAnchor: anchor,
        selectionHead: head,
        scrollTop: editor.scrollDOM.scrollTop,
        scrollLeft: editor.scrollDOM.scrollLeft,
      });
    },
    [viewKey],
  );

  const onReady = useCallback((editor: EditorView) => {
    view.current = editor;
    const previous = initialPosition.current;
    initialPosition.current = undefined;
    if (!previous) return;
    const limit = editor.state.doc.length;
    editor.dispatch({
      selection: {
        anchor: Math.min(previous.selectionAnchor, limit),
        head: Math.min(previous.selectionHead, limit),
      },
    });
    editor.requestMeasure({
      read: () => previous,
      write: (value) => {
        editor.scrollDOM.scrollTop = value.scrollTop;
        editor.scrollDOM.scrollLeft = value.scrollLeft ?? 0;
      },
    });
  }, []);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.altKey) {
          event.preventDefault();
          save();
        }
      }}
    >
      <DocumentTopBar
        title={title}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<FileCode2 />}
        status={
          buffer && !fallback && <DocumentStatusPill status={snapshot.status} hideWhenSaved />
        }
        meta={
          <DocumentMoreMenu label="Source file actions">
            <DropdownMenuItem onSelect={() => void download()}>
              <Download /> Download original
            </DropdownMenuItem>
            {buffer && !fallback && (
              <>
                <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
                  Wrap lines
                </DropdownMenuCheckboxItem>
                <DropdownMenuItem
                  onSelect={() => {
                    if (view.current) toggleComment(view.current);
                  }}
                >
                  Toggle comment
                </DropdownMenuItem>
                {snapshot.dirty && (
                  <DropdownMenuItem
                    onSelect={() => {
                      if (snapshot.currentContent !== null)
                        void saveCopy(snapshot.currentContent)
                          .then(() => toast.success('Source draft copied'))
                          .catch((error) =>
                            toast.error('Could not copy source draft', {
                              description: String(error),
                            }),
                          );
                    }}
                  >
                    Save draft as copy
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                  <History /> Version history
                </DropdownMenuItem>
              </>
            )}
          </DocumentMoreMenu>
        }
        secondary={
          buffer &&
          !fallback && (
            <>
              <DocumentTopBarButton
                onClick={save}
                disabled={!snapshot.dirty || snapshot.saving || snapshot.conflicted}
              >
                <Save /> Save
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => {
                  if (view.current) openSearchPanel(view.current);
                }}
              >
                Find / replace
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => {
                  if (view.current) gotoLine(view.current);
                }}
              >
                Go to line
              </DocumentTopBarButton>
            </>
          )
        }
      />
      {fallback ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
          <p role="status" className="text-sm text-muted-foreground">
            {fallback.reason}
          </p>
          <Button className="self-start" variant="outline" onClick={() => void download()}>
            <Download /> Download original
          </Button>
          {fallback.preview && (
            <pre className="min-h-0 overflow-auto whitespace-pre-wrap break-all rounded-md border p-3 text-sm">
              {fallback.preview}
            </pre>
          )}
        </div>
      ) : buffer ? (
        <>
          {loadWarning && (
            <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
              {loadWarning} Your draft is still open.
            </p>
          )}
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <CodeEditorSurface
                value={buffer.text}
                language={language}
                wrap={wrap}
                onReady={onReady}
                onViewChange={captureView}
                onChange={(text) => controller.markLocalChange(encodeSourceBuffer(text, buffer))}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1 text-xs text-muted-foreground">
            <span>
              Ln {position.line}, Col {position.column}
            </span>
            <span>
              {indentStyle === 'tabs' ? 'Tabs' : 'Spaces'} {tabWidth}
            </span>
            <span>UTF-8{buffer.bom ? ' BOM' : ''}</span>
            <span>{buffer.crlf ? 'CRLF' : 'LF'}</span>
            <Select
              value={language || PLAIN_TEXT_VALUE}
              onValueChange={(value) => setLanguage(value === PLAIN_TEXT_VALUE ? '' : value)}
            >
              <SelectTrigger aria-label="Source language" className="ml-auto h-7 min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODE_BLOCK_LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.label} value={option.value || PLAIN_TEXT_VALUE}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      ) : (
        <div role="status" className="p-4 text-sm text-muted-foreground">
          Opening source file…
        </div>
      )}
      {historyOpen && (
        <VersionHistoryModal open relativePath={relativePath} onOpenChange={setHistoryOpen} />
      )}
    </div>
  );
}
