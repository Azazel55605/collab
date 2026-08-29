import { type MouseEvent, useId, useLayoutEffect, useRef, useState } from 'react';

import * as d3 from 'd3';

import type { MathPlot2DSpec } from './mathPlotSpec';
import { samplePlot2D } from './mathPlotSpec';

interface MathPlot2DProps {
  spec: MathPlot2DSpec;
  /** Render without the bordered card / header chrome (used inside the plot modal). */
  variant?: 'inline' | 'modal';
  /** Notify when the plot area is shift-clicked (used to open the modal). */
  onShiftClick?: () => void;
}

const FALLBACK_SIZE = { width: 560, height: 260 };
const INLINE_INITIAL_HEIGHT = 260;
const MIN_PLOT_HEIGHT = 180;

export function MathPlot2D({ spec, variant = 'inline', onShiftClick }: MathPlot2DProps) {
  const isModal = variant === 'modal';
  const clipId = useId();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);
  const margin = { top: 16, right: 24, bottom: 34, left: 44 };

  // Track the actual pixel size of the (possibly user-resized) plot area so the
  // SVG coordinate space matches it exactly — the curve gets more room without
  // any aspect-ratio distortion.
  useLayoutEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    const measure = (width: number, height: number) => {
      if (width > 0 && height > 0)
        setSize({ width: Math.round(width), height: Math.round(height) });
    };
    // Seed synchronously to avoid a first-frame aspect flash, then track changes.
    const rect = node.getBoundingClientRect();
    measure(rect.width, rect.height);
    const observer = new ResizeObserver(([entry]) => {
      measure(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  let sampled;
  try {
    sampled = samplePlot2D(spec);
  } catch (err) {
    return (
      <div className="rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        Could not render 2D plot: {String(err instanceof Error ? err.message : err)}
      </div>
    );
  }

  const { width, height } = size;
  const xScale = d3
    .scaleLinear()
    .domain([spec.x.min, spec.x.max])
    .range([margin.left, width - margin.right]);
  const yScale = d3
    .scaleLinear()
    .domain([sampled.yDomain.min, sampled.yDomain.max])
    .range([height - margin.bottom, margin.top]);
  const line = d3
    .line<{ x: number; y: number }>()
    .x((point) => xScale(point.x))
    .y((point) => yScale(point.y));
  const xTicks = xScale.ticks(7);
  const yTicks = yScale.ticks(5);
  const zeroX = spec.x.min <= 0 && spec.x.max >= 0 ? xScale(0) : null;
  const zeroY = sampled.yDomain.min <= 0 && sampled.yDomain.max >= 0 ? yScale(0) : null;

  const handleClick = onShiftClick
    ? (event: MouseEvent) => {
        if (event.shiftKey) {
          event.preventDefault();
          onShiftClick();
        }
      }
    : undefined;

  return (
    <div
      className={isModal ? '' : 'rounded-lg border border-border/45 bg-background/45 p-3'}
      onClick={handleClick}
      title={onShiftClick ? 'Shift-click to open the interactive plot editor' : undefined}
    >
      {!isModal && (
        <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/85">2D plot</span>
          <span className="truncate font-mono">y = {spec.expression}</span>
        </div>
      )}
      <div
        ref={plotRef}
        className={isModal ? 'h-[540px] w-full' : 'w-full resize-y overflow-hidden rounded-md'}
        style={isModal ? undefined : { height: INLINE_INITIAL_HEIGHT, minHeight: MIN_PLOT_HEIGHT }}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block h-full w-full"
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={margin.left}
                y={margin.top}
                width={width - margin.left - margin.right}
                height={height - margin.top - margin.bottom}
              />
            </clipPath>
          </defs>
          <rect
            x={margin.left}
            y={margin.top}
            width={width - margin.left - margin.right}
            height={height - margin.top - margin.bottom}
            rx={6}
            className="fill-muted/15"
          />
          {xTicks.map((tick) => (
            <g key={`x-${tick}`}>
              <line
                x1={xScale(tick)}
                x2={xScale(tick)}
                y1={margin.top}
                y2={height - margin.bottom}
                className="stroke-border/40"
              />
              <text
                x={xScale(tick)}
                y={height - 12}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {tick}
              </text>
            </g>
          ))}
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={yScale(tick)}
                y2={yScale(tick)}
                className="stroke-border/40"
              />
              <text
                x={margin.left - 8}
                y={yScale(tick) + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {Number.parseFloat(tick.toPrecision(3))}
              </text>
            </g>
          ))}
          {zeroX !== null && (
            <line
              x1={zeroX}
              x2={zeroX}
              y1={margin.top}
              y2={height - margin.bottom}
              className="stroke-foreground/35"
            />
          )}
          {zeroY !== null && (
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={zeroY}
              y2={zeroY}
              className="stroke-foreground/35"
            />
          )}
          <g clipPath={`url(#${clipId})`}>
            {sampled.segments.map((segment, index) => (
              <path
                key={index}
                d={line(segment) ?? undefined}
                className="fill-none stroke-primary"
                strokeWidth={2.4}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
