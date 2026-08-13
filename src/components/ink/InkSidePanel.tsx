import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Layers,
  Lock,
  LockOpen,
  Merge,
  Plus,
  Trash2,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { InkLayer, InkScene } from '../../types/ink';
import { INK_BRUSH_WIDTHS, INK_DEFAULT_SWATCHES, INK_ERASER_SIZES } from '../../lib/ink/tools';
import type { InkToolState } from '../../lib/ink/tools';
import type { InkEraserMode } from '../../lib/ink/erase';
import type { InkAlignment, InkDistribution } from '../../lib/ink/align';

/**
 * The properties and layers panel.
 *
 * One panel rather than two, because on a laptop two stacked panels leave the
 * drawing surface too narrow to be worth having. The properties section changes
 * with the active tool, so the space is spent on whatever the user is holding.
 */

const sectionLabel = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

export interface InkSidePanelProps {
  scene: InkScene | null;
  tool: InkToolState;
  readOnly: boolean;
  selectedIds: string[];
  activeLayerId: string | null;
  onBrushChange: (change: Partial<InkToolState['brush']>) => void;
  onEraserChange: (change: { mode?: InkEraserMode; radius?: number }) => void;
  onActiveLayerChange: (layerId: string) => void;
  onAddLayer: () => void;
  onToggleLayerVisible: (layerId: string) => void;
  onToggleLayerLocked: (layerId: string) => void;
  onRenameLayer: (layerId: string, name: string) => void;
  onReorderLayer: (layerId: string, direction: 1 | -1) => void;
  onMergeLayerDown: (layerId: string) => void;
  onDeleteLayer: (layerId: string) => void;
  onAlign: (alignment: InkAlignment) => void;
  onDistribute: (axis: InkDistribution) => void;
}

