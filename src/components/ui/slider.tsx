import * as React from 'react';

import { Slider as SliderPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Slider({
  className,
  trackClassName,
  rangeClassName,
  thumbClassName,
  'aria-label': label,
  'aria-valuetext': valueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Extra classes for the track, range and thumb, e.g. for controls drawn over media. */
  trackClassName?: string;
  rangeClassName?: string;
  thumbClassName?: string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        'relative flex h-5 w-full touch-none select-none items-center data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn('relative h-1.5 grow overflow-hidden rounded-full bg-muted', trackClassName)}
      >
        <SliderPrimitive.Range className={cn('absolute h-full bg-primary', rangeClassName)} />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className={cn(
          'block size-4 rounded-full border border-primary/70 bg-background shadow-sm outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50',
          thumbClassName,
        )}
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
