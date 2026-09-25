import { INK_COLOR_TOKENS } from '../../lib/ink/colors';
import type { InkEraserMode } from '../../lib/ink/erase';
import { INK_BRUSH_ORDER, INK_BRUSH_WIDTHS, INK_ERASER_SIZES } from '../../lib/ink/tools';
import type { InkBrushKind } from '../../types/ink';
import { Separator } from '../ui/separator';

import { OptionRow, PillSelect, SectionLabel, ToggleSwitch } from './settingsControls';

const INK_COLORS = Object.values(INK_COLOR_TOKENS);
const ERASER_MODES: InkEraserMode[] = ['segment', 'stroke', 'object'];

const COLOR_LABELS: Record<string, string> = {
  'ink:foreground': 'Foreground',
  'ink:blue': 'Blue',
  'ink:red': 'Red',
  'ink:green': 'Green',
  'ink:amber': 'Amber',
  'ink:violet': 'Violet',
  'ink:cyan': 'Cyan',
  'ink:gray': 'Gray',
};

type Props = {
  brushKind: InkBrushKind;
  setBrushKind: (kind: InkBrushKind) => void;
  color: string;
  setColor: (color: string) => void;
  width: number;
  setWidth: (width: number) => void;
  eraserMode: InkEraserMode;
  setEraserMode: (mode: InkEraserMode) => void;
  eraserRadius: number;
  setEraserRadius: (radius: number) => void;
  snapToGrid: boolean;
  setSnapToGrid: (enabled: boolean) => void;
  holdToStraighten: boolean;
  setHoldToStraighten: (enabled: boolean) => void;
};

function points(units: number) {
  return `${Number((units / 64).toFixed(1))} pt`;
}

export default function SettingsInkSection({
  brushKind,
  setBrushKind,
  color,
  setColor,
  width,
  setWidth,
  eraserMode,
  setEraserMode,
  eraserRadius,
  setEraserRadius,
  snapToGrid,
  setSnapToGrid,
  holdToStraighten,
  setHoldToStraighten,
}: Props) {
  return (
    <div>
      <SectionLabel>New drawing tools</SectionLabel>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        These defaults apply when a drawing tab opens. Changes made in an open drawing remain local
        to that editor session.
      </p>

      <OptionRow label="Pen" description="Initial brush used by the pen tool">
        <PillSelect
          options={INK_BRUSH_ORDER}
          value={brushKind}
          onChange={setBrushKind}
          getLabel={(value) => (value === 'ballpoint' ? 'Ballpoint' : value)}
        />
      </OptionRow>
      <OptionRow label="Ink color" description="Theme-aware default stroke color">
        <PillSelect
          options={INK_COLORS}
          value={color}
          onChange={setColor}
          getLabel={(value) => COLOR_LABELS[value] ?? value}
        />
      </OptionRow>
      <OptionRow label="Pen width" description="Initial nominal stroke width">
        <PillSelect
          options={INK_BRUSH_WIDTHS}
          value={width}
          onChange={setWidth}
          getLabel={points}
        />
      </OptionRow>

      <Separator className="my-4 bg-border/40" />

      <SectionLabel>Eraser and geometry</SectionLabel>
      <OptionRow label="Eraser mode" description="Initial behavior of the eraser tool">
        <PillSelect
          options={ERASER_MODES}
          value={eraserMode}
          onChange={setEraserMode}
          getLabel={(value) => value[0].toUpperCase() + value.slice(1)}
        />
      </OptionRow>
      <OptionRow label="Eraser size" description="Initial eraser radius">
        <PillSelect
          options={INK_ERASER_SIZES}
          value={eraserRadius}
          onChange={setEraserRadius}
          getLabel={points}
        />
      </OptionRow>
      <OptionRow label="Snap to grid" description="Enable grid snapping when a drawing opens">
        <ToggleSwitch
          checked={snapToGrid}
          onToggle={() => setSnapToGrid(!snapToGrid)}
          ariaLabel="Default snap to grid"
          animated
        />
      </OptionRow>
      <OptionRow
        label="Hold to straighten"
        description="Convert a held pen stroke into a straight line proposal"
      >
        <ToggleSwitch
          checked={holdToStraighten}
          onToggle={() => setHoldToStraighten(!holdToStraighten)}
          ariaLabel="Default hold to straighten"
          animated
        />
      </OptionRow>
    </div>
  );
}
