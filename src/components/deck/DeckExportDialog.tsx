import { useEffect, useState } from 'react';

import { Download, Loader2, Printer } from 'lucide-react';

import { HANDOUT_SLIDES_PER_PAGE, parseSlideRange } from '../../lib/deck/output';
import type {
  DeckOrientation,
  DeckOutputLayout,
  DeckPaper,
  HandoutSlidesPerPage,
} from '../../lib/deck/output';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
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

const FORMAT_NAMES: Record<DeckExportFormat, string> = {
  pdf: 'PDF — one slide per page',
  handouts: 'PDF — handouts',
  pptx: 'PowerPoint (.pptx)',
  png: 'PNG images',
  svg: 'SVG images',
};

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

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (!onReturnFocus) return;
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Export presentation</DialogTitle>
          <DialogDescription>
            PDFs keep slides exactly as drawn and their text searchable. Exporting never changes the
            presentation.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <span className="text-xs text-muted-foreground">Format</span>
          <Select value={format} onValueChange={(value) => setFormat(value as DeckExportFormat)}>
            <SelectTrigger size="sm" aria-label="Format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FORMAT_NAMES) as DeckExportFormat[]).map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {FORMAT_NAMES[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="text-xs text-muted-foreground">Slides</span>
          <div className="flex items-center gap-2">
            <Select value={range} onValueChange={(value) => setRange(value as DeckExportRange)}>
              <SelectTrigger size="sm" className="w-40" aria-label="Slides">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All slides</SelectItem>
                <SelectItem value="current">Current slide ({currentNumber})</SelectItem>
                {selectedNumbers.length > 1 && (
                  <SelectItem value="selected">Selected ({selectedNumbers.length})</SelectItem>
                )}
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
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

          {range === 'all' && format !== 'pptx' && (
            <>
              <span />
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={includeHidden}
                  onChange={(event) => setIncludeHidden(event.target.checked)}
                />
                Include hidden slides
              </label>
            </>
          )}

          {format === 'handouts' && (
            <>
              <span className="text-xs text-muted-foreground">Per page</span>
              <div className="flex items-center gap-2">
                <Select
                  value={String(perPage)}
                  onValueChange={(value) => setPerPage(Number(value) as HandoutSlidesPerPage)}
                >
                  <SelectTrigger size="sm" className="w-20" aria-label="Slides per page">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HANDOUT_SLIDES_PER_PAGE.filter((count) => !notes || count <= 3).map(
                      (count) => (
                        <SelectItem key={count} value={String(count)}>
                          {count}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={notes}
                    onChange={(event) => {
                      setNotes(event.target.checked);
                      if (event.target.checked && perPage > 3) setPerPage(3);
                    }}
                  />
                  Speaker notes
                </label>
              </div>
              <span className="text-xs text-muted-foreground">Paper</span>
              <div className="flex items-center gap-2">
                <Select value={paper} onValueChange={(value) => setPaper(value as DeckPaper)}>
                  <SelectTrigger size="sm" className="w-24" aria-label="Paper">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a4">A4</SelectItem>
                    <SelectItem value="letter">Letter</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={orientation}
                  onValueChange={(value) => setOrientation(value as DeckOrientation)}
                >
                  <SelectTrigger size="sm" className="w-32" aria-label="Orientation">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="portrait">Portrait</SelectItem>
                    <SelectItem value="landscape">Landscape</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {format === 'png' && (
            <>
              <span className="text-xs text-muted-foreground">Size</span>
              <Select value={scale} onValueChange={setScale}>
                <SelectTrigger size="sm" className="w-40" aria-label="Image size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Standard (1×)</SelectItem>
                  <SelectItem value="2">Large (2×)</SelectItem>
                  <SelectItem value="4">Extra large (4×)</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
        </div>

        {format === 'pptx' && (
          <p className="text-xs text-muted-foreground">
            An editable copy with masters, layouts, notes, charts, and groups. Hidden slides stay
            hidden. Anything PowerPoint cannot represent exactly is listed after export.
          </p>
        )}
        {(format === 'png' || format === 'svg') && (
          <p className="text-xs text-muted-foreground">
            One slide saves as a file; several are written to a folder you choose, one file per
            slide.
          </p>
        )}
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {progress && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" />
            Rendering {progress.completed} of {progress.total}…
            <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}

        <DialogFooter>
          {printable && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                const request = build();
                if (request) onPrint(request);
              }}
            >
              <Printer className="size-4" />
              Print…
            </Button>
          )}
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              const request = build();
              if (request) onExport(request);
            }}
          >
            <Download className="size-4" />
            Export…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
