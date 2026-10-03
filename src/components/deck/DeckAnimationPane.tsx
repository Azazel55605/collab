import { useEffect, useMemo, useState } from 'react';

import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';

import {
  animationEffectLabel,
  animationEffectsForPhase,
  animationTimeline,
} from '../../lib/deck/animation';
import type { DeckAnimation, DeckDocument } from '../../types/deck';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface DeckAnimationPaneProps {
  deck: DeckDocument;
  slideId: string;
  selectedElementId?: string;
  readOnly: boolean;
  onClose: () => void;
  onSelectElement: (elementId: string) => void;
  onAnimationAdd: (elementId: string) => void;
  onAnimationsChange: (animations: DeckAnimation[]) => void;
}

const phaseLabel: Record<DeckAnimation['phase'], string> = {
  entrance: 'Entrance',
  emphasis: 'Emphasis',
  exit: 'Exit',
};

const triggerLabel: Record<DeckAnimation['trigger'], string> = {
  click: 'On click',
  withPrevious: 'With previous',
  afterPrevious: 'After previous',
};

function AnimationNumberField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Math.min(60, Math.max(0, Number(draft) || 0));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="space-y-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min="0"
        max="60"
        step="0.1"
        className="h-7 text-xs"
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/**
 * A PowerPoint-style animation pane kept separate from object/design settings.
 * The visible tree is compiled from the stored ordered timeline: roots are
 * slide entry and click steps, and their children are effects in playback order.
 */
