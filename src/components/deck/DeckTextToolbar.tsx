import type { ComponentProps } from 'react';

import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Eraser,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Plus,
  RotateCcw,
  Strikethrough,
  Subscript,
  Superscript,
  TextCursorInput,
  Underline,
} from 'lucide-react';

import { effectiveFamily, fontChoices, isFontAvailable } from '../../lib/deck/fonts';
import type { TextCommand, TextState } from '../../lib/deck/textCommands';
import { FONT_SIZE_STEPS } from '../../lib/deck/textCommands';
import { THEME_COLOR_LABELS } from '../../lib/deck/themeColors';
import { DECK_THEME_COLOR_TOKENS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type { DeckAutoFit, DeckColor, DeckTheme, DeckVerticalAlign } from '../../types/deck';
import { Button } from '../ui/button';
import { ColorPicker } from '../ui/color-picker';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export interface TextBoxSettings {
  autoFit: DeckAutoFit;
  verticalAlign: DeckVerticalAlign;
  wrap: boolean;
}

/** A font choice: a family name or one of the theme's two font roles. */
export type DeckFontChoice = string | { theme: 'heading' | 'body' };

interface DeckTextToolbarProps {
  state: TextState;
  theme: DeckTheme;
  box: TextBoxSettings | null;
  disabled?: boolean;
  /** Render inside the editor's shared, always-present formatting row. */
  embedded?: boolean;
  /** A placeholder whose overrides can be reset to its layout. */
  canResetPlaceholder?: boolean;
  onCommand: (command: TextCommand) => void;
  onFont: (font: DeckFontChoice) => void;
  onColor: (color: DeckColor | null) => void;
  onBox: (patch: Partial<TextBoxSettings>) => void;
  onLink: () => void;
  onResetPlaceholder?: () => void;
}

function ToolButton({ pressed, ...props }: ComponentProps<typeof Button> & { pressed?: boolean }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={pressed ? 'secondary' : 'ghost'}
      aria-pressed={pressed}
      // Keep the caret in the text being edited.
      onMouseDown={(event) => event.preventDefault()}
      {...props}
    />
  );
}

const Divider = () => <div className="mx-1 h-5 w-px shrink-0 bg-border" />;

const THEME_FONT_HEADING = '__theme-heading';
const THEME_FONT_BODY = '__theme-body';

/**
 * Text formatting for the deck editor. Acts on the edited selection, or on the
 * whole text of every selected box when nothing is being edited.
 */
