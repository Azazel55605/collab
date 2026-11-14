import { useMemo } from 'react';

import { AlertTriangle } from 'lucide-react';

import { countBySeverity } from '../../lib/deck/pptx/exportReport';
import type { DeckExportReport, DeckExportSeverity } from '../../lib/deck/pptx/exportReport';
import { ReportDialog, type ReviewTone } from '../ui/review-dialog';

interface DeckExportReportDialogProps {
  outcome: { report: DeckExportReport; fileName: string } | null;
  /** 1-based slide numbers by slide id, to say where an entry applies. */
  slideNumbers: ReadonlyMap<string, number>;
  onClose: () => void;
  onReturnFocus?: () => void;
}

const SEVERITY: Record<DeckExportSeverity, { label: string; tone: ReviewTone }> = {
  approximated: { label: 'Approximated', tone: 'info' },
  flattened: { label: 'Flattened', tone: 'warning' },
  omitted: { label: 'Omitted', tone: 'warning' },
  missing: { label: 'Missing', tone: 'danger' },
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

  const changed = report ? report.entries.length : 0;
  return (
    <ReportDialog
      open={outcome !== null}
      onOpenChange={(open) => !open && onClose()}
      onCloseAutoFocus={
        onReturnFocus
          ? (event) => {
              event.preventDefault();
              onReturnFocus();
            }
          : undefined
      }
      outcome={clean ? 'success' : counts?.missing ? 'warning' : 'success'}
      title="Exported to PowerPoint"
      description={`${outcome?.fileName ?? ''} · ${report?.slides ?? 0} ${report?.slides === 1 ? 'slide' : 'slides'}`}
      statsLabel="Export summary"
      stats={
        report
          ? [
              { key: 'slides', label: 'Slides', value: report.slides },
              { key: 'exact', label: 'Written exactly', value: report.exported, tone: 'success' },
              {
                key: 'changed',
                label: 'Changed in the copy',
                value: changed,
                tone: changed ? 'warning' : 'neutral',
              },
            ]
          : []
      }
      itemsLabel={clean ? undefined : 'What changed in the copy'}
      listLabel="Export details"
      emptyText={clean ? 'Everything was exported exactly.' : undefined}
      items={groups.map(([code, group]) => ({
        key: code,
        icon: <AlertTriangle />,
        title: group.message,
        detail:
          group.slides.size > 0
            ? `${group.slides.size === 1 ? 'Slide' : 'Slides'} ${[...group.slides].sort((a, b) => a - b).join(', ')}`
            : undefined,
        chip: { label: SEVERITY[group.severity].label, tone: SEVERITY[group.severity].tone },
      }))}
    >
      {report && report.fonts.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Fonts the file uses: {report.fonts.join(', ')}. A viewer without one substitutes its own,
          which can change where lines wrap.
        </p>
      )}
      {report && report.missingAssets.length > 0 && (
        <p className="text-xs text-destructive">
          Images not available: {report.missingAssets.join(', ')}
        </p>
      )}
    </ReportDialog>
  );
}
