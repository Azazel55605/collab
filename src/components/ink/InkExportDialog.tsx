import { useEffect, useState } from 'react';

import { FileText, Image as ImageIcon, PenLine } from 'lucide-react';

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
import { ExportDialog } from '../ui/export-dialog';
import { Input } from '../ui/input';
import { DetailRow } from '../ui/list-detail-dialog';
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

  const options = (): InkExportOptions => ({
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
  });
  const noSelection = scope === 'selection' && selectedObjectIds.length === 0;
  const pick = (
    id: string,
    value: string,
    onChange: (value: string) => void,
    items: [string, string, boolean?][],
    disabled = false,
  ) => (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map(([itemValue, label, itemDisabled]) => (
          <SelectItem key={itemValue} value={itemValue} disabled={itemDisabled}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <ExportDialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title="Export drawing"
      description="Exports the drawing itself, not the editor around it. Large images render in the background and can be stopped."
      formats={[
        {
          value: 'png',
          label: 'PNG image',
          description: 'Pixels, for anywhere',
          icon: <ImageIcon />,
        },
        {
          value: 'svg',
          label: 'Standalone SVG',
          description: 'Scales without blur',
          icon: <PenLine />,
        },
        {
          value: 'pdf',
          label: 'PDF document',
          description: 'One page per page',
          icon: <FileText />,
        },
      ]}
      format={format}
      onFormatChange={setFormat}
      exportLabel="Export"
      exportDisabled={noSelection}
      busy={busy}
      onExport={() => onExport(options())}
      secondary={
        onInsert && !busy ? (
          <Button
            type="button"
            variant="ghost"
            disabled={noSelection}
            onClick={() =>
              onInsert({
                ...options(),
                format: 'svg',
                scope: scope === 'document' ? 'page' : scope,
                scale: 1,
              })
            }
          >
            Insert SVG in note
          </Button>
        ) : undefined
      }
    >
      <DetailRow label="What" description="The page, the selection, or a region of it.">
        {pick('ink-export-scope', scope, (value) => setScope(value as InkExportScope), [
          ['page', 'Current page'],
          ['selection', `Selection (${selectedObjectIds.length})`, selectedObjectIds.length === 0],
          ['region', 'Visible region'],
          ...(format === 'pdf'
            ? ([['document', `All pages (${pageCount})`]] as [string, string][])
            : []),
        ])}
      </DetailRow>
      {scope === 'region' && (
        <div className="grid grid-cols-4 gap-2 border-b border-border/40 py-3">
          {(
            [
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
            ] as [string, number, (value: number) => void][]
          ).map(([label, value, update]) => (
            <label key={label} className="flex flex-col gap-1 text-[12px] font-medium">
              {label}
              <Input
                type="number"
                className="h-8"
                value={value}
                onChange={(event) => update(finiteNumber(event.target.value, value))}
              />
            </label>
          ))}
        </div>
      )}
      <DetailRow label="Crop" description="Edges of the page, or tight around the ink.">
        {pick('ink-export-crop', crop, (value) => setCrop(value as InkExportCrop), [
          ['page', 'Page edges'],
          ['content', 'Content bounds'],
        ])}
      </DetailRow>
      {format !== 'svg' && (
        <DetailRow label="Scale" description="Pixels per drawing unit.">
          {pick('ink-export-scale', String(scale), (value) => setScale(Number(value)), [
            ['1', '1×'],
            ['2', '2×'],
            ['4', '4×'],
          ])}
        </DetailRow>
      )}
      <DetailRow label="Colours" description="Keep the page look, or force light or dark.">
        {pick('ink-export-palette', palette, (value) => setPalette(value as InkExportPalette), [
          ['page', 'Match page'],
          ['light', 'Light output'],
          ['dark', 'Dark output'],
        ])}
      </DetailRow>
      <DetailRow label="Padding" description="Space around the edges, in drawing units.">
        <Input
          id="ink-export-padding"
          aria-label="Padding (ink units)"
          type="number"
          min={0}
          className="h-8 w-24"
          value={padding}
          onChange={(event) => setPadding(Math.max(0, finiteNumber(event.target.value, 0)))}
        />
      </DetailRow>
      <DetailRow
        label="Include page background and pattern"
        description="Ruled, grid, dotted, staff or storyboard paper."
      >
        <Checkbox
          id="ink-export-paper"
          aria-label="Include page background and pattern"
          checked={includePageBackground}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setIncludePageBackground(next);
            if (next) setTransparent(false);
          }}
        />
      </DetailRow>
      {format !== 'pdf' && (
        <DetailRow label="Transparent background" description="Only without the page background.">
          <Checkbox
            id="ink-export-transparent"
            aria-label="Transparent background"
            checked={transparent}
            onCheckedChange={(checked) => {
              const next = checked === true;
              setTransparent(next);
              if (next) setIncludePageBackground(false);
            }}
          />
        </DetailRow>
      )}
      {busy && (
        <div className="space-y-2 pt-3" aria-live="polite">
          <div className="flex items-center justify-between text-xs">
            <span>{progress?.label ?? 'Preparing export'}</span>
            <span className="flex items-center gap-2">
              {percentage}%
              <Button type="button" size="sm" variant="ghost" className="h-6" onClick={onCancel}>
                Cancel export
              </Button>
            </span>
          </div>
          <Progress value={percentage} />
        </div>
      )}
    </ExportDialog>
  );
}
