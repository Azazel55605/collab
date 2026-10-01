import { useMemo } from 'react';

import { CheckCircle2 } from 'lucide-react';

import { countBySeverity } from '../../lib/deck/pptx/exportReport';
import type { DeckExportReport, DeckExportSeverity } from '../../lib/deck/pptx/exportReport';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface DeckExportReportDialogProps {
  outcome: { report: DeckExportReport; fileName: string } | null;
  /** 1-based slide numbers by slide id, to say where an entry applies. */
  slideNumbers: ReadonlyMap<string, number>;
  onClose: () => void;
  onReturnFocus?: () => void;
}

const SEVERITY: Record<DeckExportSeverity, { label: string; tone: string }> = {
  approximated: { label: 'Approximated', tone: 'text-sky-500' },
  flattened: { label: 'Flattened', tone: 'text-amber-500' },
  omitted: { label: 'Omitted', tone: 'text-orange-500' },
  missing: { label: 'Missing', tone: 'text-destructive' },
};
const ORDER: DeckExportSeverity[] = ['missing', 'omitted', 'flattened', 'approximated'];

/**
 * What a PowerPoint export kept exactly and what it did not. Shown after every
 * export: the counts by kind, each reason once with the slides it applies to,
 * the fonts the file asks for, and any images that were not available.
 */
export function DeckExportReportDialog({
  outcome,
  slideNumbers,
  onClose,
  onReturnFocus,
}: DeckExportReportDialogProps) {
  const report = outcome?.report;
  const groups = useMemo(() => {
    const byCode = new Map<
      string,
      { severity: DeckExportSeverity; message: string; slides: Set<number>; count: number }
    >();
    for (const entry of report?.entries ?? []) {
      const group = byCode.get(entry.code) ?? {
        severity: entry.severity,
        message: entry.message,
        slides: new Set<number>(),
        count: 0,
      };
      group.count += 1;
      const number = entry.slideId ? slideNumbers.get(entry.slideId) : undefined;
      if (number) group.slides.add(number);
      byCode.set(entry.code, group);
    }
    return [...byCode.entries()].sort(
      ([, a], [, b]) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity),
    );
  }, [report, slideNumbers]);
  const counts = report ? countBySeverity(report) : null;
  const clean = report !== undefined && report.entries.length === 0;

  return (
    <Dialog open={outcome !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (!onReturnFocus) return;
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Exported to PowerPoint</DialogTitle>
          <DialogDescription>
            {outcome?.fileName}: {report?.slides} {report?.slides === 1 ? 'slide' : 'slides'},{' '}
            {report?.exported} objects written exactly.
          </DialogDescription>
        </DialogHeader>
        {clean ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-emerald-500" />
            Everything was exported exactly.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 text-xs" aria-label="Export summary">
              {ORDER.map((severity) => (
                <span
                  key={severity}
                  className={counts?.[severity] ? SEVERITY[severity].tone : 'text-muted-foreground'}
                >
                  {SEVERITY[severity].label}: {counts?.[severity] ?? 0}
                </span>
              ))}
            </div>
            <ul className="max-h-64 space-y-2 overflow-y-auto text-xs" aria-label="Export details">
              {groups.map(([code, group]) => (
                <li key={code} className="rounded-md border border-border/60 p-2">
                  <span className={`font-medium ${SEVERITY[group.severity].tone}`}>
                    {SEVERITY[group.severity].label}
                  </span>{' '}
                  {group.message}
                  {group.slides.size > 0 && (
                    <span className="text-muted-foreground">
                      {' '}
                      ({group.slides.size === 1 ? 'slide' : 'slides'}{' '}
                      {[...group.slides].sort((a, b) => a - b).join(', ')})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {report && report.fonts.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Fonts the file uses: {report.fonts.join(', ')}. A viewer without one substitutes its
            own, which can change where lines wrap.
          </p>
        )}
        {report && report.missingAssets.length > 0 && (
          <p className="text-xs text-destructive">
            Images not available: {report.missingAssets.join(', ')}
          </p>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
