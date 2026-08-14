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
import { useState } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { InkBrushPreset, InkLayer, InkPage, InkPageBackground, InkScene, InkSwatch } from '../../types/ink';
import { INK_LIMITS } from '../../types/ink';
import { INK_BRUSH_WIDTHS, INK_DEFAULT_SWATCHES, INK_ERASER_SIZES } from '../../lib/ink/tools';
import type { InkToolState } from '../../lib/ink/tools';
import type { InkEraserMode } from '../../lib/ink/erase';
import type { InkAlignment, InkDistribution } from '../../lib/ink/align';
import { INK_SHAPE_ORDER, INK_STAMP_CATALOG } from '../../lib/ink/advancedTools';
import type { InkDocumentTemplate } from '../../lib/ink/templates';

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
  page: InkPage | null;
  brushes: InkBrushPreset[];
  swatches: InkSwatch[];
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
  onAdvancedToolChange: (change: Partial<InkToolState>) => void;
  onRecognizeSelection: () => void;
  onSmoothSelection: () => void;
  onRecolorSelection: (color: string) => void;
  onUpdateSelectedText: (change: { text?: string; backgroundColor?: string }) => void;
  onPageBackgroundChange: (change: Partial<InkPageBackground>) => void;
  onSelectBrushPreset: (preset: InkBrushPreset) => void;
  onSaveBrushFavorite: () => void;
  onAddSwatch: () => void;
  onSetSelectedLink: (target: string | null) => void;
  templates: InkDocumentTemplate[];
  onSavePageTemplate: (name: string) => void;
  onAddPageFromTemplate: (templateId: string) => void;
  onDeleteTemplate: (templateId: string) => void;
  onImportTemplate: () => void;
  onExportTemplate: (templateId: string) => void;
}

