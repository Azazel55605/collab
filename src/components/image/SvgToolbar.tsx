import { Circle, Minus, MousePointer2, Square, Type } from 'lucide-react';

import { FloatingBar, FloatingSeparator, RailButton } from '../layout/CanvasChrome';

import type { SvgTool } from './SvgEditStage';

const TOOLS: { tool: SvgTool; label: string; icon: typeof Square }[] = [
  { tool: 'select', label: 'Select', icon: MousePointer2 },
  { tool: 'rect', label: 'Rectangle', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', icon: Circle },
  { tool: 'line', label: 'Line', icon: Minus },
  { tool: 'text', label: 'Text', icon: Type },
];

interface Props {
  tool: SvgTool;
  onToolChange: (tool: SvgTool) => void;
}

/** The SVG editor's drawing tools, as a floating rail on the left of the canvas. */
export function SvgToolbar({ tool, onToolChange }: Props) {
  return (
    <FloatingBar
      role="toolbar"
      aria-label="Drawing tools"
      orientation="vertical"
      className="top-1/2 left-3 z-30 -translate-y-1/2"
    >
      {TOOLS.map(({ tool: value, label, icon: Icon }, index) => (
        <span key={value} className="contents">
          {index === 1 && <FloatingSeparator vertical />}
          <RailButton label={label} pressed={tool === value} onClick={() => onToolChange(value)}>
            <Icon />
          </RailButton>
        </span>
      ))}
    </FloatingBar>
  );
}
