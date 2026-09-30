import type { ComponentProps } from 'react';

import {
  ArrowDownFromLine,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  ArrowUpFromLine,
  BarChart3,
  Crop,
  ExternalLink,
  FlipHorizontal2,
  FlipVertical2,
  ImageUp,
  PaintBucket,
  RefreshCw,
  RotateCw,
  Rows3,
  Shapes,
  SquareDashed,
  Trash2,
} from 'lucide-react';

import { SHAPE_NAMES } from '../../lib/deck/insert';
import { THEME_COLOR_LABELS } from '../../lib/deck/themeColors';
import {
  DECK_SHAPE_GEOMETRIES,
  DECK_THEME_COLOR_TOKENS,
  DECK_UNITS_PER_POINT,
} from '../../types/deck';
import type {
  DeckArrowhead,
  DeckColor,
  DeckDash,
  DeckElement,
  DeckShapeGeometry,
  DeckTheme,
} from '../../types/deck';
import { Button } from '../ui/button';
import { ColorPicker } from '../ui/color-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export type TableAction =
  'rowAbove' | 'rowBelow' | 'columnLeft' | 'columnRight' | 'deleteRow' | 'deleteColumn' | 'header';

export interface DeckObjectToolbarProps {
  elements: DeckElement[];
  theme: DeckTheme;
  disabled?: boolean;
  /** The table cell last edited or clicked, which row and column actions use. */
  hasActiveCell?: boolean;
  cropping?: boolean;
  onFill: (color: DeckColor | null) => void;
  onOutline: (patch: { color?: DeckColor; width?: number; dash?: DeckDash } | null) => void;
  onArrow: (end: 'start' | 'end', kind: DeckArrowhead) => void;
  onGeometry: (geometry: DeckShapeGeometry) => void;
  onOpacity: (percent: number) => void;
  onFlip: (axis: 'horizontal' | 'vertical') => void;
  onRotate: () => void;
  onCrop: () => void;
  onResetCrop: () => void;
  onReplaceImage: () => void;
  onTable: (action: TableAction) => void;
  onCellFill: (color: DeckColor | null) => void;
  onEditChart: () => void;
  onRefreshChart: () => void;
  onOpenEmbed: () => void;
  onRefreshEmbed: () => void;
}

function ToolButton(props: ComponentProps<typeof Button> & { pressed?: boolean }) {
  const { pressed, ...rest } = props;
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={pressed ? 'secondary' : 'ghost'}
      aria-pressed={pressed}
      {...rest}
    />
  );
}

function TextButton(props: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 shrink-0 gap-1 px-2 text-xs"
      {...props}
    />
  );
}

const Divider = () => <div className="mx-1 h-5 w-px shrink-0 bg-border" />;

const ARROWS: DeckArrowhead[] = ['none', 'triangle', 'open', 'oval', 'diamond'];
const ARROW_NAMES: Record<DeckArrowhead, string> = {
  none: 'None',
  triangle: 'Arrow',
  open: 'Open arrow',
  oval: 'Dot',
  diamond: 'Diamond',
};
const DASHES: DeckDash[] = ['solid', 'dash', 'dot', 'dashDot'];
const DASH_NAMES: Record<DeckDash, string> = {
  solid: 'Solid',
  dash: 'Dashed',
  dot: 'Dotted',
  dashDot: 'Dash-dot',
};
const WIDTHS = [0.5, 1, 1.5, 2, 3, 4, 6, 8];

/** Theme swatches plus "none" and a custom colour, for a fill or an outline. */
function ColorMenu({
  label,
  icon,
  theme,
  disabled,
  current,
  noneLabel,
  onPick,
}: {
  label: string;
  icon: React.ReactNode;
  theme: DeckTheme;
  disabled?: boolean;
  current: string | null;
  noneLabel: string;
  onPick: (color: DeckColor | null) => void;
}) {
  const swatches = DECK_THEME_COLOR_TOKENS.slice(0, 10);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolButton aria-label={label} title={label} disabled={disabled}>
            {icon}
            <span
              className="absolute bottom-0.5 h-0.5 w-4"
              style={{ backgroundColor: current ?? 'transparent' }}
            />
          </ToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-[11px]">{label}</DropdownMenuLabel>
          <div className="grid grid-cols-5 gap-1 px-2 pb-2">
            {swatches.map((token) => (
              <button
                key={token}
                type="button"
                aria-label={`${label}: ${THEME_COLOR_LABELS[token]}`}
                title={THEME_COLOR_LABELS[token]}
                className="h-6 rounded border border-border/60"
                style={{ backgroundColor: theme.colors[token] }}
                onClick={() => onPick({ kind: 'theme', token })}
              />
            ))}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onPick(null)}>{noneLabel}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ColorPicker
        label={`Custom ${label.toLowerCase()}`}
        value={current ?? '#000000'}
        disabled={disabled}
        align="start"
        colors={swatches.map((token) => theme.colors[token])}
        onValueChange={(value) => onPick({ kind: 'rgb', value: value.slice(0, 7).toLowerCase() })}
        trigger={
          <ToolButton
            aria-label={`Custom ${label.toLowerCase()}`}
            title={`Custom ${label.toLowerCase()}`}
            disabled={disabled}
          >
            <span
              className="size-3 rounded-full border border-border"
              style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}
            />
          </ToolButton>
        }
      />
    </>
  );
}

