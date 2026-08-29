import { useEffect, useMemo, useRef, useState } from 'react';

import { Minus, PenTool, Plus } from 'lucide-react';

import {
  type Dimensions,
  EMPTY_SIZE,
  fitWithin,
  getWorkspaceDimensions,
  scaleDimensions,
} from '../components/image/ImageViewUtils';
import { SvgEditStage, type SvgTool } from '../components/image/SvgEditStage';
import { SvgPropertiesPanel } from '../components/image/SvgPropertiesPanel';
import { SvgToolbar } from '../components/image/SvgToolbar';
import { useSvgSession } from '../components/image/useSvgSession';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import { Button } from '../components/ui/button';
import { findNode, removeNode, reorderNode, serializeScene, updateNode } from '../lib/svgDocument';
import { cn } from '../lib/utils';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import type { SvgNode, SvgScene } from '../types/svg';

interface Props {
  relativePath: string | null;
}

type SvgMode = 'view' | 'edit';

function useElementSize<T extends HTMLElement>(ref: { current: T | null }) {
  const [size, setSize] = useState<Dimensions>(EMPTY_SIZE);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Vector editor for `.svg` files. Opened for `.svg` in place of the raster
 * {@link ImageView}, it reuses the shared document top bar / viewport shell but
 * edits the SVG's own vector content: select/move/resize/restyle existing
 * primitives (stage 1) and draw new rect/ellipse/line/text primitives (stage 2).
 * Non-modeled content (defs, gradients, groups, …) is preserved untouched.
 */
export default function SvgVectorView({ relativePath }: Props) {
  const { vault } = useVaultStore();
  const { markDirty, markSaved } = useEditorStore();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportSize = useElementSize(viewportRef);

  const {
    scene,
    setScene,
    loading,
    error,
    dirty,
    saving,
    status,
    readOnly,
    assetBacked,
    save,
    loadRemote,
    keepLocal,
  } = useSvgSession({
    vault,
    relativePath,
    markDirty,
    markSaved,
  });

  const documentStatus = useMemo(
    () => (!readOnly ? { status, onLoadRemote: loadRemote, onKeepLocal: keepLocal } : null),
    [keepLocal, loadRemote, readOnly, status],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  const [mode, setMode] = useState<SvgMode>('view');
  const [tool, setTool] = useState<SvgTool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  // Reset transient UI when switching files.
  useEffect(() => {
    setMode('view');
    setTool('select');
    setSelectedId(null);
    setZoomPercent(100);
  }, [relativePath]);

  // Viewers can never enter edit mode.
  useEffect(() => {
    if (readOnly && mode === 'edit') setMode('view');
  }, [readOnly, mode]);

  const intrinsic = scene
    ? { width: scene.viewBox.width, height: scene.viewBox.height }
    : EMPTY_SIZE;
  const baseFitted = fitWithin(viewportSize, intrinsic);
  const displayDimensions = scaleDimensions(baseFitted, zoomPercent / 100);
  const workspaceDimensions = getWorkspaceDimensions(viewportSize, displayDimensions);

  const selectedNode = scene && selectedId ? findNode(scene, selectedId) : null;

  const changeSelected = (updater: (node: SvgNode) => SvgNode) => {
    if (!selectedId) return;
    setScene((current) => (current ? updateNode(current, selectedId, updater) : current));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setScene((current) => (current ? removeNode(current, selectedId) : current));
    setSelectedId(null);
  };

  const reorderSelected = (direction: 'forward' | 'backward') => {
    if (!selectedId) return;
    setScene((current) => (current ? reorderNode(current, selectedId, direction) : current));
  };

  // Delete/Escape shortcuts while editing.
  useEffect(() => {
    if (mode !== 'edit' || readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, readOnly, selectedId]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background app-document-ready">
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Image')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<PenTool size={15} className="text-sky-400/80" />}
        meta={
          scene ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {Math.round(scene.viewBox.width)} x {Math.round(scene.viewBox.height)}
            </span>
          ) : null
        }
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              {(['view', 'edit'] as const).map((next) => (
                <Button
                  key={next}
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-8 px-2.5 text-xs app-motion-fast',
                    mode === next && 'bg-accent text-accent-foreground',
                  )}
                  disabled={next === 'edit' && readOnly}
                  onClick={() => setMode(next)}
                >
                  {next === 'view' ? 'View' : 'Edit'}
                </Button>
              ))}
            </div>

            {mode === 'edit' && !readOnly && (
              <SvgToolbar
                tool={tool}
                onToolChange={setTool}
                dirty={dirty}
                saving={saving}
                onSave={() => void save()}
              />
            )}

            <div className={documentTopBarGroupClass}>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => setZoomPercent((c) => Math.max(25, c - 25))}
                disabled={zoomPercent <= 25}
                title="Zoom out"
              >
                <Minus size={14} />
              </Button>
              <button
                type="button"
                onClick={() => setZoomPercent(100)}
                className="min-w-[86px] rounded-md px-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                title="Reset zoom to 100%"
              >
                {zoomPercent}%
              </button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => setZoomPercent((c) => Math.min(400, c + 25))}
                disabled={zoomPercent >= 400}
                title="Zoom in"
              >
                <Plus size={14} />
              </Button>
            </div>
          </>
        }
      />

      {readOnly && <ReadOnlyBanner />}

      {!readOnly && assetBacked && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] text-amber-100/90">
          This SVG was imported as an image asset, so vector edits can't be saved back to it.
          Re-import the file to edit and save it as a vector document.
        </div>
      )}

      <div
        ref={viewportRef}
        className="relative flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.08)_1px,transparent_0)] [background-size:18px_18px]"
      >
        {mode === 'edit' && selectedNode && !readOnly && (
          <SvgPropertiesPanel
            node={selectedNode}
            onChange={changeSelected}
            onReorder={reorderSelected}
            onDelete={deleteSelected}
            onClose={() => setSelectedId(null)}
          />
        )}

        {loading && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading SVG…
          </div>
        )}

        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <PenTool size={28} className="opacity-35" />
            <p>Could not open this SVG for editing.</p>
            <p className="text-xs opacity-70">{error}</p>
          </div>
        )}

        {!loading && !error && scene && (
          <div
            className="flex items-center justify-center p-6"
            style={{
              width: workspaceDimensions.width,
              height: workspaceDimensions.height,
              minWidth: workspaceDimensions.width,
              minHeight: workspaceDimensions.height,
            }}
          >
            {mode === 'edit' && !readOnly ? (
              <SvgEditStage
                scene={scene}
                displayDimensions={displayDimensions}
                tool={tool}
                selectedId={selectedId}
                readOnly={readOnly}
                onSelect={setSelectedId}
                onSceneChange={(updater) =>
                  setScene((current) => (current ? updater(current) : current))
                }
                onCreated={(id) => {
                  setSelectedId(id);
                  setTool('select');
                }}
              />
            ) : (
              <SvgPreview scene={scene} displayDimensions={displayDimensions} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Non-interactive render of the current scene (view mode, reflects unsaved edits). */
function SvgPreview({
  scene,
  displayDimensions,
}: {
  scene: SvgScene;
  displayDimensions: Dimensions;
}) {
  const html = useMemo(() => serializeScene(scene), [scene]);
  return (
    <div
      className="overflow-hidden rounded-md bg-white shadow-lg shadow-black/30 ring-1 ring-border/40 [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
      style={{ width: displayDimensions.width, height: displayDimensions.height }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