export default function InkSidePanel({
  scene,
  tool,
  readOnly,
  selectedIds,
  activeLayerId,
  onBrushChange,
  onEraserChange,
  onActiveLayerChange,
  onAddLayer,
  onToggleLayerVisible,
  onToggleLayerLocked,
  onRenameLayer,
  onReorderLayer,
  onMergeLayerDown,
  onDeleteLayer,
  onAlign,
  onDistribute,
}: InkSidePanelProps) {
  // Top of the list is the top of the drawing, which is the end of layerOrder.
  const layers = scene ? [...scene.layerOrder].reverse() : [];
  const effectiveLayerId = activeLayerId ?? layers[0] ?? null;

  return (
    <aside
      className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/60 bg-card/40 p-3"
      aria-label="Drawing properties and layers"
    >
      {tool.tool === 'pen' && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Pen</h2>

          <div className="grid grid-cols-8 gap-1" role="radiogroup" aria-label="Colour">
            {INK_DEFAULT_SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={tool.brush.color === color}
                aria-label={`Colour ${color}`}
                disabled={readOnly}
                onClick={() => onBrushChange({ color })}
                style={{ background: color }}
                className={cn(
                  'size-5 rounded-full border transition-transform app-motion-fast',
                  tool.brush.color === color
                    ? 'border-foreground ring-2 ring-primary/60'
                    : 'border-border/60 hover:scale-110',
                )}
              />
            ))}
          </div>

          <label className="block space-y-1">
            <span className={sectionLabel}>Width</span>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Width">
              {INK_BRUSH_WIDTHS.map((width) => (
                <button
                  key={width}
                  type="button"
                  role="radio"
                  aria-checked={tool.brush.width === width}
                  aria-label={`Width ${Math.round(width / 64)} points`}
                  disabled={readOnly}
                  onClick={() => onBrushChange({ width })}
                  className={cn(
                    'flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-[11px] transition-colors app-motion-fast',
                    tool.brush.width === width
                      ? 'border-primary bg-primary/15'
                      : 'border-border/60 hover:bg-accent/50',
                  )}
                >
                  {Math.round(width / 64)}
                </button>
              ))}
            </div>
          </label>

          <label className="block space-y-1">
            <span className={sectionLabel}>Opacity</span>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              disabled={readOnly}
              value={Math.round(tool.brush.opacity * 100)}
              aria-label="Opacity"
              onChange={(event) => onBrushChange({ opacity: Number(event.target.value) / 100 })}
              className="w-full accent-[var(--primary)]"
            />
          </label>

          <label className="block space-y-1">
            <span className={sectionLabel}>Stabilizer</span>
            <input
              type="range"
              min={0}
              max={95}
              step={5}
              disabled={readOnly}
              value={Math.round(tool.brush.streamline * 100)}
              aria-label="Stabilizer"
              onChange={(event) => onBrushChange({ streamline: Number(event.target.value) / 100 })}
              className="w-full accent-[var(--primary)]"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={tool.brush.simulatePressure === true}
              onChange={(event) => onBrushChange({ simulatePressure: event.target.checked })}
            />
            Simulate pressure
          </label>
          {/* Off by default: a mouse line that fakes pressure looks wrong more
              often than a uniform one does. */}
        </section>
      )}

      {tool.tool === 'eraser' && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Eraser</h2>
          <div className="flex gap-1" role="radiogroup" aria-label="Eraser mode">
            {(['stroke', 'segment', 'object'] as InkEraserMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={tool.eraserMode === mode}
                disabled={readOnly}
                onClick={() => onEraserChange({ mode })}
                className={cn(
                  'flex-1 rounded-md border px-1.5 py-1 text-[11px] capitalize transition-colors app-motion-fast',
                  tool.eraserMode === mode
                    ? 'border-primary bg-primary/15'
                    : 'border-border/60 hover:bg-accent/50',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Eraser size">
            {INK_ERASER_SIZES.map((radius) => (
              <button
                key={radius}
                type="button"
                role="radio"
                aria-checked={tool.eraserRadius === radius}
                aria-label={`Eraser size ${Math.round(radius / 64)} points`}
                disabled={readOnly}
                onClick={() => onEraserChange({ radius })}
                className={cn(
                  'flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-[11px] transition-colors app-motion-fast',
                  tool.eraserRadius === radius
                    ? 'border-primary bg-primary/15'
                    : 'border-border/60 hover:bg-accent/50',
                )}
              >
                {Math.round(radius / 64)}
              </button>
            ))}
          </div>
        </section>
      )}

      {selectedIds.length > 1 && !readOnly && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Arrange {selectedIds.length} objects</h2>
          <div className="grid grid-cols-6 gap-1">
            {([
              ['left', <AlignStartVertical size={14} key="l" />, 'Align left'],
              ['center-horizontal', <AlignCenterVertical size={14} key="ch" />, 'Align centre'],
              ['right', <AlignEndVertical size={14} key="r" />, 'Align right'],
              ['top', <AlignStartHorizontal size={14} key="t" />, 'Align top'],
              ['center-vertical', <AlignCenterHorizontal size={14} key="cv" />, 'Align middle'],
              ['bottom', <AlignEndHorizontal size={14} key="b" />, 'Align bottom'],
            ] as Array<[InkAlignment, React.ReactNode, string]>).map(([alignment, icon, label]) => (
              <Tooltip key={alignment}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    onClick={() => onAlign(alignment)}
                    className="flex size-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors app-motion-fast hover:bg-accent/50 hover:text-foreground"
                  >
                    {icon}
                  </button>
                </TooltipTrigger>
                <TooltipContent className="text-xs text-foreground">{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          {selectedIds.length > 2 && (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => onDistribute('horizontal')}
                className="flex-1 rounded-md border border-border/60 px-2 py-1 text-[11px] transition-colors app-motion-fast hover:bg-accent/50"
              >
                Space across
              </button>
              <button
                type="button"
                onClick={() => onDistribute('vertical')}
                className="flex-1 rounded-md border border-border/60 px-2 py-1 text-[11px] transition-colors app-motion-fast hover:bg-accent/50"
              >
                Space down
              </button>
            </div>
          )}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className={cn(sectionLabel, 'flex items-center gap-1.5')}>
            <Layers size={12} />
            Layers
          </h2>
          <button
            type="button"
            aria-label="Add layer"
            disabled={readOnly}
            onClick={onAddLayer}
            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors app-motion-fast hover:bg-accent/60 hover:text-foreground disabled:opacity-40"
          >
            <Plus size={13} />
          </button>
        </div>

        <ul className="space-y-1" aria-label="Layers">
          {layers.map((layerId, position) => {
            const layer: InkLayer | undefined = scene?.layers[layerId];
            if (!layer) return null;
            const isBottom = position === layers.length - 1;
            return (
              <li
                key={layerId}
                className={cn(
                  'rounded-lg border px-2 py-1.5 transition-colors app-motion-fast',
                  effectiveLayerId === layerId
                    ? 'border-primary bg-primary/10'
                    : 'border-border/50 hover:bg-accent/40',
                )}
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
                    onClick={() => onToggleLayerVisible(layerId)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <button
                    type="button"
                    aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`}
                    disabled={readOnly}
                    onClick={() => onToggleLayerLocked(layerId)}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    {layer.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                  </button>
                  <input
                    value={layer.name}
                    aria-label={`Layer name for ${layer.name}`}
                    readOnly={readOnly}
                    onFocus={() => onActiveLayerChange(layerId)}
                    onChange={(event) => onRenameLayer(layerId, event.target.value)}
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none"
                  />
                </div>
                {!readOnly && (
                  <div className="mt-1 flex items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={`Move ${layer.name} up`}
                      disabled={position === 0}
                      onClick={() => onReorderLayer(layerId, 1)}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${layer.name} down`}
                      disabled={isBottom}
                      onClick={() => onReorderLayer(layerId, -1)}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Merge ${layer.name} down`}
                      disabled={isBottom}
                      onClick={() => onMergeLayerDown(layerId)}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-30"
                    >
                      <Merge size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${layer.name}`}
                      // A scene with no layers has nowhere to put the next
                      // stroke, so the last one cannot be removed.
                      disabled={layers.length <= 1}
                      onClick={() => onDeleteLayer(layerId)}
                      className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive disabled:opacity-30"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
