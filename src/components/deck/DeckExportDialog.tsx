import { useEffect, useState } from 'react';

import {
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Presentation,
  Printer,
} from 'lucide-react';

import { HANDOUT_SLIDES_PER_PAGE, parseSlideRange } from '../../lib/deck/output';
import type {
  DeckOrientation,
  DeckOutputLayout,
  DeckPaper,
  HandoutSlidesPerPage,
} from '../../lib/deck/output';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { ExportDialog } from '../ui/export-dialog';
import { Input } from '../ui/input';
import { DetailRow } from '../ui/list-detail-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export type DeckExportFormat = 'pdf' | 'handouts' | 'pptx' | 'png' | 'svg';
export type DeckExportRange = 'all' | 'current' | 'selected' | 'custom';

export interface DeckExportRequest {
  format: DeckExportFormat;
  layout: DeckOutputLayout;
  /** 1-based slide numbers, in order; `null` means every slide playback shows. */
  slides: number[] | null;
  includeHidden: boolean;
  /** PNG pixels per CSS pixel. */
  scale: number;
}

interface DeckExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnFocus?: () => void;
  slideCount: number;
  /** 1-based. */
  currentNumber: number;
  selectedNumbers: number[];
  progress: { completed: number; total: number } | null;
  onExport: (request: DeckExportRequest) => void;
  onPrint: (request: DeckExportRequest) => void;
  onCancel: () => void;
}