export default function InkSidePanel({
  scene,
  page,
  brushes,
  swatches,
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
  onAdvancedToolChange,
  onRecognizeSelection,
  onSmoothSelection,
  onRecolorSelection,
  onUpdateSelectedText,
  onPageBackgroundChange,
  onSelectBrushPreset,
  onSaveBrushFavorite,
  onAddSwatch,
  onSetSelectedLink,
  templates,
  onSavePageTemplate,
  onAddPageFromTemplate,
  onDeleteTemplate,
  onImportTemplate,
  onExportTemplate,
}: InkSidePanelProps) {
  const [templateName, setTemplateName] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  // Top of the list is the top of the drawing, which is the end of layerOrder.
  const layers = scene ? [...scene.layerOrder].reverse() : [];
  const effectiveLayerId = activeLayerId ?? layers[0] ?? null;
  const selectedObject = selectedIds.length === 1 ? scene?.objects[selectedIds[0]] : null;
  const selectedText = selectedObject?.type === 'text' ? selectedObject : null;
  const paletteColors = [...new Set([...swatches.map((swatch) => swatch.color), ...INK_DEFAULT_SWATCHES])];

  return (
    <aside
      className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/60 bg-card/40 p-3"
      aria-label="Drawing properties and layers"
    >
      {tool.tool === 'pen' && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Pen</h2>

          <div className="grid grid-cols-8 gap-1" role="radiogroup" aria-label="Colour">
            {paletteColors.map((color) => (
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
          <button
            type="button"
            disabled={readOnly || swatches.length >= INK_LIMITS.swatchesPerDocument || swatches.some((swatch) => swatch.color.toLowerCase() === tool.brush.color.toLowerCase())}
            onClick={onAddSwatch}
            className="w-full rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50 disabled:opacity-40"
          >
            Add current colour to swatches
          </button>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>Brush favourites</span>
              <button type="button" disabled={readOnly || brushes.length >= INK_LIMITS.brushesPerDocument} onClick={onSaveBrushFavorite} className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/50 disabled:opacity-40">Save current</button>
            </div>
            <div className="flex flex-wrap gap-1">
              {brushes.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-label={`Use brush favourite ${preset.name}`}
                  onClick={() => onSelectBrushPreset(preset)}
                  className={cn(
                    'rounded-md border px-2 py-1 text-[11px] hover:bg-accent/50',
                    tool.brushId === preset.id ? 'border-primary bg-primary/10' : 'border-border/60',
                  )}
                >
                  {preset.name}
                </button>
              ))}
            </div>
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

      {(tool.tool === 'shape' || tool.tool === 'connector') && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>{tool.tool === 'shape' ? 'Shape' : 'Connector'}</h2>
          {tool.tool === 'shape' && (
            <label className="block space-y-1">
              <span className={sectionLabel}>Geometry</span>
              <select
                aria-label="Shape kind"
                value={tool.shapeKind}
                disabled={readOnly}
                onChange={(event) => onAdvancedToolChange({ shapeKind: event.target.value as InkToolState['shapeKind'] })}
                className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
              >
                {INK_SHAPE_ORDER.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
          )}
          <label className="block space-y-1">
            <span className={sectionLabel}>Line style</span>
            <select
              aria-label="Line style"
              value={tool.brush.dash ?? 'solid'}
              disabled={readOnly}
              onChange={(event) => onBrushChange({ dash: event.target.value as InkToolState['brush']['dash'] })}
              className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
            >
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className={sectionLabel}>Start</span>
              <select
                aria-label="Start arrowhead"
                value={tool.arrowStart}
                onChange={(event) => onAdvancedToolChange({ arrowStart: event.target.value as InkToolState['arrowStart'] })}
                className="w-full rounded-md border border-border/60 bg-background px-1 py-1.5 text-xs"
              >
                {['none', 'arrow', 'open', 'dot'].map((kind) => <option key={kind}>{kind}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className={sectionLabel}>End</span>
              <select
                aria-label="End arrowhead"
                value={tool.arrowEnd}
                onChange={(event) => onAdvancedToolChange({ arrowEnd: event.target.value as InkToolState['arrowEnd'] })}
                className="w-full rounded-md border border-border/60 bg-background px-1 py-1.5 text-xs"
              >
                {['none', 'arrow', 'open', 'dot'].map((kind) => <option key={kind}>{kind}</option>)}
              </select>
            </label>
          </div>
          {tool.tool === 'shape' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={tool.shapeFill !== null}
                onChange={(event) => onAdvancedToolChange({ shapeFill: event.target.checked ? tool.brush.color : null })}
              />
              Fill with line colour
            </label>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={tool.snapToGrid}
              onChange={(event) => onAdvancedToolChange({ snapToGrid: event.target.checked })}
            />
            Snap to page grid
          </label>
        </section>
      )}

      {tool.tool === 'stamp' && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Stamp</h2>
          <div className="grid grid-cols-4 gap-1">
            {INK_STAMP_CATALOG.map((stamp) => (
              <button
                key={stamp.id}
                type="button"
                aria-label={`Stamp ${stamp.label}`}
                aria-pressed={tool.stampSymbolId === stamp.id}
                onClick={() => onAdvancedToolChange({ stampSymbolId: stamp.id })}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md border text-lg',
                  tool.stampSymbolId === stamp.id ? 'border-primary bg-primary/10' : 'border-border/60 hover:bg-accent/50',
                )}
              >
                {stamp.glyph}
              </button>
            ))}
          </div>
        </section>
      )}

      {(['image', 'equation', 'ruler', 'protractor', 'compass', 'guide', 'loupe', 'eyedropper'] as InkToolState['tool'][]).includes(tool.tool) && (
        <section className="space-y-1.5">
          <h2 className={sectionLabel}>{tool.tool}</h2>
          <p className="text-xs text-muted-foreground">
            {tool.tool === 'image' ? 'Drag a box, then choose a PNG, JPEG, WebP, GIF, or SVG asset.'
              : tool.tool === 'equation' ? 'Drag a box and enter bounded LaTeX.'
              : tool.tool === 'ruler' ? 'Drag an exact straight line.'
              : tool.tool === 'protractor' ? 'Drag a line snapped to 15 degree increments.'
              : tool.tool === 'compass' ? 'Drag from the centre to draw a perfect circle.'
              : tool.tool === 'guide' ? 'Drag a non-exported alignment guide.'
              : tool.tool === 'loupe' ? 'Press and drag to magnify the committed scene.'
              : 'Click an object to pick its colour.'}
          </p>
        </section>
      )}

      {tool.tool === 'pen' && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            disabled={readOnly}
            checked={tool.holdToStraighten}
            onChange={(event) => onAdvancedToolChange({ holdToStraighten: event.target.checked })}
          />
          Hold to straighten
        </label>
      )}

      {selectedIds.length > 0 && !readOnly && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Selection cleanup</h2>
          <div className="flex gap-1">
            <button type="button" onClick={onRecognizeSelection} disabled={selectedIds.length !== 1} className="flex-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50 disabled:opacity-40">
              Recognize shape
            </button>
            <button type="button" onClick={onSmoothSelection} className="flex-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50">
              Smooth
            </button>
          </div>
          <div className="grid grid-cols-8 gap-1" aria-label="Recolor selection">
            {paletteColors.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Recolor selection ${color}`}
                onClick={() => onRecolorSelection(color)}
                style={{ background: color }}
                className="size-5 rounded-full border border-border/60 hover:scale-110"
              />
            ))}
          </div>
        </section>
      )}

      {selectedText && !readOnly && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>{selectedText.sticky ? 'Sticky note' : selectedText.equation ? 'Equation' : 'Text'}</h2>
          <textarea
            aria-label="Selected text"
            value={selectedText.text}
            maxLength={16_384}
            rows={4}
            onChange={(event) => onUpdateSelectedText({ text: event.target.value })}
            className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
          {selectedText.sticky && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Note colour
              <input
                type="color"
                aria-label="Sticky note colour"
                value={selectedText.backgroundColor ?? '#fef3a7'}
                onChange={(event) => onUpdateSelectedText({ backgroundColor: event.target.value })}
                className="h-7 w-10 rounded border border-border/60 bg-transparent"
              />
            </label>
          )}
        </section>
      )}

      {selectedObject && !readOnly && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Link</h2>
          <input
            key={`${selectedObject.id}:${selectedObject.link?.target ?? ''}`}
            aria-label="Selected object link"
            defaultValue={selectedObject.link?.target ?? ''}
            placeholder="Notes/Target.md or https://…"
            onBlur={(event) => onSetSelectedLink(event.target.value.trim() || null)}
            className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
          {selectedObject.link ? (
            <button type="button" onClick={() => onSetSelectedLink(null)} className="w-full rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50">
              Remove link
            </button>
          ) : null}
          <p className="text-[11px] text-muted-foreground">Double-click the object to open its link.</p>
        </section>
      )}

      {page && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Page background</h2>
          <select
            aria-label="Page background"
            value={page.background.pattern}
            disabled={readOnly}
            onChange={(event) => onPageBackgroundChange({ pattern: event.target.value as InkPageBackground['pattern'] })}
            className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
          >
            <option value="blank">Blank</option>
            <option value="ruled">Ruled</option>
            <option value="grid">Graph</option>
            <option value="dotted">Dotted</option>
            <option value="staff">Music staff</option>
            <option value="storyboard">Storyboard</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Paper
              <input
                type="color"
                aria-label="Page colour"
                disabled={readOnly}
                value={page.background.color ?? '#ffffff'}
                onChange={(event) => onPageBackgroundChange({ color: event.target.value })}
                className="h-7 w-10 rounded border border-border/60 bg-transparent"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Lines
              <input
                type="color"
                aria-label="Page line colour"
                disabled={readOnly}
                value={page.background.lineColor ?? '#c9d1dc'}
                onChange={(event) => onPageBackgroundChange({ lineColor: event.target.value })}
                className="h-7 w-10 rounded border border-border/60 bg-transparent"
              />
            </label>
          </div>
        </section>
      )}

      {page && !readOnly && (
        <section className="space-y-2">
          <h2 className={sectionLabel}>Document templates</h2>
          <div className="flex gap-1">
            <input
              aria-label="Template name"
              value={templateName}
              placeholder={page.name ?? 'Page template'}
              onChange={(event) => setTemplateName(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
            />
            <button
              type="button"
              aria-label="Save page as template"
              onClick={() => {
                onSavePageTemplate(templateName || page.name || 'Page template');
                setTemplateName('');
              }}
              className="rounded-md border border-border/60 px-2 text-[11px] hover:bg-accent/50"
            >
              Save template
            </button>
          </div>
          {templates.length > 0 ? (
            <>
              <select
                aria-label="Drawing template"
                value={selectedTemplateId}
                onChange={(event) => setSelectedTemplateId(event.target.value)}
                className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
              >
                <option value="">Choose a template…</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              <div className="flex gap-1">
                <button type="button" disabled={!selectedTemplateId} onClick={() => onAddPageFromTemplate(selectedTemplateId)} className="flex-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50 disabled:opacity-40">
                  Add template page
                </button>
                <button type="button" disabled={!selectedTemplateId} onClick={() => { onDeleteTemplate(selectedTemplateId); setSelectedTemplateId(''); }} className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-destructive/20 hover:text-destructive disabled:opacity-40">
                  Delete
                </button>
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={onImportTemplate} className="flex-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50">
                  Import template
                </button>
                <button type="button" disabled={!selectedTemplateId} onClick={() => onExportTemplate(selectedTemplateId)} className="flex-1 rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50 disabled:opacity-40">
                  Export template
                </button>
              </div>
            </>
          ) : (
            <button type="button" onClick={onImportTemplate} className="w-full rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-accent/50">
              Import template
            </button>
          )}
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
