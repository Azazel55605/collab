import { AlertTriangle, ArrowRightLeft, Check, Info, XCircle } from 'lucide-react';

import type { SheetConversionReport, SheetConversionSeverity } from '../../types/sheetConversion';
import {
  groupConversionNotes,
  isLosslessConversion,
  SHEET_CONVERSION_SEVERITY_LABELS,
} from '../../types/sheetConversion';
import { ReportDialog, type ReviewTone } from '../ui/review-dialog';

/**
 * Shows what a `.xlsx`/`.csv` conversion actually did.
 *
 * The plan is explicit that Collab must never claim compatibility it does not
 * have, so this dialog is not optional decoration: it is how the user learns
 * that a formula was flattened or a chart was left behind, *before* relying on
 * the result.
 */

const SEVERITY_ICON: Record<SheetConversionSeverity, typeof Check> = {
  imported: Check,
  flattened: ArrowRightLeft,
  skipped: Info,
  unsupported: XCircle,
};

const CHIP_TONE: Record<SheetConversionSeverity, ReviewTone> = {
  imported: 'success',
  flattened: 'warning',
  skipped: 'neutral',
  unsupported: 'danger',
};

const SEVERITY_TONE: Record<SheetConversionSeverity, string> = {
  imported: 'text-emerald-500',
  flattened: 'text-amber-500',
  skipped: 'text-muted-foreground',
  unsupported: 'text-destructive',
};

export interface SheetConversionReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `Imported Budget.xlsx` / `Exported Budget.csv`. */
  title: string;
  /** Where the result went, shown under the title. */
  subtitle?: string;
  report: SheetConversionReport | null;
}

export default function SheetConversionReportDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  report,
}: SheetConversionReportDialogProps) {
  const groups = report ? groupConversionNotes(report) : [];
  const lossless = report ? isLosslessConversion(report) : false;

  const count = (severity: SheetConversionSeverity) =>
    groups.find((group) => group.severity === severity)?.notes.length ?? 0;
  const order: SheetConversionSeverity[] = ['unsupported', 'flattened', 'skipped', 'imported'];
  const notes = order.flatMap((severity) =>
    (groups.find((group) => group.severity === severity)?.notes ?? []).map((note, index) => {
      const Icon = SEVERITY_ICON[severity];
      return {
        key: `${severity}-${note.feature}-${index}`,
        icon: <Icon className={SEVERITY_TONE[severity]} />,
        title: (
          <>
            {note.feature}
            {note.location && (
              <span className="ml-1 text-xs text-muted-foreground">{note.location}</span>
            )}
            {note.count > 1 && (
              <span className="ml-1 text-xs text-muted-foreground">×{note.count}</span>
            )}
          </>
        ),
        detail: note.detail,
        chip: { label: SHEET_CONVERSION_SEVERITY_LABELS[severity], tone: CHIP_TONE[severity] },
      };
    }),
  );
  return (
    <ReportDialog
      open={open}
      onOpenChange={onOpenChange}
      outcome={lossless ? 'success' : 'warning'}
      title={title}
      description={`${subtitle ? `${subtitle} · ` : ''}${
        lossless
          ? 'Everything in this file was carried across.'
          : 'Converting between spreadsheet formats is not lossless. Check what changed before relying on the result.'
      }`}
      stats={
        report
          ? [
              {
                key: 'imported',
                label: 'Carried across',
                value: count('imported'),
                tone: 'success',
              },
              {
                key: 'flattened',
                label: 'Flattened',
                value: count('flattened'),
                tone: count('flattened') ? 'warning' : 'neutral',
              },
              {
                key: 'unsupported',
                label: 'Left out',
                value: count('unsupported') + count('skipped'),
                tone: count('unsupported') ? 'danger' : 'neutral',
              },
            ]
          : []
      }
      itemsLabel="Details"
      items={notes}
      emptyText="No details were reported."
      doneLabel="Close"
    >
      {report?.truncated && (
        <p className="flex items-start gap-2 rounded-[10px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
          Some content was left out because it exceeded a Collab limit, not because it is
          unsupported. The original file is unchanged.
        </p>
      )}
    </ReportDialog>
  );
}
