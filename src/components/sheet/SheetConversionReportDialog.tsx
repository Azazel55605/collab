import { AlertTriangle, ArrowRightLeft, Check, Info, XCircle } from 'lucide-react';

import type {
  SheetConversionReport,
  SheetConversionSeverity,
} from '../../types/sheetConversion';
import {
  SHEET_CONVERSION_SEVERITY_LABELS,
  groupConversionNotes,
  isLosslessConversion,
} from '../../types/sheetConversion';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {subtitle ? `${subtitle} · ` : ''}
            {lossless
              ? 'Everything in this file was carried across.'
              : 'Conversion between spreadsheet formats is not lossless. Review what changed before relying on the result.'}
          </DialogDescription>
        </DialogHeader>

        {report?.truncated && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
            <span>
              Some content was left out because it exceeded a Collab limit, not because it is
              unsupported. The original file is unchanged.
            </span>
          </div>
        )}

        <div className="max-h-80 space-y-4 overflow-y-auto pr-1">
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">No details were reported.</p>
          )}
          {groups.map((group) => {
            const Icon = SEVERITY_ICON[group.severity];
            return (
              <section key={group.severity} className="space-y-1.5">
                <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Icon size={13} className={SEVERITY_TONE[group.severity]} />
                  {SHEET_CONVERSION_SEVERITY_LABELS[group.severity]}
                </h3>
                <ul className="space-y-1.5">
                  {group.notes.map((note, index) => (
                    <li key={`${note.feature}-${index}`} className="text-sm">
                      <span className="font-medium">{note.feature}</span>
                      {note.location && (
                        <span className="ml-1 text-xs text-muted-foreground">{note.location}</span>
                      )}
                      {note.count > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ×{note.count}
                        </span>
                      )}
                      <p className="text-xs text-muted-foreground">{note.detail}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