function colorHex(color: DeckColor | undefined, theme: DeckTheme): string | null {
  if (!color) return null;
  return color.kind === 'rgb' ? color.value : theme.colors[color.token];
}

/**
 * Formatting for selected objects: fill, outline, arrowheads, shape, opacity,
 * flip and rotate, plus the image, table, chart, and linked-document actions
 * of whatever is selected.
 */
export function DeckObjectToolbar({
  elements,
  theme,
  disabled,
  hasActiveCell,
  cropping,
  onFill,
  onOutline,
  onArrow,
  onGeometry,
  onOpacity,
  onFlip,
  onRotate,
  onCrop,
  onResetCrop,
  onReplaceImage,
  onTable,
  onCellFill,
  onEditChart,
  onRefreshChart,
  onOpenEmbed,
  onRefreshEmbed,
}: DeckObjectToolbarProps) {
  const first = elements[0];
  if (!first) return null;
  const single = elements.length === 1 ? first : null;
  const fillable = elements.filter(
    (element) => element.type === 'text' || element.type === 'shape',
  );
  const outlined = elements.filter(
    (element) =>
      element.type === 'text' ||
      element.type === 'shape' ||
      element.type === 'image' ||
      element.type === 'line' ||
      element.type === 'table',
  );
  const lines = elements.filter((element) => element.type === 'line');
  const shapes = elements.filter((element) => element.type === 'shape');
  const firstFill =
    fillable[0] && 'fill' in fillable[0] && fillable[0].fill?.kind === 'solid'
      ? colorHex(fillable[0].fill.color, theme)
      : null;
  const firstLine = outlined[0]
    ? outlined[0].type === 'table'
      ? outlined[0].border
      : 'line' in outlined[0]
        ? outlined[0].line
        : undefined
    : undefined;
  const opacity = first.opacity ?? 100;

  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 bg-muted/15 px-2 py-1 scrollbar-none"
      role="toolbar"
      aria-label="Object formatting"
    >
      {fillable.length > 0 && (
        <ColorMenu
          label="Fill"
          icon={<PaintBucket />}
          theme={theme}
          disabled={disabled}
          current={firstFill}
          noneLabel="No fill"
          onPick={onFill}
        />
      )}
      {outlined.length > 0 && (
        <>
          <ColorMenu
            label="Outline"
            icon={<SquareDashed />}
            theme={theme}
            disabled={disabled}
            current={colorHex(firstLine?.color, theme)}
            noneLabel={lines.length === outlined.length ? 'Default colour' : 'No outline'}
            onPick={(color) => onOutline(color ? { color } : null)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <TextButton disabled={disabled} aria-label="Outline weight and style">
                {firstLine ? `${firstLine.width / DECK_UNITS_PER_POINT} pt` : 'Weight'}
              </TextButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuLabel className="text-[11px]">Weight</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={firstLine ? String(firstLine.width) : ''}
                onValueChange={(value) => onOutline({ width: Number(value) })}
              >
                {WIDTHS.map((points) => (
                  <DropdownMenuRadioItem
                    key={points}
                    value={String(Math.round(points * DECK_UNITS_PER_POINT))}
                  >
                    {points} pt
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px]">Style</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={firstLine?.dash ?? 'solid'}
                onValueChange={(value) => onOutline({ dash: value as DeckDash })}
              >
                {DASHES.map((dash) => (
                  <DropdownMenuRadioItem key={dash} value={dash}>
                    {DASH_NAMES[dash]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      {lines.length > 0 &&
        (['start', 'end'] as const).map((end) => {
          const line = lines[0].type === 'line' ? lines[0] : null;
          const value = (end === 'start' ? line?.startArrow : line?.endArrow) ?? 'none';
          return (
            <DropdownMenu key={end}>
              <DropdownMenuTrigger asChild>
                <TextButton
                  disabled={disabled}
                  aria-label={`${end === 'start' ? 'Start' : 'End'} arrowhead`}
                >
                  {end === 'start' ? 'Start' : 'End'}: {ARROW_NAMES[value]}
                </TextButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={value}
                  onValueChange={(next) => onArrow(end, next as DeckArrowhead)}
                >
                  {ARROWS.map((arrow) => (
                    <DropdownMenuRadioItem key={arrow} value={arrow}>
                      {ARROW_NAMES[arrow]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
      {shapes.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton aria-label="Change shape" title="Change shape" disabled={disabled}>
              <Shapes />
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {DECK_SHAPE_GEOMETRIES.map((geometry) => (
              <DropdownMenuItem key={geometry} onClick={() => onGeometry(geometry)}>
                {SHAPE_NAMES[geometry]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Divider />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TextButton disabled={disabled} aria-label="Opacity">
            {opacity}%
          </TextButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="text-[11px]">Opacity</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(opacity)}
            onValueChange={(value) => onOpacity(Number(value))}
          >
            {[100, 90, 75, 60, 50, 40, 25, 10].map((percent) => (
              <DropdownMenuRadioItem key={percent} value={String(percent)}>
                {percent}%
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {lines.length < elements.length && (
        <>
          <ToolButton
            aria-label="Flip horizontally"
            title="Flip horizontally"
            disabled={disabled}
            onClick={() => onFlip('horizontal')}
          >
            <FlipHorizontal2 />
          </ToolButton>
          <ToolButton
            aria-label="Flip vertically"
            title="Flip vertically"
            disabled={disabled}
            onClick={() => onFlip('vertical')}
          >
            <FlipVertical2 />
          </ToolButton>
        </>
      )}
      <ToolButton aria-label="Rotate 90°" title="Rotate 90°" disabled={disabled} onClick={onRotate}>
        <RotateCw />
      </ToolButton>

      {single?.type === 'image' && (
        <>
          <Divider />
          <ToolButton
            aria-label="Crop"
            title="Crop"
            pressed={cropping}
            disabled={disabled}
            onClick={onCrop}
          >
            <Crop />
          </ToolButton>
          <TextButton disabled={disabled || !single.crop} onClick={onResetCrop}>
            Reset crop
          </TextButton>
          <ToolButton
            aria-label="Replace image"
            title="Replace image"
            disabled={disabled}
            onClick={onReplaceImage}
          >
            <ImageUp />
          </ToolButton>
        </>
      )}

      {single?.type === 'table' && (
        <>
          <Divider />
          <ToolButton
            aria-label="Insert row above"
            title="Insert row above"
            disabled={disabled}
            onClick={() => onTable('rowAbove')}
          >
            <ArrowUpFromLine />
          </ToolButton>
          <ToolButton
            aria-label="Insert row below"
            title="Insert row below"
            disabled={disabled}
            onClick={() => onTable('rowBelow')}
          >
            <ArrowDownFromLine />
          </ToolButton>
          <ToolButton
            aria-label="Insert column left"
            title="Insert column left"
            disabled={disabled}
            onClick={() => onTable('columnLeft')}
          >
            <ArrowLeftFromLine />
          </ToolButton>
          <ToolButton
            aria-label="Insert column right"
            title="Insert column right"
            disabled={disabled}
            onClick={() => onTable('columnRight')}
          >
            <ArrowRightFromLine />
          </ToolButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ToolButton
                aria-label="Delete row or column"
                title="Delete row or column"
                disabled={disabled || !hasActiveCell}
              >
                <Trash2 />
              </ToolButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => onTable('deleteRow')}>Delete row</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onTable('deleteColumn')}>
                Delete column
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolButton
            aria-label="Header row"
            title="Header row"
            pressed={single.headerRow === true}
            disabled={disabled}
            onClick={() => onTable('header')}
          >
            <Rows3 />
          </ToolButton>
          {hasActiveCell && (
            <ColorMenu
              label="Cell fill"
              icon={<PaintBucket />}
              theme={theme}
              disabled={disabled}
              current={null}
              noneLabel="No fill"
              onPick={onCellFill}
            />
          )}
        </>
      )}

      {single?.type === 'chart' && (
        <>
          <Divider />
          <TextButton disabled={disabled} onClick={onEditChart}>
            <BarChart3 className="size-3.5" />
            Edit data…
          </TextButton>
          {single.source && (
            <TextButton
              disabled={disabled}
              onClick={onRefreshChart}
              title={`Read ${single.source.range} of ${single.source.path} again (last read ${new Date(single.source.refreshedAt).toLocaleString()})`}
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </TextButton>
          )}
        </>
      )}

      {single?.type === 'embed' && (
        <>
          <Divider />
          <TextButton onClick={onOpenEmbed}>
            <ExternalLink className="size-3.5" />
            Open {single.source.path.split('/').pop()}
          </TextButton>
          <TextButton disabled={disabled} onClick={onRefreshEmbed}>
            <RefreshCw className="size-3.5" />
            Refresh preview
          </TextButton>
        </>
      )}
    </div>
  );
}
