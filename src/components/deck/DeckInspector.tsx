import { useEffect, useState } from 'react';

import { ArrowDown, ArrowUp, LayoutTemplate, Palette, Play, RotateCcw, Trash2 } from 'lucide-react';

import { orderedLayouts } from '../../lib/deck/design';
import { effectiveFamily, fontChoices, isFontAvailable } from '../../lib/deck/fonts';
import { DECK_TEMPLATES } from '../../lib/deck/templates';
import type { DeckTemplateId } from '../../lib/deck/templates';
import { THEME_COLOR_LABELS } from '../../lib/deck/themeColors';
import { cn } from '../../lib/utils';
import { DECK_THEME_COLOR_TOKENS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type {
  DeckAnimation,
  DeckColor,
  DeckDocument,
  DeckElement,
  DeckFill,
  DeckRunStyle,
  DeckTextLevelStyle,
  DeckTheme,
  DeckThemeColorToken,
  DeckThemeFontRole,
  DeckTransition,
} from '../../types/deck';
import { Button } from '../ui/button';
import { ColorPicker } from '../ui/color-picker';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export type MasterTextClass = 'title' | 'body' | 'other';

export interface MasterTextStylePatch {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: DeckColor;
  font?: { theme: DeckThemeFontRole };
  bullet?: string | null;
  indent?: number;
}

interface DeckInspectorProps {
  deck: DeckDocument;
  /** The slide(s) the Slide section acts on; empty in the design editor. */
  slideIds: string[];
  /** The layout or master open in the design editor, if any. */
  design: { kind: 'layout' | 'master'; id: string } | null;
  readOnly: boolean;
  canResetSlide: boolean;
  onSlideLayout: (layoutId: string) => void;
  onResetSlide: () => void;
  onSlideBackground: (fill: DeckFill | null) => void;
  onTransitionChange: (transition: DeckTransition | null) => void;
  onTransitionPreview: () => void;
  onAnimationAdd: (elementId: string) => void;
  onAnimationsChange: (animations: DeckAnimation[]) => void;
  onApplyTemplate: (templateId: DeckTemplateId) => void;
  onThemeColor: (token: DeckThemeColorToken, hex: string) => void;
  onThemeFont: (role: DeckThemeFontRole, family: string) => void;
  onEditDesign: () => void;
  onLayoutChange: (patch: { name?: string; showMasterElements?: boolean }) => void;
  onDesignBackground: (fill: DeckFill | null) => void;
  onMasterTextStyle: (
    textClass: MasterTextClass,
    level: number,
    patch: MasterTextStylePatch,
  ) => void;
  /** The one selected object, for position, size, and alt text. */
  object?: {
    element: DeckElement;
    frame: { x: number; y: number; width: number; height: number; rotation: number };
  } | null;
  onObjectFrame?: (
    patch: Partial<{ x: number; y: number; width: number; height: number; rotation: number }>,
  ) => void;
  onObjectText?: (patch: { altText?: string; name?: string }) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border/40 px-3 py-3">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function fillColor(fill: DeckFill | undefined, theme: DeckTheme): string | null {
  if (!fill || fill.kind !== 'solid') return null;
  return fill.color.kind === 'rgb' ? fill.color.value : theme.colors[fill.color.token];
}

/** Background choice: inherit, a theme colour, or a custom colour. */
function BackgroundPicker({
  theme,
  value,
  inheritLabel,
  disabled,
  onChange,
}: {
  theme: DeckTheme;
  value: DeckFill | undefined;
  inheritLabel: string;
  disabled: boolean;
  onChange: (fill: DeckFill | null) => void;
}) {
  const current = fillColor(value, theme);
  const token = value?.kind === 'solid' && value.color.kind === 'theme' ? value.color.token : null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-6 gap-1">
        {(['light1', 'light2', 'dark1', 'dark2', 'accent1', 'accent2'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            disabled={disabled}
            aria-label={`Background ${THEME_COLOR_LABELS[entry]}`}
            aria-pressed={token === entry}
            title={THEME_COLOR_LABELS[entry]}
            className={cn(
              'h-6 rounded border border-border/60',
              token === entry && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
            )}
            style={{ backgroundColor: theme.colors[entry] }}
            onClick={() => onChange({ kind: 'solid', color: { kind: 'theme', token: entry } })}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <ColorPicker
          label="Custom background"
          value={current ?? '#ffffff'}
          disabled={disabled}
          align="start"
          onValueChange={(hex) =>
            onChange({
              kind: 'solid',
              color: { kind: 'rgb', value: hex.slice(0, 7).toLowerCase() },
            })
          }
        />
        <Button
          type="button"
          size="sm"
          variant={value ? 'ghost' : 'secondary'}
          className="h-7 text-xs"
          disabled={disabled || !value}
          onClick={() => onChange(null)}
        >
          {inheritLabel}
        </Button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  disabled,
  signed = false,
  allowZero = false,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  disabled: boolean;
  /** Accepts zero and negative values (positions, rotation). */
  signed?: boolean;
  allowZero?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (
      Number.isFinite(parsed) &&
      (signed || parsed > 0 || (allowZero && parsed === 0)) &&
      parsed !== value
    )
      onCommit(parsed);
    else setDraft(value === undefined ? '' : String(value));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        aria-label={label}
        className="h-7 w-20 text-xs"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

function AnimationSection({
  slide,
  selectedElementId,
  readOnly,
  onTransitionChange,
  onTransitionPreview,
  onAnimationAdd,
  onAnimationsChange,
}: {
  slide: NonNullable<DeckDocument['slides'][string]>;
  selectedElementId?: string;
  readOnly: boolean;
  onTransitionChange: DeckInspectorProps['onTransitionChange'];
  onTransitionPreview: DeckInspectorProps['onTransitionPreview'];
  onAnimationAdd: DeckInspectorProps['onAnimationAdd'];
  onAnimationsChange: DeckInspectorProps['onAnimationsChange'];
}) {
  const animations = slide.animations ?? [];
  const transition = slide.transition ?? { kind: 'none' as const, durationMs: 350 };
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

  return (
    <Section title="Transitions and animations">
      <div className="flex items-center gap-1.5">
        <Select
          value={transition.kind}
          disabled={readOnly}
          onValueChange={(kind) =>
            onTransitionChange(
              kind === 'none'
                ? null
                : {
                    kind: kind as Exclude<DeckTransition['kind'], 'none'>,
                    durationMs: transition.durationMs,
                  },
            )
          }
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Slide transition">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No transition</SelectItem>
            <SelectItem value="fade">Fade</SelectItem>
            <SelectItem value="push">Push</SelectItem>
            <SelectItem value="wipe">Wipe</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Preview transition"
          title="Preview transition"
          disabled={transition.kind === 'none'}
          onClick={onTransitionPreview}
        >
          <Play className="size-3.5" />
        </Button>
      </div>
      {transition.kind !== 'none' && (
        <NumberField
          label="Transition (s)"
          value={transition.durationMs / 1_000}
          disabled={readOnly}
          onCommit={(seconds) =>
            onTransitionChange({ ...transition, durationMs: Math.round(seconds * 1_000) })
          }
        />
      )}

      <div className="pt-1 text-xs text-muted-foreground">Build timeline</div>
      {animations.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No object animations on this slide.</p>
      ) : (
        <div className="space-y-2">
          {animations.map((animation, index) => {
            const element = slide.elements[animation.elementId];
            return (
              <div
                key={animation.id}
                className="space-y-1.5 rounded-md border border-border/60 p-2"
              >
                <div className="flex items-center gap-1 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {index + 1}. {element?.name ?? animation.elementId}
                  </span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move animation up"
                    disabled={readOnly || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move animation down"
                    disabled={readOnly || index === animations.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove animation"
                    disabled={readOnly}
                    onClick={() => onAnimationsChange(animations.filter((_, at) => at !== index))}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <Select
                    value={animation.phase}
                    disabled={readOnly}
                    onValueChange={(phase) =>
                      update(index, { phase: phase as DeckAnimation['phase'] })
                    }
                  >
                    <SelectTrigger size="sm" aria-label={`Animation ${index + 1} phase`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="entrance">Entrance</SelectItem>
                      <SelectItem value="emphasis">Emphasis</SelectItem>
                      <SelectItem value="exit">Exit</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={animation.effect}
                    disabled={readOnly}
                    onValueChange={(effect) =>
                      update(index, { effect: effect as DeckAnimation['effect'] })
                    }
                  >
                    <SelectTrigger size="sm" aria-label={`Animation ${index + 1} effect`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="appear">Appear</SelectItem>
                      <SelectItem value="fade">Fade</SelectItem>
                      <SelectItem value="fly">Fly / motion</SelectItem>
                      <SelectItem value="zoom">Zoom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Select
                  value={animation.trigger}
                  disabled={readOnly}
                  onValueChange={(trigger) =>
                    update(index, { trigger: trigger as DeckAnimation['trigger'] })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    aria-label={`Animation ${index + 1} trigger`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="click">On click</SelectItem>
                    <SelectItem value="withPrevious">With previous</SelectItem>
                    <SelectItem value="afterPrevious">After previous</SelectItem>
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="Duration (s)"
                    value={animation.durationMs / 1_000}
                    disabled={readOnly}
                    onCommit={(seconds) =>
                      update(index, { durationMs: Math.round(seconds * 1_000) })
                    }
                  />
                  <NumberField
                    label="Delay (s)"
                    value={(animation.delayMs ?? 0) / 1_000}
                    disabled={readOnly}
                    allowZero
                    onCommit={(seconds) => update(index, { delayMs: Math.round(seconds * 1_000) })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-7 w-full text-xs"
        disabled={readOnly || !selectedElementId || animations.length >= 200}
        onClick={() => selectedElementId && onAnimationAdd(selectedElementId)}
      >
        {selectedElementId ? 'Animate selected object' : 'Select one object to animate'}
      </Button>
    </Section>
  );
}

function MasterTextStyles({
  deck,
  masterId,
  readOnly,
  onChange,
}: {
  deck: DeckDocument;
  masterId: string;
  readOnly: boolean;
  onChange: DeckInspectorProps['onMasterTextStyle'];
}) {
  const master = deck.masters[masterId];
  const theme = deck.themes[master.themeId ?? deck.themeId] ?? deck.themes[deck.themeId];
  const [selected, setSelected] = useState('title:0');
  const [textClass, levelText] = selected.split(':') as [MasterTextClass, string];
  const level = Number(levelText);
  const entry: DeckTextLevelStyle =
    master.textStyles[textClass][Math.min(level, master.textStyles[textClass].length - 1)] ?? {};
  const run: DeckRunStyle = entry.run ?? {};
  const role = typeof run.font === 'object' ? run.font.theme : undefined;
  const color = run.color?.kind === 'theme' ? run.color.token : run.color ? 'custom' : undefined;
  const bullet = entry.paragraph?.list?.kind === 'bullet' ? (entry.paragraph.list.char ?? '•') : '';
  return (
    <div className="space-y-2">
      <Select value={selected} onValueChange={setSelected}>
        <SelectTrigger size="sm" className="w-full" aria-label="Text style">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="title:0">Title</SelectItem>
          <SelectItem value="body:0">Body, level 1</SelectItem>
          <SelectItem value="body:1">Body, level 2</SelectItem>
          <SelectItem value="body:2">Body, level 3</SelectItem>
          <SelectItem value="other:0">Other text</SelectItem>
        </SelectContent>
      </Select>
      <NumberField
        label="Size (pt)"
        value={run.size !== undefined ? run.size / DECK_UNITS_PER_POINT : undefined}
        disabled={readOnly}
        onCommit={(points) =>
          onChange(textClass, level, { size: Math.round(points * DECK_UNITS_PER_POINT) })
        }
      />
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Font</span>
        <Select
          value={role}
          disabled={readOnly}
          onValueChange={(value) =>
            onChange(textClass, level, { font: { theme: value as DeckThemeFontRole } })
          }
        >
          <SelectTrigger size="sm" className="w-32" aria-label="Theme font">
            <SelectValue placeholder="Custom" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="heading">Headings</SelectItem>
            <SelectItem value="body">Body</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant={run.bold ? 'secondary' : 'ghost'}
          aria-pressed={run.bold === true}
          className="h-7 px-2 text-xs font-bold"
          disabled={readOnly}
          onClick={() => onChange(textClass, level, { bold: !run.bold })}
        >
          Bold
        </Button>
        <Button
          type="button"
          size="sm"
          variant={run.italic ? 'secondary' : 'ghost'}
          aria-pressed={run.italic === true}
          className="h-7 px-2 text-xs italic"
          disabled={readOnly}
          onClick={() => onChange(textClass, level, { italic: !run.italic })}
        >
          Italic
        </Button>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {(['dark1', 'dark2', 'light1', 'light2', 'accent1', 'accent2'] as const).map((token) => (
          <button
            key={token}
            type="button"
            disabled={readOnly}
            aria-label={`Text colour ${THEME_COLOR_LABELS[token]}`}
            aria-pressed={color === token}
            className={cn(
              'h-6 rounded border border-border/60',
              color === token && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
            )}
            style={{ backgroundColor: theme.colors[token] }}
            onClick={() => onChange(textClass, level, { color: { kind: 'theme', token } })}
          />
        ))}
      </div>
      {textClass === 'body' && (
        <>
          <label className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Bullet</span>
            <Input
              aria-label="Bullet character"
              className="h-7 w-20 text-center text-xs"
              maxLength={2}
              value={bullet}
              disabled={readOnly}
              onChange={(event) =>
                onChange(textClass, level, {
                  bullet: Array.from(event.target.value).slice(-1)[0] ?? null,
                })
              }
            />
          </label>
          <NumberField
            label="Indent (pt)"
            value={
              entry.paragraph?.indent !== undefined
                ? entry.paragraph.indent / DECK_UNITS_PER_POINT
                : undefined
            }
            disabled={readOnly}
            onCommit={(points) =>
              onChange(textClass, level, { indent: Math.round(points * DECK_UNITS_PER_POINT) })
            }
          />
        </>
      )}
    </div>
  );
}

const POINTS = (units: number) => Math.round((units / DECK_UNITS_PER_POINT) * 10) / 10;

/** Position, size, rotation, name, and alt text of one selected object. */
function ObjectSection({
  object,
  readOnly,
  onFrame,
  onText,
}: {
  object: NonNullable<DeckInspectorProps['object']>;
  readOnly: boolean;
  onFrame: NonNullable<DeckInspectorProps['onObjectFrame']>;
  onText: NonNullable<DeckInspectorProps['onObjectText']>;
}) {
  const { element, frame } = object;
  const [alt, setAlt] = useState(element.altText ?? '');
  useEffect(() => setAlt(element.altText ?? ''), [element.altText]);
  const isLine = element.type === 'line';
  const toUnits = (points: number) => Math.round(points * DECK_UNITS_PER_POINT);
  return (
    <Section title="Position and size">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        <NumberField
          label="X (pt)"
          signed
          value={POINTS(frame.x)}
          disabled={readOnly}
          onCommit={(value) => onFrame({ x: toUnits(value) })}
        />
        <NumberField
          label="Y (pt)"
          signed
          value={POINTS(frame.y)}
          disabled={readOnly}
          onCommit={(value) => onFrame({ y: toUnits(value) })}
        />
        {!isLine && (
          <>
            <NumberField
              label="W (pt)"
              value={POINTS(frame.width)}
              disabled={readOnly}
              onCommit={(value) => onFrame({ width: toUnits(value) })}
            />
            <NumberField
              label="H (pt)"
              value={POINTS(frame.height)}
              disabled={readOnly}
              onCommit={(value) => onFrame({ height: toUnits(value) })}
            />
            <NumberField
              label="Angle (°)"
              signed
              value={Math.round(frame.rotation) / 100}
              disabled={readOnly}
              onCommit={(value) => onFrame({ rotation: Math.round(value * 100) })}
            />
          </>
        )}
      </div>
      <label className="flex flex-col gap-1 pt-1 text-xs">
        <span className="text-muted-foreground">Alt text</span>
        <textarea
          aria-label="Alt text"
          className="min-h-14 rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring"
          maxLength={4_096}
          placeholder="Describe this for people who cannot see it"
          value={alt}
          disabled={readOnly}
          onChange={(event) => setAlt(event.target.value)}
          onBlur={() => {
            if (alt !== (element.altText ?? '')) onText({ altText: alt });
          }}
        />
      </label>
    </Section>
  );
}

/**
 * The editor's right panel: the current slide's layout and background, and
 * the deck's design — template, theme colours and fonts — or, in the design
 * editor, the open layout or master's own settings.
 */
export function DeckInspector({
  deck,
  slideIds,
  design,
  readOnly,
  canResetSlide,
  onSlideLayout,
  onResetSlide,
  onSlideBackground,
  onTransitionChange,
  onTransitionPreview,
  onAnimationAdd,
  onAnimationsChange,
  onApplyTemplate,
  onThemeColor,
  onThemeFont,
  onEditDesign,
  onLayoutChange,
  onDesignBackground,
  onMasterTextStyle,
  object,
  onObjectFrame,
  onObjectText,
}: DeckInspectorProps) {
  const theme = deck.themes[deck.themeId];
  const slide = slideIds.length > 0 ? deck.slides[slideIds[0]] : undefined;
  const layouts = orderedLayouts(deck);
  const layoutValue =
    slideIds.length > 0 && slideIds.every((id) => deck.slides[id]?.layoutId === slide?.layoutId)
      ? slide?.layoutId
      : undefined;
  const designLayout = design?.kind === 'layout' ? deck.layouts[design.id] : undefined;
  const designMaster = design
    ? deck.masters[design.kind === 'master' ? design.id : (designLayout?.masterId ?? '')]
    : undefined;
  const [layoutName, setLayoutName] = useState(designLayout?.name ?? '');
  useEffect(() => setLayoutName(designLayout?.name ?? ''), [designLayout?.name]);

  return (
    <aside
      className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-border/50 bg-card/30"
      aria-label="Presentation design"
    >
      {object && onObjectFrame && onObjectText && (
        <ObjectSection
          key={object.element.id}
          object={object}
          readOnly={readOnly}
          onFrame={onObjectFrame}
          onText={onObjectText}
        />
      )}

      {!design && slide && (
        <Section title={slideIds.length > 1 ? `${slideIds.length} slides` : 'Slide'}>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Layout</span>
            <Select
              value={layoutValue}
              disabled={readOnly}
              onValueChange={(value) => onSlideLayout(value)}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="Slide layout">
                <SelectValue placeholder="Mixed" />
              </SelectTrigger>
              <SelectContent>
                {layouts.map((layout) => (
                  <SelectItem key={layout.id} value={layout.id}>
                    {layout.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-full justify-start gap-1.5 text-xs"
            disabled={readOnly || !canResetSlide}
            onClick={onResetSlide}
            title="Put placeholders back where the layout has them and remove their formatting overrides"
          >
            <RotateCcw className="size-3.5" />
            Reset placeholders to layout
          </Button>
          <div className="pt-1 text-xs text-muted-foreground">Background</div>
          <BackgroundPicker
            theme={theme}
            value={slide.background}
            inheritLabel="Follow layout"
            disabled={readOnly}
            onChange={onSlideBackground}
          />
        </Section>
      )}

      {!design && slide && slideIds.length === 1 && (
        <AnimationSection
          slide={slide}
          selectedElementId={object?.element.id}
          readOnly={readOnly}
          onTransitionChange={onTransitionChange}
          onTransitionPreview={onTransitionPreview}
          onAnimationAdd={onAnimationAdd}
          onAnimationsChange={onAnimationsChange}
        />
      )}

      {design && designMaster && (
        <>
          {designLayout ? (
            <Section title="Layout">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Name</span>
                <Input
                  aria-label="Layout name"
                  className="h-7 text-xs"
                  value={layoutName}
                  disabled={readOnly}
                  onChange={(event) => setLayoutName(event.target.value)}
                  onBlur={() => {
                    const name = layoutName.trim().slice(0, 256);
                    if (name && name !== designLayout.name) onLayoutChange({ name });
                    else setLayoutName(designLayout.name);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                  }}
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={designLayout.showMasterElements !== false}
                  disabled={readOnly}
                  onChange={(event) => onLayoutChange({ showMasterElements: event.target.checked })}
                />
                Show master artwork
              </label>
              <div className="pt-1 text-xs text-muted-foreground">Background</div>
              <BackgroundPicker
                theme={theme}
                value={designLayout.background}
                inheritLabel="Follow master"
                disabled={readOnly}
                onChange={onDesignBackground}
              />
            </Section>
          ) : (
            <>
              <Section title="Master background">
                <BackgroundPicker
                  theme={theme}
                  value={designMaster.background}
                  inheritLabel="None"
                  disabled={readOnly}
                  onChange={onDesignBackground}
                />
              </Section>
              <Section title="Master text styles">
                <MasterTextStyles
                  deck={deck}
                  masterId={designMaster.id}
                  readOnly={readOnly}
                  onChange={onMasterTextStyle}
                />
              </Section>
            </>
          )}
        </>
      )}

      {!design && (
        <Section title="Design">
          <div className="grid grid-cols-2 gap-2">
            {DECK_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={readOnly}
                className="group flex flex-col gap-1 rounded-md border border-border/60 p-1 text-left text-[11px] hover:border-primary disabled:opacity-50"
                title={template.description}
                aria-label={`Apply the ${template.name} design`}
                onClick={() => onApplyTemplate(template.id)}
              >
                <span
                  className="relative flex h-10 items-end rounded-sm px-1.5 pb-1"
                  style={{ backgroundColor: template.swatch.background }}
                >
                  <span className="font-semibold" style={{ color: template.swatch.text }}>
                    Aa
                  </span>
                  <span
                    className="absolute right-1.5 top-1.5 h-1.5 w-5 rounded-full"
                    style={{ backgroundColor: template.swatch.accent }}
                  />
                </span>
                <span className="px-0.5">{template.name}</span>
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 w-full gap-1.5 text-xs"
            onClick={onEditDesign}
          >
            <LayoutTemplate className="size-3.5" />
            Edit master and layouts
          </Button>
        </Section>
      )}

      <Section title="Theme colours">
        <div className="space-y-1">
          {DECK_THEME_COLOR_TOKENS.map((token) => (
            <div key={token} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground">{THEME_COLOR_LABELS[token]}</span>
              <ColorPicker
                label={THEME_COLOR_LABELS[token]}
                value={theme.colors[token]}
                disabled={readOnly}
                align="end"
                onValueChange={(hex) => onThemeColor(token, hex.slice(0, 7).toLowerCase())}
                trigger={
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-label={`Theme colour ${THEME_COLOR_LABELS[token]}`}
                    className="h-5 w-10 shrink-0 rounded border border-border/60"
                    style={{ backgroundColor: theme.colors[token] }}
                  />
                }
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Theme fonts">
        {(['heading', 'body'] as const).map((role) => {
          const font = theme.fonts[role];
          const drawn = effectiveFamily(font);
          return (
            <div key={role} className="space-y-1 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {role === 'heading' ? 'Headings' : 'Body'}
                </span>
                <Select
                  value={font.family}
                  disabled={readOnly}
                  onValueChange={(family) => onThemeFont(role, family)}
                >
                  <SelectTrigger size="sm" className="w-36" aria-label={`${role} font`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fontChoices(theme, font.family).map((family) => (
                      <SelectItem key={family} value={family}>
                        <span style={{ fontFamily: `"${family}", sans-serif` }}>{family}</span>
                        {!isFontAvailable(family) && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            (not installed)
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {drawn !== font.family && (
                <p className="text-[11px] text-amber-500" role="status">
                  {font.family} is not installed here; {drawn} is drawn instead.
                </p>
              )}
            </div>
          );
        })}
      </Section>

      {design && (
        <div className="flex items-center gap-1.5 px-3 py-3 text-[11px] text-muted-foreground">
          <Palette className="size-3.5" />
          Changes here restyle every slide that uses this {design.kind}.
        </div>
      )}
    </aside>
  );
}
