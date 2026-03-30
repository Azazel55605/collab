import { cn } from '../../lib/utils';
import { GRID_LAYOUTS, LAYOUT_ORDER, type GridLayoutId } from '../../store/gridStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

// Inline SVG diagrams representing each layout at 20×14 viewBox
const LAYOUT_ICONS: Record<GridLayoutId, React.ReactNode> = {
  single: (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1" y="1" width="18" height="12" rx="1.5" />
    </svg>
  ),
  'split-v': (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1" y="1" width="18" height="5" rx="1.5" />
      <rect x="1" y="8" width="18" height="5" rx="1.5" />
    </svg>
  ),
  'split-h': (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1" y="1" width="8" height="12" rx="1.5" />
      <rect x="11" y="1" width="8" height="12" rx="1.5" />
    </svg>
  ),
  'main-side': (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1" y="1" width="12" height="12" rx="1.5" />
      <rect x="15" y="1" width="4" height="12" rx="1.5" />
    </svg>
  ),
  'side-main': (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1" y="1" width="4" height="12" rx="1.5" />
      <rect x="7" y="1" width="12" height="12" rx="1.5" />
    </svg>
  ),
  '2x2': (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1" y="1" width="8" height="5" rx="1.5" />
      <rect x="11" y="1" width="8" height="5" rx="1.5" />
      <rect x="1" y="8" width="8" height="5" rx="1.5" />
      <rect x="11" y="8" width="8" height="5" rx="1.5" />
    </svg>
  ),
  'cols-3': (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1"   y="1" width="5" height="12" rx="1.5" />
      <rect x="7.5" y="1" width="5" height="12" rx="1.5" />
      <rect x="14"  y="1" width="5" height="12" rx="1.5" />
    </svg>
  ),
  'cols-4': (
    <svg viewBox="0 0 20 14" fill="currentColor" className="w-full h-full">
      <rect x="1"    y="1" width="3.5" height="12" rx="1" />
      <rect x="5.5"  y="1" width="3.5" height="12" rx="1" />
      <rect x="10"   y="1" width="3.5" height="12" rx="1" />
      <rect x="14.5" y="1" width="4.5" height="12" rx="1" />
    </svg>
  ),
};

interface Props {
  currentLayout: GridLayoutId;
  containerWidth: number;
  onChange: (id: GridLayoutId) => void;
}

export default function GridLayoutPicker({ currentLayout, containerWidth, onChange }: Props) {
  return (
    <div className="flex items-center gap-0.5 px-2 h-9 border-b border-border/50 bg-background shrink-0">
      <span className="text-xs text-muted-foreground/60 mr-1.5 select-none font-medium">Layout</span>
      <div className="flex items-center gap-0.5">
        {LAYOUT_ORDER.map((id) => {
          const layout = GRID_LAYOUTS[id];
          const isDisabled = containerWidth < layout.minWidth;
          const isActive = currentLayout === id;
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => !isDisabled && onChange(id)}
                  disabled={isDisabled}
                  className={cn(
                    'w-9 h-7 flex items-center justify-center rounded transition-all',
                    isActive
                      ? 'text-primary bg-primary/15'
                      : isDisabled
                      ? 'text-muted-foreground/20 cursor-not-allowed'
                      : 'text-muted-foreground/50 hover:text-foreground hover:bg-accent/60'
                  )}
                >
                  <div className="w-5 h-3.5">{LAYOUT_ICONS[id]}</div>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {layout.label}
                {isDisabled && (
                  <span className="text-muted-foreground ml-1">
                    (min {layout.minWidth}px)
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
