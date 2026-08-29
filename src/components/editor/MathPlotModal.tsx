import { useEffect, useMemo, useState } from 'react';

import { RotateCcw } from 'lucide-react';

import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';

import { MathPlot2D } from './MathPlot2D';
import { MathPlot3D } from './MathPlot3D';
import {
  type MathPlotDomain,
  type MathPlotSpec,
  PLOT_2D_MAX_SAMPLES,
  PLOT_3D_MAX_SAMPLES,
  PLOT_MIN_SAMPLES,
} from './mathPlotSpec';

interface MathPlotModalProps {
  spec: MathPlotSpec | null;
  onOpenChange: (open: boolean) => void;
}

// ─── Global open bus ────────────────────────────────────────────────────────
// The math plots render in several places, including a detached React root
// inside a CodeMirror live-preview widget, so they cannot share React state with
// a modal mounted in the app tree. A tiny module-level bus lets any plot request
// the modal, which is rendered once by <MathPlotModalHost /> near the app root.

type MathPlotModalListener = (spec: MathPlotSpec) => void;
const mathPlotModalListeners = new Set<MathPlotModalListener>();

export function openMathPlotModal(spec: MathPlotSpec) {
  for (const listener of mathPlotModalListeners) listener(spec);
}

function subscribeMathPlotModal(listener: MathPlotModalListener) {
  mathPlotModalListeners.add(listener);
  return () => {
    mathPlotModalListeners.delete(listener);
  };
}

/** Mount once (near the app root). Renders the plot modal on demand for any plot. */
export function MathPlotModalHost() {
  const [spec, setSpec] = useState<MathPlotSpec | null>(null);
  useEffect(() => subscribeMathPlotModal(setSpec), []);
  return (
    <MathPlotModal
      spec={spec}
      onOpenChange={(open) => {
        if (!open) setSpec(null);
      }}
    />
  );
}

