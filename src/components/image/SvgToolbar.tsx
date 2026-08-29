import { Circle, Minus, MousePointer2, Save, Square, Type } from 'lucide-react';

import { cn } from '../../lib/utils';
import { documentTopBarButtonClass, documentTopBarGroupClass } from '../layout/DocumentTopBar';
import { Button } from '../ui/button';

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
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}

export function SvgToolbar({ tool, onToolChange, dirty, saving, onSave }: Props) {
  return (
    <>
      <div className={documentTopBarGroupClass}>
        {TOOLS.map(({ tool: value, label, icon: Icon }) => (
          <Button
            key={value}
            size="icon"
            variant="ghost"
            className={cn(
              'size-8 app-motion-fast',
              tool === value && 'bg-accent text-accent-foreground',
            )}
            title={label}
            aria-pressed={tool === value}
            onClick={() => onToolChange(value)}
          >
            <Icon size={15} />
          </Button>
        ))}
      </div>

      <div className={documentTopBarGroupClass}>
        <Button
          size="sm"
          variant={dirty ? 'default' : 'ghost'}
          className={documentTopBarButtonClass}
          disabled={!dirty || saving}
          onClick={onSave}
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  );
}