export function DeckAnimationPane({
  deck,
  slideId,
  selectedElementId,
  readOnly,
  onClose,
  onSelectElement,
  onAnimationAdd,
  onAnimationsChange,
}: DeckAnimationPaneProps) {
  const slide = deck.slides[slideId];
  const animations = useMemo(() => slide?.animations ?? [], [slide?.animations]);
  const [selectedAnimationId, setSelectedAnimationId] = useState<string | null>(
    animations[0]?.id ?? null,
  );
  useEffect(() => {
    if (selectedAnimationId && animations.some(({ id }) => id === selectedAnimationId)) return;
    setSelectedAnimationId(animations[0]?.id ?? null);
  }, [animations, selectedAnimationId]);

  const timeline = useMemo(() => animationTimeline(animations), [animations]);
  const groups = useMemo(() => {
    const next = new Map<number, typeof timeline.cues>();
    for (const cue of timeline.cues) next.set(cue.step, [...(next.get(cue.step) ?? []), cue]);
    return [...next.entries()];
  }, [timeline]);
  const selectedIndex = animations.findIndex(({ id }) => id === selectedAnimationId);
  const selected = selectedIndex >= 0 ? animations[selectedIndex] : null;
  const selectedEffectChoices = selected ? [...animationEffectsForPhase(selected.phase)] : [];
  if (selected && !selectedEffectChoices.some(({ value }) => value === selected.effect)) {
    selectedEffectChoices.unshift({
      value: selected.effect,
      label: animationEffectLabel(selected.effect),
    });
  }

  const update = (index: number, patch: Partial<DeckAnimation>) =>
    onAnimationsChange(
      animations.map((animation, at) => (at === index ? { ...animation, ...patch } : animation)),
    );
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= animations.length) return;
    const next = [...animations];
    [next[index], next[to]] = [next[to], next[index]];
    onAnimationsChange(next);
  };
  const remove = (index: number) => {
    const next = animations.filter((_, at) => at !== index);
    setSelectedAnimationId(next[Math.min(index, next.length - 1)]?.id ?? null);
    onAnimationsChange(next);
  };

  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-l border-border/50 bg-card/40"
      aria-label="Animation pane"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Animations</h2>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close animation pane"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mb-3 h-8 w-full gap-1.5 text-xs"
          disabled={readOnly || !selectedElementId || animations.length >= 200}
          onClick={() => selectedElementId && onAnimationAdd(selectedElementId)}
        >
          <Plus className="size-3.5" />
          {selectedElementId ? 'Add animation to selection' : 'Select an object to animate'}
        </Button>

        {groups.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 p-3 text-xs text-muted-foreground">
            This slide has no object animations. Select an object, then add its first effect.
          </p>
        ) : (
          <div className="space-y-3" role="tree" aria-label="Animation sequence">
            {groups.map(([step, cues]) => (
              <section key={step} role="treeitem" aria-expanded="true">
                <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground uppercase">
                  <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] text-foreground">
                    {step === 0 ? 'A' : step}
                  </span>
                  {step === 0 ? 'On slide open' : `Click ${step}`}
                </div>
                <ol className="ml-2.5 space-y-1 border-l border-border/70 pl-3" role="group">
                  {cues.map((cue) => {
                    const index = animations.findIndex(({ id }) => id === cue.id);
                    const active = cue.id === selectedAnimationId;
                    const element = slide.elements[cue.elementId];
                    return (
                      <li key={cue.id}>
                        <button
                          type="button"
                          className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                            active
                              ? 'border-primary/60 bg-primary/10'
                              : 'border-border/60 bg-background/40 hover:bg-muted/60'
                          }`}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => {
                            setSelectedAnimationId(cue.id);
                            onSelectElement(cue.elementId);
                          }}
                        >
                          <span className="block truncate font-medium">
                            {index + 1}. {element?.name ?? cue.elementId}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {phaseLabel[cue.phase]} · {animationEffectLabel(cue.effect)} ·{' '}
                            {triggerLabel[cue.trigger]}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}

        {selected && selectedIndex >= 0 && (
          <section
            className="mt-4 space-y-2 border-t border-border/50 pt-3"
            aria-label="Selected animation"
          >
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                {slide.elements[selected.elementId]?.name ?? selected.elementId}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Move animation up"
                disabled={readOnly || selectedIndex === 0}
                onClick={() => move(selectedIndex, -1)}
              >
                <ArrowUp className="size-3" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Move animation down"
                disabled={readOnly || selectedIndex === animations.length - 1}
                onClick={() => move(selectedIndex, 1)}
              >
                <ArrowDown className="size-3" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Remove animation"
                disabled={readOnly}
                onClick={() => remove(selectedIndex)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <Select
                value={selected.phase}
                disabled={readOnly}
                onValueChange={(value) => {
                  const phase = value as DeckAnimation['phase'];
                  const effects = animationEffectsForPhase(phase);
                  update(selectedIndex, {
                    phase,
                    effect: effects.some(({ value: effect }) => effect === selected.effect)
                      ? selected.effect
                      : effects[0].value,
                  });
                }}
              >
                <SelectTrigger size="sm" aria-label="Animation phase">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="entrance">Entrance</SelectItem>
                  <SelectItem value="emphasis">Emphasis</SelectItem>
                  <SelectItem value="exit">Exit</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={selected.effect}
                disabled={readOnly}
                onValueChange={(value) =>
                  update(selectedIndex, { effect: value as DeckAnimation['effect'] })
                }
              >
                <SelectTrigger size="sm" aria-label="Animation effect">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedEffectChoices.map((effect) => (
                    <SelectItem key={effect.value} value={effect.value}>
                      {effect.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Select
              value={selected.trigger}
              disabled={readOnly}
              onValueChange={(value) =>
                update(selectedIndex, { trigger: value as DeckAnimation['trigger'] })
              }
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Animation trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="click">On click</SelectItem>
                <SelectItem value="withPrevious">With previous</SelectItem>
                <SelectItem value="afterPrevious">After previous</SelectItem>
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <AnimationNumberField
                label="Duration (s)"
                value={selected.durationMs / 1_000}
                disabled={readOnly}
                onCommit={(value) =>
                  update(selectedIndex, { durationMs: Math.round(value * 1_000) })
                }
              />
              <AnimationNumberField
                label="Delay (s)"
                value={(selected.delayMs ?? 0) / 1_000}
                disabled={readOnly}
                onCommit={(value) => update(selectedIndex, { delayMs: Math.round(value * 1_000) })}
              />
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