function clampSamples(value: number, max: number) {
  return Math.min(Math.max(Math.round(value), PLOT_MIN_SAMPLES), max);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** A pair of numeric inputs editing a { min, max } domain. */
function DomainField({
  label,
  domain,
  onChange,
}: {
  label: string;
  domain: MathPlotDomain;
  onChange: (next: MathPlotDomain) => void;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          aria-label={`${label} minimum`}
          value={Number.isFinite(domain.min) ? domain.min : ''}
          step="any"
          className="h-8"
          onChange={(event) => {
            const min = Number(event.target.value);
            if (Number.isFinite(min)) onChange({ ...domain, min });
          }}
        />
        <span className="text-muted-foreground/60">to</span>
        <Input
          type="number"
          aria-label={`${label} maximum`}
          value={Number.isFinite(domain.max) ? domain.max : ''}
          step="any"
          className="h-8"
          onChange={(event) => {
            const max = Number(event.target.value);
            if (Number.isFinite(max)) onChange({ ...domain, max });
          }}
        />
      </div>
    </div>
  );
}

export function MathPlotModal({ spec, onOpenChange }: MathPlotModalProps) {
  const [draft, setDraft] = useState<MathPlotSpec | null>(spec);

  // Re-seed the editable copy whenever a new plot is opened.
  useEffect(() => {
    setDraft(spec);
  }, [spec]);

  const maxSamples = draft?.kind === '3d' ? PLOT_3D_MAX_SAMPLES : PLOT_2D_MAX_SAMPLES;

  const rangeValid = useMemo(() => {
    if (!draft) return false;
    if (draft.x.min >= draft.x.max) return false;
    if (draft.kind === '3d' && draft.y.min >= draft.y.max) return false;
    return true;
  }, [draft]);

  if (!spec || !draft) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent />
      </Dialog>
    );
  }

  const updateDraft = (patch: Partial<MathPlotSpec>) => {
    setDraft((prev) => (prev ? ({ ...prev, ...patch } as MathPlotSpec) : prev));
  };

  const manualVertical = draft.kind === '2d' ? Boolean(draft.yDomain) : Boolean(draft.zDomain);
  const verticalDomain = draft.kind === '2d' ? draft.yDomain : draft.zDomain;
  const verticalLabel = draft.kind === '2d' ? 'y-axis' : 'z-axis';
  const outputVar = draft.kind === '2d' ? 'y' : 'z';

  const setManualVertical = (enabled: boolean) => {
    if (!enabled) {
      setDraft((prev) => {
        if (!prev) return prev;
        if (prev.kind === '2d') return { ...prev, yDomain: undefined };
        return { ...prev, zDomain: undefined };
      });
      return;
    }
    // Seed the manual range from a sensible default so both inputs are populated.
    const seed: MathPlotDomain = verticalDomain ?? { min: -5, max: 5 };
    setDraft((prev) => {
      if (!prev) return prev;
      if (prev.kind === '2d') return { ...prev, yDomain: seed };
      return { ...prev, zDomain: seed };
    });
  };

  const setVerticalDomain = (next: MathPlotDomain) => {
    setDraft((prev) => {
      if (!prev) return prev;
      if (prev.kind === '2d') return { ...prev, yDomain: next };
      return { ...prev, zDomain: next };
    });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(80rem,calc(100%-2rem))] max-w-none overflow-y-auto sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{draft.kind === '2d' ? '2D plot' : '3D plot'}</DialogTitle>
          <DialogDescription className="font-mono text-foreground/80">
            {outputVar} = {draft.expression || '(empty)'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 lg:flex-row">
          {/* Plot */}
          <div className="min-w-0 flex-1">
            {rangeValid ? (
              draft.kind === '2d' ? (
                <MathPlot2D spec={draft} variant="modal" />
              ) : (
                <MathPlot3D spec={draft} variant="modal" />
              )
            ) : (
              <div className="flex h-[540px] items-center justify-center rounded-lg border border-destructive/35 bg-destructive/8 px-4 text-center text-xs text-destructive">
                Each axis minimum must be less than its maximum.
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex w-full shrink-0 flex-col gap-3 lg:w-72">
            <Field label="Expression">
              <Input
                value={draft.expression}
                spellCheck={false}
                className="h-8 font-mono"
                onChange={(event) => updateDraft({ expression: event.target.value })}
              />
            </Field>

            <DomainField label="x range" domain={draft.x} onChange={(x) => updateDraft({ x })} />

            {draft.kind === '3d' && (
              <DomainField
                label="y range"
                domain={draft.y}
                onChange={(y) => updateDraft({ y } as Partial<MathPlotSpec>)}
              />
            )}

            <Field label={`Sample rate — ${draft.samples}`}>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={PLOT_MIN_SAMPLES}
                  max={maxSamples}
                  value={draft.samples}
                  className="h-8 flex-1 accent-primary"
                  onChange={(event) =>
                    updateDraft({ samples: clampSamples(Number(event.target.value), maxSamples) })
                  }
                />
                <Input
                  type="number"
                  aria-label="Sample rate"
                  min={PLOT_MIN_SAMPLES}
                  max={maxSamples}
                  value={draft.samples}
                  className="h-8 w-20"
                  onChange={(event) =>
                    updateDraft({ samples: clampSamples(Number(event.target.value), maxSamples) })
                  }
                />
              </div>
            </Field>

            <div className="flex flex-col gap-2 rounded-md border border-border/45 p-2.5">
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={manualVertical}
                  onChange={(event) => setManualVertical(event.target.checked)}
                />
                <span>Manual {verticalLabel} limits</span>
              </label>
              {manualVertical && verticalDomain && (
                <DomainField
                  label={`${verticalLabel} range`}
                  domain={verticalDomain}
                  onChange={setVerticalDomain}
                />
              )}
              {!manualVertical && (
                <p className="text-[11px] text-muted-foreground/70">
                  Auto-fit to the sampled {outputVar} values.
                </p>
              )}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1 gap-1.5"
              onClick={() => setDraft(spec)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to note
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
