import {
  type PointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';

import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';

import {
  circuitSweepOutputKey,
  circuitSweepTraceLabel,
  circuitSweepTraceUnit,
} from '../../lib/circuitSweepExport';
import type {
  CircuitSweepOutput,
  CircuitSweepResult,
  CircuitTransientResult,
} from '../../types/circuitRuntime';

import './CircuitSweepPlot.css';

const TRACE_COLORS = ['#22d3ee', '#fbbf24', '#a78bfa', '#fb7185', '#34d399', '#fb923c'];
const PLOT_WIDTH = 760;
const PLOT_HEIGHT = 300;
const MARGIN_TOP = 18;
const MARGIN_BOTTOM = 42;

function finiteExtent(values: number[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.05, 1e-9);
    return [min - padding, max + padding];
  }
  const padding = (max - min) * 0.08;
  return [min - padding, max + padding];
}

function renderIndices(start: number, end: number): number[] {
  const length = end - start + 1;
  if (length <= 900) return Array.from({ length }, (_, index) => start + index);
  const step = (length - 1) / 899;
  return Array.from({ length: 900 }, (_, index) => start + Math.round(index * step));
}

function boundedRange(start: number, end: number, sampleCount: number) {
  const maxIndex = Math.max(1, sampleCount - 1);
  const span = Math.min(maxIndex, Math.max(1, end - start));
  const boundedStart = Math.max(0, Math.min(maxIndex - span, start));
  return { start: boundedStart, end: boundedStart + span };
}

function formatAxis(value: number): string {
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e4 || absolute < 1e-3)) return value.toExponential(2);
  return Number(value.toPrecision(4)).toString();
}

