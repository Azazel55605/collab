/**
 * The PowerPoint export report.
 *
 * Export never claims compatibility it does not have. Every element is either
 * exported as-is or recorded here as approximated, flattened, omitted, or
 * missing, and the UI shows these counts before or after saving.
 */

export type DeckExportSeverity = 'approximated' | 'flattened' | 'omitted' | 'missing';

export interface DeckExportEntry {
  severity: DeckExportSeverity;
  /** Stable machine-readable reason, for grouping in the UI. */
  code: string;
  message: string;
  slideId?: string;
  elementId?: string;
}

export interface DeckExportReport {
  slides: number;
  /** Elements written with no known loss. */
  exported: number;
  entries: DeckExportEntry[];
  /** Font families the file references; the viewer substitutes any it lacks. */
  fonts: string[];
  missingAssets: string[];
}

export class DeckExportReportBuilder {
  private exportedCount = 0;
  private readonly entries: DeckExportEntry[] = [];
  private readonly fonts = new Set<string>();
  private readonly missing = new Set<string>();
  /** Deck-wide notes recorded once, not once per slide. */
  private readonly once = new Set<string>();

  exported(): void {
    this.exportedCount += 1;
  }

  add(entry: DeckExportEntry): void {
    this.entries.push(entry);
  }

  addOnce(entry: DeckExportEntry): void {
    if (this.once.has(entry.code)) return;
    this.once.add(entry.code);
    this.entries.push(entry);
  }

  font(family: string): void {
    this.fonts.add(family);
  }

  missingAsset(path: string): void {
    this.missing.add(path);
  }

  build(slides: number): DeckExportReport {
    return {
      slides,
      exported: this.exportedCount,
      entries: [...this.entries],
      fonts: [...this.fonts].sort(),
      missingAssets: [...this.missing].sort(),
    };
  }
}

export function countBySeverity(report: DeckExportReport): Record<DeckExportSeverity, number> {
  const counts: Record<DeckExportSeverity, number> = {
    approximated: 0,
    flattened: 0,
    omitted: 0,
    missing: 0,
  };
  for (const entry of report.entries) counts[entry.severity] += 1;
  return counts;
}
