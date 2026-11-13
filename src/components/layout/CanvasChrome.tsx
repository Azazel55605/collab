import type { ComponentProps, ReactNode } from 'react';

import { Maximize2, Minus, Plus } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

import { DocumentTopBarButton, DocumentTopBarIconButton } from './DocumentTopBar';

/**
 * Floating controls for canvas-style editors and viewers: a tool rail on the
 * left, a selection bar near the top, page and zoom pills at the bottom. Callers
 * position each bar (absolute, inside a `relative` stage); this gives them one
 * shared look.
 */
export function FloatingBar({
  orientation = 'horizontal',
  className,
  children,
  ...props
}: ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          'pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-lg shadow-black/20',
          orientation === 'vertical' && 'flex-col',
          className,
        )}
        aria-orientation={props.role === 'toolbar' ? orientation : undefined}
        {...props}
      >
        {children}
      </div>
    </TooltipProvider>
  );
}

export function FloatingSeparator({ vertical = false }: { vertical?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('shrink-0 bg-border', vertical ? 'mx-1.5 my-0.5 h-px w-5' : 'mx-1 h-5 w-px')}
    />
  );
}

/** Icon button for floating bars, labelled for screen readers and with a tooltip. */
export function RailButton({
  label,
  hint,
  pressed,
  side = 'right',
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof DocumentTopBarIconButton>, 'aria-label'> & {
  label: string;
  hint?: string;
  pressed?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DocumentTopBarIconButton
          aria-label={label}
          aria-pressed={pressed}
          className={cn(pressed && 'bg-primary/15 text-foreground hover:bg-primary/20', className)}
          {...props}
        >
          {children}
        </DocumentTopBarIconButton>
      </TooltipTrigger>
      <TooltipContent side={side}>{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}

/** − 100% + [fit]: the zoom control every canvas and viewer shares. */
export function ZoomPill({
  label,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
  resetLabel = 'Reset zoom to 100%',
  zoomOutDisabled,
  zoomInDisabled,
  className,
  children,
}: {
  label: string;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  onFit?: () => void;
  /** Accessible name and tooltip of the percentage button. */
  resetLabel?: string;
  zoomOutDisabled?: boolean;
  zoomInDisabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <FloatingBar role="group" aria-label="Zoom" className={cn('right-3 bottom-3', className)}>
      <RailButton label="Zoom out" side="top" onClick={onZoomOut} disabled={zoomOutDisabled}>
        <Minus />
      </RailButton>
      <DocumentTopBarButton
        onClick={onReset}
        className="min-w-14 justify-center px-1 font-mono text-xs text-muted-foreground"
        aria-label={resetLabel}
        title={resetLabel}
      >
        {label}
      </DocumentTopBarButton>
      <RailButton label="Zoom in" side="top" onClick={onZoomIn} disabled={zoomInDisabled}>
        <Plus />
      </RailButton>
      {onFit && (
        <RailButton label="Fit view" side="top" onClick={onFit}>
          <Maximize2 />
        </RailButton>
      )}
      {children}
    </FloatingBar>
  );
}