export function DeckTextToolbar({
  state,
  theme,
  box,
  disabled,
  embedded,
  canResetPlaceholder,
  onCommand,
  onFont,
  onColor,
  onBox,
  onLink,
  onResetPlaceholder,
}: DeckTextToolbarProps) {
  const families = fontChoices(theme, state.family);
  const fontValue = state.family;
  const missing = state.family !== undefined && !isFontAvailable(state.family);
  const sizePoints =
    state.size !== undefined
      ? Math.round((state.size / DECK_UNITS_PER_POINT) * 10) / 10
      : undefined;
  const sizes = [...new Set([...FONT_SIZE_STEPS, ...(sizePoints ? [sizePoints] : [])])].sort(
    (a, b) => a - b,
  );
  const themeSwatches = DECK_THEME_COLOR_TOKENS.slice(0, 10);

  return (
    <div
      className={
        embedded
          ? 'flex shrink-0 items-center gap-1'
          : 'flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 bg-muted/15 px-2 py-1 scrollbar-none'
      }
      role="toolbar"
      aria-label="Text formatting"
    >
      <Select
        value={fontValue}
        disabled={disabled}
        onValueChange={(value) =>
          onFont(
            value === THEME_FONT_HEADING
              ? { theme: 'heading' }
              : value === THEME_FONT_BODY
                ? { theme: 'body' }
                : value,
          )
        }
      >
        <SelectTrigger
          size="sm"
          className="w-40"
          aria-label="Font"
          title={
            missing && state.family
              ? `${state.family} is not installed here; ${effectiveFamily({ family: state.family, fallbacks: [] })} is drawn instead`
              : undefined
          }
        >
          <SelectValue placeholder="Mixed fonts" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={THEME_FONT_HEADING}>
            Headings — {theme.fonts.heading.family}
          </SelectItem>
          <SelectItem value={THEME_FONT_BODY}>Body — {theme.fonts.body.family}</SelectItem>
          {families.map((family) => (
            <SelectItem key={family} value={family}>
              <span style={{ fontFamily: `"${family}", sans-serif` }}>{family}</span>
              {!isFontAvailable(family) && (
                <span className="ml-1 text-[10px] text-muted-foreground">(not installed)</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {missing && (
        <span className="shrink-0 text-[10px] text-amber-500" role="status">
          font missing
        </span>
      )}
      <Select
        value={sizePoints !== undefined ? String(sizePoints) : undefined}
        disabled={disabled}
        onValueChange={(value) =>
          onCommand({
            kind: 'style',
            patch: { size: Math.round(Number(value) * DECK_UNITS_PER_POINT) },
          })
        }
      >
        <SelectTrigger size="sm" className="w-[4.5rem]" aria-label="Font size">
          <SelectValue placeholder="–" />
        </SelectTrigger>
        <SelectContent>
          {sizes.map((size) => (
            <SelectItem key={size} value={String(size)}>
              {size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ToolButton
        aria-label="Decrease font size"
        title="Decrease font size (Ctrl+Shift+<)"
        disabled={disabled}
        onClick={() => onCommand({ kind: 'sizeStep', direction: -1 })}
      >
        <Minus />
      </ToolButton>
      <ToolButton
        aria-label="Increase font size"
        title="Increase font size (Ctrl+Shift+>)"
        disabled={disabled}
        onClick={() => onCommand({ kind: 'sizeStep', direction: 1 })}
      >
        <Plus />
      </ToolButton>

      <Divider />
      <ToolButton
        aria-label="Bold"
        title="Bold (Ctrl+B)"
        pressed={state.bold === true}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'toggle', key: 'bold' })}
      >
        <Bold />
      </ToolButton>
      <ToolButton
        aria-label="Italic"
        title="Italic (Ctrl+I)"
        pressed={state.italic === true}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'toggle', key: 'italic' })}
      >
        <Italic />
      </ToolButton>
      <ToolButton
        aria-label="Underline"
        title="Underline (Ctrl+U)"
        pressed={state.underline === true}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'toggle', key: 'underline' })}
      >
        <Underline />
      </ToolButton>
      <ToolButton
        aria-label="Strikethrough"
        title="Strikethrough"
        pressed={state.strike === true}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'toggle', key: 'strike' })}
      >
        <Strikethrough />
      </ToolButton>
      <ToolButton
        aria-label="Superscript"
        title="Superscript (Ctrl+.)"
        pressed={state.baseline === 'superscript'}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'baseline', value: 'superscript' })}
      >
        <Superscript />
      </ToolButton>
      <ToolButton
        aria-label="Subscript"
        title="Subscript (Ctrl+,)"
        pressed={state.baseline === 'subscript'}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'baseline', value: 'subscript' })}
      >
        <Subscript />
      </ToolButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolButton aria-label="Text colour" title="Text colour" disabled={disabled}>
            <Baseline />
            <span
              className="absolute bottom-0.5 h-0.5 w-4"
              style={{ backgroundColor: state.color ?? 'currentColor' }}
            />
          </ToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-[11px]">Theme colours</DropdownMenuLabel>
          <div className="grid grid-cols-5 gap-1 px-2 pb-2">
            {themeSwatches.map((token) => (
              <button
                key={token}
                type="button"
                aria-label={THEME_COLOR_LABELS[token]}
                title={THEME_COLOR_LABELS[token]}
                className="h-6 rounded border border-border/60"
                style={{ backgroundColor: theme.colors[token] }}
                onClick={() => onColor({ kind: 'theme', token })}
              />
            ))}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onColor(null)}>Automatic (from layout)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ColorPicker
        label="Custom text colour"
        value={state.color ?? '#000000'}
        disabled={disabled}
        align="start"
        colors={themeSwatches.map((token) => theme.colors[token])}
        onValueChange={(value) => onColor({ kind: 'rgb', value: value.slice(0, 7).toLowerCase() })}
        trigger={
          <ToolButton
            aria-label="Custom text colour"
            title="Custom text colour"
            disabled={disabled}
          >
            <span
              className="size-3.5 rounded-full border border-border"
              style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}
            />
          </ToolButton>
        }
      />

      <Divider />
      {(
        [
          ['left', AlignLeft, 'Align left (Ctrl+L)'],
          ['center', AlignCenter, 'Centre (Ctrl+E)'],
          ['right', AlignRight, 'Align right (Ctrl+R)'],
          ['justify', AlignJustify, 'Justify (Ctrl+J)'],
        ] as const
      ).map(([value, Icon, title]) => (
        <ToolButton
          key={value}
          aria-label={title.replace(/ \(.*\)$/, '')}
          title={title}
          pressed={state.align === value}
          disabled={disabled}
          onClick={() => onCommand({ kind: 'align', value })}
        >
          <Icon />
        </ToolButton>
      ))}

      <Divider />
      <ToolButton
        aria-label="Bulleted list"
        title="Bulleted list"
        pressed={state.list === 'bullet'}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'list', list: 'bullet' })}
      >
        <List />
      </ToolButton>
      <ToolButton
        aria-label="Numbered list"
        title="Numbered list"
        pressed={state.list === 'number'}
        disabled={disabled}
        onClick={() => onCommand({ kind: 'list', list: 'number' })}
      >
        <ListOrdered />
      </ToolButton>
      <ToolButton
        aria-label="Decrease list level"
        title="Decrease list level (Shift+Tab)"
        disabled={disabled || state.level === 0}
        onClick={() => onCommand({ kind: 'level', delta: -1 })}
      >
        <IndentDecrease />
      </ToolButton>
      <ToolButton
        aria-label="Increase list level"
        title="Increase list level (Tab)"
        disabled={disabled}
        onClick={() => onCommand({ kind: 'level', delta: 1 })}
      >
        <IndentIncrease />
      </ToolButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
          >
            Spacing
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel className="text-[11px]">Line spacing</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.lineSpacing !== undefined ? String(state.lineSpacing) : ''}
            onValueChange={(value) =>
              onCommand({ kind: 'paragraph', patch: { lineSpacing: Number(value) } })
            }
          >
            {[90, 100, 115, 150, 200, 250, 300].map((value) => (
              <DropdownMenuRadioItem key={value} value={String(value)}>
                {(value / 100).toFixed(value % 100 === 0 ? 1 : 2)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px]">Space before paragraph</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.spaceBefore !== undefined ? String(state.spaceBefore) : ''}
            onValueChange={(value) =>
              onCommand({ kind: 'paragraph', patch: { spaceBefore: Number(value) } })
            }
          >
            {[0, 6, 12, 18, 24].map((points) => (
              <DropdownMenuRadioItem key={points} value={String(points * DECK_UNITS_PER_POINT)}>
                {points} pt
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuLabel className="text-[11px]">Space after paragraph</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.spaceAfter !== undefined ? String(state.spaceAfter) : ''}
            onValueChange={(value) =>
              onCommand({ kind: 'paragraph', patch: { spaceAfter: Number(value) } })
            }
          >
            {[0, 6, 12, 18, 24].map((points) => (
              <DropdownMenuRadioItem key={points} value={String(points * DECK_UNITS_PER_POINT)}>
                {points} pt
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Divider />
      <ToolButton aria-label="Link" title="Link (Ctrl+K)" disabled={disabled} onClick={onLink}>
        <Link2 />
      </ToolButton>
      <ToolButton
        aria-label="Clear formatting"
        title="Clear formatting (Ctrl+Space)"
        disabled={disabled}
        onClick={() => onCommand({ kind: 'clear' })}
      >
        <Eraser />
      </ToolButton>

      {box && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton aria-label="Text box options" title="Text box options" disabled={disabled}>
              <TextCursorInput />
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="text-[11px]">Autofit</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={box.autoFit}
              onValueChange={(value) => onBox({ autoFit: value as DeckAutoFit })}
            >
              <DropdownMenuRadioItem value="none">Do not autofit</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="shrink">Shrink text on overflow</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="grow">Resize box to fit text</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px]">Vertical alignment</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={box.verticalAlign}
              onValueChange={(value) => onBox({ verticalAlign: value as DeckVerticalAlign })}
            >
              <DropdownMenuRadioItem value="top">Top</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="middle">Middle</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="bottom">Bottom</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={box.wrap}
              onCheckedChange={(checked) => onBox({ wrap: checked })}
            >
              Wrap text
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {canResetPlaceholder && onResetPlaceholder && (
        <>
          <Divider />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={disabled}
            onClick={onResetPlaceholder}
            title="Reset position, size, and formatting to the layout"
          >
            <RotateCcw className="size-3.5" />
            Reset to layout
          </Button>
        </>
      )}
    </div>
  );
}