/** Export and print settings for a presentation. */
export function DeckExportDialog({
  open,
  onOpenChange,
  onReturnFocus,
  slideCount,
  currentNumber,
  selectedNumbers,
  progress,
  onExport,
  onPrint,
  onCancel,
}: DeckExportDialogProps) {
  const [format, setFormat] = useState<DeckExportFormat>('pdf');
  const [range, setRange] = useState<DeckExportRange>('all');
  const [custom, setCustom] = useState('');
  const [includeHidden, setIncludeHidden] = useState(false);
  const [paper, setPaper] = useState<DeckPaper>('a4');
  const [orientation, setOrientation] = useState<DeckOrientation>('portrait');
  const [perPage, setPerPage] = useState<HandoutSlidesPerPage>(3);
  const [notes, setNotes] = useState(true);
  const [scale, setScale] = useState('2');
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRange(selectedNumbers.length > 1 ? 'selected' : 'all');
    setCustom(`1-${slideCount}`);
    // Only when the dialog opens; the selection may change behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const build = (): DeckExportRequest | null => {
    let slides: number[] | null = null;
    try {
      if (range === 'current') slides = [currentNumber];
      else if (range === 'selected') slides = [...selectedNumbers].sort((a, b) => a - b);
      else if (range === 'custom') slides = parseSlideRange(custom, slideCount);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    }
    setError(null);
    const layout: DeckOutputLayout =
      format === 'handouts'
        ? { kind: 'handouts', paper, orientation, slidesPerPage: perPage, notes }
        : { kind: 'slides' };
    return { format, layout, slides, includeHidden, scale: Number(scale) || 2 };
  };

  const printable = format === 'pdf' || format === 'handouts';
  const count =
    range === 'current'
      ? 1
      : range === 'selected'
        ? selectedNumbers.length
        : range === 'custom'
          ? null
          : slideCount;
  const slidesText =
    count === null ? 'The chosen slides' : `${count} slide${count === 1 ? '' : 's'}`;
  const summary =
    format === 'pptx'
      ? `${slidesText} → an editable PowerPoint copy. Anything it cannot represent exactly is listed afterwards.`
      : format === 'png' || format === 'svg'
        ? `${slidesText} → one ${format.toUpperCase()} per slide; several go into a folder you choose.`
        : format === 'handouts'
          ? `${slidesText} → a handout PDF, ${perPage} per page`
          : `${slidesText} → one PDF page each`;
  const exportLabel = {
    pdf: 'Export PDF',
    handouts: 'Export handouts',
    pptx: 'Export PowerPoint',
    png: 'Export PNGs',
    svg: 'Export SVGs',
  }[format];

  const select = (
    value: string,
    onChange: (value: string) => void,
    label: string,
    options: [string, string][],
    width = 'w-44',
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className={width} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([optionValue, optionLabel]) => (
          <SelectItem key={optionValue} value={optionValue}>
            {optionLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <ExportDialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      onCloseAutoFocus={
        onReturnFocus
          ? (event) => {
              event.preventDefault();
              onReturnFocus();
            }
          : undefined
      }
      title="Export presentation"
      description="Exporting never changes the presentation."
      formats={[
        { value: 'pdf', label: 'PDF', description: 'One slide per page', icon: <FileText /> },
        {
          value: 'handouts',
          label: 'Handouts',
          description: 'Several per page',
          icon: <LayoutGrid />,
        },
        {
          value: 'pptx',
          label: 'PowerPoint',
          description: '.pptx, editable',
          icon: <Presentation />,
        },
        { value: 'png', label: 'PNG', description: 'One image per slide', icon: <ImageIcon /> },
        { value: 'svg', label: 'SVG', description: 'Vector images', icon: <ImageIcon /> },
      ]}
      format={format}
      onFormatChange={(next) => setFormat(next)}
      summary={summary}
      exportLabel={exportLabel}
      busy={busy}
      error={error}
      onExport={() => {
        const request = build();
        if (request) onExport(request);
      }}
      secondary={
        printable ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              const request = build();
              if (request) onPrint(request);
            }}
          >
            <Printer className="size-4" />
            Print…
          </Button>
        ) : undefined
      }
    >
      <DetailRow label="Slides" description={`${slideCount} slides in this presentation.`}>
        <div className="flex items-center gap-2">
          {select(range, (value) => setRange(value as DeckExportRange), 'Slides', [
            ['all', 'All slides'],
            ['current', `Current slide (${currentNumber})`],
            ...(selectedNumbers.length > 1
              ? ([['selected', `Selected (${selectedNumbers.length})`]] as [string, string][])
              : []),
            ['custom', 'Custom range'],
          ])}
          {range === 'custom' && (
            <Input
              aria-label="Slide numbers"
              className="h-8 w-28"
              placeholder="1-3, 5"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
          )}
        </div>
      </DetailRow>
      {range === 'all' && format !== 'pptx' && (
        <DetailRow label="Hidden slides" description="Include slides that are hidden in the show.">
          <Checkbox
            aria-label="Include hidden slides"
            checked={includeHidden}
            onCheckedChange={(checked) => setIncludeHidden(checked === true)}
          />
        </DetailRow>
      )}
      {format === 'handouts' && (
        <>
          <DetailRow label="Per page" description="With notes, at most three slides fit a page.">
            {select(
              String(perPage),
              (value) => setPerPage(Number(value) as HandoutSlidesPerPage),
              'Slides per page',
              HANDOUT_SLIDES_PER_PAGE.filter((entry) => !notes || entry <= 3).map((entry) => [
                String(entry),
                String(entry),
              ]),
              'w-24',
            )}
          </DetailRow>
          <DetailRow label="Speaker notes" description="Print each slide's notes beside it.">
            <Checkbox
              aria-label="Speaker notes"
              checked={notes}
              onCheckedChange={(checked) => {
                setNotes(checked === true);
                if (checked === true && perPage > 3) setPerPage(3);
              }}
            />
          </DetailRow>
          <DetailRow label="Paper">
            <div className="flex items-center gap-2">
              {select(
                paper,
                (value) => setPaper(value as DeckPaper),
                'Paper',
                [
                  ['a4', 'A4'],
                  ['letter', 'Letter'],
                ],
                'w-24',
              )}
              {select(
                orientation,
                (value) => setOrientation(value as DeckOrientation),
                'Orientation',
                [
                  ['portrait', 'Portrait'],
                  ['landscape', 'Landscape'],
                ],
                'w-32',
              )}
            </div>
          </DetailRow>
        </>
      )}
      {format === 'png' && (
        <DetailRow label="Size" description="Pixels per slide point.">
          {select(scale, setScale, 'Image size', [
            ['1', 'Standard (1×)'],
            ['2', 'Large (2×)'],
            ['4', 'Extra large (4×)'],
          ])}
        </DetailRow>
      )}
      {progress && (
        <div className="flex items-center gap-2 pt-3 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" />
          Rendering {progress.completed} of {progress.total}…
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
            Stop
          </Button>
        </div>
      )}
    </ExportDialog>
  );
}
