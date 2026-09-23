import { useEffect, useState } from 'react';

import type {
  InkExportCrop,
  InkExportFormat,
  InkExportOptions,
  InkExportPalette,
  InkExportScope,
} from '../../lib/ink/export';
import type { InkExportProgress } from '../../lib/ink/exportRuntime';
import type { InkBounds } from '../../types/ink';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Progress } from '../ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface InkExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId: string;
  pageCount: number;
  selectedObjectIds: string[];
  initialRegion: InkBounds;
  busy: boolean;
  progress: InkExportProgress | null;
  onExport: (options: InkExportOptions) => void;
  onInsert?: (options: InkExportOptions) => void;
  onCancel: () => void;
}

function finiteNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function InkExportDialog({
  open,
  onOpenChange,
  pageId,
  pageCount,
  selectedObjectIds,
  initialRegion,
  busy,
  progress,
  onExport,
  onInsert,
  onCancel,
}: InkExportDialogProps) {
  const [format, setFormat] = useState<InkExportFormat>('png');
  const [scope, setScope] = useState<InkExportScope>('page');
  const [crop, setCrop] = useState<InkExportCrop>('page');
  const [scale, setScale] = useState(2);
  const [padding, setPadding] = useState(0);
  const [transparent, setTransparent] = useState(false);
  const [includePageBackground, setIncludePageBackground] = useState(true);
  const [palette, setPalette] = useState<InkExportPalette>('page');
  const [region, setRegion] = useState(initialRegion);

  useEffect(() => {
    if (open) setRegion(initialRegion);
  }, [initialRegion, open]);

  useEffect(() => {
    if (format !== 'pdf' && scope === 'document') setScope('page');
  }, [format, scope]);

  const percentage = progress
    ? Math.round((progress.completed / Math.max(1, progress.total)) * 100)
    : 0;
  const regionWidth = Math.max(1, region.maxX - region.minX);
  const regionHeight = Math.max(1, region.maxY - region.minY);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Export drawing</DialogTitle>
          <DialogDescription>
            Export from the stored scene rather than the current viewport chrome. Large raster jobs
            run in a cancellable worker.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="ink-export-format" className="text-xs font-medium">
              Format
            </label>
            <Select value={format} onValueChange={(value) => setFormat(value as InkExportFormat)}>
              <SelectTrigger id="ink-export-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">PNG image</SelectItem>
                <SelectItem value="svg">Standalone SVG</SelectItem>
                <SelectItem value="pdf">PDF document</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="ink-export-scope" className="text-xs font-medium">
              Content
            </label>
            <Select value={scope} onValueChange={(value) => setScope(value as InkExportScope)}>
              <SelectTrigger id="ink-export-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="page">Current page</SelectItem>
                <SelectItem value="selection" disabled={selectedObjectIds.length === 0}>
                  Selection ({selectedObjectIds.length})
                </SelectItem>
                <SelectItem value="region">Visible region</SelectItem>
                {format === 'pdf' ? (
                  <SelectItem value="document">All pages ({pageCount})</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="ink-export-crop" className="text-xs font-medium">
              Crop
            </label>
            <Select value={crop} onValueChange={(value) => setCrop(value as InkExportCrop)}>
              <SelectTrigger id="ink-export-crop">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="page">Page edges</SelectItem>
                <SelectItem value="content">Content bounds</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="ink-export-scale" className="text-xs font-medium">
              Raster scale
            </label>
            <Select value={String(scale)} onValueChange={(value) => setScale(Number(value))}>
              <SelectTrigger id="ink-export-scale" disabled={format === 'svg'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1×</SelectItem>
                <SelectItem value="2">2×</SelectItem>
                <SelectItem value="4">4×</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="ink-export-palette" className="text-xs font-medium">
              Destination palette
            </label>
            <Select
              value={palette}
              onValueChange={(value) => setPalette(value as InkExportPalette)}
            >
              <SelectTrigger id="ink-export-palette">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="page">Match page</SelectItem>
                <SelectItem value="light">Light output</SelectItem>
                <SelectItem value="dark">Dark output</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="ink-export-padding" className="text-xs font-medium">
              Padding (ink units)
            </label>
            <Input
              id="ink-export-padding"
              type="number"
              min={0}
              value={padding}
              onChange={(event) => setPadding(Math.max(0, finiteNumber(event.target.value, 0)))}
            />
          </div>
        </div>

        {scope === 'region' ? (
          <div className="grid grid-cols-2 gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-4">
            {[
              ['X', region.minX, (value: number) => setRegion((old) => ({ ...old, minX: value }))],
              ['Y', region.minY, (value: number) => setRegion((old) => ({ ...old, minY: value }))],
              [
                'Width',
                regionWidth,
                (value: number) =>
                  setRegion((old) => ({ ...old, maxX: old.minX + Math.max(1, value) })),
              ],
              [
                'Height',
                regionHeight,
                (value: number) =>
                  setRegion((old) => ({ ...old, maxY: old.minY + Math.max(1, value) })),
              ],
            ].map(([label, value, update]) => (
              <div key={String(label)} className="space-y-1">
                <label className="text-[11px] font-medium">{String(label)}</label>
                <Input
                  type="number"
                  value={Number(value)}
                  onChange={(event) =>
                    (update as (next: number) => void)(
                      finiteNumber(event.target.value, Number(value)),
                    )
                  }
                />
              </div>
            ))}
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Checkbox
              id="ink-export-paper"
              checked={includePageBackground}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setIncludePageBackground(next);
                if (next) setTransparent(false);
              }}
            />
            <div>
              <label htmlFor="ink-export-paper" className="text-sm">
                Include page background and pattern
              </label>
              <p className="text-xs text-muted-foreground">
                Includes ruled, grid, dotted, staff, or storyboard paper.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="ink-export-transparent"
              checked={transparent}
              disabled={format === 'pdf'}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setTransparent(next);
                if (next) setIncludePageBackground(false);
              }}
            />
            <div>
              <label htmlFor="ink-export-transparent" className="text-sm">
                Transparent background
              </label>
              <p className="text-xs text-muted-foreground">
                Available for PNG and SVG when the page background is omitted.
              </p>
            </div>
          </div>
        </div>

        {busy ? (
          <div className="space-y-2 rounded-md border border-border/70 p-3" aria-live="polite">
            <div className="flex justify-between text-xs">
              <span>{progress?.label ?? 'Preparing export'}</span>
              <span>{percentage}%</span>
            </div>
            <Progress value={percentage} />
          </div>
        ) : null}

        <DialogFooter>
          {busy ? (
            <Button variant="destructive" onClick={onCancel}>
              Cancel export
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {onInsert ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    onInsert({
                      format: 'svg',
                      scope: scope === 'document' ? 'page' : scope,
                      pageId,
                      selectedObjectIds,
                      region,
                      crop,
                      scale: 1,
                      padding,
                      transparent,
                      includePageBackground,
                      palette,
                    })
                  }
                  disabled={scope === 'selection' && selectedObjectIds.length === 0}
                >
                  Insert SVG in note
                </Button>
              ) : null}
              <Button
                onClick={() =>
                  onExport({
                    format,
                    scope,
                    pageId,
                    selectedObjectIds,
                    region,
                    crop,
                    scale,
                    padding,
                    transparent: format === 'pdf' ? false : transparent,
                    includePageBackground,
                    palette,
                  })
                }
                disabled={scope === 'selection' && selectedObjectIds.length === 0}
              >
                Export
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