function CircuitSeriesPlot({
  result,
  axisValues,
  axisTitle,
  cursorLabel,
  plotLabel,
  controlLabel,
}: {
  result: CircuitSweepResult | CircuitTransientResult;
  axisValues: number[];
  axisTitle: string;
  cursorLabel: string;
  plotLabel: string;
  controlLabel: string;
}) {
  const clipId = useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{
    pointerId: number;
    clientX: number;
    range: { start: number; end: number };
  } | null>(null);
  const traceKeys = useMemo(
    () => result.traces.map((trace) => circuitSweepOutputKey(trace.output)),
    [result.traces],
  );
  const [visibleKeys, setVisibleKeys] = useState<string[]>(traceKeys);
  const [viewRange, setViewRange] = useState(() => ({
    start: 0,
    end: Math.max(1, result.sampleCount - 1),
  }));
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);

  useEffect(() => {
    setVisibleKeys(traceKeys);
    setViewRange({ start: 0, end: Math.max(1, result.sampleCount - 1) });
    setCursorIndex(null);
  }, [result.sampleCount, traceKeys]);

  const visible = useMemo(() => new Set(visibleKeys), [visibleKeys]);
  const range = boundedRange(viewRange.start, viewRange.end, result.sampleCount);
  const [xMin, xMax] = finiteExtent(axisValues.slice(range.start, range.end + 1));
  const visibleTraces = result.traces.filter((trace) =>
    visible.has(circuitSweepOutputKey(trace.output)),
  );
  const voltageValues = visibleTraces.flatMap((trace) =>
    trace.output.kind === 'node-voltage' ? trace.values.slice(range.start, range.end + 1) : [],
  );
  const currentValues = visibleTraces.flatMap((trace) =>
    trace.output.kind === 'component-current' ? trace.values.slice(range.start, range.end + 1) : [],
  );
  const hasVoltage = voltageValues.length > 0;
  const hasCurrent = currentValues.length > 0;
  const hasDualScale = hasVoltage && hasCurrent;
  const [primaryMin, primaryMax] = finiteExtent(hasVoltage ? voltageValues : currentValues);
  const [currentMin, currentMax] = finiteExtent(currentValues);
  const marginLeft = 66;
  const marginRight = hasDualScale ? 66 : 18;
  const plotWidth = PLOT_WIDTH - marginLeft - marginRight;
  const plotHeight = PLOT_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const x = (value: number) => marginLeft + ((value - xMin) / (xMax - xMin)) * plotWidth;
  const scaleY = (value: number, min: number, max: number) =>
    MARGIN_TOP + (1 - (value - min) / (max - min)) * plotHeight;
  const y = (value: number, output: CircuitSweepOutput) =>
    hasDualScale && output.kind === 'component-current'
      ? scaleY(value, currentMin, currentMax)
      : scaleY(value, primaryMin, primaryMax);
  const indices = renderIndices(range.start, range.end);
  const ticks = Array.from({ length: 5 }, (_, index) => index / 4);
  const isZoomed = range.start > 0 || range.end < result.sampleCount - 1;

  useEffect(() => {
    setCursorIndex((current) =>
      current === null ? null : Math.max(range.start, Math.min(range.end, current)),
    );
  }, [range.end, range.start]);

  const indexAtClientX = (clientX: number) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return null;
    const svgX = ((clientX - bounds.left) / bounds.width) * PLOT_WIDTH;
    const fraction = Math.max(0, Math.min(1, (svgX - marginLeft) / plotWidth));
    return Math.max(
      range.start,
      Math.min(range.end, Math.round(range.start + fraction * (range.end - range.start))),
    );
  };

  const zoomAt = (
    factor: number,
    anchorIndex = cursorIndex ?? Math.round((range.start + range.end) / 2),
  ) => {
    const currentSpan = range.end - range.start;
    const scaledSpan =
      factor < 1 ? Math.floor(currentSpan * factor) : Math.ceil(currentSpan * factor);
    const nextSpan = Math.max(1, Math.min(result.sampleCount - 1, scaledSpan));
    const anchorFraction = currentSpan > 0 ? (anchorIndex - range.start) / currentSpan : 0.5;
    const nextStart = Math.round(anchorIndex - nextSpan * anchorFraction);
    setViewRange(boundedRange(nextStart, nextStart + nextSpan, result.sampleCount));
  };

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const index = indexAtClientX(event.clientX);
    if (index !== null) setCursorIndex(index);
    panRef.current = { pointerId: event.pointerId, clientX: event.clientX, range };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const index = indexAtClientX(event.clientX);
    if (index !== null) setCursorIndex(index);
    const pan = panRef.current;
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!pan || pan.pointerId !== event.pointerId || !isZoomed || !bounds) return;
    const delta = Math.round(
      -((event.clientX - pan.clientX) / bounds.width) * (pan.range.end - pan.range.start),
    );
    setViewRange(boundedRange(pan.range.start + delta, pan.range.end + delta, result.sampleCount));
  };

  const handlePointerEnd = (event: PointerEvent<SVGSVGElement>) => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const anchor = indexAtClientX(event.clientX);
    zoomAt(event.deltaY < 0 ? 0.78 : 1.28, anchor ?? undefined);
  };

  const cursorX = cursorIndex === null ? null : x(axisValues[cursorIndex]);

  return (
    <div className="circuit-sweep-plot">
      <div className="circuit-sweep-legend" aria-label="Sweep traces">
        {result.traces.map((trace, index) => {
          const key = circuitSweepOutputKey(trace.output);
          return (
            <label key={key}>
              <input
                type="checkbox"
                checked={visible.has(key)}
                onChange={(event) =>
                  setVisibleKeys((current) =>
                    event.target.checked
                      ? [...current, key]
                      : current.filter((candidate) => candidate !== key),
                  )
                }
              />
              <span style={{ backgroundColor: TRACE_COLORS[index % TRACE_COLORS.length] }} />
              {circuitSweepTraceLabel(result, trace.output)}
              <small>{circuitSweepTraceUnit(trace.output)}</small>
            </label>
          );
        })}
      </div>
      <div className="circuit-sweep-tools" aria-label={`${controlLabel} controls`}>
        <button
          type="button"
          title="Zoom out"
          aria-label={`Zoom out ${controlLabel}`}
          onClick={() => zoomAt(1.28)}
          disabled={!isZoomed}
        >
          <ZoomOut size={14} aria-hidden />
        </button>
        <button
          type="button"
          title="Reset view"
          aria-label={`Reset ${controlLabel} view`}
          onClick={() => {
            setViewRange({ start: 0, end: Math.max(1, result.sampleCount - 1) });
            setCursorIndex(null);
          }}
          disabled={!isZoomed && cursorIndex === null}
        >
          <RotateCcw size={14} aria-hidden />
        </button>
        <button
          type="button"
          title="Zoom in"
          aria-label={`Zoom in ${controlLabel}`}
          onClick={() => zoomAt(0.78)}
        >
          <ZoomIn size={14} aria-hidden />
        </button>
        <span>
          {range.end - range.start + 1} / {result.sampleCount} samples
        </span>
      </div>
      <div className="circuit-sweep-chart">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
          role="img"
          aria-label={plotLabel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onWheel={handleWheel}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={marginLeft} y={MARGIN_TOP} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          {ticks.map((fraction) => {
            const tickY = MARGIN_TOP + fraction * plotHeight;
            const value = primaryMax - fraction * (primaryMax - primaryMin);
            return (
              <g key={`y-${fraction}`}>
                <line
                  className="circuit-sweep-grid-line"
                  x1={marginLeft}
                  x2={PLOT_WIDTH - marginRight}
                  y1={tickY}
                  y2={tickY}
                />
                <text
                  className="circuit-sweep-axis-label"
                  x={marginLeft - 10}
                  y={tickY + 4}
                  textAnchor="end"
                >
                  {formatAxis(value)} {hasVoltage ? 'V' : 'A'}
                </text>
                {hasDualScale ? (
                  <text
                    className="circuit-sweep-axis-label"
                    x={PLOT_WIDTH - marginRight + 10}
                    y={tickY + 4}
                    textAnchor="start"
                  >
                    {formatAxis(currentMax - fraction * (currentMax - currentMin))} A
                  </text>
                ) : null}
              </g>
            );
          })}
          {ticks.map((fraction) => {
            const tickX = marginLeft + fraction * plotWidth;
            const value = xMin + fraction * (xMax - xMin);
            return (
              <g key={`x-${fraction}`}>
                <line
                  className="circuit-sweep-grid-line"
                  x1={tickX}
                  x2={tickX}
                  y1={MARGIN_TOP}
                  y2={PLOT_HEIGHT - MARGIN_BOTTOM}
                />
                <text
                  className="circuit-sweep-axis-label"
                  x={tickX}
                  y={PLOT_HEIGHT - 17}
                  textAnchor="middle"
                >
                  {formatAxis(value)}
                </text>
              </g>
            );
          })}
          <g clipPath={`url(#${clipId})`}>
            {result.traces.map((trace, traceIndex) => {
              const key = circuitSweepOutputKey(trace.output);
              if (!visible.has(key)) return null;
              const points = indices
                .filter(
                  (index) =>
                    Number.isFinite(trace.values[index]) && Number.isFinite(axisValues[index]),
                )
                .map(
                  (index) =>
                    `${x(axisValues[index]).toFixed(2)},${y(trace.values[index], trace.output).toFixed(2)}`,
                )
                .join(' ');
              return (
                <polyline
                  key={key}
                  points={points}
                  fill="none"
                  stroke={TRACE_COLORS[traceIndex % TRACE_COLORS.length]}
                  strokeWidth="2.25"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {cursorX !== null && cursorIndex !== null ? (
              <>
                <line
                  className="circuit-sweep-cursor-line"
                  x1={cursorX}
                  x2={cursorX}
                  y1={MARGIN_TOP}
                  y2={PLOT_HEIGHT - MARGIN_BOTTOM}
                />
                {visibleTraces.map((trace) => (
                  <circle
                    key={`cursor-${circuitSweepOutputKey(trace.output)}`}
                    cx={cursorX}
                    cy={y(trace.values[cursorIndex], trace.output)}
                    r="4"
                    fill={TRACE_COLORS[result.traces.indexOf(trace) % TRACE_COLORS.length]}
                    stroke="#0b0e14"
                    strokeWidth="2"
                  />
                ))}
              </>
            ) : null}
          </g>
          <text
            className="circuit-sweep-axis-title"
            x={marginLeft + plotWidth / 2}
            y={PLOT_HEIGHT - 2}
            textAnchor="middle"
          >
            {axisTitle}
          </text>
        </svg>
      </div>
      {cursorIndex !== null ? (
        <div className="circuit-sweep-cursor-readout" aria-live="polite">
          <strong>
            {cursorLabel}: {formatAxis(axisValues[cursorIndex])}
          </strong>
          {visibleTraces.map((trace) => (
            <span key={circuitSweepOutputKey(trace.output)}>
              {circuitSweepTraceLabel(result, trace.output)}
              <code>
                {formatAxis(trace.values[cursorIndex])} {circuitSweepTraceUnit(trace.output)}
              </code>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CircuitSweepPlot({
  result,
  sourceLabel,
}: {
  result: CircuitSweepResult;
  sourceLabel?: string;
}) {
  const label = sourceLabel || result.source;
  return (
    <CircuitSeriesPlot
      result={result}
      axisValues={result.sourceValues}
      axisTitle={`${label} (source value)`}
      cursorLabel={label}
      plotLabel="DC sweep plot"
      controlLabel="sweep plot"
    />
  );
}

export function CircuitTransientPlot({ result }: { result: CircuitTransientResult }) {
  return (
    <CircuitSeriesPlot
      result={result}
      axisValues={result.timeSeconds}
      axisTitle="Time (s)"
      cursorLabel="Time (s)"
      plotLabel="Transient plot"
      controlLabel="transient plot"
    />
  );
}
